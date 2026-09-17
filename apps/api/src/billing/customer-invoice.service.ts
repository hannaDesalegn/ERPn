/**
 * Creating and editing a customer invoice draft, and reading one.
 *
 * A DRAFT AND NOTHING ELSE. Contract section 12.2 makes posting the irreversible moment that
 * validates, authorizes, applies side effects, allocates a number, writes an audit record and
 * commits, all in one transaction or none of it. None of that is here. Nothing in this file
 * allocates a number, writes a journal entry, moves stock, releases a reservation, touches
 * `invoiced_quantity` or records an audit event, and the two things a reader should check for are
 * that there is no code doing any of it and no method through which a caller could ask.
 *
 * WHAT AN INVOICE IS RAISED FROM. One or more confirmed sales orders. The domain model states the
 * plural in as many words, `salesOrderIds: ID[]`, "Plural: one invoice can cover several orders",
 * and this operation takes the orders as a list for that reason rather than taking one and
 * pretending the rest is a later feature.
 *
 * WHERE EVERY FIGURE COMES FROM, because section 3.3 makes almost none of them the caller's:
 *
 *   customer            the source orders, which must agree about who is being billed
 *   currency            the source orders, which must agree about what was agreed in
 *   product, sku, name  the source order line, which snapshotted them when the order was raised
 *   unit price          the source order line. See the note on `bill` below: what a customer owes
 *                       is what they agreed to, not what the catalogue says today
 *   discount            the source order line, for the same reason
 *   tax rate            `tax/tax-rate.ts`, the one resolver section 2.9 puts every document line
 *                       through
 *   the money columns   computed here from the above
 *   quantity            the caller, bounded by what the source line has left uninvoiced
 *   invoice and due date the caller
 *
 * WHAT A CALLER MAY CHOOSE IS THEREFORE: which orders, which of their lines, how much of each,
 * and the two dates. Everything else is refused by having nowhere to be supplied.
 *
 * ONE TRANSACTION. Every validating read and every write happen inside a single unit of work, so
 * an order confirmed away between the check and the insert cannot produce a half written invoice,
 * and a failure on the fourth line leaves no header behind.
 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { actorScope, UnitOfWork } from '../database/index.js';
import type {
  CustomerInvoiceLineRecord,
  CustomerInvoiceRecord,
  SalesOrderLineRecord,
  SalesOrderRecord,
  ScopedRepositories,
} from '../database/index.js';
import type { CompanyContext } from '../identity/identity.service.js';
import { compare, parseDecimal, subtract, toFixed, zero, type Decimal } from '../shared/decimal.js';
import { billedAmounts, documentTotals, RATE_SCALE } from './invoice-arithmetic.js';
import { resolveTaxRate } from '../tax/tax-rate.js';
import { CUSTOMER_INVOICE_DOC_TYPE } from '../sales/document-numbers.js';
import { statusOf as salesOrderStatusOf } from '../sales/sales-order-status.js';
import { statusOf } from './customer-invoice-status.js';

/**
 * The states a sales order may be invoiced from.
 *
 * `confirmed` and nothing else, and the shortness follows from the transition table rather than
 * from caution. An order becomes `partially_delivered` or `delivered` when a delivery is posted
 * against it, and deliveries do not exist, so those states are unreachable today and admitting
 * them would be a rule written for a document that cannot yet produce one. `draft` is refused
 * because a draft has promised nobody anything, which is section 12.2's whole distinction, and
 * billing for it would be demanding payment for a document the customer never agreed to.
 */
export const INVOICEABLE_SALES_ORDER_STATUSES = ['confirmed'] as const;

/**
 * One line a caller asks to bill.
 *
 * The quantity is optional, and absent means all of what is left. That is not a convenience: the
 * common case is billing an order in full, and requiring the caller to restate a figure the
 * server already holds would be asking for a number the server would then have to refuse to
 * trust.
 */
export interface DraftInvoiceLineInput {
  salesOrderLineId: string;
  /** A decimal string. Defaults to the source line's uninvoiced remainder. */
  quantity?: string;
}

