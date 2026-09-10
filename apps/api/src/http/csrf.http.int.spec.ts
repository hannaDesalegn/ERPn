/**
 * Cross site request forgery, at the HTTP boundary.
 *
 * Criterion 24 and contract section 14.4. Every request below goes through the real server with
 * the real guard chain, because the thing worth proving is what an attacker's page can and
 * cannot make a browser do, and a test of the token helper proves none of that.
 *
 * The attacks are modelled the way a browser would actually issue them. A cross origin form post
 * carries the victim's cookies and an `Origin` header naming the attacker, and carries no custom
 * header, because a form cannot set one. A cross origin script that sets the header would be
 * stopped by preflight before this server saw it, so the interesting case is the one where the
 * attacker plants a cookie instead, which is tested too.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';

import { AppModule } from '../app.module.js';
import { AppConfigModule } from '../config/config.module.js';
import { PasswordHasher } from '../auth/password-hasher.js';
import { hashSessionToken } from '../auth/session-token.js';
import { RoleProvisioningService } from '../authorization/role-provisioning.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import { CSRF_COOKIE, CSRF_HEADER, csrfTokenFor } from './csrf.js';
import { registerHttpPlugins } from './plugins.js';
import { SESSION_COOKIE } from './session-cookie.js';

const TEST_POLICY: Record<string, unknown> = {
  ARGON2_MEMORY_KIB: 8192,
  ARGON2_TIME_COST: 2,
  ARGON2_PARALLELISM: 1,
  SESSION_IDLE_MINUTES: 60,
  SESSION_ABSOLUTE_MINUTES: 720,
  AUTH_MAX_ATTEMPTS: 90,
  AUTH_WINDOW_MINUTES: 15,
  AUTH_LOCKOUT_MINUTES: 15,
  DATABASE_URL: process.env['DATABASE_URL'],
  DATABASE_POOL_MAX: 10,
  COOKIE_SECURE: false,
  TRUSTED_ORIGINS: [],
};

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT = 'ad100000-0000-4000-8000-00000000000a';
const COMPANY = 'bd100000-0000-4000-8000-00000000000a';
const SECOND_COMPANY = 'bd200000-0000-4000-8000-00000000000b';

const USER = 'cd100000-0000-4000-8000-00000000000a';
const EMAIL = 'csrf@test.local';
const PASSWORD = 'a perfectly ordinary passphrase';

const OTHER_USER = 'cd200000-0000-4000-8000-00000000000b';
const OTHER_EMAIL = 'other.csrf@test.local';

const MEMBERSHIP = 'dd100000-0000-4000-8000-00000000000a';
const MEMBERSHIP_SECOND = 'dd200000-0000-4000-8000-00000000000b';
const OTHER_MEMBERSHIP = 'dd300000-0000-4000-8000-00000000000c';

/**
 * What the application is served from, as a browser would report it.
 *
 * The host is stated on every request as well as the origin, because the origin check compares
 * the two and a test that sets only one is testing a request no browser makes. `app.inject`
 * defaults the host to `localhost:80`, so a bare `http://localhost` origin reads as foreign,
 * which is the check working rather than failing.
 */
const OWN_HOST = 'erp.example';
const OWN_ORIGIN = `https://${OWN_HOST}`;
const ATTACKER_ORIGIN = 'https://evil.example';

/** Headers a request from our own page carries. */
const own = (extra: Record<string, string> = {}): Record<string, string> => ({
  host: OWN_HOST,
  origin: OWN_ORIGIN,
  ...extra,
});

/** Headers a request from someone else's page carries: their origin, our host. */
const foreign = (extra: Record<string, string> = {}): Record<string, string> => ({
  host: OWN_HOST,
  origin: ATTACKER_ORIGIN,
  ...extra,
});

interface Session {
  cookie: string;
  csrf: string;
  raw: string;
}

