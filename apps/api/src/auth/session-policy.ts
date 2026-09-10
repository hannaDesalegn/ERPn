/**
 * Session lifetime rules, as pure functions.
 *
 * Contract section 5.3 requires an idle timeout and an absolute maximum lifetime, both enforced
 * server side, and expiry checked on every request rather than trusted from a cookie attribute.
 *
 * These are separated from the repository and the service on purpose. Expiry is the kind of
 * logic that is easy to get subtly wrong at a boundary, easy to test exhaustively when it takes
 * a clock as an argument, and impossible to test properly when it reads `Date.now()` inside a
 * database call.
 */

export interface SessionLifetimePolicy {
  idleMinutes: number;
  absoluteMinutes: number;
}

export interface SessionWindow {
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

/** Why a session was refused. The caller decides how much of this a client learns. */
export type SessionRejection = 'revoked' | 'idle_expired' | 'absolute_expired';

export interface SessionTimes {
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

const MINUTE_MS = 60_000;

/** The window a session gets at creation. Both clocks start now. */
export function newSessionWindow(policy: SessionLifetimePolicy, now: Date): SessionWindow {
  return {
    idleExpiresAt: new Date(now.getTime() + policy.idleMinutes * MINUTE_MS),
    absoluteExpiresAt: new Date(now.getTime() + policy.absoluteMinutes * MINUTE_MS),
  };
}

/**
 * The idle window after activity.
 *
 * Never past the absolute expiry. Without that clamp a session used every minute would live
 * forever, which is the failure an absolute lifetime exists to prevent, and it would be
 * invisible because each individual extension looks reasonable.
 */
export function extendIdleWindow(
  policy: SessionLifetimePolicy,
  session: Pick<SessionTimes, 'absoluteExpiresAt'>,
  now: Date,
): Date {
  const extended = new Date(now.getTime() + policy.idleMinutes * MINUTE_MS);

  return extended > session.absoluteExpiresAt ? session.absoluteExpiresAt : extended;
}

/**
 * Whether a session may still be used, and if not, why.
 *
 * Revocation is checked first. A revoked session that has also expired is revoked: the reason
 * a person was signed out matters more than the clock, and an operator investigating wants the
 * deliberate act reported rather than the incidental one.
 */
export function evaluateSession(session: SessionTimes, now: Date): SessionRejection | null {
  if (session.revokedAt !== null) return 'revoked';
  if (now >= session.absoluteExpiresAt) return 'absolute_expired';
  if (now >= session.idleExpiresAt) return 'idle_expired';

  return null;
}
