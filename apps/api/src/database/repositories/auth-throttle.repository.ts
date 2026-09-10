/**
 * Login throttling. INTERNAL, like every other repository implementation here.
 *
 * Contract section 5.2: login is rate limited per address and per account, with progressive
 * backoff and lockout, and every failure is recorded.
 *
 * THE ONE THING THIS FILE HAS TO GET RIGHT is that recording a failure is a single statement.
 * The obvious shape, read the count then decide then write, is wrong under concurrency: ten
 * simultaneous attempts each read the same count, each conclude they are under the limit, and
 * the limiter has been bypassed by the only attacker who would bother. `INSERT ... ON CONFLICT
 * DO UPDATE` takes a row lock, so the ten attempts serialise and the tenth sees nine.
 *
 * State lives in PostgreSQL rather than in memory because contract section 1.2 defers Redis out
 * of slice 1, and because in-memory counters reset on deploy and do not exist across replicas,
 * which makes them a limiter an attacker can clear by waiting for a release.
 */

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  AuthThrottlePolicy,
  AuthThrottleRepository,
  AuthThrottleScopeKind,
  AuthThrottleStatus,
} from './types.js';

type Db = NodePgDatabase<Record<string, never>>;

/**
 * Note the loose types, which are not laziness.
 *
 * Drizzle's raw `execute` does not apply the same result parsing as its query builder, so a
 * `timestamptz` arrives as a string here and as a `Date` elsewhere. That difference is silent
 * and it bit: comparing the string against a `Date` is always false, which made a lockout
 * register in the database and report as absent, so the limiter counted correctly and never
 * locked anyone out. `toStatus` now coerces rather than trusting the driver.
 */
type ThrottleRow = Record<string, unknown> & {
  failure_count: number | string;
  locked_until: Date | string | null;
};

export class DrizzleAuthThrottleRepository implements AuthThrottleRepository {
  /**
   * No scope parameter. This table is global by necessity, per contract section 4.6: it is
   * written before any tenant exists to scope it to.
   */
  constructor(private readonly db: Db) {}

  async status(kind: AuthThrottleScopeKind, key: string): Promise<AuthThrottleStatus> {
    const result = await this.db.execute<ThrottleRow>(sql`
      SELECT failure_count, locked_until
      FROM auth_throttle
      WHERE scope_kind = ${kind} AND scope_key = ${normalise(key)}
    `);

    const row = result.rows[0];
    if (!row) return { failureCount: 0, lockedUntil: null };

    return toStatus(row);
  }

  async recordFailure(
    kind: AuthThrottleScopeKind,
    key: string,
    policy: AuthThrottlePolicy,
  ): Promise<AuthThrottleStatus> {
    // `windowElapsed` and `nextCount` are repeated rather than factored into a CTE because
    // ON CONFLICT DO UPDATE cannot reference one of its own assignments, and a CTE would break
    // the single-statement atomicity that is the whole point.
    const windowElapsed = sql`auth_throttle.window_started_at < now() - make_interval(mins => ${policy.windowMinutes})`;
    const nextCount = sql`CASE WHEN ${windowElapsed} THEN 1 ELSE auth_throttle.failure_count + 1 END`;

    const result = await this.db.execute<ThrottleRow>(sql`
      INSERT INTO auth_throttle
        (scope_kind, scope_key, failure_count, window_started_at, last_failure_at, updated_at)
      VALUES (${kind}, ${normalise(key)}, 1, now(), now(), now())
      ON CONFLICT (scope_kind, scope_key) DO UPDATE SET
        failure_count = ${nextCount},
        window_started_at = CASE WHEN ${windowElapsed} THEN now() ELSE auth_throttle.window_started_at END,
        last_failure_at = now(),
        locked_until = CASE
          WHEN ${nextCount} >= ${policy.maxAttempts}
            THEN now() + make_interval(mins => ${policy.lockoutMinutes})
          ELSE auth_throttle.locked_until
        END,
        updated_at = now()
      RETURNING failure_count, locked_until
    `);

    const row = result.rows[0];
    if (!row) throw new Error('Throttle upsert returned no row');

    return toStatus(row);
  }

  async clearOnSuccess(kind: AuthThrottleScopeKind, key: string): Promise<void> {
    // The predicate is the control. A lock still in force is left alone, so a correct password
    // part way through a lockout does not end it early. Earlier typos are forgiven; a lock is
    // not. There is no code path above this that can pass a flag to skip the check.
    await this.db.execute(sql`
      UPDATE auth_throttle
      SET failure_count = 0,
          locked_until = NULL,
          window_started_at = now(),
          updated_at = now()
      WHERE scope_kind = ${kind}
        AND scope_key = ${normalise(key)}
        AND (locked_until IS NULL OR locked_until <= now())
    `);
  }
}

/**
 * Addresses and emails are compared case insensitively, so the key is lowercased once here.
 *
 * Without this, `User@example.com` and `user@example.com` would count separately and an
 * attacker could multiply their allowance by varying the case.
 */
function normalise(key: string): string {
  return key.trim().toLowerCase();
}

function toStatus(row: ThrottleRow): AuthThrottleStatus {
  const stored = coerceDate(row.locked_until);

  // A lock whose time has passed is not a lock. Reporting it as one would keep a person out
  // until something happened to reset the row.
  const lockedUntil = stored && stored.getTime() > Date.now() ? stored : null;

  return { failureCount: Number(row.failure_count), lockedUntil };
}

function coerceDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;

  const parsed = new Date(value);
  // An unparseable timestamp is treated as no lock rather than as a lock at the epoch, which
  // would lock the subject out permanently on bad data.
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
