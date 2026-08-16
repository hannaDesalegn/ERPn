/**
 * Reference / master data for the fixture set.
 *
 * Scenario: a wholesale distributor of electrical and industrial components.
 * Buys in bulk from manufacturers, holds stock in two warehouses, and sells on
 * credit to trade customers such as contractors and retailers.
 *
 * That business shape was chosen because it exercises every module honestly:
 * real purchasing, real multi-warehouse inventory, real receivables.
 */

import type {
  Account,
  AccountType,
  NormalBalance,
  PaymentTerms,
  ProductCategory,
  User,
  Warehouse,
} from '@/domain';
import { money } from '@/domain';
import { REFERENCE_TODAY, toISODateTime, daysAgo } from './rng';

const stamp = (who = { id: 'u-1', name: 'System' }) => ({
  createdAt: toISODateTime(daysAgo(400)),
  createdBy: who,
  updatedAt: toISODateTime(daysAgo(30)),
  updatedBy: who,
});

/**
 * The operating company.
 *
 * Left deliberately unbranded. Trading partners, products and staff below are
 * invented so the screens have realistic data to render, but the company itself
 * is a neutral placeholder until a real tenant name exists. There is no logo for
 * the same reason.
 */
export const COMPANY = {
  name: 'Company Name',
  legalName: 'Company Name Ltd.',
  taxId: 'TIN-4471902',
  baseCurrency: 'USD' as const,
  fiscalYearStart: '01-01',
};

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const USERS: User[] = [
  {
    id: 'u-1', name: 'Amara Tesfaye', email: 'amara@meridian.example',
    roleKey: 'administrator', jobTitle: 'Systems Administrator', active: true,
    lastLoginAt: toISODateTime(daysAgo(0)), ...stamp(),
  },
  {
    id: 'u-2', name: 'Daniel Roche', email: 'daniel@meridian.example',
    roleKey: 'manager', jobTitle: 'Operations Manager', active: true,
    lastLoginAt: toISODateTime(daysAgo(0)), ...stamp(),
  },
  {
    id: 'u-3', name: 'Sara Lindqvist', email: 'sara@meridian.example',
    roleKey: 'sales', jobTitle: 'Senior Sales Representative', active: true,
    lastLoginAt: toISODateTime(daysAgo(1)), ...stamp(),
  },
  {
    id: 'u-4', name: 'Kofi Mensah', email: 'kofi@meridian.example',
    roleKey: 'sales', jobTitle: 'Sales Representative', active: true,
    lastLoginAt: toISODateTime(daysAgo(2)), ...stamp(),
  },
  {
    id: 'u-5', name: 'Priya Raman', email: 'priya@meridian.example',
    roleKey: 'purchasing', jobTitle: 'Purchasing Officer', active: true,
    lastLoginAt: toISODateTime(daysAgo(1)), ...stamp(),
  },
  {
    id: 'u-6', name: 'Marcus Webb', email: 'marcus@meridian.example',
    roleKey: 'warehouse', jobTitle: 'Warehouse Supervisor', active: true,
    warehouseIds: ['wh-1'], lastLoginAt: toISODateTime(daysAgo(0)), ...stamp(),
  },
  {
    id: 'u-7', name: 'Elena Duarte', email: 'elena@meridian.example',
    roleKey: 'accountant', jobTitle: 'Financial Accountant', active: true,
    lastLoginAt: toISODateTime(daysAgo(0)), ...stamp(),
  },
  {
    id: 'u-8', name: 'Tom Becker', email: 'tom@meridian.example',
    roleKey: 'warehouse', jobTitle: 'Warehouse Operator', active: false,
    warehouseIds: ['wh-2'], lastLoginAt: toISODateTime(daysAgo(95)), ...stamp(),
  },
];

export const SALES_REPS = USERS.filter((u) => u.roleKey === 'sales');

// ---------------------------------------------------------------------------
// Warehouses
// ---------------------------------------------------------------------------

