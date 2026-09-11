/**
 * Where the sales path asks for a document number.
 *
 * Three lines of code and a boundary. The boundary is the point: `allocate` on the repository
 * takes a document type as a string, and the string is the only thing standing between a
 * confirmation and a counter that belongs to a different kind of document. Naming it once, here,
 * means a typo is a compile error rather than a second counter quietly starting at one.
 *
 * WHY THIS TAKES REPOSITORIES RATHER THAN A UNIT OF WORK. A function that opened its own
 * transaction would commit the increment on its own, and the number would be spent whether or
 * not the document it was for was ever written. That is precisely the gap section 10.4 forbids.
 * Taking the repositories of a transaction already in progress makes the safe thing the only
 * expressible thing: there is no way to call this except from inside the transaction that is
 * writing the document.
 *
 * WHY THERE IS NO `SalesOrderService.allocateNumber`. It would be exactly the unsafe operation
 * described above, reachable from anywhere, one call away from an HTTP handler. Confirmation
 * will call this from inside its own unit of work, alongside the writes that justify the number.
 *
 * NOT A FRAMEWORK. Purchase orders, invoices and deliveries will each need their own line here
 * when they arrive. The `doc_type` column already carries the dimension, so what they need is a
 * constant, not an abstraction invented in advance of its second caller.
 */

import type { AllocatedDocumentNumber, ScopedRepositories } from '../database/index.js';

/** The `doc_type` a sales order sequence is configured under. Matches the schema's format. */
export const SALES_ORDER_DOC_TYPE = 'sales_order';

/**
 * Takes the next sales order number, inside the caller's transaction.
 *
 * Rolls back with that transaction, so a confirmation that fails after this call leaves the
 * number unissued rather than skipped.
 */
export async function allocateSalesOrderNumber(
  repositories: Pick<ScopedRepositories, 'documentNumberSequences'>,
): Promise<AllocatedDocumentNumber> {
  return repositories.documentNumberSequences.allocate(SALES_ORDER_DOC_TYPE);
}
