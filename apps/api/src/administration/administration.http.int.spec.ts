/**
 * Returned-data isolation on the administration read endpoints.
 *
 * Criterion 14 asks that every read endpoint be proven to return only the active tenant's rows,
 * by a test that runs each endpoint as a user of each tenant. Criterion 16 asks that a company
 * administrator cannot read another company's users, roles or memberships. `/me` and
 * `/audit-events` were already proven that way; `/members` and `/roles` were not.
 *
 * WHAT WAS MISSING, AND WHY IT MATTERED. The existing tests on `/members` compare a 200 in one
 * company against a 403 in another, which is an authorization outcome. An endpoint can answer
 * 200 to the right people and still put the wrong rows in the body. The repository and row level
 * security suites do prove the rows, so nothing here is expected to fail; what it adds is proof
 * at the boundary a caller actually reaches, which is where criterion 14 asks for it.
 *
 * THE SEED IS BUILT TO MAKE A LEAK VISIBLE. Two tenants, one company each, and three ways of
 * being wrong are each represented. A user who belongs to only one tenant, so a leak shows as a
 * row they could never have. A user who belongs to both, so a leak shows as two tenants at once
 * rather than as a missing filter. And a role key unique to each company, because the roles
 * endpoint returns keys and names, and two companies seeded from the same templates would
 * otherwise be indistinguishable whether isolation worked or not.
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
import { RoleProvisioningService } from '../authorization/role-provisioning.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import { registerHttpPlugins } from '../http/plugins.js';
import { mutating, signIn, type BrowserSession } from '../testing/browser-session.js';

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

const TENANT_NORTH = 'af100000-0000-4000-8000-00000000000a';
const TENANT_SOUTH = 'af200000-0000-4000-8000-00000000000b';
const COMPANY_NORTH = 'bf100000-0000-4000-8000-00000000000a';
const COMPANY_SOUTH = 'bf200000-0000-4000-8000-00000000000b';

/** Belongs to one tenant each, so a leak shows as a row they could never have. */
const NORTH_ADMIN = 'cf100000-0000-4000-8000-00000000000a';
const SOUTH_ADMIN = 'cf200000-0000-4000-8000-00000000000b';
/** Belongs to both, so a leak shows as two tenants at once rather than a missing filter. */
const ROVER = 'cf300000-0000-4000-8000-00000000000c';
/** Ordinary members, so each list has more than one row to be wrong about. */
const NORTH_CLERK = 'cf400000-0000-4000-8000-00000000000d';
const SOUTH_CLERK = 'cf500000-0000-4000-8000-00000000000e';

const MEMBERSHIP_NORTH_ADMIN = 'df100000-0000-4000-8000-00000000000a';
const MEMBERSHIP_SOUTH_ADMIN = 'df200000-0000-4000-8000-00000000000b';
const MEMBERSHIP_ROVER_NORTH = 'df300000-0000-4000-8000-00000000000c';
const MEMBERSHIP_ROVER_SOUTH = 'df400000-0000-4000-8000-00000000000d';
const MEMBERSHIP_NORTH_CLERK = 'df500000-0000-4000-8000-00000000000e';
const MEMBERSHIP_SOUTH_CLERK = 'df600000-0000-4000-8000-00000000000f';

const ROLE_NORTH_ONLY = 'ef100000-0000-4000-8000-00000000000a';
const ROLE_SOUTH_ONLY = 'ef200000-0000-4000-8000-00000000000b';

const PASSWORD = 'a perfectly ordinary passphrase';
const EMAIL = {
  [NORTH_ADMIN]: 'north.admin@isolation.test',
  [SOUTH_ADMIN]: 'south.admin@isolation.test',
  [ROVER]: 'rover@isolation.test',
} as Record<string, string>;

const ALL_USERS = [NORTH_ADMIN, SOUTH_ADMIN, ROVER, NORTH_CLERK, SOUTH_CLERK];
const NORTH_MEMBERSHIPS = [
  MEMBERSHIP_NORTH_ADMIN,
  MEMBERSHIP_ROVER_NORTH,
  MEMBERSHIP_NORTH_CLERK,
];
const SOUTH_MEMBERSHIPS = [
  MEMBERSHIP_SOUTH_ADMIN,
  MEMBERSHIP_ROVER_SOUTH,
  MEMBERSHIP_SOUTH_CLERK,
];

