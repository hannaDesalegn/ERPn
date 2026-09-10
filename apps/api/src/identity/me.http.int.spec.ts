/**
 * The authenticated HTTP surface, end to end against a real PostgreSQL.
 *
 * Everything below goes through the real server: a real login, a real Set-Cookie header, a real
 * cookie sent back. Nothing constructs a principal by hand, because the thing most worth proving
 * is that a request cannot construct one either.
 *
 * The bulk of this file is attempts to obtain or change company context through the request.
 * Headers, query parameters, path segments and body fields are each tried against a company the
 * user is not a member of, and each must change nothing. Criterion 12 asks for exactly that.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import { AuthModule } from '../auth/auth.module.js';
import { PasswordHasher } from '../auth/password-hasher.js';
import { registerHttpPlugins } from '../http/plugins.js';
import { SESSION_COOKIE } from '../http/session-cookie.js';
import { IdentityModule } from './identity.module.js';

/**
 * Overridden rather than assigned to process.env, for the reason the authentication suite
 * records: imports are hoisted and the configuration module has already read the environment by
 * the time a statement at the top of this file would run.
 *
 * COOKIE_SECURE is false here because `app.inject` speaks plain HTTP. The attribute itself is
 * asserted separately, from configuration, so nothing about that check depends on this value.
 */
const TEST_POLICY: Record<string, unknown> = {
  ARGON2_MEMORY_KIB: 8192,
  ARGON2_TIME_COST: 2,
  ARGON2_PARALLELISM: 1,
  SESSION_IDLE_MINUTES: 60,
  SESSION_ABSOLUTE_MINUTES: 720,
  AUTH_MAX_ATTEMPTS: 50,
  AUTH_WINDOW_MINUTES: 15,
  AUTH_LOCKOUT_MINUTES: 15,
  DATABASE_URL: process.env['DATABASE_URL'],
  DATABASE_POOL_MAX: 10,
  COOKIE_SECURE: false,
};

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_HOME = 'a1100000-0000-4000-8000-00000000000a';
const TENANT_OTHER = 'a1200000-0000-4000-8000-00000000000b';

const HOME = 'b1100000-0000-4000-8000-00000000000a';
/** Same tenant as HOME, and the user is not a member. */
const SIBLING = 'b1200000-0000-4000-8000-00000000000b';
/** Another tenant entirely. */
const OTHER = 'b1300000-0000-4000-8000-00000000000c';

const USER = 'd1100000-0000-4000-8000-00000000000a';
/** Belongs to the sibling company, so that company is real and simply not the caller's. */
const SOMEONE_ELSE = 'd1900000-0000-4000-8000-00000000000f';
const EMAIL = 'http@context.test';
const PASSWORD = 'a perfectly ordinary passphrase';

const MEMBERSHIP_HOME = 'e1100000-0000-4000-8000-00000000000a';
const MEMBERSHIP_SIBLING = 'e1200000-0000-4000-8000-00000000000b';

const TENANTS = [TENANT_HOME, TENANT_OTHER];
const COMPANIES: [string, string][] = [
  [TENANT_HOME, HOME],
  [TENANT_HOME, SIBLING],
  [TENANT_OTHER, OTHER],
];

interface MeBody {
  user: { id: string; email: string; name: string };
  companies: { id: string; name: string; isActive: boolean }[];
  activeCompany: { id: string; name: string } | null;
  roles: { key: string; name: string }[];
}

