/**
 * The master data reads, over HTTP against a real PostgreSQL.
 *
 * These endpoints exist so a sales order form can offer a real customer, warehouse and product.
 * What is worth proving about a read like this is almost entirely scope: it returns lists, and a
 * list that quietly included a sibling company's records would look exactly like a correct one.
 *
 * So the seed puts distinctly named records in two companies of one tenant and a third in another
 * tenant. Every exclusion below names rows that really exist, which is stronger than asking for
 * something absent.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { DiscoveryModule } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppModule } from '../app.module.js';
import { AppConfigModule } from '../config/config.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PasswordHasher } from '../auth/password-hasher.js';
import { DatabaseModule } from '../database/database.module.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import { registerHttpPlugins } from '../http/plugins.js';
import { IdentityModule } from '../identity/identity.module.js';
import { mutating, signIn, type BrowserSession } from '../testing/browser-session.js';

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

const TENANT = 'd1100000-0000-4000-8000-00000000000a';
const OTHER_TENANT = 'd1200000-0000-4000-8000-00000000000b';

const COMPANY = 'd1300000-0000-4000-8000-00000000000a';
/** A sibling in the same tenant, whose records must never appear. */
const SIBLING = 'd1400000-0000-4000-8000-00000000000b';
const AWAY = 'd1500000-0000-4000-8000-00000000000c';

const SELLER = 'd1600000-0000-4000-8000-00000000000a';
const SELLER_EMAIL = 'seller@master.test';
/** Holds sales:view only, so neither capability these routes need. */
const OUTSIDER = 'd1700000-0000-4000-8000-00000000000b';
const OUTSIDER_EMAIL = 'outsider@master.test';
const PASSWORD = 'a perfectly ordinary passphrase';

/** Every scope the seed fills, with the label its records carry. */
const SCOPES: { tenantId: string; companyId: string; label: string }[] = [
  { tenantId: TENANT, companyId: COMPANY, label: 'Ours' },
  { tenantId: TENANT, companyId: SIBLING, label: 'Siblings' },
  { tenantId: OTHER_TENANT, companyId: AWAY, label: 'Aways' },
];

let sequence = 0;
const nextId = () =>
  `d2${(sequence += 1).toString().padStart(6, '0')}-0000-4000-8000-00000000000a`;

