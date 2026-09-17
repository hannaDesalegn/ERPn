/**
 * The customer invoice endpoints, with the idempotency of section 11.
 *
 * The domain operation is proved in `customer-invoice-draft.int.spec.ts` and
 * `customer-invoice-edit.int.spec.ts`. What is worth proving here is the boundary: that the
 * endpoint carries authority from the session rather than the request, that a retry replays rather
 * than raising a second invoice, and above all that the idempotency record and the write share one
 * transaction.
 *
 * THE TEST THAT MATTERS MOST is the rolled-back first attempt. If the key were claimed in a
 * transaction of its own, a creation that failed would still leave a record, and every retry
 * afterwards would replay a success that never happened. So an attempt is made to fail on purpose,
 * and the retry is then required to do the work for real.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { DiscoveryModule } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../app.module.js';
import { AppConfigModule } from '../config/config.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { provisionChartOfAccounts } from '../accounting/chart-of-accounts.js';
import { provisionPostingAccounts } from '../accounting/posting-accounts.js';
import { seedDefaultRolesIn } from '../authorization/role-provisioning.service.js';
import { provisionCustomerInvoiceSequence } from '../sales/document-numbers.js';
import { PasswordHasher } from '../auth/password-hasher.js';
import { DatabaseModule } from '../database/database.module.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import { registerHttpPlugins } from '../http/plugins.js';
import { IdentityModule } from '../identity/identity.module.js';
import { mutating, signIn, type BrowserSession } from '../testing/browser-session.js';

const TEST_POLICY: Record<string, unknown> = {
  ARGON2_MEMORY_KIB: 8192,
  ARGON2_TIME_COST: 2,
  ARGON2_PARALLELISM: 1,
  SESSION_IDLE_MINUTES: 60,
  SESSION_ABSOLUTE_MINUTES: 720,
  AUTH_MAX_ATTEMPTS: 90,
  AUTH_WINDOW_MINUTES: 15,
  AUTH_LOCKOUT_MINUTES: 15,
  DATABASE_URL: process.env['DATABASE_URL'],
  DATABASE_POOL_MAX: 10,
  COOKIE_SECURE: false,
};

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT = 'a2100000-0000-4000-8000-00000000000a';
const COMPANY = 'a2200000-0000-4000-8000-00000000000a';
/** A second company in the same tenant, for the row scope case. */
const SIBLING = 'a2300000-0000-4000-8000-00000000000b';

const BILLER = 'a2400000-0000-4000-8000-00000000000a';
const BILLER_EMAIL = 'biller@invoice-http.test';
/** Signed in, a member of the same company, and holding no invoice capability. */
const CLERK = 'a2500000-0000-4000-8000-00000000000b';
const CLERK_EMAIL = 'clerk@invoice-http.test';
const PASSWORD = 'a perfectly ordinary passphrase';

const CUSTOMER = 'a2600000-0000-4000-8000-00000000000a';
const SIBLING_CUSTOMER = 'a2610000-0000-4000-8000-00000000000b';
const WAREHOUSE = 'a2700000-0000-4000-8000-00000000000a';
const SIBLING_WAREHOUSE = 'a2710000-0000-4000-8000-00000000000b';
const WIDGET = 'a2800000-0000-4000-8000-00000000000a';
const SIBLING_WIDGET = 'a2810000-0000-4000-8000-00000000000b';

let sequence = 0;
const nextId = () =>
  `a9${(sequence += 1).toString().padStart(6, '0')}-0000-4000-8000-00000000000a`;

