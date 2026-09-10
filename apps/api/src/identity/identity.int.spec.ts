/**
 * Company context and switching, against a real PostgreSQL.
 *
 * The seed is built to make a mistake visible rather than to make the happy path work. Two
 * tenants, three companies, and a user who belongs to one company in each tenant, so any answer
 * that is quietly tenant scoped comes back half right and any answer that ignores membership
 * comes back too long.
 *
 * Contract sections 2.5, 2.6 and 2.10. Criteria 12, 13, 16 and 17.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, systemScope, UnitOfWork } from '../database/index.js';
import { IdentityModule } from './identity.module.js';
import { IdentityService, type AuthenticatedPrincipal } from './identity.service.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_ONE = '7d100000-0000-4000-8000-00000000000a';
const TENANT_TWO = '7d200000-0000-4000-8000-00000000000b';

/** Two companies in tenant one, so "wrong company, right tenant" is representable. */
const NORTH = 'c1100000-0000-4000-8000-00000000000a';
const SOUTH = 'c1200000-0000-4000-8000-00000000000b';
/** One company in tenant two, which nobody from tenant one may enter. */
const FOREIGN = 'c2100000-0000-4000-8000-00000000000c';

const MEMBER = '8d100000-0000-4000-8000-00000000000a';
const OUTSIDER = '8d200000-0000-4000-8000-00000000000b';

const MEMBERSHIP_NORTH = 'ed100000-0000-4000-8000-00000000000a';
const MEMBERSHIP_FOREIGN = 'ed200000-0000-4000-8000-00000000000b';
const MEMBERSHIP_OUTSIDER = 'ed300000-0000-4000-8000-00000000000c';

const ROLE_APPROVER = 'fd100000-0000-4000-8000-00000000000a';
const ROLE_VIEWER = 'fd200000-0000-4000-8000-00000000000b';

const SESSION_ID = '9d100000-0000-4000-8000-00000000000a';

const TENANTS = [TENANT_ONE, TENANT_TWO];
const COMPANIES: [string, string][] = [
  [TENANT_ONE, NORTH],
  [TENANT_ONE, SOUTH],
  [TENANT_TWO, FOREIGN],
];
const USERS = [MEMBER, OUTSIDER];