describe('Cross site request forgery', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let uow: UnitOfWork;
  let roles: { id: string; key: string }[] = [];

  beforeAll(async () => {
    if (!MIGRATION_URL || !process.env['DATABASE_URL']) {
      throw new Error(
        'DATABASE_URL and MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate` first.',
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, AppConfigModule, DatabaseModule],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: (key: string) => TEST_POLICY[key] })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await registerHttpPlugins(app);
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();
    uow = moduleRef.get(UnitOfWork);

    await purge();
    await seed(moduleRef.get(PasswordHasher), moduleRef.get(RoleProvisioningService));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await app.close();
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [[USER, OTHER_USER]]);
    await owner.query('DELETE FROM auth_throttle');
  });

  async function seed(
    hasher: PasswordHasher,
    provisioning: RoleProvisioningService,
  ): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)', [
      TENANT,
      'csrf',
      'Csrf',
    ]);

    const passwordHash = await hasher.hash(PASSWORD);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT }), async (r) => {
      await r.users.create({ id: USER, email: EMAIL, name: 'Csrf User', passwordHash });
      await r.users.create({ id: OTHER_USER, email: OTHER_EMAIL, name: 'Other', passwordHash });
      await r.companies.create({ id: COMPANY, name: 'Csrf Company', baseCurrency: 'USD' });
      await r.companies.create({ id: SECOND_COMPANY, name: 'Second', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT, companyId: COMPANY }),
      async (r) => {
        await r.memberships.create({ id: MEMBERSHIP, userId: USER });
        await r.memberships.create({ id: OTHER_MEMBERSHIP, userId: OTHER_USER });
      },
    );
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT, companyId: SECOND_COMPANY }),
      (r) => r.memberships.create({ id: MEMBERSHIP_SECOND, userId: USER }),
    );

    roles = await provisioning.seedDefaultRoles({ tenantId: TENANT, companyId: COMPANY });

    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [COMPANY]);
    for (const membershipId of [MEMBERSHIP, OTHER_MEMBERSHIP]) {
      await owner.query(
        'INSERT INTO membership_roles (tenant_id, company_id, membership_id, role_id) VALUES ($1,$2,$3,$4)',
        [TENANT, COMPANY, membershipId, roles.find((role) => role.key === 'administrator')?.id],
      );
    }
  }

  async function purge(): Promise<void> {
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [[USER, OTHER_USER]]);
    for (const companyId of [COMPANY, SECOND_COMPANY]) {
      await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
      await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId]);
      await owner.query('DELETE FROM membership_roles WHERE tenant_id = $1', [TENANT]);
      await owner.query('DELETE FROM role_permissions WHERE tenant_id = $1', [TENANT]);
      await owner.query('DELETE FROM roles WHERE tenant_id = $1', [TENANT]);
      await owner.query('DELETE FROM memberships WHERE tenant_id = $1 AND company_id = $2', [
        TENANT,
        companyId,
      ]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        TENANT,
        companyId,
      ]);
    }
    await owner.query(`SELECT set_config('app.tenant_id', '', false)`);
    await owner.query(`SELECT set_config('app.company_id', '', false)`);
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM auth_throttle');
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[USER, OTHER_USER]]);
    await owner.query('DELETE FROM tenants WHERE id = $1', [TENANT]);
  }

  // -------------------------------------------------------------------------------------
  // Helpers that speak HTTP and nothing else.
  // -------------------------------------------------------------------------------------

  const cookiesFrom = (raw: string | string[] | undefined): Record<string, string> => {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const parsed: Record<string, string> = {};

    for (const header of list) {
      const [pair] = header.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name) parsed[name.trim()] = rest.join('=');
    }

    return parsed;
  };

  const attributesOf = (raw: string | string[] | undefined, cookie: string): string => {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.find((header) => header.startsWith(`${cookie}=`)) ?? '';
  };

  /** A visitor with no session, holding whatever cookie the server issued on a read. */
  async function anonymous(): Promise<{ cookie: string; csrf: string }> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: own(),
    });
    const csrf = cookiesFrom(response.headers['set-cookie'])[CSRF_COOKIE] ?? '';

    return { cookie: `${CSRF_COOKIE}=${csrf}`, csrf };
  }

  /** Signs in the way the real page does, and returns everything a later request needs. */
  async function signIn(email = EMAIL): Promise<Session> {
    const before = await anonymous();

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: own({ cookie: before.cookie, [CSRF_HEADER]: before.csrf }),
      payload: { email, password: PASSWORD },
    });

    if (response.statusCode !== 204) {
      throw new Error(`Sign in failed: ${response.statusCode} ${response.body}`);
    }

    const issued = cookiesFrom(response.headers['set-cookie']);
    const raw = issued[SESSION_COOKIE] ?? '';
    const csrf = issued[CSRF_COOKIE] ?? '';

    return { cookie: `${SESSION_COOKIE}=${raw}; ${CSRF_COOKIE}=${csrf}`, csrf, raw };
  }

  /** Enters a company, which every protected route needs. */
  async function enter(session: Session, companyId = COMPANY) {
    return app.inject({
      method: 'POST',
      url: '/api/me/company',
      headers: own({ cookie: session.cookie, [CSRF_HEADER]: session.csrf }),
      payload: { companyId },
    });
  }

  // -------------------------------------------------------------------------------------
  // The happy path, first, because everything else is only interesting if this works.
  // -------------------------------------------------------------------------------------

  describe('a legitimate mutation from our own page', () => {
    it('succeeds with the cookie, the header and a same origin', async () => {
      const session = await signIn();
      const entered = await enter(session);

      expect(entered.statusCode).toBe(201);
    });

    it('lets an authorized user perform a protected mutation', async () => {
      const session = await signIn();
      await enter(session);

      const response = await app.inject({
        method: 'POST',
        url: `/api/members/${OTHER_MEMBERSHIP}/roles`,
        headers: own({ cookie: session.cookie, [CSRF_HEADER]: session.csrf }),
        payload: { roleKey: 'warehouse' },
      });

      expect(response.statusCode).toBe(201);
    });

    it('accepts a DELETE with the same protection', async () => {
      const session = await signIn();
      await enter(session);
      await app.inject({
        method: 'POST',
        url: `/api/members/${OTHER_MEMBERSHIP}/roles`,
        headers: own({ cookie: session.cookie, [CSRF_HEADER]: session.csrf }),
        payload: { roleKey: 'sales' },
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/members/${OTHER_MEMBERSHIP}/roles/sales`,
        headers: own({ cookie: session.cookie, [CSRF_HEADER]: session.csrf }),
      });

      expect(response.statusCode).toBe(200);
    });

    it('issues a token bound to the session, not an arbitrary one', async () => {
      const session = await signIn();

      expect(session.csrf).toBe(csrfTokenFor(hashSessionToken(session.raw)));
    });
  });

  // -------------------------------------------------------------------------------------
  // The forgeries.
  // -------------------------------------------------------------------------------------

  describe('a mutation with no forgery protection', () => {
    it('is refused when the header is absent', async () => {
      const session = await signIn();
      await enter(session);

      const response = await app.inject({
        method: 'POST',
        url: '/api/me/company',
        headers: own({ cookie: session.cookie }),
        payload: { companyId: SECOND_COMPANY },
      });

      expect(response.statusCode).toBe(403);
    });

    it('is refused when the header is empty', async () => {
      const session = await signIn();

      const response = await app.inject({
        method: 'POST',
        url: '/api/me/company',
        headers: own({ cookie: session.cookie, [CSRF_HEADER]: '' }),
        payload: { companyId: COMPANY },
      });

      expect(response.statusCode).toBe(403);
    });

    it('changes nothing when it refuses', async () => {
      const session = await signIn();
      await enter(session, COMPANY);

      await app.inject({
        method: 'POST',
        url: '/api/me/company',
        headers: own({ cookie: session.cookie }),
        payload: { companyId: SECOND_COMPANY },
      });

      const stored = await owner.query<{ active_company_id: string }>(
        'SELECT active_company_id FROM sessions WHERE user_id = $1',
        [USER],
      );
      expect(stored.rows[0]?.active_company_id).toBe(COMPANY);
    });
  });

  describe('a mutation with the wrong token', () => {
    it('is refused for a value that is simply invented', async () => {
      const session = await signIn();

      const response = await app.inject({
        method: 'POST',
        url: '/api/me/company',
        headers: own({ cookie: session.cookie, [CSRF_HEADER]: 'a'.repeat(64) }),
        payload: { companyId: COMPANY },
      });

      expect(response.statusCode).toBe(403);
    });

    it('is refused for another session token', async () => {
      // Two real sessions. The second person's token is a perfectly valid token, and it is not
      // valid here, which is the property that binding to the session buys.
      const mine = await signIn(EMAIL);
      const theirs = await signIn(OTHER_EMAIL);

      expect(theirs.csrf).not.toBe(mine.csrf);

      const response = await app.inject({
        method: 'POST',
        url: '/api/me/company',
        headers: own({ cookie: mine.cookie, [CSRF_HEADER]: theirs.csrf }),
        payload: { companyId: COMPANY },
      });

      expect(response.statusCode).toBe(403);
    });

    it('is refused when an attacker plants a matching cookie and header', async () => {
      // The weakness of a plain double submit, and the reason this one is bound to the session.
      // Someone able to write a cookie for the site, on a sibling subdomain or over plain HTTP,
      // can make the header equal the cookie. They cannot make either equal what this session's
      // token derives to.
      const session = await signIn();
      const planted = 'planted-value-that-matches-itself';

      const response = await app.inject({
        method: 'POST',
        url: '/api/me/company',
        headers: own({
          cookie: `${SESSION_COOKIE}=${session.raw}; ${CSRF_COOKIE}=${planted}`,
          [CSRF_HEADER]: planted,
        }),
        payload: { companyId: COMPANY },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('a cross origin request the way a browser would make it', () => {
    it('refuses a form post from another site, which carries cookies and no custom header', async () => {
      // What a hidden auto-submitting form actually produces. With SameSite=Strict the browser
      // would not even attach the session cookie; this sends it anyway, so the test proves the
      // server refuses rather than that the browser declined to ask.
      const session = await signIn();
      await enter(session);

      const response = await app.inject({
        method: 'POST',
        url: '/api/me/company',
        headers: foreign({
          referer: `${ATTACKER_ORIGIN}/gotcha.html`,
          'content-type': 'application/x-www-form-urlencoded',
          cookie: session.cookie,
        }),
        payload: 'companyId=' + SECOND_COMPANY,
      });

      expect(response.statusCode).toBe(403);
    });

    it('refuses a cross origin request even when it somehow carries the right token', async () => {
      // The origin check is independent of the token, and this is what it is for: it still
      // refuses if a token ever leaks through some other flaw.
      const session = await signIn();

      const response = await app.inject({
        method: 'POST',
        url: '/api/me/company',
        headers: foreign({ cookie: session.cookie, [CSRF_HEADER]: session.csrf }),
        payload: { companyId: COMPANY },
      });

      expect(response.statusCode).toBe(403);
    });

    it('refuses a request whose referer names another site', async () => {
      const session = await signIn();

      const response = await app.inject({
        method: 'POST',
        url: '/api/me/company',
        headers: {
          host: OWN_HOST,
          referer: `${ATTACKER_ORIGIN}/page`,
          cookie: session.cookie,
          [CSRF_HEADER]: session.csrf,
        },
        payload: { companyId: COMPANY },
      });

      expect(response.statusCode).toBe(403);
    });

    it('refuses a cross origin sign in, which is a forgery too', async () => {
      // Login forgery signs a victim into an account the attacker controls, and everything the
      // victim then does happens in that account. Lower severity than acting as the victim, and
      // still worth refusing.
      const before = await anonymous();

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: foreign({ cookie: before.cookie, [CSRF_HEADER]: before.csrf }),
        payload: { email: EMAIL, password: PASSWORD },
      });

      expect(response.statusCode).toBe(403);
    });

    it('refuses a sign in with no custom header, which a form cannot set', async () => {
      const before = await anonymous();

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: own({ cookie: before.cookie }),
        payload: { email: EMAIL, password: PASSWORD },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------------------
  // What must keep working.
  // -------------------------------------------------------------------------------------

  describe('requests the control must not break', () => {
    it('serves the health probe, which carries no cookie and no header', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
    });

    it('serves a read without a token', async () => {
      const session = await signIn();
      await enter(session);

      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: session.cookie },
      });

      expect(response.statusCode).toBe(200);
    });

    it('still refuses an unauthenticated read, so the guard order changed nothing', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/me' });

      expect(response.statusCode).toBe(401);
    });

    it('still refuses a permission the session does not hold', async () => {
      // Authorization is untouched. This person is an administrator in the first company and
      // holds nothing in the second, and the forgery check does not change either answer.
      const session = await signIn();
      await enter(session, SECOND_COMPANY);

      const response = await app.inject({
        method: 'GET',
        url: '/api/members',
        headers: { cookie: session.cookie },
      });

      expect(response.statusCode).toBe(403);
    });

    it('gives a reader the token it will need to mutate later', async () => {
      const session = await signIn();

      const read = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: `${SESSION_COOKIE}=${session.raw}` },
      });

      const issued = cookiesFrom(read.headers['set-cookie'])[CSRF_COOKIE];
      expect(issued).toBe(session.csrf);
    });

    it('replaces a stale token rather than leaving it', async () => {
      const session = await signIn();

      const read = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: `${SESSION_COOKIE}=${session.raw}; ${CSRF_COOKIE}=stale` },
      });

      expect(cookiesFrom(read.headers['set-cookie'])[CSRF_COOKIE]).toBe(session.csrf);
    });
  });

  // -------------------------------------------------------------------------------------
  // The cookies themselves.
  // -------------------------------------------------------------------------------------

  describe('cookie attributes', () => {
    it('keeps the session cookie HttpOnly and out of reach of script', async () => {
      const before = await anonymous();
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: own({ cookie: before.cookie, [CSRF_HEADER]: before.csrf }),
        payload: { email: EMAIL, password: PASSWORD },
      });

      const session = attributesOf(response.headers['set-cookie'], SESSION_COOKIE);

      expect(session).toContain('HttpOnly');
      expect(session).toContain('SameSite=Strict');
      // The response body still carries nothing, so the token exists only in the cookie.
      expect(response.body).toBe('');
    });

    it('makes the forgery cookie readable, because the page has to send it back', async () => {
      const before = await anonymous();
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: own({ cookie: before.cookie, [CSRF_HEADER]: before.csrf }),
        payload: { email: EMAIL, password: PASSWORD },
      });

      const csrf = attributesOf(response.headers['set-cookie'], CSRF_COOKIE);

      expect(csrf).not.toContain('HttpOnly');
      expect(csrf).toContain('SameSite=Strict');
    });

    it('never lets the forgery token stand in for the session token', async () => {
      // The two are different values and only one authenticates. Presenting the readable one as
      // a session must not work, or making it readable would have handed away the session.
      const session = await signIn();

      expect(session.csrf).not.toBe(session.raw);

      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: `${SESSION_COOKIE}=${session.csrf}` },
      });

      expect(response.statusCode).toBe(401);
    });

    it('clears both cookies on sign out', async () => {
      const session = await signIn();

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: own({ cookie: session.cookie, [CSRF_HEADER]: session.csrf }),
      });

      expect(response.statusCode).toBe(204);
      const cleared = cookiesFrom(response.headers['set-cookie']);
      expect(cleared[SESSION_COOKIE]).toBe('');
      expect(cleared[CSRF_COOKIE]).toBe('');
    });
  });
});
