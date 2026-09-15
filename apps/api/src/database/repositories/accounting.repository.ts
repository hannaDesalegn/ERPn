/**
 * The chart of accounts, the posting account mapping, and the value ledger. INTERNAL.
 *
 * Nothing here is re-exported from the data layer's public entry point. These classes are
 * constructed only by `UnitOfWork`, inside a transaction whose tenant and company context is
 * already set. Contract section 6.3: constructing an unscoped query must not be possible through
 * the public interface of the data layer.
 *
 * THE SAME TWO RULES AS EVERY OTHER REPOSITORY HERE:
 *
 *   1. The scope predicate is in the query, not applied afterwards. An account belonging to
 *      another company is not among the rows a query can return, rather than being fetched and
 *      then rejected.
 *   2. Writes stamp `tenant_id` and `company_id` from the scope, never from the input. The input
 *      types carry no field to supply them, which is the first line of defence, this is the
 *      second, and row level security is the third.
 *
 * NO UPDATE AND NO DELETE ON THE LEDGER, and not by convention. Migration 0014 grants the
 * application role SELECT and INSERT on `journal_entries` and `journal_lines`, and adds a trigger
 * that refuses the other two even from the owning role. Section 9.1: a posted entry is corrected
 * by a reversing entry, never edited.
 *
 * AND NO BALANCE CHECK. Section 4.1 puts that invariant in the database, as a deferred constraint
 * evaluated per entry at commit. Writing a second copy of it here would mean the error a caller
 * sees depends on which layer noticed first, and would make the trigger look like the redundant
 * one. The whole transaction fails at commit instead.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';

import {
  accounts,
  companyPostingAccounts,
  journalEntries,
  journalLines,
} from '../schema/accounting.js';
import type { Scope } from '../scope.js';
import { actingUserId } from '../scope.js';
import { requireCompanyScope } from './company-scope.js';
import {
  ConcurrencyConflictError,
  RecordNotFoundError,
  type AccountRecord,
  type AccountRepository,
  type ArchiveRequest,
  type CompanyPostingAccountRecord,
  type CompanyPostingAccountRepository,
  type JournalEntryRecord,
  type JournalLineRecord,
  type JournalRepository,
  type NewAccount,
  type NewCompanyPostingAccount,
  type NewJournalEntry,
  type RecordedJournalEntry,
} from './types.js';

type Db = NodePgDatabase<Record<string, never>>;

const ACCOUNTS = 'Accounts';
const POSTING_ACCOUNTS = 'Posting accounts';
const JOURNAL = 'Journal';

// ---------------------------------------------------------------------------------------
// The chart of accounts.
// ---------------------------------------------------------------------------------------

export class DrizzleAccountRepository implements AccountRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async findById(id: string): Promise<AccountRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, ACCOUNTS);

    const rows = await this.db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.id, id), eq(accounts.tenantId, tenantId), eq(accounts.companyId, companyId)),
      )
      .limit(1);

    return rows[0] ? toAccount(rows[0]) : null;
  }

  /**
   * Lookup by the number a bookkeeper uses.
   *
   * Scoped like every other read, which is what makes the code safe to look up at all: it is
   * unique within a company and not globally, so an unscoped query would match a row per company
   * and return whichever came first.
   */
  async findByCode(code: string): Promise<AccountRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, ACCOUNTS);

    const rows = await this.db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.code, code),
          eq(accounts.tenantId, tenantId),
          eq(accounts.companyId, companyId),
        ),
      )
      .limit(1);

    return rows[0] ? toAccount(rows[0]) : null;
  }

  async listForCompany(): Promise<AccountRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, ACCOUNTS);

    const rows = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.companyId, companyId)))
      .orderBy(asc(accounts.code));

    return rows.map(toAccount);
  }

  async create(input: NewAccount): Promise<AccountRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, ACCOUNTS);

    const rows = await this.db
      .insert(accounts)
      .values({
        id: input.id,
        // From the scope. `NewAccount` has no field with which to claim another company.
        tenantId,
        companyId,
        code: input.code,
        name: input.name,
        type: input.type,
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toAccount(row);
  }

  /**
   * Retires an account, per section 4.5. There is no delete, and the grant would refuse one.
   *
   * Optimistic locking per section 10.1: the caller supplies the version it read, and a mismatch
   * is a conflict rather than a silent overwrite.
   */
  async archive(input: ArchiveRequest): Promise<AccountRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, ACCOUNTS);

    const rows = await this.db
      .update(accounts)
      .set({
        status: 'archived',
        updatedAt: new Date(),
        updatedBy: actingUserId(this.scope),
        version: sql`${accounts.version} + 1`,
      })
      .where(
        and(
          eq(accounts.id, input.id),
          eq(accounts.tenantId, tenantId),
          eq(accounts.companyId, companyId),
          eq(accounts.version, input.expectedVersion),
        ),
      )
      .returning();

    const row = rows[0];
    if (row) return toAccount(row);

    // Nothing was updated. Either the row is not in this company, which answers as not found per
    // section 6.1, or the version moved, which is a conflict.
    const current = await this.findById(input.id);
    if (!current) throw new RecordNotFoundError(ACCOUNTS, input.id);
    throw new ConcurrencyConflictError(ACCOUNTS, input.id);
  }
}

