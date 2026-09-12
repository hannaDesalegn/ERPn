/** Sales cycle reads: orders, deliveries, and the documents around them. */

import type {
  Delivery,
  DocumentRef,
  ID,
  ISODate,
  Money,
  SalesOrder,
  SalesOrderStatus,
} from '@/domain';
import { db } from '@/mocks/db';
import {
  delay,
  NotFoundError,
  queryList,
  request,
  type ListParams,
  type Paginated,
} from './client';

/**
 * What the server says after confirming an order.
 *
 * Exactly the endpoint's response and nothing more. The status and the document number are the
 * server's to decide, per contract sections 12.2 and 10.4, so they arrive rather than being
 * worked out here.
 */
export interface ConfirmationResult {
  id: string;
  status: string;
  docNumber: string;
  reservations: number;
}


/**
 * A sales order as the backend holds it.
 *
 * Exactly the endpoint's response. Figures are decimal strings because contract section 4.3 keeps
 * them exact on the server, and converting them to whatever this application renders is this
 * layer's job rather than a component's.
 */
interface SalesOrderResponse {
  id: string;
  docNumber: string | null;
  status: string;
  orderDate: string;
  expectedDeliveryDate: string | null;
  currency: string;
  customer: { id: string; name: string };
  warehouse: { id: string; name: string };
  salesRep: { id: string; name: string } | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  version: number;
  lines: {
    id: string;
    lineNumber: number;
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
    deliveredQuantity: string;
    invoicedQuantity: string;
  }[];
}

/**
 * What the detail screen works with.
 *
 * Deliberately not the fixture `SalesOrder` type. That one carries an invoiced total, a links
 * array and notes, and the backend has no source for any of them: invoices have no table, section
 * 12.4 is explicit that a stored links array is the wrong answer, and notes are not modelled.
 * Declaring them here and filling them with zeroes would put three claims in the type that
 * nothing stands behind.
 *
 * `docNumber` and `salesRep` are nullable because the columns are. A draft has no number until
 * section 12.2's confirming transaction allocates one.
 */
export interface SalesOrderDetail {
  id: string;
  docNumber: string | null;
  status: SalesOrderStatus;
  orderDate: ISODate;
  expectedDeliveryDate?: ISODate;
  currency: Money['currency'];
  customer: { id: ID; name: string };
  warehouse: { id: ID; name: string };
  salesRep: { id: ID; name: string } | null;
  subtotal: Money;
  taxTotal: Money;
  total: Money;
  /** Section 10.1's token, carried so a later edit can say what it read. */
  version: number;
  lines: SalesOrderDetailLine[];
}

export interface SalesOrderDetailLine {
  id: ID;
  lineNumber: number;
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
  deliveredQuantity: number;
  invoicedQuantity: number;
}

/**
 * A decimal string into the minor units this application counts in.
 *
 * The server keeps four decimal places and this rounds to two, which is the representation
 * section 16.1 already records as temporary pending a shared contracts package. Rounding here
 * rather than anywhere else keeps the loss in one place, at the seam, where it can be removed.
 */
function toMoney(value: string, currency: string): Money {
  return { amount: Math.round(Number(value) * 100), currency: currency as Money['currency'] };
}

function toDetail(response: SalesOrderResponse): SalesOrderDetail {
  return {
    id: response.id,
    docNumber: response.docNumber,
    status: response.status as SalesOrderStatus,
    orderDate: response.orderDate,
    ...(response.expectedDeliveryDate ? { expectedDeliveryDate: response.expectedDeliveryDate } : {}),
    currency: response.currency as Money['currency'],
    customer: response.customer,
    warehouse: response.warehouse,
    salesRep: response.salesRep,
    subtotal: toMoney(response.subtotal, response.currency),
    taxTotal: toMoney(response.taxTotal, response.currency),
    total: toMoney(response.total, response.currency),
    version: response.version,
    lines: response.lines.map((line) => ({
      id: line.id,
      lineNumber: line.lineNumber,
      productId: line.productId,
      productSku: line.productSku,
      productName: line.productName,
      quantity: Number(line.quantity),
      unitPrice: toMoney(line.unitPrice, response.currency),
      discountPercent: Number(line.discountPercent),
      taxRatePercent: Number(line.taxRatePercent),
      lineSubtotal: toMoney(line.lineSubtotal, response.currency),
      lineTax: toMoney(line.lineTax, response.currency),
      lineTotal: toMoney(line.lineTotal, response.currency),
      deliveredQuantity: Number(line.deliveredQuantity),
      invoicedQuantity: Number(line.invoicedQuantity),
    })),
  };
}


