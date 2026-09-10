/**
 * The principal scope and the self-discovery policy from migration 0004.
 *
 * A principal scope is the narrowest thing in the data layer: an authenticated person who has
 * not entered a company. It exists to answer one question, which companies may this person
 * enter, and the whole of this file is about making sure it answers that and nothing adjacent.
 *
 * The seed deliberately puts one user in two different tenants, which is the case section 2.6
 * names as the reason accounts are global. If discovery were quietly tenant scoped, that user
 * would silently lose half their companies and no single-tenant test would notice.
 *
 * Everything runs as the application role, so row level security applies throughout.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from './database.module.js';
import { actorScope, principalScope, systemScope, UnitOfWork } from './index.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_P = '5a100000-0000-4000-8000-00000000000a';
const TENANT_Q = '5a200000-0000-4000-8000-00000000000b';
const COMPANY_P = 'cf100000-0000-4000-8000-00000000000a';
const COMPANY_Q = 'cf200000-0000-4000-8000-00000000000b';

/** Belongs to a company in each tenant. The external accountant of section 2.6. */
const ROVING_USER = '6a100000-0000-4000-8000-00000000000a';
/** Belongs to one company in one tenant, and must never see the other. */
const LOCAL_USER = '6a200000-0000-4000-8000-00000000000b';

const MEMBERSHIP_ROVING_P = 'de100000-0000-4000-8000-00000000000a';
const MEMBERSHIP_ROVING_Q = 'de200000-0000-4000-8000-00000000000b';
const MEMBERSHIP_LOCAL_P = 'de300000-0000-4000-8000-00000000000c';

