/**
 * The chart of accounts and the posting account mapping, against a real PostgreSQL.
 *
 * WHY THIS NEEDS A REAL DATABASE. Almost every claim here is a constraint, a grant or a policy:
 * a unique code per company, a foreign key that refuses another company's account, a withheld
 * DELETE, a row level security policy that hides a sibling company's chart. Section 13.2 says a
 * mock proves nothing about any of them, and a fake uniqueness check is the application agreeing
 * with itself.
 *
 * TWO TENANTS AND THREE COMPANIES, with the same account codes in each, because uniqueness is per
 * company and a lookup by code is only safe if it is scoped. An unscoped `findByCode` would match
 * three rows and return whichever the planner reached first.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, ConcurrencyConflictError, systemScope, UnitOfWork } from '../database/index.js';
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  provisionChartOfAccounts,
} from './chart-of-accounts.js';
import {
  DEFAULT_POSTING_ACCOUNTS,
  POSTING_ACCOUNT_PURPOSES,
  provisionPostingAccounts,
} from './posting-accounts.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'e1100000-0000-4000-8000-00000000000a';
const TENANT_B = 'e1200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'e2100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "wrong company, right tenant" is representable. */
const COMPANY_A2 = 'e2200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'e2300000-0000-4000-8000-00000000000c';

const USER = 'e3100000-0000-4000-8000-00000000000a';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const inA1 = () => actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: USER });
const inA2 = () => actorScope({ tenantId: TENANT_A, companyId: COMPANY_A2, userId: USER });
const inB1 = () => actorScope({ tenantId: TENANT_B, companyId: COMPANY_B1, userId: USER });

const scopeFor = (companyId: string) =>
  companyId === COMPANY_A1 ? inA1() : companyId === COMPANY_A2 ? inA2() : inB1();