export const WAREHOUSES: Warehouse[] = [
  {
    id: 'wh-1', code: 'MAIN', name: 'Central Distribution Centre',
    city: 'Rotterdam', country: 'NL', isDefault: true, active: true, ...stamp(),
  },
  {
    id: 'wh-2', code: 'SOUTH', name: 'Southern Depot',
    city: 'Lyon', country: 'FR', isDefault: false, active: true, ...stamp(),
  },
];

// ---------------------------------------------------------------------------
// Payment terms
// ---------------------------------------------------------------------------

export const PAYMENT_TERMS: Record<PaymentTerms['code'], PaymentTerms> = {
  immediate: { code: 'immediate', label: 'Due on receipt', daysUntilDue: 0 },
  net_15: { code: 'net_15', label: 'Net 15', daysUntilDue: 15 },
  net_30: { code: 'net_30', label: 'Net 30', daysUntilDue: 30 },
  net_45: { code: 'net_45', label: 'Net 45', daysUntilDue: 45 },
  net_60: { code: 'net_60', label: 'Net 60', daysUntilDue: 60 },
};

export const PAYMENT_TERMS_LIST = Object.values(PAYMENT_TERMS);

// ---------------------------------------------------------------------------
// Product categories
// ---------------------------------------------------------------------------

export const CATEGORIES: ProductCategory[] = [
  { id: 'cat-1', name: 'Cable & Wiring' },
  { id: 'cat-2', name: 'Circuit Protection' },
  { id: 'cat-3', name: 'Lighting' },
  { id: 'cat-4', name: 'Enclosures & Trunking' },
  { id: 'cat-5', name: 'Tools & Consumables' },
  { id: 'cat-6', name: 'Services' },
];

// ---------------------------------------------------------------------------
// Chart of Accounts
// ---------------------------------------------------------------------------
/**
 * A deliberately small but STRUCTURALLY REAL chart of accounts.
 *
 * Numbering follows the usual convention:
 *   1xxx assets · 2xxx liabilities · 3xxx equity · 4xxx revenue · 5xxx expenses
 *
 * The accounts marked `postable: false` are headings — they exist to subtotal
 * their children in reports and cannot receive a journal line directly.
 *
 * The three accounts that connect accounting to the rest of the ERP:
 *   1200 Accounts Receivable — created when a customer invoice is posted
 *   1300 Inventory           — increased by goods receipts, decreased by deliveries
 *   2000 Accounts Payable    — created when a supplier bill is posted
 * These are called CONTROL ACCOUNTS: their balance must always equal the sum of
 * the underlying subsidiary ledger (all customer balances, all stock valuation).
 * Reconciling them is a routine month-end check, and a mismatch means a bug.
 */
function account(
  id: string, code: string, name: string, type: AccountType,
  normalBalance: NormalBalance, balanceMajor: number,
  opts: Partial<Pick<Account, 'parentId' | 'postable' | 'isCashAccount'>> = {},
): Account {
  return {
    id, code, name, type, normalBalance,
    parentId: opts.parentId,
    postable: opts.postable ?? true,
    isCashAccount: opts.isCashAccount ?? false,
    currency: 'USD',
    balance: money(balanceMajor),
    active: true,
  };
}

