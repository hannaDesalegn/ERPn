/**
 * Drizzle definitions for the stock ledger, its balance, and reservations against it.
 *
 * These describe what `migrations/0008_stock_ledger.sql` and `0009_stock_reservations.sql`
 * create. They do not create it:
 * contract section 1.2 ratified handwritten SQL as the only thing that changes the database, and
 * `schema-drift.int.spec.ts` compares these against the live catalogue.
 *
 * Section 8.1 makes the ledger the truth and section 8.2 makes the balance a maintained
 * aggregate above it. They share a file because neither is usable without the other: a ledger
 * nobody can read a position from, and a position with nothing underneath it, are each half a
 * model. Reservations sit beside them because section 8.5's availability is read from all three
 * at once.
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

/**
 * Stock set aside for one sales order line.
 *
 * The source of truth for reserved, per the decision recorded in migration 0009: section 8.2's
 * balance is a projection of the movement ledger, and a reservation is not a movement, so
 * reserved lives here and is derived from these rows rather than held as a counter beside
 * `onHand`.
 *
 * No status, because section 12.3 has not ruled what cancelling does to reserved stock. No
 * `version`, because nothing updates a row here yet, which is section 4.2's second exempt
 * shape. Quantity is positive rather than signed: a movement records a direction, a reservation
 * records an amount set aside, and it is subtracted wherever availability is computed.
 */
export const stockReservations = pgTable('stock_reservations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  /** The line the stock is held for. Pinned to this reservation's company by composite key. */
  salesOrderLineId: uuid('sales_order_line_id').notNull(),
  /** Copied from the line, and pinned to it, so the two cannot disagree. */
  productId: uuid('product_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  /** Positive, in the product's stocking unit per section 8.4. */
  quantity: numeric('quantity', { precision: 19, scale: 6 }).notNull(),
  reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

export const inventorySchema = { stockMovements, stockBalances, stockReservations };

/** All carry `tenant_id` with row level security enabled and forced. */
export const INVENTORY_TENANT_SCOPED_TABLES = [
  'stock_movements',
  'stock_balances',
  'stock_reservations',
] as const;

/** Each belongs to exactly one company, so each carries `company_id`. */
export const INVENTORY_COMPANY_PARTITIONED_TABLES = [
  'stock_movements',
  'stock_balances',
  'stock_reservations',
] as const;

/**
 * The ledger is append only, which is section 4.2's second exempt shape.
 *
 * `stock_reservations` joins it for now: this increment only inserts rows, and the migration
 * withholds UPDATE and DELETE from the application role to match. If release turns out to reduce
 * a reservation in place, the table becomes mutable and gains `version` in that migration.
 *
 * `stock_balances` is not here. It is mutable business data, so it carries `version` under the
 * main rule, and the balance write checks it.
 */
export const INVENTORY_VERSION_EXEMPT_TABLES = ['stock_movements', 'stock_reservations'] as const;
