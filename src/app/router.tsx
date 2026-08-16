/**
 * Route table.
 *
 * Document URLs are stable and guessable (/sales/orders/so-001) because people
 * share them: "look at SO-2026-0043" should be a link.
 *
 * Every route below resolves to a real screen built against the domain model,
 * with one exception, noted at the bottom.
 */

import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/layouts/AppShell';

import { DashboardPage } from '@/features/dashboard/DashboardPage';

import { SalesOrdersPage } from '@/features/sales/SalesOrdersPage';
import { SalesOrderDetailPage } from '@/features/sales/SalesOrderDetailPage';
import { CustomersPage } from '@/features/parties/CustomersPage';
import { CustomerDetailPage } from '@/features/parties/CustomerDetailPage';
import { InvoicesPage, InvoiceDetailPage } from '@/features/finance/InvoicesPage';
import { DeliveriesPage, DeliveryDetailPage, GoodsReceiptsPage, GoodsReceiptDetailPage } from '@/features/logistics/LogisticsPages';

import { PurchaseOrdersPage } from '@/features/purchasing/PurchaseOrdersPage';
import { PurchaseOrderDetailPage } from '@/features/purchasing/PurchaseOrderDetailPage';
import { SuppliersPage, SupplierDetailPage } from '@/features/parties/SuppliersPage';
import { BillsPage, BillDetailPage } from '@/features/purchasing/BillsPage';

import { ProductsPage, ProductDetailPage } from '@/features/inventory/ProductsPage';
import { StockOnHandPage, StockMovementsPage } from '@/features/inventory/StockPages';
import { WarehousesPage, AdjustmentDetailPage } from '@/features/inventory/WarehousesPage';

import { PaymentsPage, PaymentDetailPage } from '@/features/finance/PaymentsPage';
import {
  ChartOfAccountsPage,
  GeneralLedgerPage,
  JournalEntriesPage,
  JournalEntryDetailPage,
  TrialBalancePage,
} from '@/features/accounting/AccountingPages';

import { UsersPage, AuditLogPage } from '@/features/admin/AdminPages';

import { NotFoundPage, Placeholder } from '@/features/Placeholder';

export function AppRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />

        {/* ---- Sales ---- */}
        <Route path="/sales/orders" element={<SalesOrdersPage />} />
        <Route path="/sales/orders/:id" element={<SalesOrderDetailPage />} />
        <Route path="/sales/customers" element={<CustomersPage />} />
        <Route path="/sales/customers/:id" element={<CustomerDetailPage />} />
        <Route path="/sales/invoices" element={<InvoicesPage />} />
        <Route path="/sales/invoices/:id" element={<InvoiceDetailPage />} />
        <Route path="/sales/deliveries" element={<DeliveriesPage />} />
        <Route path="/sales/deliveries/:id" element={<DeliveryDetailPage />} />

        {/* ---- Purchasing ---- */}
        <Route path="/purchasing/orders" element={<PurchaseOrdersPage />} />
        <Route path="/purchasing/orders/:id" element={<PurchaseOrderDetailPage />} />
        <Route path="/purchasing/suppliers" element={<SuppliersPage />} />
        <Route path="/purchasing/suppliers/:id" element={<SupplierDetailPage />} />
        <Route path="/purchasing/bills" element={<BillsPage />} />
        <Route path="/purchasing/bills/:id" element={<BillDetailPage />} />
        <Route path="/purchasing/receipts" element={<GoodsReceiptsPage />} />
        <Route path="/purchasing/receipts/:id" element={<GoodsReceiptDetailPage />} />

        {/* ---- Inventory ---- */}
        <Route path="/inventory/products" element={<ProductsPage />} />
        <Route path="/inventory/products/:id" element={<ProductDetailPage />} />
        <Route path="/inventory/stock" element={<StockOnHandPage />} />
        <Route path="/inventory/movements" element={<StockMovementsPage />} />
        <Route path="/inventory/warehouses" element={<WarehousesPage />} />
        <Route path="/inventory/adjustments/:id" element={<AdjustmentDetailPage />} />

        {/*
          THE ONE REMAINING PLACEHOLDER.
          `StockTransfer` is typed, but nothing else about it is settled: there
          are no fixtures, the in-transit state has no owner, and moving stock
          between warehouses should probably produce two linked movements
          through a virtual in-transit location rather than the single signed
          quantity the rest of the module uses. Building a screen now would mean
          inventing that workflow, so it stays visibly unbuilt.
        */}
        <Route
          path="/inventory/transfers/:id"
          element={
            <Placeholder
              title="Stock transfer"
              icon="truck"
              purpose="Moving stock between our own warehouses."
              readyTypes={['StockTransfer', 'StockTransferLine', 'TransferStatus']}
              remaining={[
                'Decide whether transfers move through a virtual in-transit location',
                'Define who owns the in-transit state and who confirms receipt',
                'Generate fixtures once the workflow is settled',
              ]}
            />
          }
        />

        {/* ---- Finance and accounting ---- */}
        <Route path="/finance/payments" element={<PaymentsPage />} />
        <Route path="/finance/payments/:id" element={<PaymentDetailPage />} />
        <Route path="/accounting/accounts" element={<ChartOfAccountsPage />} />
        <Route path="/accounting/accounts/:id" element={<GeneralLedgerPage />} />
        <Route path="/accounting/journal" element={<JournalEntriesPage />} />
        <Route path="/accounting/journal/:id" element={<JournalEntryDetailPage />} />
        <Route path="/accounting/trial-balance" element={<TrialBalancePage />} />

        {/* ---- Admin ---- */}
        <Route path="/admin/users" element={<UsersPage />} />
        <Route path="/admin/audit" element={<AuditLogPage />} />

        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
