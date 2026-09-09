/**
 * Sales cycle: Sales Order -> Delivery -> Customer Invoice -> Payment.
 *
 * ERP CONCEPT — WHY THESE ARE FOUR SEPARATE DOCUMENTS
 * ---------------------------------------------------
 * A beginner models "an order" with a paid flag. A real business needs four,
 * because the three real-world events they represent happen at different times,
 * are done by different people, and have different consequences:
 *
 *   Sales Order   a PROMISE. Affects nothing financially. Reserves stock.
 *                 Owned by sales.
 *   Delivery      goods physically LEAVE. Affects inventory. Owned by the warehouse.
 *   Invoice       a legal CLAIM for money. Affects the customer's balance and
 *                 revenue. Owned by accounting.
 *   Payment       cash actually ARRIVES. Affects the bank account and settles
 *                 the invoice. Owned by finance.
 *
 * They routinely diverge: you can deliver partially, invoice several deliveries
 * on one monthly invoice, or receive one payment covering three invoices. A
 * single "order" record cannot represent any of that.
 */

import type {
  DocType,
  DocumentBase,
  ID,
  ISODate,
  Money,
  PartyRef,
  Quantity,
} from './primitives';

/**
 * SALES ORDER STATUS.
 *
 * `draft` is editable and has zero side effects — nothing is reserved, nothing
 * is owed. Confirming is the meaningful transition: stock gets reserved and the
 * order becomes a commitment. This draft/confirmed split exists in every ERP.
 */
export type SalesOrderStatus =
  | 'draft'
  | 'confirmed'
  | 'partially_delivered'
  | 'delivered'
  | 'invoiced'
  | 'cancelled';

export interface SalesOrderLine {
  id: ID;
  productId: ID;
  productSku: string;
  productName: string;
  quantity: Quantity;
  /**
   * Price is COPIED onto the line at order time, not looked up from the product.
   * If the catalog price changes next month, this order must still show what the
   * customer actually agreed to. Historical documents are immutable records of a
   * past agreement.
   */
  unitPrice: Money;
  discountPercent: number;
  taxRatePercent: number;
  /** quantity x unitPrice, less discount, before tax. */
  lineSubtotal: Money;
  lineTax: Money;
  lineTotal: Money;
  /** How much of this line has actually shipped. Drives partial-delivery status. */
  deliveredQuantity: Quantity;
  invoicedQuantity: Quantity;
}

export interface SalesOrder extends DocumentBase {
  docType: Extract<DocType, 'sales_order'>;
  status: SalesOrderStatus;
  customer: PartyRef;
  orderDate: ISODate;
  expectedDeliveryDate?: ISODate;
  warehouseId: ID;
  warehouseName: string;
  salesRep: { id: ID; name: string };
  lines: SalesOrderLine[];
  subtotal: Money;
  taxTotal: Money;
  total: Money;
  currency: Money['currency'];
  /** Sum of posted invoices raised against this order. */
  invoicedTotal: Money;
  /** Convenience flag the UI uses to show a "credit hold" warning. */
  exceedsCreditLimit?: boolean;
}

/** Goods leaving our warehouse for a customer. Owned by warehouse staff. */
export type DeliveryStatus = 'draft' | 'ready' | 'shipped' | 'delivered' | 'cancelled';

export interface DeliveryLine {
  id: ID;
  productId: ID;
  productSku: string;
  productName: string;
  orderedQuantity: Quantity;
  shippedQuantity: Quantity;
}

export interface Delivery extends DocumentBase {
  docType: Extract<DocType, 'delivery'>;
  status: DeliveryStatus;
  customer: PartyRef;
  salesOrderId: ID;
  salesOrderNumber: string;
  warehouseId: ID;
  warehouseName: string;
  scheduledDate: ISODate;
  shippedDate?: ISODate;
  carrier?: string;
  trackingNumber?: string;
  lines: DeliveryLine[];
}
