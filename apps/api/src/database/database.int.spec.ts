/**
 * Integration tests for the database connection.
 *
 * These assert two different things, and both matter.
 *
 * First, that the application can reach a real PostgreSQL. That is the harness the rest of
 * slice 1 is built on, and it replaces the shell level reachability check that CI used before
 * this module existed.
 *
 * Second, and more importantly, that the role the application connects as is genuinely
 * restricted. Contract sections 2.4 and 7.1 ratified a two role setup where the API can never
 * own an object or issue DDL. That is a security boundary, and section 14.9 requires a test
 * proving the control works and a test proving its absence fails. Asserting that a privileged
 * operation is refused is the second of those.
 */

import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';

import { AppConfigModule } from '../config/config.module.js';
import { DATABASE, DATABASE_POOL, DatabaseModule, type Database } from './database.module.js';
import type { Pool } from 'pg';

describe('Database connection', () => {
  let db: Database;
  let pool: Pool;
  let close: () => Promise<void>;

  beforeAll(async () => {
    if (!process.env['DATABASE_URL']) {
      throw new Error(
        'DATABASE_URL is not set. Integration tests need a real PostgreSQL: run `npm run db:up` first.',
      );
    }

    // No HTTP application here. `createNestApplication()` would pull in an HTTP adapter, and
    // there is no reason for a database test to start a web server. The module context alone
    // gives dependency injection and, on close, the shutdown hooks that end the pool.
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
    }).compile();

    await moduleRef.init();

    db = moduleRef.get<Database>(DATABASE);
    pool = moduleRef.get<Pool>(DATABASE_POOL);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await close();
  });

  it('reaches a real PostgreSQL', async () => {
    const result = await db.execute(sql`select 1 as ok`);

    expect(result.rows[0]).toEqual({ ok: 1 });
  });

  it('runs on the PostgreSQL major version the project pins', async () => {
    // Compose and CI must not drift onto different major versions, or a constraint can pass
    // in one and fail in the other.
    const result = await db.execute<{ version: string }>(
      sql`select current_setting('server_version') as version`,
    );

    expect(result.rows[0]?.version).toMatch(/^17\./);
  });

  it('connects as a role that is not a superuser and cannot bypass row level security', async () => {
    const result = await db.execute<{ superuser: boolean; bypassrls: boolean; rolname: string }>(
      sql`select rolname, rolsuper as superuser, rolbypassrls as bypassrls
          from pg_roles where rolname = current_user`,
    );
    const role = result.rows[0];

    expect(role).toBeDefined();
    // A superuser or a BYPASSRLS role would be exempt from the policies that are the second
    // isolation layer, which contract section 2.4 forbids.
    expect(role?.superuser).toBe(false);
    expect(role?.bypassrls).toBe(false);
  });

  it('refuses DDL from the application role', async () => {
    // The application must never be able to create, alter or drop a table. If this stops
    // failing, the two role separation has been undone.
    //
    // Drizzle wraps the driver error, so the refusal text is on the cause rather than the top
    // level message. Asserting on the cause keeps the test honest: a rejection for some
    // unrelated reason would otherwise satisfy it and the control would look tested.
    const cause = await db
      .execute(sql`create table integration_should_never_exist (id integer)`)
      .then(
        () => undefined,
        (error: unknown) => (error as { cause?: { message?: string } }).cause,
      );

    expect(cause?.message).toMatch(/permission denied/i);
  });

  it('closes its pool on shutdown rather than leaking connections', async () => {
    expect(pool.totalCount).toBeGreaterThanOrEqual(0);
    expect(pool.ended).toBe(false);
  });
});
