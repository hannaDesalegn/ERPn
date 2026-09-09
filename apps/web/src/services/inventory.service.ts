/** Inventory reads: products, derived stock levels, and the movement ledger. */

import type {
  InventoryAdjustment,
  LowStockAlert,
  Product,
  StockLevel,
  StockMove,
  Warehouse,
} from '@/domain';
import { db, LOW_STOCK, STOCK_BY_PRODUCT, INVENTORY_VALUE } from '@/mocks/db';
import { delay, NotFoundError, queryList, type ListParams, type Paginated } from './client';

export interface ProductWithStock extends Product {
  onHand: number;
  reserved: number;
  available: number;
  incoming: number;
  stockValue: { amount: number; currency: 'USD' | 'EUR' | 'ETB' };
}

/**
 * Products joined with their derived stock position.
 *
 * The join happens HERE, in the service, not in the component. A component that
 * assembles data from two sources ends up owning business logic, and the logic
 * then has to be duplicated on the next screen that needs the same view.
 */
function withStock(product: Product): ProductWithStock {
  const stock = STOCK_BY_PRODUCT.get(product.id);
  return {
    ...product,
    onHand: stock?.onHand ?? 0,
    reserved: stock?.reserved ?? 0,
    available: stock?.available ?? 0,
    incoming: stock?.incoming ?? 0,
    stockValue: stock?.valuation ?? { amount: 0, currency: 'USD' },
  };
}

export const inventoryService = {
  async listProducts(params: ListParams = {}): Promise<Paginated<ProductWithStock>> {
    const rows = db.products.map(withStock);
    return delay(
      queryList(rows, params, {
        searchFields: (p) => [p.sku, p.name, p.categoryName, p.barcode],
        filterAccessors: {
          categoryId: (p) => p.categoryId,
          type: (p) => p.type,
          active: (p) => String(p.active),
        },
        sortAccessors: {
          sku: (p) => p.sku,
          name: (p) => p.name,
          available: (p) => p.available,
          onHand: (p) => p.onHand,
          salesPrice: (p) => p.salesPrice.amount,
          stockValue: (p) => p.stockValue.amount,
        },
        defaultSort: { by: 'sku', dir: 'asc' },
      }),
    );
  },

  async getProduct(id: string): Promise<ProductWithStock> {
    const product = db.products.find((p) => p.id === id);
    if (!product) throw new NotFoundError('Product', id);
    return delay(withStock(product));
  },

  /** Per-warehouse breakdown for one product. */
  async getProductStock(productId: string): Promise<StockLevel[]> {
    return delay(db.stockLevels.filter((l) => l.productId === productId));
  },

  /** The movement ledger — the source of truth stock is derived from. */
  async listMovements(params: ListParams = {}): Promise<Paginated<StockMove>> {
    return delay(
      queryList(db.stockMoves, params, {
        searchFields: (m) => [m.productSku, m.productName, m.sourceDocument.docNumber, m.warehouseName],
        filterAccessors: {
          reason: (m) => m.reason,
          warehouseId: (m) => m.warehouseId,
          productId: (m) => m.productId,
          direction: (m) => (m.quantity >= 0 ? 'in' : 'out'),
        },
        sortAccessors: {
          occurredAt: (m) => m.occurredAt,
          quantity: (m) => m.quantity,
          product: (m) => m.productSku,
        },
        defaultSort: { by: 'occurredAt', dir: 'desc' },
      }),
    );
  },

  async listStockLevels(params: ListParams = {}): Promise<Paginated<StockLevel>> {
    return delay(
      queryList(db.stockLevels, params, {
        searchFields: (l) => [l.productSku, l.productName, l.warehouseName],
        filterAccessors: {
          warehouseId: (l) => l.warehouseId,
          state: (l) =>
            l.available <= 0 ? 'out' : l.available <= l.reorderPoint ? 'low' : 'ok',
        },
        sortAccessors: {
          product: (l) => l.productSku,
          onHand: (l) => l.onHand,
          available: (l) => l.available,
          valuation: (l) => l.valuation.amount,
        },
        defaultSort: { by: 'product', dir: 'asc' },
      }),
    );
  },

  async listWarehouses(): Promise<Warehouse[]> {
    return delay(db.warehouses);
  },

  /**
   * Warehouses with their aggregate position. The totals are computed here, in
   * the service, over the whole stock set rather than in the component over a
   * page of rows.
   */
  async listWarehousesWithStats(): Promise<
    (Warehouse & {
      skuCount: number;
      unitsOnHand: number;
      lowStockCount: number;
      stockValue: { amount: number; currency: 'USD' | 'EUR' | 'ETB' };
    })[]
  > {
    return delay(
      db.warehouses.map((warehouse) => {
        const levels = db.stockLevels.filter((l) => l.warehouseId === warehouse.id);
        return {
          ...warehouse,
          skuCount: levels.filter((l) => l.onHand > 0).length,
          unitsOnHand: levels.reduce((total, l) => total + Math.max(0, l.onHand), 0),
          lowStockCount: levels.filter((l) => l.available <= l.reorderPoint).length,
          stockValue: {
            amount: levels.reduce((total, l) => total + l.valuation.amount, 0),
            currency: 'USD' as const,
          },
        };
      }),
    );
  },

  async listAdjustments(): Promise<InventoryAdjustment[]> {
    return delay([...db.adjustments].sort((a, b) => b.countDate.localeCompare(a.countDate)));
  },

  async getAdjustment(id: string): Promise<InventoryAdjustment> {
    const adjustment = db.adjustments.find((a) => a.id === id);
    if (!adjustment) throw new NotFoundError('Inventory adjustment', id);
    return delay(adjustment);
  },

  async lowStock(limit?: number): Promise<LowStockAlert[]> {
    return delay(limit ? LOW_STOCK.slice(0, limit) : LOW_STOCK);
  },

  async inventoryValue() {
    return delay(INVENTORY_VALUE);
  },
};
