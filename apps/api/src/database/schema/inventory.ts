/**
 * Drizzle definitions for the stock ledger.
 *
 * These describe what `migrations/0008_stock_ledger.sql` creates. They do not create it:
 * contract section 1.2 ratified handwritten SQL as the only thing that changes the database, and
 * `schema-drift.int.spec.ts` compares these against the live catalogue.
 *
 * Section 8.1 makes the ledger the truth and section 8.2 makes the balance a maintained
 * aggregate above it. Both are here because neither is usable without the other: a ledger
 * nobody can read a position from, and a position with nothing underneath it, are each half a
 * model.
 */

import { integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The eight reasons a movement can have.
 *
 * Closed, and not extended here. Section 8.7 records that `MovementReason` preserves what a
 * source and destination model would carry, which is precisely why it is a list rather than a
 * free text note: the reason is how this model says where goods came from or went.
 */
export const MOVEMENT_REASONS = [
  'purchase_receipt',
  'sales_delivery',
  'transfer_in',
  'transfer_out',
  'adjustment',
  'customer_return',
  'supplier_return',
  'scrap',
] as const;

export type MovementReason = (typeof MOVEMENT_REASONS)[number];

/**
 * One immutable inventory fact.
 *
 * `quantity` is signed: positive increases stock, negative decreases it. A mistake is corrected
 * by recording a compensating movement, which leaves both facts in history, never by editing
 * the original. The application role holds no UPDATE or DELETE on this table, so that is
 * enforced rather than intended.
 *
 * No `version`, under section 4.2's second exempt shape. No cost, under section 8.3, which keeps
 * quantity and value as separate linked records because they are known at different times.
 */
export const stockMovements = pgTable('stock_movements', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  productId: uuid('product_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  /** Signed, never zero, always in the product's stocking unit per section 8.4. */
  quantity: numeric('quantity', { precision: 19, scale: 6 }).notNull(),
  reason: text('reason').notNull(),
  /** Section 8.1: every movement carries the document that caused it. */
  sourceDocType: text('source_doc_type').notNull(),
  sourceDocId: uuid('source_doc_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

/**
 * What the movements for one company, product and warehouse sum to.
 *
 * Section 8.2's maintained aggregate, written in the same transaction as the movement that
 * changes it. The ledger remains the source of truth and this is the read path, with a rebuild
 * and verify job to come that recomputes it and reports drift.
 *
 * No reserved quantity yet. Section 8.5 defines available as on hand minus reserved, but a
 * reservation is not a movement, so where reserved lives is the reservation increment's
 * question rather than a column guessed at now.
 */
export const stockBalances = pgTable('stock_balances', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  productId: uuid('product_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  onHand: numeric('on_hand', { precision: 19, scale: 6 }).notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

export const inventorySchema = { stockMovements, stockBalances };

/** Both carry `tenant_id` with row level security enabled and forced. */
export const INVENTORY_TENANT_SCOPED_TABLES = ['stock_movements', 'stock_balances'] as const;

/** Both belong to exactly one company, so both carry `company_id`. */
export const INVENTORY_COMPANY_PARTITIONED_TABLES = [
  'stock_movements',
  'stock_balances',
] as const;

/**
 * The ledger is append only, which is section 4.2's second exempt shape.
 *
 * `stock_balances` is not here. It is mutable business data, so it carries `version` under the
 * main rule, and the balance write checks it.
 */
export const INVENTORY_VERSION_EXEMPT_TABLES = ['stock_movements'] as const;