// ---------------------------------------------------------------------------------------
// Which account a posting uses.
// ---------------------------------------------------------------------------------------

export class DrizzleCompanyPostingAccountRepository implements CompanyPostingAccountRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  async findForPurpose(purpose: string): Promise<CompanyPostingAccountRecord | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, POSTING_ACCOUNTS);

    const rows = await this.db
      .select()
      .from(companyPostingAccounts)
      .where(
        and(
          eq(companyPostingAccounts.purpose, purpose),
          eq(companyPostingAccounts.tenantId, tenantId),
          eq(companyPostingAccounts.companyId, companyId),
        ),
      )
      .limit(1);

    return rows[0] ? toPostingAccount(rows[0]) : null;
  }

  async listForCompany(): Promise<CompanyPostingAccountRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, POSTING_ACCOUNTS);

    const rows = await this.db
      .select()
      .from(companyPostingAccounts)
      .where(
        and(
          eq(companyPostingAccounts.tenantId, tenantId),
          eq(companyPostingAccounts.companyId, companyId),
        ),
      )
      .orderBy(asc(companyPostingAccounts.purpose));

    return rows.map(toPostingAccount);
  }

  async create(input: NewCompanyPostingAccount): Promise<CompanyPostingAccountRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, POSTING_ACCOUNTS);

    const rows = await this.db
      .insert(companyPostingAccounts)
      .values({
        id: input.id,
        tenantId,
        companyId,
        purpose: input.purpose,
        // Stamped from the scope alongside the account, which is what the composite foreign key
        // in 0013 checks: the account named here must belong to this same tenant and company.
        accountId: input.accountId,
        createdBy: actingUserId(this.scope),
        updatedBy: actingUserId(this.scope),
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toPostingAccount(row);
  }

  async pointTo(input: {
    purpose: string;
    accountId: string;
    expectedVersion: number;
  }): Promise<CompanyPostingAccountRecord> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, POSTING_ACCOUNTS);

    const rows = await this.db
      .update(companyPostingAccounts)
      .set({
        accountId: input.accountId,
        updatedAt: new Date(),
        updatedBy: actingUserId(this.scope),
        version: sql`${companyPostingAccounts.version} + 1`,
      })
      .where(
        and(
          eq(companyPostingAccounts.purpose, input.purpose),
          eq(companyPostingAccounts.tenantId, tenantId),
          eq(companyPostingAccounts.companyId, companyId),
          eq(companyPostingAccounts.version, input.expectedVersion),
        ),
      )
      .returning();

    const row = rows[0];
    if (row) return toPostingAccount(row);

    const current = await this.findForPurpose(input.purpose);
    if (!current) throw new RecordNotFoundError(POSTING_ACCOUNTS, input.purpose);
    throw new ConcurrencyConflictError(POSTING_ACCOUNTS, input.purpose);
  }
}

// ---------------------------------------------------------------------------------------
// The value ledger.
// ---------------------------------------------------------------------------------------

export class DrizzleJournalRepository implements JournalRepository {
  constructor(
    private readonly db: Db,
    private readonly scope: Scope,
  ) {}

