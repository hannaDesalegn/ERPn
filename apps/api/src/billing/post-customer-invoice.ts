/**
 * Posting a customer invoice.
 *
 * Section 12.2's irreversible moment for the second document in this system, and section 17.5's
 * slice 3: one atomic transaction writing the status change, the journal entry and its lines, the
 * audit record and the document number. Like confirmation, it is composition: the transition
 * table, the grants read, the gapless allocator, the journal repository and the audit append were
 * each built and proved on their own, and none of them is reimplemented here.
 *
 * THE SIX STEPS, IN THE ORDER SECTION 12.2 GIVES THEM:
 *
 *   1. validate against current master data and current state   the transition table, then a
 *                                                               re-read of the orders, the
 *                                                               customer and the tax rate
 *   2. authorize, including row scope and policy rules          grantsIn, plus a scoped read
 *   3. apply the side effects                                   consume the invoiced quantity,
 *                                                               then write the journal entry
 *   4. allocate the document number                             allocateCustomerInvoiceNumber
 *   5. write the audit record                                   repositories.audit.append
 *   6. commit                                                   the caller's unit of work
 *
 * WHAT IT DOES NOT WRITE, and this is a ruling rather than an omission. Section 18.2 on
 * 2026-09-15: the first customer invoice posting writes accounts receivable, revenue and tax and
 * nothing else. No stock movement, no balance change, no released reservation, no cost of goods
 * sold, no delivery interim entry, no delivered quantity. An invoice may be posted before a
 * delivery exists, and an invoiced but undelivered order keeps its reservation because only
 * delivery or cancellation releases one. A reader looking for the inventory half of this
 * transaction should find nothing, and that is the correct state of the code.
 *
 * THE ORDER OF THE SIDE EFFECTS IS A LOCK ORDER. Quantities are consumed first, over the sales
 * order lines in the canonical order `inventory/lock-order.ts` states; the number counter is
 * locked last, as it is in confirmation. Every transaction in the system therefore takes the
 * counter after whatever else it locks, which is what stops a posting and a confirmation from
 * holding one another's rows. Section 10.2 requires the order documented and followed.
 *
 * ONE TRANSACTION, AND IT IS THE CALLER'S. This takes repositories rather than a unit of work, so
 * the idempotency claim of section 11 and every write below commit together or not at all. A
 * failure anywhere throws, and the consumed quantity, the issued number, the journal entry, the
 * status and the audit row disappear together because none of them was ever committed. That is
 * why a failed posting spends no number.
 *
 * THERE IS NO ACTOR PARAMETER. The acting user is in the scope the caller's unit of work opened,
 * which is where the audit repository reads it and where row level security got it. Taking it
 * again here would be a second source of truth for who is acting.
 */

import { randomUUID } from 'node:crypto';

import { grantsIn } from '../authorization/authorization.service.js';
import type {
  CustomerInvoiceRecord,
  NewJournalLine,
  RecordedJournalEntry,
  SalesOrderLineRecord,
  SalesOrderRecord,
  ScopedRepositories,
} from '../database/index.js';
import type { CompanyContext } from '../identity/identity.service.js';
import { inSalesOrderLineLockOrder } from '../inventory/lock-order.js';
import { allocateCustomerInvoiceNumber } from '../sales/document-numbers.js';
import { statusOf as salesOrderStatusOf } from '../sales/sales-order-status.js';
import { compare, parseDecimal, toFixed } from '../shared/decimal.js';
import { resolveTaxRate } from '../tax/tax-rate.js';
import { assertTransition, statusOf } from './customer-invoice-status.js';
import { INVOICEABLE_SALES_ORDER_STATUSES } from './customer-invoice.service.js';
import { AMOUNT_SCALE, billedAmounts, documentTotals, RATE_SCALE } from './invoice-arithmetic.js';

/** The repositories this needs from a transaction already in progress. */
export type PostingRepositories = Pick<
  ScopedRepositories,
  | 'companies'
  | 'customers'
  | 'customerInvoices'
  | 'customerInvoiceLines'
  | 'salesOrders'
  | 'salesOrderLines'
  | 'postingAccounts'
  | 'journal'
  | 'documentNumberSequences'
  | 'roles'
  | 'audit'
