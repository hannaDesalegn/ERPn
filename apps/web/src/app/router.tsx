/**
 * Route table.
 *
 * Document URLs are stable and guessable (/sales/orders/so-001) because people
 * share them: "look at SO-2026-0043" should be a link.
 *
 * Every route below resolves to a real screen built against the domain model,
 * with one exception, noted at the bottom.
 *
 * PERMISSIONS ARE DECLARED HERE, next to the element each one guards, and every route that shows
 * business data carries one. The dashboard does not, because it is where an authenticated person
 * lands and it renders only the sections their permissions already allow.
 *
 * This is presentation, not enforcement. The permission comes from `/me`, which reports rather
 * than authorizes, and the server re-checks every request the page makes. Criterion 23 asks for a
 * forbidden screen instead of a rendered page, which is what these give; criterion 8 is what
 * makes the system safe, and it lives in the API.
 */

import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/layouts/AppShell';
import { Protected } from '@/app/Protected';

import { DashboardPage } from '@/features/dashboard/DashboardPage';

import { SalesOrdersPage } from '@/features/sales/SalesOrdersPage';
import { SalesOrderCreatePage } from '@/features/sales/SalesOrderCreatePage';
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
        <Route
          path="/sales/orders"
          element={<Protected permission="sales:view"><SalesOrdersPage /></Protected>}
        />
        {/* Before the :id route, so "new" is not read as an identifier. */}
        <Route
          path="/sales/orders/new"
          element={<Protected permission="sales:create"><SalesOrderCreatePage /></Protected>}
        />
        <Route
          path="/sales/orders/:id"
          element={<Protected permission="sales:view"><SalesOrderDetailPage /></Protected>}
        />
        <Route
          path="/sales/customers"
          element={<Protected permission="customers:view"><CustomersPage /></Protected>}
        />
        <Route
          path="/sales/customers/:id"
          element={<Protected permission="customers:view"><CustomerDetailPage /></Protected>}
        />
        <Route
          path="/sales/invoices"
          element={<Protected permission="invoices:view"><InvoicesPage /></Protected>}
        />
        <Route
          path="/sales/invoices/:id"
          element={<Protected permission="invoices:view"><InvoiceDetailPage /></Protected>}
        />
        <Route
          path="/sales/deliveries"
          element={<Protected permission="sales:view"><DeliveriesPage /></Protected>}
        />
        <Route
          path="/sales/deliveries/:id"
          element={<Protected permission="sales:view"><DeliveryDetailPage /></Protected>}
        />

        {/* ---- Purchasing ---- */}
        <Route
          path="/purchasing/orders"
          element={<Protected permission="purchasing:view"><PurchaseOrdersPage /></Protected>}
        />
        <Route
          path="/purchasing/orders/:id"
          element={<Protected permission="purchasing:view"><PurchaseOrderDetailPage /></Protected>}
        />
        <Route
          path="/purchasing/suppliers"
          element={<Protected permission="suppliers:view"><SuppliersPage /></Protected>}
        />
        <Route
          path="/purchasing/suppliers/:id"
          element={<Protected permission="suppliers:view"><SupplierDetailPage /></Protected>}
        />
        <Route
          path="/purchasing/bills"
          element={<Protected permission="invoices:view"><BillsPage /></Protected>}
        />
        <Route
          path="/purchasing/bills/:id"
          element={<Protected permission="invoices:view"><BillDetailPage /></Protected>}
        />
        <Route
          path="/purchasing/receipts"
          element={<Protected permission="purchasing:view"><GoodsReceiptsPage /></Protected>}
        />
        <Route
          path="/purchasing/receipts/:id"
          element={<Protected permission="purchasing:view"><GoodsReceiptDetailPage /></Protected>}
        />

        {/* ---- Inventory ---- */}
        <Route
          path="/inventory/products"
          element={<Protected permission="inventory:view"><ProductsPage /></Protected>}
        />
        <Route
          path="/inventory/products/:id"
          element={<Protected permission="inventory:view"><ProductDetailPage /></Protected>}
        />
        <Route
          path="/inventory/stock"
          element={<Protected permission="inventory:view"><StockOnHandPage /></Protected>}
        />
        <Route
          path="/inventory/movements"
          element={<Protected permission="inventory:view"><StockMovementsPage /></Protected>}
        />
        <Route
          path="/inventory/warehouses"
          element={<Protected permission="inventory:view"><WarehousesPage /></Protected>}
        />
        <Route
          path="/inventory/adjustments/:id"
          element={<Protected permission="inventory:view"><AdjustmentDetailPage /></Protected>}
        />

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
            <Protected permission="inventory:view">
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
            </Protected>
          }
        />

        {/* ---- Finance and accounting ---- */}
        <Route
          path="/finance/payments"
          element={<Protected permission="payments:view"><PaymentsPage /></Protected>}
        />
        <Route
          path="/finance/payments/:id"
          element={<Protected permission="payments:view"><PaymentDetailPage /></Protected>}
        />
        <Route
          path="/accounting/accounts"
          element={<Protected permission="accounting:view"><ChartOfAccountsPage /></Protected>}
        />
        <Route
          path="/accounting/accounts/:id"
          element={<Protected permission="accounting:view"><GeneralLedgerPage /></Protected>}
        />
        <Route
          path="/accounting/journal"
          element={<Protected permission="accounting:view"><JournalEntriesPage /></Protected>}
        />
        <Route
          path="/accounting/journal/:id"
          element={<Protected permission="accounting:view"><JournalEntryDetailPage /></Protected>}
        />
        <Route
          path="/accounting/trial-balance"
          element={<Protected permission="reports:financial"><TrialBalancePage /></Protected>}
        />

        {/* ---- Admin ---- */}
        <Route
          path="/admin/users"
          element={<Protected permission="admin:users"><UsersPage /></Protected>}
        />
        <Route
          path="/admin/audit"
          element={<Protected permission="audit:view"><AuditLogPage /></Protected>}
        />

        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
