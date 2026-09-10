/**
 * Integration tests for the migration runner, against a real PostgreSQL.
 *
 * Each case gets a throwaway schema and a throwaway directory of tiny migrations, so nothing
 * here touches `0001_identity.sql` or the application schema. What is being tested is the
 * runner: does it apply, record, skip, and refuse.
 *
 * These connect as the owning role, because that is the role the runner uses.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from 'pg';

import { MigrationError, runMigrations } from './migrator.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];
const APP_ROLE = process.env['APP_DB_ROLE'] ?? 'erp_app';

describe('Migration runner', () => {
  let admin: Client;
  let schema: string;
  let dir: string;

  beforeAll(() => {
    if (!MIGRATION_URL) {
      throw new Error(
        'MIGRATION_DATABASE_URL is not set. The runner tests need a real PostgreSQL: run `npm run db:up` first.',
      );
    }
  });

  beforeEach(async () => {
    schema = `mig_test_${Date.now()}_${Math.floor(Math.random() * 100_000)}`;
    dir = await mkdtemp(path.join(tmpdir(), 'erp-migrations-'));

    admin = new Client({ connectionString: MIGRATION_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
  });

  afterEach(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  });

  const write = (filename: string, sql: string) => writeFile(path.join(dir, filename), sql, 'utf8');

  const run = (options: { dryRun?: boolean } = {}) =>
    runMigrations({
      connectionString: MIGRATION_URL!,
      migrationsDir: dir,
      appRole: APP_ROLE,
      schema,
      ...options,
    });

  const appliedVersions = async (): Promise<string[]> => {
    const result = await admin.query<{ version: string }>(
      `SELECT version FROM "${schema}".schema_migrations ORDER BY version`,
    );
    return result.rows.map((row) => row.version);
  };

  it('runs as the owning role, which is not a superuser', async () => {
    await write('0001_first.sql', 'CREATE TABLE first_table (id integer);');

    const result = await run();

    expect(result.connectedAs).not.toBe('postgres');
    const check = await admin.query<{ superuser: boolean }>(
      'SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user',
    );
    expect(check.rows[0]?.superuser).toBe(false);
  });

  it('applies a pending migration and records it', async () => {
    await write('0001_first.sql', 'CREATE TABLE first_table (id integer);');

    const result = await run();

    expect(result.applied).toEqual(['0001']);
    expect(await appliedVersions()).toEqual(['0001']);

    const table = await admin.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'first_table'`,
      [schema],
    );
    expect(table.rowCount).toBe(1);
  });

  it('records the checksum of what it applied', async () => {
    const sql = 'CREATE TABLE first_table (id integer);';
    await write('0001_first.sql', sql);

    await run();

    const stored = await admin.query<{ checksum: string }>(
      `SELECT checksum FROM "${schema}".schema_migrations WHERE version = '0001'`,
    );
    expect(stored.rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent: a second run applies nothing', async () => {
    await write('0001_first.sql', 'CREATE TABLE first_table (id integer);');

    await run();
    const second = await run();

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['0001']);
  });

  it('applies migrations in version order, not directory order', async () => {
    // 0002 depends on 0001 existing. If the runner applied them in any other order this fails.
    await write('0002_second.sql', 'ALTER TABLE first_table ADD COLUMN label text;');
    await write('0001_first.sql', 'CREATE TABLE first_table (id integer);');

    const result = await run();

    expect(result.applied).toEqual(['0001', '0002']);
  });

  it('applies only what is pending when run again with a new migration', async () => {
    await write('0001_first.sql', 'CREATE TABLE first_table (id integer);');
    await run();

    await write('0002_second.sql', 'CREATE TABLE second_table (id integer);');
    const result = await run();

    expect(result.applied).toEqual(['0002']);
    expect(await appliedVersions()).toEqual(['0001', '0002']);
  });

  it('rolls back a failing migration and records nothing', async () => {
    await write('0001_first.sql', 'CREATE TABLE first_table (id integer);');
    await run();

    // Valid first statement, invalid second. The table must not survive the rollback.
    await write(
      '0002_broken.sql',
      'CREATE TABLE should_not_survive (id integer);\nSELECT this_function_does_not_exist();',
    );

    await expect(run()).rejects.toThrow(MigrationError);

    expect(await appliedVersions()).toEqual(['0001']);
    const survivor = await admin.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'should_not_survive'`,
      [schema],
    );
    expect(survivor.rowCount).toBe(0);
  });

  it('refuses to run a migration that changed after being applied', async () => {
    await write('0001_first.sql', 'CREATE TABLE first_table (id integer);');
    await run();

    await write('0001_first.sql', 'CREATE TABLE first_table (id bigint);');

    await expect(run()).rejects.toThrow(/has changed since it was applied/);
  });

  it('refuses when an applied migration file has been removed', async () => {
    await write('0001_first.sql', 'CREATE TABLE first_table (id integer);');
    await run();

    await rm(path.join(dir, '0001_first.sql'));
    await write('0002_second.sql', 'CREATE TABLE second_table (id integer);');

    await expect(run()).rejects.toThrow(/recorded as applied but its file is missing/);
  });

  it('refuses a migration numbered below one already applied', async () => {
    await write('0002_second.sql', 'CREATE TABLE second_table (id integer);');
    await run();

    await write('0001_late.sql', 'CREATE TABLE late_table (id integer);');

    await expect(run()).rejects.toThrow(/numbered below 0002/);
  });

  it('reports pending work without applying it on a dry run', async () => {
    await write('0001_first.sql', 'CREATE TABLE first_table (id integer);');

    const result = await run({ dryRun: true });

    expect(result.applied).toEqual([]);
    const table = await admin.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'first_table'`,
      [schema],
    );
    expect(table.rowCount).toBe(0);
  });

  it('leaves no trace at all after a dry run, not even its own bookkeeping table', async () => {
    // Found by running the real command: the first version created schema_migrations before
    // checking the dry run flag, so asking what would happen changed the database.
    await write('0001_first.sql', 'CREATE TABLE first_table (id integer);');

    await run({ dryRun: true });

    const tables = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    );
    expect(tables.rows).toEqual([]);
  });

  it('still reports pending work on a database that has never been migrated', async () => {
    await write('0001_first.sql', 'CREATE TABLE first_table (id integer);');

    const result = await run({ dryRun: true });

    expect(result.alreadyApplied).toEqual([]);
    expect(result.connectedAs).toBeTruthy();
  });

  it('exposes the application role to SQL as app.provision_role', async () => {
    // This is how a migration writes its grants without hardcoding a role name that differs
    // between environments.
    await write(
      '0001_first.sql',
      `CREATE TABLE first_table (id integer);
       DO $$ BEGIN
         EXECUTE format('GRANT SELECT ON first_table TO %I', current_setting('app.provision_role'));
       END $$;`,
    );

    await run();

    const grant = await admin.query(
      `SELECT 1 FROM information_schema.role_table_grants
       WHERE table_schema = $1 AND table_name = 'first_table' AND grantee = $2 AND privilege_type = 'SELECT'`,
      [schema, APP_ROLE],
    );
    expect(grant.rowCount).toBe(1);
  });

  it('rejects a badly named migration file rather than guessing', async () => {
    await write('nope.sql', 'SELECT 1;');

    await expect(run()).rejects.toThrow(/is not valid/);
  });
});
