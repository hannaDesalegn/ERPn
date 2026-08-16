/**
 * The in-memory "database", plus the DERIVED read-models.
 *
 * Everything below the fixtures is a PROJECTION: computed from the event data,
 * never stored independently. This file is doing, in the browser, what the real
 * backend will do in SQL. Writing it this way proves the domain model actually
 * supports the numbers the UI wants to show — if a figure cannot be derived
 * here, the model is wrong, and better to find that out now.
 *
 * WHEN THE REAL BACKEND ARRIVES this whole file is deleted. The services layer
 * keeps its signatures and calls HTTP instead.
 */

import type {
  AgingBand,
  AgingSummary,
  CashPosition,
  Customer,
  LowStockAlert,
  Money,
  StockLevel,
  Supplier,
} from '@/domain';
import { money } from '@/domain';
import { add, multiply, subtract, sum, zero } from '@/lib/money';
import { daysUntil } from '@/lib/format';
import { ACCOUNTS, CASH_ACCOUNTS, CATEGORIES, USERS, WAREHOUSES } from './reference';
import { REFERENCE_TODAY } from './rng';
import {
  ADJUSTMENTS,
  AUDIT_EVENTS,
  CUSTOMERS,
  CUSTOMER_INVOICES,
  DELIVERIES,
  GOODS_RECEIPTS,
  JOURNAL_ENTRIES,
  PAYMENTS,
  PRODUCTS,
  PURCHASE_ORDERS,
  SALES_ORDERS,
  STOCK_MOVES,
  SUPPLIERS,
  SUPPLIER_BILLS,
} from './generate';

// ---------------------------------------------------------------------------
// STOCK LEVELS — derived by folding the movement ledger
// ---------------------------------------------------------------------------

function computeStockLevels(): StockLevel[] {
  const byKey = new Map<string, StockLevel>();

  for (const product of PRODUCTS) {
    if (product.type !== 'stockable') continue;
    for (const wh of WAREHOUSES) {
      byKey.set(`${product.id}|${wh.id}`, {
        productId: product.id,
        productSku: product.sku,
        productName: product.name,
        warehouseId: wh.id,
        warehouseName: wh.name,
        onHand: 0,
        reserved: 0,
        available: 0,
        incoming: 0,
        reorderPoint: product.reorderPoint,
        valuation: zero(),
      });
    }
  }

  // 1. On hand = sum of every signed movement.
  for (const move of STOCK_MOVES) {
    const level = byKey.get(`${move.productId}|${move.warehouseId}`);
    if (!level) continue;
    level.onHand += move.quantity;
    if (!level.lastMovementAt || move.occurredAt > level.lastMovementAt) {
      level.lastMovementAt = move.occurredAt;
    }
  }

  // 2. Reserved = confirmed sales order quantity not yet shipped.
  //    This is why `available` and `onHand` differ, and why a salesperson must
  //    be shown `available`.
  for (const so of SALES_ORDERS) {
    if (!['confirmed', 'partially_delivered'].includes(so.status)) continue;
    for (const line of so.lines) {
      const outstanding = line.quantity - line.deliveredQuantity;
      if (outstanding <= 0) continue;
      const level = byKey.get(`${line.productId}|${so.warehouseId}`);
      if (level) level.reserved += outstanding;
    }
  }

  // 3. Incoming = approved purchase order quantity not yet received.
  for (const po of PURCHASE_ORDERS) {
    if (!['approved', 'partially_received'].includes(po.status)) continue;
    for (const line of po.lines) {
      const outstanding = line.quantity - line.receivedQuantity;
      if (outstanding <= 0) continue;
      const level = byKey.get(`${line.productId}|${po.warehouseId}`);
      if (level) level.incoming += outstanding;
    }
  }

  // 4. Finalise derived fields.
  for (const level of byKey.values()) {
    level.available = level.onHand - level.reserved;
    const product = PRODUCTS.find((p) => p.id === level.productId)!;
    level.valuation = multiply(product.costPrice, Math.max(0, level.onHand));
  }

  return [...byKey.values()];
}

export const STOCK_LEVELS: StockLevel[] = computeStockLevels();

/** Company-wide position per product, summing across warehouses. */
export interface ProductStockSummary {
  productId: number extends never ? never : string;
  onHand: number;
  reserved: number;
  available: number;
  incoming: number;
  valuation: Money;
}

export const STOCK_BY_PRODUCT = new Map<string, ProductStockSummary>();
for (const level of STOCK_LEVELS) {
  const current = STOCK_BY_PRODUCT.get(level.productId) ?? {
    productId: level.productId,
    onHand: 0,
    reserved: 0,
    available: 0,
    incoming: 0,
    valuation: zero(),
  };
  current.onHand += level.onHand;
  current.reserved += level.reserved;
  current.available += level.available;
  current.incoming += level.incoming;
  current.valuation = add(current.valuation, level.valuation);
  STOCK_BY_PRODUCT.set(level.productId, current);
}

