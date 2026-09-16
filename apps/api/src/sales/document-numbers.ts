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
 * NOT A FRAMEWORK. The customer invoice is the second document type here and it is written out
 * in full beside the first, rather than folded into a loop over a table of types. Purchase
 * orders and deliveries will each add their own when they arrive. The `doc_type` column already
 * carries the dimension, so what a new document needs is a constant, not an abstraction: the two
 * types differ in prefix and will differ in who allocates from them, and a shared helper would
 * have to grow a parameter for each difference.
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

/** The `doc_type` a customer invoice sequence is configured under. */
export const CUSTOMER_INVOICE_DOC_TYPE = 'customer_invoice';

/**
 * What a new company's customer invoice numbering starts as.
 *
 * Gapless, and here the setting is the reason section 10.4 gives for the whole mechanism rather
 * than a cautious default: open question 4 assumes at least one jurisdiction this product serves
 * requires an unbroken invoice series, and an invoice number is the one a tax authority reads.
 *
 * A SEPARATE COUNTER FROM THE SALES ORDER, deliberately. Section 10.4 makes a sequence per
 * company and per document type, and an invoice raised from two orders, or from none, has no
 * order number to borrow. Sharing one counter would also mean a rolled back order confirmation
 * left a hole in the invoice series, which is exactly what gapless forbids.
 */
export const CUSTOMER_INVOICE_SEQUENCE_DEFAULTS = {
  prefix: 'INV-',
  gapless: true,
} as const;

/**
 * Gives a company the customer invoice sequence that invoice posting will require.
 *
 * Provisioned now, with the rest of the company's configuration, and not by the increment that
 * first posts an invoice. The reason is the one stated above `provisionSalesOrderSequence`:
 * allocation deliberately refuses to invent a missing sequence, because a counter created on
 * demand issues number one to a company that has been trading for a year. Numbering a document
 * type is company configuration under section 2.9, and a company is configured when it is
 * created.
 *
 * Allocation arrives below, with the posting transaction that can call it from inside itself,
 * which is the property that makes an allocation safe.
 */
export async function provisionCustomerInvoiceSequence(
  repositories: Pick<ScopedRepositories, 'documentNumberSequences'>,
): Promise<DocumentNumberSequenceRecord> {
  const existing = await repositories.documentNumberSequences.findForDocType(
    CUSTOMER_INVOICE_DOC_TYPE,
  );
  if (existing) return existing;

  return repositories.documentNumberSequences.create({
    id: randomUUID(),
    docType: CUSTOMER_INVOICE_DOC_TYPE,
    ...CUSTOMER_INVOICE_SEQUENCE_DEFAULTS,
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

/**
 * Takes the next customer invoice number, inside the caller's transaction.
 *
 * The same allocator the sales order uses, against the counter the company was provisioned with,
 * and it is the only path to an invoice number: there is no second mechanism and no way for a
 * caller to supply one, because the posting request has no field for it and the schema refuses a
 * numbered draft outright.
 *
 * Rolls back with the transaction, so a posting that fails after this call leaves the number
 * unissued rather than skipped. That is what gapless means in section 10.4, and it is the reason
 * the counter is a locked row rather than a database sequence: a sequence would have committed
 * its increment independently and left a hole in the series a tax authority reads.
 */
export async function allocateCustomerInvoiceNumber(
  repositories: Pick<ScopedRepositories, 'documentNumberSequences'>,
): Promise<AllocatedDocumentNumber> {
  return repositories.documentNumberSequences.allocate(CUSTOMER_INVOICE_DOC_TYPE);
}