>;

/**
 * What a caller may say.
 *
 * An identifier and nothing else, in the shape confirmation established. Everything that decides
 * the outcome is read from the database under the acting scope: the invoice, its lines, the
 * orders behind them, the accounts the company configured, the tax rate and what the actor may
 * do. There is no number, no total, no date and no account here, so section 3.3's guarantee is
 * that they are unrepresentable rather than ignored.
 */
export interface PostingRequest {
  customerInvoiceId: string;
}

/**
 * Why a posting was refused.
 *
 * `not_found` covers an invoice that is missing, in another company or in another tenant, per
 * section 6.1, so an identifier cannot be probed. `forbidden` is separate because the actor has
 * already proved membership of this company.
 */
export type PostingRefusal =
  | 'not_found'
  | 'forbidden'
  | 'no_lines'
  | 'illegal_transition'
  /** A source order is no longer in a state that may be billed. */
  | 'order_not_invoiceable'
  /** A record the invoice names has been archived since the draft was raised. Section 12.2. */
  | 'master_data_unusable'
  /** Another invoice consumed the remainder first. The authoritative concurrency answer. */
  | 'quantity_exceeded'
  /** The stored figures no longer follow from the line's own inputs. */
  | 'incoherent_document'
  /** The company standard rate moved after the draft was raised. Section 2.9. */
  | 'tax_rate_changed'
  /** The company has no account configured for one of the three purposes. */
  | 'posting_accounts_missing'
  /** The invoice comes to nothing, so there is no entry to post. */
  | 'nothing_to_post';

export class CustomerInvoicePostingError extends Error {
  readonly reason: PostingRefusal;
  readonly subject: string | undefined;

  constructor(reason: PostingRefusal, message: string, subject?: string) {
    super(message);
    this.name = 'CustomerInvoicePostingError';
    this.reason = reason;
    this.subject = subject;
  }
}

export interface PostedCustomerInvoice {
  invoice: CustomerInvoiceRecord;
  /** The balanced entry this posting wrote, as the ledger now holds it. */
  journalEntry: RecordedJournalEntry;
  /**
   * The source lines whose invoiced quantity was consumed, in the order the locks were taken.
   *
   * Lock order rather than line order, and returned rather than implied: it is what makes the
   * acquisition sequence observable from outside, which is what the regression test reads.
   */
  consumedLines: SalesOrderLineRecord[];
}

/** The capability section 6.2 requires for this operation, from the existing catalogue. */
const REQUIRED_PERMISSION = 'invoices:post';

/** The three purposes section 18.2 rules this posting writes, and no fourth. */
const RECEIVABLE = 'accounts_receivable';
const REVENUE = 'sales_revenue';
const TAX = 'tax_payable';

