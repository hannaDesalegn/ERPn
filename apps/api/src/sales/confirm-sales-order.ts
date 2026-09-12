/**
 * Confirming a sales order.
 *
 * Section 12.2's irreversible moment, and the first operation in this system that is entirely
 * composition. Every mechanism it uses was built and proved on its own: the transition table, the
 * grants read, the reservation under its balance row lock, the gapless allocator, the audit
 * append. Nothing is reimplemented here, and that is the point of the increment.
 *
 * THE SIX STEPS, IN THE ORDER SECTION 12.2 GIVES THEM:
 *
 *   1. validate against current master data and current state   the transition table
 *   2. authorize, including row scope and policy rules          grantsIn, plus a scoped read
 *   3. apply the side effects                                   reserveForOrderLine per line
 *   4. allocate the document number                             allocateSalesOrderNumber
 *   5. write the audit record                                   repositories.audit.append
 *   6. commit                                                   the caller's unit of work
 *
 * The status write sits between four and five, because the schema will not take a status without
 * a number: migration 0005 checks that a draft has no document number and that anything else has
 * one. Section 12.2 does not number that write separately, and this is the only position in the
 * sequence where both halves of it are known.
 *
 * ONE TRANSACTION, AND IT IS THE CALLER'S. This takes repositories rather than a unit of work, as
 * the allocator and the reservation do, so every step runs inside a transaction already open. A
 * function that opened its own would make "all of the following in one transaction, or none of
 * it" a promise nobody could keep: a reservation would commit while the numbering that followed
 * it failed. Section 12.2 is explicit that there is no partial post.
 *
 * THERE IS NO ACTOR PARAMETER. The acting user is already in the scope the caller's unit of work
 * opened, which is where the audit repository reads it from and where row level security got it.
 * Taking it again here would be a second source of truth for who is acting, and the two could
 * disagree.
 *
 * WHERE THE WORK IS UNDONE. Nothing here compensates for anything. A failure at any step throws,
 * the transaction rolls back, and the reservations, the counter increment, the status and the
 * audit row all disappear together because they were never committed. That is why the number is
 * not consumed by a failed confirmation, and it is the whole reason section 10.4 insists on a
 * locked counter row rather than a database sequence.
 */

import type { CompanyContext } from '../identity/identity.service.js';
import { grantsIn } from '../authorization/authorization.service.js';
import type { ScopedRepositories, SalesOrderRecord } from '../database/index.js';
import { reserveForOrderLine } from '../inventory/reservations.js';
import { allocateSalesOrderNumber } from './document-numbers.js';
import { assertTransition, statusOf } from './sales-order-status.js';

/** The repositories this needs from a transaction already in progress. */
export type ConfirmationRepositories = Pick<
  ScopedRepositories,
  | 'salesOrders'
  | 'salesOrderLines'
  | 'stockLedger'
  | 'stockReservations'
  | 'documentNumberSequences'
  | 'roles'
  | 'audit'
>;

/**
 * What a caller may say.
 *
 * An identifier and nothing else. Everything that decides the outcome is read from the database
 * under the acting scope: the order, its lines, the products and warehouses they name, the stock,
 * and what the actor is permitted to do. Section 3.3 keeps all of it server side, and there is no
 * field here through which any of it could be supplied.
 */
export interface ConfirmationRequest {
  salesOrderId: string;
}

/**
 * Why a confirmation was refused.
 *
 * `not_found` covers an order that is missing, in another company or in another tenant. Section
 * 6.1 makes those one answer so that identifiers cannot be probed to learn what another company
 * holds. `forbidden` is separate because the actor has already proved membership of this company.
 */
export type ConfirmationRefusal = 'not_found' | 'forbidden' | 'no_lines' | 'illegal_transition';

export class SalesOrderConfirmationError extends Error {
  readonly reason: ConfirmationRefusal;

  constructor(reason: ConfirmationRefusal, message: string) {
    super(message);
    this.name = 'SalesOrderConfirmationError';
    this.reason = reason;
  }
}

export interface ConfirmedSalesOrder {
  order: SalesOrderRecord;
  /** One reservation per line, in line order. */
  reservationIds: string[];
}

