/**
 * Customer invoices, from the backend.
 *
 * Separate from `finance.service.ts`, which still answers the invoice list and every other finance
 * screen from fixtures. Keeping the real calls in their own file keeps the boundary visible: a
 * screen importing from here reads the server, and nothing here reaches `@/mocks`.
 *
 * WHAT THE SERVER OWNS. The number, the status, every figure and every line. They arrive in the
 * responses below and are never worked out here, per contract sections 3.3 and 10.4.
 */

import type { ID, ISODate, Money } from '@/domain';
import { request } from './client';
import type { TimelineEvent } from '@/components/domain/documents';
import { toAuditEvent, toMoney, type AuditEventResponse } from './sales.service';

/** An invoice as the backend holds it. Figures are decimal strings, per section 4.3. */
interface CustomerInvoiceResponse {
  id: string;
  docNumber: string | null;
  status: string;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  customer: { id: string; name: string; taxRegistrationNumber: string | null };
  subtotal: string;
  taxTotal: string;
  total: string;
  version: number;
  salesOrders: { id: string; docNumber: string | null }[];
  lines: {
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
  }[];
}

/**
 * The two states the backend's invoice can be in today.
 *
 * Not the fixture `InvoiceStatus`, which carries payment states the backend has no source for.
 */
export type CustomerInvoiceStatus = 'draft' | 'posted';

/**
 * What the invoice screen works with.
 *
 * Deliberately not the fixture `CustomerInvoice`. That type carries a paid amount, a balance due,
 * who posted it, a journal entry number and a links array, and the invoice response has none of
 * them. Declaring them and filling them with zeroes would put claims in the type nothing stands
 * behind.
 */
export interface CustomerInvoiceDetail {
  id: ID;
  /** Null while a draft. Allocated by the posting transaction. */
  docNumber: string | null;
  status: CustomerInvoiceStatus;
  invoiceDate: ISODate;
  dueDate: ISODate | null;
  currency: Money['currency'];
  customer: { id: ID; name: string; taxRegistrationNumber: string | null };
  subtotal: Money;
  taxTotal: Money;
  total: Money;
  version: number;
  salesOrders: { id: ID; docNumber: string | null }[];
  lines: CustomerInvoiceDetailLine[];
}

export interface CustomerInvoiceDetailLine {
  id: ID;
  lineNumber: number;
  sourceSalesOrderId: ID;
  productId: ID;
  productSku: string;
  productName: string;
  quantity: number;
  unitPrice: Money;
  discountPercent: number;
  taxRatePercent: number;
  lineSubtotal: Money;
  lineTax: Money;
  lineTotal: Money;
}

/**
 * What the server says after posting.
 *
 * Exactly the endpoint's response. The whole invoice is one read away; this carries what changed
 * and the entry the posting wrote.
 */
export interface PostingResult {
  id: string;
  status: string;
  docNumber: string;
  journalEntryId: string;
  total: string;
  currency: string;
}

/** One journal entry as the backend serves it. Debits and credits are decimal strings. */
interface JournalEntryResponse {
  id: string;
  entryDate: string;
  memo: string;
  currency: string;
  recordedAt: string;
  lines: {
    lineNumber: number;
    account: { id: string; code: string; name: string; type: string };
    debit: string;
    credit: string;
    currency: string;
  }[];
}

/**
 * The entry a posting wrote, as the invoice screen shows it.
 *
 * Only what the journal read returns. It is one document's entries, not a ledger, and there is no
 * balance here because the backend serves none.
 */
export interface InvoiceJournalEntry {
  id: ID;
  entryDate: ISODate;
  memo: string;
  currency: Money['currency'];
  recordedAt: string;
  lines: {
    lineNumber: number;
    account: { code: string; name: string; type: string };
    debit: Money;
    credit: Money;
  }[];
}

