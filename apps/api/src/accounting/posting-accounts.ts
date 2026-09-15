/**
 * Which account a posting uses, per company.
 *
 * The second half of section 2.9's "chart of accounts, and the accounts that document postings
 * map to". A posting service must never name an account by code, by name or by guessing at a
 * type: a company renumbers its chart, and two companies of this product do not agree on what
 * 1200 means. It asks for a purpose and is told which account this company configured for it.
 *
 * THE PURPOSE VOCABULARY IS CODE, following the pattern section 2.7 set for permissions and 0005
 * set for document types. A seeded table of purposes with a foreign key would be a second source
 * of truth for a list the code already defines, and the code is what actually decides which
 * purpose a posting asks for.
 *
 * WHY THE NAMES SAY WHICH SIDE. `tax_payable` rather than `tax`, because an invoice credits tax
 * the company owes and a supplier bill debits tax it can reclaim, and those are two accounts. A
 * purpose called `tax` would have to be repointed when purchasing arrives, which would silently
 * change what every past posting meant. `sales_revenue` for the same reason: other revenue
 * exists, and this is the one a customer invoice credits.
 */

import { randomUUID } from 'node:crypto';

import type {
  AccountRecord,
  CompanyPostingAccountRecord,
  ScopedRepositories,
} from '../database/index.js';

/**
 * Every posting purpose the system recognises. A closed list, and a short one.
 *
 * Exactly the three that section 18.2, as amended on 2026-09-15, says the first customer invoice
 * posting writes. Payables, inventory, cost of goods sold, the two interim accounts section 9.4
 * requires and the exchange difference account section 9.7 will need are each added by the
 * increment that posts to them, which is the increment that can also say which account they mean.
 */
export const POSTING_ACCOUNT_PURPOSES = [
  'accounts_receivable',
  'sales_revenue',
  'tax_payable',
] as const;

export type PostingAccountPurpose = (typeof POSTING_ACCOUNT_PURPOSES)[number];

export function isPostingAccountPurpose(value: string): value is PostingAccountPurpose {
  return (POSTING_ACCOUNT_PURPOSES as readonly string[]).includes(value);
}

/**
 * Which account in the default chart each purpose points at when a company is created.
 *
 * By code, because the code is what `provisionChartOfAccounts` writes and what an administrator
 * recognises. The mapping stored in the database is by identifier, so renaming or renumbering
 * the account afterwards does not move the pointer.
 */
export const DEFAULT_POSTING_ACCOUNTS: Readonly<Record<PostingAccountPurpose, string>> = {
  accounts_receivable: '1200',
  sales_revenue: '4000',
  tax_payable: '2200',
};

/**
 * Points a new company's purposes at the accounts it was just given.
 *
 * Takes repositories and the chart that was provisioned alongside it, both from the transaction
 * creating the company. A mapping written in a later transaction would leave a company that
 * exists, holds a chart, and cannot post, which is the half provisioned state the whole
 * operation exists to make impossible.
 *
 * IDEMPOTENT for the same reason the chart is, and the unique constraint on company and purpose
 * is what actually forbids a second row for one purpose.
 *
 * THE CROSS-COMPANY CASE IS NOT CHECKED HERE, and that is deliberate rather than missing.
 * `accounts` came from this company's own scoped repository, and the composite foreign key in
 * 0013 refuses a mapping to another company's account even if this function were called with
 * one. A check here would be a third statement of a rule the database already enforces, and the
 * kind that gets trusted in place of it.
 */
export async function provisionPostingAccounts(
  repositories: Pick<ScopedRepositories, 'postingAccounts'>,
  accounts: readonly AccountRecord[],
): Promise<CompanyPostingAccountRecord[]> {
  const byCode = new Map(accounts.map((account) => [account.code, account]));
  const existing = await repositories.postingAccounts.listForCompany();
  const byPurpose = new Map(existing.map((mapping) => [mapping.purpose, mapping]));

  const provisioned: CompanyPostingAccountRecord[] = [];
  for (const purpose of POSTING_ACCOUNT_PURPOSES) {
    const already = byPurpose.get(purpose);
    if (already) {
      provisioned.push(already);
      continue;
    }

    const code = DEFAULT_POSTING_ACCOUNTS[purpose];
    const account = byCode.get(code);
    if (!account) {
      // Unreachable while the default chart holds the codes above, and loud rather than silent
      // if the two lists ever drift apart: a company whose revenue purpose points at nothing is
      // one that cannot raise an invoice, and the failure would otherwise surface at the first
      // posting rather than at the provisioning that caused it.
      throw new Error(
        `The default chart of accounts has no account ${code}, so ${purpose} cannot be mapped`,
      );
    }

    provisioned.push(
      await repositories.postingAccounts.create({
        id: randomUUID(),
        purpose,
        accountId: account.id,
      }),
    );
  }

  return provisioned;
}