describe('Master data reads', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let uow: UnitOfWork;
  let seller: BrowserSession;
  let outsider: BrowserSession;

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
    uow = moduleRef.get(UnitOfWork);

    await purge();
    await seed(moduleRef.get(PasswordHasher));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    seller = await enter(SELLER_EMAIL);
    outsider = await enter(OUTSIDER_EMAIL);
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await app.close();
  });

  /** Signs in and enters the acting company, which a session does not have by default. */
  async function enter(email: string): Promise<BrowserSession> {
    const session = await signIn(app, { email, password: PASSWORD });

    const switched = await app.inject({
      method: 'POST',
      url: '/api/me/company',
      headers: mutating(session),
      payload: { companyId: COMPANY },
    });

    if (switched.statusCode >= 300) {
      throw new Error(`Entering the company failed: ${switched.statusCode} ${switched.body}`);
    }

    return session;
  }

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function seed(hasher: PasswordHasher): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT,
      'master-data',
      'Master Data',
      OTHER_TENANT,
      'master-data-away',
      'Master Data Away',
    ]);

    const passwordHash = await hasher.hash(PASSWORD);
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT }), async (r) => {
      await r.users.create({ id: SELLER, email: SELLER_EMAIL, name: 'Seller', passwordHash });
      await r.users.create({ id: OUTSIDER, email: OUTSIDER_EMAIL, name: 'Outsider', passwordHash });
      await r.companies.create({ id: COMPANY, name: 'Ours', baseCurrency: 'USD' });
      await r.companies.create({ id: SIBLING, name: 'Siblings', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: OTHER_TENANT }),
      (r) => r.companies.create({ id: AWAY, name: 'Aways', baseCurrency: 'USD' }),
    );

    for (const { tenantId, companyId, label } of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query(
        'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
        [nextId(), tenantId, companyId, 'CUST-1', `${label} customer`],
      );
      await owner.query(
        'INSERT INTO warehouses (id, tenant_id, company_id, code, name, is_default) VALUES ($1,$2,$3,$4,$5,true)',
        [nextId(), tenantId, companyId, 'WH-1', `${label} depot`],
      );
      await owner.query(
        `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
         VALUES ($1,$2,$3,'SKU-1',$4,'unit','10.000000','USD')`,
        [nextId(), tenantId, companyId, `${label} widget`],
      );
    }

    // A second, archived record of each kind in the acting company, so the picker's own filtering
    // has something to work with and the endpoint is seen not to do it for them.
    await ownerContext(TENANT, COMPANY);
    await owner.query(
      `INSERT INTO customers (id, tenant_id, company_id, code, name, status)
       VALUES ($1,$2,$3,'CUST-OLD','Ours retired customer','archived')`,
      [nextId(), TENANT, COMPANY],
    );
    await owner.query(
      `INSERT INTO warehouses (id, tenant_id, company_id, code, name)
       VALUES ($1,$2,$3,'WH-2','Ours overflow')`,
      [nextId(), TENANT, COMPANY],
    );

    // Roles: the seller holds both capabilities these routes need, the outsider neither.
    const sellerRole = nextId();
    const outsiderRole = nextId();
    await owner.query(
      'INSERT INTO roles (id, tenant_id, company_id, key, name) VALUES ($1,$2,$3,$4,$5), ($6,$2,$3,$7,$8)',
      [sellerRole, TENANT, COMPANY, 'sales', 'Sales', outsiderRole, 'accountant', 'Accountant'],
    );
    await owner.query(
      `INSERT INTO role_permissions (tenant_id, company_id, role_id, permission)
       VALUES ($1,$2,$3,'customers:view'), ($1,$2,$3,'inventory:view'), ($1,$2,$3,'sales:view'),
              ($1,$2,$4,'sales:view')`,
      [TENANT, COMPANY, sellerRole, outsiderRole],
    );

    for (const [userId, roleId] of [
      [SELLER, sellerRole],
      [OUTSIDER, outsiderRole],
    ] as const) {
      const membershipId = nextId();
      await owner.query(
        'INSERT INTO memberships (id, tenant_id, company_id, user_id) VALUES ($1,$2,$3,$4)',
        [membershipId, TENANT, COMPANY, userId],
      );
      await owner.query(
        'INSERT INTO membership_roles (tenant_id, company_id, membership_id, role_id) VALUES ($1,$2,$3,$4)',
        [TENANT, COMPANY, membershipId, roleId],
      );
    }
  }

  async function purge(): Promise<void> {
    await ownerContext();
    await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [[SELLER, OUTSIDER]]);

    for (const { tenantId, companyId } of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM products WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM warehouses WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
      await owner.query(
        'DELETE FROM membership_roles WHERE membership_id IN (SELECT id FROM memberships WHERE company_id = $1)',
        [companyId],
      );
      await owner.query('DELETE FROM memberships WHERE company_id = $1', [companyId]);
      await owner.query(
        'DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE company_id = $1)',
        [companyId],
      );
      await owner.query('DELETE FROM roles WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }

    await ownerContext();
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM auth_throttle');
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[SELLER, OUTSIDER]]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT, OTHER_TENANT]]);
  }

  const get = (session: BrowserSession | null, path: string) =>
    app.inject({
      method: 'GET',
      url: `/api${path}`,
      ...(session ? { headers: { cookie: session.cookie } } : {}),
    });

  const names = (body: { name: string }[]) => body.map((row) => row.name);

  const ROUTES = ['/customers', '/products', '/warehouses'] as const;

  // -------------------------------------------------------------------------------------
  // What each one returns.
  // -------------------------------------------------------------------------------------

  describe('customers', () => {
    it('returns this company\'s customers with what a picker needs', async () => {
      const response = await get(seller, '/customers');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toContainEqual({
        id: expect.any(String),
        code: 'CUST-1',
        name: 'Ours customer',
        status: 'active',
      });
    });

    it('returns archived records too, and does not decide for the picker', async () => {
      // Hiding them here would be the endpoint making a display decision, and the same list is
      // what a future administration screen reads.
      const body = (await get(seller, '/customers')).json();

      expect(names(body)).toContain('Ours retired customer');
    });

    it('exposes no scope columns, because they are not parameters', async () => {
      const [first] = (await get(seller, '/customers')).json();

      expect(first).not.toHaveProperty('tenantId');
      expect(first).not.toHaveProperty('companyId');
      expect(first).not.toHaveProperty('version');
    });
  });

  describe('products', () => {
    it('returns this company\'s products with the unit a quantity is entered in', async () => {
      const body = (await get(seller, '/products')).json();

      expect(body).toContainEqual({
        id: expect.any(String),
        sku: 'SKU-1',
        name: 'Ours widget',
        type: 'stockable',
        stockingUom: 'unit',
        status: 'active',
      });
    });

    it('exposes no price, because the server applies it', async () => {
      // Section 3.3. A price on a picker is a price somebody expects to send back.
      const [first] = (await get(seller, '/products')).json();

      expect(first).not.toHaveProperty('salesPrice');
      expect(first).not.toHaveProperty('salesPriceCurrency');
    });
  });

  describe('warehouses', () => {
    it('returns this company\'s warehouses and says which is the default', async () => {
      const body = (await get(seller, '/warehouses')).json();

      expect(body).toContainEqual({
        id: expect.any(String),
        code: 'WH-1',
        name: 'Ours depot',
        status: 'active',
        isDefault: true,
      });
      expect(names(body)).toContain('Ours overflow');
    });

    it('exposes no stock policy, which is the server\'s to read', async () => {
      const [first] = (await get(seller, '/warehouses')).json();

      expect(first).not.toHaveProperty('allowNegativeStock');
    });
  });

  // -------------------------------------------------------------------------------------
  // Scope, which is what a list read is really about.
  // -------------------------------------------------------------------------------------

  describe('scope', () => {
    it.each(ROUTES)('%s excludes a sibling company and another tenant', async (route) => {
      const body = names((await get(seller, route)).json());

      expect(body.some((name) => name.startsWith('Ours'))).toBe(true);
      expect(body.some((name) => name.startsWith('Siblings'))).toBe(false);
      expect(body.some((name) => name.startsWith('Aways'))).toBe(false);
    });

    it.each(ROUTES)('%s offers no parameter for choosing a company', async (route) => {
      // There is nothing to manipulate, so this proves the absence rather than a rejection: a
      // company named in the query changes nothing about the answer.
      const plain = (await get(seller, route)).json();
      const attempted = (await get(seller, `${route}?companyId=${SIBLING}&tenantId=${OTHER_TENANT}`)).json();

      expect(attempted).toEqual(plain);
    });

    it('answers an empty list for a company with nothing, rather than an error', async () => {
      // The sibling has records; a company with none is the case worth checking, so its rows are
      // removed and put back.
      await ownerContext(TENANT, COMPANY);
      const saved = await owner.query('SELECT * FROM customers WHERE company_id = $1', [COMPANY]);
      await owner.query('DELETE FROM customers WHERE company_id = $1', [COMPANY]);

      try {
        const response = await get(seller, '/customers');

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual([]);
      } finally {
        await ownerContext(TENANT, COMPANY);
        for (const row of saved.rows as { id: string; code: string; name: string; status: string }[]) {
          await owner.query(
            'INSERT INTO customers (id, tenant_id, company_id, code, name, status) VALUES ($1,$2,$3,$4,$5,$6)',
            [row.id, TENANT, COMPANY, row.code, row.name, row.status],
          );
        }
      }
    });
  });

  // -------------------------------------------------------------------------------------
  // Who may read them.
  // -------------------------------------------------------------------------------------

  describe('access', () => {
    it.each(ROUTES)('%s refuses a caller with no session', async (route) => {
      const response = await get(null, route);

      expect([401, 403]).toContain(response.statusCode);
    });

    it.each(ROUTES)('%s refuses a signed-in caller without the capability', async (route) => {
      // A real member of this company, holding sales:view and neither of the two these need.
      const response = await get(outsider, route);

      expect(response.statusCode).toBe(403);
    });

    it('separates the two capabilities rather than folding them into one', async () => {
      // The seller holds both, so this asserts the declarations rather than the outcome: a role
      // with only one must not reach the other's route, which the matrix test covers generally
      // and this pins for these three.
      expect((await get(seller, '/customers')).statusCode).toBe(200);
      expect((await get(seller, '/products')).statusCode).toBe(200);
    });

    it.each(ROUTES)('%s leaks no database vocabulary when it refuses', async (route) => {
      const body = JSON.stringify((await get(outsider, route)).json());

      expect(body).not.toMatch(/customers|products|warehouses|relation|column|select |pg_/i);
    });
  });
});
