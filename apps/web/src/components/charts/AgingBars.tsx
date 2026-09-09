/**
 * Aging profile as a segmented horizontal bar plus a readable breakdown list.
 *
 * WHY A SEQUENTIAL RAMP AND NOT CATEGORY COLOURS:
 * Aging buckets are ORDERED (not yet due -> 90+ days). Order is magnitude, so
 * the correct encoding is one hue running light to dark. Giving each bucket its
 * own hue would imply the buckets are unrelated categories, and would waste the
 * one visual channel that naturally communicates "this is getting worse".
 *
 * The list underneath is not decoration — it is the table view, so the figures
 * are readable without relying on colour or on judging segment widths.
 */

import type { AgingBand, Money } from '@/domain';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/format';

const RAMP = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];

export function AgingBars({
  bands,
  total,
  emptyLabel = 'Nothing outstanding',
}: {
  bands: AgingBand[];
  total: Money;
  emptyLabel?: string;
}) {
  if (total.amount <= 0) {
    return <p className="py-6 text-center text-xs text-muted">{emptyLabel}</p>;
  }

  return (
    <div>
      {/* 2px surface gaps between segments so adjacent fills never touch */}
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
        {bands.map((band, i) => {
          const pct = (band.amount.amount / total.amount) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={band.bucket}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${pct}%`, backgroundColor: RAMP[i] }}
              title={`${band.label}: ${formatMoney(band.amount)}`}
            />
          );
        })}
      </div>

      <dl className="mt-3 space-y-1">
        {bands.map((band, i) => {
          const pct = total.amount > 0 ? (band.amount.amount / total.amount) * 100 : 0;
          const overdue = band.bucket !== 'current';
          return (
            <div key={band.bucket} className="flex items-center gap-2 text-xs">
              <span
                className="size-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: RAMP[i] }}
                aria-hidden="true"
              />
              <dt className={cn('flex-1 truncate', overdue ? 'text-secondary' : 'text-muted')}>
                {band.label}
              </dt>
              <dd className="w-9 text-right text-muted tabular">{pct.toFixed(0)}%</dd>
              <dd
                className={cn(
                  'w-24 text-right font-medium tabular',
                  band.amount.amount > 0 && overdue ? 'text-primary' : 'text-secondary',
                )}
              >
                {formatMoney(band.amount)}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
