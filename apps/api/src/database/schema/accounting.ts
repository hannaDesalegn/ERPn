/**
 * Drizzle definitions for the chart of accounts and the value ledger.
 *
 * These describe what `migrations/0013_chart_of_accounts.sql` and `0014_journal_entries.sql`
 * create. They do not create it: architecture section 1.2 ratified handwritten SQL as the only thing
 * that changes the database, and `schema-drift.int.spec.ts` compares these against the live
 * catalogue, so a change to either side that the other does not match fails the build.
 *
 * When adding a column: write the migration first, apply it, then update this file.
 *
 * WHAT DRIZZLE CANNOT SAY, and where to read it instead. The balance invariant is a deferred
 * constraint trigger, the append-only guarantee is a pair of triggers plus withheld grants, and
 * both live in 0014 where they can be expressed. A schema DSL has no vocabulary for either,
 * which is one of the reasons section 1.2 dropped `drizzle-kit`. Nothing here should be read as
 * the whole truth about these tables.
 *
 * MONEY IS DECLARED AS A STRING, for the reason `sales.ts` gives: a JavaScript number is an
 * IEEE-754 double, and letting the driver hand one back would put the precision loss one layer
 * below everything that cares about it.
 */

import {
  char,
  customType,
  date,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Amounts at four decimal places, per section 4.3, exact and never a double. */
const amount = (name: string) => numeric(name, { precision: 19, scale: 4, mode: 'string' });

/**
 * PostgreSQL's 64 bit transaction id, which Drizzle has no built in type for.
 *
 * Read only from the application's point of view: the database supplies it through a default,
 * exactly as it does for `audit_events.txid`.
 */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

/**
 * One account in a company's chart.
 *
 * `normalBalance` is not a column: assets and expenses increase on the debit side and everything
 * else on the credit side, so it is a function of `type` and storing it would be a second source
 * of truth. `apps/api/src/accounting/chart-of-accounts.ts` derives it.
 */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  /** The number a bookkeeper uses. Unique within the company, never globally. */
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** One of the five sides of the accounting equation. A check constraint, not a catalogue. */
  type: text('type').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

/**
 * Which account a kind of posting uses, per company. Section 2.9's "the accounts that document
 * postings map to".
 *
 * The shape `document_number_sequences` already uses for the same problem: one row per key, the
 * vocabulary held in code per section 2.7. The composite foreign key in 0013 is what makes a
 * mapping to another company's account unrepresentable.
 */
export const companyPostingAccounts = pgTable('company_posting_accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  /** Validated against the catalogue in `accounting/posting-accounts.ts`. */
  purpose: text('purpose').notNull(),
  accountId: uuid('account_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  version: integer('version').notNull().default(1),
});

/**
 * One balanced transaction in the value ledger.
 *
 * No `version` and no `status`. Section 9.1 makes a posted entry immutable, so there is no update
 * to lose and no state to move through: a correction is a reversing entry, and the document's own
 * draft state belongs to the document, which posts nothing until it is confirmed.
 */
export const journalEntries = pgTable('journal_entries', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  /** The accounting date, which is not always the date the row was written. */
  entryDate: date('entry_date').notNull(),
  memo: text('memo').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  /** What caused the entry. Null on both halves for a manual adjustment. No foreign key: the
   * document tables it will name do not exist yet, as with `stock_movements` in 0008. */
  sourceDocType: text('source_doc_type'),
  sourceDocId: uuid('source_doc_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  /** Defaulted by the database and never supplied by a caller. Read by the trigger in 0014 that
   * refuses a line appended by a later transaction. */
  createdTxid: xid8('created_txid').notNull().default(sql`pg_current_xact_id()`),
});

/**
 * One side of an entry. Exactly one of `debit` and `credit` carries a positive amount, which the
 * check constraint in 0014 enforces and the balance trigger relies on.
 */
export const journalLines = pgTable('journal_lines', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  journalEntryId: uuid('journal_entry_id').notNull(),
  lineNumber: integer('line_number').notNull(),
  accountId: uuid('account_id').notNull(),
  debit: amount('debit').notNull().default('0'),
  credit: amount('credit').notNull().default('0'),
  currency: char('currency', { length: 3 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

/** Tenant scoped and company partitioned, all four. A ledger belongs to one company's books. */
export const ACCOUNTING_TENANT_SCOPED_TABLES = [
  'accounts',
  'company_posting_accounts',
  'journal_entries',
  'journal_lines',
] as const;

export const ACCOUNTING_COMPANY_PARTITIONED_TABLES = ACCOUNTING_TENANT_SCOPED_TABLES;

/**
 * The two ledger tables claim section 4.2's second exempt shape, append-only.
 *
 * Not a convention: 0014 grants the application role SELECT and INSERT only, and adds a trigger
 * that refuses UPDATE and DELETE from the owning role as well. A `version` column on either
 * would be a concurrency control nobody could ever need, which 4.2 calls a defect in its own
 * right.
 *
 * `accounts` and `company_posting_accounts` are not exempt. Both are edited: a chart is renamed
 * and retired, and a posting account is repointed, which is exactly the lost update section 10.1
 * prevents.
 */
export const ACCOUNTING_VERSION_EXEMPT_TABLES = ['journal_entries', 'journal_lines'] as const;

export const accountingSchema = {
  accounts,
  companyPostingAccounts,
  journalEntries,
  journalLines,
};
