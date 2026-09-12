/** Sales cycle reads: orders, deliveries, and the documents around them. */

import type { Delivery, DocumentRef, SalesOrder } from '@/domain';
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

  async getOrder(id: string): Promise<SalesOrder> {
    const order = db.salesOrders.find((so) => so.id === id);
    if (!order) throw new NotFoundError('Sales order', id);
    return delay(order);
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
