/**
 * Reserving stock, against a real PostgreSQL.
 *
 * Section 8.5 requires an order that would oversell to fail inside the transaction, and section
 * 10.2 gives the mechanism. The test that matters is the one the contract itself names in
 * section 13.1: two parallel confirmations of the last unit. Everything else here supports it.
 *
 * WHY THE RACE IS COORDINATED RATHER THAN TIMED. A test that fires two transactions and hopes
 * they overlap proves nothing on a fast machine. These hold the first transaction open at a known
 * point, let the second reach the lock, and only then release the first. The second is observed
 * to be still waiting before that happens, so the blocking is asserted rather than assumed.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, UnitOfWork } from '../database/index.js';
import type { ActorScope } from '../database/index.js';
import { reserveForOrderLine, StockReservationError } from './reservations.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'f8100000-0000-4000-8000-00000000000a';
const TENANT_B = 'f8200000-0000-4000-8000-00000000000b';

const COMPANY_A1 = 'f8300000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "same tenant, different company" is representable. */
const COMPANY_A2 = 'f8400000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'f8500000-0000-4000-8000-00000000000c';

const USER = 'f8600000-0000-4000-8000-00000000000a';

const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'f9110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'f9120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'f9130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'f9210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'f9220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'f9230000-0000-4000-8000-00000000000c',
};
const PRODUCT: Record<string, string> = {
  [COMPANY_A1]: 'f9310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'f9320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'f9330000-0000-4000-8000-00000000000c',
};
const ORDER: Record<string, string> = {
  [COMPANY_A1]: 'f9410000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'f9420000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'f9430000-0000-4000-8000-00000000000c',
};
const LINE: Record<string, string> = {
  [COMPANY_A1]: 'f9510000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'f9520000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'f9530000-0000-4000-8000-00000000000c',
};

/** A second order and line in the acting company, so two users can race for one unit. */
const RIVAL_ORDER = 'f9610000-0000-4000-8000-00000000000a';
const RIVAL_LINE = 'f9710000-0000-4000-8000-00000000000a';
/** A warehouse that permits negative stock, for the policy question. */
const PERMISSIVE_WAREHOUSE = 'f9810000-0000-4000-8000-00000000000a';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

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

