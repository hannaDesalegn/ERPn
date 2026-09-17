/**
 * The demo seed, run against a real database and then used the way a browser would use it.
 *
 * What is worth proving is not that rows exist. It is that the environment the README documents
 * is one the real system accepts: the documented accounts sign in, enter the documented
 * companies, see only their own master data, and can confirm an order against the opening stock,
 * with every guarantee the API already enforces still enforced. A seed that wrote rows the
 * application could not use would pass a row count and fail a demonstration.
 *
 * SHARES THE DATABASE, AND SAYS SO. Integration tests run against the local development database,
 * and this file removes the demo environment before and after it runs, because it has to create
 * it itself to test it. The README tells whoever runs the suite to reseed afterwards.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { DiscoveryModule } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppModule } from '../app.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { registerHttpPlugins } from '../http/plugins.js';
import { IdentityModule } from '../identity/identity.module.js';
import { mutating, signIn, type BrowserSession } from '../testing/browser-session.js';
import {
  DEMO_TENANTS,
  DEMO_USERS,
  demoCompanies,
  demoUser,
  OPENING_STOCK_DOC_TYPE,
  OPENING_STOCK_REASON,
} from './demo-dataset.js';
import { DemoSeedModule } from './demo-seed.module.js';
import { DemoAlreadySeededError, DemoSeedService, type DemoPlatform } from './demo-seed.service.js';

const TEST_POLICY: Record<string, unknown> = {
  ARGON2_MEMORY_KIB: 8192,
  ARGON2_TIME_COST: 2,
  ARGON2_PARALLELISM: 1,
  SESSION_IDLE_MINUTES: 60,
  SESSION_ABSOLUTE_MINUTES: 720,
  AUTH_MAX_ATTEMPTS: 90,
  AUTH_WINDOW_MINUTES: 15,
  AUTH_LOCKOUT_MINUTES: 15,
  DATABASE_URL: process.env['DATABASE_URL'],
  DATABASE_POOL_MAX: 10,
  COOKIE_SECURE: false,
};

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];
const PASSWORD = 'a demo password for the seed test';

const [DISTRIBUTION, TRADING] = DEMO_TENANTS;
const [EAST, WEST] = DISTRIBUTION!.companies;
const TRADING_COMPANY = TRADING!.companies[0]!;

let keySequence = 0;
const nextKey = () => `demo-seed-spec-${(keySequence += 1)}`;

describe('The demo seed', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let seeder: DemoSeedService;
  let platform: DemoPlatform;

  beforeAll(async () => {
    if (!MIGRATION_URL || !process.env['DATABASE_URL']) {
      throw new Error(
        'DATABASE_URL and MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate` first.',
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        DiscoveryModule,
        DatabaseModule,
        AuthModule,
        IdentityModule,
        AppModule,
        DemoSeedModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: (key: string) => TEST_POLICY[key] })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await registerHttpPlugins(app);
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();
    seeder = moduleRef.get(DemoSeedService);

    // The same two operations the entry point supplies, over the same owning connection.
    platform = {
      async existingTenantSlugs(slugs) {
        const result = await owner.query<{ slug: string }>(
          'SELECT slug FROM tenants WHERE slug = ANY($1)',
          [slugs],
        );
        return result.rows.map((row) => row.slug);
      },
      async createTenant(tenant) {
        await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)', [
          tenant.id,
          tenant.slug,
          tenant.name,
        ]);
      },
    };

    await purge();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    await seeder.seed({ platform, password: PASSWORD });
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await app.close();
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function purge(): Promise<void> {
    const userIds = DEMO_USERS.map((user) => user.id);
    await ownerContext();
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);

    for (const { tenant, company } of demoCompanies()) {
      await ownerContext(tenant.id, company.id);
      for (const table of [
        'idempotency_records',
        'stock_reservations',
        'stock_movements',
        'stock_balances',
        'customer_invoice_lines',
        'customer_invoices',
        'sales_order_lines',
        'sales_orders',
        'company_posting_accounts',
        'accounts',
        'document_number_sequences',
        'products',
        'warehouses',
        'customers',
        'membership_roles',
      ]) {
        await owner.query(`DELETE FROM ${table} WHERE company_id = $1`, [company.id]);
      }
      await owner.query(
        'DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE company_id = $1)',
        [company.id],
      );
      await owner.query('DELETE FROM memberships WHERE company_id = $1', [company.id]);
      await owner.query('DELETE FROM roles WHERE company_id = $1', [company.id]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenant.id,
        company.id,
      ]);
    }

    await ownerContext();
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM auth_throttle');
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [
      DEMO_TENANTS.map((tenant) => tenant.id),
    ]);
  }

  /** Signs in and enters a company, the two steps a browser takes before anything else. */
  async function enter(email: string, companyId: string): Promise<BrowserSession> {
    const session = await signIn(app, { email, password: PASSWORD });
    const switched = await app.inject({
      method: 'POST',
      url: '/api/me/company',
      headers: mutating(session),
      payload: { companyId },
    });
    if (switched.statusCode >= 300) {
      throw new Error(`Entering the company failed: ${switched.statusCode} ${switched.body}`);
    }
    return session;
  }

  async function get<T>(session: BrowserSession, url: string): Promise<{ status: number; body: T }> {
    const response = await app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });
    return { status: response.statusCode, body: response.json() as T };
  }

  describe('what it provisions', () => {
    it('creates both tenants, with two companies under the first', async () => {
      const tenants = await owner.query<{ slug: string }>(
        'SELECT slug FROM tenants WHERE id = ANY($1) ORDER BY slug',
        [DEMO_TENANTS.map((tenant) => tenant.id)],
      );
      expect(tenants.rows.map((row) => row.slug)).toEqual(['demo-distribution', 'demo-trading']);
      expect(DISTRIBUTION!.companies).toHaveLength(2);
    });

    it.each(demoCompanies().map(({ tenant, company }) => [company.name, tenant.id, company.id]))(
      'gives %s everything company provisioning gives a company',
      async (_name, tenantId, companyId) => {
        await ownerContext(tenantId, companyId);
        const counts = await owner.query<Record<string, string>>(
          `SELECT
             (SELECT count(*) FROM roles WHERE company_id = $1) AS roles,
             (SELECT count(*) FROM accounts WHERE company_id = $1) AS accounts,
             (SELECT count(*) FROM company_posting_accounts WHERE company_id = $1) AS postings,
             (SELECT string_agg(doc_type || ':' || next_value, ',' ORDER BY doc_type)
                FROM document_number_sequences WHERE company_id = $1) AS sequences`,
          [companyId],
        );
        await ownerContext();

        expect(counts.rows[0]).toEqual({
          roles: '6',
          accounts: '3',
          postings: '3',
          sequences: 'customer_invoice:1,sales_order:1',
        });
      },
    );

    it('gives each account exactly the memberships and roles the dataset documents', async () => {
      const expected: string[] = [];
      const actual: string[] = [];

      for (const { tenant, company } of demoCompanies()) {
        expected.push(`${company.administrator}:${company.name}:administrator`);
        for (const member of company.members) {
          expected.push(`${member.user}:${company.name}:${member.role}`);
        }

        await ownerContext(tenant.id, company.id);
        const rows = await owner.query<{ user_id: string; key: string }>(
          `SELECT m.user_id, r.key
             FROM memberships m
             JOIN membership_roles mr ON mr.membership_id = m.id
             JOIN roles r ON r.id = mr.role_id
            WHERE m.company_id = $1`,
          [company.id],
        );
        for (const row of rows.rows) {
          const user = DEMO_USERS.find((candidate) => candidate.id === row.user_id);
          actual.push(`${user?.key}:${company.name}:${row.key}`);
        }
      }
      await ownerContext();

      expect(actual.sort()).toEqual(expected.sort());
    });

    it('has the administrator assign every other role, through the audited path', async () => {
      await ownerContext(DISTRIBUTION!.id, EAST!.id);
      const events = await owner.query<{ actor_user_id: string }>(
        `SELECT actor_user_id FROM audit_events WHERE action = 'role_assigned' AND company_id = $1`,
        [EAST!.id],
      );
      await ownerContext();

      expect(events.rows).toHaveLength(EAST!.members.length);
      expect(new Set(events.rows.map((row) => row.actor_user_id))).toEqual(
        new Set([demoUser('admin').id]),
      );
    });
  });

  describe('opening stock', () => {
    it.each(demoCompanies().map(({ tenant, company }) => [company.name, tenant.id, company]))(
      'puts the documented quantities on the shelf in %s, through the ledger',
      async (_name, tenantId, company) => {
        await ownerContext(tenantId, company.id);
        const balances = await owner.query<{ product_id: string; on_hand: string; ledger: string }>(
          `SELECT b.product_id, b.on_hand::text,
                  (SELECT sum(m.quantity) FROM stock_movements m
                    WHERE m.product_id = b.product_id AND m.warehouse_id = b.warehouse_id)::text AS ledger
             FROM stock_balances b
            WHERE b.company_id = $1 AND b.warehouse_id = $2`,
          [company.id, company.warehouse.id],
        );
        const movements = await owner.query<{ reason: string; source_doc_type: string; source_doc_id: string }>(
          'SELECT reason, source_doc_type, source_doc_id FROM stock_movements WHERE company_id = $1',
          [company.id],
        );
        await ownerContext();

        const expected = Object.fromEntries(
          company.products.map((product) => [product.id, Number(product.openingStock)]),
        );
        const onHand = Object.fromEntries(
          balances.rows.map((row) => [row.product_id, Number(row.on_hand)]),
        );
        expect(onHand).toEqual(expected);
        for (const row of balances.rows) expect(row.ledger).toBe(row.on_hand);

        expect(movements.rows).toHaveLength(company.products.length);
        for (const movement of movements.rows) {
          expect(movement).toEqual({
            reason: OPENING_STOCK_REASON,
            source_doc_type: OPENING_STOCK_DOC_TYPE,
            source_doc_id: company.openingStockDocumentId,
          });
        }
      },
    );

    it('audits the load in the same transaction as the movements', async () => {
      await ownerContext(DISTRIBUTION!.id, EAST!.id);
      const audit = await owner.query<{ txid: string }>(
        `SELECT txid::text FROM audit_events WHERE action = 'opening_stock_recorded' AND company_id = $1`,
        [EAST!.id],
      );
      const movements = await owner.query<{ xmin: string }>(
        'SELECT DISTINCT xmin::text FROM stock_movements WHERE company_id = $1',
        [EAST!.id],
      );
      await ownerContext();

      expect(audit.rows).toHaveLength(1);
      expect(movements.rows.map((row) => row.xmin)).toEqual([audit.rows[0]!.txid]);
    });
  });

  describe('used the way the README says to use it', () => {
    it.each(DEMO_USERS.map((user) => [user.email, user.key]))(
      '%s signs in and is offered exactly its documented companies',
      async (email, key) => {
        const session = await signIn(app, { email, password: PASSWORD });
        const me = await get<{ companies: { id: string }[] }>(session, '/api/me');

        const documented = demoCompanies()
          .filter(
            ({ company }) =>
              company.administrator === key ||
              company.members.some((member) => member.user === key),
          )
          .map(({ company }) => company.id);

        expect(me.status).toBe(200);
        expect(me.body.companies.map((company) => company.id).sort()).toEqual(documented.sort());
      },
    );

    it('lets sales confirm an order against opening stock, and reserves it', async () => {
      const sales = await enter(demoUser('sales').email, EAST!.id);
      const paper = EAST!.products.find((product) => product.sku === 'SKU-1001')!;

      const created = await app.inject({
        method: 'POST',
        url: '/api/sales-orders',
        headers: mutating(sales, { 'idempotency-key': nextKey() }),
        payload: {
          customerId: EAST!.customers[0]!.id,
          warehouseId: EAST!.warehouse.id,
          orderDate: '2026-09-17',
          lines: [{ productId: paper.id, quantity: '12' }],
        },
      });
      expect(created.statusCode).toBe(201);

      const confirmed = await app.inject({
        method: 'POST',
        url: `/api/sales-orders/${created.json().id}/confirm`,
        headers: mutating(sales, { 'idempotency-key': nextKey() }),
      });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json()).toMatchObject({ status: 'confirmed', reservations: 1 });

      await ownerContext(DISTRIBUTION!.id, EAST!.id);
      const reserved = await owner.query<{ reserved: string }>(
        `SELECT coalesce(sum(quantity), 0)::text AS reserved FROM stock_reservations
          WHERE product_id = $1 AND released_at IS NULL`,
        [paper.id],
      );
      await ownerContext();
      expect(Number(reserved.rows[0]!.reserved)).toBe(12);
    });

    it('refuses to oversell the product stocked short on purpose', async () => {
      const sales = await enter(demoUser('sales').email, EAST!.id);
      const short = EAST!.products.find((product) => product.sku === 'SKU-1004')!;

      const created = await app.inject({
        method: 'POST',
        url: '/api/sales-orders',
        headers: mutating(sales, { 'idempotency-key': nextKey() }),
        payload: {
          customerId: EAST!.customers[0]!.id,
          warehouseId: EAST!.warehouse.id,
          orderDate: '2026-09-17',
          lines: [{ productId: short.id, quantity: String(Number(short.openingStock) + 1) }],
        },
      });
      const confirmed = await app.inject({
        method: 'POST',
        url: `/api/sales-orders/${created.json().id}/confirm`,
        headers: mutating(sales, { 'idempotency-key': nextKey() }),
      });

      expect(confirmed.statusCode).toBe(422);
    });

    it('shows each company its own records under colliding codes', async () => {
      const inWest = await enter(demoUser('sales').email, WEST!.id);
      const inTrading = await enter(demoUser('trading-admin').email, TRADING_COMPANY.id);

      const west = await get<{ id: string; sku: string }[]>(inWest, '/api/products');
      const trading = await get<{ id: string; sku: string }[]>(inTrading, '/api/products');

      expect(west.body.map((product) => product.id).sort()).toEqual(
        WEST!.products.map((product) => product.id).sort(),
      );
      expect(trading.body.map((product) => product.id)).toEqual([
        TRADING_COMPANY.products[0]!.id,
      ]);
      // Same code, three companies, three different records.
      expect(trading.body[0]!.sku).toBe('SKU-1001');
      expect(west.body.some((product) => product.sku === 'SKU-1001')).toBe(true);
    });

    it('refuses to let an account enter a company it was not made a member of', async () => {
      const accountant = await signIn(app, {
        email: demoUser('accountant').email,
        password: PASSWORD,
      });
      const trading = await signIn(app, {
        email: demoUser('trading-admin').email,
        password: PASSWORD,
      });

      for (const [session, companyId] of [
        [accountant, WEST!.id],
        [trading, EAST!.id],
      ] as const) {
        const switched = await app.inject({
          method: 'POST',
          url: '/api/me/company',
          headers: mutating(session),
          payload: { companyId },
        });
        expect(switched.statusCode).toBeGreaterThanOrEqual(400);
      }
    });
  });

  describe('run twice', () => {
    it('refuses, and writes nothing', async () => {
      const count = async () =>
        (
          await owner.query<{ tenants: string; users: string; audit: string }>(
            `SELECT (SELECT count(*) FROM tenants) AS tenants,
                    (SELECT count(*) FROM users) AS users,
                    (SELECT count(*) FROM audit_events) AS audit`,
          )
        ).rows[0];

      await ownerContext();
      const before = await count();

      await expect(seeder.seed({ platform, password: PASSWORD })).rejects.toBeInstanceOf(
        DemoAlreadySeededError,
      );

      expect(await count()).toEqual(before);
    });
  });
});
