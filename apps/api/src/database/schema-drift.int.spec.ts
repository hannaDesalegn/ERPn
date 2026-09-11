/**
 * Schema drift verification. Criteria 28 to 32.
 *
 * Contract section 1.2 ratified handwritten SQL migrations, and named the risk that comes with
 * them: the SQL and the Drizzle definitions are maintained separately and can silently
 * diverge. This file is the price of that decision, paid in tests.
 *
 * It reads the LIVE PostgreSQL catalogue, not the migration file. That distinction is the whole
 * point. A test that parsed the SQL would pass for a migration that was never applied, and
 * would miss a hand edit made directly against a database. Reading the catalogue asks what is
 * actually there.
 *
 * The lists it checks against are composed in `schema/index.ts` from each module's own
 * declarations, so a module added without being registered there fails the first assertion
 * rather than going unchecked.
 *
 * These tests require the migrations to have been applied: `npm run db:up && npm run db:migrate`.
 */

import { Client } from 'pg';
import { getTableConfig } from 'drizzle-orm/pg-core';

import {
  COMPANY_PARTITIONED_TABLES,
  databaseSchema,
  GLOBAL_TABLES,
  INFRASTRUCTURE_TABLES,
  NULLABLE_SCOPE_TABLES,
  TENANT_SCOPED_TABLES,
  VERSION_EXEMPT_TABLES,
} from './schema/index.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];
const APP_ROLE = process.env['APP_DB_ROLE'] ?? 'erp_app';

interface LiveColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
}

