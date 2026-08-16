/**
 * Purchase cycle: Purchase Order -> Goods Receipt -> Supplier Bill -> Payment.
 *
 * This mirrors the sales cycle exactly, with the direction reversed. That
 * symmetry is not a coincidence — it is why ERP modules feel consistent once you
 * learn one of them.
 *
 * ERP CONCEPT — THREE-WAY MATCH
 * -----------------------------
 * Before paying a supplier, a controlled business checks that three documents
 * agree:
 *   1. the Purchase Order  (what we agreed to buy, at what price)
 *   2. the Goods Receipt   (what actually arrived)
 *   3. the Supplier Bill   (what they are charging us)
 *
 * If the bill says 100 units but only 95 arrived, you do not pay for 100. This
 * single control is one of the main reasons companies buy an ERP at all, and it
 * is only possible because these are three separate documents that link to each
 * other. `matchStatus` below is where the UI surfaces it.
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

export type PurchaseOrderStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'partially_received'
  | 'received'
  | 'billed'
  | 'cancelled';

/**
 * Note `pending_approval`, which the sales order does not have.
 *
 * Spending company money usually requires authorisation above a threshold,
 * whereas taking a customer order does not. This asymmetry is a real business
 * rule, and it is where the approvals queue on the dashboard comes from.
 * The threshold and the approver are BACKEND policy; the UI only renders state.
 */
export interface PurchaseOrderLine {
  id: ID;
  productId: ID;
  productSku: string;
  productName: string;
  quantity: Quantity;
  /** Agreed purchase price at order time, copied onto the line. */
  unitCost: Money;
  taxRatePercent: number;
  lineSubtotal: Money;
  lineTax: Money;
  lineTotal: Money;
  receivedQuantity: Quantity;
  billedQuantity: Quantity;
}

export interface PurchaseOrder extends DocumentBase {
  docType: Extract<DocType, 'purchase_order'>;
  status: PurchaseOrderStatus;
  supplier: PartyRef;
  orderDate: ISODate;
  expectedDate?: ISODate;
  warehouseId: ID;
  warehouseName: string;
  requestedBy: { id: ID; name: string };
  approvedBy?: { id: ID; name: string };
  approvedAt?: string;
  lines: PurchaseOrderLine[];
  subtotal: Money;
  taxTotal: Money;
  total: Money;
  currency: Money['currency'];
  billedTotal: Money;
}

export type GoodsReceiptStatus = 'draft' | 'received' | 'cancelled';

export interface GoodsReceiptLine {
  id: ID;
  productId: ID;
  productSku: string;
  productName: string;
  orderedQuantity: Quantity;
  receivedQuantity: Quantity;
  /** Arrived but rejected on inspection. Does not enter sellable stock. */
  rejectedQuantity: Quantity;
}

export interface GoodsReceipt extends DocumentBase {
  docType: Extract<DocType, 'goods_receipt'>;
  status: GoodsReceiptStatus;
  supplier: PartyRef;
  purchaseOrderId: ID;
  purchaseOrderNumber: string;
  warehouseId: ID;
  warehouseName: string;
  receivedDate: ISODate;
  receivedBy: { id: ID; name: string };
  supplierDeliveryNote?: string;
  lines: GoodsReceiptLine[];
}

/** Result of comparing PO / receipt / bill. Drives the payment-block warning. */
export type MatchStatus = 'matched' | 'quantity_variance' | 'price_variance' | 'not_matched';
