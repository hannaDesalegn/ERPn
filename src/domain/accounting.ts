/**
 * Double-entry accounting.
 *
 * WE ARE NOT IMPLEMENTING THE ACCOUNTING ENGINE TODAY.
 * We are defining the shapes the UI must be able to display, so that when a real
 * ledger exists behind it the frontend does not need restructuring.
 *
 * ============================================================================
 * DOUBLE-ENTRY IN FIVE MINUTES
 * ============================================================================
 * Accounting is not "a list of income and expenses". It is a system where every
 * transaction is recorded in at least TWO places, and the two sides must be equal.
 *
 * The rule the whole system rests on:
 *
 *     ASSETS = LIABILITIES + EQUITY
 *
 *   Assets       things we own or are owed: cash, inventory, money customers owe us
 *   Liabilities  what we owe: supplier bills, loans, unpaid taxes
 *   Equity       what the owners have put in plus profits kept in the business
 *   Revenue      increases equity (sales)
 *   Expenses     decrease equity (cost of goods, salaries, rent)
 *
 * Every entry has DEBITS and CREDITS which must total the same amount. "Debit"
 * and "credit" do NOT mean increase and decrease — what they do depends on the
 * account type:
 *
 *     Account type   Debit    Credit
 *     Asset          increase decrease
 *     Expense        increase decrease
 *     Liability      decrease increase
 *     Equity         decrease increase
 *     Revenue        decrease increase
 *
 * WORKED EXAMPLE — we sell $1,000 of goods that cost us $600, on credit:
 *
 *   Entry 1, the sale:
 *     Debit  Accounts Receivable  1,000   (asset up: customer owes us)
 *     Credit Sales Revenue        1,000   (revenue up)
 *
 *   Entry 2, the cost of what we shipped:
 *     Debit  Cost of Goods Sold     600   (expense up)
 *     Credit Inventory              600   (asset down: goods left the warehouse)
 *
 *   Later, the customer pays:
 *     Debit  Bank                 1,000   (asset up)
 *     Credit Accounts Receivable  1,000   (asset down: no longer owed)
 *
 * Notice what this buys you. Profit ($400) is now a CONSEQUENCE of recorded
 * facts, not a number someone typed. Inventory value, receivables, and the bank
 * balance all update from the same events, and they cannot silently disagree,
 * because every entry must balance.
 *
 * THIS IS WHY THE UI MUST NOT SHOW "income" AND "expense" AS EDITABLE NUMBERS.
 * Financial figures are derived from journal entries, which are derived from
 * business documents. That chain is the product.
 * ============================================================================
 */

import type { DocType, DocumentBase, DocumentRef, ID, ISODate, Money } from './primitives';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

/** Which side increases this account type. Used to render ledgers correctly. */
export type NormalBalance = 'debit' | 'credit';

/**
 * CHART OF ACCOUNTS — the list of every account the business can post to.
 *
 * Usually numbered by convention so the ordering is meaningful:
 *   1000-1999 assets, 2000-2999 liabilities, 3000-3999 equity,
 *   4000-4999 revenue, 5000-5999 expenses
 *
 * The chart is hierarchical: "1200 Accounts Receivable" may have children.
 * Only leaf accounts can be posted to; parents exist to subtotal in reports.
 */
export interface Account {
  id: ID;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  parentId?: ID;
  /** False for parent/heading accounts that only aggregate their children. */
  postable: boolean;
  /** Marks accounts that represent real cash the business can spend. */
  isCashAccount: boolean;
  currency: Money['currency'];
  /** DERIVED from journal lines. Signed in the account's normal-balance direction. */
  balance: Money;
  active: boolean;
}

/**
 * A single side of a transaction. Exactly one of debit/credit is non-zero.
 */
export interface JournalLine {
  id: ID;
  accountId: ID;
  accountCode: string;
  accountName: string;
  description?: string;
  debit: Money;
  credit: Money;
  /**
   * Which customer or supplier this line relates to, when it hits AR or AP.
   * This is what allows a single "Accounts Receivable" account to be broken
   * down per customer — the subsidiary ledger.
   */
  partyId?: ID;
  partyName?: string;
}

export type JournalEntryStatus = 'draft' | 'posted' | 'reversed';

/**
 * JOURNAL ENTRY — one balanced transaction.
 *
 * INVARIANT: sum(debits) === sum(credits). The BACKEND must enforce this and
 * reject anything else. The frontend displays the totals so a human can see the
 * entry balances, but must never be the thing guaranteeing it.
 *
 * `sourceDocument` is what makes the ledger explainable: every entry points back
 * at the invoice, payment or stock movement that caused it. Entries with no
 * source document are manual adjustments, which auditors scrutinise closely.
 */
export interface JournalEntry extends DocumentBase {
  docType: Extract<DocType, 'journal_entry'>;
  status: JournalEntryStatus;
  entryDate: ISODate;
  /** Human label, e.g. 'Customer invoice INV-2026-0031'. */
  memo: string;
  lines: JournalLine[];
  totalDebit: Money;
  totalCredit: Money;
  /** The business document that generated this entry, if it was automatic. */
  sourceDocument?: DocumentRef;
  /** 'system' entries come from posting documents; 'manual' are typed by a human. */
  origin: 'system' | 'manual';
  postedAt?: string;
  postedBy?: { id: ID; name: string };
  /** Accounting periods are closed to stop retroactive edits. */
  periodId?: ID;
}

/** A row in the general ledger view for one account, with a running balance. */
export interface LedgerRow {
  id: ID;
  date: ISODate;
  journalEntryId: ID;
  journalEntryNumber: string;
  memo: string;
  partyName?: string;
  debit: Money;
  credit: Money;
  /** Cumulative balance after this row. Computed server-side over an ordered set. */
  runningBalance: Money;
}

/**
 * TRIAL BALANCE — every account with its total debits and credits.
 * The grand totals must be equal. If they are not, the books are broken.
 * It is the standard first check before producing financial statements.
 */
export interface TrialBalanceRow {
  accountId: ID;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  debit: Money;
  credit: Money;
}

/** Profit & Loss covers a PERIOD ("what did we earn in July"). */
export interface ProfitAndLossSection {
  label: string;
  rows: { accountCode: string; accountName: string; amount: Money }[];
  total: Money;
}

export interface ProfitAndLoss {
  fromDate: ISODate;
  toDate: ISODate;
  revenue: ProfitAndLossSection;
  costOfSales: ProfitAndLossSection;
  grossProfit: Money;
  operatingExpenses: ProfitAndLossSection;
  netProfit: Money;
}

/** Balance Sheet is a SNAPSHOT at a single date ("what do we own and owe today"). */
export interface BalanceSheet {
  asOfDate: ISODate;
  assets: ProfitAndLossSection;
  liabilities: ProfitAndLossSection;
  equity: ProfitAndLossSection;
  totalAssets: Money;
  totalLiabilitiesAndEquity: Money;
  /** Should always be true. Surfaced in the UI as a health indicator. */
  balanced: boolean;
}

/**
 * ACCOUNTING PERIOD.
 * Months/quarters are "closed" after review, which blocks new postings into
 * them. Without this, someone edits last year's numbers after the accounts were
 * filed. Enforcement is strictly a BACKEND concern.
 */
export interface AccountingPeriod {
  id: ID;
  name: string;
  startDate: ISODate;
  endDate: ISODate;
  status: 'open' | 'closed';
}
