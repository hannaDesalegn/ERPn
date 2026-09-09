/**
 * Money display.
 *
 * Always tabular figures, always right-aligned in tables. A column of currency
 * set in proportional digits cannot be scanned — the decimal points do not line
 * up, so comparing magnitudes requires reading every character.
 */

import type { Money } from '@/domain';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/format';

export function MoneyText({
  value,
  className,
  muted = false,
  strong = false,
  /** Colour negative values as a loss. Off by default: in a ledger a negative is
      often correct and unremarkable, and colouring every one is noise. */
  colorNegative = false,
}: {
  value: Money;
  className?: string;
  muted?: boolean;
  strong?: boolean;
  colorNegative?: boolean;
}) {
  // A zero amount prints as 0.00. Zero is a measured value, not a missing one,
  // and replacing it with a dash hides a real figure from the reader.
  return (
    <span
      className={cn(
        'tabular whitespace-nowrap',
        strong && 'font-medium',
        muted && 'text-muted',
        colorNegative && value.amount < 0 && 'text-danger-text',
        className,
      )}
    >
      {formatMoney(value)}
    </span>
  );
}
