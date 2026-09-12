/**
 * Confirming a sales order over HTTP, with the idempotency of section 11.
 *
 * The domain operation is already proved elsewhere. What is worth proving here is the boundary:
 * that the endpoint carries authority from the session rather than the request, that a retry
 * replays rather than reserves twice, and above all that the idempotency record and the
 * confirmation share one transaction.
 *
 * THE TEST THAT MATTERS MOST is the rolled-back first attempt. If the key were claimed in a
 * transaction of its own, a confirmation that failed would still leave a record, and every retry
 * afterwards would replay a success that never happened. So an attempt is made to fail on
 * purpose, and the retry is then required to do the work for real.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { DiscoveryModule } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppModule } from '../app.module.js';
import { AppConfigModule } from '../config/config.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PasswordHasher } from '../auth/password-hasher.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, systemScope, UnitOfWork } from '../database/index.js';
import { registerHttpPlugins } from '../http/plugins.js';
import { IdentityModule } from '../identity/identity.module.js';
import { mutating, signIn, type BrowserSession } from '../testing/browser-session.js';
import { SALES_ORDER_DOC_TYPE } from './document-numbers.js';

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

const TENANT = 'e8100000-0000-4000-8000-00000000000a';
const OTHER_TENANT = 'e8200000-0000-4000-8000-00000000000b';
const COMPANY = 'e8300000-0000-4000-8000-00000000000a';
/** A second company in the same tenant, for the row scope case. */
const SIBLING = 'e8400000-0000-4000-8000-00000000000b';

const SELLER = 'e8500000-0000-4000-8000-00000000000a';
const SELLER_EMAIL = 'seller@confirm-http.test';
/** Signed in, a member of the same company, and without sales:confirm. */
const CLERK = 'e8600000-0000-4000-8000-00000000000b';
const CLERK_EMAIL = 'clerk@confirm-http.test';
const PASSWORD = 'a perfectly ordinary passphrase';

const CUSTOMER = 'e8700000-0000-4000-8000-00000000000a';
const SIBLING_CUSTOMER = 'e8710000-0000-4000-8000-00000000000b';
const WAREHOUSE = 'e8800000-0000-4000-8000-00000000000a';
const SIBLING_WAREHOUSE = 'e8810000-0000-4000-8000-00000000000b';
const WIDGET = 'e8900000-0000-4000-8000-00000000000a';
const SIBLING_WIDGET = 'e8910000-0000-4000-8000-00000000000b';

let sequence = 0;
const nextId = (prefix: string) =>
  `${prefix}${(sequence += 1).toString().padStart(6, '0')}-0000-4000-8000-00000000000a`;

