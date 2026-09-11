/**
 * The reservation record, against a real PostgreSQL.
 *
 * This increment persists reservations and nothing else. There is no availability calculation,
 * no oversell check, no locking and no release, so none of that is tested here: a test for
 * behaviour that does not exist would pass for the wrong reason and read as though the work were
 * done.
 *
 * What is worth proving is integrity. A reservation names four things, and every one of them is
 * an opportunity to point at another company's row. The seed therefore puts a complete order in
 * each of three companies across two tenants, so every cross-company reference below is a real
 * row that exists and must still be refused.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../../config/config.module.js';
import { DatabaseModule } from '../database.module.js';
import { actorScope, UnitOfWork } from '../index.js';
import type { ActorScope } from '../index.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'c1100000-0000-4000-8000-00000000000a';
const TENANT_B = 'c1200000-0000-4000-8000-00000000000b';

const COMPANY_A1 = 'c2100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "same tenant, different company" is representable. */
const COMPANY_A2 = 'c2200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'c2300000-0000-4000-8000-00000000000c';

const USER = 'c3100000-0000-4000-8000-00000000000a';

/** One complete order per company, so a cross-company reference is a real row. */
const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'c4110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'c4120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'c4130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'c4210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'c4220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'c4230000-0000-4000-8000-00000000000c',
};
const PRODUCT: Record<string, string> = {
  [COMPANY_A1]: 'c4310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'c4320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'c4330000-0000-4000-8000-00000000000c',
};
const ORDER: Record<string, string> = {
  [COMPANY_A1]: 'c4410000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'c4420000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'c4430000-0000-4000-8000-00000000000c',
};
const LINE: Record<string, string> = {
  [COMPANY_A1]: 'c4510000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'c4520000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'c4530000-0000-4000-8000-00000000000c',
};

/** A second product and warehouse in the acting company, for the mismatch cases. */
const OTHER_PRODUCT = 'c4610000-0000-4000-8000-00000000000a';
const OTHER_WAREHOUSE = 'c4710000-0000-4000-8000-00000000000a';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const scopeFor = (tenantId: string, companyId: string): ActorScope =>
  actorScope({ tenantId, companyId, userId: USER });

const IN_A1 = scopeFor(TENANT_A, COMPANY_A1);
const IN_A2 = scopeFor(TENANT_A, COMPANY_A2);

let nextId = 0;
const reservationId = () =>
  `c5${(nextId += 1).toString().padStart(6, '0')}-0000-4000-8000-00000000000a`;

/**
 * The constraint that refused a write, read out of the error's cause chain.
 *
 * The query layer wraps driver errors, so the constraint name is never in the outermost message.
 * Asserting on that message alone passes for the wrong reason.
 */
async function refusedBy(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );

  if (error === null) throw new Error('The write was expected to be refused and was not');

  const messages: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }

  return messages.join(' | ');
}

