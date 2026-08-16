/**
 * Role definitions.
 *
 * This is CONFIGURATION, not mock data. When a real backend exists it will serve
 * the current user's permission list at login, and this file becomes the
 * fallback/dev definition. The `Permission` union in @/domain stays the contract.
 *
 * Read these role definitions as a description of how a real distribution
 * business divides responsibility. Note especially who does NOT get what:
 *   - sales can confirm an order but cannot post an invoice
 *   - purchasing can raise a PO but cannot approve one (that is the manager)
 *   - warehouse can move stock but cannot see a price or a customer balance
 *   - the accountant can post to the ledger but cannot create sales orders
 * That is segregation of duties. See the note in @/domain/security.
 */

import type { Permission, Role, RoleKey } from '@/domain';

export const ROLES: Record<RoleKey, Role> = {
  administrator: {
    key: 'administrator',
    name: 'Administrator',
    description: 'Full system access, including user management and settings.',
    permissions: [
      'sales:view', 'sales:create', 'sales:confirm', 'sales:cancel',
      'purchasing:view', 'purchasing:create', 'purchasing:approve',
      'inventory:view', 'inventory:move', 'inventory:adjust',
      'customers:view', 'customers:edit', 'suppliers:view', 'suppliers:edit',
      'invoices:view', 'invoices:create', 'invoices:post',
      'payments:view', 'payments:register',
      'accounting:view', 'accounting:post', 'accounting:close_period',
      'reports:view', 'reports:financial',
      'admin:users', 'admin:settings', 'audit:view',
    ],
  },

  manager: {
    key: 'manager',
    name: 'Operations Manager',
    description: 'Sees everything and approves spending, but does not keep the books.',
    permissions: [
      'sales:view', 'sales:create', 'sales:confirm', 'sales:cancel',
      'purchasing:view', 'purchasing:create', 'purchasing:approve',
      'inventory:view', 'inventory:adjust',
      'customers:view', 'customers:edit', 'suppliers:view', 'suppliers:edit',
      'invoices:view', 'payments:view',
      'accounting:view',
      'reports:view', 'reports:financial', 'audit:view',
    ],
  },

  sales: {
    key: 'sales',
    name: 'Sales Representative',
    description: 'Manages customers and orders. Cannot post invoices or take payments.',
    permissions: [
      'sales:view', 'sales:create', 'sales:confirm',
      'customers:view', 'customers:edit',
      // Needs to see stock to promise a delivery date, but cannot change it.
      'inventory:view',
      // Needs to see whether a customer has paid, but cannot post or collect.
      'invoices:view',
      'reports:view',
    ],
  },

  purchasing: {
    key: 'purchasing',
    name: 'Purchasing Officer',
    description: 'Raises purchase orders and manages suppliers. Approval sits with the manager.',
    permissions: [
      'purchasing:view', 'purchasing:create',
      'suppliers:view', 'suppliers:edit',
      'inventory:view',
      'reports:view',
    ],
  },

  warehouse: {
    key: 'warehouse',
    name: 'Warehouse Operator',
    description: 'Receives and ships goods, counts stock. No access to prices or finance.',
    permissions: [
      'inventory:view', 'inventory:move', 'inventory:adjust',
      // Read-only visibility of the orders they are fulfilling.
      'sales:view', 'purchasing:view',
    ],
  },

  accountant: {
    key: 'accountant',
    name: 'Accountant',
    description: 'Owns invoices, payments and the general ledger.',
    permissions: [
      'invoices:view', 'invoices:create', 'invoices:post',
      'payments:view', 'payments:register',
      'accounting:view', 'accounting:post', 'accounting:close_period',
      'customers:view', 'suppliers:view',
      'sales:view', 'purchasing:view', 'inventory:view',
      'reports:view', 'reports:financial', 'audit:view',
    ],
  },
};

export const ROLE_LIST: Role[] = Object.values(ROLES);

export function permissionsFor(roleKey: RoleKey): Set<Permission> {
  return new Set(ROLES[roleKey].permissions);
}
