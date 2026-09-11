/**
 * What states a sales order can be in, and which moves between them are legal.
 *
 * Contract section 12.1 requires the legal transitions to be declared in an explicit transition
 * table, enforced server side, with an illegal transition answering a domain error that names
 * the current state and the attempted one rather than a generic failure. This file is that
 * table. It is the first thing section 12.2's confirming transaction needs, because step one is
 * validating against current state and there was nothing to validate against.
 *
 * NO TRANSITION IS PERFORMED HERE. This decides legality and nothing else. Writing the status,
 * allocating the number, reserving the stock and recording the audit are the confirming
 * transaction's work, and section 12.2 is emphatic that it does all of them or none.
 *
 * WHY ONLY ONE TRANSITION IS DECLARED. The contract states the states and requires the table,
 * but nowhere states the sales order's own transitions. What it does state is that confirming
 * takes a draft and makes it a commitment, so `draft` to `confirmed` is the one move the
 * contract itself describes. The rest are driven by documents that do not exist yet: an order
 * becomes partially delivered because a delivery was posted against it, invoiced because an
 * invoice was. Declaring those now would be declaring transitions nothing can perform, and
 * guessing at rules the contract has not made.
 *
 * Cancellation is the deliberate omission worth naming. `cancelled` is in the status union and
 * `sales:cancel` is in the permission catalogue, but section 12.3 requires cancellation rules to
 * be explicit per document type, including whether cancelling releases reserved stock, and no
 * such rule has been written for a sales order. Reserved stock does not exist yet either. So
 * cancellation is refused here rather than half specified, and the rule is recorded as an open
 * contract decision instead of invented in a transition table.
 *
 * DENY BY DEFAULT. A pair that is not listed is illegal, in the same posture section 6.2 takes
 * for authorization. Adding a document type later means adding its transitions here, and
 * forgetting to leaves the move refused rather than silently permitted.
 */

/**
 * Every state a sales order can hold.
 *
 * Kept in step with the check constraint in migration 0005 by a test that reads the constraint
 * out of the catalogue rather than by anyone remembering. The database is the authority for what
 * may be stored; this is the authority for what the code may reason about.
 */
export const SALES_ORDER_STATUSES = [
  'draft',
  'confirmed',
  'partially_delivered',
  'delivered',
  'invoiced',
  'cancelled',
] as const;

export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];

/**
 * The transition table.
 *
 * Every state names the states it may move to. An empty list is a real answer: a delivered order
 * has nowhere to go through any operation this system currently performs.
 */
export const SALES_ORDER_TRANSITIONS: Readonly<
  Record<SalesOrderStatus, readonly SalesOrderStatus[]>
> = {
  // Section 12.2's confirming transaction, and the only move the contract describes today.
  draft: ['confirmed'],
  confirmed: [],
  partially_delivered: [],
  delivered: [],
  invoiced: [],
  cancelled: [],
};

/**
 * Thrown when a transition the table does not permit is attempted.
 *
 * Names both states, per section 12.1. A caller that is told only that something failed cannot
 * tell a stale screen from a genuine rule, and neither can whoever reads the log afterwards.
 */
export class IllegalSalesOrderTransitionError extends Error {
  readonly from: SalesOrderStatus;
  readonly to: SalesOrderStatus;

  constructor(from: SalesOrderStatus, to: SalesOrderStatus) {
    super(`A sales order cannot move from ${from} to ${to}`);
    this.name = 'IllegalSalesOrderTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Whether a value stored in the status column is one this code knows how to reason about. */
export function isSalesOrderStatus(value: string): value is SalesOrderStatus {
  return (SALES_ORDER_STATUSES as readonly string[]).includes(value);
}

/** Whether the table permits this move. Same state to same state is not a move, and is refused. */
export function canTransition(from: SalesOrderStatus, to: SalesOrderStatus): boolean {
  return SALES_ORDER_TRANSITIONS[from].includes(to);
}

/**
 * Refuses an illegal transition, loudly.
 *
 * The shape a caller uses: assert first, then do the work, so that an order in the wrong state
 * fails before anything has been written rather than leaving the caller to remember the check.
 */
export function assertTransition(from: SalesOrderStatus, to: SalesOrderStatus): void {
  if (!canTransition(from, to)) throw new IllegalSalesOrderTransitionError(from, to);
}

/**
 * Reads a status off a stored row, refusing one the code does not know.
 *
 * A row could only carry an unknown status if a migration widened the check constraint without
 * this file being updated. Refusing is the safe answer: the alternative is code reasoning about
 * a state it has no rules for.
 */
export function statusOf(value: string): SalesOrderStatus {
  if (!isSalesOrderStatus(value)) {
    throw new Error(`A sales order carries the status ${value}, which this release does not define`);
  }

  return value;
}
