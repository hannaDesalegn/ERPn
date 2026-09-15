/**
 * The chart of accounts, as far as it can be checked without a database.
 *
 * Two claims live here and neither needs PostgreSQL: the normal balance is derived from the
 * account type correctly for all five types, and the default chart is internally coherent. What a
 * database refuses, and what provisioning actually writes, is proved in `chart-of-accounts.int.spec.ts`
 * against a real one, per section 13.2.
 */

import {
  ACCOUNT_TYPES,
  DEFAULT_CHART_OF_ACCOUNTS,
  isAccountType,
  normalBalanceOf,
} from './chart-of-accounts.js';
import type { AccountType } from './chart-of-accounts.js';

describe('account types', () => {
  it('names the five sides of the accounting equation and nothing else', () => {
    expect([...ACCOUNT_TYPES]).toEqual(['asset', 'liability', 'equity', 'revenue', 'expense']);
  });

  it.each(['income', 'Asset', 'ASSET', 'receivable', ''])(
    'refuses %s, which is not one of them',
    (value) => {
      expect(isAccountType(value)).toBe(false);
    },
  );
});

describe('the normal balance of an account', () => {
  // Stated as a table rather than as five assertions, because the claim is that every type has
  // exactly one answer and the table is the whole rule.
  const expected: Record<AccountType, 'debit' | 'credit'> = {
    asset: 'debit',
    expense: 'debit',
    liability: 'credit',
    equity: 'credit',
    revenue: 'credit',
  };

  it.each(ACCOUNT_TYPES)('increases on the correct side for %s', (type) => {
    expect(normalBalanceOf(type)).toBe(expected[type]);
  });

  it('answers for every type the catalogue defines, with no default case standing in', () => {
    // If a sixth type were added to the catalogue without a rule here, this fails rather than
    // quietly treating it as a credit balance.
    expect(Object.keys(expected).sort()).toEqual([...ACCOUNT_TYPES].sort());
  });
});

describe('the default chart of accounts', () => {
  it('holds the three accounts the first invoice posting writes, and no more', () => {
    // Section 18.2 as amended 2026-09-15: receivables, revenue and tax, and nothing else. A
    // fourth account here would be one nothing can post to.
    expect(DEFAULT_CHART_OF_ACCOUNTS.map((account) => account.name)).toEqual([
      'Accounts Receivable',
      'Tax Payable',
      'Sales Revenue',
    ]);
  });

  it('gives each account a type the catalogue recognises', () => {
    for (const account of DEFAULT_CHART_OF_ACCOUNTS) {
      expect(isAccountType(account.type)).toBe(true);
    }
  });

  it('puts receivables on the debit side and revenue and tax on the credit side', () => {
    // The shape of the invoice entry the chart exists for: debit receivables, credit revenue,
    // credit tax. If the types were wrong here, the entry would still balance and every report
    // built on it would be wrong.
    const sideOf = (name: string) =>
      normalBalanceOf(DEFAULT_CHART_OF_ACCOUNTS.find((a) => a.name === name)!.type);

    expect(sideOf('Accounts Receivable')).toBe('debit');
    expect(sideOf('Sales Revenue')).toBe('credit');
    expect(sideOf('Tax Payable')).toBe('credit');
  });

  it('uses a distinct code for each account, because the code is unique per company', () => {
    const codes = DEFAULT_CHART_OF_ACCOUNTS.map((account) => account.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('uses a distinct name for each account, which the database also requires', () => {
    const names = DEFAULT_CHART_OF_ACCOUNTS.map((account) => account.name);

    expect(new Set(names).size).toBe(names.length);
  });
});
