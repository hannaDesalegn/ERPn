/**
 * The master data repositories, against a real PostgreSQL.
 *
 * The schema suite proved what the database refuses. This proves the layer above it refuses the
 * same things, which section 2.4 requires as the first of two layers and permits neither to
 * stand alone. Everything goes through the public data layer API rather than raw SQL, because
 * that is the surface the sales order service will actually hold.
 *
 * TWO TENANTS, THREE COMPANIES, AND THE SAME CODES IN EACH. A customer coded `CUST-1` and a
 * warehouse coded `WH-1` exist in every company, because uniqueness is per company and a lookup
 * by code is only safe if it is scoped. An unscoped `findByCode` would match three rows and
 * return whichever the planner reached first, which is the bug this seed is shaped to catch.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../../config/config.module.js';
import { DatabaseModule } from '../database.module.js';
import {
  actorScope,
  ConcurrencyConflictError,
  principalScope,
  RecordNotFoundError,
  systemScope,
  UnitOfWork,
} from '../index.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'a9100000-0000-4000-8000-00000000000a';
const TENANT_B = 'a9200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'b9100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "wrong company, right tenant" is representable. */
const COMPANY_A2 = 'b9200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'b9300000-0000-4000-8000-00000000000c';

const USER_A = 'c9100000-0000-4000-8000-00000000000a';
const USER_B = 'c9200000-0000-4000-8000-00000000000b';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'd9110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd9120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd9130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'd9210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd9220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd9230000-0000-4000-8000-00000000000c',
};

const inA1 = () => actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: USER_A });
const inA2 = () => actorScope({ tenantId: TENANT_A, companyId: COMPANY_A2, userId: USER_A });
const inB1 = () => actorScope({ tenantId: TENANT_B, companyId: COMPANY_B1, userId: USER_B });

