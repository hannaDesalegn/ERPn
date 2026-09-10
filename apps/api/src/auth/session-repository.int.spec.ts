/**
 * The session repository against a real PostgreSQL.
 *
 * What matters here is not that a row can be written and read back. It is that the raw token
 * never reaches the database, that lookup works from the hash alone, and that revocation is a
 * server side fact rather than a client side one. Contract sections 5.1 and 5.3.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import { hashSessionToken, issueSessionToken } from './session-token.js';
import { evaluateSession, extendIdleWindow, newSessionWindow } from './session-policy.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];
const POLICY = { idleMinutes: 60, absoluteMinutes: 720 };

const USER_ID = '5a000000-0000-4000-8000-00000000000a';
const OTHER_USER_ID = '5b000000-0000-4000-8000-00000000000b';

describe('Session repository', () => {
  let uow: UnitOfWork;
  let owner: Client;
  let close: () => Promise<void>;

  const sessionIds: string[] = [];
  const newId = () => {
    const id = crypto.randomUUID();
    sessionIds.push(id);
    return id;
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

    await uow.inSystemScope(systemScope('integration-test'), async (r) => {
      await r.users.create({
        id: USER_ID,
        email: 'session@test.local',
        name: 'Session User',
        passwordHash: 'not-a-real-hash',
      });
      await r.users.create({
        id: OTHER_USER_ID,
        email: 'other@test.local',
        name: 'Other User',
        passwordHash: 'not-a-real-hash',
      });
    });
  });

  afterAll(async () => {
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [[USER_ID, OTHER_USER_ID]]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[USER_ID, OTHER_USER_ID]]);
    await owner.end();
    await close();
  });

  const createSession = (userId = USER_ID, now = new Date()) => {
    const issued = issueSessionToken();
    const window = newSessionWindow(POLICY, now);
    const id = newId();

    return uow
      .inSystemScope(systemScope('integration-test'), (r) =>
        r.sessions.create({
          id,
          userId,
          tokenHash: issued.tokenHash,
          idleExpiresAt: window.idleExpiresAt,
          absoluteExpiresAt: window.absoluteExpiresAt,
          ipAddress: '10.0.0.1',
          userAgent: 'integration-test',
        }),
      )
      .then((session) => ({ session, token: issued.token }));
  };

  describe('token storage', () => {
    it('never writes the raw token to the database', async () => {
      const { token } = await createSession();

      // Search the whole column, not just this row. If the token appeared anywhere the
      // storage model would be broken regardless of which row held it.
      const found = await owner.query('SELECT 1 FROM sessions WHERE token_hash = $1', [token]);

      expect(found.rowCount).toBe(0);
    });

    it('stores the SHA-256 hash of the token', async () => {
      const { token } = await createSession();

      const found = await owner.query('SELECT 1 FROM sessions WHERE token_hash = $1', [
        hashSessionToken(token),
      ]);

      expect(found.rowCount).toBe(1);
    });

    it('does not expose the token hash through the repository record', async () => {
      const { session } = await createSession();

      // A field nobody needs is a field that ends up in a log line.
      expect(Object.keys(session)).not.toContain('tokenHash');
    });

    it('finds a session from a presented token', async () => {
      const { session, token } = await createSession();

      const found = await uow.inSystemScope(systemScope('integration-test'), (r) =>
        r.sessions.findByTokenHash(hashSessionToken(token)),
      );

      expect(found?.id).toBe(session.id);
    });

    it('finds nothing for a token that was never issued', async () => {
      const found = await uow.inSystemScope(systemScope('integration-test'), (r) =>
        r.sessions.findByTokenHash(hashSessionToken(issueSessionToken().token)),
      );

      expect(found).toBeNull();
    });
  });

  describe('expiry', () => {
    it('creates a session that is immediately usable', async () => {
      const now = new Date();
      const { session } = await createSession(USER_ID, now);

      expect(evaluateSession(session, now)).toBeNull();
    });

    it('rejects a session whose idle window has passed', async () => {
      const now = new Date();
      const { session } = await createSession(USER_ID, now);

      const later = new Date(now.getTime() + 61 * 60_000);
      expect(evaluateSession(session, later)).toBe('idle_expired');
    });

    it('rejects a session whose absolute lifetime has passed', async () => {
      const now = new Date();
      const { session } = await createSession(USER_ID, now);

      const muchLater = new Date(now.getTime() + 721 * 60_000);
      expect(evaluateSession(session, muchLater)).toBe('absolute_expired');
    });

    it('extends the idle window on use, and leaves the absolute lifetime alone', async () => {
      const now = new Date();
      const { session } = await createSession(USER_ID, now);
      const later = new Date(now.getTime() + 30 * 60_000);

      await uow.inSystemScope(systemScope('integration-test'), (r) =>
        r.sessions.touch({ id: session.id, idleExpiresAt: extendIdleWindow(POLICY, session, later) }),
      );

      const stored = await owner.query<{ idle_expires_at: Date; absolute_expires_at: Date }>(
        'SELECT idle_expires_at, absolute_expires_at FROM sessions WHERE id = $1',
        [session.id],
      );

      expect(stored.rows[0]?.idle_expires_at.getTime()).toBeGreaterThan(
        session.idleExpiresAt.getTime(),
      );
      // The absolute deadline is the one use must never move. Section 5.3.
      expect(stored.rows[0]?.absolute_expires_at).toEqual(session.absoluteExpiresAt);
    });
  });

  describe('revocation', () => {
    it('revokes a session server side', async () => {
      const { session, token } = await createSession();

      await uow.inSystemScope(systemScope('integration-test'), (r) => r.sessions.revoke(session.id));

      const found = await uow.inSystemScope(systemScope('integration-test'), (r) =>
        r.sessions.findByTokenHash(hashSessionToken(token)),
      );

      // The row survives, for the audit trail. What changed is that it no longer authenticates.
      expect(found).not.toBeNull();
      expect(evaluateSession(found!, new Date())).toBe('revoked');
    });

    it('keeps the original revocation time when revoked twice', async () => {
      const { session } = await createSession();

      await uow.inSystemScope(systemScope('integration-test'), (r) => r.sessions.revoke(session.id));
      const first = await owner.query<{ revoked_at: Date }>(
        'SELECT revoked_at FROM sessions WHERE id = $1',
        [session.id],
      );

      await uow.inSystemScope(systemScope('integration-test'), (r) => r.sessions.revoke(session.id));
      const second = await owner.query<{ revoked_at: Date }>(
        'SELECT revoked_at FROM sessions WHERE id = $1',
        [session.id],
      );

      expect(second.rows[0]?.revoked_at).toEqual(first.rows[0]?.revoked_at);
    });

    it('revokes every live session for one user, and nobody elses', async () => {
      // The path a password change and a dismissal both take. Contract section 5.2.
      const mine = await Promise.all([createSession(), createSession()]);
      const theirs = await createSession(OTHER_USER_ID);

      const revoked = await uow.inSystemScope(systemScope('integration-test'), (r) =>
        r.sessions.revokeAllForUser(USER_ID),
      );

      expect(revoked).toBeGreaterThanOrEqual(mine.length);

      const other = await uow.inSystemScope(systemScope('integration-test'), (r) =>
        r.sessions.findByTokenHash(hashSessionToken(theirs.token)),
      );
      expect(evaluateSession(other!, new Date())).toBeNull();
    });

    it('does not extend the idle window of a revoked session', async () => {
      const { session } = await createSession();
      await uow.inSystemScope(systemScope('integration-test'), (r) => r.sessions.revoke(session.id));

      const before = await owner.query<{ idle_expires_at: Date }>(
        'SELECT idle_expires_at FROM sessions WHERE id = $1',
        [session.id],
      );

      await uow.inSystemScope(systemScope('integration-test'), (r) =>
        r.sessions.touch({ id: session.id, idleExpiresAt: new Date(Date.now() + 999 * 60_000) }),
      );

      const after = await owner.query<{ idle_expires_at: Date }>(
        'SELECT idle_expires_at FROM sessions WHERE id = $1',
        [session.id],
      );

      expect(after.rows[0]?.idle_expires_at).toEqual(before.rows[0]?.idle_expires_at);
    });
  });
});