export interface CreateInvoiceDraftInput {
  /** One or more. The plural is the domain model's, not an accommodation. */
  salesOrderIds: string[];
  invoiceDate: string;
  dueDate?: string | null;
  /**
   * Which lines to bill, and how much of each.
   *
   * Absent means every line of every named order that still has something left to invoice, at
   * that remainder. Present means exactly these, and each must belong to one of the named orders.
   */
  lines?: DraftInvoiceLineInput[];
}

/**
 * A draft as it should now be.
 *
 * The same fields creating one accepts, plus the identifier and the version the caller read.
 * Section 10.1 requires that version; everything else a document eventually shows is the server's
 * and has nowhere here to be supplied.
 */
export interface UpdateInvoiceDraftInput extends CreateInvoiceDraftInput {
  customerInvoiceId: string;
  expectedVersion: number;
}

export interface CustomerInvoiceDraft {
  invoice: CustomerInvoiceRecord;
  lines: CustomerInvoiceLineRecord[];
}

/**
 * Why a draft was refused.
 *
 * `not_found` shapes cover a record that is missing, in another company or in another tenant, and
 * they cover them with one value on purpose. Section 6.1: a failure at the tenant or company
 * dimension is indistinguishable from the record not existing, so identifiers cannot be probed to
 * learn what another company holds.
 */
export type InvoiceDraftRejection =
  | 'no_sources'
  | 'order_not_found'
  | 'order_not_invoiceable'
  | 'customer_mismatch'
  | 'currency_mismatch'
  | 'line_not_found'
  | 'line_not_in_sources'
  | 'duplicate_line'
  | 'nothing_to_invoice'
  | 'invalid_quantity'
  | 'quantity_exceeds_remaining'
  | 'invalid_due_date'
  | 'invoice_not_found'
  | 'not_a_draft';

export class CustomerInvoiceDraftError extends Error {
  readonly reason: InvoiceDraftRejection;
  readonly subject: string | undefined;

  constructor(reason: InvoiceDraftRejection, message: string, subject?: string) {
    super(message);
    this.name = 'CustomerInvoiceDraftError';
    this.reason = reason;
    this.subject = subject;
  }
}

/**
 * An invoice as a screen and the future posting transaction need it.
 *
 * `salesOrders` is derived rather than stored: the orders an invoice covers are the distinct
 * orders behind its lines, read back from those lines. Section 12.4 refuses a stored graph for
 * exactly the reason that matters here, that it can drift from the facts it claims to describe.
 */
export interface CustomerInvoiceView {
  id: string;
  /** Null while the invoice is a draft. Allocated by the posting transaction, per section 10.4. */
  docNumber: string | null;
  status: string;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  customer: { id: string; name: string; taxRegistrationNumber: string | null };
  subtotal: string;
  taxTotal: string;
  total: string;
  /** Section 10.1's optimistic locking token, so a later edit can carry what it read. */
  version: number;
  /** The orders this invoice bills, in the plural the domain model requires. */
  salesOrders: { id: string; docNumber: string | null }[];
  lines: CustomerInvoiceLineView[];
}

export interface CustomerInvoiceLineView {
  id: string;
  lineNumber: number;
  sourceSalesOrderId: string;
  sourceSalesOrderLineId: string;
  productId: string;
  productSku: string;
  productName: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxRatePercent: string;
  lineSubtotal: string;
  lineTax: string;
  lineTotal: string;
}

/**
 * One journal entry a posting wrote, as the invoice screen shows it.
 *
 * Decimals as strings, per section 4.3. `recordedAt` is when the row was written; `entryDate` is
 * the accounting date, which is the invoice date.
 */
export interface InvoiceJournalEntryView {
  id: string;
  entryDate: string;
  memo: string;
  currency: string;
  recordedAt: string;
  lines: InvoiceJournalLineView[];
}

export interface InvoiceJournalLineView {
  lineNumber: number;
  account: { id: string; code: string; name: string; type: string };
  /** Exactly one of the two is above zero, which the database enforces. */
  debit: string;
  credit: string;
  currency: string;
}

/** One audit record about an invoice, in the shape the sales order trail answers with. */
export interface InvoiceAuditView {
  id: string;
  occurredAt: string;
  action: string;
  summary: string;
  /** Resolved from the identifier the record stored. Null if the account is gone. */
  actor: { id: string; name: string } | null;
  /** The roles the actor held at the time, per section 7.3. Never looked up now. */
  actorRoles: string[];
}

