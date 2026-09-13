/**
 * Cancelling a sales order.
 *
 * Section 12.3's ruling of 2026-09-13, composed from mechanisms that already existed, in the
 * same shape `confirmSalesOrder` beside it uses. Nothing here is reimplemented: the transition
 * table decides legality, the grants read decides authorization, the balance row lock serialises
 * the stock, and the audit append records who did it.
 *
 * THE STEPS, AND WHY THEY ARE IN THIS ORDER:
 *
 *   1. read the order under the acting scope            section 6.1 and 6.3
 *   2. check the move against the transition table      section 12.1
 *   3. authorize                                        sales:cancel, section 6.2
 *   4. release every reservation the order still holds  section 12.3, under 10.2's lock
 *   5. write the status, guarded by the version read    section 10.1
 *   6. write the audit record                           section 7.1
 *   7. commit, which is the caller's
 *
 * ONE TRANSACTION, AND IT IS THE CALLER'S, for the reason confirmation gives: a function that
 * opened its own would release stock while the status write that justified it failed. There is no
 * compensating path here and there does not need to be one. A throw at any step rolls the whole
 * thing back, and the release stamps, the status and the audit row disappear together.
 *
 * NO NUMBER IS ALLOCATED. Confirming allocates because it raises a document the business stands
 * behind. Cancelling raises nothing. A cancelled draft therefore stays unnumbered, which the
 * check constraint amended in migration 0012 permits for exactly this status and no other.
 *
 * THE LOCK ORDER, per section 10.2's requirement that it be documented and followed. This takes
 * the balance row lock for each reservation's product and warehouse, in the order
 * `listActiveForOrder` returns them, which is sorted by product then warehouse then reservation.
 * That is the same rule `confirmSalesOrder` follows through its lines, so a cancellation and a
 * confirmation competing for the same two keys queue rather than deadlock.
 *
 * WHY THE LOCK IS TAKEN AT ALL, when the release writes to the reservation row rather than to the
 * balance. Because availability is on hand minus active reservations, and a reader deciding
 * whether to reserve reads both under that one lock. Releasing outside it would let a confirmation
 * read the pre-release reserved figure, refuse an order for stock that had just come back, or
 * worse, read the post-release figure while this transaction later rolls back. The balance row is
 * the serialisation point for every question about a key, and section 10.2 names it as such.
 */

import type { CompanyContext } from '../identity/identity.service.js';
import { grantsIn } from '../authorization/authorization.service.js';
import type { ScopedRepositories, SalesOrderRecord } from '../database/index.js';
import { add, parseDecimal, toFixed, zero } from '../shared/decimal.js';
import { assertTransition, statusOf } from './sales-order-status.js';

/** The repositories this needs from a transaction already in progress. */
export type CancellationRepositories = Pick<
  ScopedRepositories,
  'salesOrders' | 'stockLedger' | 'stockReservations' | 'roles' | 'audit'
>;

/**
 * What a caller may say.
 *
 * An identifier, and a reason if they have one. That is the whole of it. The status it moves to
 * is the transition table's, the stock it releases is read from the order, and the actor is the
 * session's, so there is no field here through which any of them could be supplied.
 */
export interface CancellationRequest {
  salesOrderId: string;
  /**
   * Why, in the person's own words. Optional, per the ruling.
   *
   * Kept in the audit record and nowhere else. It explains a transition rather than describing
   * the order, so it is not a property of the order and there is no column for it.
   */
  reason?: string | undefined;
}

/**
 * Why a cancellation was refused.
 *
 * `not_found` covers an order that is missing, in another company or in another tenant, for the
 * reason section 6.1 gives: those must be one answer so identifiers cannot be probed.
 */
export type CancellationRefusal =
  | 'not_found'
  | 'forbidden'
  | 'illegal_transition'
  | 'invalid_reason';

export class SalesOrderCancellationError extends Error {
  readonly reason: CancellationRefusal;

  constructor(reason: CancellationRefusal, message: string) {
    super(message);
    this.name = 'SalesOrderCancellationError';
    this.reason = reason;
  }
}

export interface CancelledSalesOrder {
  order: SalesOrderRecord;
  /** The reservations this cancellation released, in the order it released them. */
  releasedReservationIds: string[];
  /** What came back to available, summed across those reservations, at the quantity scale. */
  releasedQuantity: string;
}

/** The capability section 6.2 requires for this operation, from the existing catalogue. */
const REQUIRED_PERMISSION = 'sales:cancel';

/** The scale every quantity column in the schema uses. */
const QUANTITY_SCALE = 6;

/**
 * The longest reason worth storing.
 *
 * Refused rather than truncated, because a reason cut off halfway is a worse record than no
 * reason at all and the caller cannot tell it happened. Checked here as well as at the endpoint:
 * the endpoint is a boundary and this is the rule, and a second caller should not be able to
 * write an unbounded string into the audit payload by not going through HTTP.
 */
export const MAX_REASON_LENGTH = 500;