describe('Master data repositories', () => {
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
    await seed();
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await close();
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  const scopeFor = (companyId: string) =>
    companyId === COMPANY_A1 ? inA1() : companyId === COMPANY_A2 ? inA2() : inB1();

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'md-repo-a',
      'MD Repo A',
      TENANT_B,
      'md-repo-b',
      'MD Repo B',
    ]);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_A }), async (r) => {
      await r.users.create({ id: USER_A, email: 'a@mdrepo.test', name: 'A', passwordHash: 'x' });
      await r.users.create({ id: USER_B, email: 'b@mdrepo.test', name: 'B', passwordHash: 'x' });
      await r.companies.create({ id: COMPANY_A1, name: 'A One', baseCurrency: 'USD' });
      await r.companies.create({ id: COMPANY_A2, name: 'A Two', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_B }), (r) =>
      r.companies.create({ id: COMPANY_B1, name: 'B One', baseCurrency: 'EUR' }),
    );

    // Created through the repository under each company's own scope, with colliding codes.
    for (const [, companyId] of SCOPES) {
      await uow.inActorScope(scopeFor(companyId), async (r) => {
        await r.customers.create({
          id: CUSTOMER[companyId]!,
          code: 'CUST-1',
          name: `Customer of ${companyId.slice(0, 4)}`,
        });
        await r.warehouses.create({
          id: WAREHOUSE[companyId]!,
          code: 'WH-1',
          name: 'Main',
          isDefault: true,
        });
      });
    }
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM warehouses WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM customers WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[USER_A, USER_B]]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  // -------------------------------------------------------------------------------------
  // Reading.
  // -------------------------------------------------------------------------------------

  describe('reading', () => {
    it('lists only the acting company customers', async () => {
      const seen = await uow.inActorScope(inA1(), (r) => r.customers.listForCompany());

      expect(seen.map((c) => c.id)).toEqual([CUSTOMER[COMPANY_A1]]);
    });

    it('lists only the acting company warehouses', async () => {
      const seen = await uow.inActorScope(inB1(), (r) => r.warehouses.listForCompany());

      expect(seen.map((w) => w.id)).toEqual([WAREHOUSE[COMPANY_B1]]);
    });

    it('cannot reach a sibling company customer by identifier', async () => {
      const found = await uow.inActorScope(inA1(), (r) =>
        r.customers.findById(CUSTOMER[COMPANY_A2]!),
      );

      // Section 6.1: a failure at this dimension is indistinguishable from the record not
      // existing. Null, not an error, so an identifier cannot be probed.
      expect(found).toBeNull();
    });

    it('cannot reach another tenant warehouse by identifier', async () => {
      const found = await uow.inActorScope(inA1(), (r) =>
        r.warehouses.findById(WAREHOUSE[COMPANY_B1]!),
      );

      expect(found).toBeNull();
    });

    it('makes a foreign identifier indistinguishable from a missing one', async () => {
      const foreign = await uow.inActorScope(inA1(), (r) =>
        r.customers.findById(CUSTOMER[COMPANY_B1]!),
      );
      const missing = await uow.inActorScope(inA1(), (r) =>
        r.customers.findById('d9990000-0000-4000-8000-00000000000f'),
      );

      expect(foreign).toEqual(missing);
    });

    it('resolves a shared code to the acting company row and no other', async () => {
      // The same code exists in all three companies. An unscoped lookup would match three rows
      // and return whichever came back first, which is the bug this seed exists to catch.
      const fromA1 = await uow.inActorScope(inA1(), (r) => r.customers.findByCode('CUST-1'));
      const fromA2 = await uow.inActorScope(inA2(), (r) => r.customers.findByCode('CUST-1'));
      const fromB1 = await uow.inActorScope(inB1(), (r) => r.customers.findByCode('CUST-1'));

      expect(fromA1?.id).toBe(CUSTOMER[COMPANY_A1]);
      expect(fromA2?.id).toBe(CUSTOMER[COMPANY_A2]);
      expect(fromB1?.id).toBe(CUSTOMER[COMPANY_B1]);
    });

    it('resolves a shared warehouse code the same way', async () => {
      const fromA1 = await uow.inActorScope(inA1(), (r) => r.warehouses.findByCode('WH-1'));
      const fromB1 = await uow.inActorScope(inB1(), (r) => r.warehouses.findByCode('WH-1'));

      expect(fromA1?.id).toBe(WAREHOUSE[COMPANY_A1]);
      expect(fromB1?.id).toBe(WAREHOUSE[COMPANY_B1]);
    });

    it('finds each company own default warehouse', async () => {
      const fromA1 = await uow.inActorScope(inA1(), (r) => r.warehouses.findDefault());
      const fromA2 = await uow.inActorScope(inA2(), (r) => r.warehouses.findDefault());

      expect(fromA1?.id).toBe(WAREHOUSE[COMPANY_A1]);
      expect(fromA2?.id).toBe(WAREHOUSE[COMPANY_A2]);
    });

    it('reports a warehouse as denying negative stock unless told otherwise', async () => {
      // Section 8.5: the policy is per warehouse and defaults to deny, and the repository does
      // not quietly widen it when the caller says nothing.
      const found = await uow.inActorScope(inA1(), (r) => r.warehouses.findDefault());

      expect(found?.allowNegativeStock).toBe(false);
      expect(found?.isDefault).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------
  // Writing.
  // -------------------------------------------------------------------------------------

  describe('writing', () => {
    it('stamps tenant and company from the scope, not from the caller', async () => {
      const id = 'd9310000-0000-4000-8000-00000000000a';
      const created = await uow.inActorScope(inA2(), (r) =>
        r.customers.create({ id, code: 'CUST-STAMP', name: 'Stamped' }),
      );

      // `NewCustomer` has no tenant or company field, so there is nothing to pass. This records
      // that what was stamped is the acting scope rather than anything else.
      expect(created.tenantId).toBe(TENANT_A);
      expect(created.companyId).toBe(COMPANY_A2);
      expect(created.status).toBe('active');
      expect(created.version).toBe(1);
    });

    it('cannot write into another company, even holding its identifiers', async () => {
      const id = 'd9320000-0000-4000-8000-00000000000b';
      await uow.inActorScope(inA1(), (r) =>
        r.customers.create({ id, code: 'CUST-WHERE', name: 'Lands here' }),
      );

      const fromSibling = await uow.inActorScope(inA2(), (r) => r.customers.findById(id));
      const fromOwner = await uow.inActorScope(inA1(), (r) => r.customers.findById(id));

      expect(fromSibling).toBeNull();
      expect(fromOwner?.companyId).toBe(COMPANY_A1);
    });

    it('lets two companies use the same code, because uniqueness is per company', async () => {
      // Seeded that way. A global unique index would make one customer of this product unable
      // to use a code because a different customer already had.
      const a1 = await uow.inActorScope(inA1(), (r) => r.customers.findByCode('CUST-1'));
      const b1 = await uow.inActorScope(inB1(), (r) => r.customers.findByCode('CUST-1'));

      expect(a1).not.toBeNull();
      expect(b1).not.toBeNull();
      expect(a1?.id).not.toBe(b1?.id);
    });

    it('refuses a second customer with a code the company already uses', async () => {
      await expect(
        uow.inActorScope(inA1(), (r) =>
          r.customers.create({
            id: 'd9330000-0000-4000-8000-00000000000c',
            code: 'CUST-1',
            name: 'Duplicate',
          }),
        ),
      ).rejects.toThrow();
    });

    it('refuses a second default warehouse in one company', async () => {
      // At most one default, which the schema expresses as a partial unique index because "at
      // most one row where this is true" is not something a row level check can see.
      await expect(
        uow.inActorScope(inA1(), (r) =>
          r.warehouses.create({
            id: 'd9340000-0000-4000-8000-00000000000d',
            code: 'WH-2',
            name: 'Second',
            isDefault: true,
          }),
        ),
      ).rejects.toThrow();
    });

    it('accepts a second non default warehouse', async () => {
      const created = await uow.inActorScope(inA1(), (r) =>
        r.warehouses.create({
          id: 'd9350000-0000-4000-8000-00000000000e',
          code: 'WH-3',
          name: 'Overflow',
          allowNegativeStock: true,
        }),
      );

      expect(created.isDefault).toBe(false);
      expect(created.allowNegativeStock).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------
  // Archiving, which is what section 4.5 offers instead of deletion.
  // -------------------------------------------------------------------------------------

  describe('archiving', () => {
    it('archives a customer and bumps its version', async () => {
      const id = 'd9410000-0000-4000-8000-00000000000a';
      const created = await uow.inActorScope(inA1(), (r) =>
        r.customers.create({ id, code: 'CUST-ARCH', name: 'To archive' }),
      );

      const archived = await uow.inActorScope(inA1(), (r) =>
        r.customers.archive({ id, expectedVersion: created.version }),
      );

      expect(archived.status).toBe('archived');
      expect(archived.version).toBe(created.version + 1);
    });

    it('refuses a stale version rather than overwriting', async () => {
      const id = 'd9420000-0000-4000-8000-00000000000b';
      const created = await uow.inActorScope(inA1(), (r) =>
        r.customers.create({ id, code: 'CUST-STALE', name: 'Raced' }),
      );
      await uow.inActorScope(inA1(), (r) =>
        r.customers.archive({ id, expectedVersion: created.version }),
      );

      // Section 10.1: the version the caller read is part of the WHERE clause, so a second
      // writer holding the old number changes nothing and is told.
      await expect(
        uow.inActorScope(inA1(), (r) =>
          r.customers.archive({ id, expectedVersion: created.version }),
        ),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    });

    it('reports another company record as not found rather than as a conflict', async () => {
      // The distinction matters: a conflict would confirm the row exists somewhere.
      await expect(
        uow.inActorScope(inA1(), (r) =>
          r.customers.archive({ id: CUSTOMER[COMPANY_A2]!, expectedVersion: 1 }),
        ),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
    });

    it('leaves the other company record untouched', async () => {
      const sibling = await uow.inActorScope(inA2(), (r) =>
        r.customers.findById(CUSTOMER[COMPANY_A2]!),
      );

      expect(sibling?.status).toBe('active');
    });

    it('archives a warehouse the same way', async () => {
      const id = 'd9430000-0000-4000-8000-00000000000c';
      const created = await uow.inActorScope(inA1(), (r) =>
        r.warehouses.create({ id, code: 'WH-ARCH', name: 'Closing' }),
      );

      const archived = await uow.inActorScope(inA1(), (r) =>
        r.warehouses.archive({ id, expectedVersion: created.version }),
      );

      expect(archived.status).toBe('archived');
    });

    it('offers no way to delete either', () => {
      // Section 4.5, and the grants agree: the application role holds no DELETE on these
      // tables. A method here would fail at the database, which is worse than not existing,
      // because it reads in a call site as though deletion were a supported operation.
      return uow.inActorScope(inA1(), async (r) => {
        const customerMethods = Object.getOwnPropertyNames(
          Object.getPrototypeOf(r.customers) as object,
        );
        const warehouseMethods = Object.getOwnPropertyNames(
          Object.getPrototypeOf(r.warehouses) as object,
        );

        expect(customerMethods).toEqual(
          expect.arrayContaining(['findById', 'findByCode', 'listForCompany', 'create', 'archive']),
        );
        expect(customerMethods).toEqual(expect.not.arrayContaining(['remove', 'delete', 'destroy']));
        expect(warehouseMethods).toEqual(
          expect.not.arrayContaining(['remove', 'delete', 'destroy']),
        );
      });
    });
  });

  // -------------------------------------------------------------------------------------
  // Scope is mandatory, and the failure is loud rather than empty.
  // -------------------------------------------------------------------------------------

  describe('scope is not optional', () => {
    it('refuses a system scope naming no tenant', async () => {
      await expect(
        uow.inSystemScope(systemScope('integration-test'), (r) => r.customers.listForCompany()),
      ).rejects.toThrow(/no tenant/);
    });

    it('refuses a system scope naming a tenant but no company', async () => {
      // A customer belongs to exactly one company, so a tenant alone is not a scope for it.
      // Returning nothing would read as an empty company rather than as a bug.
      await expect(
        uow.inSystemScope(systemScope('integration-test', { tenantId: TENANT_A }), (r) =>
          r.warehouses.listForCompany(),
        ),
      ).rejects.toThrow(/no company/);
    });

    it('refuses a principal scope, which names neither', async () => {
      await expect(
        uow.inPrincipalScope(principalScope({ userId: USER_A }), (r) =>
          (
            r as unknown as { customers: { listForCompany(): Promise<unknown> } }
          ).customers.listForCompany(),
        ),
      ).rejects.toThrow(/no tenant/);
    });

    it('works under a system scope that names both', async () => {
      // Named scopes do work, which is what makes the refusals above about the missing half
      // rather than about system scopes being refused outright.
      const seen = await uow.inSystemScope(
        systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_A1 }),
        (r) => r.customers.listForCompany(),
      );

      expect(seen.map((c) => c.id)).toContain(CUSTOMER[COMPANY_A1]);
    });
  });
});