/** What creating or editing a draft needs from a transaction already in progress. */
export type InvoiceDraftRepositories = Pick<
  ScopedRepositories,
  | 'companies'
  | 'customers'
  | 'salesOrders'
  | 'salesOrderLines'
  | 'customerInvoices'
  | 'customerInvoiceLines'
>;

/** What reading one needs. */
export type InvoiceReadRepositories = Pick<
  ScopedRepositories,
  'customerInvoices' | 'customerInvoiceLines' | 'customers' | 'salesOrders'
>;

/** A line chosen to be billed, with everything the write needs already resolved. */
interface BillableLine {
  order: SalesOrderRecord;
  line: SalesOrderLineRecord;
  quantity: Decimal;
}

@Injectable()
export class CustomerInvoiceService {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * Creates an invoice draft from one or more confirmed sales orders.
   *
   * The wrapper that opens its own transaction, for a caller that is not already in one. The
   * endpoint uses `createDraftIn` instead, because section 11 requires the idempotency claim, the
   * work and the stored response to share one transaction.
   */
  async createDraft(
    context: CompanyContext,
    actorUserId: string,
    input: CreateInvoiceDraftInput,
  ): Promise<CustomerInvoiceDraft> {
    return this.uow.inActorScope(
      actorScope({
        tenantId: context.tenantId,
        companyId: context.companyId,
        userId: actorUserId,
      }),
      (repos) => this.createDraftIn(repos, context.companyId, input),
    );
  }

  /**
   * The same creation, inside a transaction the caller already opened.
   *
   * NOTHING HERE HAS A SIDE EFFECT, and the absences are the design rather than an unfinished
   * state. No number is allocated, because section 10.4 allocates inside the posting transaction
   * and a number spent on a draft would be a hole in a gapless series. No journal entry is
   * written, because section 18.2 as amended 2026-09-15 makes accounts receivable, revenue and
   * tax the posting's work. And `invoiced_quantity` on the source line is not touched, because
   * consuming it here would mean a draft nobody posts had permanently reduced what the order can
   * still be billed for.
   */
  async createDraftIn(
    repos: InvoiceDraftRepositories,
    companyId: string,
    input: CreateInvoiceDraftInput,
  ): Promise<CustomerInvoiceDraft> {
    const company = await repos.companies.findById(companyId);
    if (!company) {
      // Unreachable through a real session, which resolved this company from a membership moments
      // ago. Loud rather than silent, because the alternative is a null currency.
      throw new Error('The acting company disappeared inside its own transaction');
    }

    const sources = await this.resolveSources(repos, input);
    const billable = await this.chooseLines(repos, sources, input);
    const priced = billable.map((entry) => this.bill(company, entry));

    const invoiceId = randomUUID();
    const invoice = await repos.customerInvoices.create({
      id: invoiceId,
      // From the orders, never from the caller. An invoice addressed to somebody the orders do
      // not name would be a demand for payment nobody agreed to.
      customerId: sources.customerId,
      invoiceDate: input.invoiceDate,
      dueDate: this.dueDateOf(input),
      currency: sources.currency,
    });

    const lines: CustomerInvoiceLineRecord[] = [];
    for (const [index, line] of priced.entries()) {
      lines.push(
        await repos.customerInvoiceLines.create({
          ...line,
          id: randomUUID(),
          customerInvoiceId: invoiceId,
          // Assigned here, so two lines cannot collide and a caller cannot choose the order in
          // which its own lines are numbered.
          lineNumber: index + 1,
          currency: sources.currency,
        }),
      );
    }

    return { invoice: await this.total(repos, invoice, lines), lines };
  }

