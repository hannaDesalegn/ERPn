/**
 * Product catalog.
 *
 * NOTE THE MOST IMPORTANT ABSENCE IN THIS FILE:
 * `Product` has NO `quantityOnHand` field.
 *
 * Stock is not an attribute of a product — it is the running total of every
 * stock movement for that product in a given warehouse. See ./inventory.ts.
 * Putting a mutable quantity on the product is the single most common modelling
 * mistake in homemade ERPs: two users edit it concurrently, nobody can explain
 * why it changed, and you can never reconstruct history.
 */

import type { ID, Money, Stamps } from './primitives';

/**
 * Unit of measure. Real ERPs support conversion (buy in cases of 12, sell in
 * units). We model only the display unit today; a `UomConversion` type is the
 * natural extension point.
 */
export type Uom = 'unit' | 'kg' | 'litre' | 'box' | 'case' | 'metre';

export interface ProductCategory {
  id: ID;
  name: string;
  parentId?: ID;
}

/**
 * PRODUCT TYPE.
 *
 * ERP CONCEPT: only *stockable* products participate in inventory. A delivery
 * fee or a consulting hour is sellable and invoiceable but generates no stock
 * movement. Modelling this now prevents a whole class of bugs later, where the
 * system tries to reserve stock for a service line.
 */
export type ProductType = 'stockable' | 'service' | 'consumable';

export interface Product extends Stamps {
  id: ID;
  /** Stock Keeping Unit — the code humans use. */
  sku: string;
  name: string;
  type: ProductType;
  categoryId: ID;
  categoryName: string;
  uom: Uom;
  barcode?: string;

  /** Default price we sell at, before customer-specific discounts. */
  salesPrice: Money;

  /**
   * COST PRICE.
   *
   * ERP CONCEPT — inventory valuation. The value of stock on hand is
   * quantity x cost, and "cost" is a choice of policy, not a fact:
   *   - standard cost: a fixed planned cost, variances posted separately
   *   - average cost:  recalculated on each receipt (what we assume here)
   *   - FIFO:          each unit keeps the cost of the batch it arrived in
   * The chosen policy changes reported profit, so it is an accounting decision.
   * The BACKEND owns this calculation. The frontend only displays the result.
   */
  costPrice: Money;
  costingMethod: 'standard' | 'average' | 'fifo';

  /**
   * REORDER POINT.
   * When available quantity falls to or below this, the product should be
   * repurchased. This is what powers the "low stock" alert on the dashboard —
   * it is a business rule per product, not a hardcoded threshold like "< 10".
   */
  reorderPoint: number;
  reorderQuantity: number;

  active: boolean;
}