describe('Schema drift', () => {
  let db: Client;
  let liveColumns: LiveColumn[];

  const liveTables = () => [...new Set(liveColumns.map((c) => c.table_name))].sort();
  const columnsOf = (table: string) => liveColumns.filter((c) => c.table_name === table);
  const columnNames = (table: string) => columnsOf(table).map((c) => c.column_name).sort();

  beforeAll(async () => {
    if (!MIGRATION_URL) {
      throw new Error(
        'MIGRATION_DATABASE_URL is not set. Drift tests read the live schema: run `npm run db:up` and `npm run db:migrate` first.',
      );
    }

    db = new Client({ connectionString: MIGRATION_URL });
    await db.connect();

    const result = await db.query<LiveColumn>(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, column_name`,
    );
    liveColumns = result.rows;

    if (liveColumns.length === 0) {
      throw new Error('The public schema is empty. Run `npm run db:migrate` before these tests.');
    }
  });

  afterAll(async () => {
    await db.end();
  });

  // -------------------------------------------------------------------------------------
  // Criterion 29: the running schema matches the Drizzle definitions.
  // -------------------------------------------------------------------------------------

  describe('the running schema matches the Drizzle definitions', () => {
    it('declares every table that exists, and no table that does not', () => {
      const declared = Object.values(databaseSchema)
        .map((table) => getTableConfig(table).name)
        .sort();

      expect(declared).toEqual(liveTables());
    });

    it.each(Object.entries(databaseSchema))(
      'declares exactly the columns %s has in the database',
      (_key, table) => {
        const config = getTableConfig(table);
        const declared = config.columns.map((column) => column.name).sort();

        expect(declared).toEqual(columnNames(config.name));
      },
    );

    it.each(Object.entries(databaseSchema))(
      'agrees with the database about nullability on %s',
      (_key, table) => {
        const config = getTableConfig(table);

        const declaredNullable = config.columns
          .filter((column) => !column.notNull)
          .map((column) => column.name)
          .sort();
        const liveNullable = columnsOf(config.name)
          .filter((column) => column.is_nullable === 'YES')
          .map((column) => column.column_name)
          .sort();

        expect(declaredNullable).toEqual(liveNullable);
      },
    );
  });

  // -------------------------------------------------------------------------------------
  // Criterion 28: scope columns, and the version rule as amended in section 4.2.
  // -------------------------------------------------------------------------------------

  describe('scope columns', () => {
    it.each(TENANT_SCOPED_TABLES)('%s carries tenant_id', (table) => {
      expect(columnNames(table)).toContain('tenant_id');
    });

    it.each(COMPANY_PARTITIONED_TABLES)('%s carries company_id', (table) => {
      expect(columnNames(table)).toContain('company_id');
    });

    it('companies carries no company_id, because it is the company', () => {
      expect(columnNames('companies')).not.toContain('company_id');
    });

    it.each(TENANT_SCOPED_TABLES.filter((t) => !NULLABLE_SCOPE_TABLES.includes(t as never)))(
      '%s has scope columns that are not null',
      (table) => {
        const scope = columnsOf(table).filter((c) =>
          ['tenant_id', 'company_id'].includes(c.column_name),
        );

        for (const column of scope) {
          expect(`${column.column_name}=${column.is_nullable}`).toBe(`${column.column_name}=NO`);
        }
      },
    );

    it.each(NULLABLE_SCOPE_TABLES)(
      '%s has nullable scope columns, the single exception in section 7.3',
      (table) => {
        const scope = columnsOf(table).filter((c) =>
          ['tenant_id', 'company_id'].includes(c.column_name),
        );

        expect(scope).toHaveLength(2);
        for (const column of scope) {
          expect(column.is_nullable).toBe('YES');
        }
      },
    );

    it.each(GLOBAL_TABLES)('%s carries neither scope column', (table) => {
      expect(columnNames(table)).not.toContain('tenant_id');
      expect(columnNames(table)).not.toContain('company_id');
    });
  });

  describe('the version column', () => {
    const mutable = [...TENANT_SCOPED_TABLES, ...GLOBAL_TABLES].filter(
      (table) =>
        !VERSION_EXEMPT_TABLES.includes(table as never) &&
        !INFRASTRUCTURE_TABLES.includes(table as never),
    );

    it.each(mutable)('%s is mutable, so it carries version', (table) => {
      expect(columnNames(table)).toContain('version');
    });

    it.each(VERSION_EXEMPT_TABLES)(
      '%s claims one of the four exempt shapes, so it must NOT carry an unused version column',
      (table) => {
        // Section 4.2: a column that looks like a concurrency control and is never checked is
        // worse than an absent one.
        expect(columnNames(table)).not.toContain('version');
      },
    );

    it('exempts sessions under the fourth shape, and nothing else under it', () => {
      // The fourth shape, ephemeral operational state under last write wins, is deliberately
      // narrow. This pins the intended membership so that widening it is a visible, reviewed
      // change to this list rather than a quiet addition to the exempt array.
      const associationOrAppendOnly = ['role_permissions', 'membership_roles', 'audit_events'];
      const claimingFourthShape = VERSION_EXEMPT_TABLES.filter(
        (table) => !associationOrAppendOnly.includes(table),
      );

      expect(claimingFourthShape).toEqual(['sessions']);
    });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 30: row level security, read from the catalogue rather than the migration text.
  // -------------------------------------------------------------------------------------

  describe('row level security', () => {
    let rls: { relname: string; enabled: boolean; forced: boolean }[];

    beforeAll(async () => {
      const result = await db.query<{ relname: string; enabled: boolean; forced: boolean }>(
        `SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class
         WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`,
      );
      rls = result.rows;
    });

    it.each(TENANT_SCOPED_TABLES)('%s has row level security enabled and forced', (table) => {
      const row = rls.find((r) => r.relname === table);

      expect(row).toBeDefined();
      // FORCE matters as much as ENABLE. Without it the table owner is exempt from its own
      // policies, and the migration role owns every table here.
      expect({ enabled: row?.enabled, forced: row?.forced }).toEqual({
        enabled: true,
        forced: true,
      });
    });

    it.each(TENANT_SCOPED_TABLES)('%s has at least one policy', async (table) => {
      const result = await db.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );

      expect(result.rowCount).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 32: grants, read from the catalogue.
  // -------------------------------------------------------------------------------------

  describe('privileges held by the application role', () => {
    let grants: Map<string, Set<string>>;

    beforeAll(async () => {
      const result = await db.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_schema = 'public'`,
        [APP_ROLE],
      );

      grants = new Map();
      for (const row of result.rows) {
        const set = grants.get(row.table_name) ?? new Set<string>();
        set.add(row.privilege_type);
        grants.set(row.table_name, set);
      }
    });

    it('holds exactly INSERT and SELECT on audit_events, making it append only', () => {
      // The append-only guarantee in section 7.1 is a grant, not a convention. If UPDATE or
      // DELETE ever appears here, application code can revise history.
      expect([...(grants.get('audit_events') ?? [])].sort()).toEqual(['INSERT', 'SELECT']);
    });

    it.each(['tenants', 'companies', 'users', 'sales_orders'])(
      'holds no DELETE on %s',
      (table) => {
        // Section 4.5: business records are cancelled, reversed or archived, never deleted. A
        // sales order that is abandoned becomes cancelled; 4.5 permits deleting a draft that
        // was never confirmed, and that grant is withheld until something needs it.
        expect([...(grants.get(table) ?? [])]).not.toContain('DELETE');
      },
    );

    it('holds DELETE on sales_order_lines, because a draft is editable', () => {
      // Section 12.2: a draft is editable and has no side effects, so removing a line from one
      // is ordinary editing rather than deleting a document. Whether a line may be removed
      // after confirmation is a state machine question, not a grant question.
      expect([...(grants.get('sales_order_lines') ?? [])]).toContain('DELETE');
    });

    it('holds no DELETE on document_number_sequences', () => {
      // A counter that can be dropped and recreated is a counter that can be reset, which is
      // how a gapless sequence reissues a number already printed on a document.
      expect([...(grants.get('document_number_sequences') ?? [])].sort()).toEqual([
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
    });

    it('holds only SELECT on tenants, which platform administration owns', () => {
      expect([...(grants.get('tenants') ?? [])]).toEqual(['SELECT']);
    });

    it('holds nothing at all on the migration runner bookkeeping table', () => {
      expect(grants.get('schema_migrations')).toBeUndefined();
    });
  });
});