  /**
   * Rewrites a draft, inside a transaction the caller already opened.
   *
   * WHY EDITING EXISTS AT ALL. Section 12.2 states plainly that a draft is editable and has no
   * side effects, and an invoice draft is the document where the edit is the point: which orders
   * to bill together, which of their lines, and how much of each is exactly what somebody decides
   * before posting. Nothing is reserved, owed or posted, so there is nothing to unwind.
   *
   * A REPLACEMENT, NOT A PATCH, which is the convention the sales order draft already sets. The
   * caller sends the invoice as it should now be, and every line is re-derived from its source
   * line exactly as creation derives it.
   *
   * THE VERSION IS THE WHOLE CONCURRENCY STORY, per section 10.1. The header write carries the
   * version the caller read, so two people editing one draft resolve to one winner and the loser
   * is told the invoice moved rather than silently overwriting. The lines are replaced after that
   * write, inside the same transaction, so a loser removes nothing.
   *
   * NO AUDIT RECORD. Document audit begins at the irreversible moment, as settled on 2026-09-13
   * for the sales order and restated for the invoice here: creating and editing a draft are
   * pre-posting mutations of a document that has claimed nothing from anybody.
   */
  async updateDraftIn(
    repos: InvoiceDraftRepositories,
    companyId: string,
    input: UpdateInvoiceDraftInput,
  ): Promise<CustomerInvoiceDraft> {
    const company = await repos.companies.findById(companyId);
    if (!company) {
      throw new Error('The acting company disappeared inside its own transaction');
    }

    // Scoped, so an invoice in another company is not found rather than refused, per section 6.1.
    const existing = await repos.customerInvoices.findById(input.customerInvoiceId);
    if (!existing) {
      throw notFound('invoice_not_found', 'Customer invoice', input.customerInvoiceId);
    }

    // NOT A TRANSITION, AND SO NOT THE TRANSITION TABLE. Editing leaves the invoice exactly where
    // it was, and section 12.1's table governs moves between states. What section 12.2 says is
    // that a draft is editable, which is a question about the current state and is asked as one.
    // The header write asks it again, for the case where somebody posts it in between.
    const status = statusOf(existing.status);
    if (status !== 'draft') {
      throw new CustomerInvoiceDraftError(
        'not_a_draft',
        `A ${status} customer invoice cannot be edited. Only a draft can.`,
      );
    }

    const sources = await this.resolveSources(repos, input);
    const billable = await this.chooseLines(repos, sources, input);
    const priced = billable.map((entry) => this.bill(company, entry));

    // The header first, because its version is the lock. Everything after this point belongs to a
    // transaction that has already won the race.
    const header = await repos.customerInvoices.updateDraft({
      id: existing.id,
      expectedVersion: input.expectedVersion,
      customerId: sources.customerId,
      invoiceDate: input.invoiceDate,
      dueDate: this.dueDateOf(input),
    });

    // Out with the old lines and in with the new. The grant to delete an invoice line exists for
    // exactly this, and migration 0015 says so: a draft is editable under section 12.2 and
    // replacing a line is ordinary editing rather than deleting a document.
    for (const line of await repos.customerInvoiceLines.listForInvoice(existing.id)) {
      await repos.customerInvoiceLines.remove(line.id);
    }

    const lines: CustomerInvoiceLineRecord[] = [];
    for (const [index, line] of priced.entries()) {
      lines.push(
        await repos.customerInvoiceLines.create({
          ...line,
          id: randomUUID(),
          customerInvoiceId: existing.id,
          lineNumber: index + 1,
          currency: sources.currency,
        }),
      );
    }

    return { invoice: await this.total(repos, header, lines), lines };
  }

  /** One invoice, as a screen shows it. Null when it is another company's or does not exist. */
  async getById(
    context: CompanyContext,
    actorUserId: string,
    customerInvoiceId: string,
  ): Promise<CustomerInvoiceView | null> {
    return this.uow.inActorScope(
      actorScope({
        tenantId: context.tenantId,
        companyId: context.companyId,
        userId: actorUserId,
      }),
      (repos) => this.readIn(repos, customerInvoiceId),
    );
  }

