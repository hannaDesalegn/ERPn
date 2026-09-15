/**
 * The application clock.
 *
 * One source of truth for "now". Nothing that renders a business date may call
 * `new Date()` directly.
 *
 * Why this exists: one indirection means a test can freeze time, and means a component
 * cannot quietly read the machine clock while the value beside it came from somewhere else.
 * An aging bucket computed from one date next to a caption printed from another is the bug
 * this prevents, and it is easy to ship because the two usually coincide.
 *
 * THE DEFAULT IS REAL TIME, and as of the sales order module that is no longer negotiable.
 * The fixture layer used to pin this to its own anchor on import, which was right while every
 * date on screen came from fixtures and wrong the moment one did not: an audit event the
 * server recorded a minute ago was measured against a date weeks in the past, so the trail
 * read "just now" forever. Contract section 16.1 gave that override the removal trigger
 * "when the API supplies dates", and it does.
 *
 * Fixture derived figures that still need the anchor ask for it explicitly, through
 * `agingReference` in the service layer, rather than bending everyone else's clock.
 *
 * Server-authoritative dates, meaning posting periods and due dates, still come from the API
 * rather than from here.
 */

const systemClock = (): Date => new Date();

let source: () => Date = systemClock;

/**
 * Freezes the clock. For tests, and for nothing else.
 *
 * Production reads the system clock, and there is deliberately no way to configure that:
 * a deployment that could pin its own "now" would age every invoice in the system wrongly.
 */
export function setClock(fn: () => Date): void {
  source = fn;
}

/** Puts the system clock back, so one test cannot leave another measuring from a fiction. */
export function resetClock(): void {
  source = systemClock;
}

export function now(): Date {
  return source();
}

/** Current date as 'YYYY-MM-DD'. */
export function todayISO(): string {
  return now().toISOString().slice(0, 10);
}
