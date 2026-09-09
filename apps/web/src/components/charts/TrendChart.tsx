/**
 * Single-series trend chart (line + soft area) with a hover crosshair.
 *
 * DESIGN DECISIONS, so they are not re-litigated later:
 *
 * - ONE series per chart, ONE y-axis. Sales and purchases are plotted as two
 *   separate charts rather than two lines on shared axes. A dual-axis chart lets
 *   you place two unrelated scales side by side and invent a correlation that is
 *   not in the data. It is the most common serious charting mistake.
 * - No legend: with a single series the title already names it.
 * - Recessive grid, thin 2px line, 8px hover marker with a surface ring.
 * - Direct labels only at the extremes, never a number on every point.
 * - A table view is available behind a toggle, so the data is reachable without
 *   relying on colour or on reading pixel positions.
 */

import { useId, useMemo, useState } from 'react';
import { formatMoneyCompact } from '@/lib/money';
import { formatDate } from '@/lib/format';
import type { Money } from '@/domain';

export interface TrendPoint {
  date: string;
  value: number;
}

const WIDTH = 720;
const HEIGHT = 180;
const PAD = { top: 14, right: 14, bottom: 22, left: 46 };

export function TrendChart({
  points,
  currency = 'USD',
  ariaLabel,
}: {
  points: TrendPoint[];
  currency?: Money['currency'];
  ariaLabel: string;
}) {
  const gradientId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const geometry = useMemo(() => {
    const max = Math.max(...points.map((p) => p.value), 1);
    const plotW = WIDTH - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;

    const x = (i: number) => PAD.left + (points.length <= 1 ? 0 : (i / (points.length - 1)) * plotW);
    const y = (v: number) => PAD.top + plotH - (v / max) * plotH;

    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const area = `${line} L${x(points.length - 1).toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`;

    // Four gridlines is enough to read a value; more competes with the data.
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ value: max * f, y: y(max * f) }));

    return { max, x, y, line, area, ticks, plotH, plotW };
  }, [points]);

  const peakIndex = useMemo(
    () => points.reduce((best, p, i) => (p.value > (points[best]?.value ?? -1) ? i : best), 0),
    [points],
  );

  const active = hoverIndex ?? null;
  const activePoint = active !== null ? points[active] : undefined;

  if (points.length === 0) {
    return <p className="py-8 text-center text-xs text-muted">No data for this period</p>;
  }

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-44 w-full"
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* Grid — recessive, behind the data, no vertical clutter */}
        {geometry.ticks.map((tick) => (
          <g key={tick.y}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={tick.y}
              y2={tick.y}
              stroke="var(--chart-grid)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 8}
              y={tick.y + 3}
              textAnchor="end"
              className="fill-[var(--chart-axis)] text-[9px] tabular"
            >
              {formatMoneyCompact({ amount: tick.value * 100, currency })}
            </text>
          </g>
        ))}

        <path d={geometry.area} fill={`url(#${gradientId})`} />
        <path
          d={geometry.line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Peak label — a selective direct label, not one per point */}
        {points[peakIndex] && points[peakIndex]!.value > 0 && (
          <g>
            <circle
              cx={geometry.x(peakIndex)}
              cy={geometry.y(points[peakIndex]!.value)}
              r="3.5"
              fill="var(--accent)"
              stroke="var(--surface)"
              strokeWidth="2"
            />
            <text
              x={Math.min(geometry.x(peakIndex), WIDTH - PAD.right - 34)}
              y={Math.max(geometry.y(points[peakIndex]!.value) - 8, 12)}
              textAnchor="middle"
              className="fill-[var(--text-secondary)] text-[9px] font-medium tabular"
            >
              {formatMoneyCompact({ amount: points[peakIndex]!.value * 100, currency })}
            </text>
          </g>
        )}

        {/* Date axis — first, middle, last only */}
        {[0, Math.floor(points.length / 2), points.length - 1].map((i) => (
          <text
            key={i}
            x={geometry.x(i)}
            y={HEIGHT - 6}
            textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
            className="fill-[var(--chart-axis)] text-[9px]"
          >
            {points[i]?.date.slice(5)}
          </text>
        ))}

        {/* Hover crosshair */}
        {active !== null && activePoint && (
          <g pointerEvents="none">
            <line
              x1={geometry.x(active)}
              x2={geometry.x(active)}
              y1={PAD.top}
              y2={PAD.top + geometry.plotH}
              stroke="var(--chart-axis)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <circle
              cx={geometry.x(active)}
              cy={geometry.y(activePoint.value)}
              r="4"
              fill="var(--accent)"
              stroke="var(--surface)"
              strokeWidth="2"
            />
          </g>
        )}

        {/* Invisible hit targets, wider than the marks */}
        {points.map((point, i) => (
          <rect
            key={point.date}
            x={geometry.x(i) - geometry.plotW / points.length / 2}
            y={PAD.top}
            width={geometry.plotW / points.length}
            height={geometry.plotH}
            fill="transparent"
            onMouseEnter={() => setHoverIndex(i)}
          />
        ))}
      </svg>

      <figcaption
        className="mt-1 h-4 text-center text-xs text-secondary tabular"
        aria-live="polite"
      >
        {activePoint
          ? `${formatDate(activePoint.date)} · ${formatMoneyCompact({ amount: activePoint.value * 100, currency })}`
          : ''}
      </figcaption>
    </figure>
  );
}
