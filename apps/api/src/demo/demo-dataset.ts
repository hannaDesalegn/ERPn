/**
 * The demo environment, as data.
 *
 * WHAT THIS IS FOR. A freshly migrated database has no tenant, no company and no account, so there
 * is nothing to sign in to and nothing to sell. This file describes the smallest environment in
 * which the real workflow can be shown and tested from a browser: two tenants, two companies
 * under one of them, an account per role that matters, customers, products, a warehouse per
 * company, and opening stock large enough to confirm an order against.
 *
 * DETERMINISTIC ON PURPOSE. Every identifier is a literal, so the documented environment is the
 * same one on every machine and a tester can write an identifier from another company into a
 * request and know exactly whose record it is. Nothing here reads the clock or a random source.
 *
 * CODES COLLIDE ACROSS COMPANIES ON PURPOSE. Every company has a `CUST-001` and a `SKU-1001`,
 * with different names and different stock. Criterion 14 of architecture section 17 asks for
 * deliberately colliding data when isolation is tested, because a leak between two companies whose
 * records look alike is the one nobody notices on screen.
 *
 * NOTHING HERE IS A SECRET. There is no password in this file. The seed takes one from the
 * environment and refuses to run in production, see `seed-environment.ts`.
 *
 * NAMES ARE INVENTED. The tenants, companies, customers and people below do not exist.
 */

import type { RoleKey } from '../authorization/permissions.js';

/**
 * A deterministic identifier in a group.
 *
 * Version 4 and variant 8 bits are set, so the value passes every UUID check in the request
 * schemas rather than only the loose pattern the scope constructors use.
 */