  /**
   * Writes an entry and its lines.
   *
   * ONE METHOD, BECAUSE AN ENTRY AND ITS LINES ARE ONE FACT. Offering a way to write the header
   * alone would offer a way to create half an entry, and section 4.1's invariant is a property of
   * the set rather than of any row in it.
   *
   * The lines go in after the entry because they reference it. Both are in the caller's
   * transaction, so a failure anywhere in it takes the whole entry, and the balance check fires
   * at commit against everything written here.
   */
  async record(input: NewJournalEntry): Promise<RecordedJournalEntry> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, JOURNAL);
    const actor = actingUserId(this.scope);

    const entryRows = await this.db
      .insert(journalEntries)
      .values({
        id: input.id,
        tenantId,
        companyId,
        entryDate: input.entryDate,
        memo: input.memo,
        currency: input.currency,
        sourceDocType: input.sourceDocType ?? null,
        sourceDocId: input.sourceDocId ?? null,
        createdBy: actor,
        updatedBy: actor,
        // `created_txid` is left to the database default. A caller supplied transaction id would
        // be a caller supplied provenance claim, which is the reason `audit_events.txid` is
        // written the same way.
      })
      .returning();

    const entry = entryRows[0];
    if (!entry) throw new Error('Insert returned no row');

    const lines: JournalLineRecord[] = [];
    let lineNumber = 0;
    for (const line of input.lines) {
      lineNumber += 1;

      const rows = await this.db
        .insert(journalLines)
        .values({
          // Generated here. A line has no identity a caller needs to choose, and the numbering
          // is the order the caller gave rather than a field they supply.
          id: randomUUID(),
          tenantId,
          companyId,
          journalEntryId: entry.id,
          lineNumber,
          accountId: line.accountId,
          debit: line.debit ?? '0',
          credit: line.credit ?? '0',
          // From the entry, not from the line. The composite key in 0014 refuses anything else,
          // and one entry in two currencies is not an entry whose balance means anything.
          currency: entry.currency,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning();

      const row = rows[0];
      if (!row) throw new Error('Insert returned no row');
      lines.push(toLine(row));
    }

    return { entry: toEntry(entry), lines };
  }

  async findById(id: string): Promise<RecordedJournalEntry | null> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, JOURNAL);

    const rows = await this.db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.id, id),
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.companyId, companyId),
        ),
      )
      .limit(1);

    const entry = rows[0];
    if (!entry) return null;

    return { entry: toEntry(entry), lines: await this.linesOf(entry.id) };
  }

  async listForSourceDocument(docType: string, docId: string): Promise<RecordedJournalEntry[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, JOURNAL);

    const rows = await this.db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.sourceDocType, docType),
          eq(journalEntries.sourceDocId, docId),
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.companyId, companyId),
        ),
      )
      .orderBy(asc(journalEntries.createdAt));

    const found: RecordedJournalEntry[] = [];
    for (const entry of rows) {
      found.push({ entry: toEntry(entry), lines: await this.linesOf(entry.id) });
    }
    return found;
  }

  private async linesOf(entryId: string): Promise<JournalLineRecord[]> {
    const { tenantId, companyId } = requireCompanyScope(this.scope, JOURNAL);

    const rows = await this.db
      .select()
      .from(journalLines)
      .where(
        and(
          eq(journalLines.journalEntryId, entryId),
          eq(journalLines.tenantId, tenantId),
          eq(journalLines.companyId, companyId),
        ),
      )
      .orderBy(asc(journalLines.lineNumber));

    return rows.map(toLine);
  }
}

// ---------------------------------------------------------------------------------------
// Row mapping.
// ---------------------------------------------------------------------------------------

type AccountRow = typeof accounts.$inferSelect;
type PostingAccountRow = typeof companyPostingAccounts.$inferSelect;
type EntryRow = typeof journalEntries.$inferSelect;
type LineRow = typeof journalLines.$inferSelect;

function toAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    type: row.type,
    status: row.status,
    version: row.version,
  };
}

function toPostingAccount(row: PostingAccountRow): CompanyPostingAccountRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    purpose: row.purpose,
    accountId: row.accountId,
    version: row.version,
  };
}

function toEntry(row: EntryRow): JournalEntryRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    entryDate: row.entryDate,
    memo: row.memo,
    currency: row.currency,
    sourceDocType: row.sourceDocType,
    sourceDocId: row.sourceDocId,
    createdAt: row.createdAt,
  };
}

function toLine(row: LineRow): JournalLineRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    journalEntryId: row.journalEntryId,
    lineNumber: row.lineNumber,
    accountId: row.accountId,
    debit: row.debit,
    credit: row.credit,
    currency: row.currency,
  };
}
