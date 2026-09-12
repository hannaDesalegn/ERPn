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

export const salesService = {
  async listOrders(params: ListParams = {}): Promise<Paginated<SalesOrder>> {
    const result = queryList(db.salesOrders, params, {
      searchFields: (so) => [so.docNumber, so.customer.name, so.salesRep.name, so.warehouseName],
      filterAccessors: {
        status: (so) => so.status,
        warehouseId: (so) => so.warehouseId,
        salesRepId: (so) => so.salesRep.id,
        customerId: (so) => so.customer.id,
      },
      sortAccessors: {
        docNumber: (so) => so.docNumber,
        orderDate: (so) => so.orderDate,
        customer: (so) => so.customer.name,
        total: (so) => so.total.amount,
        status: (so) => so.status,
      },
      defaultSort: { by: 'orderDate', dir: 'desc' },
    });

    // Aggregate over the filtered set, not the page. See the note in client.ts.
    const filteredTotal = queryList(db.salesOrders, { ...params, page: 1, pageSize: Number.MAX_SAFE_INTEGER }, {
      searchFields: (so) => [so.docNumber, so.customer.name, so.salesRep.name, so.warehouseName],
      filterAccessors: {
        status: (so) => so.status,
        warehouseId: (so) => so.warehouseId,
        salesRepId: (so) => so.salesRep.id,
        customerId: (so) => so.customer.id,
      },
    }).rows.reduce((acc, so) => acc + so.total.amount, 0);

    return delay({ ...result, totals: { value: filteredTotal } });
  },

  /**
   * One sales order, from the backend.
   *
   * THE FIRST READ IN THIS FILE THAT IS NOT A FIXTURE. Section 16.1 removes the fixture layer per
   * module as endpoints land, and this is the sales order detail landing. The list beside it still
   * reads `db.salesOrders`, because no list endpoint exists yet, so the two disagree about which
   * orders there are until it does.
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