function demoId(group: string, n: number): string {
  return `${group}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export type DemoUserKey = 'admin' | 'sales' | 'accountant' | 'warehouse' | 'trading-admin';

export interface DemoUser {
  key: DemoUserKey;
  id: string;
  /** The `.test` domain is reserved and never resolves, so no mail can reach a real person. */
  email: string;
  name: string;
}

export interface DemoMember {
  user: DemoUserKey;
  role: RoleKey;
}

export interface DemoCustomer {
  id: string;
  code: string;
  name: string;
  taxRegistrationNumber: string | null;
}

export interface DemoProduct {
  id: string;
  sku: string;
  name: string;
  stockingUom: string;
  /** Six decimal places, the scale the column holds. */
  salesPrice: string;
  /** Opening quantity in the stocking unit, in the company's default warehouse. */
  openingStock: string;
}

export interface DemoWarehouse {
  id: string;
  code: string;
  name: string;
}

export interface DemoCompany {
  id: string;
  name: string;
  legalName: string;
  baseCurrency: string;
  /**
   * The account company provisioning makes the first administrator.
   *
   * Every other member is admitted afterwards and given their role by this person, through the
   * same role assignment the administration endpoint uses.
   */
  administrator: DemoUserKey;
  members: DemoMember[];
  warehouse: DemoWarehouse;
  customers: DemoCustomer[];
  products: DemoProduct[];
  /**
   * The source document every opening stock movement for this company names.
   *
   * Section 8.1 allows no movement without a causing document. Opening stock is one load, so it
   * is one document identifier per company rather than one per product.
   */
  openingStockDocumentId: string;
}

export interface DemoTenant {
  id: string;
  slug: string;
  name: string;
  companies: DemoCompany[];
}

/** The source document type opening stock movements carry. */
export const OPENING_STOCK_DOC_TYPE = 'opening_stock';

/**
 * The reason opening stock movements carry.
 *
 * One of the eight the ledger accepts. None of them names an opening balance, and inventing one
 * would be a migration; an adjustment is what bringing a counted quantity into the books is.
 */
export const OPENING_STOCK_REASON = 'adjustment';

export const DEMO_USERS: readonly DemoUser[] = [
  { key: 'admin', id: demoId('de000003', 1), email: 'demo-admin@erp.test', name: 'Dana Admin' },
  { key: 'sales', id: demoId('de000003', 2), email: 'demo-sales@erp.test', name: 'Sam Sales' },
  {
    key: 'accountant',
    id: demoId('de000003', 3),
    email: 'demo-accountant@erp.test',
    name: 'Alex Accountant',
  },
  {
    key: 'warehouse',
    id: demoId('de000003', 4),
    email: 'demo-warehouse@erp.test',
    name: 'Wren Warehouse',
  },
  {
    key: 'trading-admin',
    id: demoId('de000003', 5),
    email: 'demo-trading-admin@erp.test',
    name: 'Terry Trading',
  },
];

export const DEMO_TENANTS: readonly DemoTenant[] = [
  {
    id: demoId('de000001', 1),
    slug: 'demo-distribution',
    name: 'Demo Distribution Group',
    companies: [
      {
        id: demoId('de000002', 1),
        name: 'Demo Distribution East',
        legalName: 'Demo Distribution East LLC',
        baseCurrency: 'USD',
        administrator: 'admin',
        members: [
          { user: 'sales', role: 'sales' },
          { user: 'accountant', role: 'accountant' },
          { user: 'warehouse', role: 'warehouse' },
        ],
        warehouse: { id: demoId('de000004', 1), code: 'WH-MAIN', name: 'East Main Warehouse' },
        customers: [
          {
            id: demoId('de000005', 0x101),
            code: 'CUST-001',
            name: 'Harbor Office Supplies',
            taxRegistrationNumber: 'US-11-2233445',
          },
          {
            id: demoId('de000005', 0x102),
            code: 'CUST-002',
            name: 'Lakeside School District',
            taxRegistrationNumber: null,
          },
          {
            id: demoId('de000005', 0x103),
            code: 'CUST-003',
            name: 'Northgate Clinics',
            taxRegistrationNumber: 'US-44-5566778',
          },
        ],
        products: [
          {
            id: demoId('de000006', 0x101),
            sku: 'SKU-1001',
            name: 'Copy paper A4 80gsm, box of 5 reams',
            stockingUom: 'box',
            salesPrice: '24.500000',
            openingStock: '400',
          },
          {
            id: demoId('de000006', 0x102),
            sku: 'SKU-1002',
            name: 'Ballpoint pens blue, box of 50',
            stockingUom: 'box',
            salesPrice: '6.750000',
            openingStock: '250',
          },
          {
            id: demoId('de000006', 0x103),
            sku: 'SKU-1003',
            name: 'Heavy duty stapler',
            stockingUom: 'unit',
            salesPrice: '18.990000',
            openingStock: '120',
          },
          {
            // Deliberately short, so an oversell refusal can be shown without first selling
            // four hundred boxes of paper.
            id: demoId('de000006', 0x104),
            sku: 'SKU-1004',
            name: 'Archive storage box',
            stockingUom: 'unit',
            salesPrice: '3.250000',
            openingStock: '5',
          },
        ],
        openingStockDocumentId: demoId('de000007', 1),
      },
      {
        id: demoId('de000002', 2),
        name: 'Demo Distribution West',
        legalName: 'Demo Distribution West LLC',
        baseCurrency: 'USD',
        administrator: 'admin',
        // Sales works in both companies, so switching is something a non-administrator can show.
        // The accountant and the warehouse operator are not members here, so entering this
        // company is something they can be shown to be refused.
        members: [{ user: 'sales', role: 'sales' }],
        warehouse: { id: demoId('de000004', 2), code: 'WH-MAIN', name: 'West Main Warehouse' },
        customers: [
          {
            id: demoId('de000005', 0x201),
            code: 'CUST-001',
            name: 'Canyon Hardware Co',
            taxRegistrationNumber: 'US-77-8899001',
          },
          {
            id: demoId('de000005', 0x202),
            code: 'CUST-002',
            name: 'Pacific Print House',
            taxRegistrationNumber: null,
          },
        ],
        products: [
          {
            id: demoId('de000006', 0x201),
            sku: 'SKU-1001',
            name: 'Copy paper Letter 20lb, box of 10 reams',
            stockingUom: 'box',
            salesPrice: '39.000000',
            openingStock: '150',
          },
          {
            id: demoId('de000006', 0x202),
            sku: 'SKU-2001',
            name: 'Packing tape, roll',
            stockingUom: 'unit',
            salesPrice: '2.400000',
            openingStock: '600',
          },
        ],
        openingStockDocumentId: demoId('de000007', 2),
      },
    ],
  },
  {
    id: demoId('de000001', 2),
    slug: 'demo-trading',
    name: 'Demo Trading Ltd',
    companies: [
      {
        id: demoId('de000002', 3),
        name: 'Demo Trading',
        legalName: 'Demo Trading Ltd',
        baseCurrency: 'USD',
        administrator: 'trading-admin',
        members: [],
        warehouse: { id: demoId('de000004', 3), code: 'WH-MAIN', name: 'Trading Warehouse' },
        customers: [
          {
            id: demoId('de000005', 0x301),
            code: 'CUST-001',
            name: 'Riverbend Retail',
            taxRegistrationNumber: null,
          },
        ],
        products: [
          {
            id: demoId('de000006', 0x301),
            sku: 'SKU-1001',
            name: 'Thermal receipt rolls, box of 50',
            stockingUom: 'box',
            salesPrice: '31.200000',
            openingStock: '80',
          },
        ],
        openingStockDocumentId: demoId('de000007', 3),
      },
    ],
  },
];

export function demoUser(key: DemoUserKey): DemoUser {
  const user = DEMO_USERS.find((candidate) => candidate.key === key);
  if (!user) throw new Error(`No demo user with key ${key}`);
  return user;
}

/** Every company in the dataset, with the tenant it belongs to. */
export function demoCompanies(): { tenant: DemoTenant; company: DemoCompany }[] {
  return DEMO_TENANTS.flatMap((tenant) =>
    tenant.companies.map((company) => ({ tenant, company })),
  );
}

/**
 * The membership identifier a demo user holds in a demo company.
 *
 * Deterministic like everything else, derived from the positions of the tenant, company and user
 * so that no second table of identifiers has to be kept in step with the one above. Company
 * provisioning mints the first administrator's membership itself, so that one is not derived.
 */
export function demoMembershipId(companyId: string, userKey: DemoUserKey): string {
  const companyIndex = demoCompanies().findIndex(({ company }) => company.id === companyId);
  const userIndex = DEMO_USERS.findIndex((user) => user.key === userKey);
  if (companyIndex < 0 || userIndex < 0) {
    throw new Error(`No demo membership for ${userKey} in ${companyId}`);
  }
  return demoId('de000008', (companyIndex + 1) * 0x100 + userIndex + 1);
}