/** One row of the list, as the backend serves it. */
interface SalesOrderRowResponse {
  id: string;
  docNumber: string | null;
  status: string;
  orderDate: string;
  currency: string;
  total: string;
  customer: { name: string };
  warehouse: { name: string };
  salesRep: { name: string } | null;
  lineCount: number;
  orderedQuantity: string;
  deliveredQuantity: string;
}

interface SalesOrderPageResponse {
  rows: SalesOrderRowResponse[];
  total: number;
  page: number;
  pageSize: number;
  totalValue: string;
}

/**
 * A sales order as the list screen shows it.
 *
 * Not the detail type and not the fixture type. A list row carries a line count and two
 * quantities where the document carries lines, because the screen renders a count and a
 * delivered percentage and nothing else from them.
 */
export interface SalesOrderRow {
  id: ID;
  docNumber: string | null;
  status: SalesOrderStatus;
  orderDate: ISODate;
  total: Money;
  customer: { name: string };
  warehouse: { name: string };
  salesRep: { name: string } | null;
  lineCount: number;
  orderedQuantity: number;
  deliveredQuantity: number;
}

/** `ListParams` into the query string the endpoint accepts. */
function listQueryString(params: ListParams): string {
  const query = new URLSearchParams();

  if (params.search) query.set('search', params.search);
  for (const [key, values] of Object.entries(params.filters ?? {})) {
    for (const value of values ?? []) query.append(key, value);
  }
  if (params.sortBy) query.set('sortBy', params.sortBy);
  if (params.sortDir) query.set('sortDir', params.sortDir);
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));

  const rendered = query.toString();
  return rendered ? `?${rendered}` : '';
}

