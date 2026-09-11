/**
 * Provisioning a company, against a real PostgreSQL.
 *
 * The invariant being proved is one sentence: a company that exists is fully provisioned, with
 * its default roles and its sales order sequence, all written by the transaction that created
 * it. A half provisioned company is worse than none, because nothing about it looks wrong until
 * somebody tries to grant authority in it or confirm an order.
 *
 * WHY THIS NEEDS A REAL DATABASE. Two of the claims are a rollback and a unique constraint, and
 * neither survives a mock. A fake transaction always rolls back cleanly, and a fake uniqueness
 * check is just the application agreeing with itself.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { seedDefaultRolesIn } from '../authorization/role-provisioning.service.js';
import { ROLE_KEYS } from '../authorization/permissions.js';
import { actorScope, systemScope, UnitOfWork } from '../database/index.js';
import {
  allocateSalesOrderNumber,
  provisionSalesOrderSequence,
  SALES_ORDER_DOC_TYPE,
} from '../sales/document-numbers.js';
import { CompaniesModule } from './companies.module.js';
import { CompanyProvisioningService } from './company-provisioning.service.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'a1100000-0000-4000-8000-00000000000a';
const TENANT_B = 'a1200000-0000-4000-8000-00000000000b';

const COMPANY_A1 = 'a2100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "same tenant, different company" is representable. */
const COMPANY_A2 = 'a2200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'a2300000-0000-4000-8000-00000000000c';
/** Created inside a transaction that then fails, so it must never reach the database. */
const COMPANY_DOOMED = 'a2400000-0000-4000-8000-00000000000d';
/** Never provisioned, so "allocation does not create one" has something to be true about. */
const COMPANY_BARE = 'a2500000-0000-4000-8000-00000000000e';

const USER = 'a3100000-0000-4000-8000-00000000000a';

const TENANTS = [TENANT_A, TENANT_B];

/** Every company any test here can create, for a teardown that cannot miss one. */
const COMPANY_SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_A, COMPANY_DOOMED],
  [TENANT_A, COMPANY_BARE],
  [TENANT_B, COMPANY_B1],
];

