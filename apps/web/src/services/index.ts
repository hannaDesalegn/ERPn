/**
 * The single import surface for data access.
 *
 * Components import { api } from '@/services' and never touch @/mocks directly.
 * That rule is what makes the mock-to-real-backend swap a contained change.
 */

export { NotFoundError, type ListParams, type Paginated } from './client';
export { resolveDocumentRefs, type RelatedDocument } from './sales.service';
export type { ProductWithStock } from './inventory.service';

import { setClock } from '@/lib/clock';
import { REFERENCE_TODAY } from '@/mocks/rng';

import { adminService } from './admin.service';
import { masterDataService } from './master-data.service';
import { dashboardService } from './dashboard.service';
import { financeService } from './finance.service';
import { inventoryService } from './inventory.service';
import { partiesService } from './parties.service';
import { purchasingService } from './purchasing.service';
import { salesService } from './sales.service';

/**
 * MOCK-ONLY: point the application clock at the fixture anchor.
 *
 * The fixtures are generated around a fixed date, so relative timestamps and
 * overdue calculations must be measured from that same date. Delete this line
 * when the real backend lands and the default system clock takes over.
 */
setClock(() => REFERENCE_TODAY);

export const api = {
  dashboard: dashboardService,
  sales: salesService,
  purchasing: purchasingService,
  inventory: inventoryService,
  parties: partiesService,
  finance: financeService,
  admin: adminService,
  masterData: masterDataService,
};

/**
 * Query keys for TanStack Query, centralised.
 *
 * Centralising them is not bureaucracy — it is what makes cross-module
 * invalidation correct. When posting an invoice eventually becomes a mutation,
 * it must invalidate the customer's balance, the receivables aging, AND the
 * dashboard. Scattered inline key arrays make that impossible to get right,
 * and stale financial figures are worse than slow ones.
 */
export const queryKeys = {
  dashboard: ['dashboard'] as const,
  salesOrders: (params?: unknown) => ['sales', 'orders', params] as const,
  salesOrder: (id: string) => ['sales', 'orders', id] as const,
  salesOrderAudit: (id: string) => ['sales', 'orders', id, 'audit'] as const,
  deliveries: (params?: unknown) => ['sales', 'deliveries', params] as const,
  purchaseOrders: (params?: unknown) => ['purchasing', 'orders', params] as const,
  purchaseOrder: (id: string) => ['purchasing', 'orders', id] as const,
  goodsReceipts: (params?: unknown) => ['purchasing', 'receipts', params] as const,
  products: (params?: unknown) => ['inventory', 'products', params] as const,
  product: (id: string) => ['inventory', 'products', id] as const,
  productStock: (id: string) => ['inventory', 'products', id, 'stock'] as const,
  stockLevels: (params?: unknown) => ['inventory', 'levels', params] as const,
  stockMoves: (params?: unknown) => ['inventory', 'moves', params] as const,
  warehouses: ['inventory', 'warehouses'] as const,
  /** The real read, kept apart from the fixture one above until inventory's endpoints land. */
  warehouseOptions: ['master-data', 'warehouses'] as const,
  customerOptions: ['master-data', 'customers'] as const,
  productOptions: ['master-data', 'products'] as const,
  warehouseStats: ['inventory', 'warehouses', 'stats'] as const,
  adjustments: ['inventory', 'adjustments'] as const,
  adjustment: (id: string) => ['inventory', 'adjustments', id] as const,
  deliveries2: (params?: unknown) => ['sales', 'deliveries', params] as const,
  delivery: (id: string) => ['sales', 'deliveries', id] as const,
  goodsReceipt: (id: string) => ['purchasing', 'receipts', id] as const,
  customers: (params?: unknown) => ['parties', 'customers', params] as const,
  customer: (id: string) => ['parties', 'customers', id] as const,
  customerActivity: (id: string) => ['parties', 'customers', id, 'activity'] as const,
  suppliers: (params?: unknown) => ['parties', 'suppliers', params] as const,
  supplier: (id: string) => ['parties', 'suppliers', id] as const,
  supplierActivity: (id: string) => ['parties', 'suppliers', id, 'activity'] as const,
  customerInvoices: (params?: unknown) => ['finance', 'invoices', params] as const,
  customerInvoice: (id: string) => ['finance', 'invoices', id] as const,
  supplierBills: (params?: unknown) => ['finance', 'bills', params] as const,
  supplierBill: (id: string) => ['finance', 'bills', id] as const,
  payments: (params?: unknown) => ['finance', 'payments', params] as const,
  payment: (id: string) => ['finance', 'payments', id] as const,
  chartOfAccounts: ['accounting', 'accounts'] as const,
  journalEntries: (params?: unknown) => ['accounting', 'journal', params] as const,
  journalEntry: (id: string) => ['accounting', 'journal', id] as const,
  trialBalance: ['accounting', 'trial-balance'] as const,
  generalLedger: (accountId: string) => ['accounting', 'ledger', accountId] as const,
  auditEvents: (params?: unknown) => ['admin', 'audit', params] as const,
  auditForDocument: (id: string) => ['admin', 'audit', 'doc', id] as const,
  recentActivity: ['admin', 'activity'] as const,
  users: ['admin', 'users'] as const,
};
