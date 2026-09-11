/**
 * Provisioning a company, against a real PostgreSQL.
 *
 * The invariant being proved is one sentence: a company that exists has the sales order sequence
 * confirmation will later demand, and it got it in the same transaction that created it.
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
    }
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

  const provisionA1 = () =>
    provisioning.provision({
      tenantId: TENANT_A,
      id: COMPANY_A1,
      name: 'A One',
      baseCurrency: 'USD',
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
});
