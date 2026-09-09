/**
 * The application clock.
 *
 * One source of truth for "now". Nothing that renders a business date may call
 * `new Date()` directly.
 *
 * Why this exists: the fixture set is anchored to a fixed date so the data does
 * not rot, while `new Date()` follows the real machine clock. Any component
 * mixing the two shows an aging bucket computed from one date next to a caption
 * printed from another. Today those happen to coincide, which is exactly what
 * makes the bug easy to ship and hard to notice.
 *
 * The mock layer overrides this on import. When a real backend lands, delete
 * that override and the default takes over. Server-authoritative dates (posting
 * periods, due dates) should still come from the API, not from here.
 */

let source: () => Date = () => new Date();

/** Called by the fixture layer in development. */
export function setClock(fn: () => Date): void {
  source = fn;
}

export function now(): Date {
  return source();
}

/** Current date as 'YYYY-MM-DD'. */
export function todayISO(): string {
  return now().toISOString().slice(0, 10);
}
