/**
 * The availability read, against a real PostgreSQL.
 *
 * Section 8.5: available equals on hand minus reserved. Two things here are worth the trouble of
 * a real database, and everything else is arithmetic.
 *
 * The first is scope. Availability is summed from two tables across four dimensions, and every
 * one of them is an opportunity to count stock that belongs to somebody else. The seed therefore
 * puts a stocked product in each of three companies across two tenants, with different
 * quantities, so a leak shows up as the wrong number rather than as a coincidence.
 *
 * The second is the lock. Section 10.2 requires the balance row to be locked when reserving, and
 * a mocked lock always holds, so the test that matters holds one transaction open and proves a
 * second blocks on the same key and does not block on a different one.
 *
 * WHAT IS NOT TESTED HERE, BECAUSE IT DOES NOT EXIST. No reservation, no oversell refusal, no
 * last unit race, no release. This increment reads a number. A test for behaviour that has not
 * been written would pass for the wrong reason.
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

const TENANT_A = 'd1100000-0000-4000-8000-00000000000a';
const TENANT_B = 'd1200000-0000-4000-8000-00000000000b';

const COMPANY_A1 = 'd2100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "same tenant, different company" is representable. */
const COMPANY_A2 = 'd2200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'd2300000-0000-4000-8000-00000000000c';

const USER = 'd3100000-0000-4000-8000-00000000000a';

const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'd4110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd4120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd4130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'd4210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd4220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd4230000-0000-4000-8000-00000000000c',
};
const PRODUCT: Record<string, string> = {
  [COMPANY_A1]: 'd4310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd4320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd4330000-0000-4000-8000-00000000000c',
};
const ORDER: Record<string, string> = {
  [COMPANY_A1]: 'd4410000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd4420000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd4430000-0000-4000-8000-00000000000c',
};
const LINE: Record<string, string> = {
  [COMPANY_A1]: 'd4510000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd4520000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd4530000-0000-4000-8000-00000000000c',
};

/** A second product and warehouse in the acting company, for the other-dimension cases. */
const OTHER_PRODUCT = 'd4610000-0000-4000-8000-00000000000a';
const OTHER_WAREHOUSE = 'd4710000-0000-4000-8000-00000000000a';
/** A line ordering the other product, so a reservation against it is legal. */
const OTHER_LINE = 'd4810000-0000-4000-8000-00000000000a';
/** Never stocked and never reserved, so "no balance row" has something to be true about. */
const UNSTOCKED_PRODUCT = 'd4910000-0000-4000-8000-00000000000a';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

/** Different per company, so counting another company's stock shows up as the wrong number. */
const STOCKED: Record<string, string> = {
  [COMPANY_A1]: '100',
  [COMPANY_A2]: '55',
  [COMPANY_B1]: '77',
};

const scopeFor = (tenantId: string, companyId: string): ActorScope =>
  actorScope({ tenantId, companyId, userId: USER });

const IN_A1 = scopeFor(TENANT_A, COMPANY_A1);
const IN_A2 = scopeFor(TENANT_A, COMPANY_A2);
const IN_B1 = scopeFor(TENANT_B, COMPANY_B1);

let sequence = 0;
const nextId = (prefix: string) =>
  `${prefix}${(sequence += 1).toString().padStart(6, '0')}-0000-4000-8000-00000000000a`;