function toDetail(response: CustomerInvoiceResponse): CustomerInvoiceDetail {
  const currency = response.currency;

  return {
    id: response.id,
    docNumber: response.docNumber,
    status: response.status as CustomerInvoiceStatus,
    invoiceDate: response.invoiceDate,
    dueDate: response.dueDate,
    currency: currency as Money['currency'],
    customer: response.customer,
    subtotal: toMoney(response.subtotal, currency),
    taxTotal: toMoney(response.taxTotal, currency),
    total: toMoney(response.total, currency),
    version: response.version,
    salesOrders: response.salesOrders,
    lines: response.lines.map((line) => ({
      id: line.id,
      lineNumber: line.lineNumber,
      sourceSalesOrderId: line.sourceSalesOrderId,
      productId: line.productId,
      productSku: line.productSku,
      productName: line.productName,
      quantity: Number(line.quantity),
      unitPrice: toMoney(line.unitPrice, currency),
      discountPercent: Number(line.discountPercent),
      taxRatePercent: Number(line.taxRatePercent),
      lineSubtotal: toMoney(line.lineSubtotal, currency),
      lineTax: toMoney(line.lineTax, currency),
      lineTotal: toMoney(line.lineTotal, currency),
    })),
  };
}

export const invoicesService = {
  /**
   * Raises a draft invoice from one confirmed sales order.
   *
   * WHAT IT SENDS: the order and the invoice date. No lines, so the server bills every line with
   * something left to invoice, at that remainder. No price, tax, total, status or number, because
   * every one of those is the server's, and the endpoint refuses a body naming any of them.
   *
   * THE KEY IS THE CALLER'S, one per intent, as on every mutating sales call: a retry of the same
   * press replays the same draft rather than raising a second one.
   */
  async createFromOrder(
    salesOrderId: string,
    invoiceDate: string,
    idempotencyKey: string,
  ): Promise<CustomerInvoiceDetail> {
    return toDetail(
      await request<CustomerInvoiceResponse>('/customer-invoices', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ salesOrderIds: [salesOrderId], invoiceDate }),
      }),
    );
  },

  /**
   * Posts a draft invoice to the ledger.
   *
   * NO BODY. There is nothing about a posting for a caller to decide: the lines, the accounts, the
   * number, the date and the status all come from persisted records. The server re-reads the
   * orders, re-checks the tax rate and the arithmetic, consumes the invoiced quantities, allocates
   * the number, writes the entry and the audit record, and commits, or does none of it.
   *
   * The key is one per intent, so a retry of the same press replays the posting rather than being
   * refused as a second one.
   */
  async postInvoice(id: string, idempotencyKey: string): Promise<PostingResult> {
    return request<PostingResult>(`/customer-invoices/${id}/post`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  },

  /**
   * The journal entries this invoice's posting wrote.
   *
   * Needs `accounting:view`, which the sales role does not hold. A draft answers with an empty
   * list, because it has posted nothing.
   */
  async journal(id: string): Promise<InvoiceJournalEntry[]> {
    const entries = await request<JournalEntryResponse[]>(`/customer-invoices/${id}/journal`);

    return entries.map((entry) => ({
      id: entry.id,
      entryDate: entry.entryDate,
      memo: entry.memo,
      currency: entry.currency as Money['currency'],
      recordedAt: entry.recordedAt,
      lines: entry.lines.map((line) => ({
        lineNumber: line.lineNumber,
        account: { code: line.account.code, name: line.account.name, type: line.account.type },
        debit: toMoney(line.debit, line.currency),
        credit: toMoney(line.credit, line.currency),
      })),
    }));
  },

  /**
   * The audit trail of one invoice, in the shape the history panel already reads.
   *
   * Needs `audit:view`. Document audit begins at posting, so a draft answers with an empty list.
   */
  async auditTrail(id: string): Promise<TimelineEvent[]> {
    const events = await request<AuditEventResponse[]>(`/customer-invoices/${id}/audit-events`);
    return events.map(toAuditEvent);
  },

  /**
   * One customer invoice.
   *
   * Another company's invoice answers 404, the same as one that does not exist, per section 6.1.
   */
  async getInvoice(id: string): Promise<CustomerInvoiceDetail> {
    return toDetail(await request<CustomerInvoiceResponse>(`/customer-invoices/${id}`));
  },
};
