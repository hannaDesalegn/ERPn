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

/**
 * The screens that read and write through the API. Every other screen renders fixtures.
 *
 * WHY THIS EXISTS. The application is shown to internship reviewers and security testers, who
 * cannot tell a fixture screen from a real one by looking, and a convincing screen of invented
 * figures is exactly what they would otherwise report as a finding. So the shell labels every
 * fixture screen, in the navigation and on the page, from this one list.
 *
 * Prefixes, so a document's detail, create and edit routes follow its list. Add a prefix when a
 * module's screens move onto the API, in the same change that deletes their fixture reads.
 */
export const SERVER_BACKED_PREFIXES: readonly string[] = ['/sales/orders'];

/**
 * Screens whose detail route reads the server while their list still does not.
 *
 * The customer invoice detail is real and reached from a real sales order; the invoice list has no
 * endpoint and stays sample data. So the pages beneath the prefix count as real and the prefix
 * itself does not.
 */
export const SERVER_BACKED_DETAIL_PREFIXES: readonly string[] = ['/sales/invoices'];

/** Whether the screen at this path shows fixture data rather than data from the server. */
export function showsSampleData(pathname: string): boolean {
  const real =
    SERVER_BACKED_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    ) ||
    SERVER_BACKED_DETAIL_PREFIXES.some(
      (prefix) => pathname.startsWith(`${prefix}/`) && pathname.length > prefix.length + 1,
    );

  return !real;
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
