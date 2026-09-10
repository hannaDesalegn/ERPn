/**
 * The authentication service against a real PostgreSQL.
 *
 * This is the security test suite for contract sections 5.1 to 5.4 and criterion 18. It is
 * written to attack the control rather than demonstrate it: the tests that matter are the ones
 * that try to enumerate an account, replay a token, outlive an expiry, escape a lockout, or
 * leave a session behind without the audit record that explains it.
 *
 * The database is real, per section 13.2. Row level security policies, grants and check
 * constraints are the logic being tested here, and a fake proves nothing about any of them.
 *
 * Requires `npm run db:up` and `npm run db:migrate`, with DATABASE_URL and
 * MIGRATION_DATABASE_URL set.
 */

// Authentication policy for this suite.
//
// Supplied by overriding ConfigService rather than by assigning to process.env. ESM hoists
// every import above ordinary statements, and ConfigModule.forRoot reads and validates the
// environment while config.module.js is being imported, so an assignment written at the top of
// this file would run after the value had already been read. That failure is silent: the suite
// simply runs under the production defaults and several lockout tests quietly prove nothing.
//
// The argon2 cost is the schema minimum rather than the production default, because this file
// hashes and verifies dozens of times and 64 MiB each time would make the suite unpleasant to
// run. It is still real argon2id with real salts; only the cost differs, and the test that
// cares about the parameters reads them from configuration rather than assuming them.
const TEST_POLICY: Record<string, unknown> = {
  ARGON2_MEMORY_KIB: 8192,
  ARGON2_TIME_COST: 2,
  ARGON2_PARALLELISM: 1,
  SESSION_IDLE_MINUTES: 60,
  SESSION_ABSOLUTE_MINUTES: 720,
  AUTH_MAX_ATTEMPTS: 3,
  AUTH_WINDOW_MINUTES: 15,
  AUTH_LOCKOUT_MINUTES: 15,
  DATABASE_URL: process.env['DATABASE_URL'],
  DATABASE_POOL_MAX: 10,
};

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import { AuthModule } from './auth.module.js';
import { AuthenticationService, type LoginSuccess } from './authentication.service.js';
import { PasswordHasher, parsePhcParameters } from './password-hasher.js';
import { evaluateSession } from './session-policy.js';
import { hashSessionToken } from './session-token.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];
const MAX_ATTEMPTS = 3;

const ALICE_ID = '7a000000-0000-4000-8000-00000000000a';
const ALICE_EMAIL = 'alice.auth@test.local';
const ALICE_PASSWORD = 'correct horse battery staple';

const DISABLED_ID = '7b000000-0000-4000-8000-00000000000b';
const DISABLED_EMAIL = 'disabled.auth@test.local';

const TX_ID = '7c000000-0000-4000-8000-00000000000c';
const TX_EMAIL = 'txconsistency.auth@test.local';

const ALL_USER_IDS = [ALICE_ID, DISABLED_ID, TX_ID];
const ALL_EMAILS = [ALICE_EMAIL, DISABLED_EMAIL, TX_EMAIL];

interface AuditRow {
  action: string;
  entity_id: string | null;
  tenant_id: string | null;
  company_id: string | null;
  summary: string;
  changes: { reason?: string } | null;
  ip_address: string | null;
  user_agent: string | null;
  actor_user_id: string | null;
  txid: string;
}

interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}

