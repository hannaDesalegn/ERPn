/**
 * The sales repositories, against a real PostgreSQL.
 *
 * The schema suite already proved what the database refuses. This proves the layer above it
 * refuses the same things, which contract section 2.4 requires as the first of two layers and
 * permits neither to stand alone. Everything here goes through the public data layer API rather
 * than through raw SQL, because that is the surface a future service will actually hold.
 *
 * TWO TENANTS WITH COLLIDING DATA. Each has an order, and one tenant has two companies so that
 * "wrong company, right tenant" is representable. A scoping mistake that filtered by tenant and
 * forgot company would pass a single-company seed and fail here.
 *
 * Everything runs as the application role, so row level security applies underneath throughout.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../../config/config.module.js';
import { DatabaseModule } from '../database.module.js';
import { actorScope, principalScope, systemScope, UnitOfWork } from '../index.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'a6100000-0000-4000-8000-00000000000a';
const TENANT_B = 'a6200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'b6100000-0000-4000-8000-00000000000a';
const COMPANY_A2 = 'b6200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'b6300000-0000-4000-8000-00000000000c';

const USER_A = 'c6100000-0000-4000-8000-00000000000a';
const USER_B = 'c6200000-0000-4000-8000-00000000000b';

/** Master data identifiers with no tables behind them yet. */
const CUSTOMER = 'd6100000-0000-4000-8000-00000000000a';
const WAREHOUSE = 'd6200000-0000-4000-8000-00000000000b';
const PRODUCT = 'd6300000-0000-4000-8000-00000000000c';

const ORDER_A1 = 'e6100000-0000-4000-8000-00000000000a';
const ORDER_A2 = 'e6200000-0000-4000-8000-00000000000b';
const ORDER_B1 = 'e6300000-0000-4000-8000-00000000000c';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const inA1 = () => actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: USER_A });
const inA2 = () => actorScope({ tenantId: TENANT_A, companyId: COMPANY_A2, userId: USER_A });
const inB1 = () => actorScope({ tenantId: TENANT_B, companyId: COMPANY_B1, userId: USER_B });