export const salesService = {
  /**
   * One page of this company's sales orders, from the backend.
   *
   * The filtering, sorting, paging and the total are all the server's, which is what section 3.3
   * means by an aggregate covering the whole filtered set: computing it here from `rows` would
   * silently answer a different question as soon as a second page existed.
   */
  async listOrders(params: ListParams = {}): Promise<Paginated<SalesOrderRow>> {
    const page = await request<SalesOrderPageResponse>(
      `/sales-orders${listQueryString(params)}`,
    );

    return {
      rows: page.rows.map((row) => ({
        id: row.id,
        docNumber: row.docNumber,
        status: row.status as SalesOrderStatus,
        orderDate: row.orderDate,
        total: toMoney(row.total, row.currency),
        customer: row.customer,
        warehouse: row.warehouse,
        salesRep: row.salesRep,
        lineCount: row.lineCount,
        orderedQuantity: Number(row.orderedQuantity),
        deliveredQuantity: Number(row.deliveredQuantity),
      })),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      totals: { value: toMoney(page.totalValue, 'USD').amount },
    };
  },

  /**
   * One sales order, from the backend.
   *
   * Section 16.1 removes the fixture layer per module as endpoints land, and the sales order
   * document has landed: this and the list above both read the backend, so an identifier from one
   * is an identifier the other serves.
   *
   * `db.salesOrders` survives below for the dashboard's recent orders and for resolving document
   * references, neither of which has an endpoint. Those are other modules' fixtures, not this
   * one's.
   */
  async getOrder(id: string): Promise<SalesOrderDetail> {
    return toDetail(await request<SalesOrderResponse>(`/sales-orders/${id}`));
  },

  /**
   * Confirms a sales order against the real backend.
   *
   * THE FIRST WRITE IN THIS FILE THAT IS NOT A FIXTURE. Everything above still reads from
   * `@/mocks`; this reaches the endpoint that reserves the stock, allocates the number, writes
   * the audit record and commits, all in one transaction. None of that is repeated here, and
   * none of it could be: the rules live on the server and this is a caller.
   *
   * NO BODY. There is nothing about a confirmation for a caller to decide. The lines, their
   * quantities, the warehouse, the number and the status all come from persisted records, per
   * section 3.3, so the request carries an identifier in its path and a key in its header.
   *
   * THE KEY IS THE CALLER'S, AND IT IS ONE PER INTENT. Section 11 is explicit that a key belongs
   * to a user intent rather than to a network attempt: pressing the button once produces one key
   * however many times the request is transmitted. Generating one here, inside the call, would
   * make every retry a fresh intent and defeat the whole mechanism, so it is an argument.
   */
  async confirmOrder(id: string, idempotencyKey: string): Promise<ConfirmationResult> {
    return request<ConfirmationResult>(`/sales-orders/${id}/confirm`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  },

  async listDeliveries(params: ListParams = {}): Promise<Paginated<Delivery>> {
    return delay(
      queryList(db.deliveries, params, {
        searchFields: (d) => [d.docNumber, d.customer.name, d.salesOrderNumber, d.trackingNumber],
        filterAccessors: { status: (d) => d.status, warehouseId: (d) => d.warehouseId },
        sortAccessors: { docNumber: (d) => d.docNumber, shippedDate: (d) => d.shippedDate ?? '' },
        defaultSort: { by: 'shippedDate', dir: 'desc' },
      }),
    );
  },

  async getDelivery(id: string): Promise<Delivery> {
    const delivery = db.deliveries.find((d) => d.id === id);
    if (!delivery) throw new NotFoundError('Delivery', id);
    return delay(delivery);
  },

  /** Recent orders for the dashboard. */
  async recentOrders(limit = 6): Promise<SalesOrder[]> {
    return delay(
      [...db.salesOrders]
        .filter((so) => so.status !== 'draft')
        .sort((a, b) => b.orderDate.localeCompare(a.orderDate))
        .slice(0, limit),
    );
  },
};

/**
 * Resolve a set of DocumentRefs into displayable rows.
 *
 * This powers the "related documents" panel. In a real backend this is one
 * endpoint returning the document graph around a record, which is far cheaper
 * than the client fetching each linked document separately.
 */
export interface RelatedDocument {
  ref: DocumentRef;
  date?: string;
  status?: string;
  amount?: { amount: number; currency: 'USD' | 'EUR' | 'ETB' };
}

export function resolveDocumentRefs(refs: DocumentRef[]): RelatedDocument[] {
  return refs.map((ref) => {
    switch (ref.docType) {
      case 'sales_order': {
        const d = db.salesOrders.find((x) => x.id === ref.id);
        return { ref, date: d?.orderDate, status: d?.status, amount: d?.total };
      }
      case 'delivery': {
        const d = db.deliveries.find((x) => x.id === ref.id);
        return { ref, date: d?.shippedDate ?? d?.scheduledDate, status: d?.status };
      }
      case 'customer_invoice': {
        const d = db.customerInvoices.find((x) => x.id === ref.id);
        return { ref, date: d?.invoiceDate, status: d?.status, amount: d?.total };
      }
      case 'supplier_bill': {
        const d = db.supplierBills.find((x) => x.id === ref.id);
        return { ref, date: d?.invoiceDate, status: d?.status, amount: d?.total };
      }
      case 'customer_payment':
      case 'supplier_payment': {
        const d = db.payments.find((x) => x.id === ref.id);
        return { ref, date: d?.paymentDate, status: d?.status, amount: d?.amount };
      }
      case 'purchase_order': {
        const d = db.purchaseOrders.find((x) => x.id === ref.id);
        return { ref, date: d?.orderDate, status: d?.status, amount: d?.total };
      }
      case 'goods_receipt': {
        const d = db.goodsReceipts.find((x) => x.id === ref.id);
        return { ref, date: d?.receivedDate, status: d?.status };
      }
      case 'journal_entry': {
        const d = db.journalEntries.find((x) => x.id === ref.id);
        return { ref, date: d?.entryDate, status: d?.status, amount: d?.totalDebit };
      }
      case 'inventory_adjustment': {
        const d = db.adjustments.find((x) => x.id === ref.id);
        return { ref, date: d?.countDate, status: d?.status };
      }
      default:
        return { ref };
    }
  });
}
