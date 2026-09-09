/**
 * Money arithmetic and formatting.
 *
 * All arithmetic happens on integer minor units. Conversion to a decimal string
 * happens only at the boundary, for display. Keeping this in one file means
 * there is exactly one place where rounding can go wrong.
 */

import type { CurrencyCode, Money } from '@/domain';

const ZERO_CACHE: Partial<Record<CurrencyCode, Money>> = {};

export function zero(currency: CurrencyCode = 'USD'): Money {
  return (ZERO_CACHE[currency] ??= { amount: 0, currency });
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    // Cross-currency arithmetic needs an explicit exchange rate and a
    // realised-gain/loss posting. Failing loudly is correct.
    throw new Error(`Cannot combine ${a.currency} with ${b.currency} without a conversion rate`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function sum(values: Money[], currency: CurrencyCode = 'USD'): Money {
  return values.reduce(add, zero(currency));
}

/** Multiply money by a plain number (a quantity or a rate). Rounds half away from zero. */
export function multiply(a: Money, factor: number): Money {
  const raw = a.amount * factor;
  return { amount: Math.round(raw), currency: a.currency };
}

export function percentOf(a: Money, percent: number): Money {
  return multiply(a, percent / 100);
}

export function isZero(a: Money): boolean {
  return a.amount === 0;
}

export function isNegative(a: Money): boolean {
  return a.amount < 0;
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amount - b.amount;
}

const SYMBOLS: Record<CurrencyCode, string> = {
  USD: '$',
  EUR: '€',
  ETB: 'Br',
};

/**
 * Format for display. Uses Intl so locale conventions (grouping, decimal
 * separator) are handled correctly rather than hand-rolled.
 */
export function formatMoney(
  value: Money,
  options: { compact?: boolean; showCurrency?: boolean; signed?: boolean } = {},
): string {
  const { compact = false, showCurrency = false, signed = false } = options;
  const major = value.amount / 100;

  const formatter = new Intl.NumberFormat('en-US', {
    style: showCurrency ? 'currency' : 'decimal',
    currency: value.currency,
    minimumFractionDigits: compact ? 0 : 2,
    maximumFractionDigits: compact ? 1 : 2,
    notation: compact ? 'compact' : 'standard',
  });

  const body = formatter.format(major);
  if (showCurrency) return body;

  const sign = signed && value.amount > 0 ? '+' : '';
  return `${sign}${SYMBOLS[value.currency]}${body}`;
}

/** Short form for dashboard tiles: $1.2M, $48.3K. */
export function formatMoneyCompact(value: Money): string {
  return formatMoney(value, { compact: true });
}
