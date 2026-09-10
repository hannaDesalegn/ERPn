/**
 * Minimal inline icon set.
 *
 * Hand-rolled rather than pulling in an icon library: we need about twenty
 * glyphs, and inline SVG keeps the bundle small and the render synchronous.
 * Swapping to lucide-react later is a find-and-replace of this one component.
 *
 * Icons are decorative here — every one is paired with a text label — so they
 * are marked aria-hidden. An icon-only control must carry its own aria-label.
 */

const PATHS = {
  dashboard: 'M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z',
  sales: 'M3 3v18h18M7 15l4-5 3 3 5-7',
  cart: 'M6 6h15l-1.5 9h-12L6 6Zm0 0L5 3H2m5 18a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm11 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  box: 'M21 8v8l-9 5-9-5V8l9-5 9 5Zm-18 0 9 5 9-5m-9 5v10',
  users: 'M17 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9.5 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm12.5 10v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8',
  truck: 'M1 4h13v11H1V4Zm13 4h4l3 4v3h-7V8ZM6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  invoice: 'M6 2h9l5 5v15H6V2Zm9 0v5h5M9 12h7M9 16h7M9 8h3',
  bank: 'M3 21h18M4 10h16M5 10V7l7-4 7 4v3M6 10v11m4-11v11m4-11v11m4-11v11',
  ledger: 'M4 3h13a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V3Zm4 5h7M8 12h7M8 16h4',
  chart: 'M3 21h18M7 17V9m5 8V5m5 12v-6',
  shield: 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2-1.2L15 3H9l-.5 2.6a8 8 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a8 8 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2 1.2L9 21h6l.5-2.6a8 8 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2Z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35',
  chevronRight: 'm9 18 6-6-6-6',
  chevronDown: 'm6 9 6 6 6-6',
  chevronLeft: 'm15 18-6-6 6-6',
  arrowUp: 'M12 19V5m-7 7 7-7 7 7',
  arrowDown: 'M12 5v14m7-7-7 7-7-7',
  arrowRight: 'M5 12h14m-7-7 7 7-7 7',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-14h.01M11 12h1v4h1',
  check: 'm20 6-11 11-5-5',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-16v6l4 2',
  close: 'M18 6 6 18M6 6l12 12',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6m4-3h6v6m-11 5L21 3',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-15v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
  filter: 'M3 4h18l-7 8v6l-4 2v-8L3 4Z',
  plus: 'M12 5v14m-7-7h14',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  history: 'M3 3v6h6M3.5 13a9 9 0 1 0 2.6-6.4L3 9m9-1v5l4 2',
  warehouse: 'M2 20V8l10-4 10 4v12H2Zm5 0v-8h10v8M9 20v-4h6v4',
  download: 'M12 3v12m-5-5 5 5 5-5M3 21h18',
  menu: 'M3 6h18M3 12h18M3 18h18',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  className = 'size-4',
  strokeWidth = 1.8,
}: {
  name: IconName;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