describe('Company context', () => {
  let identity: IdentityService;
  let uow: UnitOfWork;
  let owner: Client;
  let close: () => Promise<void>;

  const principal = (activeCompanyId: string | null = null): AuthenticatedPrincipal => ({
    sessionId: SESSION_ID,
    userId: MEMBER,
    activeCompanyId,
  });

  beforeAll(async () => {
    if (!MIGRATION_URL || !process.env['DATABASE_URL']) {
      throw new Error(
        'DATABASE_URL and MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate` first.',
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule, IdentityModule],
    }).compile();
    await moduleRef.init();

    identity = moduleRef.get(IdentityService);
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

  beforeEach(async () => {
    await owner.query('UPDATE sessions SET active_company_id = NULL WHERE id = $1', [SESSION_ID]);
  });

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_ONE,
      'context-one',
      'Context One',
      TENANT_TWO,
      'context-two',
      'Context Two',
    ]);

    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_ONE }),
      async (r) => {
        await r.users.create({
          id: MEMBER,
          email: 'member@context.test',
          name: 'Member',
          passwordHash: 'x',
        });
        await r.users.create({
          id: OUTSIDER,
          email: 'outsider@context.test',
          name: 'Outsider',
          passwordHash: 'x',
        });
        await r.companies.create({ id: NORTH, name: 'North Trading', baseCurrency: 'USD' });
        await r.companies.create({ id: SOUTH, name: 'South Trading', baseCurrency: 'USD' });
      },
    );

    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_TWO }),
      async (r) => {
        await r.companies.create({ id: FOREIGN, name: 'Foreign Trading', baseCurrency: 'EUR' });
      },
    );

    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_ONE, companyId: NORTH }),
      async (r) => {
        await r.memberships.create({ id: MEMBERSHIP_NORTH, userId: MEMBER });
      },
    );
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_ONE, companyId: SOUTH }),
      async (r) => {
        await r.memberships.create({ id: MEMBERSHIP_OUTSIDER, userId: OUTSIDER });
      },
    );
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_TWO, companyId: FOREIGN }),
      async (r) => {
        await r.memberships.create({ id: MEMBERSHIP_FOREIGN, userId: MEMBER });
      },
    );

    // Deliberately colliding role keys. The same key means different things in different
    // companies, which is what makes criterion 17 a real test rather than a naming exercise.
    await insertRole(TENANT_ONE, NORTH, ROLE_APPROVER, 'approver', 'Approver');
    await insertRole(TENANT_TWO, FOREIGN, ROLE_VIEWER, 'viewer', 'Viewer');
    await grantRole(TENANT_ONE, NORTH, MEMBERSHIP_NORTH, ROLE_APPROVER);
    await grantRole(TENANT_TWO, FOREIGN, MEMBERSHIP_FOREIGN, ROLE_VIEWER);

    await owner.query(
      `INSERT INTO sessions (id, token_hash, user_id, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour', now() + interval '12 hours')`,
      [SESSION_ID, 'context-test-not-a-real-hash', MEMBER],
    );
  }

  async function insertRole(
    tenantId: string,
    companyId: string,
    id: string,
    key: string,
    name: string,
  ): Promise<void> {
    await scopedOwner(tenantId, companyId);
    await owner.query(
      'INSERT INTO roles (id, tenant_id, company_id, key, name) VALUES ($1,$2,$3,$4,$5)',
      [id, tenantId, companyId, key, name],
    );
  }

  async function grantRole(
    tenantId: string,
    companyId: string,
    membershipId: string,
    roleId: string,
  ): Promise<void> {
    await scopedOwner(tenantId, companyId);
    await owner.query(
      'INSERT INTO membership_roles (tenant_id, company_id, membership_id, role_id) VALUES ($1,$2,$3,$4)',
      [tenantId, companyId, membershipId, roleId],
    );
  }

  /** The owning role is subject to FORCE row level security too, so it needs the context set. */
  async function scopedOwner(tenantId: string, companyId: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId]);
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of COMPANIES) {
      await scopedOwner(tenantId, companyId);
      await owner.query('DELETE FROM membership_roles WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM roles WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM memberships WHERE tenant_id = $1 AND company_id = $2', [
        tenantId,
        companyId,
      ]);
    }
    for (const tenantId of TENANTS) {
      await scopedOwner(tenantId, NORTH);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1', [tenantId]);
    }
    await owner.query(`SELECT set_config('app.tenant_id', '', false)`);
    await owner.query(`SELECT set_config('app.company_id', '', false)`);
    // Before the users go. Audit rows reference the actor, and the append-only table has no
    // delete policy for any role, so TRUNCATE is the only way to clear them. Section 7.1.
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [USERS]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [USERS]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [TENANTS]);
  }

  const activeCompanyOnSession = () =>
    owner
      .query<{ active_company_id: string | null }>(
        'SELECT active_company_id FROM sessions WHERE id = $1',
        [SESSION_ID],
      )
      .then((r) => r.rows[0]?.active_company_id ?? null);

  // -------------------------------------------------------------------------------------
  // What /me reports.
  // -------------------------------------------------------------------------------------

  describe('describing the authenticated user', () => {
    it('lists every company the user belongs to and no others', async () => {
      const me = await identity.describe(principal());

      expect(me.companies.map((c) => c.id).sort()).toEqual([NORTH, FOREIGN].sort());
      expect(me.companies.map((c) => c.id)).not.toContain(SOUTH);
    });

    it('lists companies across tenants, because one account reaches all of them', async () => {
      const me = await identity.describe(principal());

      // North is in one tenant and Foreign in another. A tenant scoped answer would drop one.
      expect(me.companies).toHaveLength(2);
      expect(me.companies.map((c) => c.name).sort()).toEqual([
        'Foreign Trading',
        'North Trading',
      ]);
    });

    it('lists nothing for a user with no memberships', async () => {
      const me = await identity.describe({
        sessionId: SESSION_ID,
        userId: OUTSIDER,
        activeCompanyId: null,
      });

      // The outsider is a member of South, so this proves the list is per user rather than per
      // tenant: they see South and never North or Foreign.
      expect(me.companies.map((c) => c.id)).toEqual([SOUTH]);
    });

    it('reports no active company for a session that has entered none', async () => {
      const me = await identity.describe(principal());

      expect(me.activeCompany).toBeNull();
      expect(me.companies.every((c) => !c.isActive)).toBe(true);
      expect(me.roles).toEqual([]);
    });

    it('reports the active company once one is entered', async () => {
      await identity.switchCompany({ principal: principal(), companyId: NORTH });
      const me = await identity.describe(principal(NORTH));

      expect(me.activeCompany).toEqual({ id: NORTH, name: 'North Trading' });
      expect(me.companies.find((c) => c.id === NORTH)?.isActive).toBe(true);
      expect(me.companies.find((c) => c.id === FOREIGN)?.isActive).toBe(false);
    });

    it('returns no password hash and no session token', async () => {
      const serialised = JSON.stringify(await identity.describe(principal(NORTH)));

      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('password_hash');
      expect(serialised).not.toContain('token');
      expect(Object.keys(await identity.describe(principal())).sort()).toEqual([
        'activeCompany',
        'companies',
        'permissions',
        'roles',
        'user',
      ]);
    });

    it('does not disclose the tenant', async () => {
      // Section 2.10: nothing a user receives may disclose the existence or identity of a
      // tenant. The client has no use for it, and the server never accepts one back.
      const serialised = JSON.stringify(await identity.describe(principal(NORTH)));

      expect(serialised).not.toContain(TENANT_ONE);
      expect(serialised).not.toContain(TENANT_TWO);
      expect(serialised).not.toContain('tenant');
    });
  });

  // -------------------------------------------------------------------------------------
  // Roles follow the company, and nothing else does.
  // -------------------------------------------------------------------------------------

  describe('roles in the active company', () => {
    it('reports the roles held in the company currently entered', async () => {
      const me = await identity.describe(principal(NORTH));

      expect(me.roles).toEqual([{ key: 'approver', name: 'Approver' }]);
    });

    it('reports different roles after switching, and never both companies at once', async () => {
      // Criterion 17. The same person, two companies, different roles in each, and no leakage
      // of one company's grant into the other.
      const inNorth = await identity.describe(principal(NORTH));
      const inForeign = await identity.describe(principal(FOREIGN));

      expect(inNorth.roles.map((r) => r.key)).toEqual(['approver']);
      expect(inForeign.roles.map((r) => r.key)).toEqual(['viewer']);
      expect(inForeign.roles.map((r) => r.key)).not.toContain('approver');
    });

    it('grants nothing by switching, only reports what the membership already held', async () => {
      const before = await identity.describe(principal(NORTH));
      await identity.switchCompany({ principal: principal(NORTH), companyId: FOREIGN });
      const after = await identity.describe(principal(FOREIGN));

      // The roles changed because the company changed. Nothing was added: each list is exactly
      // what that membership was granted at seed time.
      expect(before.roles).toHaveLength(1);
      expect(after.roles).toHaveLength(1);
      expect(after.roles).not.toEqual(before.roles);
    });
  });

  // -------------------------------------------------------------------------------------
  // Switching, and the ways it must refuse.
  // -------------------------------------------------------------------------------------

  describe('switching company', () => {
    it('enters a company the user belongs to', async () => {
      const result = await identity.switchCompany({ principal: principal(), companyId: NORTH });

      expect(result.outcome).toBe('switched');
      expect(await activeCompanyOnSession()).toBe(NORTH);
    });

    it('refuses a company in the same tenant that the user is not a member of', async () => {
      const result = await identity.switchCompany({ principal: principal(), companyId: SOUTH });

      expect(result).toEqual({ outcome: 'not_found' });
      expect(await activeCompanyOnSession()).toBeNull();
    });

    it('refuses a company in another tenant', async () => {
      const result = await identity.switchCompany({
        principal: { sessionId: SESSION_ID, userId: OUTSIDER, activeCompanyId: null },
        companyId: FOREIGN,
      });

      expect(result).toEqual({ outcome: 'not_found' });
    });

    it('answers identically for a real company and one that does not exist', async () => {
      // Criterion 15. Compared for equality, not merely for both being refusals, because an
      // extra field or a different shape is enough to sort real identifiers from invented ones.
      const notAMember = await identity.switchCompany({
        principal: principal(),
        companyId: SOUTH,
      });
      const notAtAll = await identity.switchCompany({
        principal: principal(),
        companyId: 'aaaaaaaa-0000-4000-8000-00000000ffff',
      });

      expect(notAMember).toEqual(notAtAll);
    });

    it('answers identically for a malformed identifier', async () => {
      const malformed = await identity.switchCompany({
        principal: principal(),
        companyId: "'; DROP TABLE memberships; --",
      });

      expect(malformed).toEqual({ outcome: 'not_found' });

      // And the table is still there, which the next assertion would not survive otherwise.
      const still = await identity.describe(principal());
      expect(still.companies).toHaveLength(2);
    });

    it('leaves the previous company in place when a switch is refused', async () => {
      await identity.switchCompany({ principal: principal(), companyId: NORTH });

      const refused = await identity.switchCompany({
        principal: principal(NORTH),
        companyId: SOUTH,
      });

      expect(refused).toEqual({ outcome: 'not_found' });
      expect(await activeCompanyOnSession()).toBe(NORTH);
    });

    it('refuses once the membership is suspended, without waiting for the session to expire', async () => {
      await identity.switchCompany({ principal: principal(), companyId: NORTH });
      await scopedOwner(TENANT_ONE, NORTH);
      await owner.query(`UPDATE memberships SET status = 'suspended' WHERE id = $1`, [
        MEMBERSHIP_NORTH,
      ]);

      try {
        expect(await identity.currentContext(principal(NORTH))).toBeNull();
        expect(
          await identity.switchCompany({ principal: principal(), companyId: NORTH }),
        ).toEqual({ outcome: 'not_found' });

        const me = await identity.describe(principal(NORTH));
        expect(me.activeCompany).toBeNull();
        expect(me.companies.map((c) => c.id)).toEqual([FOREIGN]);
        expect(me.roles).toEqual([]);
      } finally {
        await owner.query(`UPDATE memberships SET status = 'active' WHERE id = $1`, [
          MEMBERSHIP_NORTH,
        ]);
      }
    });
  });

  // -------------------------------------------------------------------------------------
  // Audit.
  // -------------------------------------------------------------------------------------

  describe('audit', () => {
    it('records a successful switch inside the target company', async () => {
      await owner.query('TRUNCATE audit_events');
      await identity.switchCompany({ principal: principal(), companyId: NORTH });

      await scopedOwner(TENANT_ONE, NORTH);
      const events = await owner.query<{
        action: string;
        tenant_id: string;
        company_id: string;
        actor_user_id: string;
        entity_id: string;
        changes: { activeCompanyId: { from: string | null; to: string } };
      }>(`SELECT * FROM audit_events WHERE action = 'switched_company'`);

      expect(events.rowCount).toBe(1);
      expect(events.rows[0]).toMatchObject({
        tenant_id: TENANT_ONE,
        company_id: NORTH,
        actor_user_id: MEMBER,
        entity_id: SESSION_ID,
      });
      // Section 7.2: structured values, not a rendered sentence.
      expect(events.rows[0]?.changes).toEqual({
        activeCompanyId: { from: null, to: NORTH },
      });
    });

    it('records the company left as well as the one entered', async () => {
      await owner.query('TRUNCATE audit_events');
      await identity.switchCompany({ principal: principal(NORTH), companyId: FOREIGN });

      await scopedOwner(TENANT_TWO, FOREIGN);
      const events = await owner.query<{
        changes: { activeCompanyId: { from: string | null; to: string } };
      }>(`SELECT changes FROM audit_events WHERE action = 'switched_company'`);

      expect(events.rows[0]?.changes).toEqual({
        activeCompanyId: { from: NORTH, to: FOREIGN },
      });
    });

    it('writes the session change and the audit record in one transaction', async () => {
      await owner.query('TRUNCATE audit_events');
      await identity.switchCompany({ principal: principal(), companyId: NORTH });

      await scopedOwner(TENANT_ONE, NORTH);
      const audit = await owner.query<{ txid: string }>(
        `SELECT txid FROM audit_events WHERE action = 'switched_company'`,
      );
      const session = await owner.query<{ xmin: string }>(
        'SELECT xmin::text AS xmin FROM sessions WHERE id = $1',
        [SESSION_ID],
      );

      expect(audit.rows[0]?.txid).toBe(session.rows[0]?.xmin);
    });

    it('writes no audit record for a refused switch', async () => {
      await owner.query('TRUNCATE audit_events');
      await identity.switchCompany({ principal: principal(), companyId: SOUTH });

      await scopedOwner(TENANT_ONE, SOUTH);
      const inSouth = await owner.query(`SELECT 1 FROM audit_events`);
      await scopedOwner(TENANT_ONE, NORTH);
      const inNorth = await owner.query(`SELECT 1 FROM audit_events`);

      expect(inSouth.rowCount).toBe(0);
      expect(inNorth.rowCount).toBe(0);
    });

    it('keeps the switch record inside the tenant it belongs to', async () => {
      await owner.query('TRUNCATE audit_events');
      await identity.switchCompany({ principal: principal(), companyId: FOREIGN });

      await scopedOwner(TENANT_ONE, NORTH);
      const visibleToOne = await owner.query(`SELECT 1 FROM audit_events`);
      await scopedOwner(TENANT_TWO, FOREIGN);
      const visibleToTwo = await owner.query(`SELECT 1 FROM audit_events`);

      expect(visibleToOne.rowCount).toBe(0);
      expect(visibleToTwo.rowCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------------
  // The isolation the context is supposed to buy.
  // -------------------------------------------------------------------------------------

  describe('isolation under a resolved context', () => {
    it('reads only the entered company tenant, even for a user who spans two', async () => {
      const context = await identity.currentContext(principal(NORTH));

      const visible = await uow.inActorScope(
        actorScope({
          tenantId: context!.tenantId,
          companyId: context!.companyId,
          userId: MEMBER,
        }),
        (r) => r.companies.listForTenant(),
      );

      expect(visible.map((c) => c.id).sort()).toEqual([NORTH, SOUTH].sort());
      expect(visible.map((c) => c.id)).not.toContain(FOREIGN);
    });

    it('cannot read the other company roles from inside one company', async () => {
      const context = await identity.currentContext(principal(NORTH));

      const roles = await uow.inActorScope(
        actorScope({
          tenantId: context!.tenantId,
          companyId: context!.companyId,
          userId: MEMBER,
        }),
        // The foreign membership identifier, asked for from inside North. It matches no row
        // rather than returning the other company's roles.
        (r) => r.roles.listForMembership(MEMBERSHIP_FOREIGN),
      );

      expect(roles).toEqual([]);
    });

    it('resolves a context whose tenant matches the membership, not the session', async () => {
      // The session stores only a company. This is the derivation that makes that safe.
      expect(await identity.currentContext(principal(NORTH))).toEqual({
        tenantId: TENANT_ONE,
        companyId: NORTH,
        membershipId: MEMBERSHIP_NORTH,
      });
      expect(await identity.currentContext(principal(FOREIGN))).toEqual({
        tenantId: TENANT_TWO,
        companyId: FOREIGN,
        membershipId: MEMBERSHIP_FOREIGN,
      });
    });

    it('resolves no context from a company the session was never entitled to', async () => {
      // The state a forged session row would produce. Even with the identifier already on the
      // session, membership is what decides, so the answer is no context at all.
      expect(await identity.currentContext(principal(SOUTH))).toBeNull();
    });
  });
});
