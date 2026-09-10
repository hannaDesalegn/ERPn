import {
  evaluateSession,
  extendIdleWindow,
  newSessionWindow,
  type SessionLifetimePolicy,
} from './session-policy.js';

const POLICY: SessionLifetimePolicy = { idleMinutes: 60, absoluteMinutes: 720 };
const NOW = new Date('2026-09-10T12:00:00.000Z');

const minutesFrom = (base: Date, minutes: number) =>
  new Date(base.getTime() + minutes * 60_000);

describe('newSessionWindow', () => {
  it('starts both clocks at creation', () => {
    const window = newSessionWindow(POLICY, NOW);

    expect(window.idleExpiresAt).toEqual(minutesFrom(NOW, 60));
    expect(window.absoluteExpiresAt).toEqual(minutesFrom(NOW, 720));
  });
});

describe('extendIdleWindow', () => {
  it('pushes the idle deadline forward from the moment of use', () => {
    const session = { absoluteExpiresAt: minutesFrom(NOW, 720) };
    const later = minutesFrom(NOW, 30);

    expect(extendIdleWindow(POLICY, session, later)).toEqual(minutesFrom(later, 60));
  });

  it('never pushes past the absolute expiry', () => {
    // Without this clamp, a session used once a minute would live forever, and every single
    // extension would look reasonable in isolation. Contract section 5.3.
    const absolute = minutesFrom(NOW, 720);
    const nearTheEnd = minutesFrom(NOW, 700);

    expect(extendIdleWindow(POLICY, { absoluteExpiresAt: absolute }, nearTheEnd)).toEqual(absolute);
  });

  it('cannot resurrect a session past an absolute expiry already in the past', () => {
    const absolute = minutesFrom(NOW, -1);

    expect(extendIdleWindow(POLICY, { absoluteExpiresAt: absolute }, NOW)).toEqual(absolute);
  });
});

describe('evaluateSession', () => {
  const live = {
    idleExpiresAt: minutesFrom(NOW, 60),
    absoluteExpiresAt: minutesFrom(NOW, 720),
    revokedAt: null,
  };

  it('accepts a live session', () => {
    expect(evaluateSession(live, NOW)).toBeNull();
  });

  it('rejects a session past its idle deadline', () => {
    expect(evaluateSession(live, minutesFrom(NOW, 61))).toBe('idle_expired');
  });

  it('rejects a session past its absolute deadline', () => {
    const stillFresh = {
      idleExpiresAt: minutesFrom(NOW, 800),
      absoluteExpiresAt: minutesFrom(NOW, 720),
      revokedAt: null,
    };

    // Idle is nowhere near, so only the absolute lifetime can refuse this one. That is the
    // case an idle timeout alone would miss.
    expect(evaluateSession(stillFresh, minutesFrom(NOW, 721))).toBe('absolute_expired');
  });

  it('rejects exactly at the deadline, not one tick after', () => {
    expect(evaluateSession(live, minutesFrom(NOW, 60))).toBe('idle_expired');
  });

  it('rejects a revoked session even while both clocks are healthy', () => {
    expect(evaluateSession({ ...live, revokedAt: NOW }, NOW)).toBe('revoked');
  });

  it('reports revocation ahead of expiry when both apply', () => {
    // The deliberate act is the one an operator investigating wants to see.
    const expiredAndRevoked = { ...live, revokedAt: NOW };

    expect(evaluateSession(expiredAndRevoked, minutesFrom(NOW, 900))).toBe('revoked');
  });
});
