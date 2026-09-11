/**
 * Where the sales path sets up a document number sequence, and where it asks for a number.
 *
 * Very little code and a boundary. The boundary is the point: `allocate` and `create` on the
 * repository both take a document type as a string, and the string is the only thing standing
 * between a confirmation and a counter that belongs to a different kind of document. Naming it
 * once, here, means a typo is a compile error rather than a second counter quietly starting at
 * one. Provisioning lives beside allocation for that reason: the two must agree on the name, and
 * a company whose sequence was created under a different one has a counter nothing reads.
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

import { randomUUID } from 'node:crypto';

import type {
  AllocatedDocumentNumber,
  DocumentNumberSequenceRecord,
  ScopedRepositories,
} from '../database/index.js';

/** The `doc_type` a sales order sequence is configured under. Matches the schema's format. */
export const SALES_ORDER_DOC_TYPE = 'sales_order';

/**
 * What a new company's sales order numbering starts as.
 *
 * A default, not a rule. Section 2.9 makes the series, the format and the gapless choice company
 * configuration edited through the administration UI, so this is the value a company begins with
 * and later changes, in the same way section 2.7 seeds role templates that the company then owns.
 *
 * Gapless because a sales order becomes an invoice, and the jurisdictions section 10.4 cites
 * require an unbroken invoice series. Starting gap tolerant would make the stricter setting a
 * thing each company has to remember to turn on.
 */
export const SALES_ORDER_SEQUENCE_DEFAULTS = {
  prefix: 'SO-',
  gapless: true,
} as const;

/**
 * Gives a company the sales order sequence that confirmation will later require.
 *
 * Takes repositories rather than a unit of work, for the same reason the allocation below does:
 * this belongs to the transaction that creates the company. Section 12.2 allocates a number
 * inside the confirming transaction, and an allocation cannot invent the sequence it reads, so
 * the row has to be there already or the first confirmation of a company's life fails.
 *
 * IDEMPOTENT, AND THE DATABASE IS WHY. The unique constraint on company and document type is
 * what actually forbids a second counter; this check just turns a repeat call into the answer it
 * should have. Two counters for one document type would issue the same number twice.
 */
export async function provisionSalesOrderSequence(
  repositories: Pick<ScopedRepositories, 'documentNumberSequences'>,
): Promise<DocumentNumberSequenceRecord> {
  const existing = await repositories.documentNumberSequences.findForDocType(SALES_ORDER_DOC_TYPE);
  if (existing) return existing;

  return repositories.documentNumberSequences.create({
    id: randomUUID(),
    docType: SALES_ORDER_DOC_TYPE,
    ...SALES_ORDER_SEQUENCE_DEFAULTS,
  });
}

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
