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
 * NO RELEASE AND NO UPDATE. The application role holds neither grant. Section 12.3 has not ruled
 * whether cancelling releases reserved stock, and partial delivery might reduce a reservation or
 * close it, so the shape of release is undecided and the schema says so by withholding the grant
 * rather than by guessing.
 */

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { stockReservations } from '../schema/inventory.js';
import type { Scope } from '../scope.js';
import { actingUserId } from '../scope.js';
import { requireCompanyScope } from './company-scope.js';
import type {
  NewStockReservation,
  StockReservationRecord,
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
  };
}
