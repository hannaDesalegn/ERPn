/**
 * The chart of accounts: what an account is, and the one a company starts with.
 *
 * Section 2.9 lists "chart of accounts, and the accounts that document postings map to" among
 * the things a company configures. This file is the first half, and `posting-accounts.ts` is the
 * second. They are separate files because they answer different questions: which accounts exist,
 * and which one a particular posting uses.
 *
 * THE DEFAULT CHART IS THREE ACCOUNTS, AND THAT IS THE WHOLE POINT. Section 18.2, as amended on
 * 2026-09-15, rules that the first customer invoice posting writes receivables, revenue and tax
 * and nothing else. A bank account, an inventory account and a cost of goods sold account would
 * be accounts nothing can post to, in a chart nobody can edit yet, and section 16.1 would have
 * to carry them as temporary state until the modules that use them arrived. Three is what the
 * ruling asks for.
 *
 * SEEDED AT COMPANY CREATION, NEVER AT POSTING TIME. Section 2.7 seeds role templates when a
 * company is created and they belong to the company from that moment; a chart is the same shape
 * of thing. Creating an account lazily during a posting would mean the first invoice of a
 * company's life silently invents its books, and the account a bookkeeper later renames would
 * not be the account the earlier entry hit.
 */

import { randomUUID } from 'node:crypto';

import type { AccountRecord, ScopedRepositories } from '../database/index.js';

/**
 * The five sides of the accounting equation: assets equal liabilities plus equity, with revenue
 * and expenses as the two ways equity moves.
 *
 * Closed, and closed differently from the permission catalogue and the document type list. Those
 * are vocabularies this product invents and will extend. These five are double entry itself, so
 * migration 0013 states them as a check constraint rather than trusting this list alone.
 */
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Which side increases an account. Read by a ledger view to sign a balance correctly. */
export type NormalBalance = 'debit' | 'credit';

export function isAccountType(value: string): value is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

/**
 * The side an account increases on.
 *
 * A function rather than a column, deliberately. It is determined entirely by the type, so
 * storing it would be a second source of truth: a row could then claim to be an asset that
 * increases on the credit side, which is not a configuration choice but a corrupt record.
 */
export function normalBalanceOf(type: AccountType): NormalBalance {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/** One account in the chart a new company starts with. */
export interface DefaultAccount {
  code: string;
  name: string;
  type: AccountType;
}

/**
 * The chart every new company is given.
 *
 * The codes follow the convention the domain model states: assets in the one thousands,
 * liabilities in the two thousands, revenue in the four thousands. A company may renumber and
 * rename these afterwards; they are a starting point under section 2.9, not a rule.
 */
export const DEFAULT_CHART_OF_ACCOUNTS: readonly DefaultAccount[] = [
  { code: '1200', name: 'Accounts Receivable', type: 'asset' },
  { code: '2200', name: 'Tax Payable', type: 'liability' },
  { code: '4000', name: 'Sales Revenue', type: 'revenue' },
];

/**
 * Gives a company the chart it cannot post without.
 *
 * Takes repositories rather than a unit of work, for the reason `provisionSalesOrderSequence`
 * gives: this belongs to the transaction that creates the company, and a function that opened
 * its own transaction would commit a chart for a company that then failed to exist.
 *
 * IDEMPOTENT, AND THE DATABASE IS WHY. The unique constraint on company and code is what forbids
 * a second account; this lookup turns a repeat call into the answer it should have, in the same
 * shape the sales order sequence uses. Re-provisioning an established company must not add a
 * second Sales Revenue beside the one its ledger already points at.
 */
export async function provisionChartOfAccounts(
  repositories: Pick<ScopedRepositories, 'accounts'>,
): Promise<AccountRecord[]> {
  const existing = await repositories.accounts.listForCompany();
  const byCode = new Map(existing.map((account) => [account.code, account]));

  const provisioned: AccountRecord[] = [];
  for (const wanted of DEFAULT_CHART_OF_ACCOUNTS) {
    const already = byCode.get(wanted.code);
    provisioned.push(
      already ??
        (await repositories.accounts.create({
          id: randomUUID(),
          code: wanted.code,
          name: wanted.name,
          type: wanted.type,
        })),
    );
  }

  return provisioned;
}
