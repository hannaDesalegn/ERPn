/**
 * Drizzle definitions for the master data schema.
 *
 * These describe what `migrations/0006_master_data.sql` creates. They do not create it:
 * contract section 1.2 ratified handwritten SQL as the only thing that changes the database, and
 * `schema-drift.int.spec.ts` compares these against the live catalogue.
 *
 * ONE FILE, THREE EVENTUAL MODULES. Customers are parties, products are the catalogue, and
 * warehouses are the organisation configuration section 2.9 describes. They share a file while
 * each is a handful of columns; the moment any of them grows its own behaviour, it gets its own
 * module and its own entry in `schema/index.ts`.
 *
 * All three are company scoped. Section 2.2 describes companies that may "share a user directory
 * and possibly a product catalogue", and settles the possibly with a `[FUT]`: shared master data
 * between companies inside one tenant is recorded and not built until asked.
 */

import {
  boolean,
  char,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** A party the company sells to. Archived rather than deleted, per section 4.5. */
export const customers = pgTable('customers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

/**
 * The catalogue.
 *
 * There is no quantity column, and that absence is the point. Section 8.1: stock is an append
 * only ledger of movements, not an attribute of a product, and it is the single easiest thing
 * for a future contributor to undo under deadline pressure.
 *
 * `stockingUom` is section 8.4's canonical stocking unit. `salesPrice` is the master data
 * section 3.3 requires the server to recompute from, rather than trusting a price returned by a
 * form. Both are declared as strings for the reason section 4.3 gives about doubles.
 */
export const products = pgTable('products', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  /** Only a stockable product participates in inventory. */
  type: text('type').notNull().default('stockable'),
  stockingUom: text('stocking_uom').notNull(),
  salesPrice: numeric('sales_price', { precision: 19, scale: 6, mode: 'string' })
    .notNull()
    .default('0'),
  salesPriceCurrency: char('sales_price_currency', { length: 3 }).notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

/**
 * Company configuration under section 2.9, which lists organisation among the things a company
 * configures. `allowNegativeStock` carries section 8.5's per warehouse policy, defaulting to
 * deny; the transaction that writes a movement is what will enforce it.
 */
export const warehouses = pgTable('warehouses', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  isDefault: boolean('is_default').notNull().default(false),
  allowNegativeStock: boolean('allow_negative_stock').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

/** Tenant scoped and company partitioned, all three. */
export const MASTER_DATA_TENANT_SCOPED_TABLES = [
  'customers',
  'products',
  'warehouses',
] as const;

export const MASTER_DATA_COMPANY_PARTITIONED_TABLES = MASTER_DATA_TENANT_SCOPED_TABLES;

/**
 * None is exempt from `version`.
 *
 * All three are mutable business records edited by administrators, which is the circumstance
 * section 4.2's optimistic locking exists for, and none of the four exempt shapes describes
 * them.
 */
export const MASTER_DATA_VERSION_EXEMPT_TABLES = [] as const;

export const masterDataSchema = {
  customers,
  products,
  warehouses,
};
