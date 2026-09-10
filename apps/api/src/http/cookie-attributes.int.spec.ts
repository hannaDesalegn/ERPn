/**
 * The attributes actually written on the cookies, under the secure configuration.
 *
 * Criterion 3 requires the session cookie to be `HttpOnly`, `Secure` and `SameSite`. The other
 * HTTP suites assert two of those three and cannot assert the third, because they run with
 * `COOKIE_SECURE` false so that `app.inject` speaks plain HTTP the way local development does.
 * That left the production attribute proven only at the configuration layer: the schema refuses
 * a false value in production, which shows the setting is right and not that the header carries
 * it.
 *
 * So this suite boots one application with the secure configuration and reads the raw
 * `set-cookie` headers. It is small on purpose. Everything else about sessions, forgery and
 * authorization is proven elsewhere and is not repeated here.
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
import { DatabaseModule } from '../database/database.module.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import { CSRF_COOKIE, CSRF_HEADER } from './csrf.js';
import { registerHttpPlugins } from './plugins.js';
import { SESSION_COOKIE } from './session-cookie.js';
import { cookiesFrom } from '../testing/browser-session.js';

/**
 * The one line that matters, and the reason this file exists separately.
 *
 * Every other integration suite sets this false. Changing it there would make `Secure` cookies
 * unsendable over the plain HTTP those suites use, so the secure case gets its own application.
 */
const SECURE_POLICY: Record<string, unknown> = {
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
  COOKIE_SECURE: true,
  TRUSTED_ORIGINS: [],
};

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const USER = 'ae100000-0000-4000-8000-00000000000a';
const EMAIL = 'secure.cookie@test.local';
const PASSWORD = 'a perfectly ordinary passphrase';

describe('Cookie attributes under the secure configuration', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let setCookie: string[];

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
      .useValue({ get: (key: string) => SECURE_POLICY[key] })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await registerHttpPlugins(app);
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();
    await purge();

    // A user and nothing else. Signing in needs no company and no membership, so this suite
    // seeds no tenant: the cookie is written before any of that is resolved.
    const hasher = moduleRef.get(PasswordHasher);
    const uow = moduleRef.get(UnitOfWork);
    const passwordHash = await hasher.hash(PASSWORD);

    await uow.inSystemScope(systemScope('integration-test'), (r) =>
      r.users.create({ id: USER, email: EMAIL, name: 'Secure Cookie', passwordHash }),
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // One sign in, the way the page makes it: read first for the forgery token, then post.
    const visit = await app.inject({ method: 'GET', url: '/api/me' });
    const issued = cookiesFrom(visit.headers['set-cookie'])[CSRF_COOKIE] ?? '';

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie: `${CSRF_COOKIE}=${issued}`, [CSRF_HEADER]: issued },
      payload: { email: EMAIL, password: PASSWORD },
    });

    if (response.statusCode !== 204) {
      throw new Error(`Sign in failed: ${response.statusCode} ${response.body}`);
    }

    const raw = response.headers['set-cookie'];
    setCookie = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await app.close();
  });

  async function purge(): Promise<void> {
    await owner.query('DELETE FROM sessions WHERE user_id = $1', [USER]);
    await owner.query('DELETE FROM auth_throttle');
    await owner.query('DELETE FROM users WHERE id = $1', [USER]);
  }

  const headerFor = (name: string): string => {
    const found = setCookie.find((header) => header.startsWith(`${name}=`));
    if (!found) throw new Error(`Sign in set no ${name} cookie`);
    return found;
  };

  it('wrote both cookies on the sign in response', () => {
    // Without this the assertions below would pass over a header that was never sent.
    expect(setCookie.length).toBeGreaterThanOrEqual(2);
    expect(headerFor(SESSION_COOKIE)).toContain(`${SESSION_COOKIE}=`);
    expect(headerFor(CSRF_COOKIE)).toContain(`${CSRF_COOKIE}=`);
  });

  it('marks the session cookie Secure, HttpOnly and SameSite=Strict', () => {
    // Criterion 3, read off the wire rather than inferred from configuration. `Secure` is the
    // one the other suites cannot show, because they run without it so that plain HTTP works.
    const session = headerFor(SESSION_COOKIE);

    expect(session).toContain('Secure');
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Strict');
  });

  it('marks the forgery cookie Secure and SameSite=Strict, and readable', () => {
    // Secure for the same reason as the session cookie: neither should ever cross plain HTTP.
    // Not HttpOnly, because the page has to read it to put it in a header, which is the whole
    // mechanism in section 14.4.
    const csrf = headerFor(CSRF_COOKIE);

    expect(csrf).toContain('Secure');
    expect(csrf).toContain('SameSite=Strict');
    expect(csrf).not.toContain('HttpOnly');
  });

  it('gives neither cookie an expiry, so the server clock is the only one that counts', () => {
    // Section 5.3 checks expiry on every request. A Max-Age here would be a second, client held
    // answer to the same question.
    expect(headerFor(SESSION_COOKIE)).not.toContain('Max-Age');
    expect(headerFor(SESSION_COOKIE)).not.toContain('Expires');
  });

  it('scopes both cookies to the whole application and to no wider domain', () => {
    for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
      expect(headerFor(name)).toContain('Path=/');
      // No Domain attribute, so the cookie is not offered to sibling subdomains.
      expect(headerFor(name)).not.toContain('Domain=');
    }
  });
});