export const INVENTORY_VALUE: Money = sum(STOCK_LEVELS.map((l) => l.valuation));

/**
 * LOW STOCK — compared against each product's own reorder point, per warehouse.
 * `covered` marks shortfalls that an incoming purchase order already solves, so
 * the alert list shows what actually needs a human decision.
 */
export const LOW_STOCK: LowStockAlert[] = STOCK_LEVELS.filter((l) => l.available <= l.reorderPoint)
  .map((l) => {
    const product = PRODUCTS.find((p) => p.id === l.productId)!;
    const supplierId = { 'cat-1': 's-001', 'cat-2': 's-004', 'cat-3': 's-003', 'cat-4': 's-005', 'cat-5': 's-006' }[
      product.categoryId
    ];
    const supplier = SUPPLIERS.find((s) => s.id === supplierId);
    return {
      productId: l.productId,
      productSku: l.productSku,
      productName: l.productName,
      warehouseName: l.warehouseName,
      available: l.available,
      reorderPoint: l.reorderPoint,
      reorderQuantity: product.reorderQuantity,
      incoming: l.incoming,
      covered: l.available + l.incoming > l.reorderPoint,
      preferredSupplierId: supplier?.id,
      preferredSupplierName: supplier?.name,
    };
  })
  .sort((a, b) => a.available - a.reorderPoint - (b.available - b.reorderPoint));

// ---------------------------------------------------------------------------
// PARTY BALANCES — derived from posted invoices, not stored
// ---------------------------------------------------------------------------

for (const customer of CUSTOMERS) {
  const owing = CUSTOMER_INVOICES.filter(
    (i) => i.party.id === customer.id && i.status !== 'cancelled' && i.status !== 'draft',
  );
  customer.balance = sum(owing.map((i) => i.balanceDue));
}

for (const supplier of SUPPLIERS) {
  const owed = SUPPLIER_BILLS.filter(
    (b) => b.party.id === supplier.id && b.status !== 'cancelled' && b.status !== 'draft',
  );
  supplier.balance = sum(owed.map((b) => b.balanceDue));
}

// ---------------------------------------------------------------------------
// AGING
// ---------------------------------------------------------------------------

function bucketFor(dueDate: string): keyof Omit<AgingSummary, 'partyId' | 'partyName' | 'total' | 'oldestDueDate'> {
  const days = -daysUntil(dueDate, REFERENCE_TODAY); // positive = overdue by N days
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}

function buildAging(
  invoices: { party: { id: string; name: string }; dueDate: string; balanceDue: Money; status: string }[],
): AgingSummary[] {
  const byParty = new Map<string, AgingSummary>();
  for (const inv of invoices) {
    if (inv.balanceDue.amount <= 0) continue;
    if (inv.status === 'draft' || inv.status === 'cancelled') continue;
    const entry = byParty.get(inv.party.id) ?? {
      partyId: inv.party.id,
      partyName: inv.party.name,
      current: zero(),
      d1_30: zero(),
      d31_60: zero(),
      d61_90: zero(),
      d90_plus: zero(),
      total: zero(),
    };
    const bucket = bucketFor(inv.dueDate);
    entry[bucket] = add(entry[bucket], inv.balanceDue);
    entry.total = add(entry.total, inv.balanceDue);
    if (!entry.oldestDueDate || inv.dueDate < entry.oldestDueDate) entry.oldestDueDate = inv.dueDate;
    byParty.set(inv.party.id, entry);
  }
  return [...byParty.values()].sort((a, b) => b.total.amount - a.total.amount);
}

export const RECEIVABLES_AGING: AgingSummary[] = buildAging(CUSTOMER_INVOICES);
export const PAYABLES_AGING: AgingSummary[] = buildAging(SUPPLIER_BILLS);

function toBands(rows: AgingSummary[]): AgingBand[] {
  return [
    { bucket: 'current', label: 'Not yet due', amount: sum(rows.map((r) => r.current)) },
    { bucket: '1_30', label: '1 to 30 days', amount: sum(rows.map((r) => r.d1_30)) },
    { bucket: '31_60', label: '31 to 60 days', amount: sum(rows.map((r) => r.d31_60)) },
    { bucket: '61_90', label: '61 to 90 days', amount: sum(rows.map((r) => r.d61_90)) },
    { bucket: '90_plus', label: '90+ days', amount: sum(rows.map((r) => r.d90_plus)) },
  ];
}

export const RECEIVABLES_BANDS = toBands(RECEIVABLES_AGING);
export const PAYABLES_BANDS = toBands(PAYABLES_AGING);

export const TOTAL_RECEIVABLE: Money = sum(RECEIVABLES_AGING.map((r) => r.total));
export const TOTAL_PAYABLE: Money = sum(PAYABLES_AGING.map((r) => r.total));

// ---------------------------------------------------------------------------
// CASH
// ---------------------------------------------------------------------------

export const CASH_POSITION: CashPosition = {
  accounts: CASH_ACCOUNTS.map((a) => ({ id: a.id, name: a.name, balance: a.balance })),
  total: sum(CASH_ACCOUNTS.map((a) => a.balance)),
};

