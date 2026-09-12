/**
 * Drizzle definitions for the idempotency records of section 11.
 *
 * These describe what `migrations/0010_idempotency_records.sql` creates. They do not create it:
 * contract section 1.2 ratified handwritten SQL as the only thing that changes the database, and
 * `schema-drift.int.spec.ts` compares these against the live catalogue.
 */

import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * One request intent, and the response it produced.
 *
 * Identified by the key together with the tenant, company, user and endpoint. Section 11 names
 * the last three; section 4.6 requires the first. The same key from another user, or from the
 * same user in another company, is a different intent rather than a replay.
 *
 * No `version`, under section 4.2's fourth shape. The four conditions are checked one by one in
 * the migration rather than claimed, because the exemption is by reason and not by name.
 */
export const idempotencyRecords = pgTable('idempotency_records', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  userId: uuid('user_id').notNull(),
  /** The method and route, for example `POST sales-orders/:id/confirm`. */
  endpoint: text('endpoint').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  /** A digest of the request, so a differing replay is a conflict without storing the body. */
  requestFingerprint: text('request_fingerprint').notNull(),
  /** Null only while the claiming transaction is still running, which nobody else can observe. */
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

export const idempotencySchema = { idempotencyRecords };

/** Carries `tenant_id`, with row level security enabled and forced. */
export const IDEMPOTENCY_TENANT_SCOPED_TABLES = ['idempotency_records'] as const;

/** Belongs to exactly one company, so it carries `company_id`. */
export const IDEMPOTENCY_COMPANY_PARTITIONED_TABLES = ['idempotency_records'] as const;

/** Exempt under section 4.2's fourth shape. See the migration for the four conditions. */
export const IDEMPOTENCY_VERSION_EXEMPT_TABLES = ['idempotency_records'] as const;