export async function postCustomerInvoice(
  repositories: PostingRepositories,
  context: CompanyContext,
  request: PostingRequest,
): Promise<PostedCustomerInvoice> {
  // ---- Step 1: validate against current state. -----------------------------------------
  //
  // Scoped, so an invoice in another company is not found rather than refused, per section 6.1.
  // This read is also where the version the transition is guarded by comes from.
  const invoice = await repositories.customerInvoices.findById(request.customerInvoiceId);
  if (!invoice) {
    throw new CustomerInvoicePostingError('not_found', 'Customer invoice not found');
  }

  // Section 12.1's table decides, not a status compared in place here. A second posting of an
  // already posted invoice fails on this line, which is the domain guard section 11 requires to
  // exist independently of any idempotency record.
  assertTransition(statusOf(invoice.status), 'posted');

  const lines = await repositories.customerInvoiceLines.listForInvoice(invoice.id);
  if (lines.length === 0) {
    // Nothing owed and nothing to post. A demand for payment of nothing should never have been
    // written, and posting one would produce a numbered document with no content and an entry
    // with no lines, which the balance trigger would refuse anyway.
    throw new CustomerInvoicePostingError('no_lines', 'A customer invoice needs at least one line');
  }

  const company = await repositories.companies.findById(context.companyId);
  if (!company) {
    // Unreachable through a real session, which resolved this company from a membership moments
    // ago. Loud rather than silent, because the alternative is a null tax rate.
    throw new Error('The acting company disappeared inside its own transaction');
  }

  // ---- Still step 1: validate against current master data. ------------------------------
  //
  // The half a draft cannot do on its own. Draft creation checked all of this when the invoice
  // was raised; a draft can sit for weeks, and archiving is how a record stops being usable while
  // staying referenced by the history that names it. Posting is the moment the business commits.
  //
  // Sequential, because a unit of work is one connection and parallel reads pipeline onto it.
  const customer = await repositories.customers.findById(invoice.customerId);
  if (!customer || customer.status !== 'active') {
    throw new CustomerInvoicePostingError(
      'master_data_unusable',
      'The customer on this invoice is no longer active',
    );
  }

  // Every source order, re-read now rather than trusted from when the draft was raised. An order
  // cancelled in the meantime cannot be billed, and section 18.2 keeps the invoiceable set to
  // confirmed orders for the reasons the draft operation states.
  const orders = new Map<string, SalesOrderRecord>();
  for (const orderId of [...new Set(lines.map((line) => line.sourceSalesOrderId))]) {
    const order = await repositories.salesOrders.findById(orderId);
    if (!order) {
      throw new CustomerInvoicePostingError('not_found', 'Sales order not found', orderId);
    }

    const status = salesOrderStatusOf(order.status);
    if (!(INVOICEABLE_SALES_ORDER_STATUSES as readonly string[]).includes(status)) {
      throw new CustomerInvoicePostingError(
        'order_not_invoiceable',
        `A ${status} sales order cannot be invoiced. Only a confirmed one can.`,
        orderId,
      );
    }

    orders.set(orderId, order);
  }

  // ---- Still step 1: the document has to follow from its own inputs. ---------------------
  //
  // WHAT IS RE-READ AND WHAT IS NOT. The unit price and the discount are the commercial terms the
  // customer agreed to, snapshotted from the order line when the draft was raised, and section
  // 18.2 on 2026-09-16 rules that posting does not replace them with today's catalogue. The tax
  // rate is the exception section 2.9 names: it goes through one resolver, and the rate on a
  // draft is a working figure the committing transaction recomputes.
  //
  // A RATE THAT MOVED IS A REFUSAL, NOT A REWRITE. If the company's standard rate changed after
  // the draft was raised, the figures on the document no longer follow from the current rule, and
  // there are two ways to honour 2.9: refuse, or rewrite the amounts while posting. Rewriting
  // would post a total nobody approved, on a document whose whole purpose is to be the demand a
  // person signed off. So it is refused, and the caller re-reads the draft, which re-derives every
  // line at the new rate, and posts that.
  const currentRate = parseDecimal(resolveTaxRate(company), RATE_SCALE);

  for (const line of lines) {
    const storedRate = parseDecimal(line.taxRatePercent, RATE_SCALE);
    if (compare(storedRate, currentRate) !== 0) {
      throw new CustomerInvoicePostingError(
        'tax_rate_changed',
        `This invoice was raised at ${line.taxRatePercent} per cent tax and the company now charges ${toFixed(currentRate, RATE_SCALE)}. Re-read the draft and post it again.`,
        line.id,
      );
    }

    // And the stored money still follows from the stored inputs, computed by the one function
    // that raised them. This is what makes "the journal equals the invoice" a fact about the
    // document rather than about this function's arithmetic.
    const recomputed = billedAmounts({
      quantity: parseDecimal(line.quantity, RATE_SCALE),
      unitPrice: parseDecimal(line.unitPrice, RATE_SCALE),
      discountPercent: parseDecimal(line.discountPercent, RATE_SCALE),
      taxRatePercent: storedRate,
    });

    if (
      recomputed.lineSubtotal !== line.lineSubtotal ||
      recomputed.lineTax !== line.lineTax ||
      recomputed.lineTotal !== line.lineTotal
    ) {
      throw new CustomerInvoicePostingError(
        'incoherent_document',
        `Line ${line.lineNumber} does not add up from its own quantity, price and rate`,
        line.id,
      );
    }
  }

  // The header has to agree with its lines as well. A document whose total is not the sum of what
  // it bills would post a journal entry that balances against the wrong figure.
  const totals = documentTotals(lines);
  if (
    totals.subtotal !== invoice.subtotal ||
    totals.taxTotal !== invoice.taxTotal ||
    totals.total !== invoice.total
  ) {
    throw new CustomerInvoicePostingError(
      'incoherent_document',
      'The invoice totals are not the sum of its lines',
    );
  }

  // AN INVOICE THAT COMES TO NOTHING POSTS NOTHING, and it is refused here rather than at the
  // database. A line may carry a hundred per cent discount, which the constraint permits and a
  // salesperson means, so a document whose every line is free is raisable and its total is zero.
  // The entry for it would have to debit nothing and credit nothing, and migration 0014 refuses a
  // line with no amount on either side. Answering with the rule rather than with a constraint
  // violation is the difference between a caller who knows what to do and one who files a bug.
  //
  // Found by the generated cases in `invoice-posting-invariant.int.spec.ts`, which is the kind of
  // edge an example nobody thought to write does not reach.
  if (compare(parseDecimal(invoice.total, AMOUNT_SCALE), parseDecimal('0', AMOUNT_SCALE)) <= 0) {
    throw new CustomerInvoicePostingError(
      'nothing_to_post',
      'This invoice comes to nothing, so there is no entry to post',
    );
  }

  // ---- Step 2: authorize. --------------------------------------------------------------
  //
  // The operation dimension of section 6.1, read inside this transaction rather than before it.
  // The tenant and company dimensions were enforced by the scoped read above: an invoice
  // belonging to another company never reached this line. The membership is the session's.
  const grants = await grantsIn(repositories, context.membershipId);
  if (!grants.permissions.includes(REQUIRED_PERMISSION)) {
    throw new CustomerInvoicePostingError(
      'forbidden',
      'Posting a customer invoice needs the invoices:post capability in this company',
    );
  }

  // The accounts this company configured, resolved by purpose rather than named here. Section 2.9
  // holds the mapping per company, and an account identifier written into this file would be one
  // company's chart imposed on every other.
  const receivable = await accountFor(repositories, RECEIVABLE);
  const revenue = await accountFor(repositories, REVENUE);
  const tax = await accountFor(repositories, TAX);

  // ---- Step 3: apply the side effects. -------------------------------------------------
  //
  // THE QUANTITY FIRST, AND THIS IS THE AUTHORITATIVE CONCURRENCY POINT. Section 18.2 on
  // 2026-09-16: a draft claims nothing, so two drafts may describe the same remainder and posting
  // is where it is validated and consumed. The remainder is tested inside the statement that
  // consumes it, so two postings racing for one remainder resolve to one winner and one refusal,
  // and neither can read a figure that another transaction is about to change.
  //
  // IN CANONICAL LOCK ORDER, per section 10.2 and `inventory/lock-order.ts`. An invoice bills
  // lines of several orders, so line numbers say nothing about sequence across two documents;
  // sorting by the identifier gives every transaction in the system the same order over the same
  // rows. Two postings sharing two lines therefore cannot hold one another's.
  const consumedLines: SalesOrderLineRecord[] = [];
  for (const line of inSalesOrderLineLockOrder(
    lines.map((line) => ({ id: line.sourceSalesOrderLineId, quantity: line.quantity })),
  )) {
    const consumed = await repositories.salesOrderLines.consumeInvoicedQuantity({
      id: line.id,
      // From the persisted invoice line, never from the request, which has no quantity field.
      quantity: line.quantity,
    });

    if (!consumed) {
      // Either another posting took the remainder first, or the line is not in this company. The
      // second is unreachable here, because the composite key in 0015 pins every invoice line to
      // a source line of its own company, so this says what the caller can act on.
      throw new CustomerInvoicePostingError(
        'quantity_exceeded',
        'That sales order line no longer has enough left to invoice',
        line.id,
      );
    }

    consumedLines.push(consumed);
  }

  // ---- Step 4: allocate the document number. -------------------------------------------
  //
  // After the quantities, so the counter row is the last lock this transaction takes, exactly as
  // it is the last lock a confirmation takes. Gapless, from the counter locked inside this
  // transaction: a rollback after this point leaves the number unissued rather than skipped.
  const allocated = await allocateCustomerInvoiceNumber(repositories);

  // ---- Still step 3: the entry section 17.5 asks for. ----------------------------------
  //
  // Receivables debited for the gross, revenue credited for the net, tax credited for the
  // difference. The three figures are the invoice's own totals, so the entry equals the document
  // by construction rather than by a second calculation.
  //
  // A ZERO TAX LINE IS OMITTED, NOT WRITTEN AS ZERO. Migration 0014 refuses a line with nothing on
  // either side, and a company that charges no tax has nothing to credit: two lines are the whole
  // of that entry and it balances.
  const journalLines: NewJournalLine[] = [
    { accountId: receivable, debit: invoice.total },
    { accountId: revenue, credit: invoice.subtotal },
  ];
  if (compare(parseDecimal(invoice.taxTotal, AMOUNT_SCALE), parseDecimal('0', AMOUNT_SCALE)) > 0) {
    journalLines.push({ accountId: tax, credit: invoice.taxTotal });
  }

  const journalEntry = await repositories.journal.record({
    id: randomUUID(),
    entryDate: invoice.invoiceDate,
    memo: `Customer invoice ${allocated.formatted}`,
    currency: invoice.currency,
    // Section 12.4: the edge is stored once, on the entry, which is what makes the posting
    // explainable from the ledger side without a second table claiming the same fact.
    sourceDocType: 'customer_invoice',
    sourceDocId: invoice.id,
    lines: journalLines,
  });

  // The status and the number together, guarded by the version read in step one. Two postings
  // that both passed the transition check resolve here: the second matches no row and is told the
  // invoice moved under it, rather than issuing a second number for one document.
  const posted = await repositories.customerInvoices.applyTransition({
    id: invoice.id,
    expectedVersion: invoice.version,
    expectedStatus: invoice.status,
    status: 'posted',
    docNumber: allocated.formatted,
  });

  // ---- Step 5: write the audit record. -------------------------------------------------
  //
  // Same transaction as the change it describes, with the actor from the session, per section
  // 7.1. A failure here takes the posting with it, which is the point of it being here rather
  // than after the commit.
  await repositories.audit.append({
    // Section 7.3: the roles as they were, not looked up later. The same grants step two
    // authorized against, so the record says what was true when the decision was made.
    actorRoles: grants.roles.map((role) => role.key),
    // Framework supplied, never client supplied.
    requestId: context.requestId ?? null,
    action: 'customer_invoice_posted',
    entityType: 'customer_invoice',
    entityId: invoice.id,
    summary: `Posted customer invoice ${allocated.formatted} for ${invoice.total} ${invoice.currency}`,
    changes: {
      status: { from: invoice.status, to: 'posted' },
      docNumber: allocated.formatted,
      total: invoice.total,
      currency: invoice.currency,
      journalEntryId: journalEntry.entry.id,
      salesOrders: [...orders.keys()],
    },
  });

  // ---- Step 6 is the caller's commit. --------------------------------------------------
  return { invoice: posted, journalEntry, consumedLines };
}

/**
 * The account this company posts a purpose to.
 *
 * Refused rather than defaulted when it is missing. A company is provisioned with all three, so
 * an absent one means somebody removed a mapping, and picking an account on their behalf would
 * put a real amount in a place nobody chose.
 */
async function accountFor(
  repositories: Pick<PostingRepositories, 'postingAccounts'>,
  purpose: string,
): Promise<string> {
  const mapping = await repositories.postingAccounts.findForPurpose(purpose);
  if (!mapping) {
    throw new CustomerInvoicePostingError(
      'posting_accounts_missing',
      `This company has no account configured for ${purpose}`,
      purpose,
    );
  }

  return mapping.accountId;
}