  /**
   * The same read, inside a transaction the caller already opened.
   *
   * Used by the creating and editing endpoints so their response is what the detail endpoint
   * would say, without a second copy of the mapping to drift.
   */
  /**
   * The ledger entries this invoice's posting wrote, with the accounts named.
   *
   * THE INVOICE IS RESOLVED FIRST, and that is the access control, in the shape the sales order
   * trail established. Entries are found by source document identifier, and an identifier alone
   * decides nothing about who may see them, so the scoped invoice read answers first: another
   * company's invoice is not found, exactly as the detail read answers, per section 6.1. Row level
   * security confines the journal read as well, which is the second layer rather than the first.
   *
   * NOT A LEDGER API. One document's entries and nothing else: no account balances, no listing by
   * account or period, no trial balance. It exists so the result of a posting can be seen, and a
   * draft, which has posted nothing, answers with an empty list.
   *
   * THE ACCOUNT IS READ, NOT SNAPSHOTTED. A line references its account by identifier, and the
   * code and name shown are the account's own. An account is archived rather than deleted, so the
   * row is always there to be read.
   */
  async postingJournal(
    context: CompanyContext,
    actorUserId: string,
    customerInvoiceId: string,
  ): Promise<InvoiceJournalEntryView[] | null> {
    return this.uow.inActorScope(
      actorScope({
        tenantId: context.tenantId,
        companyId: context.companyId,
        userId: actorUserId,
      }),
      async (repos) => {
        const invoice = await repos.customerInvoices.findById(customerInvoiceId);
        if (!invoice) return null;

        const entries = await repos.journal.listForSourceDocument(
          CUSTOMER_INVOICE_DOC_TYPE,
          invoice.id,
        );

        const views: InvoiceJournalEntryView[] = [];
        for (const { entry, lines } of entries) {
          const viewLines: InvoiceJournalLineView[] = [];
          // One at a time, for the reason `readIn` gives: one connection per unit of work.
          for (const line of lines) {
            const account = await repos.accounts.findById(line.accountId);
            viewLines.push({
              lineNumber: line.lineNumber,
              account: {
                id: line.accountId,
                code: account?.code ?? '',
                name: account?.name ?? '',
                type: account?.type ?? '',
              },
              debit: line.debit,
              credit: line.credit,
              currency: line.currency,
            });
          }

          views.push({
            id: entry.id,
            entryDate: entry.entryDate,
            memo: entry.memo,
            currency: entry.currency,
            recordedAt: entry.createdAt.toISOString(),
            lines: viewLines,
          });
        }

        return views;
      },
    );
  }

  /**
   * The audit trail of one invoice.
   *
   * The sales order trail's shape and rules, applied to this document. Resolved through the scoped
   * invoice read first, so another company's invoice is not found. Document audit begins at the
   * lifecycle boundary, which for an invoice is posting, so a draft answers with an empty list
   * rather than an invented entry.
   *
   * The actor's name is resolved now and the roles are not: section 7.3 captures the roles held at
   * the time. The request id and the change payload stay on the record and off the wire, which is
   * the narrow default every audit read in this API already keeps.
   */
  async auditTrail(
    context: CompanyContext,
    actorUserId: string,
    customerInvoiceId: string,
  ): Promise<InvoiceAuditView[] | null> {
    return this.uow.inActorScope(
      actorScope({
        tenantId: context.tenantId,
        companyId: context.companyId,
        userId: actorUserId,
      }),
      async (repos) => {
        const invoice = await repos.customerInvoices.findById(customerInvoiceId);
        if (!invoice) return null;

        const events = await repos.audit.listForEntity(CUSTOMER_INVOICE_DOC_TYPE, invoice.id);

        const trail: InvoiceAuditView[] = [];
        for (const event of events) {
          const actor = event.actorUserId ? await repos.users.findById(event.actorUserId) : null;

          trail.push({
            id: event.id,
            occurredAt: event.occurredAt.toISOString(),
            action: event.action,
            summary: event.summary,
            actor: actor ? { id: actor.id, name: actor.name } : null,
            actorRoles: event.actorRoles ?? [],
          });
        }

        return trail;
      },
    );
  }

