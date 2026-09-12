/**
 * Closing the retention window of section 11, against a real PostgreSQL.
 *
 * Two things here are worth a real database rather than a mock. The boundary, because whether a
 * record exactly at its expiry is inside or outside the window is decided by a policy in
 * migration 0011 and not by the predicate the repository happens to carry. And the restriction
 * itself, because the claim being made is that the application role cannot delete a live record
 * even when it tries, which is a statement about grants and policies and nothing else.
 *
 * The seed puts records in three companies across two tenants, expired and live in each, so a
 * sweep that reached too far shows up as somebody else's row disappearing.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, UnitOfWork } from '../database/index.js';
import { IdempotencyExpiryService } from './idempotency-expiry.service.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'a5100000-0000-4000-8000-00000000000a';
const TENANT_B = 'a5200000-0000-4000-8000-00000000000b';

const COMPANY_A1 = 'a5300000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "swept one, kept the other" is representable. */
const COMPANY_A2 = 'a5400000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'a5500000-0000-4000-8000-00000000000c';

const OWNER_USER = 'a5600000-0000-4000-8000-00000000000a';
/** A second person, because section 11 makes the user part of a record's identity. */
const OTHER_USER = 'a5700000-0000-4000-8000-00000000000b';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const HOUR = 60 * 60 * 1000;

let sequence = 0;
const nextId = () =>
  `a6${(sequence += 1).toString().padStart(6, '0')}-0000-4000-8000-00000000000a`;

