/**
 * The posting purpose catalogue, as far as it can be checked without a database.
 *
 * The claim worth testing here is that the two lists agree: every purpose has a default account,
 * and every default account code exists in the chart a company is actually given. A drift between
 * them would surface as a company provisioned with a purpose pointing at nothing, which is a
 * company that cannot raise an invoice.
 */

import { DEFAULT_CHART_OF_ACCOUNTS } from './chart-of-accounts.js';
import {
  DEFAULT_POSTING_ACCOUNTS,
  isPostingAccountPurpose,
  POSTING_ACCOUNT_PURPOSES,
} from './posting-accounts.js';

describe('the posting purpose catalogue', () => {
  it('names the three purposes the first invoice posting needs, and no more', () => {
    expect([...POSTING_ACCOUNT_PURPOSES]).toEqual([
      'accounts_receivable',
      'sales_revenue',
      'tax_payable',
    ]);
  });

  it.each(['receivables', 'tax', 'revenue', 'accounts_payable', ''])(
    'refuses %s, which the catalogue does not define',
    (value) => {
      expect(isPostingAccountPurpose(value)).toBe(false);
    },
  );

  it('uses names the database will accept as a purpose', () => {
    // The check constraint in 0013 is `^[a-z][a-z0-9_]{1,62}$`. A purpose that fails it would be
    // refused at provisioning time, in the transaction that creates a company.
    for (const purpose of POSTING_ACCOUNT_PURPOSES) {
      expect(purpose).toMatch(/^[a-z][a-z0-9_]{1,62}$/);
    }
  });
});

describe('the default mapping onto the chart', () => {
  it('gives every purpose a default account', () => {
    expect(Object.keys(DEFAULT_POSTING_ACCOUNTS).sort()).toEqual([...POSTING_ACCOUNT_PURPOSES].sort());
  });

  it('points every purpose at a code the default chart actually contains', () => {
    const codes = new Set(DEFAULT_CHART_OF_ACCOUNTS.map((account) => account.code));

    for (const purpose of POSTING_ACCOUNT_PURPOSES) {
      expect(codes.has(DEFAULT_POSTING_ACCOUNTS[purpose])).toBe(true);
    }
  });

  it('points each purpose at a different account', () => {
    const codes = Object.values(DEFAULT_POSTING_ACCOUNTS);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('maps each purpose onto an account of the type double entry requires', () => {
    // Receivables is an asset the invoice debits, revenue is revenue it credits, and the tax it
    // owes is a liability. A purpose pointing at the wrong type still balances and still
    // misstates the balance sheet, which is why the type is asserted rather than the code alone.
    const typeOf = (code: string) =>
      DEFAULT_CHART_OF_ACCOUNTS.find((account) => account.code === code)!.type;

    expect(typeOf(DEFAULT_POSTING_ACCOUNTS.accounts_receivable)).toBe('asset');
    expect(typeOf(DEFAULT_POSTING_ACCOUNTS.sales_revenue)).toBe('revenue');
    expect(typeOf(DEFAULT_POSTING_ACCOUNTS.tax_payable)).toBe('liability');
  });
});