  async readIn(
    repos: InvoiceReadRepositories,
    customerInvoiceId: string,
  ): Promise<CustomerInvoiceView | null> {
    const invoice = await repos.customerInvoices.findById(customerInvoiceId);
    if (!invoice) return null;

    // One at a time. A unit of work is one connection, so parallel reads would be pipelined onto
    // it and the driver deprecates that.
    const lines = await repos.customerInvoiceLines.listForInvoice(invoice.id);
    const customer = await repos.customers.findById(invoice.customerId);

    // The orders this invoice covers, derived from its lines rather than from a stored set. In
    // line order, deduplicated, so the same order appearing on three lines is named once.
    const orders: { id: string; docNumber: string | null }[] = [];
    for (const orderId of [...new Set(lines.map((line) => line.sourceSalesOrderId))]) {
      const order = await repos.salesOrders.findById(orderId);
      orders.push({ id: orderId, docNumber: order?.docNumber ?? null });
    }

    return {
      id: invoice.id,
      docNumber: invoice.docNumber,
      status: invoice.status,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      customer: {
        id: invoice.customerId,
        // A composite foreign key pins the customer to this company, so a missing row here would
        // mean the key was dropped rather than that the reference was wrong.
        name: customer?.name ?? '',
        // What a legally valid invoice prints beside the party, per section 2.9.
        taxRegistrationNumber: customer?.taxRegistrationNumber ?? null,
      },
      subtotal: invoice.subtotal,
      taxTotal: invoice.taxTotal,
      total: invoice.total,
      version: invoice.version,
      salesOrders: orders,
      lines: lines.map((line) => ({
        id: line.id,
        lineNumber: line.lineNumber,
        sourceSalesOrderId: line.sourceSalesOrderId,
        sourceSalesOrderLineId: line.sourceSalesOrderLineId,
        productId: line.productId,
        productSku: line.productSku,
        productName: line.productName,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountPercent: line.discountPercent,
        taxRatePercent: line.taxRatePercent,
        lineSubtotal: line.lineSubtotal,
        lineTax: line.lineTax,
        lineTotal: line.lineTotal,
      })),
    };
  }

  /**
   * Reads the source orders and establishes that they can be billed together.
   *
   * Every read is scoped, so an order in another company is not found rather than refused, and a
   * caller cannot learn that it exists. Two orders that disagree about the customer or the
   * currency are refused rather than reconciled: an invoice is addressed to one party and carries
   * one currency, and picking one of two would be inventing which.
   */
  private async resolveSources(
    repos: Pick<InvoiceDraftRepositories, 'salesOrders'>,
    input: CreateInvoiceDraftInput,
  ): Promise<{ orders: SalesOrderRecord[]; customerId: string; currency: string }> {
    // Deduplicated, so naming one order twice is the same request as naming it once rather than
    // a way to bill it twice.
    const ids = [...new Set(input.salesOrderIds)];
    if (ids.length === 0) {
      throw new CustomerInvoiceDraftError(
        'no_sources',
        'An invoice is raised from at least one confirmed sales order',
      );
    }

    const orders: SalesOrderRecord[] = [];
    for (const id of ids) {
      const order = await repos.salesOrders.findById(id);
      if (!order) throw notFound('order_not_found', 'Sales order', id);

      const status = salesOrderStatusOf(order.status);
      if (!(INVOICEABLE_SALES_ORDER_STATUSES as readonly string[]).includes(status)) {
        throw new CustomerInvoiceDraftError(
          'order_not_invoiceable',
          `A ${status} sales order cannot be invoiced. Only a confirmed one can.`,
          id,
        );
      }

      orders.push(order);
    }

    const first = orders[0]!;
    for (const order of orders) {
      if (order.customerId !== first.customerId) {
        throw new CustomerInvoiceDraftError(
          'customer_mismatch',
          'Every sales order on one invoice must be for the same customer',
          order.id,
        );
      }
      if (order.currency !== first.currency) {
        // Unreachable while every order takes the company's base currency, and refused rather
        // than resolved because an invoice carries one currency and section 4.3 will not guess a
        // rate between two.
        throw new CustomerInvoiceDraftError(
          'currency_mismatch',
          'Every sales order on one invoice must be in the same currency',
          order.id,
        );
      }
    }

    return { orders, customerId: first.customerId, currency: first.currency };
  }

