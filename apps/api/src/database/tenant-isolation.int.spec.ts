/**
 * Tenant isolation, verified through the application role. Criterion 31, and the negative
 * requirements in contract section 2.10.
 *
 * Every assertion here runs as `erp_app`, and the first test proves that. This matters more
 * than it looks: an earlier round of these checks was written against the provisioning
 * superuser and reported that cross-tenant inserts succeeded. A superuser bypasses row level
 * security entirely, so that suite could not have failed no matter how broken the policies
 * were. Contract section 7.1 now forbids a superuser for exactly this reason, and the check
 * below keeps the guarantee visible in the test output.
 *
 * Seed data is created by the owning role, asserted against, and removed afterwards, so the
 * development database is left holding schema and nothing else.
 */

import { Client } from 'pg';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];
const APP_URL = process.env['DATABASE_URL'];

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const COMPANY_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const COMPANY_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const USER_ID = '99999999-9999-9999-9999-99999999999a';

describe('Tenant isolation', () => {
  let owner: Client;
  let app: Client;

  beforeAll(async () => {
    if (!MIGRATION_URL || !APP_URL) {
      throw new Error(
        'MIGRATION_DATABASE_URL and DATABASE_URL must both be set. Run `npm run db:up` and `npm run db:migrate` first.',
      );
    }

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();

    // The owning role is subject to its own policies, so seeding sets the context explicitly.
    // That is the behaviour a superuser owner would have hidden.
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3), ($4, $5, $6)', [
      TENANT_A, 'isolation-a', 'Isolation A',
      TENANT_B, 'isolation-b', 'Isolation B',
    ]);
    await owner.query(
      'INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
      [USER_ID, 'isolation@example.test', 'Isolation User', 'not-a-real-hash'],
    );

    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
    await owner.query(
      'INSERT INTO companies (id, tenant_id, name, base_currency) VALUES ($1, $2, $3, $4)',
      [COMPANY_A, TENANT_A, 'Company A', 'USD'],
    );
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [COMPANY_A]);
    await owner.query(
      'INSERT INTO memberships (id, tenant_id, company_id, user_id) VALUES ($1, $2, $3, $4)',
      ['dddddddd-0000-0000-0000-00000000000d', TENANT_A, COMPANY_A, USER_ID],
    );

    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_B]);
    await owner.query(
      'INSERT INTO companies (id, tenant_id, name, base_currency) VALUES ($1, $2, $3, $4)',
      [COMPANY_B, TENANT_B, 'Company B', 'EUR'],
    );

    app = new Client({ connectionString: APP_URL });
    await app.connect();
  });

  afterAll(async () => {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [COMPANY_A]);
    await owner.query('DELETE FROM memberships WHERE user_id = $1', [USER_ID]);
    await owner.query('DELETE FROM companies WHERE id = $1', [COMPANY_A]);
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_B]);
    await owner.query('DELETE FROM companies WHERE id = $1', [COMPANY_B]);
    await owner.query('DELETE FROM users WHERE id = $1', [USER_ID]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);

    await app.end();
    await owner.end();
  });

  const asTenant = async (tenantId: string | null) => {
    await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
  };

  it('runs as the application role, which is not a superuser', async () => {
    const result = await app.query<{ user: string; superuser: boolean }>(
      `SELECT current_user AS user,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
    );

    expect(result.rows[0]?.superuser).toBe(false);
  });

  it('returns zero rows when no tenant context is set, rather than every row', async () => {
    // Criterion 31, and the failure direction that matters. A policy that fails open here
    // would leak every customer's data at once.
    await asTenant(null);

    const result = await app.query<{ count: string }>('SELECT count(*) FROM companies');

    expect(result.rows[0]?.count).toBe('0');
  });

  it('shows a tenant only its own companies', async () => {
    await asTenant(TENANT_A);
    const a = await app.query<{ name: string }>('SELECT name FROM companies');
    expect(a.rows.map((r) => r.name)).toEqual(['Company A']);

    await asTenant(TENANT_B);
    const b = await app.query<{ name: string }>('SELECT name FROM companies');
    expect(b.rows.map((r) => r.name)).toEqual(['Company B']);
  });

  it('makes another tenant record indistinguishable from one that does not exist', async () => {
    // Contract section 6.1: a failure at the tenant dimension returns the same response as a
    // genuine miss, so identifiers cannot be probed to learn what other companies hold.
    await asTenant(TENANT_B);

    const foreign = await app.query('SELECT 1 FROM companies WHERE id = $1', [COMPANY_A]);
    const absent = await app.query('SELECT 1 FROM companies WHERE id = $1', [
      '00000000-0000-0000-0000-000000000000',
    ]);

    expect(foreign.rowCount).toBe(absent.rowCount);
    expect(foreign.rowCount).toBe(0);
  });

  it('hides another tenant memberships', async () => {
    await asTenant(TENANT_B);

    const result = await app.query<{ count: string }>('SELECT count(*) FROM memberships');

    expect(result.rows[0]?.count).toBe('0');
  });

  it('refuses to write a row belonging to another tenant', async () => {
    await asTenant(TENANT_B);

    await expect(
      app.query('INSERT INTO companies (id, tenant_id, name, base_currency) VALUES ($1, $2, $3, $4)', [
        'cccccccc-0000-0000-0000-00000000000c', TENANT_A, 'Forged', 'USD',
      ]),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('refuses UPDATE and DELETE on the audit log', async () => {
    await asTenant(TENANT_A);

    await expect(app.query('UPDATE audit_events SET summary = $1', ['tampered'])).rejects.toThrow(
      /permission denied/i,
    );
    await expect(app.query('DELETE FROM audit_events')).rejects.toThrow(/permission denied/i);
  });

  it('refuses DDL from the application role', async () => {
    await expect(app.query('CREATE TABLE isolation_should_not_exist (id integer)')).rejects.toThrow(
      /permission denied/i,
    );
  });
});