interface MemberView {
  id: string;
  userId: string;
  status: string;
}

interface RoleView {
  key: string;
  name: string;
}

describe('Administration reads are confined to one tenant', () => {
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
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [ALL_USERS]);
    await owner.query('DELETE FROM auth_throttle');
  });

  async function seed(
    hasher: PasswordHasher,
    provisioning: RoleProvisioningService,
  ): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_NORTH,
      'isolation-north',
      'Isolation North',
      TENANT_SOUTH,
      'isolation-south',
      'Isolation South',
    ]);

    const passwordHash = await hasher.hash(PASSWORD);
    const user = (id: string, email: string, name: string) => ({
      id,
      email,
      name,
      passwordHash,
    });

    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_NORTH }),
      async (r) => {
        await r.users.create(user(NORTH_ADMIN, EMAIL[NORTH_ADMIN]!, 'North Admin'));
        await r.users.create(user(SOUTH_ADMIN, EMAIL[SOUTH_ADMIN]!, 'South Admin'));
        await r.users.create(user(ROVER, EMAIL[ROVER]!, 'Rover'));
        await r.users.create(user(NORTH_CLERK, 'north.clerk@isolation.test', 'North Clerk'));
        await r.users.create(user(SOUTH_CLERK, 'south.clerk@isolation.test', 'South Clerk'));
        await r.companies.create({ id: COMPANY_NORTH, name: 'North', baseCurrency: 'USD' });
      },
    );
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_SOUTH }),
      (r) => r.companies.create({ id: COMPANY_SOUTH, name: 'South', baseCurrency: 'EUR' }),
    );

    await provisionCompany(
      { tenantId: TENANT_NORTH, companyId: COMPANY_NORTH },
      provisioning,
      {
        memberships: [
          [MEMBERSHIP_NORTH_ADMIN, NORTH_ADMIN],
          [MEMBERSHIP_ROVER_NORTH, ROVER],
          [MEMBERSHIP_NORTH_CLERK, NORTH_CLERK],
        ],
        administrators: [MEMBERSHIP_NORTH_ADMIN, MEMBERSHIP_ROVER_NORTH],
        distinctive: { id: ROLE_NORTH_ONLY, key: 'north_only', name: 'North Only' },
      },
    );

    await provisionCompany(
      { tenantId: TENANT_SOUTH, companyId: COMPANY_SOUTH },
      provisioning,
      {
        memberships: [
          [MEMBERSHIP_SOUTH_ADMIN, SOUTH_ADMIN],
          [MEMBERSHIP_ROVER_SOUTH, ROVER],
          [MEMBERSHIP_SOUTH_CLERK, SOUTH_CLERK],
        ],
        administrators: [MEMBERSHIP_SOUTH_ADMIN, MEMBERSHIP_ROVER_SOUTH],
        distinctive: { id: ROLE_SOUTH_ONLY, key: 'south_only', name: 'South Only' },
      },
    );
  }

  async function provisionCompany(
    target: { tenantId: string; companyId: string },
    provisioning: RoleProvisioningService,
    plan: {
      memberships: [string, string][];
      administrators: string[];
      distinctive: { id: string; key: string; name: string };
    },
  ): Promise<void> {
    await uow.inSystemScope(systemScope('tenant-provisioning', target), async (r) => {
      for (const [id, userId] of plan.memberships) {
        await r.memberships.create({ id, userId });
      }
    });

    const seeded = await provisioning.seedDefaultRoles(target);
    const administrator = seeded.find((role) => role.key === 'administrator');

    await uow.inSystemScope(systemScope('tenant-provisioning', target), async (r) => {
      // A role that exists in this company and nowhere else. The endpoint returns keys and
      // names, so without it two companies seeded from the same templates look identical
      // whether isolation works or not.
      await r.roles.create(plan.distinctive);

      for (const membershipId of plan.administrators) {
        await r.roles.assignToMembership({ membershipId, roleId: administrator!.id });
      }
    });
  }

  async function purge(): Promise<void> {
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [ALL_USERS]);

    const scopes: [string, string][] = [
      [TENANT_NORTH, COMPANY_NORTH],
      [TENANT_SOUTH, COMPANY_SOUTH],
    ];
    for (const [tenantId, companyId] of scopes) {
      await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
      await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId]);
      await owner.query('DELETE FROM membership_roles WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM role_permissions WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM roles WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM memberships WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1', [tenantId]);
    }
    await owner.query(`SELECT set_config('app.tenant_id', '', false)`);
    await owner.query(`SELECT set_config('app.company_id', '', false)`);
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM auth_throttle');
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [ALL_USERS]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_NORTH, TENANT_SOUTH]]);
  }

  // -------------------------------------------------------------------------------------
  // Helpers that speak HTTP and nothing else.
  // -------------------------------------------------------------------------------------

  /** Signs in and enters a company, the way the page does. */
  async function working(userId: string, companyId: string): Promise<BrowserSession> {
    const session = await signIn(app, { email: EMAIL[userId]!, password: PASSWORD });
    await entering(session, companyId);
    return session;
  }

  async function entering(session: BrowserSession, companyId: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/me/company',
      headers: mutating(session),
      payload: { companyId },
    });

    if (response.statusCode !== 201) {
      throw new Error(`Could not enter company: ${response.statusCode} ${response.body}`);
    }
  }

  async function members(session: BrowserSession): Promise<MemberView[]> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/members',
      headers: { cookie: session.cookie },
    });

    expect(response.statusCode).toBe(200);
    return JSON.parse(response.body) as MemberView[];
  }

  async function roles(session: BrowserSession): Promise<RoleView[]> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/roles',
      headers: { cookie: session.cookie },
    });

    expect(response.statusCode).toBe(200);
    return JSON.parse(response.body) as RoleView[];
  }

  // -------------------------------------------------------------------------------------
  // Criterion 14, and the read half of criterion 16, for /members.
  // -------------------------------------------------------------------------------------

  describe('GET /members, run as a user of each tenant', () => {
    it('returns the north memberships to a north administrator, and no others', async () => {
      const seen = await members(await working(NORTH_ADMIN, COMPANY_NORTH));

      expect(seen.map((m) => m.id).sort()).toEqual([...NORTH_MEMBERSHIPS].sort());
    });

    it('returns the south memberships to a south administrator, and no others', async () => {
      const seen = await members(await working(SOUTH_ADMIN, COMPANY_SOUTH));

      expect(seen.map((m) => m.id).sort()).toEqual([...SOUTH_MEMBERSHIPS].sort());
    });

    it('shows a north administrator no membership belonging to the other tenant', async () => {
      const seen = await members(await working(NORTH_ADMIN, COMPANY_NORTH));
      const ids = seen.map((m) => m.id);

      for (const foreign of SOUTH_MEMBERSHIPS) {
        expect(ids).not.toContain(foreign);
      }
    });

    it('shows a north administrator no user who belongs only to the other tenant', async () => {
      // Not just the membership rows. A leak that returned the row without its identifier would
      // still disclose that a person exists in another customer's company.
      const seen = await members(await working(NORTH_ADMIN, COMPANY_NORTH));
      const users = seen.map((m) => m.userId);

      expect(users).not.toContain(SOUTH_ADMIN);
      expect(users).not.toContain(SOUTH_CLERK);
      expect(users).toContain(NORTH_CLERK);
    });

    it('shows the same person one tenant at a time as they switch', async () => {
      // The strongest case. This user is genuinely a member of both, so a missing filter shows
      // up as both lists at once rather than as an empty result.
      const session = await working(ROVER, COMPANY_NORTH);
      const north = await members(session);

      await entering(session, COMPANY_SOUTH);
      const south = await members(session);

      expect(north.map((m) => m.id).sort()).toEqual([...NORTH_MEMBERSHIPS].sort());
      expect(south.map((m) => m.id).sort()).toEqual([...SOUTH_MEMBERSHIPS].sort());
      expect(north.map((m) => m.id).some((id) => south.map((s) => s.id).includes(id))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 14, and the read half of criterion 16, for /roles.
  // -------------------------------------------------------------------------------------

  describe('GET /roles, run as a user of each tenant', () => {
    it('shows a north administrator the role that exists only in north', async () => {
      const seen = await roles(await working(NORTH_ADMIN, COMPANY_NORTH));

      expect(seen.map((r) => r.key)).toContain('north_only');
      expect(seen.map((r) => r.key)).not.toContain('south_only');
    });

    it('shows a south administrator the role that exists only in south', async () => {
      const seen = await roles(await working(SOUTH_ADMIN, COMPANY_SOUTH));

      expect(seen.map((r) => r.key)).toContain('south_only');
      expect(seen.map((r) => r.key)).not.toContain('north_only');
    });

    it('shows the same person one company roles at a time as they switch', async () => {
      const session = await working(ROVER, COMPANY_NORTH);
      const north = await roles(session);

      await entering(session, COMPANY_SOUTH);
      const south = await roles(session);

      expect(north.map((r) => r.key)).toContain('north_only');
      expect(north.map((r) => r.key)).not.toContain('south_only');
      expect(south.map((r) => r.key)).toContain('south_only');
      expect(south.map((r) => r.key)).not.toContain('north_only');
    });

    it('gives each company its own copy of the shared templates, not a shared row', async () => {
      // Both companies were seeded from the same templates, so the six keys match. That is the
      // point of section 2.7: the rows are copies a company owns, and the isolation above is
      // about ownership rather than about the two lists happening to differ.
      const north = await roles(await working(NORTH_ADMIN, COMPANY_NORTH));
      const south = await roles(await working(SOUTH_ADMIN, COMPANY_SOUTH));

      const shared = ['administrator', 'manager', 'sales', 'purchasing', 'warehouse', 'accountant'];
      for (const key of shared) {
        expect(north.map((r) => r.key)).toContain(key);
        expect(south.map((r) => r.key)).toContain(key);
      }

      const northIds = await roleIdsIn(TENANT_NORTH, COMPANY_NORTH);
      const southIds = await roleIdsIn(TENANT_SOUTH, COMPANY_SOUTH);
      expect(northIds.some((id) => southIds.includes(id))).toBe(false);
    });
  });

  async function roleIdsIn(tenantId: string, companyId: string): Promise<string[]> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId]);
    const rows = await owner.query<{ id: string }>('SELECT id FROM roles');

    return rows.rows.map((row) => row.id);
  }

  // -------------------------------------------------------------------------------------
  // Criterion 16 states the modify half as well. It is proven in the role provisioning suite,
  // where a membership identifier from another company answers not found. This records that a
  // foreign identifier reaches nothing through the reads either.
  // -------------------------------------------------------------------------------------

  describe('a company administrator reaching for the other tenant', () => {
    it('cannot widen the read with a company or tenant identifier in the request', async () => {
      const session = await working(NORTH_ADMIN, COMPANY_NORTH);

      const response = await app.inject({
        method: 'GET',
        url: `/api/members?companyId=${COMPANY_SOUTH}&tenantId=${TENANT_SOUTH}`,
        headers: {
          cookie: session.cookie,
          'x-company-id': COMPANY_SOUTH,
          'x-tenant-id': TENANT_SOUTH,
        },
      });
      const seen = JSON.parse(response.body) as MemberView[];

      expect(response.statusCode).toBe(200);
      expect(seen.map((m) => m.id).sort()).toEqual([...NORTH_MEMBERSHIPS].sort());
    });

    it('cannot enter the other tenant company at all', async () => {
      // The read is confined because the context is, and the context is confined because the
      // switch refuses. Section 6.1 evaluates that dimension first.
      const session = await signIn(app, { email: EMAIL[NORTH_ADMIN]!, password: PASSWORD });

      const response = await app.inject({
        method: 'POST',
        url: '/api/me/company',
        headers: mutating(session),
        payload: { companyId: COMPANY_SOUTH },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