describe('Sales repositories', () => {
  let uow: UnitOfWork;
  let owner: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    if (!MIGRATION_URL || !process.env['DATABASE_URL']) {
      throw new Error(
        'DATABASE_URL and MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate` first.',
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
    }).compile();
    await moduleRef.init();

    uow = moduleRef.get(UnitOfWork);
    close = () => moduleRef.close();

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();

    await purge();
    await seed();
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await close();
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'sales-repo-a',
      'Sales Repo A',
      TENANT_B,
      'sales-repo-b',
      'Sales Repo B',
    ]);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_A }), async (r) => {
      await r.users.create({ id: USER_A, email: 'a@salesrepo.test', name: 'A', passwordHash: 'x' });
      await r.users.create({ id: USER_B, email: 'b@salesrepo.test', name: 'B', passwordHash: 'x' });
      await r.companies.create({ id: COMPANY_A1, name: 'A One', baseCurrency: 'USD' });
      await r.companies.create({ id: COMPANY_A2, name: 'A Two', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_B }), (r) =>
      r.companies.create({ id: COMPANY_B1, name: 'B One', baseCurrency: 'EUR' }),
    );

    // One order per company, created through the repository under each company's own scope.
    const orders: [string, ReturnType<typeof inA1>, string][] = [
      [ORDER_A1, inA1(), 'USD'],
      [ORDER_A2, inA2(), 'USD'],
      [ORDER_B1, inB1(), 'EUR'],
    ];
    for (const [id, scope, currency] of orders) {
      await uow.inActorScope(scope, (r) =>
        r.salesOrders.create({
          id,
          customerId: CUSTOMER,
          warehouseId: WAREHOUSE,
          orderDate: '2026-09-11',
          currency,
        }),
      );
    }
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM sales_order_lines WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM sales_orders WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM document_number_sequences WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[USER_A, USER_B]]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  // -------------------------------------------------------------------------------------
  // Reading.
  // -------------------------------------------------------------------------------------

  describe('reading orders', () => {
    it('lists only the acting company orders', async () => {
      const seen = await uow.inActorScope(inA1(), (r) => r.salesOrders.listForCompany());

      expect(seen.map((o) => o.id)).toEqual([ORDER_A1]);
    });

    it('cannot reach a sibling company order by identifier', async () => {
      const found = await uow.inActorScope(inA1(), (r) => r.salesOrders.findById(ORDER_A2));

      // Section 6.1: a failure at this dimension is indistinguishable from the record not
      // existing. Null, not an error, so an identifier cannot be probed.
      expect(found).toBeNull();
    });

    it('cannot reach another tenant order by identifier', async () => {
      const found = await uow.inActorScope(inA1(), (r) => r.salesOrders.findById(ORDER_B1));

      expect(found).toBeNull();
    });

    it('makes a foreign identifier indistinguishable from a missing one', async () => {
      const foreign = await uow.inActorScope(inA1(), (r) => r.salesOrders.findById(ORDER_B1));
      const missing = await uow.inActorScope(inA1(), (r) =>
        r.salesOrders.findById('e6900000-0000-4000-8000-00000000000f'),
      );

      expect(foreign).toEqual(missing);
    });

    it('returns its own order to the company that owns it', async () => {
      // Without this the refusals above would pass for a repository that returned nothing ever.
      const found = await uow.inActorScope(inB1(), (r) => r.salesOrders.findById(ORDER_B1));

      expect(found?.id).toBe(ORDER_B1);
      expect(found?.companyId).toBe(COMPANY_B1);
    });
  });

  // -------------------------------------------------------------------------------------
  // Writing.
  // -------------------------------------------------------------------------------------

  describe('writing orders', () => {
    it('stamps tenant and company from the scope, not from the caller', async () => {
      const id = 'e6400000-0000-4000-8000-00000000000d';
      const created = await uow.inActorScope(inA2(), (r) =>
        r.salesOrders.create({
          id,
          customerId: CUSTOMER,
          warehouseId: WAREHOUSE,
          orderDate: '2026-09-11',
          currency: 'USD',
        }),
      );

      // `NewSalesOrder` has no tenant or company field, so there is nothing to pass. This
      // records that what was stamped is the acting scope rather than anything else.
      expect(created.tenantId).toBe(TENANT_A);
      expect(created.companyId).toBe(COMPANY_A2);

      await ownerContext(TENANT_A, COMPANY_A2);
      await owner.query('DELETE FROM sales_orders WHERE id = $1', [id]);
    });

    it('creates a draft with no document number, which is the only thing it can create', async () => {
      const id = 'e6500000-0000-4000-8000-00000000000e';
      const created = await uow.inActorScope(inA1(), (r) =>
        r.salesOrders.create({
          id,
          customerId: CUSTOMER,
          warehouseId: WAREHOUSE,
          orderDate: '2026-09-11',
          currency: 'USD',
        }),
      );

      // Section 12.2 allocates the number as step four of the confirming transaction, and this
      // layer does not confirm anything.
      expect(created.status).toBe('draft');
      expect(created.docNumber).toBeNull();
      expect(created.version).toBe(1);

      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('DELETE FROM sales_orders WHERE id = $1', [id]);
    });

    it('keeps money as exact decimal strings', async () => {
      // Section 4.3: a JavaScript number is an IEEE-754 double and loses precision silently, so
      // the boundary hands back what the database holds.
      const found = await uow.inActorScope(inA1(), (r) => r.salesOrders.findById(ORDER_A1));

      expect(typeof found?.total).toBe('string');
      expect(found?.total).toBe('0.0000');
    });

    it('cannot write into another company, even with its identifiers in hand', async () => {
      // The scope is the only thing that decides where a row lands. Acting in one company while
      // holding another company's order id changes nothing about where the write goes.
      const id = 'e6600000-0000-4000-8000-00000000000f';
      await uow.inActorScope(inA1(), (r) =>
        r.salesOrders.create({
          id,
          customerId: CUSTOMER,
          warehouseId: WAREHOUSE,
          orderDate: '2026-09-11',
          currency: 'USD',
        }),
      );

      const fromSibling = await uow.inActorScope(inA2(), (r) => r.salesOrders.findById(id));
      const fromOwner = await uow.inActorScope(inA1(), (r) => r.salesOrders.findById(id));

      expect(fromSibling).toBeNull();
      expect(fromOwner?.companyId).toBe(COMPANY_A1);

      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('DELETE FROM sales_orders WHERE id = $1', [id]);
    });
  });

  // -------------------------------------------------------------------------------------
  // Lines, and the parent they belong to.
  // -------------------------------------------------------------------------------------

  describe('lines', () => {
    const line = (id: string, salesOrderId: string, lineNumber: number, currency = 'USD') => ({
      id,
      salesOrderId,
      lineNumber,
      productId: PRODUCT,
      productSku: 'SKU-1',
      productName: 'Widget',
      quantity: '2.500000',
      unitPrice: '1.250000',
      currency,
    });

    it('adds a line to an order in the acting company', async () => {
      const id = 'f6100000-0000-4000-8000-00000000000a';
      const created = await uow.inActorScope(inA1(), (r) =>
        r.salesOrderLines.create(line(id, ORDER_A1, 1)),
      );

      expect(created.tenantId).toBe(TENANT_A);
      expect(created.companyId).toBe(COMPANY_A1);
      expect(created.quantity).toBe('2.500000');

      await uow.inActorScope(inA1(), (r) => r.salesOrderLines.remove(id));
    });

    it('refuses a line on an order in another company', async () => {
      // Acting in the sibling company, pointing at the first company's order. The composite key
      // refuses it: a line cannot belong to an order outside its own tenant and company.
      await expect(
        uow.inActorScope(inA2(), (r) =>
          r.salesOrderLines.create(line('f6200000-0000-4000-8000-00000000000b', ORDER_A1, 1)),
        ),
      ).rejects.toThrow();
    });

    it('refuses a line on an order in another tenant', async () => {
      await expect(
        uow.inActorScope(inB1(), (r) =>
          r.salesOrderLines.create(
            line('f6300000-0000-4000-8000-00000000000c', ORDER_A1, 1, 'EUR'),
          ),
        ),
      ).rejects.toThrow();
    });

    it('refuses a line carrying a currency its order does not', async () => {
      await expect(
        uow.inActorScope(inA1(), (r) =>
          r.salesOrderLines.create(
            line('f6400000-0000-4000-8000-00000000000d', ORDER_A1, 2, 'EUR'),
          ),
        ),
      ).rejects.toThrow();
    });

    it('lists lines only for an order in the acting company', async () => {
      const id = 'f6500000-0000-4000-8000-00000000000e';
      await uow.inActorScope(inA1(), (r) => r.salesOrderLines.create(line(id, ORDER_A1, 3)));

      const own = await uow.inActorScope(inA1(), (r) => r.salesOrderLines.listForOrder(ORDER_A1));
      const sibling = await uow.inActorScope(inA2(), (r) =>
        r.salesOrderLines.listForOrder(ORDER_A1),
      );
      const foreign = await uow.inActorScope(inB1(), (r) =>
        r.salesOrderLines.listForOrder(ORDER_A1),
      );

      expect(own.map((l) => l.id)).toEqual([id]);
      // The order identifier is real and the lines exist. Asking from anywhere else returns
      // nothing rather than that company's lines.
      expect(sibling).toEqual([]);
      expect(foreign).toEqual([]);

      await uow.inActorScope(inA1(), (r) => r.salesOrderLines.remove(id));
    });

    it('removes only within the acting company', async () => {
      const id = 'f6600000-0000-4000-8000-00000000000f';
      await uow.inActorScope(inA1(), (r) => r.salesOrderLines.create(line(id, ORDER_A1, 4)));

      // A delete issued from the sibling company matches no row rather than removing one.
      await uow.inActorScope(inA2(), (r) => r.salesOrderLines.remove(id));
      const survived = await uow.inActorScope(inA1(), (r) =>
        r.salesOrderLines.listForOrder(ORDER_A1),
      );
      expect(survived.map((l) => l.id)).toEqual([id]);

      await uow.inActorScope(inA1(), (r) => r.salesOrderLines.remove(id));
      const removed = await uow.inActorScope(inA1(), (r) =>
        r.salesOrderLines.listForOrder(ORDER_A1),
      );
      expect(removed).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // Number sequences.
  // -------------------------------------------------------------------------------------

  describe('document number sequences', () => {
    it('creates one for the acting company and finds it by document type', async () => {
      const id = 'a7100000-0000-4000-8000-00000000000a';
      const created = await uow.inActorScope(inA1(), (r) =>
        r.documentNumberSequences.create({ id, docType: 'sales_order', prefix: 'SO-' }),
      );

      expect(created.companyId).toBe(COMPANY_A1);
      expect(created.prefix).toBe('SO-');
      // Section 10.4 makes gapless the per sequence setting, and true the safe default.
      expect(created.gapless).toBe(true);
      // The counter starts at one and is not advanced by anything in this layer.
      expect(created.nextValue).toBe(1n);

      const found = await uow.inActorScope(inA1(), (r) =>
        r.documentNumberSequences.findForDocType('sales_order'),
      );
      expect(found?.id).toBe(id);
    });

    it('does not find another company sequence, even for the same document type', async () => {
      const fromSibling = await uow.inActorScope(inA2(), (r) =>
        r.documentNumberSequences.findForDocType('sales_order'),
      );
      const fromOtherTenant = await uow.inActorScope(inB1(), (r) =>
        r.documentNumberSequences.findForDocType('sales_order'),
      );

      expect(fromSibling).toBeNull();
      expect(fromOtherTenant).toBeNull();
    });

    it('lists only the acting company sequences', async () => {
      const listed = await uow.inActorScope(inA1(), (r) =>
        r.documentNumberSequences.listForCompany(),
      );
      const sibling = await uow.inActorScope(inA2(), (r) =>
        r.documentNumberSequences.listForCompany(),
      );

      expect(listed.map((s) => s.docType)).toEqual(['sales_order']);
      expect(sibling).toEqual([]);
    });

    it('offers no way to allocate a number', async () => {
      // Section 10.4's allocation takes a row lock inside the transaction that creates the
      // document, and that transaction does not exist yet. A method here now would be a guess
      // at a mechanism whose whole difficulty is what surrounds it.
      //
      // `getOwnPropertyNames`, not `keys`. Class methods are non-enumerable, so the first
      // version of this read an empty list and would have passed whatever the repository
      // offered, which is the failure mode a negative assertion is most prone to.
      const surface = await uow.inActorScope(inA1(), async (r) =>
        Object.getOwnPropertyNames(Object.getPrototypeOf(r.documentNumberSequences) as object),
      );

      expect(surface).toEqual(
        expect.arrayContaining(['findForDocType', 'listForCompany', 'create']),
      );
      expect(surface).toEqual(
        expect.not.arrayContaining(['allocate', 'next', 'take', 'increment']),
      );
    });
  });

  // -------------------------------------------------------------------------------------
  // Scope is mandatory, and the failure is loud rather than empty.
  // -------------------------------------------------------------------------------------

  describe('scope is not optional', () => {
    it('refuses a system scope naming no tenant', async () => {
      await expect(
        uow.inSystemScope(systemScope('integration-test'), (r) =>
          r.salesOrders.listForCompany(),
        ),
      ).rejects.toThrow(/no tenant/);
    });

    it('refuses a system scope naming a tenant but no company', async () => {
      // A sales order belongs to exactly one company, so a tenant alone is not a scope for it.
      // Returning nothing here would read as an empty company rather than as a bug.
      await expect(
        uow.inSystemScope(systemScope('integration-test', { tenantId: TENANT_A }), (r) =>
          r.salesOrders.listForCompany(),
        ),
      ).rejects.toThrow(/no company/);
    });

    it('refuses a principal scope, which names neither', async () => {
      await expect(
        uow.inPrincipalScope(principalScope({ userId: USER_A }), (r) =>
          (
            r as unknown as { salesOrders: { listForCompany(): Promise<unknown> } }
          ).salesOrders.listForCompany(),
        ),
      ).rejects.toThrow(/no tenant/);
    });

    it('reaches nothing through a system scope that names both', async () => {
      // Named scopes do work, which is what makes the refusals above about the missing half
      // rather than about system scopes being refused outright.
      const seen = await uow.inSystemScope(
        systemScope('scheduled-maintenance', { tenantId: TENANT_A, companyId: COMPANY_A1 }),
        (r) => r.salesOrders.listForCompany(),
      );

      expect(seen.map((o) => o.id)).toEqual([ORDER_A1]);
    });
  });
});
