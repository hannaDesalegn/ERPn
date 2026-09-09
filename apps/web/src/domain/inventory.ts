/**
 * Inventory: warehouses, stock movements, and derived stock levels.
 *
 * THE CENTRAL IDEA OF THIS FILE
 * -----------------------------
 * Inventory is an append-only LEDGER, exactly like accounting.
 *
 * You never "set" a quantity. You record a MOVEMENT: 50 units arrived at the
 * main warehouse from supplier X on this date, referencing goods receipt GR-0012.
 * Quantity on hand is then *derived* by summing movements.
 *
 * Why this matters:
 *   - Every change has a cause you can point at (a document).
 *   - You can reconstruct stock as of any past date, which you need for
 *     valuation, audits, and year-end closing.
 *   - Concurrent updates append rather than overwrite, so nothing is lost.
 *   - "Why do we have 47 and not 50?" becomes an answerable question.
 *
 * A manual correction is not an exception to this rule — it is an
 * `inventory_adjustment` document that produces its own movement, with a reason.
 * That is how a real system stays auditable while still allowing humans to fix
 * reality after a stock count.
 */

import type {
  DocType,
  DocumentBase,
  DocumentRef,
  ID,
  ISODate,
  ISODateTime,
  Money,
  Quantity,
  Stamps,
} from './primitives';

export interface Warehouse extends Stamps {
  id: ID;
  code: string;
  name: string;
  city: string;
  country: string;
  /** One warehouse is the default destination for purchases / source for sales. */
  isDefault: boolean;
  active: boolean;
}

/**
 * STOCK LOCATIONS (future extension, deliberately simplified today).
 *
 * Mature ERPs model movements between *locations*, not warehouses, and include
 * virtual locations such as "Supplier", "Customer", "Inventory Loss" and
 * "Production". Every movement then has both a source and a destination, and the
 * whole system becomes double-entry for goods — quantities are conserved, they
 * only move. Odoo works exactly this way.
 *
 * We model a single warehouse plus a signed quantity today, which is simpler to
 * read. `MovementReason` below preserves the information that a full
 * source/destination model would carry, so upgrading later is a migration of
 * this one type rather than a rewrite of the whole module.
 */
export type MovementReason =
  | 'purchase_receipt' // goods arrived from a supplier
  | 'sales_delivery' // goods shipped to a customer
  | 'transfer_in' // arrived from another of our warehouses
  | 'transfer_out' // left for another of our warehouses
  | 'adjustment' // physical count correction
  | 'customer_return'
  | 'supplier_return'
  | 'scrap'; // damaged / written off

/**
 * A single, immutable inventory fact.
 *
 * `quantity` is SIGNED: positive increases stock, negative decreases it.
 * Once written, a stock move is never edited. A mistake is corrected by
 * recording a compensating move, which leaves both facts visible in history.
 */
export interface StockMove {
  id: ID;
  productId: ID;
  productSku: string;
  productName: string;
  warehouseId: ID;
  warehouseName: string;
  /** Signed. +50 = received, -3 = shipped. */
  quantity: Quantity;
  reason: MovementReason;
  /**
   * Unit cost attached to this movement, used for inventory valuation.
   * Outbound moves carry the cost the units were valued at when they left,
   * which is what makes Cost of Goods Sold computable.
   */
  unitCost: Money;
  occurredAt: ISODateTime;
  /** The document that caused this movement. Never null in a healthy system. */
  sourceDocument: DocumentRef;
  createdBy: { id: ID; name: string };
}

/**
 * STOCK LEVEL — a read-only PROJECTION, not a stored record.
 *
 * The backend computes this by aggregating StockMove rows. The frontend must
 * never write it. Typing it as a separate read-model (rather than as fields on
 * Product) is what stops a future developer from "just updating the quantity".
 */
export interface StockLevel {
  productId: ID;
  productSku: string;
  productName: string;
  warehouseId: ID;
  warehouseName: string;
  /** Physically present right now. */
  onHand: Quantity;
  /**
   * RESERVED: promised to confirmed sales orders but not yet shipped.
   * Physically still on the shelf, but not sellable to anyone else.
   */
  reserved: Quantity;
  /**
   * AVAILABLE = onHand - reserved. This is the number a salesperson must see
   * before promising delivery. Showing onHand instead is how businesses
   * accidentally sell the same unit twice.
   */
  available: Quantity;
  /** Expected from confirmed purchase orders not yet received. */
  incoming: Quantity;
  reorderPoint: number;
  /** onHand x unit cost, using the product's costing method. */
  valuation: Money;
  lastMovementAt?: ISODateTime;
}

/** Row shape for the low-stock alert list. */
export interface LowStockAlert {
  productId: ID;
  productSku: string;
  productName: string;
  warehouseName: string;
  available: Quantity;
  reorderPoint: number;
  reorderQuantity: number;
  incoming: Quantity;
  /** True when a purchase order is already covering the shortfall. */
  covered: boolean;
  preferredSupplierId?: ID;
  preferredSupplierName?: string;
}

/** Moving stock between our own warehouses. Creates two movements (out, in). */
export type TransferStatus = 'draft' | 'in_transit' | 'received' | 'cancelled';

export interface StockTransferLine {
  id: ID;
  productId: ID;
  productSku: string;
  productName: string;
  quantity: Quantity;
}

export interface StockTransfer extends DocumentBase {
  docType: Extract<DocType, 'stock_transfer'>;
  status: TransferStatus;
  fromWarehouseId: ID;
  fromWarehouseName: string;
  toWarehouseId: ID;
  toWarehouseName: string;
  shippedDate?: ISODate;
  receivedDate?: ISODate;
  lines: StockTransferLine[];
}

/**
 * INVENTORY ADJUSTMENT — the audited way to correct reality.
 *
 * After a physical stock count, counted quantity rarely equals system quantity
 * (theft, breakage, mis-picks, data entry errors). The difference is recorded as
 * an adjustment with a REASON, which both fixes stock and creates an accounting
 * consequence: inventory value goes down and an expense account is charged.
 */
export type AdjustmentStatus = 'draft' | 'posted' | 'cancelled';

export interface InventoryAdjustmentLine {
  id: ID;
  productId: ID;
  productSku: string;
  productName: string;
  systemQuantity: Quantity;
  countedQuantity: Quantity;
  /** countedQuantity - systemQuantity. Signed. */
  difference: Quantity;
}

export interface InventoryAdjustment extends DocumentBase {
  docType: Extract<DocType, 'inventory_adjustment'>;
  status: AdjustmentStatus;
  warehouseId: ID;
  warehouseName: string;
  countDate: ISODate;
  reason: 'cycle_count' | 'annual_count' | 'damage' | 'theft' | 'correction';
  lines: InventoryAdjustmentLine[];
}
