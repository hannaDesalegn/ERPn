/**
 * Drizzle definitions for the identity schema.
 *
 * These describe the schema that `migrations/0001_identity.sql` creates. They do not create
 * it: contract section 1.2 ratified handwritten SQL as the only thing that changes the
 * database. What lives here is the typed view the application queries through.
 *
 * THE RULE THAT KEEPS THESE TWO HONEST. Because the SQL and these definitions are maintained
 * by hand, they can drift. `schema-drift.int.spec.ts` reads the live PostgreSQL catalogue and
 * compares it against what is declared here, so a change to either side that the other does
 * not match fails the build. Section 1.2 records this as the accepted price of not generating
 * migrations.
 *
 * When adding a column: write the migration first, apply it, then update this file. The drift
 * test will tell you if you forgot the second half.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  char,
  customType,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * PostgreSQL's 64 bit transaction id. Drizzle has no built-in mapping, and it is read only
 * from the application's point of view: the database supplies it through a default.
 */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

// ---------------------------------------------------------------------------------------
// Global tables. No tenant_id, no company_id, no row level security.
// Contract section 4.6 names these three as a closed exception.
// ---------------------------------------------------------------------------------------

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  /** Null for an account that authenticates through an external identity provider. */
  passwordHash: text('password_hash'),
  externalSubjectId: text('external_subject_id'),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  /** Hash of the opaque cookie token. The token itself is never stored. */
  tokenHash: text('token_hash').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  activeCompanyId: uuid('active_company_id').references((): AnyPgColumn => companies.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
});

// ---------------------------------------------------------------------------------------
// Tenant scoped tables. Both scope columns, not null, row level security enabled and forced.
// ---------------------------------------------------------------------------------------

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  baseCurrency: char('base_currency', { length: 3 }).notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

/**
 * Association table, insert and delete only. No `version`: section 4.2 exempts association
 * tables, because a row is created or removed and never edited.
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    tenantId: uuid('tenant_id').notNull(),
    companyId: uuid('company_id').notNull(),
    roleId: uuid('role_id').notNull(),
    /** A capability string from the compiled catalogue. There is no permissions table. */
    permission: text('permission').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permission] })],
);

/** Association table. No `version`, for the same reason as `role_permissions`. */
export const membershipRoles = pgTable(
  'membership_roles',
  {
    tenantId: uuid('tenant_id').notNull(),
    companyId: uuid('company_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (table) => [primaryKey({ columns: [table.membershipId, table.roleId] })],
);

/**
 * Append only. Scope columns are nullable here alone, constrained to the authentication
 * actions, because a failed login precedes any company. Contract section 7.3.
 *
 * No `version`: rows are never updated, and section 7.1 revokes UPDATE and DELETE from the
 * application role outright.
 */
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id'),
  companyId: uuid('company_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  /** The actor's roles as they were at the time, not looked up later. */
  actorRoles: text('actor_roles').array().notNull().default([]),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  summary: text('summary').notNull(),
  /** Field path with typed old and new values. Never preformatted display strings. */
  changes: jsonb('changes'),
  requestId: text('request_id'),
  ipAddress: inet('ip_address'),
  userAgent: text('user_agent'),
  /**
   * The database transaction the change was written in, so an audit record ties back to the
   * exact commit that produced it.
   *
   * The default is declared so Drizzle treats it as database supplied and leaves it out of the
   * required insert fields. The application must never set this: a caller-provided transaction
   * id would be a caller-provided provenance claim.
   */
  txid: xid8('txid').notNull().default(sql`pg_current_xact_id()`),
});

/**
 * The migration runner's own bookkeeping. Declared so the drift test accounts for every table
 * in the schema rather than ignoring the ones it does not recognise.
 */
export const schemaMigrations = pgTable('schema_migrations', {
  version: text('version').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  appliedBy: text('applied_by').notNull(),
});

// ---------------------------------------------------------------------------------------
// Classification the drift test asserts against, so the rules in contract sections 4.2 and
// 4.6 are data rather than prose repeated in a test file.
// ---------------------------------------------------------------------------------------

/** Outside the tenant boundary. Must carry neither scope column and no row level security. */
export const GLOBAL_TABLES = ['tenants', 'users', 'sessions'] as const;

/**
 * Inside the tenant boundary: carries `tenant_id` and has row level security enabled and
 * forced. `companies` is here but not in the list below, because it *is* the company: its own
 * primary key serves where other tables carry `company_id`.
 */
export const TENANT_SCOPED_TABLES = [
  'companies',
  'memberships',
  'roles',
  'role_permissions',
  'membership_roles',
  'audit_events',
] as const;

/** Additionally partitioned by company, so they carry `company_id` as well. */
export const COMPANY_PARTITIONED_TABLES = [
  'memberships',
  'roles',
  'role_permissions',
  'membership_roles',
  'audit_events',
] as const;

/**
 * Exempt from `version`. Contract section 4.2 defines four shapes, and each entry below names
 * the one it claims. Adding a table here without being able to name its shape is a defect.
 *
 * | Table | Shape |
 * |---|---|
 * | `role_permissions` | Association table, insert and delete only |
 * | `membership_roles` | Association table, insert and delete only |
 * | `audit_events` | Append only. Section 7.1 revokes UPDATE and DELETE from the application role |
 * | `sessions` | Ephemeral operational state under last write wins |
 *
 * The fourth shape is the narrow one, and `sessions` is its only example. It qualifies because
 * all four conditions in section 4.2 hold: the table holds operational state rather than
 * business content, its rows are expected to expire and cost a re-login when lost, last write
 * wins is the chosen model rather than an oversight, and its concurrent writers are one
 * principal doing one thing. `last_seen_at` is refreshed by nearly every request, so optimistic
 * locking would produce conflicts that describe nothing real.
 *
 * A mutable business table is never exempt. Conflicts on business data are the control working.
 */
export const VERSION_EXEMPT_TABLES = [
  'role_permissions',
  'membership_roles',
  'audit_events',
  'sessions',
] as const;

/**
 * Not a business table. The migration runner's own bookkeeping, exempt from every rule above.
 * Its `version` column is a migration number and has nothing to do with optimistic locking.
 */
export const INFRASTRUCTURE_TABLES = ['schema_migrations'] as const;

/** Scope columns are nullable on this table alone, per section 7.3. */
export const NULLABLE_SCOPE_TABLES = ['audit_events'] as const;

export const identitySchema = {
  tenants,
  users,
  sessions,
  companies,
  memberships,
  roles,
  rolePermissions,
  membershipRoles,
  auditEvents,
  schemaMigrations,
};