describe('Expiring idempotency records', () => {
  let expiry: IdempotencyExpiryService;
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
      providers: [IdempotencyExpiryService],
    }).compile();
    await moduleRef.init();

    expiry = moduleRef.get(IdempotencyExpiryService);
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

  beforeEach(async () => {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM idempotency_records WHERE company_id = $1', [companyId]);
    }
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'expiry-a',
      'Expiry A',
      TENANT_B,
      'expiry-b',
      'Expiry B',
    ]);
    await owner.query(
      'INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4), ($5,$6,$7,$4)',
      [
        OWNER_USER,
        'owner@expiry.test',
        'Owner',
        'not-a-real-hash',
        OTHER_USER,
        'other@expiry.test',
        'Other',
      ],
    );

    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query(
        'INSERT INTO companies (id, tenant_id, name, base_currency) VALUES ($1,$2,$3,$4)',
        [companyId, tenantId, `Company ${companyId.slice(0, 4)}`, 'USD'],
      );
    }
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM idempotency_records WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[OWNER_USER, OTHER_USER]]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  /** A record placed at an exact moment, so a boundary can be aimed at rather than approached. */
  async function record(
    tenantId: string,
    companyId: string,
    expiresAt: Date,
    options: { userId?: string; key?: string } = {},
  ): Promise<string> {
    const id = nextId();
    await ownerContext(tenantId, companyId);
    await owner.query(
      `INSERT INTO idempotency_records
         (id, tenant_id, company_id, user_id, endpoint, idempotency_key, request_fingerprint,
          response_status, response_body, expires_at)
       VALUES ($1,$2,$3,$4,'POST sales-orders/:id/confirm',$5,'fingerprint',200,'{"ok":true}'::jsonb,$6)`,
      [id, tenantId, companyId, options.userId ?? OWNER_USER, options.key ?? id, expiresAt],
    );
    return id;
  }

  const survivorsIn = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{ id: string }>(
      'SELECT id FROM idempotency_records ORDER BY expires_at',
    );
    return rows.rows.map((row) => row.id);
  };

  // -------------------------------------------------------------------------------------
  // 1, 2 and 3. What goes and what stays.
  // -------------------------------------------------------------------------------------

  describe('the sweep', () => {
    it('removes a record whose window has closed', async () => {
      const stale = await record(TENANT_A, COMPANY_A1, new Date(Date.now() - HOUR));

      const result = await expiry.sweep();

      expect(result.recordsRemoved).toBe(1);
      expect(await survivorsIn(TENANT_A, COMPANY_A1)).not.toContain(stale);
    });

    it('keeps a record whose window is still open', async () => {
      const live = await record(TENANT_A, COMPANY_A1, new Date(Date.now() + HOUR));

      const result = await expiry.sweep();

      expect(result.recordsRemoved).toBe(0);
      expect(await survivorsIn(TENANT_A, COMPANY_A1)).toEqual([live]);
    });

    it('removes a record exactly at its expiry, which is the moment it is gone', async () => {
      // Section 11 does not say whether the boundary is inclusive. The codebase does:
      // `session-policy.ts` treats a session as expired when now is at or past its expiry, and
      // migration 0011 writes that same rule into the policy.
      const cutoff = new Date();
      const atTheBoundary = await record(TENANT_A, COMPANY_A1, cutoff);

      await expiry.sweep(cutoff);

      expect(await survivorsIn(TENANT_A, COMPANY_A1)).not.toContain(atTheBoundary);
    });

    it('keeps a record one millisecond the other side of the boundary', async () => {
      const cutoff = new Date();
      const justAfter = await record(TENANT_A, COMPANY_A1, new Date(cutoff.getTime() + 1));

      await expiry.sweep(cutoff);

      expect(await survivorsIn(TENANT_A, COMPANY_A1)).toEqual([justAfter]);
    });

    it('separates the expired from the live in one pass', async () => {
      const stale = await record(TENANT_A, COMPANY_A1, new Date(Date.now() - HOUR));
      const live = await record(TENANT_A, COMPANY_A1, new Date(Date.now() + HOUR));

      const result = await expiry.sweep();

      expect(result.recordsRemoved).toBe(1);
      expect(await survivorsIn(TENANT_A, COMPANY_A1)).toEqual([live]);
      expect(stale).not.toBe(live);
    });
  });

  // -------------------------------------------------------------------------------------
  // 4 and 5. Running it when there is nothing to do.
  // -------------------------------------------------------------------------------------

  describe('running it again', () => {
    it('is safe on a second pass, which removes nothing', async () => {
      await record(TENANT_A, COMPANY_A1, new Date(Date.now() - HOUR));

      const first = await expiry.sweep();
      const second = await expiry.sweep();

      expect(first.recordsRemoved).toBe(1);
      expect(second.recordsRemoved).toBe(0);
    });

    it('succeeds against a database with no records at all', async () => {
      const result = await expiry.sweep();

      expect(result.recordsRemoved).toBe(0);
      // It still walked the companies, so an empty result means nothing to do rather than
      // nothing looked at.
      expect(result.companiesVisited).toBeGreaterThanOrEqual(SCOPES.length);
    });

    it('reports the instant every company was compared against', async () => {
      const cutoff = new Date(Date.now() - HOUR);

      const result = await expiry.sweep(cutoff);

      expect(result.cutoff).toBe(cutoff);
    });
  });

  // -------------------------------------------------------------------------------------
  // 6 and 7. Reach.
  // -------------------------------------------------------------------------------------

  describe('what it reaches', () => {
    it('clears expired records in every company and tenant', async () => {
      for (const [tenantId, companyId] of SCOPES) {
        await record(tenantId, companyId, new Date(Date.now() - HOUR));
      }

      const result = await expiry.sweep();

      expect(result.recordsRemoved).toBe(3);
      for (const [tenantId, companyId] of SCOPES) {
        expect(await survivorsIn(tenantId, companyId)).toEqual([]);
      }
    });

    it('leaves a sibling company\'s live records alone while clearing another\'s', async () => {
      await record(TENANT_A, COMPANY_A1, new Date(Date.now() - HOUR));
      const theirs = await record(TENANT_A, COMPANY_A2, new Date(Date.now() + HOUR));

      await expiry.sweep();

      expect(await survivorsIn(TENANT_A, COMPANY_A1)).toEqual([]);
      expect(await survivorsIn(TENANT_A, COMPANY_A2)).toEqual([theirs]);
    });

    it('clears expired records belonging to different users alike', async () => {
      // The user is part of a record's identity, per section 11, but not of its lifecycle. An
      // expired record is expired whoever made it.
      await record(TENANT_A, COMPANY_A1, new Date(Date.now() - HOUR), { userId: OWNER_USER });
      await record(TENANT_A, COMPANY_A1, new Date(Date.now() - HOUR), { userId: OTHER_USER });

      const result = await expiry.sweep();

      expect(result.recordsRemoved).toBe(2);
      expect(await survivorsIn(TENANT_A, COMPANY_A1)).toEqual([]);
    });

    it('touches no other table', async () => {
      await record(TENANT_A, COMPANY_A1, new Date(Date.now() - HOUR));

      await ownerContext();
      const before = await owner.query<{ tenants: string; users: string; companies: string }>(
        `SELECT (SELECT count(*) FROM tenants)::text AS tenants,
                (SELECT count(*) FROM users)::text AS users,
                (SELECT count(*) FROM companies)::text AS companies`,
      );

      await expiry.sweep();

      await ownerContext();
      const after = await owner.query(
        `SELECT (SELECT count(*) FROM tenants)::text AS tenants,
                (SELECT count(*) FROM users)::text AS users,
                (SELECT count(*) FROM companies)::text AS companies`,
      );

      expect(after.rows[0]).toEqual(before.rows[0]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 8 and 9. The database is what enforces the rule.
  // -------------------------------------------------------------------------------------

  describe('the restriction', () => {
    it('refuses to delete a live record even when asked directly', async () => {
      // The claim the restrictive policy in migration 0011 makes. The predicate in the
      // repository is not the control; this is, and it holds against a statement written to
      // ignore it.
      const live = await record(TENANT_A, COMPANY_A1, new Date(Date.now() + HOUR));

      const app = new Client({ connectionString: process.env['DATABASE_URL'] });
      await app.connect();
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT_A]);
        await app.query(`SELECT set_config('app.company_id', $1, false)`, [COMPANY_A1]);

        const removed = await app.query('DELETE FROM idempotency_records WHERE id = $1', [live]);

        // Not an error: a restrictive policy filters the rows a statement can see rather than
        // refusing the statement. Nothing matched, so nothing went.
        expect(removed.rowCount).toBe(0);
      } finally {
        await app.end();
      }

      expect(await survivorsIn(TENANT_A, COMPANY_A1)).toEqual([live]);
    });

    it('refuses a sweep that names a future cutoff', async () => {
      // A caller passing tomorrow cannot clear today's live records, because the database applies
      // its own clock through the policy as well as the caller's through the predicate.
      const live = await record(TENANT_A, COMPANY_A1, new Date(Date.now() + HOUR));

      const result = await expiry.sweep(new Date(Date.now() + 48 * HOUR));

      expect(result.recordsRemoved).toBe(0);
      expect(await survivorsIn(TENANT_A, COMPANY_A1)).toEqual([live]);
    });

    it('reads the expiry column rather than the age of the row', async () => {
      // A record created long ago with a window still open must survive, and one created a
      // moment ago with a window already closed must not. Anything keying off `created_at` would
      // get both backwards.
      await ownerContext(TENANT_A, COMPANY_A1);
      const oldButLive = await record(TENANT_A, COMPANY_A1, new Date(Date.now() + HOUR));
      await owner.query(
        `UPDATE idempotency_records SET created_at = now() - interval '30 days' WHERE id = $1`,
        [oldButLive],
      );
      const newButExpired = await record(TENANT_A, COMPANY_A1, new Date(Date.now() - 1));

      const result = await expiry.sweep();

      expect(result.recordsRemoved).toBe(1);
      expect(await survivorsIn(TENANT_A, COMPANY_A1)).toEqual([oldButLive]);
      expect(newButExpired).not.toBe(oldButLive);
    });
  });

  // -------------------------------------------------------------------------------------
  // Concurrency.
  // -------------------------------------------------------------------------------------

  describe('running alongside other work', () => {
    it('is safe when two sweeps run at once', async () => {
      for (const [tenantId, companyId] of SCOPES) {
        await record(tenantId, companyId, new Date(Date.now() - HOUR));
      }

      // Whichever reaches a row first removes it; the other's delete matches nothing. Neither
      // fails, and between them they remove each row exactly once.
      const [first, second] = await Promise.all([expiry.sweep(), expiry.sweep()]);

      expect(first.recordsRemoved + second.recordsRemoved).toBe(3);
      for (const [tenantId, companyId] of SCOPES) {
        expect(await survivorsIn(tenantId, companyId)).toEqual([]);
      }
    });

    it('does not remove a record claimed while it was running', async () => {
      // A live record written during the sweep is not expired, so nothing about the timing can
      // make it a candidate. The sweep is not holding a lock that would block it either.
      await record(TENANT_A, COMPANY_A1, new Date(Date.now() - HOUR));

      const fresh = nextId();
      const [, result] = await Promise.all([
        uow.inActorScope(
          actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: OWNER_USER }),
          (repos) =>
            repos.idempotency.claim({
              id: fresh,
              endpoint: 'POST sales-orders/:id/confirm',
              key: 'claimed-during-the-sweep',
              fingerprint: 'fingerprint',
              expiresAt: new Date(Date.now() + HOUR),
            }),
        ),
        expiry.sweep(),
      ]);

      expect(result.recordsRemoved).toBe(1);
      expect(await survivorsIn(TENANT_A, COMPANY_A1)).toEqual([fresh]);
    });
  });
});
