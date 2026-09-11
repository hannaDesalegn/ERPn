/**
 * The stock ledger, and the balance it maintains.
 *
 * ONE METHOD, AND IT WRITES TWO ROWS. Section 8.2 requires the balance to be maintained in the
 * same transaction as the movement that changes it, so recording a movement and updating the
 * balance are not two operations a caller could do one of. There is no `updateBalance` to call
 * on its own and no way to insert a movement without the balance following, because a ledger and
 * an aggregate that disagree is the one state this pair exists to prevent.
 *
 * THE LOCK IS THE POINT. Section 10.2 names stock balance rows as the canonical case for
 * `SELECT ... FOR UPDATE`, and describes the failure it prevents: two salespeople confirming
 * orders for the last ten units at the same moment, both reading a balance of ten, both
 * succeeding, and the warehouse discovering the oversell at picking time. The lock is taken
 * before the balance is read, so the second transaction waits rather than reading a value the
 * first is about to change.
 *
 * LOCK ORDER. Section 10.2 requires the acquisition order to be documented and followed. This
 * operation takes exactly one lock, on the balance row for its own key, and takes it before the
 * movement is written. A caller moving several products in one transaction therefore acquires
 * locks in the order it presents them, and the rule when that arrives is to sort by product then
 * warehouse, so two transactions touching the same pair of keys cannot deadlock against each
 * other. Nothing here takes a second lock, so nothing here can deadlock yet.
 *
 * NO ON HAND CHECK. Section 8.5 makes negative stock a policy per warehouse defaulting to deny,
 * and refusing an oversell is the reservation increment's work, where the policy is read and the
 * order is the thing being refused. A movement that takes a balance negative is recorded here,
 * because the ledger records what happened.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';

import { stockBalances, stockMovements } from '../schema/inventory.js';
import type { Scope } from '../scope.js';
import { actingUserId } from '../scope.js';
import { requireCompanyScope } from './company-scope.js';
import type {
  NewStockMovement,
  RecordedMovement,
  StockBalanceRecord,
  StockLedgerRepository,
  StockMovementRecord,
} from './types.js';

/** The same handle every other repository takes: a transaction, never the pool. */
type Db = NodePgDatabase<Record<string, never>>;

export class DrizzleStockLedgerRepository implements StockLedgerRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async balanceFor(productId: string, warehouseId: string): Promise<StockBalanceRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Stock');

    const rows = await this.db
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.tenantId, tenantId),
          eq(stockBalances.companyId, companyId),
          eq(stockBalances.productId, productId),
          eq(stockBalances.warehouseId, warehouseId),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row ? toBalance(row) : null;
  }

  async movementsFor(productId: string, warehouseId: string): Promise<StockMovementRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Stock');

    const rows = await this.db
      .select()
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.tenantId, tenantId),
          eq(stockMovements.companyId, companyId),
          eq(stockMovements.productId, productId),
          eq(stockMovements.warehouseId, warehouseId),
        ),
      )
      .orderBy(stockMovements.occurredAt);

    return rows.map(toMovement);
  }

  /**
   * Records one movement and moves its balance by the same quantity.
   *
   * FOUR STATEMENTS, IN THIS ORDER, AND THE ORDER MATTERS.
   *
   * First an insert of the balance row that does nothing if one already exists. This is what
   * makes the first movement for a key work without a read-then-create race: two transactions
   * both finding no balance and both creating one would otherwise produce the duplicate the
   * unique key forbids, and one of them would fail on what is really a benign collision.
   *
   * Then `SELECT ... FOR UPDATE`, which is section 10.2's lock. A second transaction reaching
   * this line for the same key blocks here until this one commits or rolls back.
   *
   * Then the movement insert, which is the fact.
   *
   * Then the balance update, computed by the database from the locked row (`on_hand + $1`)
   * rather than from any value this process read. Even a stale read cannot produce a lost
   * update, and the version check asserts the lock was held: under it the match cannot fail, so
   * a failure means the lock above stopped being taken.
   *
   * Nothing here commits. Both rows belong to the caller's transaction, so a later failure takes
   * the movement and the balance together and neither is left describing the other wrongly.
   */
  async record(input: NewStockMovement): Promise<RecordedMovement> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Stock');
    const actor = actingUserId(this.scope);

    const belongsHere = and(
      eq(stockBalances.tenantId, tenantId),
      eq(stockBalances.companyId, companyId),
      eq(stockBalances.productId, input.productId),
      eq(stockBalances.warehouseId, input.warehouseId),
    );

    // A balance of zero is the honest starting position for a key nothing has moved yet.
    await this.db
      .insert(stockBalances)
      .values({
        id: randomUUID(),
        tenantId,
        companyId,
        productId: input.productId,
        warehouseId: input.warehouseId,
        onHand: '0',
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing();

    const locked = await this.db.select().from(stockBalances).where(belongsHere).limit(1).for('update');

    const balanceBefore = locked[0];
    if (!balanceBefore) {
      // Unreachable: the insert above either created the row or found it already there.
      throw new Error('The stock balance vanished between being ensured and being locked');
    }

    const movementRows = await this.db
      .insert(stockMovements)
      .values({
        id: input.id,
        // From the scope. `NewStockMovement` has no field with which to claim another company.
        tenantId,
        companyId,
        productId: input.productId,
        warehouseId: input.warehouseId,
        quantity: input.quantity,
        reason: input.reason,
        sourceDocType: input.sourceDocType,
        sourceDocId: input.sourceDocId,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();

    const movement = movementRows[0];
    if (!movement) throw new Error('Insert returned no row');

    const updated = await this.db
      .update(stockBalances)
      .set({
        // Computed by the database from the locked row, never from what this process read.
        onHand: sql`${stockBalances.onHand} + ${input.quantity}`,
        version: sql`${stockBalances.version} + 1`,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(and(eq(stockBalances.id, balanceBefore.id), eq(stockBalances.version, balanceBefore.version)))
      .returning();

    const balance = updated[0];
    if (!balance) {
      // Section 4.2 requires the version to be checked rather than merely present. Under the
      // lock above this cannot happen, which is exactly what makes it a useful assertion: it is
      // what fails first if the lock is ever dropped.
      throw new Error('The stock balance changed under a lock that should have prevented it');
    }

    return { movement: toMovement(movement), balance: toBalance(balance) };
  }
}

function toMovement(row: typeof stockMovements.$inferSelect): StockMovementRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    productId: row.productId,
    warehouseId: row.warehouseId,
    quantity: row.quantity,
    reason: row.reason,
    sourceDocType: row.sourceDocType,
    sourceDocId: row.sourceDocId,
    occurredAt: row.occurredAt,
  };
}

function toBalance(row: typeof stockBalances.$inferSelect): StockBalanceRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    productId: row.productId,
    warehouseId: row.warehouseId,
    onHand: row.onHand,
    version: row.version,
  };
}
