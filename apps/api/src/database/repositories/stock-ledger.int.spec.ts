/**
 * The stock ledger and its maintained balance, against a real PostgreSQL.
 *
 * The claim worth proving is that the ledger and the balance can never disagree. Section 8.1
 * makes the ledger the truth, section 8.2 makes the balance an aggregate maintained in the same
 * transaction as the movement that changes it, and section 10.2 names this exact row as the
 * canonical case for `SELECT ... FOR UPDATE`, describing the failure it prevents: two
 * salespeople both reading a balance of ten, both succeeding, and the warehouse discovering the
 * oversell at picking time.
 *
 * None of that survives a mock. A fake lock always holds, a fake transaction always rolls back
 * cleanly, and a fake unique constraint is the application agreeing with itself.
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

const TENANT_A = 'b1100000-0000-4000-8000-00000000000a';
const TENANT_B = 'b1200000-0000-4000-8000-00000000000b';

const COMPANY_A1 = 'b2100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "same tenant, different company" is representable. */
const COMPANY_A2 = 'b2200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'b2300000-0000-4000-8000-00000000000c';

const USER = 'b3100000-0000-4000-8000-00000000000a';

/** The same sku in every company, so a leak shows up as stock in the wrong place. */
const WIDGET: Record<string, string> = {
  [COMPANY_A1]: 'b4110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b4120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b4130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'b4210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b4220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b4230000-0000-4000-8000-00000000000c',
};

/** A second product and a second warehouse in the acting company, for the dimension tests. */
const GADGET = 'b4310000-0000-4000-8000-00000000000a';
const OVERFLOW = 'b4410000-0000-4000-8000-00000000000a';

/** A stand-in for the document that caused a movement, per section 8.1. */
const SOURCE_DOC = 'b5100000-0000-4000-8000-00000000000a';

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

/** A promise with its resolver, for holding a transaction open from outside it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

/**
 * The constraint that refused a write, read out of the error's cause chain.
 *
 * The query layer wraps driver errors, so the constraint name is never in the outermost
 * message. Asserting on that message alone passes for the wrong reason.
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

/** Lets pending work run, so "did the other transaction get through" has a chance to be yes. */
const settle = (ms = 250) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let nextId = 0;
const movementId = () => `b6${(nextId += 1).toString().padStart(6, '0')}-0000-4000-8000-00000000000a`;

