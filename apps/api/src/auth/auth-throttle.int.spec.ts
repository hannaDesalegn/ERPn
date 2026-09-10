/**
 * Login throttling against a real PostgreSQL.
 *
 * Contract section 5.2. The tests that matter are the ones that try to get past the limiter:
 * a correct password mid-lockout, and concurrent attempts racing the counter. A test that only
 * counts to ten and stops proves the happy path of a control, which is not the same as proving
 * the control.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import type { AuthThrottlePolicy } from '../database/repositories/types.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const POLICY: AuthThrottlePolicy = { maxAttempts: 5, windowMinutes: 15, lockoutMinutes: 15 };

describe('Login throttling', () => {
  let uow: UnitOfWork;
  let owner: Client;
  let close: () => Promise<void>;

  const keys: string[] = [];
  const freshKey = (prefix: string) => {
    const key = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    keys.push(key.toLowerCase());
    return key;
  };

  beforeAll(async () => {
    if (!MIGRATION_URL) {
      throw new Error('MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate`.');
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
    }).compile();
    await moduleRef.init();

    uow = moduleRef.get(UnitOfWork);
    close = () => moduleRef.close();

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();
  });

  afterAll(async () => {
    await owner.query('DELETE FROM auth_throttle WHERE scope_key = ANY($1)', [keys]);
    await owner.end();
    await close();
  });

  const fail = (kind: 'address' | 'account', key: string) =>
    uow.inSystemScope(systemScope('integration-test'), (r) =>
      r.authThrottle.recordFailure(kind, key, POLICY),
    );

  const status = (kind: 'address' | 'account', key: string) =>
    uow.inSystemScope(systemScope('integration-test'), (r) => r.authThrottle.status(kind, key));

  const clear = (kind: 'address' | 'account', key: string) =>
    uow.inSystemScope(systemScope('integration-test'), (r) =>
      r.authThrottle.clearOnSuccess(kind, key),
    );

  it('starts with no failures and no lock', async () => {
    expect(await status('account', freshKey('new'))).toEqual({
      failureCount: 0,
      lockedUntil: null,
    });
  });

  it('counts failures up to the limit without locking', async () => {
    const key = freshKey('counting');

    for (let attempt = 1; attempt < POLICY.maxAttempts; attempt++) {
      const result = await fail('account', key);
      expect(result.failureCount).toBe(attempt);
      expect(result.lockedUntil).toBeNull();
    }
  });

  it('locks on the attempt that reaches the limit', async () => {
    const key = freshKey('locking');

    for (let attempt = 1; attempt < POLICY.maxAttempts; attempt++) {
      await fail('account', key);
    }
    const final = await fail('account', key);

    expect(final.failureCount).toBe(POLICY.maxAttempts);
    expect(final.lockedUntil).toBeInstanceOf(Date);
    expect(final.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('counts address and account separately', async () => {
    // Two dimensions, per section 5.2. An attacker spreading across accounts still trips the
    // address limit; one spreading across addresses still trips the account limit.
    const key = freshKey('shared');

    await fail('address', key);
    await fail('address', key);
    await fail('account', key);

    expect((await status('address', key)).failureCount).toBe(2);
    expect((await status('account', key)).failureCount).toBe(1);
  });

  it('treats keys case insensitively, so varying case does not multiply the allowance', async () => {
    const key = freshKey('CaseKey');

    await fail('account', key.toUpperCase());
    await fail('account', key.toLowerCase());

    expect((await status('account', key)).failureCount).toBe(2);
  });

  describe('bypass attempts', () => {
    it('does not let a successful authentication clear a lock that is in force', async () => {
      // The obvious bypass: fail until locked, then supply the correct password. If clearing
      // were unconditional the lockout would be worth nothing.
      const key = freshKey('bypass-lock');
      for (let i = 0; i < POLICY.maxAttempts; i++) await fail('account', key);

      const locked = await status('account', key);
      expect(locked.lockedUntil).not.toBeNull();

      await clear('account', key);

      const afterSuccess = await status('account', key);
      expect(afterSuccess.lockedUntil).not.toBeNull();
    });

    it('does clear earlier failures when not locked, so typos are forgiven', async () => {
      const key = freshKey('forgiven');
      await fail('account', key);
      await fail('account', key);

      await clear('account', key);

      expect(await status('account', key)).toEqual({ failureCount: 0, lockedUntil: null });
    });

    it('cannot be raced past the limit by concurrent attempts', async () => {
      // Twenty simultaneous failures against a limit of five. A read-then-write limiter lets
      // most of these through, because each reads the same count before any writes. The
      // single-statement upsert serialises them on the row lock.
      const key = freshKey('concurrent');

      const results = await Promise.all(
        Array.from({ length: 20 }, () => fail('account', key)),
      );

      const counts = results.map((r) => r.failureCount).sort((a, b) => a - b);
      // Every attempt got a distinct, consecutive count. No two attempts saw the same number.
      expect(counts).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

      const final = await status('account', key);
      expect(final.failureCount).toBe(20);
      expect(final.lockedUntil).not.toBeNull();
    });
  });

  describe('the window', () => {
    it('restarts the count once the window has elapsed', async () => {
      const key = freshKey('window');
      await fail('account', key);
      await fail('account', key);

      // Age the window past its limit rather than waiting fifteen minutes. The row is moved,
      // not the clock, so the assertion is about the query and not about the test harness.
      await owner.query(
        `UPDATE auth_throttle SET window_started_at = now() - make_interval(mins => $1)
         WHERE scope_kind = 'account' AND scope_key = $2`,
        [POLICY.windowMinutes + 1, key.toLowerCase()],
      );

      const afterWindow = await fail('account', key);

      expect(afterWindow.failureCount).toBe(1);
    });

    it('reports an elapsed lock as unlocked', async () => {
      const key = freshKey('expired-lock');
      for (let i = 0; i < POLICY.maxAttempts; i++) await fail('account', key);

      await owner.query(
        `UPDATE auth_throttle SET locked_until = now() - make_interval(mins => 1)
         WHERE scope_kind = 'account' AND scope_key = $1`,
        [key.toLowerCase()],
      );

      // A lock whose time has passed is not a lock. Reporting it as one would keep a person
      // out until something happened to reset the row.
      expect((await status('account', key)).lockedUntil).toBeNull();
    });

    it('allows clearing once a lock has elapsed', async () => {
      const key = freshKey('clear-after-lock');
      for (let i = 0; i < POLICY.maxAttempts; i++) await fail('account', key);
      await owner.query(
        `UPDATE auth_throttle SET locked_until = now() - make_interval(mins => 1)
         WHERE scope_kind = 'account' AND scope_key = $1`,
        [key.toLowerCase()],
      );

      await clear('account', key);

      expect(await status('account', key)).toEqual({ failureCount: 0, lockedUntil: null });
    });
  });

  it('survives a restart, because the state is in PostgreSQL and not in memory', async () => {
    // An in-memory limiter resets on deploy, which makes it a limiter an attacker clears by
    // waiting for a release. A second module instance stands in for a restart or a replica.
    const key = freshKey('durable');
    for (let i = 0; i < 3; i++) await fail('account', key);

    const secondInstance = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
    }).compile();
    await secondInstance.init();

    try {
      const seen = await secondInstance
        .get(UnitOfWork)
        .inSystemScope(systemScope('integration-test'), (r) =>
          r.authThrottle.status('account', key),
        );

      expect(seen.failureCount).toBe(3);
    } finally {
      await secondInstance.close();
    }
  });
});
