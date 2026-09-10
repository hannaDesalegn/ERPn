/**
 * The permission catalogue and the default role templates.
 *
 * Contract section 2.7: the permission catalogue is code, roles are data owned by each company.
 * This file is the code half. It is the single authority for which capability strings exist, and
 * nothing may grant a string that is not listed here.
 *
 * NOTHING HERE IS NEW. The vocabulary is the one section 6.2 carries forward from the existing
 * model, and the six role shapes are the ones section 2.7 names. A drift test compares both
 * against the frontend definitions they came from, so this file and that one cannot diverge
 * quietly while the frontend still holds its own copy. If a capability is genuinely missing for
 * some new operation, adding it is an amendment, not an implementation detail.
 *
 * WHY `resource:action` AND WHY THE VERBS ARE SPLIT. Section 6.2 keeps `create` separate from
 * `confirm`, `approve` and `post` because that split is what encodes segregation of duties. The
 * person who raises a purchase order must not be the one who approves it. Collapsing them into a
 * single `purchasing:write` would read as tidier and would remove a fraud control.
 */

/**
 * Every capability the system recognises. A closed list.
 *
 * Ordered by resource so that a reviewer reading a diff can see what a change actually adds.
 */
export const PERMISSIONS = [
  // Sales
  'sales:view',
  'sales:create',
  'sales:confirm',
  'sales:cancel',
  // Purchasing
  'purchasing:view',
  'purchasing:create',
  'purchasing:approve',
  // Inventory
  'inventory:view',
  'inventory:move',
  'inventory:adjust',
  // Parties
  'customers:view',
  'customers:edit',
  'suppliers:view',
  'suppliers:edit',
  // Billing
  'invoices:view',
  'invoices:create',
  'invoices:post',
  'payments:view',
  'payments:register',
  // Accounting
  'accounting:view',
  'accounting:post',
  'accounting:close_period',
  // Reporting and administration
  'reports:view',
  'reports:financial',
  'admin:users',
  'admin:settings',
  'audit:view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const CATALOGUE: ReadonlySet<string> = new Set(PERMISSIONS);

/**
 * Whether a string names a capability that exists.
 *
 * Section 2.7 requires two checks that catch different failures, and both call this. On write, a
 * permission absent from the catalogue is rejected, so configuration cannot invent a capability.
 * At startup, every stored permission is checked, so a capability removed in a release surfaces
 * immediately instead of silently granting nothing to whoever still holds it.
 */
export function isPermission(value: string): value is Permission {
  return CATALOGUE.has(value);
}

export const ROLE_KEYS = [
  'administrator',
  'manager',
  'sales',
  'purchasing',
  'warehouse',
  'accountant',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

export interface RoleTemplate {
  key: RoleKey;
  name: string;
  description: string;
  permissions: readonly Permission[];
}

/**
 * What a company starts with, per section 2.7.
 *
 * Templates, not shared rows. They are copied into a company when it is created and are that
 * company's own from that moment, so editing one affects nobody else. That is the whole reason
 * roles are data and the catalogue is code.
 *
 * Read these as a description of how a distribution business divides responsibility, and note
 * especially who does NOT get what. Sales can confirm an order and cannot post an invoice.
 * Purchasing can raise a purchase order and cannot approve one. Warehouse can move stock and
 * cannot see a price. The accountant posts to the ledger and cannot create sales orders.
 */
export const ROLE_TEMPLATES: Readonly<Record<RoleKey, RoleTemplate>> = {
  administrator: {
    key: 'administrator',
    name: 'Administrator',
    description: 'Full system access, including user management and settings.',
    permissions: [
      'sales:view',
      'sales:create',
      'sales:confirm',
      'sales:cancel',
      'purchasing:view',
      'purchasing:create',
      'purchasing:approve',
      'inventory:view',
      'inventory:move',
      'inventory:adjust',
      'customers:view',
      'customers:edit',
      'suppliers:view',
      'suppliers:edit',
      'invoices:view',
      'invoices:create',
      'invoices:post',
      'payments:view',
      'payments:register',
      'accounting:view',
      'accounting:post',
      'accounting:close_period',
      'reports:view',
      'reports:financial',
      'admin:users',
      'admin:settings',
      'audit:view',
    ],
  },

  manager: {
    key: 'manager',
    name: 'Operations Manager',
    description: 'Sees everything and approves spending, but does not keep the books.',
    permissions: [
      'sales:view',
      'sales:create',
      'sales:confirm',
      'sales:cancel',
      'purchasing:view',
      'purchasing:create',
      'purchasing:approve',
      'inventory:view',
      'inventory:adjust',
      'customers:view',
      'customers:edit',
      'suppliers:view',
      'suppliers:edit',
      'invoices:view',
      'payments:view',
      'accounting:view',
      'reports:view',
      'reports:financial',
      'audit:view',
    ],
  },

  sales: {
    key: 'sales',
    name: 'Sales Representative',
    description: 'Manages customers and orders. Cannot post invoices or take payments.',
    permissions: [
      'sales:view',
      'sales:create',
      'sales:confirm',
      'customers:view',
      'customers:edit',
      // Needs to see stock to promise a delivery date, and cannot change it.
      'inventory:view',
      // Needs to see whether a customer has paid, and cannot post or collect.
      'invoices:view',
      'reports:view',
    ],
  },

  purchasing: {
    key: 'purchasing',
    name: 'Purchasing Officer',
    description: 'Raises purchase orders and manages suppliers. Approval sits with the manager.',
    permissions: [
      'purchasing:view',
      'purchasing:create',
      'suppliers:view',
      'suppliers:edit',
      'inventory:view',
      'reports:view',
    ],
  },

  warehouse: {
    key: 'warehouse',
    name: 'Warehouse Operator',
    description: 'Receives and ships goods, counts stock. No access to prices or finance.',
    permissions: [
      'inventory:view',
      'inventory:move',
      'inventory:adjust',
      // Read-only visibility of the orders they are fulfilling.
      'sales:view',
      'purchasing:view',
    ],
  },

  accountant: {
    key: 'accountant',
    name: 'Accountant',
    description: 'Owns invoices, payments and the general ledger.',
    permissions: [
      'invoices:view',
      'invoices:create',
      'invoices:post',
      'payments:view',
      'payments:register',
      'accounting:view',
      'accounting:post',
      'accounting:close_period',
      'customers:view',
      'suppliers:view',
      'sales:view',
      'purchasing:view',
      'inventory:view',
      'reports:view',
      'reports:financial',
      'audit:view',
    ],
  },
};

export const ROLE_TEMPLATE_LIST: readonly RoleTemplate[] = ROLE_KEYS.map(
  (key) => ROLE_TEMPLATES[key],
);

/**
 * The permissions a template grants, as a set.
 *
 * Used by the matrix test to compute an expected answer for every role against every route,
 * rather than restating the matrix by hand where it could be made to agree with a bug.
 */
export function templatePermissions(key: RoleKey): ReadonlySet<Permission> {
  return new Set(ROLE_TEMPLATES[key].permissions);
}