  /**
   * Works out which order lines are being billed, and how much of each.
   *
   * WHAT BOUNDS A QUANTITY. The source line's own uninvoiced remainder, meaning what was ordered
   * less what has already been invoiced. Billing more than was ordered has no basis in any
   * document, and the bound is read from the order line inside this transaction rather than taken
   * from anything the caller sent.
   *
   * WHAT THE BOUND DOES NOT DO is stop two drafts from each claiming the same remainder. Nothing
   * is consumed until posting, so two drafts raised at once can both pass this check, and the
   * architecture has not ruled whether that is allowed. It is left as it is rather than closed
   * with an invented reservation: section 12.2 makes posting the moment that validates against
   * current state, and that is where the question belongs.
   */
  private async chooseLines(
    repos: Pick<InvoiceDraftRepositories, 'salesOrderLines'>,
    sources: { orders: SalesOrderRecord[] },
    input: CreateInvoiceDraftInput,
  ): Promise<BillableLine[]> {
    const byOrder = new Map(sources.orders.map((order) => [order.id, order]));

    // Every line of every named order, read once, so both branches below work from the same
    // authoritative rows rather than from two different reads.
    const orderLines = new Map<string, { order: SalesOrderRecord; line: SalesOrderLineRecord }>();
    const inOrder: { order: SalesOrderRecord; line: SalesOrderLineRecord }[] = [];
    for (const order of sources.orders) {
      for (const line of await repos.salesOrderLines.listForOrder(order.id)) {
        orderLines.set(line.id, { order, line });
        inOrder.push({ order, line });
      }
    }

    const chosen: BillableLine[] = [];

    if (input.lines === undefined) {
      // Billing the orders in full: every line with something still to invoice, at its remainder.
      for (const entry of inOrder) {
        const remaining = remainderOf(entry.line);
        if (compare(remaining, zero(0)) <= 0) continue;
        chosen.push({ ...entry, quantity: remaining });
      }

      if (chosen.length === 0) {
        throw new CustomerInvoiceDraftError(
          'nothing_to_invoice',
          'Every line of those sales orders has already been invoiced',
        );
      }

      return chosen;
    }

    const seen = new Set<string>();
    for (const requested of input.lines) {
      if (seen.has(requested.salesOrderLineId)) {
        // The unique key in 0015 refuses this too. Refusing it here names the line rather than
        // surfacing a constraint violation the caller has to decode.
        throw new CustomerInvoiceDraftError(
          'duplicate_line',
          'One invoice line per sales order line. Add the quantities together instead.',
          requested.salesOrderLineId,
        );
      }
      seen.add(requested.salesOrderLineId);

      const entry = orderLines.get(requested.salesOrderLineId);
      if (!entry) {
        // Either the line does not exist, or it belongs to an order that was not named. Both are
        // the caller's mistake; only the second is worth distinguishing, and only because the
        // line may be perfectly real in a company the caller can see.
        const line = await repos.salesOrderLines.findById(requested.salesOrderLineId);
        if (!line) throw notFound('line_not_found', 'Sales order line', requested.salesOrderLineId);

        throw new CustomerInvoiceDraftError(
          'line_not_in_sources',
          'That sales order line belongs to an order this invoice does not name',
          requested.salesOrderLineId,
        );
      }

      const remaining = remainderOf(entry.line);
      const quantity =
        requested.quantity === undefined
          ? remaining
          : decimalOr(requested.quantity, 'invalid_quantity', 'quantity');

      if (compare(quantity, zero(0)) <= 0) {
        throw new CustomerInvoiceDraftError(
          'invalid_quantity',
          'An invoice line quantity must be greater than zero',
          requested.salesOrderLineId,
        );
      }

      if (compare(quantity, remaining) > 0) {
        throw new CustomerInvoiceDraftError(
          'quantity_exceeds_remaining',
          `That line has ${toFixed(remaining, RATE_SCALE)} left to invoice`,
          requested.salesOrderLineId,
        );
      }

      chosen.push({ ...entry, quantity });
    }

    if (chosen.length === 0) {
      throw new CustomerInvoiceDraftError(
        'nothing_to_invoice',
        'An invoice needs at least one line',
      );
    }

    // In the order the caller listed them, which is the only ordering that is the caller's to
    // decide. `byOrder` is consulted so a line whose order vanished between the two reads cannot
    // slip through as a line with no source.
    for (const entry of chosen) {
      if (!byOrder.has(entry.order.id)) {
        throw notFound('order_not_found', 'Sales order', entry.order.id);
      }
    }

    return chosen;
  }

