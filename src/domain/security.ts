/**
 * Users, roles and permissions.
 *
 * ============================================================================
 * READ THIS BEFORE TRUSTING ANYTHING IN THIS FILE
 * ============================================================================
 * Frontend permission checks are a USABILITY feature, not a security feature.
 *
 * Hiding a button stops an honest warehouse clerk from wandering into the
 * accounting module by accident. It does not stop anyone from calling the API
 * directly. EVERY permission in this file must be enforced again on the server,
 * on every request. If the backend trusts a role sent by the client, the system
 * has no access control at all.
 *
 * We build it now anyway, because retrofitting permission awareness into an
 * existing UI means touching every screen. Designing the seam early is cheap.
 * ============================================================================
 *
 * MODEL: role-based access control (RBAC). Users hold roles; roles grant
 * permissions; permissions are checked. We use `resource:action` strings, which
 * is the same shape most backends (Django guardian, Odoo groups, Casbin) can map
 * onto.
 */

import type { ID, Stamps } from './primitives';

export type RoleKey =
  | 'administrator'
  | 'manager'
  | 'sales'
  | 'purchasing'
  | 'warehouse'
  | 'accountant';

/**
 * Permission strings.
 *
 * Note the split between `create/edit` and the state-changing verbs
 * (`confirm`, `post`, `approve`). That distinction IS the internal control:
 *
 *   SEGREGATION OF DUTIES — the person who raises a purchase order should not
 *   be the person who approves it, and the person who records an invoice should
 *   not be the person who releases the payment. Otherwise one employee can
 *   invent a supplier, order from it, approve it, and pay themselves.
 *
 * This is a real fraud control that ERPs exist to enforce, and it only works if
 * "create" and "approve" are separate permissions.
 */
export type Permission =
  // Sales
  | 'sales:view'
  | 'sales:create'
  | 'sales:confirm'
  | 'sales:cancel'
  // Purchasing
  | 'purchasing:view'
  | 'purchasing:create'
  | 'purchasing:approve'
  // Inventory
  | 'inventory:view'
  | 'inventory:move'
  | 'inventory:adjust'
  // Parties
  | 'customers:view'
  | 'customers:edit'
  | 'suppliers:view'
  | 'suppliers:edit'
  // Billing
  | 'invoices:view'
  | 'invoices:create'
  | 'invoices:post'
  | 'payments:view'
  | 'payments:register'
  // Accounting
  | 'accounting:view'
  | 'accounting:post'
  | 'accounting:close_period'
  // Reporting & admin
  | 'reports:view'
  | 'reports:financial'
  | 'admin:users'
  | 'admin:settings'
  | 'audit:view';

export interface Role {
  key: RoleKey;
  name: string;
  description: string;
  permissions: Permission[];
}

export interface User extends Stamps {
  id: ID;
  name: string;
  email: string;
  roleKey: RoleKey;
  jobTitle: string;
  /** Restricting a warehouse clerk to their own site is a common requirement. */
  warehouseIds?: ID[];
  active: boolean;
  lastLoginAt?: string;
}

/** The signed-in user as the UI sees them. */
export interface Session {
  user: User;
  role: Role;
  permissions: Set<Permission>;
}