describe('Authenticated HTTP surface', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let uow: UnitOfWork;

  beforeAll(async () => {
    if (!MIGRATION_URL || !process.env['DATABASE_URL']) {
      throw new Error(
        'DATABASE_URL and MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate` first.',
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule, AuthModule, IdentityModule],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: (key: string) => TEST_POLICY[key] })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // The same registration the process entry point performs. A test server assembled
    // differently proves things about a server nobody deploys.
    await registerHttpPlugins(app);
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();
    uow = moduleRef.get(UnitOfWork);

    await purge();
    await seed(moduleRef.get(PasswordHasher));
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await app.close();
  });

  beforeEach(async () => {
    // Every test logs in for itself. Clearing first means "the session" is unambiguous when a
    // test reads the row back, rather than whichever row the database happened to return.
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [[USER, SOMEONE_ELSE]]);
  });

  async function seed(hasher: PasswordHasher): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_HOME,
      'http-home',
      'HTTP Home',
      TENANT_OTHER,
      'http-other',
      'HTTP Other',
    ]);

    const passwordHash = await hasher.hash(PASSWORD);

    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_HOME }),
      async (r) => {
        await r.users.create({ id: USER, email: EMAIL, name: 'HTTP User', passwordHash });
        await r.users.create({
          id: SOMEONE_ELSE,
          email: 'someone.else@context.test',
          name: 'Someone Else',
          passwordHash,
        });
        await r.companies.create({ id: HOME, name: 'Home Company', baseCurrency: 'USD' });
        await r.companies.create({ id: SIBLING, name: 'Sibling Company', baseCurrency: 'USD' });
      },
    );
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_OTHER }),
      async (r) => {
        await r.companies.create({ id: OTHER, name: 'Other Company', baseCurrency: 'EUR' });
      },
    );
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_HOME, companyId: HOME }),
      async (r) => {
        await r.memberships.create({ id: MEMBERSHIP_HOME, userId: USER });
      },
    );
    // A membership row for the sibling company that belongs to nobody in this test, so the
    // company is real and reachable and simply not this user's.
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_HOME, companyId: SIBLING }),
      async (r) => {
        await r.memberships.create({ id: MEMBERSHIP_SIBLING, userId: SOMEONE_ELSE });
      },
    );
  }

  async function purge(): Promise<void> {
    // Sessions first. `sessions.active_company_id` is a foreign key into `companies`, so a
    // session left pointing at a company blocks that company's deletion.
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [[USER, SOMEONE_ELSE]]);

    for (const [tenantId, companyId] of COMPANIES) {
      await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
      await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId]);
      await owner.query('DELETE FROM memberships WHERE tenant_id = $1 AND company_id = $2', [
        tenantId,
        companyId,
      ]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await owner.query(`SELECT set_config('app.tenant_id', '', false)`);
    await owner.query(`SELECT set_config('app.company_id', '', false)`);
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [[USER, SOMEONE_ELSE]]);
    // Both dimensions. The account rows are keyed by email; the address rows are keyed by the
    // loopback address `app.inject` presents, and leaving one behind shows up as a residual row
    // in the end-of-run check rather than as a failing test.
    await owner.query('DELETE FROM auth_throttle WHERE scope_key LIKE $1 OR scope_key = $2', [
      '%context.test',
      '127.0.0.1',
    ]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[USER, SOMEONE_ELSE]]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [TENANTS]);
  }

  // -------------------------------------------------------------------------------------
  // Helpers that speak HTTP and nothing else.
  // -------------------------------------------------------------------------------------

  const login = async (password = PASSWORD) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, password },
    });

    const setCookie = response.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const token = header?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1] ?? null;

    return { response, header: header ?? null, token };
  };

  const authenticated = async () => {
    const { token } = await login();
    if (!token) throw new Error('Login did not issue a session cookie');
    return `${SESSION_COOKIE}=${token}`;
  };

  const getMe = (cookie?: string, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { ...(cookie ? { cookie } : {}), ...extra },
    });

  const switchTo = (cookie: string, payload: Record<string, unknown>, url = '/api/me/company') =>
    app.inject({ method: 'POST', url, headers: { cookie }, payload });

  // -------------------------------------------------------------------------------------
  // Getting in.
  // -------------------------------------------------------------------------------------

  describe('login', () => {
    it('issues an HttpOnly SameSite cookie and no body', async () => {
      const { response, header } = await login();

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Strict');
      expect(header).toContain('Path=/');
    });

    it('puts no token or session identifier in the response body', async () => {
      // Criterion 3. The cookie is the only place the token appears.
      const { response, token } = await login();

      expect(response.body).not.toContain(token ?? 'unreachable');
      expect(response.body).toBe('');
    });

    it('carries the Secure attribute when configuration asks for it', async () => {
      // This suite runs over plain HTTP, so the cookie is written without Secure. The attribute
      // is driven by configuration, and configuration refuses a false value in production, so
      // what is asserted here is that the setting is the only thing deciding it.
      const { validateEnv } = await import('../config/env.schema.js');

      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
          COOKIE_SECURE: 'false',
        }),
      ).toThrow(/COOKIE_SECURE/);
      expect(
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
        }).COOKIE_SECURE,
      ).toBe(true);
    });

    it('refuses a wrong password with no cookie', async () => {
      const { response, header } = await login('not the password');

      expect(response.statusCode).toBe(401);
      expect(header).toBeNull();
    });

    it('answers a malformed body exactly as it answers a wrong password', async () => {
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: EMAIL, password: 'not the password' },
      });
      const malformed = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: EMAIL },
      });

      expect(malformed.statusCode).toBe(wrong.statusCode);
      expect(JSON.parse(malformed.body)).toEqual(JSON.parse(wrong.body));
    });

    it('answers an unknown account exactly as it answers a wrong password', async () => {
      const unknown = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'nobody@context.test', password: PASSWORD },
      });
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: EMAIL, password: 'not the password' },
      });

      expect(JSON.parse(unknown.body)).toEqual(JSON.parse(wrong.body));
    });
  });

  // -------------------------------------------------------------------------------------
  // Who may call /me at all.
  // -------------------------------------------------------------------------------------

  describe('reaching /me without a session', () => {
    it('refuses a request with no cookie', async () => {
      const response = await getMe();

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).not.toHaveProperty('user');
    });

    it('refuses an invented token', async () => {
      expect((await getMe(`${SESSION_COOKIE}=${'a'.repeat(43)}`)).statusCode).toBe(401);
    });

    it('refuses an empty cookie', async () => {
      expect((await getMe(`${SESSION_COOKIE}=`)).statusCode).toBe(401);
    });

    it('refuses the stored hash presented as the token', async () => {
      const { token } = await login();
      const stored = await owner.query<{ token_hash: string }>(
        'SELECT token_hash FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
        [USER],
      );

      expect(token).not.toBe(stored.rows[0]?.token_hash);
      expect(
        (await getMe(`${SESSION_COOKIE}=${stored.rows[0]?.token_hash ?? 'x'}`)).statusCode,
      ).toBe(401);
    });

    it('refuses a session after logout, using the same cookie', async () => {
      const cookie = await authenticated();
      expect((await getMe(cookie)).statusCode).toBe(200);

      const loggedOut = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie },
      });

      expect(loggedOut.statusCode).toBe(204);
      expect((await getMe(cookie)).statusCode).toBe(401);
    });

    it('refuses a session whose idle window has passed', async () => {
      const cookie = await authenticated();
      await owner.query(
        `UPDATE sessions SET idle_expires_at = now() - interval '1 minute' WHERE user_id = $1`,
        [USER],
      );

      expect((await getMe(cookie)).statusCode).toBe(401);
    });

    it('accepts a logout with no session at all, and says nothing extra', async () => {
      const anonymous = await app.inject({ method: 'POST', url: '/api/auth/logout' });

      expect(anonymous.statusCode).toBe(204);
      expect(anonymous.body).toBe('');
    });
  });

  // -------------------------------------------------------------------------------------
  // What /me reports.
  // -------------------------------------------------------------------------------------

  describe('what an authenticated caller receives', () => {
    it('returns the caller and the companies they belong to', async () => {
      const response = await getMe(await authenticated());
      const body = JSON.parse(response.body) as MeBody;

      expect(response.statusCode).toBe(200);
      expect(body.user).toEqual({ id: USER, email: EMAIL, name: 'HTTP User' });
      expect(body.companies.map((c) => c.id)).toEqual([HOME]);
    });

    it('omits companies in the same tenant that the caller is not a member of', async () => {
      const body = JSON.parse((await getMe(await authenticated())).body) as MeBody;

      // Sibling is real, in the same tenant, and has a membership row belonging to someone
      // else. Being inside the tenant is not membership.
      expect(body.companies.map((c) => c.id)).not.toContain(SIBLING);
      expect(body.companies.map((c) => c.id)).not.toContain(OTHER);
    });

    it('returns no session token, password hash or tenant identifier', async () => {
      const cookie = await authenticated();
      const raw = (await getMe(cookie)).body;

      expect(raw).not.toContain(cookie.split('=')[1] ?? 'unreachable');
      expect(raw).not.toContain('$argon2');
      expect(raw).not.toContain(TENANT_HOME);
      expect(raw).not.toContain(TENANT_OTHER);
    });

    it('starts with no active company and no roles', async () => {
      const body = JSON.parse((await getMe(await authenticated())).body) as MeBody;

      expect(body.activeCompany).toBeNull();
      expect(body.roles).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 12. The request must not be able to choose the company.
  // -------------------------------------------------------------------------------------

  describe('company context cannot be supplied by the request', () => {
    const forgeries: [string, Record<string, string>][] = [
      ['a company header', { 'x-company-id': SIBLING }],
      ['a tenant header', { 'x-tenant-id': TENANT_OTHER }],
      ['an authorization header naming a company', { authorization: `Bearer ${SIBLING}` }],
      ['a forwarded company header', { 'x-forwarded-company': OTHER }],
    ];

    it.each(forgeries)('ignores %s', async (_label, headers) => {
      const cookie = await authenticated();
      await switchTo(cookie, { companyId: HOME });

      const body = JSON.parse((await getMe(cookie, headers)).body) as MeBody;

      expect(body.activeCompany?.id).toBe(HOME);
      expect(body.companies.map((c) => c.id)).toEqual([HOME]);
    });

    it('ignores a company in the query string', async () => {
      const cookie = await authenticated();
      await switchTo(cookie, { companyId: HOME });

      const response = await app.inject({
        method: 'GET',
        url: `/api/me?companyId=${SIBLING}&tenantId=${TENANT_OTHER}`,
        headers: { cookie },
      });
      const body = JSON.parse(response.body) as MeBody;

      expect(body.activeCompany?.id).toBe(HOME);
    });

    it('rejects a tenant identifier smuggled into the switch body', async () => {
      const cookie = await authenticated();

      // Extra fields are not merged into anything. Only companyId is read, and it still has to
      // match a membership, so naming another tenant beside it changes nothing.
      const response = await switchTo(cookie, { companyId: OTHER, tenantId: TENANT_OTHER });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse((await getMe(cookie)).body) as MeBody;
      expect(body.activeCompany).toBeNull();
    });

    it('has no route that takes a company in the path', async () => {
      const cookie = await authenticated();

      // If one is ever added, this fails and the reviewer is forced to look at it.
      expect((await switchTo(cookie, {}, `/api/me/company/${HOME}`)).statusCode).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/me/company/${HOME}`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 13. Switching.
  // -------------------------------------------------------------------------------------

  describe('switching company over HTTP', () => {
    it('enters a company the caller belongs to and reports it back', async () => {
      const cookie = await authenticated();
      const response = await switchTo(cookie, { companyId: HOME });
      const body = JSON.parse(response.body) as MeBody;

      expect(response.statusCode).toBe(201);
      expect(body.activeCompany).toEqual({ id: HOME, name: 'Home Company' });
    });

    it('persists the choice to the session, not to the response only', async () => {
      const cookie = await authenticated();
      await switchTo(cookie, { companyId: HOME });

      const stored = await owner.query<{ active_company_id: string }>(
        'SELECT active_company_id FROM sessions WHERE user_id = $1',
        [USER],
      );
      expect(stored.rows[0]?.active_company_id).toBe(HOME);

      // And a fresh request, carrying nothing but the cookie, still sees it.
      const body = JSON.parse((await getMe(cookie)).body) as MeBody;
      expect(body.activeCompany?.id).toBe(HOME);
    });

    it('refuses a company in the same tenant the caller does not belong to', async () => {
      const cookie = await authenticated();
      const response = await switchTo(cookie, { companyId: SIBLING });

      expect(response.statusCode).toBe(404);
    });

    it('refuses a company in another tenant', async () => {
      expect((await switchTo(await authenticated(), { companyId: OTHER })).statusCode).toBe(404);
    });

    it('answers all three refusals with an identical status and body', async () => {
      // Criterion 15, at the HTTP boundary rather than in the service. Status and body are
      // compared for equality, because either alone can sort real identifiers from invented.
      const cookie = await authenticated();

      const sameTenant = await switchTo(cookie, { companyId: SIBLING });
      const otherTenant = await switchTo(cookie, { companyId: OTHER });
      const nonexistent = await switchTo(cookie, {
        companyId: 'ffffffff-0000-4000-8000-00000000ffff',
      });
      const malformed = await switchTo(cookie, { companyId: 'not-a-uuid' });
      const missingField = await switchTo(cookie, {});

      const shape = (r: { statusCode: number; body: string }) => ({
        status: r.statusCode,
        body: JSON.parse(r.body) as unknown,
      });

      expect(shape(otherTenant)).toEqual(shape(sameTenant));
      expect(shape(nonexistent)).toEqual(shape(sameTenant));
      expect(shape(malformed)).toEqual(shape(sameTenant));
      expect(shape(missingField)).toEqual(shape(sameTenant));
    });

    it('refuses to switch without a session', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/me/company',
        payload: { companyId: HOME },
      });

      expect(response.statusCode).toBe(401);
    });

    it('writes an audit record for the switch and none for a refusal', async () => {
      await owner.query('TRUNCATE audit_events');
      const cookie = await authenticated();

      await switchTo(cookie, { companyId: SIBLING });
      await switchTo(cookie, { companyId: HOME });

      await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_HOME]);
      await owner.query(`SELECT set_config('app.company_id', $1, false)`, [HOME]);
      const events = await owner.query<{ action: string; company_id: string }>(
        'SELECT action, company_id FROM audit_events',
      );

      expect(events.rows.map((r) => r.action)).toEqual(['switched_company']);
      expect(events.rows[0]?.company_id).toBe(HOME);
    });

    it('does not carry context from one session to another', async () => {
      // Two sessions for the same person. Entering a company in one must not enter it in the
      // other, because the company lives on the session rather than on the user.
      const first = await authenticated();
      const second = await authenticated();

      await switchTo(first, { companyId: HOME });

      expect((JSON.parse((await getMe(first)).body) as MeBody).activeCompany?.id).toBe(HOME);
      expect((JSON.parse((await getMe(second)).body) as MeBody).activeCompany).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------
  // Membership ending, mid-session.
  // -------------------------------------------------------------------------------------

  describe('when membership ends while a session is live', () => {
    it('drops the company context on the next request', async () => {
      const cookie = await authenticated();
      await switchTo(cookie, { companyId: HOME });

      await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_HOME]);
      await owner.query(`SELECT set_config('app.company_id', $1, false)`, [HOME]);
      await owner.query(`UPDATE memberships SET status = 'suspended' WHERE id = $1`, [
        MEMBERSHIP_HOME,
      ]);

      try {
        const body = JSON.parse((await getMe(cookie)).body) as MeBody;

        expect(body.activeCompany).toBeNull();
        expect(body.companies).toEqual([]);
        expect(body.roles).toEqual([]);
      } finally {
        await owner.query(`UPDATE memberships SET status = 'active' WHERE id = $1`, [
          MEMBERSHIP_HOME,
        ]);
      }
    });

    it('leaves the session itself valid, because identity did not change', async () => {
      // Losing a membership is not losing an account. The person is still signed in and can
      // still enter any company they do still belong to.
      const cookie = await authenticated();
      await switchTo(cookie, { companyId: HOME });

      await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_HOME]);
      await owner.query(`SELECT set_config('app.company_id', $1, false)`, [HOME]);
      await owner.query(`UPDATE memberships SET status = 'suspended' WHERE id = $1`, [
        MEMBERSHIP_HOME,
      ]);

      try {
        expect((await getMe(cookie)).statusCode).toBe(200);
      } finally {
        await owner.query(`UPDATE memberships SET status = 'active' WHERE id = $1`, [
          MEMBERSHIP_HOME,
        ]);
      }
    });
  });
});