/** A promise with its resolver, for holding a transaction open from outside it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

/** Lets pending work run, so "did the other transaction get through" can be answered with yes. */
const settle = (ms = 250) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Stock availability', () => {
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
    // Stock and reservations both, rebuilt from nothing. Several tests below move stock, and
    // clearing only the reservations would make every later expectation a statement about
    // whatever ran first rather than about the test making it.
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM stock_reservations WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_movements WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_balances WHERE company_id = $1', [companyId]);
    }
    await stockUp();
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'avail-a',
      'Avail A',
      TENANT_B,
      'avail-b',
      'Avail B',
    ]);
    await owner.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)', [
      USER,
      'reader@avail.test',
      'Reader',
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
         VALUES ($1,$2,$3,$4,1,$5,'SKU-1','Widget','500.000000','10.000000','USD')`,
        [LINE[companyId], tenantId, companyId, ORDER[companyId], PRODUCT[companyId]],
      );
    }

    // The extra dimensions, all inside the acting company.
    await ownerContext(TENANT_A, COMPANY_A1);
    await owner.query(
      `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
       VALUES ($1,$2,$3,'SKU-2','Gadget','unit','5.000000','USD'),
              ($4,$2,$3,'SKU-3','Never stocked','unit','1.000000','USD')`,
      [OTHER_PRODUCT, TENANT_A, COMPANY_A1, UNSTOCKED_PRODUCT],
    );
    await owner.query(
      'INSERT INTO warehouses (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
      [OTHER_WAREHOUSE, TENANT_A, COMPANY_A1, 'WH-2', 'Overflow'],
    );
    await owner.query(
      `INSERT INTO sales_order_lines
         (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku, product_name,
          quantity, unit_price, currency)
       VALUES ($1,$2,$3,$4,2,$5,'SKU-2','Gadget','500.000000','5.000000','USD')`,
      [OTHER_LINE, TENANT_A, COMPANY_A1, ORDER[COMPANY_A1], OTHER_PRODUCT],
    );

  }

  /**
   * Puts the opening stock on the shelves, through the ledger rather than by writing balances.
   *
   * On hand is then what the movements actually make it, which is the relationship section 8.2
   * describes. Writing the balance rows directly would test this read against a number nothing
   * produced.
   */
  async function stockUp(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await receive(
        scopeFor(tenantId, companyId),
        PRODUCT[companyId]!,
        WAREHOUSE[companyId]!,
        STOCKED[companyId]!,
      );
    }
    await receive(IN_A1, OTHER_PRODUCT, WAREHOUSE[COMPANY_A1]!, '40');
    await receive(IN_A1, PRODUCT[COMPANY_A1]!, OTHER_WAREHOUSE, '30');
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM stock_reservations WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_movements WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_balances WHERE company_id = $1', [companyId]);
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

  /** Puts stock on a shelf the way the system does, through the ledger. */
  const receive = (scope: ActorScope, productId: string, warehouseId: string, quantity: string) =>
    uow.inActorScope(scope, (repositories) =>
      repositories.stockLedger.record({
        id: nextId('d6'),
        productId,
        warehouseId,
        quantity,
        reason: 'purchase_receipt',
        sourceDocType: 'purchase_order',
        sourceDocId: nextId('d7'),
      }),
    );

  /** Holds stock against a line, without any of the checks the reservation increment will add. */
  const hold = (
    scope: ActorScope,
    quantity: string,
    where: { productId?: string; warehouseId?: string; salesOrderLineId?: string } = {},
  ) =>
    uow.inActorScope(scope, (repositories) =>
      repositories.stockReservations.create({
        id: nextId('d8'),
        salesOrderLineId: where.salesOrderLineId ?? LINE[scope.companyId]!,
        productId: where.productId ?? PRODUCT[scope.companyId]!,
        warehouseId: where.warehouseId ?? WAREHOUSE[scope.companyId]!,
        quantity,
      }),
    );

  const availability = (scope: ActorScope, productId?: string, warehouseId?: string) =>
    uow.inActorScope(scope, (repositories) =>
      repositories.stockLedger.availabilityForUpdate(
        productId ?? PRODUCT[scope.companyId]!,
        warehouseId ?? WAREHOUSE[scope.companyId]!,
      ),
    );

  // -------------------------------------------------------------------------------------
  // 1 to 4. The arithmetic.
  // -------------------------------------------------------------------------------------

  describe('available equals on hand minus reserved', () => {
    it('is the whole of on hand when nothing is reserved', async () => {
      const result = await availability(IN_A1);

      expect(result.onHand).toBe('100.000000');
      expect(result.reserved).toBe('0.000000');
      expect(result.available).toBe('100.000000');
    });

    it('falls by what a reservation holds', async () => {
      await hold(IN_A1, '30');

      const result = await availability(IN_A1);

      expect(result.reserved).toBe('30.000000');
      expect(result.available).toBe('70.000000');
    });

    it('sums several reservations against the same key', async () => {
      await hold(IN_A1, '30');
      await hold(IN_A1, '25');
      await hold(IN_A1, '5');

      const result = await availability(IN_A1);

      expect(result.reserved).toBe('60.000000');
      expect(result.available).toBe('40.000000');
    });

    it('keeps a fraction of a unit exactly', async () => {
      // The precision every quantity column uses. A double would already have lost this.
      await hold(IN_A1, '0.000001');
      await hold(IN_A1, '0.000002');

      const result = await availability(IN_A1);

      expect(result.reserved).toBe('0.000003');
      expect(result.available).toBe('99.999997');
    });

    it('reports a negative figure rather than clamping it', async () => {
      // More reserved than is on the shelf should never happen once the oversell check exists,
      // and if it ever does, the honest answer is the one that makes it visible.
      await hold(IN_A1, '150');

      const result = await availability(IN_A1);

      expect(result.available).toBe('-50.000000');
    });

    it('follows on hand as the ledger moves it', async () => {
      await hold(IN_A1, '10');
      await receive(IN_A1, PRODUCT[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!, '-40');

      const result = await availability(IN_A1);

      expect(result.onHand).toBe('60.000000');
      expect(result.available).toBe('50.000000');
    });
  });

  // -------------------------------------------------------------------------------------
  // 5 to 8. Every dimension of the key.
  // -------------------------------------------------------------------------------------

  describe('only reservations for this exact key count', () => {
    it('ignores a sibling company in the same tenant', async () => {
      await hold(IN_A2, '50');

      const result = await availability(IN_A1);

      expect(result.reserved).toBe('0.000000');
      expect(result.available).toBe('100.000000');
    });

    it('ignores another tenant', async () => {
      await hold(IN_B1, '70');

      const result = await availability(IN_A1);

      expect(result.reserved).toBe('0.000000');
    });

    it('ignores another product in the same warehouse', async () => {
      await hold(IN_A1, '40', { productId: OTHER_PRODUCT, salesOrderLineId: OTHER_LINE });

      const result = await availability(IN_A1);

      expect(result.reserved).toBe('0.000000');
      expect(result.available).toBe('100.000000');
    });

    it('ignores the same product in another warehouse', async () => {
      await hold(IN_A1, '20', { warehouseId: OTHER_WAREHOUSE });

      const result = await availability(IN_A1);

      expect(result.reserved).toBe('0.000000');
      expect(result.available).toBe('100.000000');
    });

    it('reads on hand for the key asked for, not for the product anywhere', async () => {
      // The same product is stocked in both warehouses, at different quantities.
      const main = await availability(IN_A1, PRODUCT[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!);
      const overflow = await availability(IN_A1, PRODUCT[COMPANY_A1]!, OTHER_WAREHOUSE);

      expect(main.onHand).toBe('100.000000');
      expect(overflow.onHand).toBe('30.000000');
    });

    it('gives each company its own answer for the same question', async () => {
      await hold(IN_A1, '10');
      await hold(IN_A2, '5');

      expect((await availability(IN_A1)).available).toBe('90.000000');
      expect((await availability(IN_A2)).available).toBe('50.000000');
      expect((await availability(IN_B1)).available).toBe('77.000000');
    });
  });

  // -------------------------------------------------------------------------------------
  // Missing balance.
  // -------------------------------------------------------------------------------------

  describe('a key nothing has ever moved', () => {
    it('is zero rather than an error', async () => {
      // Section 8.1 makes the ledger the truth and 8.2 makes the balance what it sums to, so no
      // movements means no row and a position of zero. That is an answer.
      const result = await availability(IN_A1, UNSTOCKED_PRODUCT, WAREHOUSE[COMPANY_A1]!);

      expect(result.onHand).toBe('0.000000');
      expect(result.reserved).toBe('0.000000');
      expect(result.available).toBe('0.000000');
    });

    it('reports that no lock was taken, because there was no row to lock', async () => {
      const missing = await availability(IN_A1, UNSTOCKED_PRODUCT, WAREHOUSE[COMPANY_A1]!);
      const present = await availability(IN_A1);

      expect(missing.locked).toBe(false);
      expect(present.locked).toBe(true);
    });

    it('does not create the balance row it could not find', async () => {
      await availability(IN_A1, UNSTOCKED_PRODUCT, WAREHOUSE[COMPANY_A1]!);

      await ownerContext(TENANT_A, COMPANY_A1);
      const rows = await owner.query('SELECT 1 FROM stock_balances WHERE product_id = $1', [
        UNSTOCKED_PRODUCT,
      ]);

      expect(rows.rowCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------
  // 9 and 10. The lock, proved by making a second transaction wait for it.
  // -------------------------------------------------------------------------------------

  describe('the balance row is locked', () => {
    it('makes a second reader of the same key wait for the first', async () => {
      const held = gate();
      let secondFinished = false;

      const first = uow.inActorScope(IN_A1, async (repositories) => {
        await repositories.stockLedger.availabilityForUpdate(
          PRODUCT[COMPANY_A1]!,
          WAREHOUSE[COMPANY_A1]!,
        );
        await held.promise;
      });

      // Let the first transaction reach its lock before the second asks for it.
      await settle(100);

      const second = availability(IN_A1).then((result) => {
        secondFinished = true;
        return result;
      });

      await settle();
      // Still waiting. Without the lock this read would have returned long ago.
      expect(secondFinished).toBe(false);

      held.open();
      await first;

      expect((await second).available).toBe('100.000000');
      expect(secondFinished).toBe(true);
    });

    it('does not make a reader of a different key wait', async () => {
      // The lock is per balance row, not per table. Two salespeople selling different products
      // have no reason to queue behind each other.
      const held = gate();

      const first = uow.inActorScope(IN_A1, async (repositories) => {
        await repositories.stockLedger.availabilityForUpdate(
          PRODUCT[COMPANY_A1]!,
          WAREHOUSE[COMPANY_A1]!,
        );
        await held.promise;
      });

      await settle(100);

      const other = await availability(IN_A1, OTHER_PRODUCT, WAREHOUSE[COMPANY_A1]!);

      expect(other.onHand).toBe('40.000000');

      held.open();
      await first;
    });

    it('does not make another company wait for the same product and warehouse ids', async () => {
      const held = gate();

      const first = uow.inActorScope(IN_A1, async (repositories) => {
        await repositories.stockLedger.availabilityForUpdate(
          PRODUCT[COMPANY_A1]!,
          WAREHOUSE[COMPANY_A1]!,
        );
        await held.promise;
      });

      await settle(100);

      expect((await availability(IN_A2)).available).toBe('55.000000');

      held.open();
      await first;
    });

    it('reads what the lock made it wait for, not what it could have read before', async () => {
      // The claim section 10.2 actually buys. The second reader asks first, waits on the lock,
      // and comes back with the figure the first transaction committed rather than the one that
      // was true when it asked.
      const held = gate();

      const mover = uow.inActorScope(IN_A1, async (repositories) => {
        await repositories.stockLedger.availabilityForUpdate(
          PRODUCT[COMPANY_A1]!,
          WAREHOUSE[COMPANY_A1]!,
        );
        await repositories.stockLedger.record({
          id: nextId('d6'),
          productId: PRODUCT[COMPANY_A1]!,
          warehouseId: WAREHOUSE[COMPANY_A1]!,
          quantity: '-60',
          reason: 'sales_delivery',
          sourceDocType: 'sales_order',
          sourceDocId: nextId('d7'),
        });
        await held.promise;
      });

      await settle(100);
      const waiting = availability(IN_A1);
      await settle();
      held.open();
      await mover;

      // Forty, not the hundred that was on the shelf when the read was asked for.
      expect((await waiting).onHand).toBe('40.000000');
      expect((await waiting).available).toBe('40.000000');
    });

    it('sees a reservation committed while it waited', async () => {
      const held = gate();

      const holder = uow.inActorScope(IN_A1, async (repositories) => {
        await repositories.stockLedger.availabilityForUpdate(
          PRODUCT[COMPANY_A1]!,
          WAREHOUSE[COMPANY_A1]!,
        );
        await repositories.stockReservations.create({
          id: nextId('d8'),
          salesOrderLineId: LINE[COMPANY_A1]!,
          productId: PRODUCT[COMPANY_A1]!,
          warehouseId: WAREHOUSE[COMPANY_A1]!,
          quantity: '90',
        });
        await held.promise;
      });

      await settle(100);
      const waiting = availability(IN_A1);
      await settle();
      held.open();
      await holder;

      // This is what makes the balance row lock sufficient without locking reservations: the
      // waiting transaction's reservation sum runs after the lock is granted, on a snapshot that
      // already contains the row the first transaction inserted.
      expect((await waiting).reserved).toBe('90.000000');
      expect((await waiting).available).toBe('10.000000');
    });
  });

  // -------------------------------------------------------------------------------------
  // 11 and 12. It is a read.
  // -------------------------------------------------------------------------------------

  describe('it writes nothing', () => {
    it('leaves the balance row untouched, including its version', async () => {
      await hold(IN_A1, '10');

      await ownerContext(TENANT_A, COMPANY_A1);
      const before = await owner.query<{ version: number; on_hand: string; xmin: string }>(
        'SELECT version, on_hand, xmin::text AS xmin FROM stock_balances WHERE product_id = $1 AND warehouse_id = $2',
        [PRODUCT[COMPANY_A1], WAREHOUSE[COMPANY_A1]],
      );

      await availability(IN_A1);
      await availability(IN_A1);

      await ownerContext(TENANT_A, COMPANY_A1);
      const after = await owner.query<{ version: number; on_hand: string; xmin: string }>(
        'SELECT version, on_hand, xmin::text AS xmin FROM stock_balances WHERE product_id = $1 AND warehouse_id = $2',
        [PRODUCT[COMPANY_A1], WAREHOUSE[COMPANY_A1]],
      );

      // `xmin` is the transaction that last wrote the row. Unchanged means nothing wrote it,
      // which is a stronger statement than the column values happening to match.
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it('creates, updates and deletes no reservation', async () => {
      await hold(IN_A1, '10');
      await hold(IN_A1, '20');

      await ownerContext(TENANT_A, COMPANY_A1);
      const before = await owner.query('SELECT id, quantity, xmin::text FROM stock_reservations ORDER BY id');

      await availability(IN_A1);

      await ownerContext(TENANT_A, COMPANY_A1);
      const after = await owner.query('SELECT id, quantity, xmin::text FROM stock_reservations ORDER BY id');

      expect(after.rows).toEqual(before.rows);
      expect(after.rows).toHaveLength(2);
    });

    it('writes no movement', async () => {
      await ownerContext(TENANT_A, COMPANY_A1);
      const before = await owner.query('SELECT count(*)::int AS n FROM stock_movements');

      await availability(IN_A1);

      await ownerContext(TENANT_A, COMPANY_A1);
      const after = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM stock_movements');

      expect(after.rows[0]?.n).toBe((before.rows[0] as { n: number }).n);
    });

    it('offers no reservation or confirmation operation beside it', async () => {
      // The read primitive and nothing more. Reserving is an availability check followed by a
      // write, and this increment deliberately owns only the first half.
      const methods = await uow.inActorScope(IN_A1, async (repositories) =>
        Object.getOwnPropertyNames(Object.getPrototypeOf(repositories.stockLedger)),
      );

      expect(methods).toContain('availabilityForUpdate');
      expect(methods).not.toContain('reserveStock');
      expect(methods).not.toContain('releaseReservation');
      expect(methods).not.toContain('calculateAvailabilityAndReserve');
    });
  });
});
