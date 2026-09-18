/**
 * What states a customer invoice can be in, and which moves between them are legal.
 *
 * Architecture section 12.1 requires the legal transitions to be declared in an explicit transition
 * table, enforced server side, with an illegal transition answering a domain error that names the
 * current state and the attempted one rather than a generic failure. This file is that table for
 * the invoice, in the shape `sales/sales-order-status.ts` already established for the order.
 *
 * NO TRANSITION IS PERFORMED HERE. This decides legality and nothing else. Writing the status,
 * allocating the number, posting the journal entry and recording the audit are the posting
 * transaction's work (`post-customer-invoice.ts`), and section 12.2 requires it to do all of them
 * or none.
 *
 * WHY THE UNION IS TWO VALUES. The domain model in `apps/web/src/domain/billing.ts` lists
 * `partially_paid`, `paid` and `overdue` beside `draft` and `posted`. All three are conclusions
 * rather than states somebody moves a document into: paid follows from the payment allocations
 * against the invoice, overdue follows from the due date and the clock. Section 9.2 refuses a
 * stored balance treated as a source of truth, and a status column holding the same conclusion is
 * that column under another name. Whether those become statuses at all is the payments module's
 * decision, and it can make it when it has the allocations to derive them from.
 *
 * WHY `cancelled` IS NOT HERE EITHER, and it is a different reason. Section 12.3 requires a
 * cancellation rule per document type, and no rule exists for the invoice: a posted invoice is
 * corrected by a credit note, which is a new document, and abandoning a draft is not specified.
 * Admitting the value without a rule would put an unspecified behaviour in the schema, where it is
 * hardest to revisit.
 *
 * DENY BY DEFAULT. A pair that is not listed is illegal, in the same posture section 6.2 takes for
 * authorization. Forgetting to add one leaves the move refused rather than silently permitted.
 */

/**
 * Every state a customer invoice can hold.
 *
 * Kept in step with the check constraint in migration 0015 by a test that reads the constraint out
 * of the catalogue rather than by anyone remembering. The database is the authority for what may
 * be stored; this is the authority for what the code may reason about.
 */
export const CUSTOMER_INVOICE_STATUSES = ['draft', 'posted'] as const;

export type CustomerInvoiceStatus = (typeof CUSTOMER_INVOICE_STATUSES)[number];

/**
 * The transition table.
 *
 * Every state names the states it may move to. An empty list is a real answer: section 12.3 makes
 * a posted document immutable and corrects it with a new one, so a posted invoice moves nowhere
 * through any operation this system performs. A credit note is a document, not a status.
 */
export const CUSTOMER_INVOICE_TRANSITIONS: Readonly<
  Record<CustomerInvoiceStatus, readonly CustomerInvoiceStatus[]>
> = {
  // Performed by the posting transaction in `post-customer-invoice.ts`.
  draft: ['posted'],
  // Refused on purpose, not omitted. Correction is a credit note, per section 12.3.
  posted: [],
};

/**
 * Thrown when a transition the table does not permit is attempted.
 *
 * Names both states, per section 12.1. A caller told only that something failed cannot tell a
 * stale screen from a genuine rule, and neither can whoever reads the log afterwards.
 */
export class IllegalCustomerInvoiceTransitionError extends Error {
  readonly from: CustomerInvoiceStatus;
  readonly to: CustomerInvoiceStatus;

  constructor(from: CustomerInvoiceStatus, to: CustomerInvoiceStatus) {
    super(`A customer invoice cannot move from ${from} to ${to}`);
    this.name = 'IllegalCustomerInvoiceTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Whether a value stored in the status column is one this code knows how to reason about. */
export function isCustomerInvoiceStatus(value: string): value is CustomerInvoiceStatus {
  return (CUSTOMER_INVOICE_STATUSES as readonly string[]).includes(value);
}

/** Whether the table permits this move. Same state to same state is not a move, and is refused. */
export function canTransition(
  from: CustomerInvoiceStatus,
  to: CustomerInvoiceStatus,
): boolean {
  return CUSTOMER_INVOICE_TRANSITIONS[from].includes(to);
}

/**
 * Refuses an illegal transition, loudly.
 *
 * The shape a caller uses: assert first, then do the work, so an invoice in the wrong state fails
 * before anything has been written rather than leaving the caller to remember the check.
 */
export function assertTransition(
  from: CustomerInvoiceStatus,
  to: CustomerInvoiceStatus,
): void {
  if (!canTransition(from, to)) throw new IllegalCustomerInvoiceTransitionError(from, to);
}

/**
 * Reads a status off a stored row, refusing one the code does not know.
 *
 * A row could only carry an unknown status if a migration widened the check constraint without
 * this file being updated. Refusing is the safe answer: the alternative is code reasoning about a
 * state it has no rules for.
 */
export function statusOf(value: string): CustomerInvoiceStatus {
  if (!isCustomerInvoiceStatus(value)) {
    throw new Error(
      `A customer invoice carries the status ${value}, which this release does not define`,
    );
  }

  return value;
}