describe('The stock ledger', () => {
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
    // Every test starts from an empty ledger, so a balance is a statement about this test.
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
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
      'stock-a',
      'Stock A',
      TENANT_B,
      'stock-b',
      'Stock B',
    ]);
    await owner.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)', [
      USER,
      'keeper@stock.test',
      'Keeper',
      'not-a-real-hash',
    ]);

    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query(
        'INSERT INTO companies (id, tenant_id, name, base_currency) VALUES ($1,$2,$3,$4)',
        [companyId, tenantId, `Company ${companyId.slice(0, 4)}`, 'USD'],
      );
      await owner.query(
        'INSERT INTO warehouses (id, tenant_id, company_id, code, name, is_default) VALUES ($1,$2,$3,$4,$5,true)',
        [WAREHOUSE[companyId], tenantId, companyId, 'WH-1', 'Main'],
      );
      await owner.query(
        `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
         VALUES ($1,$2,$3,'SKU-WIDGET','Widget','unit','10.000000','USD')`,
        [WIDGET[companyId], tenantId, companyId],
      );
    }

    await ownerContext(TENANT_A, COMPANY_A1);
    await owner.query(
      `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
       VALUES ($1,$2,$3,'SKU-GADGET','Gadget','unit','5.000000','USD')`,
      [GADGET, TENANT_A, COMPANY_A1],
    );
    await owner.query(
      'INSERT INTO warehouses (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
      [OVERFLOW, TENANT_A, COMPANY_A1, 'WH-2', 'Overflow'],
    );
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM stock_movements WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_balances WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM products WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM warehouses WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('DELETE FROM users WHERE id = $1', [USER]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  /** One movement in its own transaction, which is how a posting will reach it. */
  const move = (
    scope: ActorScope,
    quantity: string,
    overrides: Partial<{ productId: string; warehouseId: string; reason: string }> = {},
  ) =>
    uow.inActorScope(scope, (repositories) =>
      repositories.stockLedger.record({
        id: movementId(),
        productId: overrides.productId ?? WIDGET[scope.companyId]!,
        warehouseId: overrides.warehouseId ?? WAREHOUSE[scope.companyId]!,
        quantity,
        reason: overrides.reason ?? 'purchase_receipt',
        sourceDocType: 'purchase_receipt',
        sourceDocId: SOURCE_DOC,
      }),
    );

  const storedBalance = async (tenantId: string, companyId: string, productId: string, warehouseId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{ on_hand: string; version: number }>(
      'SELECT on_hand, version FROM stock_balances WHERE product_id = $1 AND warehouse_id = $2',
      [productId, warehouseId],
    );
    return rows.rows[0];
  };

  const storedMovements = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{ id: string; quantity: string; reason: string }>(
      'SELECT id, quantity, reason FROM stock_movements ORDER BY created_at',
    );
    return rows.rows;
  };

  // -------------------------------------------------------------------------------------
  // 1 to 3. Recording a movement, and what it does to the balance.
  // -------------------------------------------------------------------------------------

  describe('recording a movement', () => {
    it('writes the fact and returns it', async () => {
      const { movement } = await move(IN_A1, '50');

      expect(movement.tenantId).toBe(TENANT_A);
      expect(movement.companyId).toBe(COMPANY_A1);
      expect(movement.quantity).toBe('50.000000');
      expect(movement.reason).toBe('purchase_receipt');
      expect(movement.sourceDocId).toBe(SOURCE_DOC);
    });

    it('creates the balance for a key nothing has moved before', async () => {
      const { balance } = await move(IN_A1, '50');

      expect(balance.onHand).toBe('50.000000');
      expect((await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!))?.on_hand).toBe(
        '50.000000',
      );
    });

    it('moves the balance by the signed quantity, in both directions', async () => {
      await move(IN_A1, '50');
      const { balance } = await move(IN_A1, '-20', { reason: 'sales_delivery' });

      expect(balance.onHand).toBe('30.000000');
    });

    it('accumulates across many movements', async () => {
      await move(IN_A1, '100');
      await move(IN_A1, '-30', { reason: 'sales_delivery' });
      await move(IN_A1, '-5', { reason: 'scrap' });
      await move(IN_A1, '12', { reason: 'customer_return' });

      const stored = await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!);
      expect(stored?.on_hand).toBe('77.000000');
      expect(await storedMovements(TENANT_A, COMPANY_A1)).toHaveLength(4);
    });

    it('keeps fractional quantities exactly, per section 4.4', async () => {
      // Distribution sells fractional kilograms and metres, and a double would already be wrong.
      await move(IN_A1, '0.000001');
      await move(IN_A1, '0.000002');

      const stored = await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!);
      expect(stored?.on_hand).toBe('0.000003');
    });

    it('lets the balance go negative, because policy decides that and not the column', async () => {
      // Section 8.5 makes negative stock a per warehouse policy defaulting to deny. Refusing an
      // oversell belongs where the policy is read; the ledger records what happened.
      const { balance } = await move(IN_A1, '-5', { reason: 'sales_delivery' });

      expect(balance.onHand).toBe('-5.000000');
    });

    it('leaves the balance equal to the sum of its movements', async () => {
      await move(IN_A1, '40');
      await move(IN_A1, '-15', { reason: 'sales_delivery' });
      await move(IN_A1, '7', { reason: 'adjustment' });

      // The rebuild and verify job of section 8.2 will make exactly this comparison.
      await ownerContext(TENANT_A, COMPANY_A1);
      const check = await owner.query<{ ledger: string; maintained: string }>(
        `SELECT (SELECT sum(quantity) FROM stock_movements WHERE product_id = $1 AND warehouse_id = $2) AS ledger,
                (SELECT on_hand FROM stock_balances WHERE product_id = $1 AND warehouse_id = $2) AS maintained`,
        [WIDGET[COMPANY_A1], WAREHOUSE[COMPANY_A1]],
      );

      expect(check.rows[0]?.maintained).toBe(check.rows[0]?.ledger);
    });
  });

  // -------------------------------------------------------------------------------------
  // 4 and 12. The database enforces the rules, not the application.
  // -------------------------------------------------------------------------------------

  describe('the database enforces the ledger rules', () => {
    it('refuses to update a movement, because the grant is absent', async () => {
      // Section 8.1 calls the ledger immutable. Section 7.1 established that the way to mean it
      // is to withhold the grant, so this is the database refusing rather than a code review.
      await move(IN_A1, '10');

      const app = new Client({ connectionString: process.env['DATABASE_URL'] });
      await app.connect();
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
        await app.query(`SELECT set_config('app.company_id', $1, false)`, [COMPANY_A1]);

        await expect(app.query('UPDATE stock_movements SET quantity = 999')).rejects.toThrow(
          /permission denied/i,
        );
        await expect(app.query('DELETE FROM stock_movements')).rejects.toThrow(/permission denied/i);
      } finally {
        await app.end();
      }
    });

    it('offers no way to update a movement through the repository either', async () => {
      const methods = await uow.inActorScope(IN_A1, async (repositories) =>
        Object.getOwnPropertyNames(Object.getPrototypeOf(repositories.stockLedger)),
      );

      expect(methods).toContain('record');
      expect(methods).not.toContain('update');
      expect(methods).not.toContain('delete');
      expect(methods).not.toContain('updateBalance');
    });

    it('refuses a movement of zero', async () => {
      // A movement of nothing is not a fact worth recording.
      expect(await refusedBy(move(IN_A1, '0'))).toMatch(/stock_movements_quantity_check/);
    });

    it('refuses a reason outside the eight', async () => {
      // Section 8.7 makes the reason how this model says where goods came from or went, so it is
      // a closed list. An invented reason would be a movement nobody can interpret.
      expect(await refusedBy(move(IN_A1, '5', { reason: 'shrinkage' }))).toMatch(
        /stock_movements_reason_check/,
      );
    });

    it('refuses a product belonging to another company', async () => {
      // The composite key. Both rows are individually legitimate and only the pairing is wrong,
      // which is what row level security cannot catch on its own.
      //
      // The balance key is what refuses it, because the balance row is ensured before the
      // movement is written. Either constraint is the same rule: the pairing is named on both
      // tables precisely so neither can record a product this company does not own.
      expect(await refusedBy(move(IN_A1, '5', { productId: WIDGET[COMPANY_A2]! }))).toMatch(
        /stock_balances_product_fkey/,
      );

      expect(await storedMovements(TENANT_A, COMPANY_A1)).toEqual([]);
    });

    it('refuses a warehouse belonging to another company', async () => {
      expect(await refusedBy(move(IN_A1, '5', { warehouseId: WAREHOUSE[COMPANY_A2]! }))).toMatch(
        /stock_balances_warehouse_fkey/,
      );

      expect(await storedMovements(TENANT_A, COMPANY_A1)).toEqual([]);
    });

    it('names the pairing on the movement table too, not only on the balance', async () => {
      // Proving the movement's own key exists rather than inferring it from the migration text.
      // The balance happens to be checked first; both must hold.
      await ownerContext(TENANT_A, COMPANY_A1);
      const keys = await owner.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'stock_movements'::regclass AND contype = 'f'`,
      );
      const names = keys.rows.map((row) => row.conname);

      expect(names).toContain('stock_movements_product_fkey');
      expect(names).toContain('stock_movements_warehouse_fkey');
    });

    it('refuses a second balance row for one key', async () => {
      await move(IN_A1, '5');

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO stock_balances (id, tenant_id, company_id, product_id, warehouse_id, on_hand)
           VALUES ($1,$2,$3,$4,$5,0)`,
          ['b7100000-0000-4000-8000-00000000000a', TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1], WAREHOUSE[COMPANY_A1]],
        ),
      ).rejects.toThrow(/stock_balances_key_key/);
    });

    it('holds no delete grant on a balance either', async () => {
      const app = new Client({ connectionString: process.env['DATABASE_URL'] });
      await app.connect();
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
        await app.query(`SELECT set_config('app.company_id', $1, false)`, [COMPANY_A1]);

        // A balance that can be dropped is one that can be silently re-derived as zero.
        await expect(app.query('DELETE FROM stock_balances')).rejects.toThrow(/permission denied/i);
      } finally {
        await app.end();
      }
    });
  });

  // -------------------------------------------------------------------------------------
  // 5, 6 and the transaction proof.
  // -------------------------------------------------------------------------------------

  describe('the movement and its balance are one write', () => {
    it('shares a transaction, proved by xmin', async () => {
      // Two different values would mean two transactions, and a window in which the ledger and
      // the balance disagree. This is the proof the audit trail uses in section 7.1.
      await move(IN_A1, '25');

      await ownerContext(TENANT_A, COMPANY_A1);
      const written = await owner.query<{ xmin: string }>(
        `SELECT xmin::text AS xmin FROM stock_movements
         UNION
         SELECT xmin::text FROM stock_balances`,
      );

      expect(written.rows).toHaveLength(1);
    });

    it('leaves no movement when the transaction fails afterwards', async () => {
      const failure = new Error('posting refused by test');

      await expect(
        uow.inActorScope(IN_A1, async (repositories) => {
          await repositories.stockLedger.record({
            id: movementId(),
            productId: WIDGET[COMPANY_A1]!,
            warehouseId: WAREHOUSE[COMPANY_A1]!,
            quantity: '100',
            reason: 'purchase_receipt',
            sourceDocType: 'purchase_receipt',
            sourceDocId: SOURCE_DOC,
          });
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(await storedMovements(TENANT_A, COMPANY_A1)).toEqual([]);
      expect(await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!)).toBeUndefined();
    });

    it('leaves the balance where it was when a later movement fails', async () => {
      await move(IN_A1, '40');

      await expect(
        uow.inActorScope(IN_A1, async (repositories) => {
          await repositories.stockLedger.record({
            id: movementId(),
            productId: WIDGET[COMPANY_A1]!,
            warehouseId: WAREHOUSE[COMPANY_A1]!,
            quantity: '-10',
            reason: 'sales_delivery',
            sourceDocType: 'sales_delivery',
            sourceDocId: SOURCE_DOC,
          });
          // A second movement naming a product from another company, refused by the key.
          await repositories.stockLedger.record({
            id: movementId(),
            productId: WIDGET[COMPANY_B1]!,
            warehouseId: WAREHOUSE[COMPANY_A1]!,
            quantity: '-5',
            reason: 'sales_delivery',
            sourceDocType: 'sales_delivery',
            sourceDocId: SOURCE_DOC,
          });
        }),
      ).rejects.toThrow();

      // Still forty, and still one movement. The whole posting rolled back, not part of it.
      const stored = await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!);
      expect(stored?.on_hand).toBe('40.000000');
      expect(await storedMovements(TENANT_A, COMPANY_A1)).toHaveLength(1);
    });

    it('bumps the balance version on every movement', async () => {
      await move(IN_A1, '5');
      const first = await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!);

      await move(IN_A1, '5');
      const second = await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!);

      expect(second!.version).toBe(first!.version + 1);
    });
  });

  // -------------------------------------------------------------------------------------
  // 10 and 11. Concurrency, which is the reason the lock exists.
  // -------------------------------------------------------------------------------------

  describe('two transactions at once', () => {
    it('makes the second wait for the first, rather than reading past it', async () => {
      // The canonical failure of section 10.2: both read ten, both succeed, the warehouse finds
      // the oversell at picking time. The lock is what makes the second one wait.
      await move(IN_A1, '10');

      const held = gate();
      let secondFinished = false;

      const first = uow.inActorScope(IN_A1, async (repositories) => {
        await repositories.stockLedger.record({
          id: movementId(),
          productId: WIDGET[COMPANY_A1]!,
          warehouseId: WAREHOUSE[COMPANY_A1]!,
          quantity: '-10',
          reason: 'sales_delivery',
          sourceDocType: 'sales_delivery',
          sourceDocId: SOURCE_DOC,
        });
        await held.promise;
      });

      await settle();
      const second = move(IN_A1, '-10', { reason: 'sales_delivery' }).then((result) => {
        secondFinished = true;
        return result;
      });

      await settle();
      // Blocked on the row, not merely slow.
      expect(secondFinished).toBe(false);

      held.open();
      await first;
      await second;

      // Both movements are recorded and the balance reflects both, which is only possible if the
      // second read the value the first had already written.
      const stored = await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!);
      expect(stored?.on_hand).toBe('-10.000000');
      expect(await storedMovements(TENANT_A, COMPANY_A1)).toHaveLength(3);
    });

    it('loses no update when ten movements race for one balance', async () => {
      await Promise.all(Array.from({ length: 10 }, () => move(IN_A1, '3')));

      // Thirty, not three. A read-modify-write without the lock would land somewhere between.
      const stored = await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!);
      expect(stored?.on_hand).toBe('30.000000');
      expect(await storedMovements(TENANT_A, COMPANY_A1)).toHaveLength(10);
    });

    it('creates exactly one balance when ten movements race for a key that has none', async () => {
      // The first-movement race. Ten transactions all find no balance; only one row may exist.
      await Promise.all(Array.from({ length: 10 }, () => move(IN_A1, '1', { productId: GADGET })));

      await ownerContext(TENANT_A, COMPANY_A1);
      const rows = await owner.query('SELECT id FROM stock_balances WHERE product_id = $1', [GADGET]);

      expect(rows.rows).toHaveLength(1);
      expect((await storedBalance(TENANT_A, COMPANY_A1, GADGET, WAREHOUSE[COMPANY_A1]!))?.on_hand).toBe(
        '10.000000',
      );
    });

    it('lets a different key proceed while one is held', async () => {
      const held = gate();

      const first = uow.inActorScope(IN_A1, async (repositories) => {
        await repositories.stockLedger.record({
          id: movementId(),
          productId: WIDGET[COMPANY_A1]!,
          warehouseId: WAREHOUSE[COMPANY_A1]!,
          quantity: '5',
          reason: 'purchase_receipt',
          sourceDocType: 'purchase_receipt',
          sourceDocId: SOURCE_DOC,
        });
        await held.promise;
      });

      await settle();
      // A different product entirely, so a different balance row and a different lock.
      const other = await move(IN_A1, '7', { productId: GADGET });

      expect(other.balance.onHand).toBe('7.000000');

      held.open();
      await first;
    });
  });

  // -------------------------------------------------------------------------------------
  // 7 and 8. Scope, and the dimensions of a balance.
  // -------------------------------------------------------------------------------------

  describe('balances are separate', () => {
    it('keeps two companies in one tenant apart', async () => {
      await move(IN_A1, '100');
      await move(IN_A2, '7');

      expect((await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!))?.on_hand).toBe(
        '100.000000',
      );
      expect((await storedBalance(TENANT_A, COMPANY_A2, WIDGET[COMPANY_A2]!, WAREHOUSE[COMPANY_A2]!))?.on_hand).toBe(
        '7.000000',
      );
    });

    it('keeps two tenants apart', async () => {
      await move(IN_A1, '100');
      await move(IN_B1, '3');

      expect((await storedBalance(TENANT_B, COMPANY_B1, WIDGET[COMPANY_B1]!, WAREHOUSE[COMPANY_B1]!))?.on_hand).toBe(
        '3.000000',
      );
      expect(await storedMovements(TENANT_B, COMPANY_B1)).toHaveLength(1);
    });

    it('shows a company only its own movements', async () => {
      await move(IN_A1, '100');
      await move(IN_A2, '7');

      const seen = await uow.inActorScope(IN_A1, (repositories) =>
        repositories.stockLedger.movementsFor(WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!),
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]?.companyId).toBe(COMPANY_A1);
    });

    it('gives a company no balance for another company\'s key', async () => {
      await move(IN_A2, '7');

      const seen = await uow.inActorScope(IN_A1, (repositories) =>
        repositories.stockLedger.balanceFor(WIDGET[COMPANY_A2]!, WAREHOUSE[COMPANY_A2]!),
      );

      expect(seen).toBeNull();
    });

    it('keeps one product apart from another in the same warehouse', async () => {
      await move(IN_A1, '100');
      await move(IN_A1, '4', { productId: GADGET });

      expect((await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!))?.on_hand).toBe(
        '100.000000',
      );
      expect((await storedBalance(TENANT_A, COMPANY_A1, GADGET, WAREHOUSE[COMPANY_A1]!))?.on_hand).toBe('4.000000');
    });

    it('keeps one warehouse apart from another for the same product', async () => {
      // The same product in two warehouses is two positions. Section 8.2 keys the balance by
      // location as well as product for exactly this reason.
      await move(IN_A1, '100');
      await move(IN_A1, '9', { warehouseId: OVERFLOW });

      expect((await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, WAREHOUSE[COMPANY_A1]!))?.on_hand).toBe(
        '100.000000',
      );
      expect((await storedBalance(TENANT_A, COMPANY_A1, WIDGET[COMPANY_A1]!, OVERFLOW))?.on_hand).toBe('9.000000');
    });
  });

  // -------------------------------------------------------------------------------------
  // 9 and 10 of the invariant list. What this increment deliberately does not hold.
  // -------------------------------------------------------------------------------------

  describe('what is deliberately absent', () => {
    it('represents no reservation anywhere', async () => {
      // Section 8.5 defines available as on hand minus reserved, but a reservation is not a
      // movement, so where reserved lives is the reservation increment's question. A column
      // nothing maintains would read as though the work were done.
      await ownerContext(TENANT_A, COMPANY_A1);
      const columns = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name IN ('stock_balances', 'stock_movements')`,
      );
      const names = columns.rows.map((row) => row.column_name);

      expect(names).not.toContain('reserved');
      expect(names).not.toContain('reserved_quantity');
      expect(names).not.toContain('available');
    });

    it('carries no cost on a movement, because value is a separate record', async () => {
      // Section 8.3, after Business Central's Item Ledger Entry and Value Entry: quantity and
      // cost are known at different times, and conflating them is what produced the fixture
      // set's inventory control account and valuation differing by three hundred thousand.
      await ownerContext(TENANT_A, COMPANY_A1);
      const columns = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'stock_movements'`,
      );
      const names = columns.rows.map((row) => row.column_name);

      expect(names).not.toContain('unit_cost');
      expect(names).not.toContain('cost');
      expect(names).not.toContain('value');
    });
  });
});