describe('Company provisioning', () => {
  let provisioning: CompanyProvisioningService;
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
      imports: [AppConfigModule, DatabaseModule, CompaniesModule],
    }).compile();
    await moduleRef.init();

    provisioning = moduleRef.get(CompanyProvisioningService);
    uow = moduleRef.get(UnitOfWork);
    close = () => moduleRef.close();

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();

    await purge();
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'provision-a',
      'Provision A',
      TENANT_B,
      'provision-b',
      'Provision B',
    ]);
    await owner.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)', [
      USER,
      'provisioner@company.test',
      'Provisioner',
      'not-a-real-hash',
    ]);
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await close();
  });

  beforeEach(async () => {
    // Companies are what each test creates, so each starts with none. Otherwise "exactly one
    // sequence" would be a statement about every test that ran before this one.
    await clearCompanies();
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function clearCompanies(): Promise<void> {
    // Per company, not per tenant. The sequence policy matches on the company as well as the
    // tenant, so a single company context hides every other company's rows and the delete would
    // silently skip them, leaving the foreign key to refuse the companies afterwards.
    for (const [tenantId, companyId] of COMPANY_SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM document_number_sequences WHERE company_id = $1', [companyId]);
      await owner.query(
        'DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE company_id = $1)',
        [companyId],
      );
      await owner.query('DELETE FROM membership_roles WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM memberships WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM roles WHERE company_id = $1', [companyId]);
    }
    await ownerContext();
    await owner.query('TRUNCATE audit_events');
    for (const tenantId of TENANTS) {
      await ownerContext(tenantId);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1', [tenantId]);
    }
  }

  async function purge(): Promise<void> {
    await clearCompanies();
    await ownerContext();
    await owner.query('DELETE FROM users WHERE id = $1', [USER]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [TENANTS]);
  }

  /** Every sequence row a company holds, read past the application with the owning role. */
  const sequencesOf = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      id: string;
      tenant_id: string;
      company_id: string;
      doc_type: string;
      prefix: string;
      gapless: boolean;
      next_value: string;
    }>('SELECT * FROM document_number_sequences ORDER BY doc_type');
    return rows.rows;
  };

  const companyRows = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query('SELECT id FROM companies WHERE id = $1', [companyId]);
    return rows.rows;
  };

  /** Every role a company holds, with how many permissions each carries. */
  const rolesOf = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      id: string;
      tenant_id: string;
      company_id: string;
      key: string;
      grants: string;
    }>(
      `SELECT r.id, r.tenant_id, r.company_id, r.key,
              (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS grants
         FROM roles r
        ORDER BY r.key`,
    );
    return rows.rows;
  };

  /** Every membership a company holds, with the role keys each one carries. */
  const membersOf = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      id: string;
      tenant_id: string;
      company_id: string;
      user_id: string;
      status: string;
      role_keys: string[] | null;
    }>(
      `SELECT m.id, m.tenant_id, m.company_id, m.user_id, m.status,
              array_remove(array_agg(r.key), NULL) AS role_keys
         FROM memberships m
         LEFT JOIN membership_roles mr ON mr.membership_id = m.id
         LEFT JOIN roles r ON r.id = mr.role_id
        WHERE m.company_id = $1
        GROUP BY m.id, m.tenant_id, m.company_id, m.user_id, m.status`,
      // Named explicitly, because the memberships policy is tenant-only by design: company
      // switching reads a person's memberships across the companies of their tenant. Relying on
      // row level security here would return every company's members and quietly pass.
      [companyId],
    );
    return rows.rows;
  };

  const provisionA1 = () =>
    provisioning.provision({
      tenantId: TENANT_A,
      id: COMPANY_A1,
      name: 'A One',
      baseCurrency: 'USD',
      administratorUserId: USER,
    });

  // -------------------------------------------------------------------------------------
  // 1. A new company gets its sequence.
  // -------------------------------------------------------------------------------------

  describe('a newly created company', () => {
    it('receives a sales order sequence', async () => {
      const { company, salesOrderSequence } = await provisionA1();

      expect(company.id).toBe(COMPANY_A1);
      expect(salesOrderSequence.docType).toBe(SALES_ORDER_DOC_TYPE);

      const stored = await sequencesOf(TENANT_A, COMPANY_A1);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.doc_type).toBe(SALES_ORDER_DOC_TYPE);
    });

    it('starts the counter at one, unspent', async () => {
      await provisionA1();

      const stored = await sequencesOf(TENANT_A, COMPANY_A1);
      expect(stored[0]?.next_value).toBe('1');
    });

    it('is gapless by default, because a sales order becomes an invoice', async () => {
      // Section 10.4 makes the choice a per sequence setting. Starting at the stricter one means
      // a company has to opt out of a legal requirement rather than remember to opt in.
      await provisionA1();

      const stored = await sequencesOf(TENANT_A, COMPANY_A1);
      expect(stored[0]?.gapless).toBe(true);
    });

    it('carries the prefix the rest of the system already prints', async () => {
      const { salesOrderSequence } = await provisionA1();

      expect(salesOrderSequence.prefix).toBe('SO-');
    });
  });

  // -------------------------------------------------------------------------------------
  // 2. Scope.
  // -------------------------------------------------------------------------------------

  describe('the sequence is scoped', () => {
    it('is stamped with the tenant and company it was created for', async () => {
      await provisionA1();

      const stored = await sequencesOf(TENANT_A, COMPANY_A1);
      expect(stored[0]?.tenant_id).toBe(TENANT_A);
      expect(stored[0]?.company_id).toBe(COMPANY_A1);
    });

    it('is the only sequence in the company, so no other type is invented', async () => {
      // Provisioning what confirmation needs, not a catalogue of every document type the product
      // will eventually have. A delivery sequence created now would be configuration nobody
      // chose, for a document that cannot yet be raised.
      await provisionA1();

      const stored = await sequencesOf(TENANT_A, COMPANY_A1);
      expect(stored.map((row) => row.doc_type)).toEqual([SALES_ORDER_DOC_TYPE]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 3. Provisioning twice.
  // -------------------------------------------------------------------------------------

  describe('provisioning again', () => {
    it('does not create a second sequence for the same company', async () => {
      await provisionA1();

      await uow.inSystemScope(
        systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_A1 }),
        (repositories) => provisionSalesOrderSequence(repositories),
      );

      const stored = await sequencesOf(TENANT_A, COMPANY_A1);
      expect(stored).toHaveLength(1);
    });

    it('returns the sequence that already exists rather than a new one', async () => {
      const first = await provisionA1();

      const again = await uow.inSystemScope(
        systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_A1 }),
        (repositories) => provisionSalesOrderSequence(repositories),
      );

      expect(again.id).toBe(first.salesOrderSequence.id);
    });

    it('is refused by the database if the application ever tries anyway', async () => {
      // The check above is a convenience. This is the guarantee: section 4.1 keeps integrity in
      // the database, and two counters for one document type would issue the same number twice.
      await provisionA1();

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO document_number_sequences (id, tenant_id, company_id, doc_type)
           VALUES ($1,$2,$3,$4)`,
          ['a4100000-0000-4000-8000-00000000000a', TENANT_A, COMPANY_A1, SALES_ORDER_DOC_TYPE],
        ),
      ).rejects.toThrow(/document_number_sequences_company_doc_type_key/);
    });

    it('does not advance a counter that has already been used', async () => {
      await provisionA1();
      await uow.inActorScope(
        actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: USER }),
        (repositories) => allocateSalesOrderNumber(repositories),
      );

      await uow.inSystemScope(
        systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_A1 }),
        (repositories) => provisionSalesOrderSequence(repositories),
      );

      // Still two. Re-provisioning a trading company must not reset it to one and reissue
      // numbers that are already on documents.
      const stored = await sequencesOf(TENANT_A, COMPANY_A1);
      expect(stored[0]?.next_value).toBe('2');
    });
  });

  // -------------------------------------------------------------------------------------
  // 4. Rollback.
  // -------------------------------------------------------------------------------------

  describe('a provisioning transaction that fails', () => {
    it('leaves neither the company nor its sequence behind', async () => {
      const failure = new Error('provisioning refused by test');

      await expect(
        uow.inSystemScope(
          systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_DOOMED }),
          async (repositories) => {
            await repositories.companies.create({
              id: COMPANY_DOOMED,
              name: 'Doomed',
              baseCurrency: 'USD',
            });
            await provisionSalesOrderSequence(repositories);
            throw failure;
          },
        ),
      ).rejects.toBe(failure);

      expect(await companyRows(TENANT_A, COMPANY_DOOMED)).toEqual([]);
      expect(await sequencesOf(TENANT_A, COMPANY_DOOMED)).toEqual([]);
    });

    it('writes the company and the sequence in one transaction', async () => {
      // `xmin` is the transaction that last wrote the row. Two different values would mean two
      // transactions, and a company could then exist for a moment with no sequence. This is the
      // same proof the audit trail uses in section 7.1.
      await provisionA1();

      await ownerContext(TENANT_A, COMPANY_A1);
      const company = await owner.query<{ xmin: string }>(
        'SELECT xmin::text AS xmin FROM companies WHERE id = $1',
        [COMPANY_A1],
      );
      const sequence = await owner.query<{ xmin: string }>(
        'SELECT xmin::text AS xmin FROM document_number_sequences WHERE company_id = $1',
        [COMPANY_A1],
      );

      expect(company.rows[0]?.xmin).toBe(sequence.rows[0]?.xmin);
    });

    it('leaves no company behind when the sequence write is what fails', async () => {
      // The reverse order of the first case. The company is written, then the sequence write is
      // refused by the unique constraint, and the company must go with it.
      await provisionA1();

      await expect(
        uow.inSystemScope(
          systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_DOOMED }),
          async (repositories) => {
            await repositories.companies.create({
              id: COMPANY_DOOMED,
              name: 'Doomed',
              baseCurrency: 'USD',
            });
            // Same id as the sequence provisioned above, which the primary key refuses.
            await repositories.documentNumberSequences.create({
              id: (await sequencesOf(TENANT_A, COMPANY_A1))[0]!.id,
              docType: 'delivery',
            });
          },
        ),
      ).rejects.toThrow();

      expect(await companyRows(TENANT_A, COMPANY_DOOMED)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 5. What the sequence is for.
  // -------------------------------------------------------------------------------------

  describe('the provisioned sequence', () => {
    it('is what allocation consumes', async () => {
      await provisionA1();

      const allocated = await uow.inActorScope(
        actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: USER }),
        (repositories) => allocateSalesOrderNumber(repositories),
      );

      expect(allocated.value).toBe(1n);
      expect(allocated.formatted).toBe('SO-0001');
      expect((await sequencesOf(TENANT_A, COMPANY_A1))[0]?.next_value).toBe('2');
    });

    it('lets a brand new company confirm its first order without a manual step', async () => {
      // The whole point of the increment. Before it, this sequence of calls threw.
      const { company } = await provisionA1();

      const allocated = await uow.inActorScope(
        actorScope({ tenantId: TENANT_A, companyId: company.id, userId: USER }),
        (repositories) => allocateSalesOrderNumber(repositories),
      );

      expect(allocated.formatted).toBe('SO-0001');
    });
  });

  // -------------------------------------------------------------------------------------
  // 6. One company cannot reach another's.
  // -------------------------------------------------------------------------------------

  describe('companies do not share a counter', () => {
    it('gives each company in a tenant its own, both starting at one', async () => {
      await provisionA1();
      await provisioning.provision({
        tenantId: TENANT_A,
        id: COMPANY_A2,
        name: 'A Two',
        baseCurrency: 'USD',
        administratorUserId: USER,
      });

      const first = await sequencesOf(TENANT_A, COMPANY_A1);
      const second = await sequencesOf(TENANT_A, COMPANY_A2);

      expect(first[0]?.id).not.toBe(second[0]?.id);
      expect(first[0]?.next_value).toBe('1');
      expect(second[0]?.next_value).toBe('1');
    });

    it('does not let one company advance another, in the same tenant', async () => {
      await provisionA1();
      await provisioning.provision({
        tenantId: TENANT_A,
        id: COMPANY_A2,
        name: 'A Two',
        baseCurrency: 'USD',
        administratorUserId: USER,
      });

      await uow.inActorScope(
        actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: USER }),
        (repositories) => allocateSalesOrderNumber(repositories),
      );

      expect((await sequencesOf(TENANT_A, COMPANY_A1))[0]?.next_value).toBe('2');
      expect((await sequencesOf(TENANT_A, COMPANY_A2))[0]?.next_value).toBe('1');
    });

    it('keeps tenants apart, and both may hold number one at once', async () => {
      await provisionA1();
      await provisioning.provision({
        tenantId: TENANT_B,
        id: COMPANY_B1,
        name: 'B One',
        baseCurrency: 'EUR',
        administratorUserId: USER,
      });

      const here = await uow.inActorScope(
        actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: USER }),
        (repositories) => allocateSalesOrderNumber(repositories),
      );
      const there = await uow.inActorScope(
        actorScope({ tenantId: TENANT_B, companyId: COMPANY_B1, userId: USER }),
        (repositories) => allocateSalesOrderNumber(repositories),
      );

      // Two companies each holding SO-0001 is correct. The number is unique within a company,
      // never across the platform.
      expect(here.formatted).toBe('SO-0001');
      expect(there.formatted).toBe('SO-0001');
      expect((await sequencesOf(TENANT_A, COMPANY_A1))[0]?.next_value).toBe('2');
      expect((await sequencesOf(TENANT_B, COMPANY_B1))[0]?.next_value).toBe('2');
    });
  });

  // -------------------------------------------------------------------------------------
  // 7. Allocation is not a provisioning path.
  // -------------------------------------------------------------------------------------

  describe('allocation never creates a sequence', () => {
    it('refuses a company that was never provisioned, and writes nothing', async () => {
      // A counter invented at allocation time would issue number one to a company that has been
      // trading for a year, so the refusal is the correct behaviour rather than a gap.
      await uow.inSystemScope(
        systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_BARE }),
        (repositories) =>
          repositories.companies.create({
            id: COMPANY_BARE,
            name: 'Bare',
            baseCurrency: 'USD',
          }),
      );

      await expect(
        uow.inActorScope(
          actorScope({ tenantId: TENANT_A, companyId: COMPANY_BARE, userId: USER }),
          (repositories) => allocateSalesOrderNumber(repositories),
        ),
      ).rejects.toThrow();

      expect(await sequencesOf(TENANT_A, COMPANY_BARE)).toEqual([]);
    });

    it('leaves no sequence behind even after several refused attempts', async () => {
      await uow.inSystemScope(
        systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_BARE }),
        (repositories) =>
          repositories.companies.create({
            id: COMPANY_BARE,
            name: 'Bare',
            baseCurrency: 'USD',
          }),
      );

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(
          uow.inActorScope(
            actorScope({ tenantId: TENANT_A, companyId: COMPANY_BARE, userId: USER }),
            (repositories) => allocateSalesOrderNumber(repositories),
          ),
        ).rejects.toThrow();
      }

      expect(await sequencesOf(TENANT_A, COMPANY_BARE)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 8. Everything a company needs, in one transaction.
  // -------------------------------------------------------------------------------------

  describe('the whole company, or none of it', () => {
    it('creates the company, its default roles and its sequence together', async () => {
      const { company, roles, salesOrderSequence } = await provisionA1();

      expect(company.id).toBe(COMPANY_A1);
      expect(roles.map((role) => role.key).sort()).toEqual([...ROLE_KEYS].sort());
      expect(salesOrderSequence.docType).toBe(SALES_ORDER_DOC_TYPE);

      // Read back from the database, not from what the service returned.
      expect(await rolesOf(TENANT_A, COMPANY_A1)).toHaveLength(ROLE_KEYS.length);
      expect(await sequencesOf(TENANT_A, COMPANY_A1)).toHaveLength(1);
      expect(await companyRows(TENANT_A, COMPANY_A1)).toHaveLength(1);
    });

    it('scopes all three to the same tenant and company', async () => {
      await provisionA1();

      for (const role of await rolesOf(TENANT_A, COMPANY_A1)) {
        expect(role.tenant_id).toBe(TENANT_A);
        expect(role.company_id).toBe(COMPANY_A1);
      }
      const sequence = (await sequencesOf(TENANT_A, COMPANY_A1))[0];
      expect(sequence?.tenant_id).toBe(TENANT_A);
      expect(sequence?.company_id).toBe(COMPANY_A1);
    });

    it('gives every seeded role the permissions its template grants', async () => {
      // Section 2.7 seeds templates, not empty shells. A role with no permissions would look
      // provisioned on the administration screen and grant nothing.
      await provisionA1();

      for (const role of await rolesOf(TENANT_A, COMPANY_A1)) {
        expect(Number(role.grants)).toBeGreaterThan(0);
      }
    });

    it('writes all three in a single transaction', async () => {
      // One `xmin` across the company, a role and the sequence. Three values would mean three
      // transactions and three windows in which a company exists half configured.
      await provisionA1();

      await ownerContext(TENANT_A, COMPANY_A1);
      const written = await owner.query<{ xmin: string }>(
        `SELECT xmin::text AS xmin FROM companies WHERE id = $1
         UNION
         SELECT xmin::text FROM roles WHERE company_id = $1
         UNION
         SELECT xmin::text FROM document_number_sequences WHERE company_id = $1`,
        [COMPANY_A1],
      );

      expect(written.rows).toHaveLength(1);
    });

    it('leaves nothing behind when role seeding fails', async () => {
      // The roles are seeded before the sequence, so a failure here has already written the
      // company and some of the roles. All of it must go.
      await expect(
        uow.inSystemScope(
          systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_DOOMED }),
          async (repositories) => {
            await repositories.companies.create({
              id: COMPANY_DOOMED,
              name: 'Doomed',
              baseCurrency: 'USD',
            });
            await seedDefaultRolesIn(repositories, COMPANY_DOOMED);
            // A second seeding of the same company, which the unique key on company and role
            // key refuses partway through the second role.
            await seedDefaultRolesIn(repositories, COMPANY_DOOMED);
          },
        ),
      ).rejects.toThrow();

      expect(await companyRows(TENANT_A, COMPANY_DOOMED)).toEqual([]);
      expect(await rolesOf(TENANT_A, COMPANY_DOOMED)).toEqual([]);
      expect(await sequencesOf(TENANT_A, COMPANY_DOOMED)).toEqual([]);
    });

    it('leaves no roles behind when the sequence write is what fails', async () => {
      await provisionA1();

      await expect(
        uow.inSystemScope(
          systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_DOOMED }),
          async (repositories) => {
            await repositories.companies.create({
              id: COMPANY_DOOMED,
              name: 'Doomed',
              baseCurrency: 'USD',
            });
            await seedDefaultRolesIn(repositories, COMPANY_DOOMED);
            // Reusing the sequence id already provisioned above, which the primary key refuses.
            await repositories.documentNumberSequences.create({
              id: (await sequencesOf(TENANT_A, COMPANY_A1))[0]!.id,
              docType: SALES_ORDER_DOC_TYPE,
            });
          },
        ),
      ).rejects.toThrow();

      expect(await companyRows(TENANT_A, COMPANY_DOOMED)).toEqual([]);
      expect(await rolesOf(TENANT_A, COMPANY_DOOMED)).toEqual([]);
    });

    it('refuses to provision the same company twice, and changes nothing when it does', async () => {
      const first = await provisionA1();

      await expect(provisionA1()).rejects.toThrow();

      // Still exactly one of each, and the same rows as before.
      expect(await rolesOf(TENANT_A, COMPANY_A1)).toHaveLength(ROLE_KEYS.length);
      const sequences = await sequencesOf(TENANT_A, COMPANY_A1);
      expect(sequences).toHaveLength(1);
      expect(sequences[0]?.id).toBe(first.salesOrderSequence.id);
    });

    it('provisions each company in a tenant separately and completely', async () => {
      await provisionA1();
      await provisioning.provision({
        tenantId: TENANT_A,
        id: COMPANY_A2,
        name: 'A Two',
        baseCurrency: 'USD',
        administratorUserId: USER,
      });

      // Roles are per company, per section 2.7, so the same six keys exist twice over as
      // different rows rather than being shared.
      const first = await rolesOf(TENANT_A, COMPANY_A1);
      const second = await rolesOf(TENANT_A, COMPANY_A2);

      expect(first).toHaveLength(ROLE_KEYS.length);
      expect(second).toHaveLength(ROLE_KEYS.length);
      expect(first.map((role) => role.key)).toEqual(second.map((role) => role.key));
      expect(first.some((role) => second.some((other) => other.id === role.id))).toBe(false);
    });

    it('records the seeding in the audit trail, in that same transaction', async () => {
      await provisionA1();

      await ownerContext(TENANT_A, COMPANY_A1);
      const events = await owner.query<{ action: string; entity_id: string; xmin: string }>(
        `SELECT action, entity_id, xmin::text AS xmin FROM audit_events WHERE entity_id = $1`,
        [COMPANY_A1],
      );
      const company = await owner.query<{ xmin: string }>(
        'SELECT xmin::text AS xmin FROM companies WHERE id = $1',
        [COMPANY_A1],
      );

      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]?.action).toBe('roles_seeded');
      // Section 7.1: the record and the change it describes share a transaction.
      expect(events.rows[0]?.xmin).toBe(company.rows[0]?.xmin);
    });
  });

  // -------------------------------------------------------------------------------------
  // 9. The company's first member.
  // -------------------------------------------------------------------------------------

  describe('the first administrator', () => {
    it('is admitted as a member of the new company', async () => {
      const { administrator } = await provisionA1();

      expect(administrator.membership.userId).toBe(USER);

      const members = await membersOf(TENANT_A, COMPANY_A1);
      expect(members).toHaveLength(1);
      expect(members[0]?.user_id).toBe(USER);
      expect(members[0]?.status).toBe('active');
    });

    it('belongs to the tenant and company being provisioned', async () => {
      await provisionA1();

      const member = (await membersOf(TENANT_A, COMPANY_A1))[0];
      expect(member?.tenant_id).toBe(TENANT_A);
      expect(member?.company_id).toBe(COMPANY_A1);
    });

    it('holds the administrator role, and only that one', async () => {
      await provisionA1();

      const member = (await membersOf(TENANT_A, COMPANY_A1))[0];
      expect(member?.role_keys).toEqual(['administrator']);
    });

    it('holds this company\'s own copy of the role, not another company\'s', async () => {
      // Section 2.7 makes roles the company's own from the moment they are seeded. Pointing a
      // membership at a role row belonging to a sibling company would be the one way to make
      // authority travel between companies.
      const { administrator } = await provisionA1();

      const roles = await rolesOf(TENANT_A, COMPANY_A1);
      const administratorRole = roles.find((role) => role.key === 'administrator');

      expect(administrator.roleId).toBe(administratorRole?.id);
      expect(administratorRole?.company_id).toBe(COMPANY_A1);
    });

    it('takes its permissions from the template rather than from anything set here', async () => {
      // Provisioning grants no permission of its own. Whatever the administrator can do is what
      // the catalogue's template says, read back through the role the membership points at.
      await provisionA1();

      const granted = await uow.inActorScope(
        actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: USER }),
        async (repositories) => {
          const membership = await repositories.memberships.findOwnForActiveCompany();
          return repositories.roles.listPermissionsForMembership(membership!.id);
        },
      );

      expect(granted.length).toBeGreaterThan(0);
      expect(granted).toContain('admin:users');
    });

    it('is reachable as an ordinary member, with no founder flag anywhere', async () => {
      // The membership carries nothing marking it as the first. If it did, every later
      // authorization decision would have a second thing to consult.
      await provisionA1();

      await ownerContext(TENANT_A, COMPANY_A1);
      const columns = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'memberships'`,
      );
      const names = columns.rows.map((row) => row.column_name);

      expect(names).not.toContain('is_admin');
      expect(names).not.toContain('is_owner');
      expect(names).not.toContain('is_founder');
    });
  });

  // -------------------------------------------------------------------------------------
  // 10. All four, or none.
  // -------------------------------------------------------------------------------------

  describe('company, roles, sequence and membership together', () => {
    it('writes all four in a single transaction', async () => {
      await provisionA1();

      await ownerContext(TENANT_A, COMPANY_A1);
      const written = await owner.query<{ xmin: string }>(
        `SELECT xmin::text AS xmin FROM companies WHERE id = $1
         UNION
         SELECT xmin::text FROM roles WHERE company_id = $1
         UNION
         SELECT xmin::text FROM document_number_sequences WHERE company_id = $1
         UNION
         SELECT xmin::text FROM memberships WHERE company_id = $1
         UNION
         SELECT xmin::text FROM membership_roles WHERE company_id = $1`,
        [COMPANY_A1],
      );

      expect(written.rows).toHaveLength(1);
    });

    it('leaves nothing behind when admitting the administrator fails', async () => {
      // The membership is written last, so by the time this fails the company, its roles and its
      // sequence are all in the transaction. Every one of them must go.
      await expect(
        provisioning.provision({
          tenantId: TENANT_A,
          id: COMPANY_DOOMED,
          name: 'Doomed',
          baseCurrency: 'USD',
          // No such user, which the membership's foreign key refuses.
          administratorUserId: 'a3900000-0000-4000-8000-00000000000f',
        }),
      ).rejects.toThrow();

      expect(await companyRows(TENANT_A, COMPANY_DOOMED)).toEqual([]);
      expect(await rolesOf(TENANT_A, COMPANY_DOOMED)).toEqual([]);
      expect(await sequencesOf(TENANT_A, COMPANY_DOOMED)).toEqual([]);
      expect(await membersOf(TENANT_A, COMPANY_DOOMED)).toEqual([]);
    });

    it('leaves no membership when an earlier step is what fails', async () => {
      await provisionA1();

      await expect(
        uow.inSystemScope(
          systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_DOOMED }),
          async (repositories) => {
            await repositories.companies.create({
              id: COMPANY_DOOMED,
              name: 'Doomed',
              baseCurrency: 'USD',
            });
            await repositories.memberships.create({
              id: 'a3800000-0000-4000-8000-00000000000e',
              userId: USER,
            });
            // Reusing the sequence id provisioned above, which the primary key refuses.
            await repositories.documentNumberSequences.create({
              id: (await sequencesOf(TENANT_A, COMPANY_A1))[0]!.id,
              docType: SALES_ORDER_DOC_TYPE,
            });
          },
        ),
      ).rejects.toThrow();

      expect(await membersOf(TENANT_A, COMPANY_DOOMED)).toEqual([]);
      expect(await companyRows(TENANT_A, COMPANY_DOOMED)).toEqual([]);
    });

    it('cannot admit the same person to one company twice', async () => {
      await provisionA1();

      const refusal = await uow
        .inSystemScope(
          systemScope('tenant-provisioning', { tenantId: TENANT_A, companyId: COMPANY_A1 }),
          (repositories) =>
            repositories.memberships.create({
              id: 'a3700000-0000-4000-8000-00000000000d',
              userId: USER,
            }),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );

      // The constraint name lives in the driver error, which the query layer wraps, so the
      // assertion walks the cause chain rather than reading the outermost message.
      expect(causeChain(refusal)).toMatch(/memberships_company_user_key/);
      expect(await membersOf(TENANT_A, COMPANY_A1)).toHaveLength(1);
    });

    it('leaves membership untouched when provisioning is retried', async () => {
      const first = await provisionA1();

      await expect(provisionA1()).rejects.toThrow();

      const members = await membersOf(TENANT_A, COMPANY_A1);
      expect(members).toHaveLength(1);
      expect(members[0]?.id).toBe(first.administrator.membership.id);
      expect(members[0]?.role_keys).toEqual(['administrator']);
    });

    it('gives two companies in a tenant separate memberships for the same person', async () => {
      // Section 2.6: one account reaches every company the person belongs to, through a separate
      // membership in each. The same user in two companies is two rows, not one shared one.
      const first = await provisionA1();
      const second = await provisioning.provision({
        tenantId: TENANT_A,
        id: COMPANY_A2,
        name: 'A Two',
        baseCurrency: 'USD',
        administratorUserId: USER,
      });

      expect(first.administrator.membership.id).not.toBe(second.administrator.membership.id);
      expect(first.administrator.roleId).not.toBe(second.administrator.roleId);

      const here = await membersOf(TENANT_A, COMPANY_A1);
      const there = await membersOf(TENANT_A, COMPANY_A2);
      expect(here).toHaveLength(1);
      expect(there).toHaveLength(1);
      expect(here[0]?.company_id).toBe(COMPANY_A1);
      expect(there[0]?.company_id).toBe(COMPANY_A2);
    });

    it('does not make the administrator of one company a member of its sibling', async () => {
      await provisionA1();

      // Reading company A2 as the same user, who has no membership there at all.
      const seen = await uow.inActorScope(
        actorScope({ tenantId: TENANT_A, companyId: COMPANY_A2, userId: USER }),
        (repositories) => repositories.memberships.findOwnForActiveCompany(),
      );

      expect(seen).toBeNull();
    });
  });
});

/** Every message in an error's cause chain, because the query layer wraps driver errors. */
function causeChain(error: unknown): string {
  const messages: string[] = [];

  for (let current = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }

  return messages.join(' | ');
}
