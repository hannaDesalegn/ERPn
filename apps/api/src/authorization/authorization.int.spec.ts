/**
 * Effective permission resolution, against a real PostgreSQL.
 *
 * The seed gives one person a different role in each of two companies, in two different tenants,
 * with the same permission granted in one and not the other. That arrangement is what makes the
 * interesting failures visible: a resolution that ignores the company comes back with the union
 * of both, and one that ignores the tenant comes back with rows it should never have seen.
 *
 * Contract sections 2.7, 6.1 and 6.2.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, systemScope, UnitOfWork, UnknownPermissionError } from '../database/index.js';
import { AuthorizationModule } from './authorization.module.js';
import { AuthorizationService } from './authorization.service.js';
import type { CompanyContext } from '../identity/identity.service.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'aa100000-0000-4000-8000-00000000000a';
const TENANT_B = 'aa200000-0000-4000-8000-00000000000b';

const NORTH = 'ba100000-0000-4000-8000-00000000000a';
const EAST = 'ba200000-0000-4000-8000-00000000000b';

const PERSON = 'ca100000-0000-4000-8000-00000000000a';
const STRANGER = 'ca200000-0000-4000-8000-00000000000b';

const MEMBERSHIP_NORTH = 'da100000-0000-4000-8000-00000000000a';
const MEMBERSHIP_EAST = 'da200000-0000-4000-8000-00000000000b';
const MEMBERSHIP_STRANGER = 'da300000-0000-4000-8000-00000000000c';

const ROLE_NORTH_ACCOUNTANT = 'ea100000-0000-4000-8000-00000000000a';
const ROLE_EAST_WAREHOUSE = 'ea200000-0000-4000-8000-00000000000b';
const ROLE_NORTH_SPARE = 'ea300000-0000-4000-8000-00000000000c';

const TENANTS = [TENANT_A, TENANT_B];
const COMPANIES: [string, string][] = [
  [TENANT_A, NORTH],
  [TENANT_B, EAST],
];
const USERS = [PERSON, STRANGER];

const northContext: CompanyContext = {
  tenantId: TENANT_A,
  companyId: NORTH,
  membershipId: MEMBERSHIP_NORTH,
};
const eastContext: CompanyContext = {
  tenantId: TENANT_B,
  companyId: EAST,
  membershipId: MEMBERSHIP_EAST,
};

describe('Effective permissions', () => {
  let authorization: AuthorizationService;
  let uow: UnitOfWork;
  let owner: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    if (!MIGRATION_URL || !process.env['DATABASE_URL']) {
      throw new Error(
        'DATABASE_URL and MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate` first.',
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule, AuthorizationModule],
    }).compile();
    await moduleRef.init();

    authorization = moduleRef.get(AuthorizationService);
    uow = moduleRef.get(UnitOfWork);
    close = () => moduleRef.close();

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();

    await purge();
    await seed();
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await close();
  });

  /** Everything below writes through the data layer, which is what is under test. */
  const inNorth = <T>(work: Parameters<UnitOfWork['inActorScope']>[1]): Promise<T> =>
    uow.inActorScope(
      actorScope({ tenantId: TENANT_A, companyId: NORTH, userId: PERSON }),
      work,
    ) as Promise<T>;

  const inEast = <T>(work: Parameters<UnitOfWork['inActorScope']>[1]): Promise<T> =>
    uow.inActorScope(
      actorScope({ tenantId: TENANT_B, companyId: EAST, userId: PERSON }),
      work,
    ) as Promise<T>;

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'authz-a',
      'Authz A',
      TENANT_B,
      'authz-b',
      'Authz B',
    ]);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_A }), async (r) => {
      await r.users.create({ id: PERSON, email: 'person@authz.test', name: 'Person', passwordHash: 'x' });
      await r.users.create({ id: STRANGER, email: 'stranger@authz.test', name: 'Stranger', passwordHash: 'x' });
      await r.companies.create({ id: NORTH, name: 'North', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_B }), async (r) => {
      await r.companies.create({ id: EAST, name: 'East', baseCurrency: 'EUR' });
    });

    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: NORTH }),
      async (r) => {
        await r.memberships.create({ id: MEMBERSHIP_NORTH, userId: PERSON });
        await r.memberships.create({ id: MEMBERSHIP_STRANGER, userId: STRANGER });
        await r.roles.create({ id: ROLE_NORTH_ACCOUNTANT, key: 'accountant', name: 'Accountant' });
        await r.roles.create({ id: ROLE_NORTH_SPARE, key: 'sales', name: 'Sales Representative' });
        await r.roles.grantPermissions({
          roleId: ROLE_NORTH_ACCOUNTANT,
          permissions: ['accounting:post', 'invoices:post', 'audit:view'],
        });
        await r.roles.grantPermissions({
          roleId: ROLE_NORTH_SPARE,
          permissions: ['sales:create', 'audit:view'],
        });
        await r.roles.assignToMembership({
          membershipId: MEMBERSHIP_NORTH,
          roleId: ROLE_NORTH_ACCOUNTANT,
        });
      },
    );

    // The same person, another tenant, a role that grants none of the above.
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_B, companyId: EAST }),
      async (r) => {
        await r.memberships.create({ id: MEMBERSHIP_EAST, userId: PERSON });
        await r.roles.create({ id: ROLE_EAST_WAREHOUSE, key: 'warehouse', name: 'Warehouse Operator' });
        await r.roles.grantPermissions({
          roleId: ROLE_EAST_WAREHOUSE,
          permissions: ['inventory:move', 'inventory:view'],
        });
        await r.roles.assignToMembership({
          membershipId: MEMBERSHIP_EAST,
          roleId: ROLE_EAST_WAREHOUSE,
        });
      },
    );
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of COMPANIES) {
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
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [USERS]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [USERS]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [TENANTS]);
  }

  // -------------------------------------------------------------------------------------
  // Resolution.
  // -------------------------------------------------------------------------------------

  describe('resolving what a membership grants', () => {
    it('returns the permissions of the roles that membership holds', async () => {
      const grants = await authorization.grantsFor(northContext, PERSON);

      expect(grants.permissions).toEqual(['accounting:post', 'audit:view', 'invoices:post']);
      expect(grants.roles).toEqual([{ key: 'accountant', name: 'Accountant' }]);
    });

    it('grants nothing from a role that exists but is not assigned', async () => {
      // The spare role is in the same company with a real grant on it. Only assignment reaches
      // a person, so its permissions must not appear.
      const grants = await authorization.grantsFor(northContext, PERSON);

      expect(grants.permissions).not.toContain('sales:create');
    });

    it('unions the permissions of several roles without duplicating the overlap', async () => {
      await inNorth((r) =>
        r.roles.assignToMembership({
          membershipId: MEMBERSHIP_NORTH,
          roleId: ROLE_NORTH_SPARE,
        }),
      );

      try {
        const grants = await authorization.grantsFor(northContext, PERSON);

        // audit:view is granted by both roles and appears once.
        expect(grants.permissions).toEqual([
          'accounting:post',
          'audit:view',
          'invoices:post',
          'sales:create',
        ]);
        expect(grants.roles).toHaveLength(2);
      } finally {
        await inNorth((r) =>
          r.roles.removeFromMembership({
            membershipId: MEMBERSHIP_NORTH,
            roleId: ROLE_NORTH_SPARE,
          }),
        );
      }
    });

    it('grants nothing to a membership with no roles', async () => {
      const grants = await authorization.grantsFor(
        { tenantId: TENANT_A, companyId: NORTH, membershipId: MEMBERSHIP_STRANGER },
        STRANGER,
      );

      expect(grants).toEqual({ roles: [], permissions: [] });
    });
  });

  // -------------------------------------------------------------------------------------
  // Roles do not travel between companies. Criterion 17.
  // -------------------------------------------------------------------------------------

  describe('permissions are a question about a company', () => {
    it('answers differently in each company for the same person', async () => {
      const north = await authorization.grantsFor(northContext, PERSON);
      const east = await authorization.grantsFor(eastContext, PERSON);

      expect(north.permissions).toEqual(['accounting:post', 'audit:view', 'invoices:post']);
      expect(east.permissions).toEqual(['inventory:move', 'inventory:view']);
    });

    it('never leaks one company grants into the other', async () => {
      const east = await authorization.grantsFor(eastContext, PERSON);

      for (const granted of ['accounting:post', 'invoices:post', 'audit:view']) {
        expect(east.permissions).not.toContain(granted);
      }
    });

    it('says no in one company to a capability held in the other', async () => {
      expect(await authorization.can(northContext, PERSON, 'accounting:post')).toBe(true);
      expect(await authorization.can(eastContext, PERSON, 'accounting:post')).toBe(false);

      expect(await authorization.can(eastContext, PERSON, 'inventory:move')).toBe(true);
      expect(await authorization.can(northContext, PERSON, 'inventory:move')).toBe(false);
    });

    it('finds nothing for a membership identifier from another company', async () => {
      // The east membership asked for under the north context. It matches no row rather than
      // resolving the other company's roles, which is section 6.3 rather than a check afterwards.
      const grants = await authorization.grantsFor(
        { tenantId: TENANT_A, companyId: NORTH, membershipId: MEMBERSHIP_EAST },
        PERSON,
      );

      expect(grants).toEqual({ roles: [], permissions: [] });
    });

    it('finds nothing when the tenant and company of a context do not match', async () => {
      // A context that names one tenant and another tenant's company. Nothing can construct one
      // through the identity layer; this proves the data layer refuses it anyway.
      const grants = await authorization.grantsFor(
        { tenantId: TENANT_A, companyId: EAST, membershipId: MEMBERSHIP_EAST },
        PERSON,
      );

      expect(grants).toEqual({ roles: [], permissions: [] });
    });
  });

  // -------------------------------------------------------------------------------------
  // Revocation takes effect immediately, because nothing is cached.
  // -------------------------------------------------------------------------------------

  describe('revocation', () => {
    it('stops granting as soon as a permission is revoked from the role', async () => {
      expect(await authorization.can(northContext, PERSON, 'invoices:post')).toBe(true);

      await inNorth((r) =>
        r.roles.revokePermission({ roleId: ROLE_NORTH_ACCOUNTANT, permission: 'invoices:post' }),
      );

      try {
        // No cache to expire and no session to hunt down. Section 6.6: this is the re-derive
        // half of the choice it requires, and this is the test that it is real.
        expect(await authorization.can(northContext, PERSON, 'invoices:post')).toBe(false);
      } finally {
        await inNorth((r) =>
          r.roles.grantPermissions({
            roleId: ROLE_NORTH_ACCOUNTANT,
            permissions: ['invoices:post'],
          }),
        );
      }
    });

    it('stops granting as soon as the role is removed from the membership', async () => {
      await inNorth((r) =>
        r.roles.removeFromMembership({
          membershipId: MEMBERSHIP_NORTH,
          roleId: ROLE_NORTH_ACCOUNTANT,
        }),
      );

      try {
        expect(await authorization.grantsFor(northContext, PERSON)).toEqual({
          roles: [],
          permissions: [],
        });
      } finally {
        await inNorth((r) =>
          r.roles.assignToMembership({
            membershipId: MEMBERSHIP_NORTH,
            roleId: ROLE_NORTH_ACCOUNTANT,
          }),
        );
      }
    });
  });

  // -------------------------------------------------------------------------------------
  // The catalogue, enforced at the write and again at the read. Section 2.7.
  // -------------------------------------------------------------------------------------

  describe('the catalogue on write', () => {
    it('refuses a permission that is not in the catalogue', async () => {
      await expect(
        inNorth((r) =>
          r.roles.grantPermissions({
            roleId: ROLE_NORTH_SPARE,
            permissions: ['sales:view', 'admin:everything'],
          }),
        ),
      ).rejects.toBeInstanceOf(UnknownPermissionError);
    });

    it('writes none of a batch when one entry is invalid', async () => {
      // All or nothing. A partial write would leave the role holding some of what was asked for,
      // which reads on an administration screen as a successful grant.
      await expect(
        inNorth((r) =>
          r.roles.grantPermissions({
            roleId: ROLE_NORTH_SPARE,
            permissions: ['reports:financial', 'not:real'],
          }),
        ),
      ).rejects.toBeInstanceOf(UnknownPermissionError);

      const stored = await inNorth<string[]>((r) => r.roles.listStoredPermissions());
      expect(stored).not.toContain('reports:financial');
      expect(stored).not.toContain('not:real');
    });

    it('is idempotent when granting what is already granted', async () => {
      await inNorth((r) =>
        r.roles.grantPermissions({
          roleId: ROLE_NORTH_ACCOUNTANT,
          permissions: ['audit:view'],
        }),
      );

      const grants = await authorization.grantsFor(northContext, PERSON);
      expect(grants.permissions.filter((p) => p === 'audit:view')).toHaveLength(1);
    });
  });

  describe('the catalogue on read', () => {
    it('drops a stored string the current release no longer defines', async () => {
      // Written past the repository, as a release that removed a capability would leave behind.
      // The read must fail closed: an unknown string grants nothing rather than being compared
      // against a required permission it can never equal.
      await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
      await owner.query(`SELECT set_config('app.company_id', $1, false)`, [NORTH]);
      await owner.query(
        'INSERT INTO role_permissions (tenant_id, company_id, role_id, permission) VALUES ($1,$2,$3,$4)',
        [TENANT_A, NORTH, ROLE_NORTH_ACCOUNTANT, 'legacy:capability'],
      );

      try {
        const grants = await authorization.grantsFor(northContext, PERSON);

        expect(grants.permissions).not.toContain('legacy:capability');
        expect(grants.permissions).toContain('accounting:post');
      } finally {
        await owner.query(
          'DELETE FROM role_permissions WHERE role_id = $1 AND permission = $2',
          [ROLE_NORTH_ACCOUNTANT, 'legacy:capability'],
        );
      }
    });
  });

  // -------------------------------------------------------------------------------------
  // The scope is still the scope.
  // -------------------------------------------------------------------------------------

  describe('isolation', () => {
    it('cannot read another company roles through the repository', async () => {
      const roles = await inNorth<unknown[]>((r) => r.roles.listForMembership(MEMBERSHIP_EAST));

      expect(roles).toEqual([]);
    });

    it('cannot read another company stored permissions', async () => {
      const north = await inNorth<string[]>((r) => r.roles.listStoredPermissions());
      const east = await inEast<string[]>((r) => r.roles.listStoredPermissions());

      expect(north).not.toContain('inventory:move');
      expect(east).not.toContain('accounting:post');
    });

    it('stamps a new role with the acting company, not one supplied', async () => {
      const created = await inNorth<{ id: string }>((r) =>
        r.roles.create({ id: 'ea900000-0000-4000-8000-00000000000f', key: 'manager', name: 'M' }),
      );

      try {
        const row = await owner.query<{ tenant_id: string; company_id: string }>(
          'SELECT tenant_id, company_id FROM roles WHERE id = $1',
          [created.id],
        );

        expect(row.rows[0]).toEqual({ tenant_id: TENANT_A, company_id: NORTH });
      } finally {
        await owner.query('DELETE FROM roles WHERE id = $1', [created.id]);
      }
    });
  });
});