/** The capability section 6.2 requires for this operation, from the existing catalogue. */
const REQUIRED_PERMISSION = 'sales:confirm';

export async function confirmSalesOrder(
  repositories: ConfirmationRepositories,
  context: CompanyContext,
  request: ConfirmationRequest,
): Promise<ConfirmedSalesOrder> {
  // ---- Step 1: validate against current state. -----------------------------------------
  //
  // Scoped, so an order in another company is not found rather than refused, per section 6.1.
  // This read is also where the version the transition is guarded by comes from.
  const order = await repositories.salesOrders.findById(request.salesOrderId);
  if (!order) {
    throw new SalesOrderConfirmationError('not_found', 'Sales order not found');
  }

  // Section 12.1's table decides, not a status compared in place here. A second confirmation of
  // an already confirmed order fails on this line, which is the domain guard section 11 says must
  // exist independently of any idempotency record.
  assertTransition(statusOf(order.status), 'confirmed');

  const lines = await repositories.salesOrderLines.listForOrder(order.id);
  if (lines.length === 0) {
    // Nothing to reserve and nothing to owe. An order promising nothing should never have been
    // written, but confirming one would produce a numbered document with no content.
    throw new SalesOrderConfirmationError('no_lines', 'A sales order needs at least one line');
  }

  // ---- Step 2: authorize. --------------------------------------------------------------
  //
  // The operation dimension of section 6.1, read inside this transaction rather than before it.
  // The tenant and company dimensions were enforced by the scoped read above: an order belonging
  // to another company never reached this line. The membership is the session's, never the
  // request's.
  const grants = await grantsIn(repositories, context.membershipId);
  if (!grants.permissions.includes(REQUIRED_PERMISSION)) {
    throw new SalesOrderConfirmationError(
      'forbidden',
      'Confirming a sales order needs the sales:confirm capability in this company',
    );
  }

  // ---- Step 3: apply the side effects. -------------------------------------------------
  //
  // One reservation per line, each taking its own balance row lock and refusing an oversell
  // inside this transaction per section 8.5. Sequential rather than parallel, which is what
  // section 10.2's documented lock order asks for: locks are acquired in line order, the same
  // order for every transaction confirming any order, so two confirmations competing for the
  // same two products queue rather than deadlock.
  //
  // A line that cannot be reserved throws, and the lines already reserved go with it. Section
  // 12.2 permits no partial post, and this is where that is most easily gotten wrong.
  const reservationIds: string[] = [];
  for (const line of lines) {
    const reservation = await reserveForOrderLine(repositories, {
      salesOrderLineId: line.id,
      // From the persisted line, never from the request. The request has no quantity field.
      quantity: line.quantity,
    });
    reservationIds.push(reservation.id);
  }

  // ---- Step 4: allocate the document number. -------------------------------------------
  //
  // Gapless, from the counter row locked inside this transaction. A rollback after this point
  // leaves the number unissued rather than skipped, which is the property section 10.4 accepts
  // the serialisation cost for.
  const allocated = await allocateSalesOrderNumber(repositories);

  // The status and the number together, guarded by the version read in step one. Two
  // confirmations that both passed the transition check resolve here: the second matches no row
  // and is told the order moved under it, rather than issuing a second number for one document.
  const confirmed = await repositories.salesOrders.applyTransition({
    id: order.id,
    expectedVersion: order.version,
    expectedStatus: order.status,
    status: 'confirmed',
    docNumber: allocated.formatted,
  });

  // ---- Step 5: write the audit record. -------------------------------------------------
  //
  // Same transaction as the change it describes, with the actor from the session, per section
  // 7.1. A failure here takes the confirmation with it, which is the point of it being here
  // rather than after the commit.
  await repositories.audit.append({
    action: 'sales_order_confirmed',
    entityType: 'sales_order',
    entityId: order.id,
    summary: `Confirmed sales order ${allocated.formatted}`,
    changes: {
      status: { from: order.status, to: 'confirmed' },
      docNumber: allocated.formatted,
      reservations: reservationIds.length,
    },
  });

  // ---- Step 6 is the caller's commit. --------------------------------------------------
  return { order: confirmed, reservationIds };
}