export async function cancelSalesOrder(
  repositories: CancellationRepositories,
  context: CompanyContext,
  request: CancellationRequest,
): Promise<CancelledSalesOrder> {
  // ---- Step 0: the one thing the caller said that is theirs to say. ---------------------
  //
  // Before anything is read, so a malformed request is refused rather than half performed.
  const reason = request.reason?.trim();
  if (reason !== undefined && reason.length > MAX_REASON_LENGTH) {
    throw new SalesOrderCancellationError(
      'invalid_reason',
      `A cancellation reason may be at most ${MAX_REASON_LENGTH} characters`,
    );
  }

  // ---- Step 1: read the order under the acting scope. ----------------------------------
  //
  // The scope is in the query, so an order in another company is not found rather than found
  // and refused. This read is also where the version guarding step five comes from.
  const order = await repositories.salesOrders.findById(request.salesOrderId);
  if (!order) {
    throw new SalesOrderCancellationError('not_found', 'Sales order not found');
  }

  // ---- Step 2: check the move. ---------------------------------------------------------
  //
  // Section 12.1's table decides, not a status compared in place. A second cancellation of an
  // already cancelled order fails here, which is the state guard section 11 requires to exist
  // independently of any idempotency record.
  const from = statusOf(order.status);
  assertTransition(from, 'cancelled');

  // ---- Step 3: authorize. --------------------------------------------------------------
  //
  // Read inside this transaction rather than before it, so a capability revoked a moment ago is
  // not usable by a request already in flight. The tenant and company dimensions were settled by
  // the scoped read above.
  const grants = await grantsIn(repositories, context.membershipId);
  if (!grants.permissions.includes(REQUIRED_PERMISSION)) {
    throw new SalesOrderCancellationError(
      'forbidden',
      'Cancelling a sales order needs the sales:cancel capability in this company',
    );
  }

  // ---- Step 4: release what the order holds. -------------------------------------------
  //
  // Read from the order rather than from anything the caller said, and read now rather than
  // earlier, so a reservation written between the caller's screen and this transaction is
  // released too. A draft holds nothing and this is simply empty, which is not a special case.
  const held = await repositories.stockReservations.listActiveForOrder(order.id);

  const releasedReservationIds: string[] = [];
  // Summed through the shared arithmetic of section 4.3 rather than in a double. The figure is
  // for a person to read and is still not worked out in floating point.
  let releasedQuantity = zero(QUANTITY_SCALE);
  for (const reservation of held) {
    // The lock, before the release it protects. Sequential rather than parallel, in the order
    // the read returned, which is the acquisition order documented above. `availabilityForUpdate`
    // writes nothing; it is called for the lock and for nothing else here.
    await repositories.stockLedger.availabilityForUpdate(
      reservation.productId,
      reservation.warehouseId,
    );

    const released = await repositories.stockReservations.releaseUnderBalanceLock({
      id: reservation.id,
      // The version this transaction read, under that lock. A competing release matched first
      // means no row matches here, and the conflict propagates rather than being swallowed.
      expectedVersion: reservation.version,
    });

    releasedReservationIds.push(released.id);
    releasedQuantity = add(releasedQuantity, parseDecimal(released.quantity, QUANTITY_SCALE));
  }

  // ---- Step 5: write the status. -------------------------------------------------------
  //
  // Guarded by the version read in step one and by the status it was read in, per section 10.1.
  // Two cancellations that both passed the transition check resolve here, and the second finds
  // no row and is told the order moved under it.
  //
  // The number is carried through unchanged, which is what makes a cancelled draft stay
  // unnumbered and a cancelled confirmed order keep what it was issued.
  const cancelled = await repositories.salesOrders.applyTransition({
    id: order.id,
    expectedVersion: order.version,
    expectedStatus: order.status,
    status: 'cancelled',
    docNumber: order.docNumber,
  });

  // ---- Step 6: write the audit record. -------------------------------------------------
  //
  // Same transaction as the change it describes, actor from the session, per section 7.1. The
  // reason lives here and only here, alongside the structured before and after of section 7.2.
  await repositories.audit.append({
    action: 'sales_order_cancelled',
    entityType: 'sales_order',
    entityId: order.id,
    summary: summaryFor(cancelled),
    changes: {
      status: { from: order.status, to: 'cancelled' },
      releasedReservations: releasedReservationIds.length,
      releasedQuantity: toFixed(releasedQuantity, QUANTITY_SCALE),
      // Omitted rather than recorded as null when nobody gave one, so a reader can tell "no
      // reason offered" from "a reason that happened to be empty". Whitespace alone is nobody
      // giving one, which is why this reads the trimmed value.
      ...(reason ? { reason } : {}),
    },
  });

  // ---- Step 7 is the caller's commit. --------------------------------------------------
  return {
    order: cancelled,
    releasedReservationIds,
    releasedQuantity: toFixed(releasedQuantity, QUANTITY_SCALE),
  };
}

/**
 * What the trail says happened.
 *
 * Named by document number where there is one. A cancelled draft has none, so it is described
 * rather than given an identifier no human recognises.
 */
function summaryFor(order: SalesOrderRecord): string {
  return order.docNumber
    ? `Cancelled sales order ${order.docNumber}`
    : 'Cancelled a draft sales order';
}
