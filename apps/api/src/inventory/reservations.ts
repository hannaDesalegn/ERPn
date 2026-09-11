/**
 * Reserving stock for a sales order line.
 *
 * Section 8.5 in one operation: available is on hand minus reserved, and an order that would
 * oversell fails inside the transaction rather than after it. The check and the write are one
 * unit, taken under the balance row lock of section 10.2, so the answer cannot go stale between
 * being read and being acted on.
 *
 * WHY THIS TAKES REPOSITORIES RATHER THAN A UNIT OF WORK, the same reason
 * `allocateSalesOrderNumber` does. Section 12.2 makes confirmation one transaction doing six
 * things or none, and reserving is step three of it. A function that opened its own transaction
 * would commit a reservation whether or not the order it was for was ever confirmed, and the
 * lock it took would be released before the rest of the work happened. Taking the repositories
 * of a transaction already in progress makes the safe thing the only expressible thing.
 *
 * WHAT THE CALLER MAY SAY, AND WHAT IT MAY NOT. A caller names a line and a quantity. Everything
 * else is read from the line and its order: the product from the line, the warehouse from the
 * order, the tenant and company from the scope that found them. Section 3.3 keeps the server
 * recomputing from its own master data, and there is no field on the request for a product, a
 * warehouse, a company or an available quantity, so none of them can be supplied wrongly.
 *
 * THE LOCK ORDER IS ONE LOCK. `availabilityForUpdate` takes the balance row for this key and
 * nothing else is locked, which is the invariant that makes the balance row a sufficient
 * serialisation point for reservations: every writer of a reservation passes through here first.
 *
 * WHAT THIS DOES NOT DO. No release, no cancellation, no delivery, no status, and no idempotency.
 * Section 12.3 has not ruled what cancelling does to reserved stock, and section 11's idempotency
 * belongs at the endpoint rather than here.
 */

import { randomUUID } from 'node:crypto';

import type { ScopedRepositories, StockReservationRecord } from '../database/index.js';
import { compare, parseDecimal, toFixed, zero } from '../shared/decimal.js';

/** The scale every quantity column in the schema uses. */
const QUANTITY_SCALE = 6;

/** The repositories this needs from a transaction already in progress. */
export type ReservationRepositories = Pick<
  ScopedRepositories,
  'stockLedger' | 'stockReservations' | 'salesOrders' | 'salesOrderLines'
>;

export interface ReservationRequest {
  /** The line the stock is held for. Everything else is read from it. */
  salesOrderLineId: string;
  /** How much to hold, in the product's stocking unit. The only quantity the caller chooses. */
  quantity: string;
}

/**
 * Why a reservation was refused.
 *
 * `line_not_found` covers a line that is missing, in another company or in another tenant, and it
 * covers them with one value on purpose. Section 6.1: a failure at the tenant or company
 * dimension is indistinguishable from the record not existing, so identifiers cannot be probed.
 */
export type ReservationRefusal =
  | 'line_not_found'
  | 'order_not_found'
  | 'invalid_quantity'
  | 'insufficient_stock';

export class StockReservationError extends Error {
  readonly reason: ReservationRefusal;
  /** Present on `insufficient_stock`, so a caller can say which line was short and by how much. */
  readonly shortfall:
    | { requested: string; available: string; onHand: string; reserved: string }
    | undefined;

  constructor(
    reason: ReservationRefusal,
    message: string,
    shortfall?: { requested: string; available: string; onHand: string; reserved: string },
  ) {
    super(message);
    this.name = 'StockReservationError';
    this.reason = reason;
    this.shortfall = shortfall;
  }
}

/**
 * Holds stock for one order line, inside the caller's transaction.
 *
 * Rolls back with that transaction, so a confirmation that fails after this call leaves the stock
 * unreserved rather than held for an order that does not exist.
 */
export async function reserveForOrderLine(
  repositories: ReservationRepositories,
  request: ReservationRequest,
): Promise<StockReservationRecord> {
  // The quantity, before anything is read. A malformed figure is rejected rather than coerced
  // into a plausible one, per section 14.2.
  const quantity = parse(request.quantity);
  if (compare(quantity, zero(0)) <= 0) {
    // The database refuses this too. Refusing it here names the reason rather than surfacing a
    // constraint violation the caller has to decode.
    throw new StockReservationError(
      'invalid_quantity',
      'A reservation must be for more than nothing',
    );
  }

  // The authoritative line. Scoped, so a line in another company is simply not found.
  const line = await repositories.salesOrderLines.findById(request.salesOrderLineId);
  if (!line) {
    throw new StockReservationError('line_not_found', 'Sales order line not found');
  }

  // The warehouse comes from the order, because that is where the order ships from. Reading it
  // from the request would let a caller hold another warehouse's stock against this line.
  const order = await repositories.salesOrders.findById(line.salesOrderId);
  if (!order) {
    // Unreachable through a real line, which a composite foreign key pins to an order in this
    // same company. Loud rather than silent, because the alternative is a reservation with no
    // warehouse.
    throw new StockReservationError('order_not_found', 'The order this line belongs to is missing');
  }

  // The lock, and the decision it protects. Everything from here to the insert is inside it.
  const availability = await repositories.stockLedger.availabilityForUpdate(
    line.productId,
    order.warehouseId,
  );

  const available = parse(availability.available);
  if (compare(available, quantity) < 0) {
    // Section 8.5: an order that would oversell fails inside the transaction, not after it.
    // Unconditional, and it does not consult the warehouse's negative stock policy. That policy
    // is about stock going negative, which is a movement, and this is a promise against stock
    // that is still on the shelf. The clause requiring this failure carries no exception.
    throw new StockReservationError(
      'insufficient_stock',
      `Only ${availability.available} available, and ${toFixed(quantity, QUANTITY_SCALE)} was asked for`,
      {
        requested: toFixed(quantity, QUANTITY_SCALE),
        available: availability.available,
        onHand: availability.onHand,
        reserved: availability.reserved,
      },
    );
  }

  return repositories.stockReservations.createUnderBalanceLock({
    id: randomUUID(),
    salesOrderLineId: line.id,
    // From the line and the order, never from the request. The composite keys in migration 0009
    // refuse the combination a second time.
    productId: line.productId,
    warehouseId: order.warehouseId,
    quantity: toFixed(quantity, QUANTITY_SCALE),
  });
}

function parse(value: string) {
  try {
    return parseDecimal(value, QUANTITY_SCALE);
  } catch (error) {
    throw new StockReservationError(
      'invalid_quantity',
      `A reservation quantity must be a decimal with at most ${QUANTITY_SCALE} places: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
