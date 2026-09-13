/**
 * Reading and recording reservations against stock.
 *
 * WHAT IS DELIBERATELY NOT HERE IS THE RESERVATION OPERATION. `createUnderBalanceLock` writes a
 * row and makes no claim that the stock was there to be held. Section 8.5 requires an order that
 * would oversell to fail inside the transaction, and section 10.2 requires the balance row to be
 * locked while that decision is made, so reserving is a read of availability under a lock
 * followed by this write, not this write alone. That operation is `reserveForOrderLine` in
 * `src/inventory/reservations.ts`, and the method here is named for the precondition it cannot
 * check so that a call from anywhere else fails review on the name.
 *
 * RELEASE IS THE SAME SHAPE. `releaseUnderBalanceLock` stamps one row and says nothing about
 * whether the balance row for its key was locked first. Section 12.3's ruling of 2026-09-13 made
 * release a stamp rather than a delete, and migration 0012 grants UPDATE and still no DELETE, so
 * the record of what was held survives every release the application can perform.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { salesOrderLines } from '../schema/sales.js';
import { stockReservations } from '../schema/inventory.js';
import type { Scope } from '../scope.js';
import { actingUserId } from '../scope.js';
import { requireCompanyScope } from './company-scope.js';
import { ConcurrencyConflictError } from './types.js';
import type {
  NewStockReservation,
  StockReservationRecord,
  StockReservationRelease,
  StockReservationRepository,
} from './types.js';

/** The same handle every other repository takes: a transaction, never the pool. */
type Db = NodePgDatabase<Record<string, never>>;

export class DrizzleStockReservationRepository implements StockReservationRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async listForBalanceKey(
    productId: string,
    warehouseId: string,
  ): Promise<StockReservationRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Stock reservations');

    const rows = await this.db
      .select()
      .from(stockReservations)
      .where(
        and(
          eq(stockReservations.tenantId, tenantId),
          eq(stockReservations.companyId, companyId),
          eq(stockReservations.productId, productId),
          eq(stockReservations.warehouseId, warehouseId),
        ),
      )
      .orderBy(stockReservations.reservedAt);

    return rows.map(toReservation);
  }

  async listForOrderLine(salesOrderLineId: string): Promise<StockReservationRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Stock reservations');

    const rows = await this.db
      .select()
      .from(stockReservations)
      .where(
        and(
          eq(stockReservations.tenantId, tenantId),
          eq(stockReservations.companyId, companyId),
          eq(stockReservations.salesOrderLineId, salesOrderLineId),
        ),
      )
      .orderBy(stockReservations.reservedAt);

    return rows.map(toReservation);
  }

  async listActiveForOrder(salesOrderId: string): Promise<StockReservationRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Stock reservations');

    // Joined to the lines rather than fetched line by line. A cancellation must release
    // everything the order holds, and a caller looping over lines it read earlier releases
    // everything it happened to know about, which is not the same list.
    const rows = await this.db
      .select({ reservation: stockReservations })
      .from(stockReservations)
      .innerJoin(salesOrderLines, eq(salesOrderLines.id, stockReservations.salesOrderLineId))
      .where(
        and(
          eq(stockReservations.tenantId, tenantId),
          eq(stockReservations.companyId, companyId),
          eq(salesOrderLines.salesOrderId, salesOrderId),
          // Active only. A released row is not held, so releasing it again would be a second
          // stamp over the first and would lose when the stock actually came back.
          isNull(stockReservations.releasedAt),
        ),
      )
      // Deterministic, and it is the lock order the cancelling operation follows.
      .orderBy(stockReservations.productId, stockReservations.warehouseId, stockReservations.id);

    return rows.map((row) => toReservation(row.reservation));
  }

  async releaseUnderBalanceLock(input: StockReservationRelease): Promise<StockReservationRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Stock reservations');

    const rows = await this.db
      .update(stockReservations)
      .set({
        releasedAt: new Date(),
        version: sql`${stockReservations.version} + 1`,
        updatedAt: new Date(),
        updatedBy: actingUserId(this.scope),
      })
      .where(
        and(
          eq(stockReservations.tenantId, tenantId),
          eq(stockReservations.companyId, companyId),
          eq(stockReservations.id, input.id),
          // Section 10.1's guard, and it is read rather than merely carried: a release built on a
          // stale read matches no row here.
          eq(stockReservations.version, input.expectedVersion),
          // And the row must still be held. Two cancellations that both passed the order's own
          // guard resolve here, and the second releases nothing rather than restamping the first.
          isNull(stockReservations.releasedAt),
        ),
      )
      .returning();

    const row = rows[0];
    if (!row) throw new ConcurrencyConflictError('Stock reservation', input.id);
    return toReservation(row);
  }

  async createUnderBalanceLock(input: NewStockReservation): Promise<StockReservationRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, 'Stock reservations');

    const rows = await this.db
      .insert(stockReservations)
      .values({
        id: input.id,
        // From the scope. `NewStockReservation` has no field with which to claim another company,
        // and the composite keys refuse a line, product or warehouse belonging to one.
        tenantId,
        companyId,
        salesOrderLineId: input.salesOrderLineId,
        productId: input.productId,
        warehouseId: input.warehouseId,
        quantity: input.quantity,
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toReservation(row);
  }
}

function toReservation(row: typeof stockReservations.$inferSelect): StockReservationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    salesOrderLineId: row.salesOrderLineId,
    productId: row.productId,
    warehouseId: row.warehouseId,
    quantity: row.quantity,
    reservedAt: row.reservedAt,
    releasedAt: row.releasedAt,
    version: row.version,
  };
}
