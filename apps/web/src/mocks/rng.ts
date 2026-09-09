/**
 * Deterministic pseudo-random generator.
 *
 * Mock data must be STABLE across reloads. If the dashboard shows a different
 * revenue figure every refresh, you cannot tell a rendering bug from noise, and
 * screenshots are useless for review. A seeded generator gives realistic-looking
 * variety that is nonetheless identical every run.
 */

export function createRng(seed: number) {
  // mulberry32 — small, fast, good enough for fixture data.
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    /** Integer in [min, max] inclusive. */
    int(min: number, max: number): number {
      return Math.floor(next() * (max - min + 1)) + min;
    },
    float(min: number, max: number, decimals = 2): number {
      const v = next() * (max - min) + min;
      return Number(v.toFixed(decimals));
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)]!;
    },
    /** Pick n distinct items. */
    sample<T>(items: readonly T[], n: number): T[] {
      const pool = [...items];
      const out: T[] = [];
      for (let i = 0; i < n && pool.length; i++) {
        out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]!);
      }
      return out;
    },
    /** True with the given probability. */
    chance(probability: number): boolean {
      return next() < probability;
    },
  };
}

export type Rng = ReturnType<typeof createRng>;

/** Date helpers used to place documents on a realistic timeline. */
export function daysAgo(n: number, base: Date = REFERENCE_TODAY): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function toISODateTime(d: Date): string {
  return d.toISOString();
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

/**
 * A FIXED "today" for the fixture set.
 *
 * Mock data anchored to the real clock rots: an order dated "3 days ago" when
 * written is 6 months stale later, and every aging bucket drifts. We anchor the
 * dataset to a constant, and the app treats this as "now" while running on mocks.
 * Swapping to a real backend removes this entirely.
 */
export const REFERENCE_TODAY = new Date('2026-08-14T10:00:00.000Z');