export const ACCOUNTS: Account[] = [
  // ---- Assets -------------------------------------------------------------
  account('a-1000', '1000', 'Current Assets', 'asset', 'debit', 0, { postable: false }),
  account('a-1010', '1010', 'Cash on Hand', 'asset', 'debit', 8_450, { parentId: 'a-1000', isCashAccount: true }),
  account('a-1020', '1020', 'Operating Bank Account', 'asset', 'debit', 214_380.55, { parentId: 'a-1000', isCashAccount: true }),
  account('a-1030', '1030', 'Reserve Bank Account', 'asset', 'debit', 75_000, { parentId: 'a-1000', isCashAccount: true }),
  account('a-1200', '1200', 'Accounts Receivable', 'asset', 'debit', 187_642.18, { parentId: 'a-1000' }),
  account('a-1300', '1300', 'Inventory', 'asset', 'debit', 412_907.4, { parentId: 'a-1000' }),
  account('a-1400', '1400', 'Prepaid Expenses', 'asset', 'debit', 12_300, { parentId: 'a-1000' }),
  account('a-1500', '1500', 'Fixed Assets', 'asset', 'debit', 0, { postable: false }),
  account('a-1510', '1510', 'Warehouse Equipment', 'asset', 'debit', 96_000, { parentId: 'a-1500' }),
  account('a-1590', '1590', 'Accumulated Depreciation', 'asset', 'credit', -28_400, { parentId: 'a-1500' }),

  // ---- Liabilities --------------------------------------------------------
  account('a-2000', '2000', 'Current Liabilities', 'liability', 'credit', 0, { postable: false }),
  account('a-2010', '2010', 'Accounts Payable', 'liability', 'credit', 143_218.9, { parentId: 'a-2000' }),
  account('a-2100', '2100', 'VAT Payable', 'liability', 'credit', 31_704.62, { parentId: 'a-2000' }),
  account('a-2200', '2200', 'Accrued Expenses', 'liability', 'credit', 9_850, { parentId: 'a-2000' }),
  account('a-2500', '2500', 'Long-term Loan', 'liability', 'credit', 120_000),

  // ---- Equity -------------------------------------------------------------
  account('a-3000', '3000', 'Share Capital', 'equity', 'credit', 250_000),
  account('a-3100', '3100', 'Retained Earnings', 'equity', 'credit', 318_745.33),

  // ---- Revenue ------------------------------------------------------------
  account('a-4000', '4000', 'Revenue', 'revenue', 'credit', 0, { postable: false }),
  account('a-4010', '4010', 'Product Sales', 'revenue', 'credit', 1_284_610.75, { parentId: 'a-4000' }),
  account('a-4020', '4020', 'Delivery & Freight Income', 'revenue', 'credit', 38_420.5, { parentId: 'a-4000' }),
  account('a-4900', '4900', 'Sales Discounts', 'revenue', 'debit', -22_180.4, { parentId: 'a-4000' }),

  // ---- Expenses -----------------------------------------------------------
  account('a-5000', '5000', 'Cost of Sales', 'expense', 'debit', 0, { postable: false }),
  account('a-5010', '5010', 'Cost of Goods Sold', 'expense', 'debit', 812_405.2, { parentId: 'a-5000' }),
  account('a-5020', '5020', 'Freight Inwards', 'expense', 'debit', 24_180.6, { parentId: 'a-5000' }),
  account('a-5030', '5030', 'Inventory Shrinkage', 'expense', 'debit', 6_842.15, { parentId: 'a-5000' }),
  account('a-6000', '6000', 'Operating Expenses', 'expense', 'debit', 0, { postable: false }),
  account('a-6010', '6010', 'Salaries & Wages', 'expense', 'debit', 198_400, { parentId: 'a-6000' }),
  account('a-6020', '6020', 'Rent & Utilities', 'expense', 'debit', 64_800, { parentId: 'a-6000' }),
  account('a-6030', '6030', 'Vehicle & Distribution', 'expense', 'debit', 41_260.85, { parentId: 'a-6000' }),
  account('a-6040', '6040', 'Software & IT', 'expense', 'debit', 18_940, { parentId: 'a-6000' }),
  account('a-6050', '6050', 'Professional Fees', 'expense', 'debit', 12_500, { parentId: 'a-6000' }),
  account('a-6900', '6900', 'Bad Debt Expense', 'expense', 'debit', 4_120, { parentId: 'a-6000' }),
];

export const CASH_ACCOUNTS = ACCOUNTS.filter((a) => a.isCashAccount);

export const ACCOUNT_BY_CODE = new Map(ACCOUNTS.map((a) => [a.code, a]));

export { REFERENCE_TODAY };
