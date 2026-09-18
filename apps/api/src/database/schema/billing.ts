/**
 * Drizzle definitions for the customer invoice and its lines.
 *
 * These describe what `migrations/0015_customer_invoices.sql` creates. They do not create it:
 * architecture section 1.2 ratified handwritten SQL as the only thing that changes the database, and
 * `schema-drift.int.spec.ts` compares these against the live catalogue, so a change to either
 * side that the other does not match fails the build.
 *
 * When adding a column: write the migration first, apply it, then update this file.
 *
 * WHAT DRIZZLE CANNOT SAY. The composite keys that pin a line to its source order line, and the
 * constraint that keeps a draft unnumbered, live in the migration where they can be expressed.
 * Nothing here should be read as the whole truth about these tables.
 *
 * MONEY AND QUANTITIES ARE STRINGS, for the reason `sales.ts` gives: a JavaScript number is an
 * IEEE-754 double, and letting the driver hand one back would put the precision loss below
 * everything that cares about it.
 */

import { char, date, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const amount = (name: string) => numeric(name, { precision: 19, scale: 4, mode: 'string' });
const unitPrice = (name: string) => numeric(name, { precision: 19, scale: 6, mode: 'string' });
const quantity = (name: string) => numeric(name, { precision: 19, scale: 6, mode: 'string' });
const percent = (name: string) => numeric(name, { precision: 9, scale: 6, mode: 'string' });

/**
 * A customer invoice: a demand for payment, and the document that begins the accounting
 * consequence of a sale.
 *
 * `docNumber` is null while it is a draft. Section 10.4 allocates one inside the posting
 * transaction, and the check constraint in 0015 refuses a numbered draft outright.
 *
 * There is no `paidAmount` or `balanceDue`. Section 9.2: balances are derived from the ledger,
 * and no entity carries a stored balance treated as a source of truth.
 */
export const customerInvoices = pgTable('customer_invoices', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  docNumber: text('doc_number'),
  status: text('status').notNull().default('draft'),
  /** One party per invoice. The orders behind it must agree about who is being billed. */
  customerId: uuid('customer_id').notNull(),
  invoiceDate: date('invoice_date').notNull(),
  /** Null until payment terms exist to derive it from; stated by the caller until then. */
  dueDate: date('due_date'),
  currency: char('currency', { length: 3 }).notNull(),
  subtotal: amount('subtotal').notNull().default('0'),
  taxTotal: amount('tax_total').notNull().default('0'),
  total: amount('total').notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

/**
 * One line of an invoice, and the sales order line it bills.
 *
 * The source columns are what hold the relationship the domain model states as
 * `salesOrderIds: ID[]`: the orders an invoice covers are the distinct orders behind its lines,
 * so there is no second place for that set to be stored and drift from.
 */
export const customerInvoiceLines = pgTable('customer_invoice_lines', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  customerInvoiceId: uuid('customer_invoice_id').notNull(),
  lineNumber: integer('line_number').notNull(),
  /** What this line bills, pinned to each other and to this company by composite keys in 0015. */
  sourceSalesOrderId: uuid('source_sales_order_id').notNull(),
  sourceSalesOrderLineId: uuid('source_sales_order_line_id').notNull(),
  productId: uuid('product_id').notNull(),
  /** Snapshotted from the order line, which snapshotted them from the catalogue. Section 3.4. */
  productSku: text('product_sku').notNull(),
  productName: text('product_name').notNull(),
  quantity: quantity('quantity').notNull(),
  unitPrice: unitPrice('unit_price').notNull(),
  discountPercent: percent('discount_percent').notNull().default('0'),
  taxRatePercent: percent('tax_rate_percent').notNull().default('0'),
  currency: char('currency', { length: 3 }).notNull(),
  lineSubtotal: amount('line_subtotal').notNull().default('0'),
  lineTax: amount('line_tax').notNull().default('0'),
  lineTotal: amount('line_total').notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

/** Tenant scoped and company partitioned. An invoice belongs to exactly one company. */
export const BILLING_TENANT_SCOPED_TABLES = [
  'customer_invoices',
  'customer_invoice_lines',
] as const;

export const BILLING_COMPANY_PARTITIONED_TABLES = BILLING_TENANT_SCOPED_TABLES;

/**
 * The lines claim section 4.2's first exempt shape: insert and delete only.
 *
 * Editing a draft replaces its lines, exactly as editing a sales order draft does, and nothing
 * updates one in place. `sales_order_lines` is not exempt because its delivered and invoiced
 * quantities are updated by the documents raised against the order; no equivalent figure lives
 * here. The invoice header is mutable while it is a draft and carries its `version`.
 */
export const BILLING_VERSION_EXEMPT_TABLES = ['customer_invoice_lines'] as const;

export const billingSchema = {
  customerInvoices,
  customerInvoiceLines,
};
