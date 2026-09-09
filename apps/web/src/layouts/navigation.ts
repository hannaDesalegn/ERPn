/**
 * Navigation definition.
 *
 * INFORMATION ARCHITECTURE DECISION
 * ---------------------------------
 * Grouped by BUSINESS FUNCTION (Sales, Purchasing, Inventory, Accounting), not
 * by data type. A user thinks "I need to check an order", not "I need the
 * sales_order table". Grouping by department also means each group maps to a
 * role, so hiding a whole section for a warehouse operator is natural.
 *
 * Every item declares the permission that reveals it. Sections with no visible
 * children are hidden entirely — a nav full of dead ends teaches users to
 * distrust the menu.
 */

import type { Permission } from '@/domain';

export interface NavItem {
  label: string;
  to: string;
  permission?: Permission;
  /** Marks the item active for nested routes too. */
  matchPrefix?: string;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', to: '/', matchPrefix: '/' }],
  },
  {
    label: 'Sales',
    items: [
      { label: 'Sales orders', to: '/sales/orders', permission: 'sales:view' },
      { label: 'Customers', to: '/sales/customers', permission: 'customers:view' },
      { label: 'Invoices', to: '/sales/invoices', permission: 'invoices:view' },
      { label: 'Deliveries', to: '/sales/deliveries', permission: 'sales:view' },
    ],
  },
  {
    label: 'Purchasing',
    items: [
      { label: 'Purchase orders', to: '/purchasing/orders', permission: 'purchasing:view' },
      { label: 'Suppliers', to: '/purchasing/suppliers', permission: 'suppliers:view' },
      { label: 'Supplier bills', to: '/purchasing/bills', permission: 'invoices:view' },
      { label: 'Goods receipts', to: '/purchasing/receipts', permission: 'purchasing:view' },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Products', to: '/inventory/products', permission: 'inventory:view' },
      { label: 'Stock on hand', to: '/inventory/stock', permission: 'inventory:view' },
      { label: 'Stock movements', to: '/inventory/movements', permission: 'inventory:view' },
      { label: 'Warehouses', to: '/inventory/warehouses', permission: 'inventory:view' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { label: 'Payments', to: '/finance/payments', permission: 'payments:view' },
      { label: 'Chart of accounts', to: '/accounting/accounts', permission: 'accounting:view' },
      { label: 'Journal entries', to: '/accounting/journal', permission: 'accounting:view' },
      { label: 'Trial balance', to: '/accounting/trial-balance', permission: 'reports:financial' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Users & roles', to: '/admin/users', permission: 'admin:users' },
      { label: 'Audit log', to: '/admin/audit', permission: 'audit:view' },
    ],
  },
];