describe('Confirming a sales order over HTTP', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let uow: UnitOfWork;
  let seller: BrowserSession;
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

    seller = await enter(SELLER_EMAIL);
    clerk = await enter(CLERK_EMAIL);
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await app.close();
  });

  beforeEach(async () => {
    for (const companyId of [COMPANY, SIBLING]) {
      await ownerContext(TENANT, companyId);
      await owner.query('DELETE FROM idempotency_records WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_reservations WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_movements WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_balances WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [companyId]);
      await owner.query(
        'UPDATE document_number_sequences SET next_value = 1 WHERE company_id = $1',
        [companyId],
      );
    }
    await ownerContext();
    await owner.query('TRUNCATE audit_events');
  });

  /**
   * Signs in and enters the acting company.
   *
   * Both halves are needed: a session alone has no company, because section 2.5 has the server
   * resolve it from a membership rather than letting a request name one. Both users belong to two
   * companies here, so neither gets one by default.
   */
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

  async function seed(hasher: PasswordHasher): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT,
      'confirm-http',
      'Confirm HTTP',
      OTHER_TENANT,
      'confirm-http-away',
      'Confirm HTTP Away',
    ]);

    const passwordHash = await hasher.hash(PASSWORD);
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT }), async (r) => {
      await r.users.create({ id: SELLER, email: SELLER_EMAIL, name: 'Seller', passwordHash });
      await r.users.create({ id: CLERK, email: CLERK_EMAIL, name: 'Clerk', passwordHash });
      await r.companies.create({ id: COMPANY, name: 'Main', baseCurrency: 'USD' });
      await r.companies.create({ id: SIBLING, name: 'Sibling', baseCurrency: 'USD' });
    });

    for (const companyId of [COMPANY, SIBLING]) {
      await ownerContext(TENANT, companyId);
      await owner.query(
        `INSERT INTO document_number_sequences (id, tenant_id, company_id, doc_type, prefix, gapless, next_value)
         VALUES ($1,$2,$3,$4,'SO-',true,1)`,
        [nextId('e9'), TENANT, companyId, SALES_ORDER_DOC_TYPE],
      );
      await owner.query(
        'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
        [companyId === COMPANY ? CUSTOMER : SIBLING_CUSTOMER, TENANT, companyId, 'CUST-1', 'Buyer'],
      );
      await owner.query(
        'INSERT INTO warehouses (id, tenant_id, company_id, code, name, is_default) VALUES ($1,$2,$3,$4,$5,true)',
        [
          companyId === COMPANY ? WAREHOUSE : SIBLING_WAREHOUSE,
          TENANT,
          companyId,
          'WH-1',
          'Main',
        ],
      );
      await owner.query(
        `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
         VALUES ($1,$2,$3,'SKU-W','Widget','unit','10.000000','USD')`,
        [companyId === COMPANY ? WIDGET : SIBLING_WIDGET, TENANT, companyId],
      );

      // A role that can confirm, and one that can only look.
      const sellerRole = nextId('ea');
      const clerkRole = nextId('eb');
      await owner.query(
        'INSERT INTO roles (id, tenant_id, company_id, key, name) VALUES ($1,$2,$3,$4,$5), ($6,$2,$3,$7,$8)',
        [sellerRole, TENANT, companyId, 'sales', 'Sales', clerkRole, 'warehouse', 'Warehouse'],
      );
      await owner.query(
        `INSERT INTO role_permissions (tenant_id, company_id, role_id, permission)
         VALUES ($1,$2,$3,'sales:confirm'), ($1,$2,$3,'sales:view'), ($1,$2,$3,'sales:create'),
                ($1,$2,$4,'sales:view')`,
        [TENANT, companyId, sellerRole, clerkRole],
      );

      for (const [userId, roleId] of [
        [SELLER, sellerRole],
        [CLERK, clerkRole],
      ] as const) {
        const membershipId = nextId('ec');
        await owner.query(
          'INSERT INTO memberships (id, tenant_id, company_id, user_id) VALUES ($1,$2,$3,$4)',
          [membershipId, TENANT, companyId, userId],
        );
        await owner.query(
          'INSERT INTO membership_roles (tenant_id, company_id, membership_id, role_id) VALUES ($1,$2,$3,$4)',
          [TENANT, companyId, membershipId, roleId],
        );
      }
    }
  }

  async function purge(): Promise<void> {
    // Sessions first. Entering a company puts its identifier on the session row, so the company
    // cannot go while a session still points at it.
    await ownerContext();
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [[SELLER, CLERK]]);

    for (const companyId of [COMPANY, SIBLING]) {
      await ownerContext(TENANT, companyId);
      await owner.query('DELETE FROM idempotency_records WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_reservations WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_movements WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_balances WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM document_number_sequences WHERE company_id = $1', [companyId]);
      await owner.query(
        'DELETE FROM membership_roles WHERE membership_id IN (SELECT id FROM memberships WHERE company_id = $1)',
        [companyId],
      );
      await owner.query('DELETE FROM memberships WHERE company_id = $1', [companyId]);
      await owner.query(
        'DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE company_id = $1)',
        [companyId],
      );
      await owner.query('DELETE FROM roles WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM products WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM warehouses WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        TENANT,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM auth_throttle');
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[SELLER, CLERK]]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT, OTHER_TENANT]]);
  }

  /** Puts stock on a shelf through the ledger. */
  const stock = (companyId: string, productId: string, quantity: string) =>
    uow.inActorScope(
      actorScope({ tenantId: TENANT, companyId, userId: SELLER }),
      (repositories) =>
        repositories.stockLedger.record({
          id: nextId('ed'),
          productId,
          warehouseId: companyId === COMPANY ? WAREHOUSE : SIBLING_WAREHOUSE,
          quantity,
          reason: 'purchase_receipt',
          sourceDocType: 'purchase_order',
          sourceDocId: nextId('ee'),
        }),
    );

  async function draft(companyId: string, quantity: string): Promise<string> {
    const orderId = nextId('ef');
    const product = companyId === COMPANY ? WIDGET : SIBLING_WIDGET;
    await ownerContext(TENANT, companyId);
    await owner.query(
      `INSERT INTO sales_orders (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
       VALUES ($1,$2,$3,'draft',$4,$5,current_date,'USD')`,
      [
        orderId,
        TENANT,
        companyId,
        companyId === COMPANY ? CUSTOMER : SIBLING_CUSTOMER,
        companyId === COMPANY ? WAREHOUSE : SIBLING_WAREHOUSE,
      ],
    );
    await owner.query(
      `INSERT INTO sales_order_lines
         (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku, product_name,
          quantity, unit_price, currency)
       VALUES ($1,$2,$3,$4,1,$5,'SKU-W','Widget',$6,'10.000000','USD')`,
      [nextId('f0'), TENANT, companyId, orderId, product, quantity],
    );
    return orderId;
  }

  const confirm = (
    session: BrowserSession,
    orderId: string,
    key: string | undefined,
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/sales-orders/${orderId}/confirm`,
      headers: mutating(session, key === undefined ? extra : { 'idempotency-key': key, ...extra }),
    });

  const createOrder = (
    session: BrowserSession,
    payload: Record<string, unknown>,
    // `null` means send no header. `undefined` would trigger the default and quietly send one.
    key: string | null = 'key-create',
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/sales-orders',
      headers: mutating(session, key === null ? {} : { 'idempotency-key': key }),
      payload,
    });

  /** A well formed order for the acting company, with whatever a test wants to vary. */
  const validOrder = (overrides: Record<string, unknown> = {}) => ({
    customerId: CUSTOMER,
    warehouseId: WAREHOUSE,
    orderDate: '2026-09-12',
    lines: [{ productId: WIDGET, quantity: '3' }],
    ...overrides,
  });

  const listOrders = (session: BrowserSession, query = '') =>
    app.inject({
      method: 'GET',
      url: `/api/sales-orders${query}`,
      headers: { cookie: session.cookie },
    });

  const readOrder = (session: BrowserSession, orderId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/sales-orders/${orderId}`,
      headers: { cookie: session.cookie },
    });

  const counter = async () => {
    await ownerContext(TENANT, COMPANY);
    const rows = await owner.query<{ next_value: string }>(
      'SELECT next_value FROM document_number_sequences WHERE company_id = $1',
      [COMPANY],
    );
    return rows.rows[0]?.next_value;
  };

  const counts = async () => {
    await ownerContext(TENANT, COMPANY);
    const rows = await owner.query<{ reservations: string; events: string; records: string }>(
      `SELECT (SELECT count(*) FROM stock_reservations)::text AS reservations,
              (SELECT count(*) FROM audit_events WHERE action = 'sales_order_confirmed')::text AS events,
              (SELECT count(*) FROM idempotency_records)::text AS records`,
    );
    return rows.rows[0];
  };

  // -------------------------------------------------------------------------------------
  // 1, 12, 13, 14 and 16. The happy path, and exactly one of everything.
  // -------------------------------------------------------------------------------------

  describe('a valid confirmation', () => {
    it('answers 200 with the order, its number and its reservations', async () => {
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      const response = await confirm(seller, orderId, 'key-happy');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: orderId,
        status: 'confirmed',
        docNumber: 'SO-0001',
        reservations: 1,
      });
    });

    it('produces exactly one number, one audit record and one reservation', async () => {
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      await confirm(seller, orderId, 'key-once');

      expect(await counts()).toEqual({ reservations: '1', events: '1', records: '1' });
      expect(await counter()).toBe('2');
    });

    it('takes the company from the session rather than anything sent', async () => {
      // There is no body on this route at all, which is the simplest defence section 14.3 can
      // have. A caller wanting another company has nowhere to say so.
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      const response = await app.inject({
        method: 'POST',
        url: `/api/sales-orders/${orderId}/confirm`,
        headers: mutating(seller, { 'idempotency-key': 'key-body' }),
        payload: { companyId: SIBLING, docNumber: 'SO-9999', status: 'delivered' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().docNumber).toBe('SO-0001');
      expect(response.json().status).toBe('confirmed');
    });
  });

  // -------------------------------------------------------------------------------------
  // 2, 3 and 4. Who may call it.
  // -------------------------------------------------------------------------------------

  describe('access', () => {
    it('refuses an unauthenticated caller', async () => {
      const orderId = await draft(COMPANY, '1');

      const response = await app.inject({
        method: 'POST',
        url: `/api/sales-orders/${orderId}/confirm`,
        headers: { 'idempotency-key': 'key-anon' },
      });

      expect([401, 403]).toContain(response.statusCode);
      expect(await counts()).toMatchObject({ records: '0' });
    });

    it('refuses a signed-in caller without sales:confirm', async () => {
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      const response = await confirm(clerk, orderId, 'key-clerk');

      expect(response.statusCode).toBe(403);
      // Refused by the guard before anything ran, so no key was claimed either.
      expect(await counts()).toEqual({ reservations: '0', events: '0', records: '0' });
    });

    it('answers not found for an order in a sibling company', async () => {
      await stock(SIBLING, SIBLING_WIDGET, '100');
      const theirs = await draft(SIBLING, '10');

      const response = await confirm(seller, theirs, 'key-sibling');

      // Section 6.1: the same answer as a missing order.
      expect(response.statusCode).toBe(404);
      await ownerContext(TENANT, SIBLING);
      const row = await owner.query('SELECT status FROM sales_orders WHERE id = $1', [theirs]);
      expect(row.rows[0]).toMatchObject({ status: 'draft' });
    });

    it('answers not found for an order that does not exist', async () => {
      const response = await confirm(seller, 'e8990000-0000-4000-8000-00000000000f', 'key-ghost');

      expect(response.statusCode).toBe(404);
    });

    it('answers not found for an identifier that is not a uuid', async () => {
      // Not a 400. Telling a malformed identifier from a real one nobody may see would be a way
      // to probe, which is the same reasoning as 6.1.
      const response = await confirm(seller, 'not-a-uuid', 'key-malformed');

      expect(response.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------------------
  // 5, 6 and 7. Domain refusals, and the status codes they map to.
  // -------------------------------------------------------------------------------------

  describe('domain refusals', () => {
    it('answers 409 for an order that is already confirmed', async () => {
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');
      await confirm(seller, orderId, 'key-first');

      // A different key, so this is a genuinely new intent rather than a replay.
      const response = await confirm(seller, orderId, 'key-second');

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toMatch(/cannot move from confirmed to confirmed/);
      expect(await counts()).toMatchObject({ reservations: '1', events: '1' });
    });

    it('answers 422 when there is not enough stock', async () => {
      await stock(COMPANY, WIDGET, '5');
      const orderId = await draft(COMPANY, '10');

      const response = await confirm(seller, orderId, 'key-short');

      expect(response.statusCode).toBe(422);
      expect(response.json().message).toMatch(/available/);
    });

    it('answers 422 for an order with no lines', async () => {
      const orderId = nextId('f1');
      await ownerContext(TENANT, COMPANY);
      await owner.query(
        `INSERT INTO sales_orders (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
         VALUES ($1,$2,$3,'draft',$4,$5,current_date,'USD')`,
        [orderId, TENANT, COMPANY, CUSTOMER, WAREHOUSE],
      );

      const response = await confirm(seller, orderId, 'key-empty');

      expect(response.statusCode).toBe(422);
    });

    it('exposes no database detail when a refusal happens', async () => {
      await stock(COMPANY, WIDGET, '5');
      const orderId = await draft(COMPANY, '10');

      const response = await confirm(seller, orderId, 'key-leak');

      const body = JSON.stringify(response.json());
      expect(body).not.toMatch(/stock_reservations|relation|constraint|pg_|select /i);
    });
  });

  // -------------------------------------------------------------------------------------
  // The header itself.
  // -------------------------------------------------------------------------------------

  describe('the idempotency key', () => {
    it('is required, per section 11', async () => {
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      const response = await confirm(seller, orderId, undefined);

      expect(response.statusCode).toBe(400);
      expect(await counts()).toMatchObject({ reservations: '0' });
    });

    it.each(['', 'has a space', 'x'.repeat(256)])('refuses %s as a key', async (key) => {
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      const response = await confirm(seller, orderId, key);

      expect(response.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------------------
  // 8, 9, 10 and 15. The idempotency semantics of section 11.
  // -------------------------------------------------------------------------------------

  describe('a retry with the same key', () => {
    it('returns the stored response without doing the work again', async () => {
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      const first = await confirm(seller, orderId, 'key-retry');
      const second = await confirm(seller, orderId, 'key-retry');

      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      // The proof that the operation did not run again: one of everything, still.
      expect(await counts()).toEqual({ reservations: '1', events: '1', records: '1' });
      expect(await counter()).toBe('2');
    });

    it('replays rather than failing on the transition table', async () => {
      // Without the idempotency record this would be a second confirmation and a 409. That it
      // answers the stored 200 instead is exactly what section 11 asks for.
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');
      await confirm(seller, orderId, 'key-replay');

      const response = await confirm(seller, orderId, 'key-replay');

      expect(response.statusCode).toBe(200);
      expect(response.json().docNumber).toBe('SO-0001');
    });

    it('answers 409 when the same key carries a different request', async () => {
      await stock(COMPANY, WIDGET, '100');
      const first = await draft(COMPANY, '10');
      const second = await draft(COMPANY, '10');

      await confirm(seller, first, 'key-shared');
      const response = await confirm(seller, second, 'key-shared');

      expect(response.statusCode).toBe(409);
      expect((await counts())?.reservations).toBe('1');
      expect((await orderStatus(second))).toBe('draft');
    });

    it('treats the same key from another user as a different intent', async () => {
      // Section 11 scopes a record by company, user and endpoint. The clerk cannot confirm, so
      // a 403 rather than a replay of the seller's response is what proves the key is not shared.
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');
      await confirm(seller, orderId, 'key-mine');

      const response = await confirm(clerk, orderId, 'key-mine');

      expect(response.statusCode).toBe(403);
    });

    it('does not keep a record when the confirmation rolled back', async () => {
      // The test this whole boundary exists for. A failed attempt must leave no claim behind, or
      // every retry afterwards replays a success that never happened.
      await stock(COMPANY, WIDGET, '5');
      const orderId = await draft(COMPANY, '10');

      const failed = await confirm(seller, orderId, 'key-rollback');
      expect(failed.statusCode).toBe(422);
      expect(await counts()).toEqual({ reservations: '0', events: '0', records: '0' });

      // Now make it possible, and retry with the same key. It must do the work rather than
      // replaying the failure or refusing as a duplicate.
      await stock(COMPANY, WIDGET, '100');
      const retried = await confirm(seller, orderId, 'key-rollback');

      expect(retried.statusCode).toBe(200);
      expect(retried.json().docNumber).toBe('SO-0001');
      expect(await counts()).toEqual({ reservations: '1', events: '1', records: '1' });
    });

    it('stores the record in the same transaction as the confirmation', async () => {
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      await confirm(seller, orderId, 'key-atomic');

      await ownerContext(TENANT, COMPANY);
      const written = await owner.query<{ xmin: string }>(
        `SELECT xmin::text AS xmin FROM sales_orders WHERE id = $1
         UNION
         SELECT xmin::text FROM stock_reservations
         UNION
         SELECT xmin::text FROM idempotency_records`,
        [orderId],
      );

      // One transaction wrote the order, its reservation and the idempotency record. Two values
      // would mean a record that could outlive the work it describes.
      expect(written.rows).toHaveLength(1);
    });

    it('scopes the record by company, user and endpoint', async () => {
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      await confirm(seller, orderId, 'key-scope');

      await ownerContext(TENANT, COMPANY);
      const rows = await owner.query<{
        tenant_id: string;
        company_id: string;
        user_id: string;
        endpoint: string;
        idempotency_key: string;
        response_status: number;
      }>('SELECT * FROM idempotency_records');

      expect(rows.rows[0]).toMatchObject({
        tenant_id: TENANT,
        company_id: COMPANY,
        user_id: SELLER,
        endpoint: 'POST sales-orders/:id/confirm',
        idempotency_key: 'key-scope',
        response_status: 200,
      });
    });
  });

  // -------------------------------------------------------------------------------------
  // 11. Concurrent identical requests.
  // -------------------------------------------------------------------------------------

  describe('two identical requests at once', () => {
    it('confirms once and replays the other', async () => {
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      const [first, second] = await Promise.all([
        confirm(seller, orderId, 'key-race'),
        confirm(seller, orderId, 'key-race'),
      ]);

      // Both answer the same thing, because one did the work and the other waited on the unique
      // index and then read what it stored.
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.json()).toEqual(second.json());

      // And exactly one of everything happened.
      expect(await counts()).toEqual({ reservations: '1', events: '1', records: '1' });
      expect(await counter()).toBe('2');
    });

    it('holds to one confirmation when many arrive together', async () => {
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => confirm(seller, orderId, 'key-storm')),
      );

      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(new Set(responses.map((response) => JSON.stringify(response.json()))).size).toBe(1);
      expect(await counts()).toEqual({ reservations: '1', events: '1', records: '1' });
    });

    it('lets only one through when two different keys race for one order', async () => {
      // Two genuinely different intents. The idempotency layer does not apply, so this falls to
      // the transition table and the version guard beneath it.
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      const responses = await Promise.all([
        confirm(seller, orderId, 'key-a'),
        confirm(seller, orderId, 'key-b'),
      ]);

      const ok = responses.filter((response) => response.statusCode === 200);
      expect(ok).toHaveLength(1);
      expect(await counts()).toMatchObject({ reservations: '1', events: '1' });
      expect(await counter()).toBe('2');
    });

    it('refuses a concurrent pair sharing a key but naming different orders', async () => {
      await stock(COMPANY, WIDGET, '100');
      const first = await draft(COMPANY, '10');
      const second = await draft(COMPANY, '10');

      const responses = await Promise.all([
        confirm(seller, first, 'key-clash'),
        confirm(seller, second, 'key-clash'),
      ]);

      const statuses = responses.map((response) => response.statusCode).sort();
      expect(statuses).toEqual([200, 409]);
      expect((await counts())?.reservations).toBe('1');
    });
  });

  async function orderStatus(id: string): Promise<string | undefined> {
    await ownerContext(TENANT, COMPANY);
    const rows = await owner.query<{ status: string }>(
      'SELECT status FROM sales_orders WHERE id = $1',
      [id],
    );
    return rows.rows[0]?.status;
  }
// -------------------------------------------------------------------------------------
  // Reading an order over HTTP.
  // -------------------------------------------------------------------------------------

  describe('reading an order', () => {
    it('returns the persisted document and its lines', async () => {
      const orderId = await draft(COMPANY, '10');

      const response = await readOrder(seller, orderId);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: orderId,
        status: 'draft',
        docNumber: null,
        currency: 'USD',
        customer: { id: CUSTOMER },
        warehouse: { id: WAREHOUSE },
      });
      expect(response.json().lines).toHaveLength(1);
    });

    it('needs only sales:view, not the capability to act on it', async () => {
      // The clerk can see a sales order and cannot confirm one. Gating the read behind the
      // capability to change it would be the wrong shape.
      const orderId = await draft(COMPANY, '10');

      expect((await readOrder(clerk, orderId)).statusCode).toBe(200);
      expect((await confirm(clerk, orderId, 'key-clerk-read')).statusCode).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
      const orderId = await draft(COMPANY, '10');

      const response = await app.inject({
        method: 'GET',
        url: `/api/sales-orders/${orderId}`,
      });

      expect([401, 403]).toContain(response.statusCode);
    });

    it('answers not found for an order in a sibling company', async () => {
      const theirs = await draft(SIBLING, '10');

      // A real order that really exists. Section 6.1 makes this indistinguishable from a missing
      // one, so knowing its identifier reveals nothing.
      expect((await readOrder(seller, theirs)).statusCode).toBe(404);
    });

    it('answers not found for an order that does not exist', async () => {
      const response = await readOrder(seller, 'e8990000-0000-4000-8000-00000000000f');

      expect(response.statusCode).toBe(404);
    });

    it('answers not found for an identifier that is not a uuid', async () => {
      expect((await readOrder(seller, 'not-a-uuid')).statusCode).toBe(404);
    });

    it('shows the number and status a confirmation gave it', async () => {
      // The read and the write agreeing, which is what makes the detail screen coherent after
      // the action rather than only during it.
      await stock(COMPANY, WIDGET, '100');
      const orderId = await draft(COMPANY, '10');

      await confirm(seller, orderId, 'key-read-after');
      const response = await readOrder(seller, orderId);

      expect(response.json()).toMatchObject({
        status: 'confirmed',
        docNumber: 'SO-0001',
      });
    });

    it('reads figures from the database rather than from anything cached', async () => {
      const orderId = await draft(COMPANY, '10');

      await ownerContext(TENANT, COMPANY);
      await owner.query(`UPDATE sales_orders SET total = '777.0000' WHERE id = $1`, [orderId]);

      expect((await readOrder(seller, orderId)).json().total).toBe('777.0000');
    });
  });
// -------------------------------------------------------------------------------------
  // Listing orders over HTTP.
  // -------------------------------------------------------------------------------------

  describe('listing orders', () => {
    it('returns only this company orders, with what the list screen renders', async () => {
      const orderId = await draft(COMPANY, '10');

      const response = await listOrders(seller);

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.rows[0]).toMatchObject({
        id: orderId,
        status: 'draft',
        docNumber: null,
        customer: { name: 'Buyer' },
        warehouse: { name: 'Main' },
        lineCount: 1,
        orderedQuantity: '10.000000',
        deliveredQuantity: '0.000000',
      });
    });

    it('excludes a sibling company orders', async () => {
      await draft(COMPANY, '10');
      await draft(SIBLING, '10');

      const body = (await listOrders(seller)).json();

      // One, not two. The sibling's order is a real row in the same tenant.
      expect(body.total).toBe(1);
      expect(body.rows).toHaveLength(1);
    });

    it('shows each company only its own, under the same call', async () => {
      const mine = await draft(COMPANY, '10');
      const theirs = await draft(SIBLING, '10');

      const ids = (await listOrders(seller)).json().rows.map((row: { id: string }) => row.id);

      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
    });

    it('answers an empty page rather than an error when there is nothing', async () => {
      const body = (await listOrders(seller)).json();

      expect(body).toMatchObject({ rows: [], total: 0, page: 1, totalValue: '0' });
    });

    it('totals the whole filtered set rather than the page', async () => {
      // Three orders, a page of two. The value has to cover all three, because a user filtering a
      // list wants the total of what they filtered to, not of what happens to be visible.
      for (let index = 0; index < 3; index += 1) await draft(COMPANY, '10');
      await ownerContext(TENANT, COMPANY);
      await owner.query(`UPDATE sales_orders SET total = '100.0000'`);

      const body = (await listOrders(seller, '?pageSize=2')).json();

      expect(body.rows).toHaveLength(2);
      expect(body.total).toBe(3);
      expect(body.totalValue).toBe('300.0000');
    });

    it('orders deterministically, so pages do not overlap', async () => {
      // Every order here shares an order date, which is exactly when an unstable sort loses a row
      // between pages. The identifier is the tiebreaker that stops it.
      for (let index = 0; index < 5; index += 1) await draft(COMPANY, '10');

      const first = (await listOrders(seller, '?pageSize=2&page=1')).json();
      const second = (await listOrders(seller, '?pageSize=2&page=2')).json();
      const third = (await listOrders(seller, '?pageSize=2&page=3')).json();

      const seen = [...first.rows, ...second.rows, ...third.rows].map((r: { id: string }) => r.id);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('filters by status without leaving the company', async () => {
      await stock(COMPANY, WIDGET, '100');
      const confirmed = await draft(COMPANY, '10');
      await draft(COMPANY, '10');
      await confirm(seller, confirmed, 'key-list-filter');

      const body = (await listOrders(seller, '?status=confirmed')).json();

      expect(body.total).toBe(1);
      expect(body.rows[0]?.id).toBe(confirmed);
    });

    it('searches the document number and the customer', async () => {
      await stock(COMPANY, WIDGET, '100');
      const numbered = await draft(COMPANY, '10');
      await draft(COMPANY, '10');
      await confirm(seller, numbered, 'key-list-search');

      expect((await listOrders(seller, '?search=SO-0001')).json().total).toBe(1);
      expect((await listOrders(seller, '?search=Buyer')).json().total).toBe(2);
      expect((await listOrders(seller, '?search=nobody')).json().total).toBe(0);
    });

    it('needs only sales:view', async () => {
      await draft(COMPANY, '10');

      expect((await listOrders(clerk)).statusCode).toBe(200);
    });

    it('refuses an unauthenticated caller', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/sales-orders' });

      expect([401, 403]).toContain(response.statusCode);
    });

    it('refuses a query it does not understand rather than ignoring it', async () => {
      // Section 14.2: unknown fields rejected rather than ignored. A caller naming a company is
      // the case that matters, and it is refused rather than quietly dropped.
      expect((await listOrders(seller, '?companyId=' + SIBLING)).statusCode).toBe(400);
      expect((await listOrders(seller, '?sortBy=total_secret')).statusCode).toBe(400);
      expect((await listOrders(seller, '?pageSize=100000')).statusCode).toBe(400);
    });

    it('leaks no database vocabulary when it refuses', async () => {
      const body = JSON.stringify((await listOrders(seller, '?sortBy=; drop table')).json());

      expect(body).not.toMatch(/sales_orders|relation|column|select |pg_/i);
    });

    it('returns identifiers the detail route actually serves', async () => {
      // The regression this whole work package exists for. Every identifier the list hands back
      // must be one the detail endpoint answers, or the navigation is broken again.
      await draft(COMPANY, '10');
      await draft(COMPANY, '10');

      const rows = (await listOrders(seller)).json().rows as { id: string }[];

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect((await readOrder(seller, row.id)).statusCode).toBe(200);
      }
    });
  });
  // -------------------------------------------------------------------------------------
  // Creating a draft over HTTP.
  // -------------------------------------------------------------------------------------

  describe('creating a draft', () => {
    it('answers 201 with the order the detail endpoint would describe', async () => {
      const response = await createOrder(seller, validOrder());

      expect(response.statusCode).toBe(201);
      const created = response.json();
      expect(created).toMatchObject({ status: 'draft', docNumber: null, currency: 'USD' });

      // The same shape as reading it back, because there is one mapping rather than two.
      const read = await readOrder(seller, created.id);
      expect(read.json()).toEqual(created);
    });

    it('leaves it a draft with no number', async () => {
      const created = (await createOrder(seller, validOrder())).json();

      expect(created.docNumber).toBeNull();
      expect(created.status).toBe('draft');
      expect(await counter()).toBe('1');
    });

    it('prices the lines from master data rather than from the request', async () => {
      // Three widgets at the catalogue price of ten. The request named neither figure.
      const created = (await createOrder(seller, validOrder())).json();

      expect(created.lines).toHaveLength(1);
      expect(created.lines[0]).toMatchObject({ quantity: '3.000000', unitPrice: '10.000000' });
      expect(created.total).not.toBe('0.0000');
    });

    it('refuses a price, a total or a status sent anyway', async () => {
      // Section 14.2 rejects unknown fields rather than ignoring them, which is also the answer
      // to section 14.3 on mass assignment.
      for (const extra of [
        { total: '0.0100' },
        { status: 'confirmed' },
        { docNumber: 'SO-9999' },
        { companyId: SIBLING },
      ]) {
        expect((await createOrder(seller, validOrder(extra))).statusCode).toBe(400);
      }
    });

    it('refuses a price smuggled onto a line', async () => {
      const response = await createOrder(
        seller,
        validOrder({ lines: [{ productId: WIDGET, quantity: '3', unitPrice: '0.010000' }] }),
      );

      expect(response.statusCode).toBe(400);
    });

    it('appears in the list it belongs to', async () => {
      const created = (await createOrder(seller, validOrder())).json();

      const rows = (await listOrders(seller)).json().rows as { id: string }[];

      expect(rows.map((row) => row.id)).toContain(created.id);
    });

    it('can then be confirmed', async () => {
      // The whole path in one test: create, read, confirm.
      await stock(COMPANY, WIDGET, '100');
      const created = (await createOrder(seller, validOrder())).json();

      const confirmed = await confirm(seller, created.id, 'key-create-confirm');

      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().docNumber).toBe('SO-0001');
    });

    it('needs sales:create, which the clerk does not hold', async () => {
      const response = await createOrder(clerk, validOrder(), 'key-clerk-create');

      expect(response.statusCode).toBe(403);
      expect((await listOrders(seller)).json().total).toBe(0);
    });

    it('refuses an unauthenticated caller', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sales-orders',
        headers: { 'idempotency-key': 'key-anon-create' },
        payload: validOrder(),
      });

      expect([401, 403]).toContain(response.statusCode);
    });

    it('requires an idempotency key', async () => {
      const response = await createOrder(seller, validOrder(), null);

      expect(response.statusCode).toBe(400);
      expect((await listOrders(seller)).json().total).toBe(0);
    });

    it('replays a retry rather than creating a second order', async () => {
      const first = await createOrder(seller, validOrder(), 'key-twice');
      const second = await createOrder(seller, validOrder(), 'key-twice');

      expect(second.json()).toEqual(first.json());
      expect((await listOrders(seller)).json().total).toBe(1);
    });

    it('refuses the same key carrying a different order', async () => {
      await createOrder(seller, validOrder(), 'key-shared-create');

      const response = await createOrder(
        seller,
        validOrder({ orderDate: '2026-09-13' }),
        'key-shared-create',
      );

      expect(response.statusCode).toBe(409);
      expect((await listOrders(seller)).json().total).toBe(1);
    });
  });

  describe('a draft that cannot be created', () => {
    const refusedBy = (payload: Record<string, unknown>, key = 'key-bad') => createOrder(seller, payload, key);

    it('refuses a customer from a sibling company', async () => {
      // A real customer, in a real company of the same tenant. Section 6.1 answers the same as
      // for one that does not exist, so an identifier reveals nothing.
      const response = await refusedBy(validOrder({ customerId: SIBLING_CUSTOMER }));

      expect(response.statusCode).toBe(422);
      expect(response.json().message).toBe('Customer not found');
    });

    it('refuses a warehouse from a sibling company', async () => {
      const response = await refusedBy(validOrder({ warehouseId: SIBLING_WAREHOUSE }));

      expect(response.statusCode).toBe(422);
      expect(response.json().message).toBe('Warehouse not found');
    });

    it('refuses a product from a sibling company', async () => {
      const response = await refusedBy(
        validOrder({ lines: [{ productId: SIBLING_WIDGET, quantity: '1' }] }),
      );

      expect(response.statusCode).toBe(422);
      expect(response.json().message).toBe('Product not found');
    });

    it('refuses master data that does not exist', async () => {
      const response = await refusedBy(
        validOrder({ customerId: 'e8990000-0000-4000-8000-00000000000f' }),
      );

      expect(response.statusCode).toBe(422);
    });

    it.each(['0', '-1', 'abc', '1.1234567'])('refuses a quantity of %s', async (quantity) => {
      const response = await refusedBy(validOrder({ lines: [{ productId: WIDGET, quantity }] }));

      expect(response.statusCode).toBe(422);
    });

    it('refuses an order with no lines', async () => {
      // Established from the contract rather than assumed: section 12.2 prices a draft from its
      // lines, and an order promising nothing is not a draft of anything.
      const response = await refusedBy(validOrder({ lines: [] }));

      expect(response.statusCode).toBe(400);
    });

    it('writes nothing at all when it refuses', async () => {
      await refusedBy(
        validOrder({
          lines: [
            { productId: WIDGET, quantity: '1' },
            { productId: SIBLING_WIDGET, quantity: '1' },
          ],
        }),
      );

      // Not one line, not a header, and no idempotency record to block the retry.
      expect((await listOrders(seller)).json().total).toBe(0);
      await ownerContext(TENANT, COMPANY);
      const lines = await owner.query('SELECT 1 FROM sales_order_lines');
      const records = await owner.query('SELECT 1 FROM idempotency_records');
      expect(lines.rowCount).toBe(0);
      expect(records.rowCount).toBe(0);
    });

    it('lets the retry after a refusal succeed', async () => {
      await refusedBy(validOrder({ customerId: SIBLING_CUSTOMER }), 'key-retry-create');

      const response = await createOrder(seller, validOrder(), 'key-retry-create');

      expect(response.statusCode).toBe(201);
    });

    it('leaks no database vocabulary when it refuses', async () => {
      const refused = await refusedBy(validOrder({ customerId: SIBLING_CUSTOMER }));
      const body = JSON.stringify(refused.json());

      expect(body).not.toMatch(/sales_orders|relation|constraint|column|pg_|select /i);
    });
  });
});