// ---------------------------------------------------------------------------
// SALES / PURCHASE TOTALS AND TRENDS
// ---------------------------------------------------------------------------

const todayISO = REFERENCE_TODAY.toISOString().slice(0, 10);
const monthPrefix = todayISO.slice(0, 7);

function previousMonthPrefix(): string {
  const d = new Date(REFERENCE_TODAY);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

const countedSalesStatuses = ['confirmed', 'partially_delivered', 'delivered', 'invoiced'];
const countedSales = SALES_ORDERS.filter((so) => countedSalesStatuses.includes(so.status));

export const SALES_TODAY: Money = sum(countedSales.filter((s) => s.orderDate === todayISO).map((s) => s.subtotal));
export const SALES_THIS_MONTH: Money = sum(
  countedSales.filter((s) => s.orderDate.startsWith(monthPrefix)).map((s) => s.subtotal),
);
export const SALES_LAST_MONTH: Money = sum(
  countedSales.filter((s) => s.orderDate.startsWith(previousMonthPrefix())).map((s) => s.subtotal),
);

const countedPurchases = PURCHASE_ORDERS.filter((po) =>
  ['approved', 'partially_received', 'received', 'billed'].includes(po.status),
);
export const PURCHASES_THIS_MONTH: Money = sum(
  countedPurchases.filter((p) => p.orderDate.startsWith(monthPrefix)).map((p) => p.subtotal),
);
export const PURCHASES_LAST_MONTH: Money = sum(
  countedPurchases.filter((p) => p.orderDate.startsWith(previousMonthPrefix())).map((p) => p.subtotal),
);

/** Daily totals for the last `days` days, zero-filled so the chart has no gaps. */
function dailySeries(
  docs: { orderDate: string; subtotal: Money }[],
  days: number,
): { date: string; value: number }[] {
  const totals = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(REFERENCE_TODAY);
    d.setUTCDate(d.getUTCDate() - i);
    totals.set(d.toISOString().slice(0, 10), 0);
  }
  for (const doc of docs) {
    if (totals.has(doc.orderDate)) {
      totals.set(doc.orderDate, totals.get(doc.orderDate)! + doc.subtotal.amount / 100);
    }
  }
  return [...totals.entries()].map(([date, value]) => ({ date, value }));
}

export const SALES_TREND = dailySeries(countedSales, 30);
export const PURCHASE_TREND = dailySeries(countedPurchases, 30);

export const GROSS_MARGIN_THIS_MONTH: Money = (() => {
  const revenue = SALES_THIS_MONTH;
  const cost = sum(
    countedSales
      .filter((s) => s.orderDate.startsWith(monthPrefix))
      .flatMap((s) =>
        s.lines.map((l) => {
          const product = PRODUCTS.find((p) => p.id === l.productId);
          return product ? multiply(product.costPrice, l.quantity) : zero();
        }),
      ),
  );
  return subtract(revenue, cost);
})();

// ---------------------------------------------------------------------------
// PENDING WORK
// ---------------------------------------------------------------------------

export const PENDING_APPROVALS = PURCHASE_ORDERS.filter((po) => po.status === 'pending_approval');
export const OVERDUE_INVOICES = CUSTOMER_INVOICES.filter((i) => i.status === 'overdue');
export const OVERDUE_BILLS = SUPPLIER_BILLS.filter((b) => b.status === 'overdue');
export const UNMATCHED_BILLS = SUPPLIER_BILLS.filter(
  (b) => b.matchStatus !== 'matched' && b.balanceDue.amount > 0,
);
export const UNALLOCATED_PAYMENTS = PAYMENTS.filter((p) => p.unallocatedAmount.amount > 0);
export const CREDIT_EXCEEDED = CUSTOMERS.filter(
  (c) => c.active && c.balance.amount > c.creditLimit.amount,
);

// ---------------------------------------------------------------------------
// EXPORTED DATABASE HANDLE
// ---------------------------------------------------------------------------

export const db = {
  today: todayISO,
  accounts: ACCOUNTS,
  adjustments: ADJUSTMENTS,
  auditEvents: AUDIT_EVENTS,
  categories: CATEGORIES,
  customerInvoices: CUSTOMER_INVOICES,
  customers: CUSTOMERS,
  deliveries: DELIVERIES,
  goodsReceipts: GOODS_RECEIPTS,
  journalEntries: JOURNAL_ENTRIES,
  payments: PAYMENTS,
  products: PRODUCTS,
  purchaseOrders: PURCHASE_ORDERS,
  salesOrders: SALES_ORDERS,
  stockLevels: STOCK_LEVELS,
  stockMoves: STOCK_MOVES,
  supplierBills: SUPPLIER_BILLS,
  suppliers: SUPPLIERS,
  users: USERS,
  warehouses: WAREHOUSES,
};

export type Db = typeof db;

export { money, CUSTOMERS, SUPPLIERS };
export type { Customer, Supplier };