  /**
   * Turns one chosen order line into the figures that will be stored.
   *
   * WHY THE PRICE COMES FROM THE ORDER LINE AND NOT FROM THE PRODUCT. Section 3.4 makes a document
   * the immutable record of a past agreement, and the agreement about price was made when the
   * order was raised and snapshotted onto its line then. Billing today's catalogue price would
   * charge a customer something they never agreed to, and would make the invoice disagree with
   * the order it cites. Section 3.3's requirement is that the figure is not the caller's, and it
   * is not: it comes from a persisted document row read inside this transaction.
   *
   * WHY THE TAX RATE DOES NOT. Section 2.9 requires every document line to resolve its rate
   * through one function, and makes the rate on a draft a working figure recomputed when the
   * document is committed. A tax point is the invoice's own date, not the order's, so the rate
   * that applies to the invoice is the one that applies now.
   *
   * The arithmetic is the sales order's, line for line: gross, then discounted, then rounded once
   * to the amount scale, then tax on the rounded subtotal. Anything else would make an invoice
   * for the whole of an order disagree with the order's own total by a rounding step.
   */
  private bill(
    company: { baseCurrency: string; standardTaxRatePercent: string },
    entry: BillableLine,
  ): Omit<
    Parameters<ScopedRepositories['customerInvoiceLines']['create']>[0],
    'id' | 'customerInvoiceId' | 'lineNumber' | 'currency'
  > {
    const { line, order, quantity } = entry;

    const unitPrice = parseDecimal(line.unitPrice);
    const discount = parseDecimal(line.discountPercent);
    const taxRate = parseDecimal(resolveTaxRate(company));

    // One implementation, shared with posting, which recomputes these to check that the document
    // it is about to make binding still follows from its own inputs. Two implementations would
    // eventually round differently, and the difference would surface as a journal entry that does
    // not equal the invoice it came from.
    const amounts = billedAmounts({
      quantity,
      unitPrice,
      discountPercent: discount,
      taxRatePercent: taxRate,
    });

    return {
      sourceSalesOrderId: order.id,
      sourceSalesOrderLineId: line.id,
      productId: line.productId,
      // Snapshotted from the order line, which snapshotted them from the catalogue when the order
      // was raised. Both documents therefore say what was agreed rather than what is current.
      productSku: line.productSku,
      productName: line.productName,
      quantity: toFixed(quantity, RATE_SCALE),
      unitPrice: toFixed(unitPrice, RATE_SCALE),
      discountPercent: toFixed(discount, RATE_SCALE),
      taxRatePercent: toFixed(taxRate, RATE_SCALE),
      ...amounts,
    };
  }

  /** The due date, refused when it falls before the invoice it is due for. */
  private dueDateOf(input: CreateInvoiceDraftInput): string | null {
    const dueDate = input.dueDate ?? null;
    if (dueDate !== null && dueDate < input.invoiceDate) {
      // The check constraint refuses this too. Refusing it here says which two dates disagree.
      throw new CustomerInvoiceDraftError(
        'invalid_due_date',
        'An invoice cannot fall due before the day it is raised',
      );
    }

    return dueDate;
  }

  /**
   * Writes the document totals, summed from the stored lines.
   *
   * No rounding: each line was already rounded to the amount scale, so the sum is exact and no
   * difference arises for section 4.3 to allocate.
   */
  private async total(
    repos: Pick<InvoiceDraftRepositories, 'customerInvoices'>,
    invoice: CustomerInvoiceRecord,
    lines: CustomerInvoiceLineRecord[],
  ): Promise<CustomerInvoiceRecord> {
    return repos.customerInvoices.setTotals({
      id: invoice.id,
      ...documentTotals(lines),
    });
  }
}

/** What a sales order line still has left to be invoiced: ordered less already invoiced. */
function remainderOf(line: SalesOrderLineRecord): Decimal {
  return subtract(
    parseDecimal(line.quantity, RATE_SCALE),
    parseDecimal(line.invoicedQuantity, RATE_SCALE),
  );
}

function decimalOr(value: string, reason: InvoiceDraftRejection, field: string): Decimal {
  try {
    return parseDecimal(value, RATE_SCALE);
  } catch (error) {
    // The parse failure carries the useful detail; the domain error carries the reason a caller
    // can branch on. Section 14.2: rejected rather than coerced into something plausible.
    throw new CustomerInvoiceDraftError(
      reason,
      `A line ${field} must be a decimal with at most ${RATE_SCALE} places: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function notFound(
  reason: InvoiceDraftRejection,
  subject: string,
  id: string,
): CustomerInvoiceDraftError {
  // One message whether the record is missing, another company's or another tenant's.
  return new CustomerInvoiceDraftError(reason, `${subject} not found`, id);
}