describe('Stock reservations', () => {
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

  beforeEach(async () => {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM stock_reservations WHERE company_id = $1', [companyId]);
    }
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'reserve-a',
      'Reserve A',
      TENANT_B,
      'reserve-b',
      'Reserve B',
    ]);
    await owner.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)', [
      USER,
      'holder@reserve.test',
      'Holder',
      'not-a-real-hash',
    ]);

    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query(
        'INSERT INTO companies (id, tenant_id, name, base_currency) VALUES ($1,$2,$3,$4)',
        [companyId, tenantId, `Company ${companyId.slice(0, 4)}`, 'USD'],
      );
      await owner.query(
        'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
        [CUSTOMER[companyId], tenantId, companyId, 'CUST-1', 'A Customer'],
      );
      await owner.query(
        'INSERT INTO warehouses (id, tenant_id, company_id, code, name, is_default) VALUES ($1,$2,$3,$4,$5,true)',
        [WAREHOUSE[companyId], tenantId, companyId, 'WH-1', 'Main'],
      );
      await owner.query(
        `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
         VALUES ($1,$2,$3,'SKU-1','Widget','unit','10.000000','USD')`,
        [PRODUCT[companyId], tenantId, companyId],
      );
      await owner.query(
        `INSERT INTO sales_orders (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
         VALUES ($1,$2,$3,'draft',$4,$5,current_date,'USD')`,
        [ORDER[companyId], tenantId, companyId, CUSTOMER[companyId], WAREHOUSE[companyId]],
      );
      await owner.query(
        `INSERT INTO sales_order_lines
           (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku, product_name,
            quantity, unit_price, currency)
         VALUES ($1,$2,$3,$4,1,$5,'SKU-1','Widget','100.000000','10.000000','USD')`,
        [LINE[companyId], tenantId, companyId, ORDER[companyId], PRODUCT[companyId]],
      );
    }

    await ownerContext(TENANT_A, COMPANY_A1);
    await owner.query(
      `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
       VALUES ($1,$2,$3,'SKU-2','Gadget','unit','5.000000','USD')`,
      [OTHER_PRODUCT, TENANT_A, COMPANY_A1],
    );
    await owner.query(
      'INSERT INTO warehouses (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
      [OTHER_WAREHOUSE, TENANT_A, COMPANY_A1, 'WH-2', 'Overflow'],
    );
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM stock_reservations WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM products WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM warehouses WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('DELETE FROM users WHERE id = $1', [USER]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  /** One reservation, with whatever the test wants to vary. */
  const reserve = (
    scope: ActorScope,
    overrides: Partial<{
      quantity: string;
      salesOrderLineId: string;
      productId: string;
      warehouseId: string;
    }> = {},
  ) =>
    uow.inActorScope(scope, (repositories) =>
      repositories.stockReservations.create({
        id: reservationId(),
        salesOrderLineId: overrides.salesOrderLineId ?? LINE[scope.companyId]!,
        productId: overrides.productId ?? PRODUCT[scope.companyId]!,
        warehouseId: overrides.warehouseId ?? WAREHOUSE[scope.companyId]!,
        quantity: overrides.quantity ?? '10',
      }),
    );

  const storedIn = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      id: string;
      tenant_id: string;
      company_id: string;
      sales_order_line_id: string;
      product_id: string;
      warehouse_id: string;
      quantity: string;
    }>('SELECT * FROM stock_reservations');
    return rows.rows;
  };

  // -------------------------------------------------------------------------------------
  // 1 and 8. The record, and what it says.
  // -------------------------------------------------------------------------------------

  describe('a reservation record', () => {
    it('can be persisted and read back', async () => {
      const reservation = await reserve(IN_A1, { quantity: '25' });

      expect(reservation.quantity).toBe('25.000000');
      expect(await storedIn(TENANT_A, COMPANY_A1)).toHaveLength(1);
    });

    it('carries the company, line, product and warehouse it was made for', async () => {
      const reservation = await reserve(IN_A1);

      expect(reservation.tenantId).toBe(TENANT_A);
      expect(reservation.companyId).toBe(COMPANY_A1);
      expect(reservation.salesOrderLineId).toBe(LINE[COMPANY_A1]);
      expect(reservation.productId).toBe(PRODUCT[COMPANY_A1]);
      expect(reservation.warehouseId).toBe(WAREHOUSE[COMPANY_A1]);
    });

    it('takes its scope from the session rather than from the input', async () => {
      // The input type has no tenant or company field. This is the runtime half of that: a
      // caller sending them anyway is sending fields the operation does not read.
      const smuggled = {
        id: reservationId(),
        salesOrderLineId: LINE[COMPANY_A1]!,
        productId: PRODUCT[COMPANY_A1]!,
        warehouseId: WAREHOUSE[COMPANY_A1]!,
        quantity: '5',
        tenantId: TENANT_B,
        companyId: COMPANY_B1,
      };

      const reservation = await uow.inActorScope(IN_A1, (repositories) =>
        repositories.stockReservations.create(
          smuggled as unknown as Parameters<typeof repositories.stockReservations.create>[0],
        ),
      );

      expect(reservation.companyId).toBe(COMPANY_A1);
      expect(await storedIn(TENANT_B, COMPANY_B1)).toEqual([]);
    });

    it('keeps the quantity at the precision every other quantity uses', async () => {
      const reservation = await reserve(IN_A1, { quantity: '0.000001' });

      expect(reservation.quantity).toBe('0.000001');
    });

    it('records when it was made', async () => {
      const before = new Date();
      const reservation = await reserve(IN_A1);

      expect(reservation.reservedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    });
  });

  // -------------------------------------------------------------------------------------
  // 2. The quantity constraint.
  // -------------------------------------------------------------------------------------

  describe('quantity', () => {
    it.each(['0', '-1', '-0.000001'])('refuses %s at the database', async (quantity) => {
      // Positive, unlike a movement. A movement is signed because it records a direction; a
      // reservation is an amount set aside and is subtracted wherever availability is computed,
      // so a negative one would silently increase what the business thinks it can sell.
      expect(await refusedBy(reserve(IN_A1, { quantity }))).toMatch(
        /stock_reservations_quantity_check/,
      );
    });

    it('leaves nothing behind when the quantity is refused', async () => {
      await refusedBy(reserve(IN_A1, { quantity: '0' }));

      expect(await storedIn(TENANT_A, COMPANY_A1)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 3 to 7 and 9. Integrity, enforced by the database.
  // -------------------------------------------------------------------------------------

  describe('the database refuses a reservation that crosses a company', () => {
    it('refuses a line belonging to a sibling company', async () => {
      // A real line, in a real company of the same tenant. Row level security cannot catch this
      // on its own: both rows are individually legitimate and only the pairing is wrong.
      expect(
        await refusedBy(reserve(IN_A1, { salesOrderLineId: LINE[COMPANY_A2]! })),
      ).toMatch(/stock_reservations_line_fkey/);
    });

    it('refuses a line belonging to another tenant', async () => {
      expect(
        await refusedBy(reserve(IN_A1, { salesOrderLineId: LINE[COMPANY_B1]! })),
      ).toMatch(/stock_reservations_line_fkey/);
    });

    it('refuses a product belonging to another company', async () => {
      expect(await refusedBy(reserve(IN_A1, { productId: PRODUCT[COMPANY_A2]! }))).toMatch(
        /stock_reservations_line_product_fkey|stock_reservations_product_fkey/,
      );
    });

    it('refuses a warehouse belonging to another company', async () => {
      expect(await refusedBy(reserve(IN_A1, { warehouseId: WAREHOUSE[COMPANY_A2]! }))).toMatch(
        /stock_reservations_warehouse_fkey/,
      );
    });

    it('writes nothing at all when a reference is refused', async () => {
      await refusedBy(reserve(IN_A1, { salesOrderLineId: LINE[COMPANY_A2]! }));

      expect(await storedIn(TENANT_A, COMPANY_A1)).toEqual([]);
      expect(await storedIn(TENANT_A, COMPANY_A2)).toEqual([]);
    });
  });

  describe('the owning line', () => {
    it('refuses a reservation for a line that does not exist', async () => {
      expect(
        await refusedBy(
          reserve(IN_A1, { salesOrderLineId: 'c4990000-0000-4000-8000-00000000000f' }),
        ),
      ).toMatch(/stock_reservations_line_fkey/);
    });

    it('refuses holding a product the line did not order', async () => {
      // The reservation copies the product from its line, so the two must agree. A reservation
      // holding gadgets for a line that ordered widgets would make reserved wrong for both.
      expect(await refusedBy(reserve(IN_A1, { productId: OTHER_PRODUCT }))).toMatch(
        /stock_reservations_line_product_fkey/,
      );
    });

    it('allows a warehouse other than the order\'s, which is not yet a rule', async () => {
      // Recorded rather than enforced. An order names one warehouse today, but nothing in the
      // contract says a reservation must be taken there, and inventing that constraint would
      // decide a question about partial shipment that nobody has asked yet.
      const reservation = await reserve(IN_A1, { warehouseId: OTHER_WAREHOUSE });

      expect(reservation.warehouseId).toBe(OTHER_WAREHOUSE);
    });
  });

  describe('scope', () => {
    it('shows a company only its own reservations', async () => {
      await reserve(IN_A1, { quantity: '10' });
      await reserve(IN_A2, { quantity: '7' });

      const seen = await uow.inActorScope(IN_A1, (repositories) =>
        repositories.stockReservations.listForBalanceKey(
          PRODUCT[COMPANY_A1]!,
          WAREHOUSE[COMPANY_A1]!,
        ),
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]?.quantity).toBe('10.000000');
    });

    it('gives a company nothing for a sibling company\'s key', async () => {
      await reserve(IN_A2, { quantity: '7' });

      const seen = await uow.inActorScope(IN_A1, (repositories) =>
        repositories.stockReservations.listForBalanceKey(
          PRODUCT[COMPANY_A2]!,
          WAREHOUSE[COMPANY_A2]!,
        ),
      );

      expect(seen).toEqual([]);
    });

    it('lists what one line holds, across several reservations', async () => {
      await reserve(IN_A1, { quantity: '10' });
      await reserve(IN_A1, { quantity: '15' });

      const seen = await uow.inActorScope(IN_A1, (repositories) =>
        repositories.stockReservations.listForOrderLine(LINE[COMPANY_A1]!),
      );

      // Several rows for one line are permitted. Nothing in the contract makes a line's
      // reservation a single row, and a unique key would decide partial reservation by accident.
      expect(seen).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------------------
  // 10. What the schema guard should see, and what this increment refuses to offer.
  // -------------------------------------------------------------------------------------

  describe('the shape of the table', () => {
    it('holds no status, because cancellation has not been ruled on', async () => {
      // Section 12.3 requires cancellation rules per document type including whether cancelling
      // releases reserved stock. A lifecycle invented here would be that unwritten rule guessed
      // at in the schema.
      await ownerContext(TENANT_A, COMPANY_A1);
      const columns = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'stock_reservations'`,
      );
      const names = columns.rows.map((row) => row.column_name);

      expect(names).not.toContain('status');
      expect(names).not.toContain('released_at');
      expect(names).not.toContain('version');
    });

    it('left the balance alone, with no reserved column', async () => {
      // The decision this increment implements: reserved is derived from these rows, and
      // `on_hand` remains the projection of the movement ledger and nothing else.
      await ownerContext(TENANT_A, COMPANY_A1);
      const columns = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'stock_balances'`,
      );
      const names = columns.rows.map((row) => row.column_name);

      expect(names).not.toContain('reserved');
      expect(names).toContain('on_hand');
    });

    it('holds no update or delete grant, because release is undecided', async () => {
      const app = new Client({ connectionString: process.env['DATABASE_URL'] });
      await app.connect();
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
        await app.query(`SELECT set_config('app.company_id', $1, false)`, [COMPANY_A1]);

        await expect(app.query('UPDATE stock_reservations SET quantity = 1')).rejects.toThrow(
          /permission denied/i,
        );
        await expect(app.query('DELETE FROM stock_reservations')).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        await app.end();
      }
    });

    it('offers no reserve or release operation through the repository', async () => {
      // Reserving is an availability check under a lock followed by this write, per sections 8.5
      // and 10.2. A method called `reserve` here would be the dangerous half of it on its own.
      const methods = await uow.inActorScope(IN_A1, async (repositories) =>
        Object.getOwnPropertyNames(Object.getPrototypeOf(repositories.stockReservations)),
      );

      expect(methods).toContain('create');
      expect(methods).not.toContain('reserve');
      expect(methods).not.toContain('release');
      expect(methods).not.toContain('available');
    });
  });
});