describe('Authentication', () => {
  let auth: AuthenticationService;
  let hasher: PasswordHasher;
  let uow: UnitOfWork;
  let owner: Client;
  let close: () => Promise<void>;

  /** Every address used gets its own value, so one test's lockout is never another's. */
  let addressCounter = 0;
  const freshAddress = () => {
    addressCounter += 1;
    return `10.9.${Math.floor(addressCounter / 200)}.${addressCounter % 200}`;
  };

  const loginAs = (email: string, password: string, ipAddress = freshAddress()) =>
    auth.login({ email, password, ipAddress, userAgent: 'integration-test' });

  const sessionRow = (id: string) =>
    owner
      .query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id])
      .then((r) => r.rows[0] ?? null);

  /**
   * Reads platform level audit rows.
   *
   * As the owning role with no tenant context set, which after migration 0003 is the only
   * context that may see them. A tenant scoped context sees none of these, and one of the tests
   * below proves that rather than assuming it.
   */
  const auditFor = (email: string) =>
    owner
      .query<AuditRow>(
        `SELECT * FROM audit_events WHERE summary LIKE '%' || $1 || '%' ORDER BY occurred_at`,
        [email],
      )
      .then((r) => r.rows);

  const clearThrottle = () =>
    owner.query('DELETE FROM auth_throttle WHERE scope_key LIKE $1 OR scope_key LIKE $2', [
      '%test.local',
      '10.9.%',
    ]);

  beforeAll(async () => {
    if (!MIGRATION_URL) {
      throw new Error(
        'MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate`.',
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule, AuthModule],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: (key: string) => TEST_POLICY[key] })
      .compile();
    await moduleRef.init();

    auth = moduleRef.get(AuthenticationService);
    hasher = moduleRef.get(PasswordHasher);
    uow = moduleRef.get(UnitOfWork);
    close = () => moduleRef.close();

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();

    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [ALL_USER_IDS]);
    await owner.query('DELETE FROM users WHERE id = ANY($1) OR email = ANY($2)', [
      ALL_USER_IDS,
      ALL_EMAILS,
    ]);

    const passwordHash = await hasher.hash(ALICE_PASSWORD);

    await uow.inSystemScope(systemScope('integration-test'), async (r) => {
      await r.users.create({ id: ALICE_ID, email: ALICE_EMAIL, name: 'Alice', passwordHash });
      await r.users.create({
        id: DISABLED_ID,
        email: DISABLED_EMAIL,
        name: 'Disabled',
        passwordHash,
      });
      await r.users.create({ id: TX_ID, email: TX_EMAIL, name: 'Tx', passwordHash });
    });

    await owner.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [DISABLED_ID]);
  });

  afterAll(async () => {
    await clearThrottle();
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [ALL_USER_IDS]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [ALL_USER_IDS]);
    // TRUNCATE rather than DELETE. Section 7.1 gives the audit table no delete policy at all,
    // and FORCE ROW LEVEL SECURITY applies that to the owning role too. TRUNCATE is a table
    // privilege that policies do not cover, which is why the integration files run serially.
    await owner.query('TRUNCATE audit_events');
    await owner.end();
    await close();
  });

  beforeEach(async () => {
    await clearThrottle();
  });

  // -------------------------------------------------------------------------------------
  // Credentials, and the enumeration question.
  // -------------------------------------------------------------------------------------

  describe('credential verification', () => {
    it('accepts the correct password', async () => {
      const result = await loginAs(ALICE_EMAIL, ALICE_PASSWORD);

      expect(result.outcome).toBe('authenticated');
      expect((result as LoginSuccess).userId).toBe(ALICE_ID);
    });

    it('rejects the wrong password', async () => {
      const result = await loginAs(ALICE_EMAIL, 'not the password');

      expect(result).toEqual({ outcome: 'rejected', reason: 'invalid_credentials' });
    });

    it('accepts the email in any case and with surrounding space', async () => {
      const result = await loginAs(`  ${ALICE_EMAIL.toUpperCase()}  `, ALICE_PASSWORD);

      expect(result.outcome).toBe('authenticated');
    });

    it('gives a nonexistent account a response identical to a wrong password', async () => {
      // Section 5.2. Identical means deep equal, not merely similar wording: an extra field, a
      // different set of keys, or a retryAfter present in one case and absent in the other is
      // enough to sort real accounts from invented ones.
      const missing = await loginAs('nobody.here@test.local', 'not the password');
      const wrong = await loginAs(ALICE_EMAIL, 'not the password');

      expect(missing).toEqual(wrong);
      expect(Object.keys(missing).sort()).toEqual(Object.keys(wrong).sort());
    });

    it('gives a disabled account the same response as a wrong password', async () => {
      // A disabled account that answers differently has told the attacker it exists.
      const disabled = await loginAs(DISABLED_EMAIL, ALICE_PASSWORD);
      const wrong = await loginAs(ALICE_EMAIL, 'not the password');

      expect(disabled).toEqual(wrong);
    });

    it('creates no session for a disabled account', async () => {
      await loginAs(DISABLED_EMAIL, ALICE_PASSWORD);

      const sessions = await owner.query('SELECT 1 FROM sessions WHERE user_id = $1', [
        DISABLED_ID,
      ]);
      expect(sessions.rowCount).toBe(0);
    });

    it('spends real argon2 work when no account matches, not a parse failure', async () => {
      // The defence this pins is easy to write and easy to get wrong. A hand written decoy
      // string is rejected by argon2 while parsing and returns almost immediately, which
      // restores exactly the fast path it was meant to remove while still looking present in
      // review. So the assertion is not "verify was called" but "verify was called with a real
      // argon2id hash carrying the configured cost".
      const verify = vi.spyOn(hasher, 'verify');

      try {
        await loginAs('nobody.here@test.local', 'whatever');

        expect(verify).toHaveBeenCalledTimes(1);
        const decoy = verify.mock.calls[0]?.[0] ?? '';
        expect(parsePhcParameters(decoy)).toEqual(hasher.currentParameters);
      } finally {
        verify.mockRestore();
      }
    });

    it('never returns a password hash through the authentication API', async () => {
      const result = await loginAs(ALICE_EMAIL, ALICE_PASSWORD);
      const stored = await owner.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [ALICE_ID],
      );

      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain(stored.rows[0]?.password_hash);
      expect(serialised).not.toContain('$argon2');
      expect(serialised).not.toContain(ALICE_PASSWORD);
      expect(Object.keys(result).sort()).toEqual([
        'expiresAt',
        'outcome',
        'sessionId',
        'token',
        'userId',
      ]);
    });
  });

  // -------------------------------------------------------------------------------------
  // Session storage and lookup.
  // -------------------------------------------------------------------------------------

  describe('session storage', () => {
    it('stores a hash and never the token itself', async () => {
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;
      const row = await sessionRow(result.sessionId);

      expect(row?.token_hash).toBe(hashSessionToken(result.token));
      expect(row?.token_hash).not.toBe(result.token);

      // Not merely "the hash column differs from the token". No column anywhere in the row may
      // hold it, which also catches a well meaning debug column added later.
      expect(JSON.stringify(row)).not.toContain(result.token);
    });

    it('finds no row anywhere in the table matching the raw token', async () => {
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;

      const byToken = await owner.query('SELECT 1 FROM sessions WHERE token_hash = $1', [
        result.token,
      ]);
      expect(byToken.rowCount).toBe(0);
    });

    it('validates a session from the hashed token', async () => {
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;

      expect(await auth.validate(result.token)).toEqual({
        outcome: 'valid',
        sessionId: result.sessionId,
        userId: ALICE_ID,
        // Reported, not trusted. Authentication says which company the session last entered;
        // the identity layer is what checks it against a live membership. A session that has
        // entered none carries null, which is the state every session starts in.
        activeCompanyId: null,
      });
    });

    it('rejects a token that was never issued', async () => {
      expect(await auth.validate('a'.repeat(43))).toEqual({ outcome: 'invalid' });
    });

    it('rejects the stored hash presented as if it were the token', async () => {
      // The obvious attack against a hashed token scheme: steal the database, present what is
      // in it. The stored value must not authenticate anything.
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;
      const row = await sessionRow(result.sessionId);

      expect(await auth.validate(row!.token_hash)).toEqual({ outcome: 'invalid' });
    });
  });

  // -------------------------------------------------------------------------------------
  // Expiry. Section 5.3: both windows enforced server side, checked on every request.
  // -------------------------------------------------------------------------------------

  describe('expiry', () => {
    it('rejects a session past its idle window', async () => {
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;
      await owner.query(
        `UPDATE sessions SET idle_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [result.sessionId],
      );

      expect(await auth.validate(result.token)).toEqual({ outcome: 'invalid' });
    });

    it('does not extend the idle window of a session it just rejected', async () => {
      // Expiry is checked before the sliding extension. If the order were reversed, a request
      // arriving one second late would resurrect a dead session rather than be refused by it.
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;
      await owner.query(
        `UPDATE sessions SET idle_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [result.sessionId],
      );
      const before = await sessionRow(result.sessionId);

      await auth.validate(result.token);

      const after = await sessionRow(result.sessionId);
      expect(after?.idle_expires_at).toEqual(before?.idle_expires_at);
    });

    it('rejects a session past its absolute window', async () => {
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;
      // Both columns move together. The table constrains absolute_expires_at >= idle_expires_at,
      // so an expired absolute window with a live idle window is not a representable state, and
      // that is the point: the clamp in the next test is what makes the absolute limit bite.
      await owner.query(
        `UPDATE sessions
            SET absolute_expires_at = now() - interval '1 minute',
                idle_expires_at     = now() - interval '1 minute'
          WHERE id = $1`,
        [result.sessionId],
      );

      const row = await sessionRow(result.sessionId);
      expect(evaluateSession(rowTimes(row!), new Date())).toBe('absolute_expired');
      expect(await auth.validate(result.token)).toEqual({ outcome: 'invalid' });
    });

    it('never extends the idle window past the absolute expiry', async () => {
      // The failure an absolute lifetime exists to prevent: a session used every minute living
      // forever, with each individual extension looking perfectly reasonable.
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;
      // Both columns, because the table constrains absolute_expires_at >= idle_expires_at and
      // moving only the absolute one backwards is rejected by the database.
      await owner.query(
        `UPDATE sessions
            SET absolute_expires_at = now() + interval '30 seconds',
                idle_expires_at     = now() + interval '30 seconds'
          WHERE id = $1`,
        [result.sessionId],
      );

      expect(await auth.validate(result.token)).toEqual({
        outcome: 'valid',
        sessionId: result.sessionId,
        userId: ALICE_ID,
        // Reported, not trusted. Authentication says which company the session last entered;
        // the identity layer is what checks it against a live membership. A session that has
        // entered none carries null, which is the state every session starts in.
        activeCompanyId: null,
      });

      const row = await sessionRow(result.sessionId);
      expect(row!.idle_expires_at).toEqual(row!.absolute_expires_at);
    });

    it('extends the idle window on ordinary use', async () => {
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;
      await owner.query(
        `UPDATE sessions SET idle_expires_at = now() + interval '1 minute' WHERE id = $1`,
        [result.sessionId],
      );
      const before = await sessionRow(result.sessionId);

      await auth.validate(result.token);

      const after = await sessionRow(result.sessionId);
      expect(after!.idle_expires_at.getTime()).toBeGreaterThan(before!.idle_expires_at.getTime());
    });
  });

  // -------------------------------------------------------------------------------------
  // Revocation.
  // -------------------------------------------------------------------------------------

  describe('revocation', () => {
    it('invalidates the session on logout', async () => {
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;

      await auth.logout(result.token);

      expect(await auth.validate(result.token)).toEqual({ outcome: 'invalid' });
      expect((await sessionRow(result.sessionId))?.revoked_at).toBeInstanceOf(Date);
    });

    it('treats logging out twice as ordinary, not as an error', async () => {
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;

      await auth.logout(result.token);
      await expect(auth.logout(result.token)).resolves.toBeUndefined();
    });

    it('ignores a logout for a token that was never issued', async () => {
      await expect(auth.logout('b'.repeat(43))).resolves.toBeUndefined();
    });

    it('revokes every live session for a user at once', async () => {
      const first = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;
      const second = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;

      const revoked = await auth.revokeAllSessionsForUser(ALICE_ID);

      expect(revoked).toBeGreaterThanOrEqual(2);
      expect(await auth.validate(first.token)).toEqual({ outcome: 'invalid' });
      expect(await auth.validate(second.token)).toEqual({ outcome: 'invalid' });
    });
  });

  // -------------------------------------------------------------------------------------
  // Throttling. Section 5.2, and the tests worth having are the bypasses.
  // -------------------------------------------------------------------------------------

  describe('throttling', () => {
    it('locks out after the configured number of failures', async () => {
      const address = freshAddress();

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const result = await loginAs(ALICE_EMAIL, 'wrong', address);
        expect(result).toEqual({ outcome: 'rejected', reason: 'invalid_credentials' });
      }

      const locked = await loginAs(ALICE_EMAIL, 'wrong', address);
      expect(locked).toMatchObject({ outcome: 'rejected', reason: 'locked_out' });
    });

    it('does not let the correct password end a lockout early', async () => {
      // The bypass a limiter most often has. An attacker who guesses correctly on the attempt
      // after the lock must still be refused, and the lock must survive the attempt.
      const address = freshAddress();
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await loginAs(ALICE_EMAIL, 'wrong', address);
      }

      const correct = await loginAs(ALICE_EMAIL, ALICE_PASSWORD, address);
      expect(correct).toMatchObject({ outcome: 'rejected', reason: 'locked_out' });

      const still = await owner.query<{ locked_until: Date | null }>(
        `SELECT locked_until FROM auth_throttle WHERE scope_kind = 'account' AND scope_key = $1`,
        [ALICE_EMAIL],
      );
      expect(still.rows[0]?.locked_until).toBeInstanceOf(Date);
    });

    it('creates no session while locked out', async () => {
      const address = freshAddress();
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await loginAs(ALICE_EMAIL, 'wrong', address);
      }
      const before = await owner.query('SELECT count(*) FROM sessions WHERE user_id = $1', [
        ALICE_ID,
      ]);

      await loginAs(ALICE_EMAIL, ALICE_PASSWORD, address);

      const after = await owner.query('SELECT count(*) FROM sessions WHERE user_id = $1', [
        ALICE_ID,
      ]);
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it('forgives earlier typos once a login succeeds', async () => {
      const address = freshAddress();
      await loginAs(ALICE_EMAIL, 'wrong', address);
      await loginAs(ALICE_EMAIL, 'wrong', address);

      const success = await loginAs(ALICE_EMAIL, ALICE_PASSWORD, address);
      expect(success.outcome).toBe('authenticated');

      // The counter is back to zero, so the next two failures do not reach the limit.
      await loginAs(ALICE_EMAIL, 'wrong', address);
      const second = await loginAs(ALICE_EMAIL, 'wrong', address);
      expect(second).toEqual({ outcome: 'rejected', reason: 'invalid_credentials' });
    });

    it('locks the address even when the attempted accounts differ', async () => {
      // Password spraying: one address, many accounts, one attempt each. A per account limit
      // alone never sees it.
      const address = freshAddress();

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await loginAs(`sprayed-${attempt}@test.local`, 'wrong', address);
      }

      const locked = await loginAs(ALICE_EMAIL, ALICE_PASSWORD, address);
      expect(locked).toMatchObject({ outcome: 'rejected', reason: 'locked_out' });
    });

    it('cannot be outrun by concurrent attempts', async () => {
      // The classic bypass: enough attempts in flight together that each reads the same count
      // and each concludes it is under the limit. The counter is an atomic upsert precisely so
      // that this cannot happen, and this is the test that would catch a regression to a read,
      // decide, write shape.
      const address = freshAddress();
      const attempts = MAX_ATTEMPTS + 6;

      const results = await Promise.all(
        Array.from({ length: attempts }, () => loginAs(ALICE_EMAIL, 'wrong', address)),
      );

      expect(results.every((r) => r.outcome === 'rejected')).toBe(true);

      const row = await owner.query<{ failure_count: number; locked_until: Date | null }>(
        `SELECT failure_count, locked_until FROM auth_throttle
          WHERE scope_kind = 'address' AND scope_key = $1`,
        [address],
      );
      expect(Number(row.rows[0]?.failure_count)).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
      expect(row.rows[0]?.locked_until).toBeInstanceOf(Date);

      // And the state is genuinely locked afterwards, not merely counted.
      expect(await loginAs(ALICE_EMAIL, ALICE_PASSWORD, address)).toMatchObject({
        reason: 'locked_out',
      });
    });
  });

  // -------------------------------------------------------------------------------------
  // Audit. Criterion 18, section 7.1.
  // -------------------------------------------------------------------------------------

  describe('audit', () => {
    it('records a successful login', async () => {
      const address = freshAddress();
      await loginAs(ALICE_EMAIL, ALICE_PASSWORD, address);

      const login = (await auditFor(ALICE_EMAIL)).filter((e) => e.action === 'logged_in').at(-1);

      expect(login).toBeDefined();
      expect(login).toMatchObject({
        action: 'logged_in',
        entity_id: ALICE_ID,
        tenant_id: null,
        company_id: null,
        user_agent: 'integration-test',
      });
      expect(login?.ip_address).toBe(address);
    });

    it('records a failed login, including why', async () => {
      await loginAs(ALICE_EMAIL, 'wrong');

      const failure = (await auditFor(ALICE_EMAIL))
        .filter((e) => e.action === 'login_failed')
        .at(-1);

      expect(failure).toMatchObject({
        action: 'login_failed',
        entity_id: null,
        tenant_id: null,
      });
      expect(failure?.changes).toEqual({ reason: 'invalid_credentials' });
    });

    it('records a login attempt against an account that does not exist', async () => {
      // The attempt with no user and no tenant is the one a naive design cannot record, and it
      // is exactly the attempt worth recording.
      await loginAs('ghost.auth@test.local', 'wrong');

      const events = await auditFor('ghost.auth@test.local');
      expect(events.map((e) => e.action)).toContain('login_failed');
    });

    it('records a lockout distinctly from a bad password', async () => {
      const address = freshAddress();
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await loginAs(ALICE_EMAIL, 'wrong', address);
      }
      await loginAs(ALICE_EMAIL, 'wrong', address);

      const reasons = (await auditFor(ALICE_EMAIL))
        .filter((e) => e.action === 'login_failed')
        .map((e) => e.changes?.reason);

      // The client is told one thing; the trail records what actually happened.
      expect(reasons).toContain('locked_out');
    });

    it('records a logout', async () => {
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;

      await auth.logout(result.token);

      const events = await owner.query<AuditRow>(
        `SELECT * FROM audit_events WHERE action = 'logged_out' AND entity_id = $1`,
        [ALICE_ID],
      );
      expect(events.rowCount).toBeGreaterThan(0);
    });

    it('writes the session and its audit record in one transaction', async () => {
      const result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;

      const login = (await auditFor(ALICE_EMAIL)).filter((e) => e.action === 'logged_in').at(-1);
      const session = await owner.query<{ xmin: string }>(
        'SELECT xmin::text AS xmin FROM sessions WHERE id = $1',
        [result.sessionId],
      );

      // The audit row records the transaction it was written in. It must be the transaction
      // that inserted the session row, which is what section 7.1 means by "the same transaction
      // as the change it describes" rather than "shortly afterwards".
      expect(login?.txid).toBe(session.rows[0]?.xmin);
    });

    it('leaves no session behind when the audit write fails', async () => {
      // Transactional consistency, tested by breaking the audit write rather than by trusting
      // that a BEGIN was issued. The trigger fires only for this one account, so the rest of
      // the suite is untouched.
      await owner.query(`
        CREATE FUNCTION erp_test_block_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF position('${TX_EMAIL}' in NEW.summary) > 0 THEN
            RAISE EXCEPTION 'audit write refused by test';
          END IF;
          RETURN NEW;
        END
        $fn$;
        CREATE TRIGGER erp_test_block_audit_trigger
          BEFORE INSERT ON audit_events
          FOR EACH ROW EXECUTE FUNCTION erp_test_block_audit();
      `);

      try {
        const error = await loginAs(TX_EMAIL, ALICE_PASSWORD).then(
          () => null,
          (thrown: unknown) => thrown,
        );

        // Drizzle wraps the driver error in one of its own, so the sentinel is in the cause
        // chain rather than the top message.
        expect(error).toBeInstanceOf(Error);
        expect(causeChain(error)).toContain('audit write refused by test');

        const sessions = await owner.query('SELECT 1 FROM sessions WHERE user_id = $1', [TX_ID]);
        expect(sessions.rowCount).toBe(0);
      } finally {
        await owner.query('DROP TRIGGER erp_test_block_audit_trigger ON audit_events');
        await owner.query('DROP FUNCTION erp_test_block_audit()');
      }
    });

    it('keeps platform audit rows out of every tenant context', async () => {
      // Migration 0003 made these rows readable in an empty tenant context. That must not have
      // made them readable to a tenant, which is the whole isolation claim.
      await loginAs(ALICE_EMAIL, ALICE_PASSWORD);

      const visibleToTenant = await owner.query<{ count: string }>(
        `SELECT set_config('app.tenant_id', $1, true) AS ignored,
                (SELECT count(*) FROM audit_events WHERE tenant_id IS NULL) AS count`,
        ['11111111-1111-4111-8111-111111111111'],
      );

      expect(Number(visibleToTenant.rows[0]?.count)).toBe(0);
      expect((await auditFor(ALICE_EMAIL)).length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------------------
  // What must never appear, and what authentication must never reach.
  // -------------------------------------------------------------------------------------

  describe('secret handling and scope', () => {
    it('writes no secret to any output stream during a full session lifecycle', async () => {
      const captured: string[] = [];
      const stdout = process.stdout.write.bind(process.stdout);
      const stderr = process.stderr.write.bind(process.stderr);
      const capture = (chunk: unknown): boolean => {
        captured.push(String(chunk));
        return true;
      };

      process.stdout.write = capture as typeof process.stdout.write;
      process.stderr.write = capture as typeof process.stderr.write;

      let result: LoginSuccess;
      try {
        result = (await loginAs(ALICE_EMAIL, ALICE_PASSWORD)) as LoginSuccess;
        await auth.validate(result.token);
        await auth.logout(result.token);
        await loginAs(ALICE_EMAIL, 'wrong');
      } finally {
        process.stdout.write = stdout;
        process.stderr.write = stderr;
      }

      const output = captured.join('');
      expect(output).not.toContain(result.token);
      expect(output).not.toContain(hashSessionToken(result.token));
      expect(output).not.toContain(ALICE_PASSWORD);
      expect(output).not.toContain('$argon2');
    });

    it('cannot reach tenant scoped data from the authentication scope', async () => {
      // An authentication scope has no tenant, and section 6.3 makes that a denial rather than
      // a wildcard. The repository refuses before a query is built, and row level security
      // would deny it a second time if it did not.
      await expect(
        uow.inSystemScope(systemScope('authentication'), (r) => r.companies.listForTenant()),
      ).rejects.toThrow(/system scope with no tenant/);
    });

    it('sees no tenant audit row from an empty tenant context', async () => {
      const foreign = await owner.query<{ count: string }>(
        `SELECT count(*) AS count FROM audit_events WHERE tenant_id IS NOT NULL`,
      );

      // With no tenant context set, only platform rows are visible. A tenant row appearing here
      // would mean the 0003 policy admits more than it claims.
      expect(Number(foreign.rows[0]?.count)).toBe(0);
    });
  });
});

/** Every message in an error's cause chain, since drivers and ORMs both wrap. */
function causeChain(error: unknown): string {
  const messages: string[] = [];

  for (let current = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }

  return messages.join(' | ');
}

function rowTimes(row: SessionRow) {
  return {
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at,
  };
}
