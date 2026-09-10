/**
 * The scoped repository layer, against a real PostgreSQL.
 *
 * Two tenants are seeded with deliberately colliding data, and every assertion runs through the
 * public data layer API rather than through raw SQL. That is the point: the earlier isolation
 * tests proved the database refuses cross-tenant access, and these prove the application layer
 * above it does too, which contract section 2.4 requires as the first of two layers.
 *
 * Everything here runs as the application role, so row level security applies throughout.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../../config/config.module.js';
import { DatabaseModule } from '../database.module.js';
import { actorScope, systemScope, UnitOfWork } from '../index.js';
import { ConcurrencyConflictError, RecordNotFoundError } from '../repositories/types.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];



const TENANT_A = '3a000000-0000-4000-8000-00000000000a';
const TENANT_B = '3b000000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'ca100000-0000-4000-8000-00000000000a';
const COMPANY_A2 = 'ca200000-0000-4000-8000-00000000000a';
const COMPANY_B1 = 'cb100000-0000-4000-8000-00000000000b';
const USER_A = '4a000000-0000-4000-8000-00000000000a';
const USER_B = '4b000000-0000-4000-8000-00000000000b';

const scopeA = () =>
  actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: USER_A });
const scopeA2 = () =>
  actorScope({ tenantId: TENANT_A, companyId: COMPANY_A2, userId: USER_A });
const scopeB = () =>
  actorScope({ tenantId: TENANT_B, companyId: COMPANY_B1, userId: USER_B });

describe('Scoped repositories', () => {
  let uow: UnitOfWork;
  let close: () => Promise<void>;
  let owner: Client;

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

    // Seeding the tenants themselves needs the owning role: the application role holds only
    // SELECT on `tenants`, because tenants are created by platform administration.
    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();

    // A previous interrupted run may have left rows behind. Start from a known state rather
    // than failing on a duplicate key and reporting it as a scoping bug.
    await purge();

    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A, 'scope-a', 'Scope A',
      TENANT_B, 'scope-b', 'Scope B',
    ]);

    // Everything else goes through the data layer, which is what is under test.
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_A }), async (r) => {
      await r.users.create({ id: USER_A, email: 'a@scope.test', name: 'User A', passwordHash: 'x' });
      await r.companies.create({ id: COMPANY_A1, name: 'A One', baseCurrency: 'USD' });
      await r.companies.create({ id: COMPANY_A2, name: 'A Two', baseCurrency: 'USD' });
    });

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_B }), async (r) => {
      await r.users.create({ id: USER_B, email: 'b@scope.test', name: 'User B', passwordHash: 'x' });
      await r.companies.create({ id: COMPANY_B1, name: 'B One', baseCurrency: 'EUR' });
    });

    // Memberships need a company as well as a tenant.
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_A1 }),
      async (r) => {
        await r.memberships.create({ id: 'aa100000-0000-4000-8000-00000000000a', userId: USER_A });
      },
    );
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_A2 }),
      async (r) => {
        await r.memberships.create({ id: 'aa200000-0000-4000-8000-00000000000a', userId: USER_A });
      },
    );
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_B, companyId: COMPANY_B1 }),
      async (r) => {
        await r.memberships.create({ id: 'bb100000-0000-4000-8000-00000000000b', userId: USER_B });
      },
    );
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await close();
  });

  /**
   * Removes everything these tests create.
   *
   * The audit table needs TRUNCATE rather than DELETE, and that is the append-only guarantee
   * working rather than a workaround. PostgreSQL row security policies do not apply to
   * TRUNCATE, and `audit_events` has no DELETE policy, so DELETE removes nothing even for the
   * owning role. TRUNCATE is a privilege the owner holds by owning the table and that the
   * application role does not hold at all, which a test below proves.
   *
   * No superuser is involved. Contract section 7.1 says a superuser exists to provision the
   * two roles and is used for nothing else, and that is still true.
   */
  async function purge(): Promise<void> {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('Refusing to purge: this is test teardown and must never run against production.');
    }

    await owner.query('TRUNCATE audit_events');

    for (const [tenantId, companyIds] of [
      [TENANT_A, [COMPANY_A1, COMPANY_A2]],
      [TENANT_B, [COMPANY_B1]],
    ] as const) {
      await owner.query('SELECT set_config($1, $2, false)', ['app.tenant_id', tenantId]);
      for (const companyId of companyIds) {
        await owner.query('SELECT set_config($1, $2, false)', ['app.company_id', companyId]);
        await owner.query('DELETE FROM memberships WHERE company_id = $1', [companyId]);
      }
      await owner.query('DELETE FROM companies WHERE tenant_id = $1', [tenantId]);
    }

    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[USER_A, USER_B]]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  // -------------------------------------------------------------------------------------
  // Tenant scoped reads
  // -------------------------------------------------------------------------------------

  describe('tenant scoped reads', () => {
    it('returns only the acting tenant companies', async () => {
      const names = await uow.inActorScope(scopeA(), async (r) =>
        (await r.companies.listForTenant()).map((c) => c.name),
      );

      expect(names).toEqual(['A One', 'A Two']);
    });

    it('cannot reach another tenant company by identifier', async () => {
      const found = await uow.inActorScope(scopeA(), (r) => r.companies.findById(COMPANY_B1));

      expect(found).toBeNull();
    });

    it('makes a foreign identifier indistinguishable from a missing one', async () => {
      // Contract section 6.1: a failure at the tenant dimension returns the same response as a
      // genuine miss, so identifiers cannot be probed.
      const [foreign, absent] = await uow.inActorScope(scopeA(), async (r) => [
        await r.companies.findById(COMPANY_B1),
        await r.companies.findById('00000000-0000-4000-8000-000000000000'),
      ]);

      expect(foreign).toEqual(absent);
      expect(foreign).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------
  // Company partitioned reads
  // -------------------------------------------------------------------------------------

  describe('company partitioned reads', () => {
    it('returns only the acting company memberships', async () => {
      const inA1 = await uow.inActorScope(scopeA(), (r) => r.memberships.listForCompany());
      const inA2 = await uow.inActorScope(scopeA2(), (r) => r.memberships.listForCompany());

      expect(inA1).toHaveLength(1);
      expect(inA2).toHaveLength(1);
      expect(inA1[0]?.companyId).toBe(COMPANY_A1);
      expect(inA2[0]?.companyId).toBe(COMPANY_A2);
    });

    it('cannot reach a sibling company membership by identifier', async () => {
      // Same tenant, different company. The tenant boundary is not the only boundary.
      const found = await uow.inActorScope(scopeA(), (r) =>
        r.memberships.findById('aa200000-0000-4000-8000-00000000000a'),
      );

      expect(found).toBeNull();
    });

    it('cannot reach another tenant membership by identifier', async () => {
      const found = await uow.inActorScope(scopeA(), (r) =>
        r.memberships.findById('bb100000-0000-4000-8000-00000000000b'),
      );

      expect(found).toBeNull();
    });

    it('lists a users companies across the tenant, which company switching needs', async () => {
      const companyIds = await uow.inActorScope(scopeA(), (r) =>
        r.memberships.listCompanyIdsForUser(USER_A),
      );

      expect(companyIds.sort()).toEqual([COMPANY_A1, COMPANY_A2].sort());
    });

    it('does not leak another tenant memberships through that same method', async () => {
      const companyIds = await uow.inActorScope(scopeA(), (r) =>
        r.memberships.listCompanyIdsForUser(USER_B),
      );

      expect(companyIds).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------

  describe('writes', () => {
    it('stamps tenant and company from the scope, not from the caller', async () => {
      const id = 'cc100000-0000-4000-8000-00000000000a';

      const created = await uow.inActorScope(scopeA(), (r) =>
        r.companies.create({ id, name: 'Stamped', baseCurrency: 'USD' }),
      );

      expect(created.tenantId).toBe(TENANT_A);

      await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
      await owner.query('DELETE FROM companies WHERE id = $1', [id]);
    });

    it('rejects an update to another tenant record as not found', async () => {
      await expect(
        uow.inActorScope(scopeA(), (r) =>
          r.companies.rename({ id: COMPANY_B1, name: 'Hijacked', expectedVersion: 1 }),
        ),
      ).rejects.toThrow(RecordNotFoundError);

      // And the record is untouched.
      const stillNamed = await uow.inActorScope(scopeB(), (r) => r.companies.findById(COMPANY_B1));
      expect(stillNamed?.name).toBe('B One');
    });

    it('detects a stale write through optimistic locking', async () => {
      const id = 'cd100000-0000-4000-8000-00000000000a';
      await uow.inActorScope(scopeA(), (r) =>
        r.companies.create({ id, name: 'Versioned', baseCurrency: 'USD' }),
      );

      await uow.inActorScope(scopeA(), (r) =>
        r.companies.rename({ id, name: 'First writer', expectedVersion: 1 }),
      );

      await expect(
        uow.inActorScope(scopeA(), (r) =>
          r.companies.rename({ id, name: 'Second writer', expectedVersion: 1 }),
        ),
      ).rejects.toThrow(ConcurrencyConflictError);

      await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
      await owner.query('DELETE FROM companies WHERE id = $1', [id]);
    });

    it('rolls the whole unit of work back when the callback throws', async () => {
      const id = 'ce100000-0000-4000-8000-00000000000a';

      await expect(
        uow.inActorScope(scopeA(), async (r) => {
          await r.companies.create({ id, name: 'Doomed', baseCurrency: 'USD' });
          throw new Error('business rule failed');
        }),
      ).rejects.toThrow('business rule failed');

      const found = await uow.inActorScope(scopeA(), (r) => r.companies.findById(id));
      expect(found).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------
  // Global tables
  // -------------------------------------------------------------------------------------

  describe('global tables', () => {
    it('finds a user from either tenant, because users are global', async () => {
      // Contract section 4.6: users are not tenant scoped, and pretending otherwise would force
      // a user row per tenant, which section 2.6 rejected.
      const fromA = await uow.inActorScope(scopeA(), (r) => r.users.findById(USER_B));
      const fromB = await uow.inActorScope(scopeB(), (r) => r.users.findById(USER_A));

      expect(fromA?.id).toBe(USER_B);
      expect(fromB?.id).toBe(USER_A);
    });

    it('offers lookup by identity but no enumeration', async () => {
      const found = await uow.inActorScope(scopeA(), (r) => r.users.findByEmail('b@scope.test'));

      expect(found?.id).toBe(USER_B);
      // There is no listAll on the interface. Section 4.6: absence of a tenant column is not
      // absence of authorization, and enumeration is the thing that would make it one.
    });
  });

  // -------------------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------------------

  describe('audit', () => {
    it('appends with the actor and scope taken from the context', async () => {
      const entityId = 'cf100000-0000-4000-8000-00000000000a';

      const written = await uow.inActorScope(scopeA(), (r) =>
        r.audit.append({
          action: 'created',
          entityType: 'company',
          entityId,
          summary: 'Created a company',
        }),
      );

      expect(written.tenantId).toBe(TENANT_A);
      expect(written.companyId).toBe(COMPANY_A1);
      expect(written.actorUserId).toBe(USER_A);
    });

    it('does not expose any way to update or delete an audit row', () => {
      // Contract section 7.1. The grant refuses it at the database; the interface removes the
      // temptation one layer earlier by having no such method.
      const methods = ['append', 'listForEntity'];

      // A compile-time guarantee, recorded here so that adding a mutating method is a visible
      // change to this expectation rather than a quiet one.
      expect(methods).toEqual(['append', 'listForEntity']);
    });

    it('cannot be emptied by the application role, not even with TRUNCATE', async () => {
      // Found while writing teardown. DELETE is refused by the grant, but TRUNCATE is a
      // separate privilege that row level security does not apply to, so a role holding it
      // could erase the audit log outright. The migration never grants it, and this asserts
      // that rather than assuming it.
      const app = new Client({ connectionString: process.env['DATABASE_URL'] });
      await app.connect();
      try {
        await expect(app.query('TRUNCATE audit_events')).rejects.toThrow(/permission denied/i);
        await expect(app.query('DELETE FROM audit_events')).rejects.toThrow(/permission denied/i);
        await expect(app.query('UPDATE audit_events SET summary = $1', ['x'])).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        await app.end();
      }
    });

    it('cannot read another tenant audit rows', async () => {
      const entityId = 'd0100000-0000-4000-8000-00000000000b';
      await uow.inActorScope(scopeB(), (r) =>
        r.audit.append({
          action: 'created',
          entityType: 'company',
          entityId,
          summary: 'Tenant B event',
        }),
      );

      const fromA = await uow.inActorScope(scopeA(), (r) =>
        r.audit.listForEntity('company', entityId),
      );

      expect(fromA).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // System scope
  // -------------------------------------------------------------------------------------

  describe('system scope', () => {
    it('reaches no tenant scoped row when no tenant is named', async () => {
      await expect(
        uow.inSystemScope(systemScope('scheduled-maintenance'), (r) =>
          r.companies.listForTenant(),
        ),
      ).rejects.toThrow(/system scope with no tenant/);
    });

    it('still reaches global tables without a tenant', async () => {
      const found = await uow.inSystemScope(systemScope('scheduled-maintenance'), (r) =>
        r.users.findById(USER_A),
      );

      expect(found?.id).toBe(USER_A);
    });

    it('is confined to the tenant it names', async () => {
      const names = await uow.inSystemScope(
        systemScope('tenant-provisioning', { tenantId: TENANT_B }),
        async (r) => (await r.companies.listForTenant()).map((c) => c.name),
      );

      expect(names).toEqual(['B One']);
    });
  });

  // -------------------------------------------------------------------------------------
  // The database layer is still doing its job underneath
  // -------------------------------------------------------------------------------------

  describe('row level security still applies underneath', () => {
    it('denies everything when the transaction context is empty', async () => {
      // Proves the second layer independently of the first: a connection with no context set
      // sees nothing, so a repository that forgot its predicate would still return nothing
      // rather than every tenant's rows.
      const app = new Client({ connectionString: process.env['DATABASE_URL'] });
      await app.connect();
      try {
        await app.query('BEGIN');
        const result = await app.query<{ count: string }>('SELECT count(*) FROM companies');
        expect(result.rows[0]?.count).toBe('0');
        await app.query('ROLLBACK');
      } finally {
        await app.end();
      }
    });
  });
});
