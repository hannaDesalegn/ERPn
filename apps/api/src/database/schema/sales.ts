/**
 * Drizzle definitions for the sales schema.
 *
 * These describe what `migrations/0005_sales_orders.sql` creates. They do not create it:
 * contract section 1.2 ratified handwritten SQL as the only thing that changes the database.
 * `schema-drift.int.spec.ts` reads the live catalogue and compares it against what is declared
 * here, so a change to either side that the other does not match fails the build.
 *
 * When adding a column: write the migration first, apply it, then update this file.
 *
 * MONEY AND QUANTITIES ARE DECLARED AS STRINGS, and that is not a shortcut. Section 4.3 stores
 * money as exact `NUMERIC` and section 4.3 again sends it over the wire as a decimal string,
 * because a JavaScript number is an IEEE-754 double and silently loses precision. Letting the
 * driver hand back a `number` here would put that loss one layer below everything that cares
 * about it, which is the worst place for it to happen.
 */

import {
  bigint,
  boolean,
  char,
  date,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Money and quantity columns.
 *
 * `mode: 'string'` keeps the exact decimal the database holds. The application parses it with a
 * decimal type at the point it does arithmetic, per section 4.3, and never with `Number`.
 */
const amount = (name: string) => numeric(name, { precision: 19, scale: 4, mode: 'string' });
const unitPrice = (name: string) => numeric(name, { precision: 19, scale: 6, mode: 'string' });
const quantity = (name: string) => numeric(name, { precision: 19, scale: 6, mode: 'string' });
const percent = (name: string) => numeric(name, { precision: 9, scale: 6, mode: 'string' });

/**
 * Document numbering, per section 10.4.
 *
 * A counter row rather than a PostgreSQL sequence, because a sequence is lock free and leaves
 * gaps when a transaction rolls back, and gapless numbering is a legal requirement in many
 * jurisdictions. `nextValue` is allocated under a row lock inside the transaction that creates
 * the document; `prefix` and `gapless` are configuration guarded by `version`.
 */
export const documentNumberSequences = pgTable('document_number_sequences', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  /** Which document type this numbers. Validated against a catalogue in code, per section 2.7. */
  docType: text('doc_type').notNull(),
  prefix: text('prefix').notNull().default(''),
  /** Per sequence, per section 10.4, because the requirement varies by country and document. */
  gapless: boolean('gapless').notNull().default(true),
  /** The counter. Read and incremented under a row lock, never by a sequence. */
  nextValue: bigint('next_value', { mode: 'bigint' }).notNull().default(1n),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

/**
 * A sales order: a promise, per the domain model. It affects nothing financially and reserves
 * stock. Delivery, invoice and payment are separate documents for separate events.
 *
 * `docNumber` is null while the order is a draft. Section 12.2 allocates it as step four of the
 * confirming transaction, so a draft genuinely has none.
 */
export const salesOrders = pgTable('sales_orders', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  docNumber: text('doc_number'),
  status: text('status').notNull().default('draft'),
  /** Master data references. No foreign key yet; the tables do not exist. */
  customerId: uuid('customer_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  salesRepUserId: uuid('sales_rep_user_id'),
  orderDate: date('order_date').notNull(),
  expectedDeliveryDate: date('expected_delivery_date'),
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
 * The lines of one order.
 *
 * Mutable, and therefore versioned: delivered and invoiced quantities change as documents are
 * raised against the order. The product name and SKU are copied at order time for the reason the
 * domain model gives about price: a document is an immutable record of a past agreement.
 */
export const salesOrderLines = pgTable('sales_order_lines', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  salesOrderId: uuid('sales_order_id').notNull(),
  lineNumber: integer('line_number').notNull(),
  productId: uuid('product_id').notNull(),
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
  deliveredQuantity: quantity('delivered_quantity').notNull().default('0'),
  invoicedQuantity: quantity('invoiced_quantity').notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

/**
 * Tenant scoped and company partitioned, all three.
 *
 * Unlike `companies` and `memberships`, which company switching has to read across, a document
 * belongs to exactly one company and nothing needs to read one across the companies of a tenant.
 */
export const SALES_TENANT_SCOPED_TABLES = [
  'document_number_sequences',
  'sales_orders',
  'sales_order_lines',
] as const;

export const SALES_COMPANY_PARTITIONED_TABLES = SALES_TENANT_SCOPED_TABLES;

/**
 * None of them is exempt from `version`, and the one that might look exempt is not.
 *
 * `document_number_sequences` is updated by two different kinds of writer. The counter is
 * allocated under an explicit row lock, which is section 10.4's mechanism and not a lost update
 * risk. The configuration beside it is edited by administrators, which is, so the table carries
 * `version` under the main rule in section 4.2 and claims none of the four exempt shapes.
 */
export const SALES_VERSION_EXEMPT_TABLES = [] as const;

export const salesSchema = {
  documentNumberSequences,
  salesOrders,
  salesOrderLines,
};