/** Lets pending work run, so "is the other transaction still waiting" can be answered. */
const settle = (ms = 300) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Reserving stock', () => {
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
    // Stock and reservations both, so every quantity below is a statement about its own test.
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM stock_reservations WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_movements WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_balances WHERE company_id = $1', [companyId]);
    }
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'hold-a',
      'Hold A',
      TENANT_B,
      'hold-b',
      'Hold B',
    ]);
    await owner.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)', [
      USER,
      'seller@hold.test',
      'Seller',
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

    // A rival order in the acting company, shipping from the same warehouse for the same product.
    // Two salespeople, one shelf, which is the situation section 10.2 describes.
    await ownerContext(TENANT_A, COMPANY_A1);
    await owner.query(
      `INSERT INTO sales_orders (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
       VALUES ($1,$2,$3,'draft',$4,$5,current_date,'USD')`,
      [RIVAL_ORDER, TENANT_A, COMPANY_A1, CUSTOMER[COMPANY_A1], WAREHOUSE[COMPANY_A1]],
    );
    await owner.query(
      `INSERT INTO sales_order_lines
         (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku, product_name,
          quantity, unit_price, currency)
       VALUES ($1,$2,$3,$4,1,$5,'SKU-1','Widget','500.000000','10.000000','USD')`,
      [RIVAL_LINE, TENANT_A, COMPANY_A1, RIVAL_ORDER, PRODUCT[COMPANY_A1]],
    );
    await owner.query(
      `INSERT INTO warehouses (id, tenant_id, company_id, code, name, allow_negative_stock)
       VALUES ($1,$2,$3,'WH-NEG','Backorder shelf',true)`,
      [PERMISSIVE_WAREHOUSE, TENANT_A, COMPANY_A1],
    );
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
  const stock = (scope: ActorScope, quantity: string, warehouseId?: string) =>
    uow.inActorScope(scope, (repositories) =>
      repositories.stockLedger.record({
        id: nextId('fa'),
        productId: PRODUCT[scope.companyId]!,
        warehouseId: warehouseId ?? WAREHOUSE[scope.companyId]!,
        quantity,
        reason: 'purchase_receipt',
        sourceDocType: 'purchase_order',
        sourceDocId: nextId('fb'),
      }),
    );

  /** One reservation, in its own transaction, which is how confirmation will reach it. */
  const reserve = (scope: ActorScope, quantity: string, salesOrderLineId?: string) =>
    uow.inActorScope(scope, (repositories) =>
      reserveForOrderLine(repositories, {
        salesOrderLineId: salesOrderLineId ?? LINE[scope.companyId]!,
        quantity,
      }),
    );

  const reservationsIn = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{ id: string; quantity: string; sales_order_line_id: string }>(
      'SELECT id, quantity, sales_order_line_id FROM stock_reservations ORDER BY reserved_at',
    );
    return rows.rows;
  };

  const totalReserved = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{ total: string }>(
      'SELECT coalesce(sum(quantity), 0)::text AS total FROM stock_reservations',
    );
    return rows.rows[0]?.total ?? '0';
  };

  const refusal = async (work: Promise<unknown>): Promise<StockReservationError> => {
    const error = await work.then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(StockReservationError);
    return error as StockReservationError;
  };

  // -------------------------------------------------------------------------------------
  // 1, 5 and 6. A reservation that is allowed.
  // -------------------------------------------------------------------------------------

  describe('a reservation within available stock', () => {
    it('is created', async () => {
      await stock(IN_A1, '100');

      const reservation = await reserve(IN_A1, '30');

      expect(reservation.quantity).toBe('30.000000');
      expect(await reservationsIn(TENANT_A, COMPANY_A1)).toHaveLength(1);
    });

    it('is tied to the line it was asked for, with that line\'s product', async () => {
      await stock(IN_A1, '100');

      const reservation = await reserve(IN_A1, '30');

      expect(reservation.salesOrderLineId).toBe(LINE[COMPANY_A1]);
      expect(reservation.productId).toBe(PRODUCT[COMPANY_A1]);
      expect(reservation.companyId).toBe(COMPANY_A1);
    });

    it('takes its warehouse from the order rather than from the caller', async () => {
      // The request has no warehouse field. This is the runtime half of that: the warehouse on
      // the reservation is the one the order ships from.
      await stock(IN_A1, '100');

      const reservation = await reserve(IN_A1, '5');

      expect(reservation.warehouseId).toBe(WAREHOUSE[COMPANY_A1]);
    });

    it('reduces what is available to the next caller', async () => {
      await stock(IN_A1, '100');
      await reserve(IN_A1, '30');

      const after = await uow.inActorScope(IN_A1, (repositories) =>
        repositories.stockLedger.availabilityForUpdate(
          PRODUCT[COMPANY_A1]!,
          WAREHOUSE[COMPANY_A1]!,
        ),
      );

      expect(after.reserved).toBe('30.000000');
      expect(after.available).toBe('70.000000');
    });

    it('may take exactly what is available, to the last unit', async () => {
      await stock(IN_A1, '10');

      const reservation = await reserve(IN_A1, '10');

      expect(reservation.quantity).toBe('10.000000');
    });

    it('keeps a fraction of a unit exactly', async () => {
      await stock(IN_A1, '1');

      await reserve(IN_A1, '0.000001');
      await reserve(IN_A1, '0.000002');

      expect(await totalReserved(TENANT_A, COMPANY_A1)).toBe('0.000003');
    });

    it('accumulates across several reservations until the stock runs out', async () => {
      await stock(IN_A1, '10');

      await reserve(IN_A1, '6');
      await reserve(IN_A1, '4');

      expect(await totalReserved(TENANT_A, COMPANY_A1)).toBe('10.000000');
      await refusal(reserve(IN_A1, '0.000001'));
    });
  });

  // -------------------------------------------------------------------------------------
  // 2, 3, 4 and 15. What is refused, and that nothing is written when it is.
  // -------------------------------------------------------------------------------------

  describe('a reservation beyond available stock', () => {
    it('is refused', async () => {
      await stock(IN_A1, '10');

      const error = await refusal(reserve(IN_A1, '11'));

      expect(error.reason).toBe('insufficient_stock');
    });

    it('writes nothing when it is refused', async () => {
      await stock(IN_A1, '10');

      await refusal(reserve(IN_A1, '11'));

      expect(await reservationsIn(TENANT_A, COMPANY_A1)).toEqual([]);
    });

    it('says how short it was, so the caller can explain it', async () => {
      await stock(IN_A1, '10');
      await reserve(IN_A1, '7');

      const error = await refusal(reserve(IN_A1, '5'));

      expect(error.shortfall).toEqual({
        requested: '5.000000',
        available: '3.000000',
        onHand: '10.000000',
        reserved: '7.000000',
      });
    });

    it('is refused when nothing has ever been stocked', async () => {
      const error = await refusal(reserve(IN_A1, '1'));

      expect(error.reason).toBe('insufficient_stock');
      expect(error.shortfall?.onHand).toBe('0.000000');
    });

    it('is refused when availability is already negative', async () => {
      // Availability can only be negative through a movement taking stock below what is held.
      await stock(IN_A1, '10');
      await reserve(IN_A1, '10');
      await stock(IN_A1, '-4');

      const error = await refusal(reserve(IN_A1, '0.000001'));

      expect(error.reason).toBe('insufficient_stock');
      expect(error.shortfall?.available).toBe('-4.000000');
    });

    it('is refused even where the warehouse permits negative stock', async () => {
      // Section 8.5's requirement that an overselling order fails carries no exception, and its
      // negative stock policy is about stock rather than availability: reserving does not move
      // anything off the shelf. The flag governs the movement, which is a later increment.
      await stock(IN_A1, '2', PERMISSIVE_WAREHOUSE);

      const permissiveOrder = nextId('fc');
      const permissiveLine = nextId('fd');
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(
        `INSERT INTO sales_orders (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
         VALUES ($1,$2,$3,'draft',$4,$5,current_date,'USD')`,
        [permissiveOrder, TENANT_A, COMPANY_A1, CUSTOMER[COMPANY_A1], PERMISSIVE_WAREHOUSE],
      );
      await owner.query(
        `INSERT INTO sales_order_lines
           (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku, product_name,
            quantity, unit_price, currency)
         VALUES ($1,$2,$3,$4,1,$5,'SKU-1','Widget','500.000000','10.000000','USD')`,
        [permissiveLine, TENANT_A, COMPANY_A1, permissiveOrder, PRODUCT[COMPANY_A1]],
      );

      try {
        const error = await refusal(reserve(IN_A1, '3', permissiveLine));
        expect(error.reason).toBe('insufficient_stock');
      } finally {
        await ownerContext(TENANT_A, COMPANY_A1);
        await owner.query('DELETE FROM sales_order_lines WHERE id = $1', [permissiveLine]);
        await owner.query('DELETE FROM sales_orders WHERE id = $1', [permissiveOrder]);
      }
    });
  });

  describe('an invalid quantity', () => {
    it.each(['0', '-1', '-0.000001'])('refuses %s before reading anything', async (quantity) => {
      await stock(IN_A1, '100');

      const error = await refusal(reserve(IN_A1, quantity));

      expect(error.reason).toBe('invalid_quantity');
      expect(await reservationsIn(TENANT_A, COMPANY_A1)).toEqual([]);
    });

    it.each(['', 'abc', '1e3', '1.2.3', 'NaN', '1.1234567'])(
      'refuses %s rather than coercing it',
      async (quantity) => {
        await stock(IN_A1, '100');

        expect((await refusal(reserve(IN_A1, quantity))).reason).toBe('invalid_quantity');
      },
    );
  });

  // -------------------------------------------------------------------------------------
  // 7, 8 and 9. Scope and authority.
  // -------------------------------------------------------------------------------------

  describe('scope', () => {
    it('refuses a line belonging to a sibling company', async () => {
      await stock(IN_A1, '100');
      await stock(IN_A2, '100');

      const error = await refusal(reserve(IN_A1, '1', LINE[COMPANY_A2]!));

      expect(error.reason).toBe('line_not_found');
      expect(await reservationsIn(TENANT_A, COMPANY_A2)).toEqual([]);
    });

    it('refuses a line belonging to another tenant', async () => {
      await stock(IN_A1, '100');
      await stock(IN_B1, '100');

      const error = await refusal(reserve(IN_A1, '1', LINE[COMPANY_B1]!));

      expect(error.reason).toBe('line_not_found');
      expect(await reservationsIn(TENANT_B, COMPANY_B1)).toEqual([]);
    });

    it('refuses a line that does not exist, with the same answer', async () => {
      // Section 6.1: a cross-company failure is indistinguishable from a missing record, so an
      // identifier cannot be probed to learn what another company holds.
      await stock(IN_A1, '100');

      const error = await refusal(reserve(IN_A1, '1', 'f9990000-0000-4000-8000-00000000000f'));

      expect(error.reason).toBe('line_not_found');
      expect(error.message).toBe('Sales order line not found');
    });

    it('reads each company\'s stock separately for the same product and warehouse ids', async () => {
      await stock(IN_A1, '1');
      await stock(IN_A2, '100');

      await reserve(IN_A2, '50');
      const error = await refusal(reserve(IN_A1, '2'));

      expect(error.reason).toBe('insufficient_stock');
      expect(error.shortfall?.onHand).toBe('1.000000');
      expect(await totalReserved(TENANT_A, COMPANY_A1)).toBe('0');
    });

    it('cannot be pointed at another company by the request', async () => {
      // The request carries a line and a quantity. A caller sending a company, product or
      // warehouse is sending fields the operation does not read.
      await stock(IN_A1, '100');

      const smuggled = {
        salesOrderLineId: LINE[COMPANY_A1]!,
        quantity: '5',
        tenantId: TENANT_B,
        companyId: COMPANY_B1,
        productId: PRODUCT[COMPANY_B1]!,
        warehouseId: WAREHOUSE[COMPANY_B1]!,
      };

      const reservation = await uow.inActorScope(IN_A1, (repositories) =>
        reserveForOrderLine(
          repositories,
          smuggled as unknown as Parameters<typeof reserveForOrderLine>[1],
        ),
      );

      expect(reservation.tenantId).toBe(TENANT_A);
      expect(reservation.companyId).toBe(COMPANY_A1);
      expect(reservation.productId).toBe(PRODUCT[COMPANY_A1]);
      expect(reservation.warehouseId).toBe(WAREHOUSE[COMPANY_A1]);
      expect(await reservationsIn(TENANT_B, COMPANY_B1)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 10. Rollback.
  // -------------------------------------------------------------------------------------

  describe('a transaction that fails after the decision', () => {
    it('leaves no reservation behind', async () => {
      await stock(IN_A1, '100');

      await expect(
        uow.inActorScope(IN_A1, async (repositories) => {
          await reserveForOrderLine(repositories, {
            salesOrderLineId: LINE[COMPANY_A1]!,
            quantity: '40',
          });
          // A real failure rather than a test hook: the same line reserved twice inside one
          // transaction is fine, but this asks for a line in another company, which the scoped
          // read refuses. Confirmation will fail here for its own reasons in the same way.
          await reserveForOrderLine(repositories, {
            salesOrderLineId: LINE[COMPANY_A2]!,
            quantity: '1',
          });
        }),
      ).rejects.toBeInstanceOf(StockReservationError);

      expect(await reservationsIn(TENANT_A, COMPANY_A1)).toEqual([]);
    });

    it('leaves the stock available to the next caller', async () => {
      await stock(IN_A1, '10');

      await expect(
        uow.inActorScope(IN_A1, async (repositories) => {
          await reserveForOrderLine(repositories, {
            salesOrderLineId: LINE[COMPANY_A1]!,
            quantity: '10',
          });
          throw new Error('the confirmation this was part of failed later');
        }),
      ).rejects.toThrow(/failed later/);

      // All ten still there, so the rollback released the hold rather than leaking it.
      const reservation = await reserve(IN_A1, '10');
      expect(reservation.quantity).toBe('10.000000');
    });
  });

  // -------------------------------------------------------------------------------------
  // 11 to 14. The races, which are the point of the increment.
  // -------------------------------------------------------------------------------------

  describe('two users racing for the last unit', () => {
    it('lets exactly one of them have it', async () => {
      await stock(IN_A1, '1');

      const held = gate();
      let secondSettled = false;

      // The first transaction takes the lock, reserves the unit, and is held open.
      const first = uow.inActorScope(IN_A1, async (repositories) => {
        await reserveForOrderLine(repositories, {
          salesOrderLineId: LINE[COMPANY_A1]!,
          quantity: '1',
        });
        await held.promise;
      });

      // Let it reach the lock before the rival asks for the same unit.
      await settle(150);

      const second = uow
        .inActorScope(IN_A1, (repositories) =>
          reserveForOrderLine(repositories, {
            salesOrderLineId: RIVAL_LINE,
            quantity: '1',
          }),
        )
        .then(
          () => 'succeeded' as const,
          (error: unknown) => error,
        )
        .then((outcome) => {
          secondSettled = true;
          return outcome;
        });

      await settle();
      // Blocked on the balance row rather than having read past it. Without the lock this would
      // already have decided, on a view of the stock that the first transaction was changing.
      expect(secondSettled).toBe(false);

      held.open();
      await first;
      const outcome = await second;

      expect(outcome).toBeInstanceOf(StockReservationError);
      expect((outcome as StockReservationError).reason).toBe('insufficient_stock');

      // Exactly one reservation, for exactly the one unit, held by the first line.
      const rows = await reservationsIn(TENANT_A, COMPANY_A1);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.quantity).toBe('1.000000');
      expect(rows[0]?.sales_order_line_id).toBe(LINE[COMPANY_A1]);
      expect(await totalReserved(TENANT_A, COMPANY_A1)).toBe('1.000000');
    });

    it('lets the second have it when the first rolls back', async () => {
      // The mirror image, and the reason the lock has to be held for the whole transaction
      // rather than only for the read.
      await stock(IN_A1, '1');

      const held = gate();

      const first = uow
        .inActorScope(IN_A1, async (repositories) => {
          await reserveForOrderLine(repositories, {
            salesOrderLineId: LINE[COMPANY_A1]!,
            quantity: '1',
          });
          await held.promise;
          throw new Error('this confirmation failed');
        })
        .catch(() => 'rolled back' as const);

      await settle(150);

      const second = uow.inActorScope(IN_A1, (repositories) =>
        reserveForOrderLine(repositories, { salesOrderLineId: RIVAL_LINE, quantity: '1' }),
      );

      await settle();
      held.open();
      await first;

      expect((await second).quantity).toBe('1.000000');
      expect(await totalReserved(TENANT_A, COMPANY_A1)).toBe('1.000000');
    });
  });

  describe('many transactions demanding more than exists', () => {
    it('never reserves more than the stock on the shelf', async () => {
      // Ten at once for three units. This runs them genuinely in parallel rather than gated, so
      // it is the unstructured version of the race above: whatever the interleaving, the total
      // held can never exceed what was there.
      await stock(IN_A1, '3');

      const attempts = Array.from({ length: 10 }, (_, index) =>
        uow
          .inActorScope(IN_A1, (repositories) =>
            reserveForOrderLine(repositories, {
              salesOrderLineId: index % 2 === 0 ? LINE[COMPANY_A1]! : RIVAL_LINE,
              quantity: '1',
            }),
          )
          .then(
            () => 'ok' as const,
            () => 'refused' as const,
          ),
      );

      const outcomes = await Promise.all(attempts);

      expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(3);
      expect(outcomes.filter((outcome) => outcome === 'refused')).toHaveLength(7);
      expect(await totalReserved(TENANT_A, COMPANY_A1)).toBe('3.000000');
    });

    it('leaves availability at exactly zero, never below', async () => {
      await stock(IN_A1, '5');

      await Promise.all(
        Array.from({ length: 8 }, () =>
          uow
            .inActorScope(IN_A1, (repositories) =>
              reserveForOrderLine(repositories, {
                salesOrderLineId: LINE[COMPANY_A1]!,
                quantity: '1',
              }),
            )
            .catch(() => undefined),
        ),
      );

      const after = await uow.inActorScope(IN_A1, (repositories) =>
        repositories.stockLedger.availabilityForUpdate(
          PRODUCT[COMPANY_A1]!,
          WAREHOUSE[COMPANY_A1]!,
        ),
      );

      expect(after.available).toBe('0.000000');
      expect(after.reserved).toBe('5.000000');
    });

    it('does not serialise transactions for different products or companies', async () => {
      // The lock is per balance row. Two companies selling their own stock have no reason to
      // queue behind each other, and a lock that made them would be a scaling bug.
      await stock(IN_A1, '5');
      await stock(IN_A2, '5');

      const [a1, a2] = await Promise.all([reserve(IN_A1, '5'), reserve(IN_A2, '5')]);

      expect(a1.companyId).toBe(COMPANY_A1);
      expect(a2.companyId).toBe(COMPANY_A2);
    });
  });

  // -------------------------------------------------------------------------------------
  // The shape of the boundary.
  // -------------------------------------------------------------------------------------

  describe('the operation boundary', () => {
    it('offers no way to reserve without the availability step', async () => {
      // The repository's write is named for the precondition it cannot check, and there is no
      // `reserve` beside it that would look equally safe.
      const methods = await uow.inActorScope(IN_A1, async (repositories) =>
        Object.getOwnPropertyNames(Object.getPrototypeOf(repositories.stockReservations)),
      );

      expect(methods).toContain('createUnderBalanceLock');
      expect(methods).not.toContain('create');
      expect(methods).not.toContain('reserve');
      expect(methods).not.toContain('release');
    });

    it('cannot be called without a transaction, because it takes repositories', async () => {
      // Same shape as `allocateSalesOrderNumber`. A function that opened its own transaction
      // would commit a hold whether or not the order it was for was ever confirmed.
      expect(reserveForOrderLine.length).toBe(2);
    });

    it('implements no release, which section 12.3 has not ruled on', async () => {
      await stock(IN_A1, '10');
      await reserve(IN_A1, '4');

      const app = new Client({ connectionString: process.env['DATABASE_URL'] });
      await app.connect();
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
        await app.query(`SELECT set_config('app.company_id', $1, false)`, [COMPANY_A1]);

        await expect(app.query('DELETE FROM stock_reservations')).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        await app.end();
      }
    });
  });
});