describe('The customer invoice endpoints', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let uow: UnitOfWork;
  let biller: BrowserSession;
  let clerk: BrowserSession;

  beforeAll(async () => {
    if (!MIGRATION_URL || !process.env['DATABASE_URL']) {
      throw new Error(
        'DATABASE_URL and MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate` first.',
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        DiscoveryModule,
        DatabaseModule,
        AuthModule,
        IdentityModule,
        AppModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: (key: string) => TEST_POLICY[key] })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await registerHttpPlugins(app);
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();
    uow = moduleRef.get(UnitOfWork);

    await purge();
    await seed(moduleRef.get(PasswordHasher));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    biller = await enter(BILLER_EMAIL);
    clerk = await enter(CLERK_EMAIL);
  });

  afterAll(async () => {
    try {
      await purge();
    } finally {
      await owner.end();
      await app.close();
    }
  });

  beforeEach(async () => {
    for (const companyId of [COMPANY, SIBLING]) {
      await ownerContext(TENANT, companyId);
      await owner.query('DELETE FROM idempotency_records WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customer_invoice_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customer_invoices WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [companyId]);
      await owner.query(
        'UPDATE document_number_sequences SET next_value = 1 WHERE company_id = $1',
        [companyId],
      );
    }
    await ownerContext();
    // The ledger refuses a delete even from the owning role, which is the guarantee 0014 adds.
    await owner.query('TRUNCATE journal_lines, journal_entries');
    await owner.query('TRUNCATE audit_events');
  });

  async function enter(email: string): Promise<BrowserSession> {
    const session = await signIn(app, { email, password: PASSWORD });

    const switched = await app.inject({
      method: 'POST',
      url: '/api/me/company',
      headers: mutating(session),
      payload: { companyId: COMPANY },
    });

    if (switched.statusCode >= 300) {
      throw new Error(`Entering the company failed: ${switched.statusCode} ${switched.body}`);
    }

    return session;
  }

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  /** The books and the counter posting needs, through the functions provisioning uses. */
  async function provisionBooks(companyId: string): Promise<void> {
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT, companyId }),
      async (r) => {
        await provisionCustomerInvoiceSequence(r);
        const chart = await provisionChartOfAccounts(r);
        await provisionPostingAccounts(r, chart);
      },
    );
  }

  /** This company's own copies of the templates, per section 2.7. */
  async function seedDefaultRolesFor(companyId: string) {
    return uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT, companyId }),
      (r) => seedDefaultRolesIn(r, companyId),
    );
  }

  async function seed(hasher: PasswordHasher): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)', [
      TENANT,
      'invoice-http',
      'Invoice HTTP',
    ]);

    const passwordHash = await hasher.hash(PASSWORD);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT }), async (r) => {
      await r.users.create({ id: BILLER, email: BILLER_EMAIL, name: 'Biller', passwordHash });
      await r.users.create({ id: CLERK, email: CLERK_EMAIL, name: 'Clerk', passwordHash });
      await r.companies.create({ id: COMPANY, name: 'Home', baseCurrency: 'USD' });
      await r.companies.create({ id: SIBLING, name: 'Sibling', baseCurrency: 'USD' });
    });

    // The biller is an accountant, which the catalogue gives `invoices:create` and
    // `invoices:view`. The clerk is a warehouse user, which it gives neither, so every refusal
    // below is the capability missing rather than the session.
    for (const companyId of [COMPANY, SIBLING]) {
      await provisionBooks(companyId);
      const seeded = await seedDefaultRolesFor(companyId);
      await uow.inSystemScope(
        systemScope('tenant-provisioning', { tenantId: TENANT, companyId }),
        async (r) => {
          const billerMembership = await r.memberships.create({ id: nextId(), userId: BILLER });
          const clerkMembership = await r.memberships.create({ id: nextId(), userId: CLERK });

          await r.roles.assignToMembership({
            membershipId: billerMembership.id,
            roleId: seeded.find((role) => role.key === 'accountant')!.id,
          });
          await r.roles.assignToMembership({
            membershipId: clerkMembership.id,
            roleId: seeded.find((role) => role.key === 'warehouse')!.id,
          });
        },
      );
    }

    for (const [companyId, customerId, warehouseId, productId] of [
      [COMPANY, CUSTOMER, WAREHOUSE, WIDGET],
      [SIBLING, SIBLING_CUSTOMER, SIBLING_WAREHOUSE, SIBLING_WIDGET],
    ] as const) {
      await ownerContext(TENANT, companyId);
      await owner.query(
        'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
        [customerId, TENANT, companyId, 'CUST-1', 'A Customer'],
      );
      await owner.query(
        'INSERT INTO warehouses (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
        [warehouseId, TENANT, companyId, 'WH-1', 'Main'],
      );
      await owner.query(
        `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
         VALUES ($1,$2,$3,'SKU-1','A Product','each','10.000000','USD')`,
        [productId, TENANT, companyId],
      );
    }
  }

  async function purge(): Promise<void> {
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [[BILLER, CLERK]]);
    for (const companyId of [COMPANY, SIBLING]) {
      await ownerContext(TENANT, companyId);
      await owner.query('DELETE FROM idempotency_records WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customer_invoice_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customer_invoices WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM company_posting_accounts WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM accounts WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM document_number_sequences WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM products WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM warehouses WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM membership_roles WHERE company_id = $1', [companyId]);
      await owner.query(
        'DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE company_id = $1)',
        [companyId],
      );
      await owner.query('DELETE FROM memberships WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM roles WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM companies WHERE id = $1', [companyId]);
    }
    await ownerContext();
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM auth_throttle');
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[BILLER, CLERK]]);
    await owner.query('DELETE FROM tenants WHERE id = $1', [TENANT]);
  }

  /** A confirmed order in the named company, written directly. */
  async function confirmedOrder(companyId = COMPANY): Promise<{ id: string; lineId: string }> {
    const id = nextId();
    const lineId = nextId();
    const inHome = companyId === COMPANY;

    await ownerContext(TENANT, companyId);
    await owner.query(
      `INSERT INTO sales_orders
         (id, tenant_id, company_id, status, doc_number, customer_id, warehouse_id, order_date, currency)
       VALUES ($1,$2,$3,'confirmed',$4,$5,$6,current_date,'USD')`,
      [
        id,
        TENANT,
        companyId,
        // The whole identifier, because the first six characters are the same for every id this
        // helper generates and a number is unique per company.
        `SO-${id}`,
        inHome ? CUSTOMER : SIBLING_CUSTOMER,
        inHome ? WAREHOUSE : SIBLING_WAREHOUSE,
      ],
    );
    await owner.query(
      `INSERT INTO sales_order_lines
         (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku,
          product_name, quantity, unit_price, currency)
       VALUES ($1,$2,$3,$4,1,$5,'SKU-1','A Product','5.000000','10.000000','USD')`,
      [lineId, TENANT, companyId, id, inHome ? WIDGET : SIBLING_WIDGET],
    );

    return { id, lineId };
  }

  const post = (session: BrowserSession, key: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/customer-invoices',
      headers: { ...mutating(session), 'idempotency-key': key },
      payload,
    });

  const put = (
    session: BrowserSession,
    id: string,
    key: string,
    payload: Record<string, unknown>,
  ) =>
    app.inject({
      method: 'PUT',
      url: `/api/customer-invoices/${id}`,
      headers: { ...mutating(session), 'idempotency-key': key },
      payload,
    });

  const get = (session: BrowserSession, id: string) =>
    app.inject({
      method: 'GET',
      url: `/api/customer-invoices/${id}`,
      headers: { cookie: session.cookie },
    });

  // -------------------------------------------------------------------------------------
  // 1. Creating.
  // -------------------------------------------------------------------------------------

  describe('creating a draft', () => {
    it('answers 201 with the invoice the detail endpoint would show', async () => {
      const order = await confirmedOrder();

      const response = await post(biller, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('draft');
      expect(body.docNumber).toBeNull();
      expect(body.lines).toHaveLength(1);
      expect(body.salesOrders.map((each: { id: string }) => each.id)).toEqual([order.id]);
    });

    it('answers exactly what the read endpoint answers', async () => {
      const order = await confirmedOrder();

      const created = await post(biller, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
      });
      const read = await get(biller, JSON.parse(created.body).id);

      expect(JSON.parse(read.body)).toEqual(JSON.parse(created.body));
    });

    it('refuses a request with no idempotency key', async () => {
      const order = await confirmedOrder();

      const response = await app.inject({
        method: 'POST',
        url: '/api/customer-invoices',
        headers: mutating(biller),
        payload: { salesOrderIds: [order.id], invoiceDate: '2026-09-15' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuses a body carrying a figure the server owns', async () => {
      // Section 3.3 and 14.2: a caller sending a total is sending a field the operation does not
      // read, and `strict` refuses it rather than ignoring it.
      const order = await confirmedOrder();

      const response = await post(biller, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
        total: '1.0000',
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuses a body naming a status or a document number', async () => {
      const order = await confirmedOrder();

      for (const extra of [{ status: 'posted' }, { docNumber: 'INV-0001' }]) {
        const response = await post(biller, randomUUID(), {
          salesOrderIds: [order.id],
          invoiceDate: '2026-09-15',
          ...extra,
        });

        expect(response.statusCode).toBe(400);
      }
    });

    it('refuses an empty list of orders', async () => {
      const response = await post(biller, randomUUID(), {
        salesOrderIds: [],
        invoiceDate: '2026-09-15',
      });

      expect(response.statusCode).toBe(400);
    });

    it('answers 422 for an order in another company, as though it did not exist', async () => {
      const foreign = await confirmedOrder(SIBLING);

      const response = await post(biller, randomUUID(), {
        salesOrderIds: [foreign.id],
        invoiceDate: '2026-09-15',
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).message).toMatch(/not found/i);
    });

    it('refuses a caller without the capability', async () => {
      const order = await confirmedOrder();

      const response = await post(clerk, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------------------
  // 2. Idempotency, per section 11.
  // -------------------------------------------------------------------------------------

  describe('the idempotency key', () => {
    it('replays the same response rather than raising a second invoice', async () => {
      const order = await confirmedOrder();
      const key = randomUUID();
      const body = { salesOrderIds: [order.id], invoiceDate: '2026-09-15' };

      const first = await post(biller, key, body);
      const second = await post(biller, key, body);

      expect(second.statusCode).toBe(201);
      expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));

      await ownerContext(TENANT, COMPANY);
      const stored = await owner.query<{ count: string }>('SELECT count(*) FROM customer_invoices');
      expect(stored.rows[0]?.count).toBe('1');
    });

    it('rejects the same key with a different request as a conflict', async () => {
      const first = await confirmedOrder();
      const second = await confirmedOrder();
      const key = randomUUID();

      await post(biller, key, { salesOrderIds: [first.id], invoiceDate: '2026-09-15' });
      const response = await post(biller, key, {
        salesOrderIds: [second.id],
        invoiceDate: '2026-09-15',
      });

      expect(response.statusCode).toBe(409);
    });

    it('leaves no record behind when the work fails, so a retry does it for real', async () => {
      // THE TEST THAT MATTERS MOST. The first attempt names a draft order, which the operation
      // refuses. If the key had been claimed in a transaction of its own, the retry below would
      // replay that refusal forever instead of billing the order once it is confirmable.
      const order = await confirmedOrder();
      await ownerContext(TENANT, COMPANY);
      await owner.query(`UPDATE sales_orders SET status = 'draft', doc_number = NULL WHERE id = $1`, [
        order.id,
      ]);

      const key = randomUUID();
      const body = { salesOrderIds: [order.id], invoiceDate: '2026-09-15' };

      const refused = await post(biller, key, body);
      expect(refused.statusCode).toBe(422);

      await ownerContext(TENANT, COMPANY);
      const records = await owner.query<{ count: string }>(
        'SELECT count(*) FROM idempotency_records',
      );
      expect(records.rows[0]?.count).toBe('0');

      await owner.query(
        `UPDATE sales_orders SET status = 'confirmed', doc_number = 'SO-RETRY' WHERE id = $1`,
        [order.id],
      );
      const retried = await post(biller, key, body);

      expect(retried.statusCode).toBe(201);
    });

    it('keeps one company key from answering another company request', async () => {
      // Section 11 scopes a record by company as well as by user and endpoint. The two companies
      // are entered by the same person, so the key alone is not what separates them.
      const order = await confirmedOrder();
      const key = randomUUID();
      await post(biller, key, { salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await ownerContext(TENANT, COMPANY);
      const records = await owner.query<{ company_id: string }>(
        'SELECT company_id FROM idempotency_records',
      );
      expect(records.rows.every((row) => row.company_id === COMPANY)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------
  // 3. Editing.
  // -------------------------------------------------------------------------------------

  describe('editing a draft', () => {
    const createOne = async () => {
      const order = await confirmedOrder();
      const created = await post(biller, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
      });
      return { order, invoice: JSON.parse(created.body) };
    };

    it('answers 200 with the invoice as it now stands', async () => {
      const { order, invoice } = await createOne();

      const response = await put(biller, invoice.id, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-20',
        version: invoice.version,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.invoiceDate).toBe('2026-09-20');
      expect(body.version).toBe(invoice.version + 1);
    });

    it('answers 409 with the current invoice when the version is stale', async () => {
      const { order, invoice } = await createOne();
      await put(biller, invoice.id, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-20',
        version: invoice.version,
      });

      const response = await put(biller, invoice.id, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-21',
        version: invoice.version,
      });

      expect(response.statusCode).toBe(409);
      // Section 10.1: the interface has to be able to say what changed, which a bare message
      // cannot. The body carries the invoice that won.
      expect(JSON.parse(response.body).current.invoiceDate).toBe('2026-09-20');
    });

    it('refuses an edit with no idempotency key', async () => {
      const { order, invoice } = await createOne();

      const response = await app.inject({
        method: 'PUT',
        url: `/api/customer-invoices/${invoice.id}`,
        headers: mutating(biller),
        payload: {
          salesOrderIds: [order.id],
          invoiceDate: '2026-09-20',
          version: invoice.version,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('replays an edit carrying the same key rather than applying it twice', async () => {
      const { order, invoice } = await createOne();
      const key = randomUUID();
      const body = {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-20',
        version: invoice.version,
      };

      const first = await put(biller, invoice.id, key, body);
      const second = await put(biller, invoice.id, key, body);

      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
      // Applied once: a second application would have needed a version this body does not carry.
      expect(JSON.parse(second.body).version).toBe(invoice.version + 1);
    });

    it('answers 404 for an invoice in another company', async () => {
      const foreign = await confirmedOrder(SIBLING);
      await ownerContext(TENANT, SIBLING);
      const foreignInvoice = nextId();
      await owner.query(
        `INSERT INTO customer_invoices
           (id, tenant_id, company_id, customer_id, invoice_date, currency)
         VALUES ($1,$2,$3,$4,current_date,'USD')`,
        [foreignInvoice, TENANT, SIBLING, SIBLING_CUSTOMER],
      );

      const response = await put(biller, foreignInvoice, randomUUID(), {
        salesOrderIds: [foreign.id],
        invoiceDate: '2026-09-20',
        version: 1,
      });

      expect(response.statusCode).toBe(404);
    });

    it('refuses a caller without the capability', async () => {
      const { order, invoice } = await createOne();

      const response = await put(clerk, invoice.id, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-20',
        version: invoice.version,
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------------------
  // 4. Reading.
  // -------------------------------------------------------------------------------------

  describe('reading an invoice', () => {
    it('answers 404 for an invoice in another company', async () => {
      await ownerContext(TENANT, SIBLING);
      const foreignInvoice = nextId();
      await owner.query(
        `INSERT INTO customer_invoices
           (id, tenant_id, company_id, customer_id, invoice_date, currency)
         VALUES ($1,$2,$3,$4,current_date,'USD')`,
        [foreignInvoice, TENANT, SIBLING, SIBLING_CUSTOMER],
      );

      const response = await get(biller, foreignInvoice);

      expect(response.statusCode).toBe(404);
    });

    it('answers 404 for an invoice that does not exist, in the same words', async () => {
      const missing = await get(biller, randomUUID());

      expect(missing.statusCode).toBe(404);
    });

    it('answers 404 for an identifier that is not one', async () => {
      const response = await get(biller, 'not-a-uuid');

      expect(response.statusCode).toBe(404);
    });

    it('refuses a caller without the capability', async () => {
      const order = await confirmedOrder();
      const created = await post(biller, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
      });

      const response = await get(clerk, JSON.parse(created.body).id);

      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------------------
  // 5. What no endpoint does.
  // -------------------------------------------------------------------------------------

  describe('posting an invoice', () => {
    const drafted = async () => {
      const order = await confirmedOrder();
      const created = await post(biller, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
      });
      return { order, invoice: JSON.parse(created.body) };
    };

    const postInvoice = (session: BrowserSession, id: string, key: string) =>
      app.inject({
        method: 'POST',
        url: `/api/customer-invoices/${id}/post`,
        headers: { ...mutating(session), 'idempotency-key': key },
      });

    it('answers 200 with the number, the status and the entry it wrote', async () => {
      const { invoice } = await drafted();

      const response = await postInvoice(biller, invoice.id, randomUUID());

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('posted');
      expect(body.docNumber).toMatch(/^INV-\d{4}$/);
      expect(body.journalEntryId).toMatch(/^[0-9a-f-]{36}$/);
      // Five units at ten, which is the order this fixture confirms.
      expect(body.total).toBe('50.0000');
    });

    it('shows the posted invoice on the read endpoint afterwards', async () => {
      const { invoice } = await drafted();
      const posted = JSON.parse((await postInvoice(biller, invoice.id, randomUUID())).body);

      const read = JSON.parse((await get(biller, invoice.id)).body);

      expect({
        status: read.status,
        docNumber: read.docNumber,
        total: read.total,
        lines: read.lines.length,
        orders: read.salesOrders.length,
        version: read.version,
      }).toEqual({
        status: 'posted',
        docNumber: posted.docNumber,
        total: '50.0000',
        lines: 1,
        orders: 1,
        version: 2,
      });
    });

    it('refuses a request with no idempotency key, and posts nothing', async () => {
      const { invoice } = await drafted();

      const response = await app.inject({
        method: 'POST',
        url: `/api/customer-invoices/${invoice.id}/post`,
        headers: mutating(biller),
      });

      expect(response.statusCode).toBe(400);

      await ownerContext(TENANT, COMPANY);
      const entries = await owner.query<{ count: string }>('SELECT count(*) FROM journal_entries');
      expect(entries.rows[0]?.count).toBe('0');
    });

    it('replays the same response rather than posting twice', async () => {
      const { invoice } = await drafted();
      const key = randomUUID();

      const first = await postInvoice(biller, invoice.id, key);
      const second = await postInvoice(biller, invoice.id, key);

      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));

      await ownerContext(TENANT, COMPANY);
      const entries = await owner.query<{ count: string }>('SELECT count(*) FROM journal_entries');
      expect(entries.rows[0]?.count).toBe('1');
    });

    it('rejects the same key against a different invoice as a conflict', async () => {
      const first = await drafted();
      const second = await drafted();
      const key = randomUUID();

      await postInvoice(biller, first.invoice.id, key);
      const response = await postInvoice(biller, second.invoice.id, key);

      expect(response.statusCode).toBe(409);
      expect((await get(biller, second.invoice.id)).body).toContain('"status":"draft"');
    });

    it('leaves no record behind when the posting fails, so a retry does it for real', async () => {
      // The same claim creation makes, on the operation whose accidental repetition matters most.
      // The first attempt names an invoice whose order was cancelled, which the operation refuses.
      const { order, invoice } = await drafted();
      await ownerContext(TENANT, COMPANY);
      await owner.query(`UPDATE sales_orders SET status = 'cancelled' WHERE id = $1`, [order.id]);

      const key = randomUUID();
      const refused = await postInvoice(biller, invoice.id, key);
      expect(refused.statusCode).toBe(422);

      await ownerContext(TENANT, COMPANY);
      // The posting endpoint's records only. The draft that set this test up claimed a key of its
      // own, on a different endpoint, and that one committed.
      const records = await owner.query<{ count: string }>(
        `SELECT count(*) FROM idempotency_records WHERE endpoint LIKE '%/post'`,
      );
      expect(records.rows[0]?.count).toBe('0');

      await owner.query(`UPDATE sales_orders SET status = 'confirmed' WHERE id = $1`, [order.id]);
      const retried = await postInvoice(biller, invoice.id, key);

      expect(retried.statusCode).toBe(200);
    });

    it('answers 409 when the invoice is already posted', async () => {
      const { invoice } = await drafted();
      await postInvoice(biller, invoice.id, randomUUID());

      const response = await postInvoice(biller, invoice.id, randomUUID());

      // Section 12.1's refusal names both states, and an already posted invoice is a conflict
      // rather than a bad request: the caller is not wrong, the document moved.
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).message).toMatch(/cannot move from posted to posted/);
    });

    it('refuses a caller without invoices:post', async () => {
      const { invoice } = await drafted();

      const response = await postInvoice(clerk, invoice.id, randomUUID());

      expect(response.statusCode).toBe(403);
      expect((await get(biller, invoice.id)).body).toContain('"status":"draft"');
    });

    it('answers 404 for an invoice in another company', async () => {
      await ownerContext(TENANT, SIBLING);
      const foreignInvoice = nextId();
      await owner.query(
        `INSERT INTO customer_invoices
           (id, tenant_id, company_id, customer_id, invoice_date, currency)
         VALUES ($1,$2,$3,$4,current_date,'USD')`,
        [foreignInvoice, TENANT, SIBLING, SIBLING_CUSTOMER],
      );

      const response = await postInvoice(biller, foreignInvoice, randomUUID());

      expect(response.statusCode).toBe(404);
    });

    it('answers 404 for an identifier that is not one', async () => {
      const response = await postInvoice(biller, 'not-a-uuid', randomUUID());

      expect(response.statusCode).toBe(404);
    });

    it('refuses an unauthenticated caller before it reaches the operation', async () => {
      const { invoice } = await drafted();

      const response = await app.inject({
        method: 'POST',
        url: `/api/customer-invoices/${invoice.id}/post`,
        headers: { 'idempotency-key': randomUUID() },
      });

      // The forgery guard answers first on a mutation carrying neither session nor token, which
      // is the ordering the matrix suite states: a forgery is turned away before the database.
      expect(response.statusCode).toBe(403);
    });

    it('writes no journal entry behind creating or editing a draft', async () => {
      const order = await confirmedOrder();
      const created = await post(biller, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
      });
      const invoice = JSON.parse(created.body);
      await put(biller, invoice.id, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-16',
        version: invoice.version,
      });

      await ownerContext(TENANT, COMPANY);
      const entries = await owner.query<{ count: string }>('SELECT count(*) FROM journal_entries');
      expect(entries.rows[0]?.count).toBe('0');
    });
  });

  // -------------------------------------------------------------------------------------
  // 5. What a posting left behind: its journal entry and its trail.
  // -------------------------------------------------------------------------------------

  describe('reading what a posting wrote', () => {
    const postInvoice = (session: BrowserSession, id: string) =>
      app.inject({
        method: 'POST',
        url: `/api/customer-invoices/${id}/post`,
        headers: { ...mutating(session), 'idempotency-key': randomUUID() },
      });

    const read = (session: BrowserSession, id: string, what: 'journal' | 'audit-events') =>
      app.inject({
        method: 'GET',
        url: `/api/customer-invoices/${id}/${what}`,
        headers: { cookie: session.cookie },
      });

    /** A draft raised in the home company from a confirmed order of five at ten. */
    const drafted = async () => {
      const order = await confirmedOrder();
      const created = await post(biller, randomUUID(), {
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
      });
      return JSON.parse(created.body) as { id: string };
    };

    it('answers with the entry the posting wrote, accounts named, balanced', async () => {
      const invoice = await drafted();
      const posted = JSON.parse((await postInvoice(biller, invoice.id)).body);

      const response = await read(biller, invoice.id, 'journal');

      expect(response.statusCode).toBe(200);
      const entries = JSON.parse(response.body);
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(entry).toMatchObject({
        id: posted.journalEntryId,
        entryDate: '2026-09-15',
        memo: `Customer invoice ${posted.docNumber}`,
        currency: 'USD',
      });

      // Receivables debited the total and revenue credited the net. The company charges no tax,
      // so there is no third line: a zero tax line is omitted, which is the posting ruling.
      const sides = entry.lines.map(
        (line: { account: { type: string; code: string; name: string }; debit: string; credit: string }) => ({
          type: line.account.type,
          named: line.account.code.length > 0 && line.account.name.length > 0,
          debit: Number(line.debit),
          credit: Number(line.credit),
        }),
      );
      expect(sides).toEqual([
        { type: 'asset', named: true, debit: 50, credit: 0 },
        { type: 'revenue', named: true, debit: 0, credit: 50 },
      ]);
    });

    it('answers with an empty journal for a draft, which has posted nothing', async () => {
      const invoice = await drafted();

      const response = await read(biller, invoice.id, 'journal');

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual([]);
    });

    it('answers with the posting in the trail, naming the number, the amount and the actor', async () => {
      const invoice = await drafted();
      const posted = JSON.parse((await postInvoice(biller, invoice.id)).body);

      const response = await read(biller, invoice.id, 'audit-events');

      expect(response.statusCode).toBe(200);
      const trail = JSON.parse(response.body);
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        action: 'customer_invoice_posted',
        summary: `Posted customer invoice ${posted.docNumber} for 50.0000 USD`,
        actor: { id: BILLER, name: 'Biller' },
        actorRoles: ['accountant'],
      });
    });

    it('answers with an empty trail for a draft, because document audit begins at posting', async () => {
      const invoice = await drafted();

      const response = await read(biller, invoice.id, 'audit-events');

      expect(JSON.parse(response.body)).toEqual([]);
    });

    it.each(['journal', 'audit-events'] as const)(
      'refuses %s to a caller without the capability',
      async (what) => {
        const invoice = await drafted();
        await postInvoice(biller, invoice.id);

        const response = await read(clerk, invoice.id, what);

        expect(response.statusCode).toBe(403);
      },
    );

    it.each(['journal', 'audit-events'] as const)(
      'answers 404 for %s of an invoice posted in another company',
      async (what) => {
        // Posted for real in the sibling, by the same person, so there is an entry and a trail to
        // leak. The home session then asks for it by identifier.
        const inSibling = await signIn(app, { email: BILLER_EMAIL, password: PASSWORD });
        await app.inject({
          method: 'POST',
          url: '/api/me/company',
          headers: mutating(inSibling),
          payload: { companyId: SIBLING },
        });
        const order = await confirmedOrder(SIBLING);
        const created = await post(inSibling, randomUUID(), {
          salesOrderIds: [order.id],
          invoiceDate: '2026-09-15',
        });
        const foreign = JSON.parse(created.body) as { id: string };
        expect((await postInvoice(inSibling, foreign.id)).statusCode).toBe(200);
        expect((await read(inSibling, foreign.id, what)).body).not.toBe('[]');

        const response = await read(biller, foreign.id, what);

        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain(foreign.id);
      },
    );

    it.each(['journal', 'audit-events'] as const)(
      'answers 404 for %s of an identifier that is not one',
      async (what) => {
        const response = await read(biller, 'not-a-uuid', what);

        expect(response.statusCode).toBe(404);
      },
    );
  });
});