describe('Principal scope', () => {
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
      imports: [AppConfigModule, DatabaseModule],
    }).compile();
    await moduleRef.init();

    uow = moduleRef.get(UnitOfWork);
    close = () => moduleRef.close();

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();

    await purge();

    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_P,
      'principal-p',
      'Principal P',
      TENANT_Q,
      'principal-q',
      'Principal Q',
    ]);

    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_P }),
      async (r) => {
        await r.users.create({
          id: ROVING_USER,
          email: 'roving@principal.test',
          name: 'Roving',
          passwordHash: 'x',
        });
        await r.users.create({
          id: LOCAL_USER,
          email: 'local@principal.test',
          name: 'Local',
          passwordHash: 'x',
        });
        await r.companies.create({ id: COMPANY_P, name: 'P Company', baseCurrency: 'USD' });
      },
    );

    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_Q }),
      async (r) => {
        await r.companies.create({ id: COMPANY_Q, name: 'Q Company', baseCurrency: 'EUR' });
      },
    );

    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_P, companyId: COMPANY_P }),
      async (r) => {
        await r.memberships.create({ id: MEMBERSHIP_ROVING_P, userId: ROVING_USER });
        await r.memberships.create({ id: MEMBERSHIP_LOCAL_P, userId: LOCAL_USER });
      },
    );

    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_Q, companyId: COMPANY_Q }),
      async (r) => {
        await r.memberships.create({ id: MEMBERSHIP_ROVING_Q, userId: ROVING_USER });
      },
    );
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await close();
  });

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of [
      [TENANT_P, COMPANY_P],
      [TENANT_Q, COMPANY_Q],
    ]) {
      await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
      await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId]);
      await owner.query('DELETE FROM memberships WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1', [tenantId]);
    }
    await owner.query(`SELECT set_config('app.tenant_id', '', false)`);
    await owner.query(`SELECT set_config('app.company_id', '', false)`);
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [
      [ROVING_USER, LOCAL_USER],
    ]);
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[ROVING_USER, LOCAL_USER]]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_P, TENANT_Q]]);
  }

  const ownMemberships = (userId: string) =>
    uow.inPrincipalScope(principalScope({ userId }), (r) => r.memberships.listOwn());

  // -------------------------------------------------------------------------------------
  // What discovery is for.
  // -------------------------------------------------------------------------------------

  describe('own membership discovery', () => {
    it('returns every company the person belongs to, across tenants', async () => {
      const found = await ownMemberships(ROVING_USER);

      expect(found.map((m) => m.companyId).sort()).toEqual([COMPANY_P, COMPANY_Q].sort());
      expect([...new Set(found.map((m) => m.tenantId))].sort()).toEqual(
        [TENANT_P, TENANT_Q].sort(),
      );
    });

    it('returns only the asking person rows', async () => {
      const found = await ownMemberships(LOCAL_USER);

      expect(found).toHaveLength(1);
      expect(found[0]?.companyId).toBe(COMPANY_P);
      expect(found.every((m) => m.userId === LOCAL_USER)).toBe(true);
    });

    it('returns nothing for a user with no memberships', async () => {
      // A real user id with no membership rows, not a malformed one. The answer is an empty
      // list rather than an error, because "you belong to nothing yet" is a legitimate state.
      const stranger = await ownMemberships('6a900000-0000-4000-8000-00000000000f');

      expect(stranger).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // The policy underneath, tested without the repository in the way.
  // -------------------------------------------------------------------------------------

  describe('the row level security policy, independent of the repository predicate', () => {
    /**
     * Runs a statement as the application role with the context set by hand.
     *
     * The repository always adds a user predicate of its own, so a test that went through it
     * would pass even if the policy admitted everything. This sets the context and issues a
     * bare SELECT, so what comes back is what the policy alone allows.
     */
    async function selectMembershipsAs(context: {
      tenantId?: string;
      userId?: string;
    }): Promise<string[]> {
      const app = new Client({ connectionString: process.env['DATABASE_URL'] });
      await app.connect();

      try {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [context.tenantId ?? '']);
        await app.query(`SELECT set_config('app.user_id', $1, true)`, [context.userId ?? '']);

        const result = await app.query<{ id: string }>('SELECT id FROM memberships');
        await app.query('ROLLBACK');

        return result.rows.map((r) => r.id).sort();
      } finally {
        await app.end();
      }
    }

    it('denies everything when both tenant and user context are empty', async () => {
      // Section 2.4: an empty context denies. Adding a user dimension must not have turned the
      // empty case into a wildcard.
      expect(await selectMembershipsAs({})).toEqual([]);
    });

    it('admits only the named user rows when the tenant context is empty', async () => {
      expect(await selectMembershipsAs({ userId: ROVING_USER })).toEqual(
        [MEMBERSHIP_ROVING_P, MEMBERSHIP_ROVING_Q].sort(),
      );
      expect(await selectMembershipsAs({ userId: LOCAL_USER })).toEqual([MEMBERSHIP_LOCAL_P]);
    });

    it('still confines a tenant context to that tenant, whoever the user is', async () => {
      // The new policy requires an empty tenant context, so it cannot widen a tenant scoped
      // read. A person who belongs to two tenants sees one tenant's row here, not both.
      expect(await selectMembershipsAs({ tenantId: TENANT_P, userId: ROVING_USER })).toEqual(
        [MEMBERSHIP_LOCAL_P, MEMBERSHIP_ROVING_P].sort(),
      );
    });

    it('shows a tenant nothing of the other tenant, even for a shared user', async () => {
      const inQ = await selectMembershipsAs({ tenantId: TENANT_Q, userId: ROVING_USER });

      expect(inQ).toEqual([MEMBERSHIP_ROVING_Q]);
      expect(inQ).not.toContain(MEMBERSHIP_ROVING_P);
    });
  });

  // -------------------------------------------------------------------------------------
  // What a principal scope must not become.
  // -------------------------------------------------------------------------------------

  describe('the limits of a principal scope', () => {
    it('cannot read companies, because it names no tenant', async () => {
      await expect(
        uow.inPrincipalScope(principalScope({ userId: ROVING_USER }), (r) =>
          (r as { companies?: { listForTenant(): Promise<unknown> } }).companies!.listForTenant(),
        ),
      ).rejects.toThrow(/no tenant/);
    });

    it('cannot read a membership by identifier, only discover its own', async () => {
      // Discovery is the only membership read a principal gets. Lookup by id belongs to an
      // actor scope, where the tenant and company predicates apply.
      await expect(
        uow.inPrincipalScope(principalScope({ userId: ROVING_USER }), (r) =>
          (
            r.memberships as unknown as { findById(id: string): Promise<unknown> }
          ).findById(MEMBERSHIP_LOCAL_P),
        ),
      ).rejects.toThrow(/no tenant/);
    });

    it('refuses discovery under a system scope, which has no person', async () => {
      await expect(
        uow.inSystemScope(systemScope('integration-test'), (r) =>
          (r.memberships as unknown as { listOwn(): Promise<unknown> }).listOwn(),
        ),
      ).rejects.toThrow(/requires a principal scope/);
    });

    it('refuses discovery under an actor scope, which would narrow it to one tenant', async () => {
      await expect(
        uow.inActorScope(
          actorScope({ tenantId: TENANT_P, companyId: COMPANY_P, userId: ROVING_USER }),
          (r) => (r.memberships as unknown as { listOwn(): Promise<unknown> }).listOwn(),
        ),
      ).rejects.toThrow(/requires a principal scope/);
    });
  });
});
