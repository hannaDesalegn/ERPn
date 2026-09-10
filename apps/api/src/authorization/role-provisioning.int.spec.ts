/**
 * Seeding a company's roles, changing who holds them, and the startup catalogue check.
 *
 * Contract sections 2.7 and 6.6, and criterion 11. The test that matters most here is the
 * escalation one: an administrator of a company must not be able to mint authority they do not
 * hold by assigning a role that carries it, which is the classic way a role model becomes a way
 * around itself.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, systemScope, UnitOfWork } from '../database/index.js';
import { AuthorizationModule } from './authorization.module.js';
import { AuthorizationService } from './authorization.service.js';
import { CatalogueIntegrityCheck } from './catalogue-integrity.js';
import { ROLE_TEMPLATES, templatePermissions } from './permissions.js';
import { RoleProvisioningService } from './role-provisioning.service.js';
import type { CompanyContext } from '../identity/identity.service.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT = 'ab100000-0000-4000-8000-00000000000a';
const COMPANY = 'bb100000-0000-4000-8000-00000000000a';
const OTHER_COMPANY = 'bb200000-0000-4000-8000-00000000000b';

const ADMIN = 'cb100000-0000-4000-8000-00000000000a';
const CLERK = 'cb200000-0000-4000-8000-00000000000b';
const LIMITED = 'cb300000-0000-4000-8000-00000000000c';

const MEMBERSHIP_ADMIN = 'db100000-0000-4000-8000-00000000000a';
const MEMBERSHIP_CLERK = 'db200000-0000-4000-8000-00000000000b';
const MEMBERSHIP_LIMITED = 'db300000-0000-4000-8000-00000000000c';
const MEMBERSHIP_ELSEWHERE = 'db400000-0000-4000-8000-00000000000d';

const USERS = [ADMIN, CLERK, LIMITED];

const context: CompanyContext = {
  tenantId: TENANT,
  companyId: COMPANY,
  membershipId: MEMBERSHIP_ADMIN,
};
const limitedContext: CompanyContext = {
  tenantId: TENANT,
  companyId: COMPANY,
  membershipId: MEMBERSHIP_LIMITED,
};

describe('Role provisioning', () => {
  let provisioning: RoleProvisioningService;
  let authorization: AuthorizationService;
  let integrity: CatalogueIntegrityCheck;
  let uow: UnitOfWork;
  let owner: Client;
  let close: () => Promise<void>;

  let seeded: { id: string; key: string }[] = [];
  const roleId = (key: string) => seeded.find((role) => role.key === key)?.id ?? 'missing';

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

    provisioning = moduleRef.get(RoleProvisioningService);
    authorization = moduleRef.get(AuthorizationService);
    integrity = moduleRef.get(CatalogueIntegrityCheck);
    uow = moduleRef.get(UnitOfWork);
    close = () => moduleRef.close();

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();

    await purge();

    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)', [
      TENANT,
      'provisioning',
      'Provisioning',
    ]);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT }), async (r) => {
      await r.users.create({ id: ADMIN, email: 'admin@prov.test', name: 'Admin', passwordHash: 'x' });
      await r.users.create({ id: CLERK, email: 'clerk@prov.test', name: 'Clerk', passwordHash: 'x' });
      await r.users.create({ id: LIMITED, email: 'limited@prov.test', name: 'Limited', passwordHash: 'x' });
      await r.companies.create({ id: COMPANY, name: 'Provisioned', baseCurrency: 'USD' });
      await r.companies.create({ id: OTHER_COMPANY, name: 'Elsewhere', baseCurrency: 'USD' });
    });

    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT, companyId: COMPANY }),
      async (r) => {
        await r.memberships.create({ id: MEMBERSHIP_ADMIN, userId: ADMIN });
        await r.memberships.create({ id: MEMBERSHIP_CLERK, userId: CLERK });
        await r.memberships.create({ id: MEMBERSHIP_LIMITED, userId: LIMITED });
      },
    );
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT, companyId: OTHER_COMPANY }),
      async (r) => {
        await r.memberships.create({ id: MEMBERSHIP_ELSEWHERE, userId: CLERK });
      },
    );

    seeded = await provisioning.seedDefaultRoles({ tenantId: TENANT, companyId: COMPANY });

    // The administrator holds everything, which is what makes the escalation test meaningful:
    // a refusal must come from the role being wider than the actor, not from a bare membership.
    await inCompany((r) =>
      r.roles.assignToMembership({
        membershipId: MEMBERSHIP_ADMIN,
        roleId: roleId('administrator'),
      }),
    );
    await inCompany((r) =>
      r.roles.assignToMembership({
        membershipId: MEMBERSHIP_LIMITED,
        roleId: roleId('purchasing'),
      }),
    );
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await close();
  });

  const inCompany = <T>(work: Parameters<UnitOfWork['inActorScope']>[1]): Promise<T> =>
    uow.inActorScope(
      actorScope({ tenantId: TENANT, companyId: COMPANY, userId: ADMIN }),
      work,
    ) as Promise<T>;

  async function purge(): Promise<void> {
    for (const companyId of [COMPANY, OTHER_COMPANY]) {
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
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [USERS]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [USERS]);
    await owner.query('DELETE FROM tenants WHERE id = $1', [TENANT]);
  }

  /** The owning role is inside FORCE row level security too, so it needs the context set. */
  async function scopedOwner(companyId: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId]);
  }

  const auditIn = (companyId: string) =>
    scopedOwner(companyId)
      .then(() =>
        owner.query<{
          action: string;
          entity_id: string;
          actor_user_id: string | null;
          changes: Record<string, unknown>;
        }>('SELECT action, entity_id, actor_user_id, changes FROM audit_events'),
      )
      .then((r) => r.rows);

  // -------------------------------------------------------------------------------------
  // Seeding.
  // -------------------------------------------------------------------------------------

  describe('seeding the default templates', () => {
    it('creates one role per template', () => {
      expect(seeded.map((role) => role.key).sort()).toEqual(
        Object.keys(ROLE_TEMPLATES).sort(),
      );
    });

    it('grants each role exactly what its template defines', async () => {
      for (const key of Object.keys(ROLE_TEMPLATES) as (keyof typeof ROLE_TEMPLATES)[]) {
        const granted = await inCompany<string[]>((r) =>
          r.roles.listPermissionsForRole(roleId(key)),
        );

        expect(granted).toEqual([...templatePermissions(key)].sort());
      }
    });

    it('stamps every role with the company it was seeded into', async () => {
      // The owning role is subject to FORCE row level security, so it sees the roles table only
      // inside a context. Without this the query returns nothing and the assertion fails for a
      // reason that has nothing to do with what is being tested.
      await scopedOwner(COMPANY);

      const rows = await owner.query<{ tenant_id: string; company_id: string }>(
        'SELECT DISTINCT tenant_id, company_id FROM roles WHERE id = ANY($1)',
        [seeded.map((role) => role.id)],
      );

      expect(rows.rows).toEqual([{ tenant_id: TENANT, company_id: COMPANY }]);
    });

    it('gives another company none of them', async () => {
      // Templates are copied, not shared. The second company was created and never seeded, so
      // it has no roles at all rather than a view of the first company's.
      const elsewhere = await uow.inActorScope(
        actorScope({ tenantId: TENANT, companyId: OTHER_COMPANY, userId: CLERK }),
        (r) => r.roles.listForCompany(),
      );

      expect(elsewhere).toEqual([]);
    });

    it('writes one audit record naming what was seeded', async () => {
      const events = (await auditIn(COMPANY)).filter((e) => e.action === 'roles_seeded');

      expect(events).toHaveLength(1);
      expect(events[0]?.entity_id).toBe(COMPANY);
      // Seeding happens before anyone is inside the company, so there is no actor to record.
      expect(events[0]?.actor_user_id).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 11 and section 6.6.
  // -------------------------------------------------------------------------------------

  describe('assigning a role', () => {
    it('assigns a role the actor fully holds', async () => {
      const result = await provisioning.assignRole({
        context,
        actorUserId: ADMIN,
        membershipId: MEMBERSHIP_CLERK,
        roleKey: 'warehouse',
      });

      expect(result).toEqual({ outcome: 'applied' });

      const grants = await authorization.grantsFor(
        { tenantId: TENANT, companyId: COMPANY, membershipId: MEMBERSHIP_CLERK },
        CLERK,
      );
      expect(grants.permissions).toEqual([...templatePermissions('warehouse')].sort());
    });

    it('refuses a role carrying permissions the actor does not hold', async () => {
      // The limited actor holds the purchasing template, which cannot approve. Assigning the
      // manager role would hand out an approval right they do not have themselves.
      const result = await provisioning.assignRole({
        context: limitedContext,
        actorUserId: LIMITED,
        membershipId: MEMBERSHIP_CLERK,
        roleKey: 'manager',
      });

      expect(result.outcome).toBe('would_escalate');
      expect(result.outcome === 'would_escalate' && result.missing).toContain(
        'purchasing:approve',
      );
    });

    it('writes nothing when it refuses', async () => {
      await owner.query('TRUNCATE audit_events');

      await provisioning.assignRole({
        context: limitedContext,
        actorUserId: LIMITED,
        membershipId: MEMBERSHIP_CLERK,
        roleKey: 'accountant',
      });

      const grants = await authorization.grantsFor(
        { tenantId: TENANT, companyId: COMPANY, membershipId: MEMBERSHIP_CLERK },
        CLERK,
      );
      expect(grants.roles.map((r) => r.key)).not.toContain('accountant');
      expect(await auditIn(COMPANY)).toEqual([]);
    });

    it('allows a role that is a subset of what the actor holds', async () => {
      // The rule is about the permission set, not about role names or hierarchy. Purchasing
      // may hand out a role narrower than its own.
      const result = await provisioning.assignRole({
        context: limitedContext,
        actorUserId: LIMITED,
        membershipId: MEMBERSHIP_CLERK,
        roleKey: 'purchasing',
      });

      expect(result).toEqual({ outcome: 'applied' });
    });

    it('refuses a role key that does not exist in this company', async () => {
      const result = await provisioning.assignRole({
        context,
        actorUserId: ADMIN,
        membershipId: MEMBERSHIP_CLERK,
        roleKey: 'auditor-general',
      });

      expect(result).toEqual({ outcome: 'not_found' });
    });

    it('refuses a membership from another company', async () => {
      // The membership exists and belongs to the same user, in a company this context does not
      // name. It matches no row under this scope rather than being found and then rejected.
      const result = await provisioning.assignRole({
        context,
        actorUserId: ADMIN,
        membershipId: MEMBERSHIP_ELSEWHERE,
        roleKey: 'warehouse',
      });

      expect(result).toEqual({ outcome: 'not_found' });
    });

    it('writes an audit record naming the role and what it grants', async () => {
      await owner.query('TRUNCATE audit_events');

      await provisioning.assignRole({
        context,
        actorUserId: ADMIN,
        membershipId: MEMBERSHIP_CLERK,
        roleKey: 'sales',
      });

      const events = (await auditIn(COMPANY)).filter((e) => e.action === 'role_assigned');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        entity_id: MEMBERSHIP_CLERK,
        actor_user_id: ADMIN,
      });
      // Structured, per section 7.2: what was granted, not a sentence describing it.
      expect(events[0]?.changes).toMatchObject({
        role: { key: 'sales', permissions: [...templatePermissions('sales')].sort() },
      });
    });
  });

  describe('removing a role', () => {
    it('removes it and stops granting immediately', async () => {
      await provisioning.assignRole({
        context,
        actorUserId: ADMIN,
        membershipId: MEMBERSHIP_CLERK,
        roleKey: 'accountant',
      });

      const removed = await provisioning.removeRole({
        context,
        actorUserId: ADMIN,
        membershipId: MEMBERSHIP_CLERK,
        roleKey: 'accountant',
      });

      expect(removed).toEqual({ outcome: 'applied' });

      const grants = await authorization.grantsFor(
        { tenantId: TENANT, companyId: COMPANY, membershipId: MEMBERSHIP_CLERK },
        CLERK,
      );
      expect(grants.roles.map((r) => r.key)).not.toContain('accountant');
      expect(grants.permissions).not.toContain('accounting:post');
    });

    it('writes an audit record', async () => {
      await owner.query('TRUNCATE audit_events');
      await provisioning.removeRole({
        context,
        actorUserId: ADMIN,
        membershipId: MEMBERSHIP_CLERK,
        roleKey: 'sales',
      });

      const events = (await auditIn(COMPANY)).filter((e) => e.action === 'role_removed');
      expect(events).toHaveLength(1);
      expect(events[0]?.actor_user_id).toBe(ADMIN);
    });
  });

  // -------------------------------------------------------------------------------------
  // The startup check, section 2.7.
  // -------------------------------------------------------------------------------------

  describe('the startup catalogue check', () => {
    it('finds nothing wrong with a freshly seeded company', async () => {
      expect(await integrity.findMismatches()).toEqual([]);
    });

    it('finds a stored permission the catalogue no longer defines', async () => {
      // Written past the repository, which is what a release that renamed a capability leaves
      // behind. The rows still look like grants and now grant nothing.
      await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
      await owner.query(`SELECT set_config('app.company_id', $1, false)`, [COMPANY]);
      await owner.query(
        'INSERT INTO role_permissions (tenant_id, company_id, role_id, permission) VALUES ($1,$2,$3,$4)',
        [TENANT, COMPANY, roleId('manager'), 'reports:retired'],
      );

      try {
        const mismatches = await integrity.findMismatches();

        expect(mismatches).toHaveLength(1);
        expect(mismatches[0]).toEqual({
          tenantId: TENANT,
          companyId: COMPANY,
          unknown: ['reports:retired'],
        });

        // And the boot would stop rather than warn.
        await expect(integrity.onApplicationBootstrap()).rejects.toThrow(/not in the catalogue/);
      } finally {
        await owner.query('DELETE FROM role_permissions WHERE permission = $1', [
          'reports:retired',
        ]);
      }
    });

    it('passes when everything stored is defined', async () => {
      await expect(integrity.onApplicationBootstrap()).resolves.toBeUndefined();
    });

    it('refuses to enumerate tenants outside a system scope', async () => {
      // Section 2.10: nothing that serves a request may learn that another tenant exists.
      await expect(
        uow.inActorScope(
          actorScope({ tenantId: TENANT, companyId: COMPANY, userId: ADMIN }),
          (r) => (r as unknown as { tenants: { listAll(): Promise<unknown> } }).tenants.listAll(),
        ),
      ).rejects.toThrow(/requires a system scope/);
    });
  });
});