describe('Chart of accounts', () => {
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
    await seedCompanies();
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await close();
  });

  beforeEach(async () => {
    // Each test provisions what it needs, so each starts with no chart anywhere. Otherwise "the
    // company holds exactly three accounts" would be a statement about the tests before it.
    await clearCharts();
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function seedCompanies(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'coa-a',
      'COA A',
      TENANT_B,
      'coa-b',
      'COA B',
    ]);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_A }), async (r) => {
      await r.users.create({ id: USER, email: 'coa@company.test', name: 'COA', passwordHash: 'x' });
      await r.companies.create({ id: COMPANY_A1, name: 'A One', baseCurrency: 'USD' });
      await r.companies.create({ id: COMPANY_A2, name: 'A Two', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_B }), (r) =>
      r.companies.create({ id: COMPANY_B1, name: 'B One', baseCurrency: 'EUR' }),
    );
  }

  async function clearCharts(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM company_posting_accounts WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM accounts WHERE company_id = $1', [companyId]);
    }
  }

  async function purge(): Promise<void> {
    await clearCharts();
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('DELETE FROM users WHERE id = $1', [USER]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  /** Provisions the chart and the mapping in one transaction, as company creation does. */
  const provision = (companyId: string) =>
    uow.inActorScope(scopeFor(companyId), async (r) => {
      const chart = await provisionChartOfAccounts(r);
      const mappings = await provisionPostingAccounts(r, chart);
      return { chart, mappings };
    });

  /** Every account row a company holds, read past the application with the owning role. */
  const accountRowsOf = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const result = await owner.query<{
      id: string;
      tenant_id: string;
      company_id: string;
      code: string;
      name: string;
      type: string;
      status: string;
      version: number;
    }>('SELECT * FROM accounts ORDER BY code');
    return result.rows;
  };

  // -------------------------------------------------------------------------------------
  // 1. What provisioning writes.
  // -------------------------------------------------------------------------------------

  describe('a newly provisioned company', () => {
    it('receives the whole default chart', async () => {
      const { chart } = await provision(COMPANY_A1);

      expect(chart.map((account) => account.code)).toEqual(
        DEFAULT_CHART_OF_ACCOUNTS.map((account) => account.code),
      );
    });

    it('receives the three accounts the first invoice posting writes, and no others', async () => {
      await provision(COMPANY_A1);

      const stored = await accountRowsOf(TENANT_A, COMPANY_A1);
      expect(stored.map((row) => `${row.code} ${row.name} ${row.type}`)).toEqual([
        '1200 Accounts Receivable asset',
        '2200 Tax Payable liability',
        '4000 Sales Revenue revenue',
      ]);
    });

    it('stamps every account with the tenant and company it was created for', async () => {
      await provision(COMPANY_A1);

      const stored = await accountRowsOf(TENANT_A, COMPANY_A1);
      for (const row of stored) {
        expect({ tenant: row.tenant_id, company: row.company_id }).toEqual({
          tenant: TENANT_A,
          company: COMPANY_A1,
        });
      }
    });

    it('starts every account active, because a chart nobody can post to is not a chart', async () => {
      await provision(COMPANY_A1);

      const stored = await accountRowsOf(TENANT_A, COMPANY_A1);
      expect(stored.every((row) => row.status === 'active')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------
  // 2. Provisioning twice.
  // -------------------------------------------------------------------------------------

  describe('provisioning again', () => {
    it('adds no second copy of any account', async () => {
      await provision(COMPANY_A1);
      await provision(COMPANY_A1);

      expect(await accountRowsOf(TENANT_A, COMPANY_A1)).toHaveLength(
        DEFAULT_CHART_OF_ACCOUNTS.length,
      );
    });

    it('returns the accounts that already exist rather than new ones', async () => {
      const first = await provision(COMPANY_A1);
      const again = await provision(COMPANY_A1);

      expect(again.chart.map((a) => a.id)).toEqual(first.chart.map((a) => a.id));
    });

    it('leaves a renamed account alone, rather than restoring the default name', async () => {
      // A company owns its chart from creation, per section 2.7's reasoning about role templates.
      // Re-provisioning must not undo an administrator's edit.
      const { chart } = await provision(COMPANY_A1);
      const revenue = chart.find((a) => a.code === '4000')!;
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('UPDATE accounts SET name = $1 WHERE id = $2', ['Turnover', revenue.id]);

      await provision(COMPANY_A1);

      const stored = await accountRowsOf(TENANT_A, COMPANY_A1);
      expect(stored.find((row) => row.code === '4000')?.name).toBe('Turnover');
      expect(stored).toHaveLength(DEFAULT_CHART_OF_ACCOUNTS.length);
    });

    it('is refused by the database if the application ever tries anyway', async () => {
      // The lookup above is a convenience. This is the guarantee, per section 4.1: two accounts
      // with one code would make every posting that resolves by code ambiguous.
      await provision(COMPANY_A1);

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO accounts (id, tenant_id, company_id, code, name, type)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            'e4100000-0000-4000-8000-00000000000a',
            TENANT_A,
            COMPANY_A1,
            '4000',
            'Another Revenue',
            'revenue',
          ],
        ),
      ).rejects.toThrow(/accounts_company_code_key/);
    });

    it('refuses a second account with the same name as well', async () => {
      await provision(COMPANY_A1);

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO accounts (id, tenant_id, company_id, code, name, type)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            'e4200000-0000-4000-8000-00000000000b',
            TENANT_A,
            COMPANY_A1,
            '4001',
            'Sales Revenue',
            'revenue',
          ],
        ),
      ).rejects.toThrow(/accounts_company_name_key/);
    });
  });

  // -------------------------------------------------------------------------------------
  // 3. What the database refuses about an account.
  // -------------------------------------------------------------------------------------

  describe('the database', () => {
    it('refuses an account type outside the accounting equation', async () => {
      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO accounts (id, tenant_id, company_id, code, name, type)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          ['e4300000-0000-4000-8000-00000000000c', TENANT_A, COMPANY_A1, '9000', 'Income', 'income'],
        ),
      ).rejects.toThrow(/accounts_type_check/);
    });

    it('refuses a padded code, which would compare unequal to the same code typed plainly', async () => {
      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO accounts (id, tenant_id, company_id, code, name, type)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          ['e4400000-0000-4000-8000-00000000000d', TENANT_A, COMPANY_A1, ' 4000 ', 'Padded', 'revenue'],
        ),
      ).rejects.toThrow(/accounts_code_check/);
    });

    it('refuses an account in a company that does not exist', async () => {
      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO accounts (id, tenant_id, company_id, code, name, type)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            'e4500000-0000-4000-8000-00000000000e',
            TENANT_A,
            'e2900000-0000-4000-8000-00000000000f',
            '4000',
            'Orphan',
            'revenue',
          ],
        ),
      ).rejects.toThrow();
    });

    it('holds no DELETE on accounts for the application role, per section 4.5', async () => {
      const result = await owner.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = $1 AND table_schema = 'public' AND table_name = 'accounts'`,
        [process.env['APP_DB_ROLE'] ?? 'erp_app'],
      );

      expect(result.rows.map((row) => row.privilege_type).sort()).toEqual([
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 4. Scope.
  // -------------------------------------------------------------------------------------

  describe('company and tenant scope', () => {
    it('gives each company in a tenant its own accounts, with the same codes', async () => {
      const here = await provision(COMPANY_A1);
      const there = await provision(COMPANY_A2);

      expect(here.chart.map((a) => a.code)).toEqual(there.chart.map((a) => a.code));
      // Same codes, different rows. Two companies both numbering revenue 4000 is the normal case.
      expect(here.chart.map((a) => a.id)).not.toEqual(there.chart.map((a) => a.id));
    });

    it('lists only the acting company accounts', async () => {
      await provision(COMPANY_A1);
      await provision(COMPANY_A2);

      const seen = await uow.inActorScope(inA1(), (r) => r.accounts.listForCompany());

      expect(seen.every((account) => account.companyId === COMPANY_A1)).toBe(true);
      expect(seen).toHaveLength(DEFAULT_CHART_OF_ACCOUNTS.length);
    });

    it('cannot reach a sibling company account by identifier', async () => {
      await provision(COMPANY_A1);
      const { chart } = await provision(COMPANY_A2);

      const found = await uow.inActorScope(inA1(), (r) => r.accounts.findById(chart[0]!.id));

      // Section 6.1: a failure at this dimension answers as the record not existing, so an
      // identifier cannot be probed to learn what another company holds.
      expect(found).toBeNull();
    });

    it('cannot reach another tenant account by identifier', async () => {
      await provision(COMPANY_A1);
      const { chart } = await provision(COMPANY_B1);

      const found = await uow.inActorScope(inA1(), (r) => r.accounts.findById(chart[0]!.id));

      expect(found).toBeNull();
    });

    it('resolves a code within the acting company, not across the tenant', async () => {
      const here = await provision(COMPANY_A1);
      await provision(COMPANY_A2);

      const found = await uow.inActorScope(inA1(), (r) => r.accounts.findByCode('4000'));

      expect(found?.id).toBe(here.chart.find((a) => a.code === '4000')!.id);
    });

    it('returns nothing at all when no company context is set', async () => {
      await provision(COMPANY_A1);

      await ownerContext();
      const result = await owner.query<{ count: string }>('SELECT count(*) FROM accounts');

      // Section 2.4: an empty context denies rather than admits. FORCE row level security is what
      // makes this true for the owning role as well.
      expect(result.rows[0]?.count).toBe('0');
    });
  });

  // -------------------------------------------------------------------------------------
  // 5. Archiving, which replaces deleting.
  // -------------------------------------------------------------------------------------

  describe('retiring an account', () => {
    it('archives rather than deletes, per section 4.5', async () => {
      const { chart } = await provision(COMPANY_A1);
      const account = chart.find((a) => a.code === '2200')!;

      const archived = await uow.inActorScope(inA1(), (r) =>
        r.accounts.archive({ id: account.id, expectedVersion: account.version }),
      );

      expect(archived.status).toBe('archived');
      expect(await accountRowsOf(TENANT_A, COMPANY_A1)).toHaveLength(
        DEFAULT_CHART_OF_ACCOUNTS.length,
      );
    });

    it('refuses a stale version, per the optimistic locking in section 10.1', async () => {
      const { chart } = await provision(COMPANY_A1);
      const account = chart.find((a) => a.code === '2200')!;
      await uow.inActorScope(inA1(), (r) =>
        r.accounts.archive({ id: account.id, expectedVersion: account.version }),
      );

      await expect(
        uow.inActorScope(inA1(), (r) =>
          r.accounts.archive({ id: account.id, expectedVersion: account.version }),
        ),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    });

    it('cannot archive a sibling company account', async () => {
      await provision(COMPANY_A1);
      const { chart } = await provision(COMPANY_A2);
      const foreign = chart[0]!;

      await expect(
        uow.inActorScope(inA1(), (r) =>
          r.accounts.archive({ id: foreign.id, expectedVersion: foreign.version }),
        ),
      ).rejects.toThrow(/was not found/);

      const stored = await accountRowsOf(TENANT_A, COMPANY_A2);
      expect(stored.every((row) => row.status === 'active')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------
  // 6. The posting account mapping.
  // -------------------------------------------------------------------------------------

  describe('posting accounts', () => {
    const mappingRowsOf = async (tenantId: string, companyId: string) => {
      await ownerContext(tenantId, companyId);
      const result = await owner.query<{
        purpose: string;
        account_id: string;
        tenant_id: string;
        company_id: string;
      }>('SELECT * FROM company_posting_accounts ORDER BY purpose');
      return result.rows;
    };

    it('maps every purpose the catalogue defines', async () => {
      await provision(COMPANY_A1);

      const stored = await mappingRowsOf(TENANT_A, COMPANY_A1);
      expect(stored.map((row) => row.purpose)).toEqual([...POSTING_ACCOUNT_PURPOSES].sort());
    });

    it('points each purpose at the account the default says', async () => {
      const { chart } = await provision(COMPANY_A1);
      const codeOf = new Map(chart.map((account) => [account.id, account.code]));

      const stored = await mappingRowsOf(TENANT_A, COMPANY_A1);
      const mapped = Object.fromEntries(
        stored.map((row) => [row.purpose, codeOf.get(row.account_id)]),
      );

      expect(mapped).toEqual(DEFAULT_POSTING_ACCOUNTS);
    });

    it('points only at accounts of its own company', async () => {
      await provision(COMPANY_A1);
      await provision(COMPANY_A2);

      const stored = await mappingRowsOf(TENANT_A, COMPANY_A1);
      const own = new Set((await accountRowsOf(TENANT_A, COMPANY_A1)).map((row) => row.id));

      for (const row of stored) {
        expect(own.has(row.account_id)).toBe(true);
      }
    });

    it('is refused by the database when a mapping names another company account', async () => {
      // The guarantee, and the reason the foreign key is composite. A plain `account_id` key
      // would accept any account in the deployment and leave the company check to whichever
      // caller remembered it, which section 6.3 rejects by name.
      await provision(COMPANY_A1);
      const { chart } = await provision(COMPANY_A2);
      const foreign = chart[0]!;

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO company_posting_accounts (id, tenant_id, company_id, purpose, account_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            'e5100000-0000-4000-8000-00000000000a',
            TENANT_A,
            COMPANY_A1,
            'bank',
            foreign.id,
          ],
        ),
      ).rejects.toThrow(/company_posting_accounts_account_fkey/);
    });

    it('is refused by the database when a mapping names another tenant account', async () => {
      await provision(COMPANY_A1);
      const { chart } = await provision(COMPANY_B1);
      const foreign = chart[0]!;

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO company_posting_accounts (id, tenant_id, company_id, purpose, account_id)
           VALUES ($1,$2,$3,$4,$5)`,
          ['e5200000-0000-4000-8000-00000000000b', TENANT_A, COMPANY_A1, 'bank', foreign.id],
        ),
      ).rejects.toThrow(/company_posting_accounts_account_fkey/);
    });

    it('refuses a second mapping for one purpose', async () => {
      const { chart } = await provision(COMPANY_A1);

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO company_posting_accounts (id, tenant_id, company_id, purpose, account_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            'e5300000-0000-4000-8000-00000000000c',
            TENANT_A,
            COMPANY_A1,
            'sales_revenue',
            chart[0]!.id,
          ],
        ),
      ).rejects.toThrow(/company_posting_accounts_company_purpose_key/);
    });

    it('reads back the account a purpose resolves to, inside the acting company', async () => {
      const { chart } = await provision(COMPANY_A1);
      await provision(COMPANY_A2);

      const mapping = await uow.inActorScope(inA1(), (r) =>
        r.postingAccounts.findForPurpose('accounts_receivable'),
      );

      expect(mapping?.accountId).toBe(chart.find((a) => a.code === '1200')!.id);
    });

    it('answers nothing for a purpose in a company that has none', async () => {
      await provision(COMPANY_A1);

      const mapping = await uow.inActorScope(inA2(), (r) =>
        r.postingAccounts.findForPurpose('accounts_receivable'),
      );

      expect(mapping).toBeNull();
    });

    it('repoints a purpose at another account of the same company', async () => {
      const { chart, mappings } = await provision(COMPANY_A1);
      const revenue = mappings.find((m) => m.purpose === 'sales_revenue')!;
      const other = await uow.inActorScope(inA1(), (r) =>
        r.accounts.create({
          id: 'e6100000-0000-4000-8000-00000000000a',
          code: '4100',
          name: 'Service Revenue',
          type: 'revenue',
        }),
      );

      const moved = await uow.inActorScope(inA1(), (r) =>
        r.postingAccounts.pointTo({
          purpose: 'sales_revenue',
          accountId: other.id,
          expectedVersion: revenue.version,
        }),
      );

      expect(moved.accountId).toBe(other.id);
      expect(moved.accountId).not.toBe(chart.find((a) => a.code === '4000')!.id);
    });

    it('refuses to repoint with a stale version', async () => {
      const { mappings } = await provision(COMPANY_A1);
      const revenue = mappings.find((m) => m.purpose === 'sales_revenue')!;
      const other = await uow.inActorScope(inA1(), (r) =>
        r.accounts.create({
          id: 'e6200000-0000-4000-8000-00000000000b',
          code: '4100',
          name: 'Service Revenue',
          type: 'revenue',
        }),
      );
      await uow.inActorScope(inA1(), (r) =>
        r.postingAccounts.pointTo({
          purpose: 'sales_revenue',
          accountId: other.id,
          expectedVersion: revenue.version,
        }),
      );

      await expect(
        uow.inActorScope(inA1(), (r) =>
          r.postingAccounts.pointTo({
            purpose: 'sales_revenue',
            accountId: other.id,
            expectedVersion: revenue.version,
          }),
        ),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    });

    it('cannot be repointed at a sibling company account through the repository either', async () => {
      const { mappings } = await provision(COMPANY_A1);
      const { chart: foreignChart } = await provision(COMPANY_A2);
      const revenue = mappings.find((m) => m.purpose === 'sales_revenue')!;

      // Drizzle wraps the driver error in one of its own, so the constraint name is in the
      // cause chain rather than in the message the repository threw.
      const error = await uow
        .inActorScope(inA1(), (r) =>
          r.postingAccounts.pointTo({
            purpose: 'sales_revenue',
            accountId: foreignChart.find((a) => a.code === '4000')!.id,
            expectedVersion: revenue.version,
          }),
        )
        .catch((thrown: unknown) => thrown);

      expect(causeChain(error)).toMatch(/company_posting_accounts_account_fkey/);
    });

    it('holds no DELETE on the mapping for the application role', async () => {
      const result = await owner.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = $1 AND table_schema = 'public' AND table_name = 'company_posting_accounts'`,
        [process.env['APP_DB_ROLE'] ?? 'erp_app'],
      );

      expect(result.rows.map((row) => row.privilege_type).sort()).toEqual([
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
    });

    it('lists only the acting company mappings', async () => {
      await provision(COMPANY_A1);
      await provision(COMPANY_B1);

      const seen = await uow.inActorScope(inB1(), (r) => r.postingAccounts.listForCompany());

      expect(seen.every((mapping) => mapping.companyId === COMPANY_B1)).toBe(true);
      expect(seen).toHaveLength(POSTING_ACCOUNT_PURPOSES.length);
    });
  });

  // -------------------------------------------------------------------------------------
  // 7. Rollback.
  // -------------------------------------------------------------------------------------

  describe('a provisioning transaction that fails', () => {
    it('leaves neither the chart nor the mapping behind', async () => {
      const failure = new Error('accounting provisioning refused by test');

      await expect(
        uow.inActorScope(inA1(), async (r) => {
          const chart = await provisionChartOfAccounts(r);
          await provisionPostingAccounts(r, chart);
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(await accountRowsOf(TENANT_A, COMPANY_A1)).toEqual([]);
      expect(await mappingRowsOfCompany(TENANT_A, COMPANY_A1)).toEqual([]);
    });

    it('writes the chart and the mapping in one transaction', async () => {
      // `xmin` is the transaction that wrote the row. Two different values would mean a company
      // could exist for a moment with a chart and no mapping onto it.
      await provision(COMPANY_A1);

      await ownerContext(TENANT_A, COMPANY_A1);
      const accountsWritten = await owner.query<{ xmin: string }>(
        'SELECT DISTINCT xmin::text AS xmin FROM accounts',
      );
      const mappingsWritten = await owner.query<{ xmin: string }>(
        'SELECT DISTINCT xmin::text AS xmin FROM company_posting_accounts',
      );

      expect(accountsWritten.rows).toHaveLength(1);
      expect(mappingsWritten.rows).toEqual(accountsWritten.rows);
    });

    async function mappingRowsOfCompany(tenantId: string, companyId: string) {
      await ownerContext(tenantId, companyId);
      const result = await owner.query('SELECT * FROM company_posting_accounts');
      return result.rows;
    }
  });
});

/** Drizzle wraps driver errors, so a constraint name has to be read through the chain. */
function causeChain(error: unknown): string {
  const messages: string[] = [];

  for (let current = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }

  return messages.join(' | ');
}
