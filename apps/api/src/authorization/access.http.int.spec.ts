/**
 * Deny by default, and the role/permission matrix, over the real HTTP surface.
 *
 * Criteria 7, 8, 9 and 12. Every request below carries a real cookie from a real login. Nothing
 * constructs a principal, a context or a permission set by hand, because the claim being tested
 * is that a request cannot.
 *
 * THE MATRIX IS GENERATED, NOT WRITTEN OUT. Criterion 9 asks for every registered route against
 * every role with an expected allow or deny, generated from the permission registry. The route
 * list comes from the same startup audit the guard reads, and the expectation for each cell is
 * computed from the role template. A matrix typed out by hand agrees with the code until someone
 * adds a route, and then agrees with the bug.
 *
 * The seed puts the same person in two companies in two tenants with different roles, so a cell
 * that passes for the wrong reason, by reading the other company's grants, fails here.
 */

import { ConfigService } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';

import { AdministrationModule } from '../administration/administration.module.js';
import { provisionChartOfAccounts } from '../accounting/chart-of-accounts.js';
import { provisionPostingAccounts } from '../accounting/posting-accounts.js';
import { AppConfigModule } from '../config/config.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PasswordHasher } from '../auth/password-hasher.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, systemScope, UnitOfWork } from '../database/index.js';
import { registerHttpPlugins } from '../http/plugins.js';
import { RouteDeclarationAudit, type DeclaredRoute } from '../http/route-declarations.js';
import { CSRF_HEADER } from '../http/csrf.js';
import { SESSION_COOKIE } from '../http/session-cookie.js';
import { signIn } from '../testing/browser-session.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AppModule } from '../app.module.js';
import { PERMISSIONS, ROLE_KEYS, templatePermissions, type RoleKey } from './permissions.js';
import { RoleProvisioningService } from './role-provisioning.service.js';
import type { RouteAccess } from './route-access.js';

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

const TENANT_HOME = 'ac100000-0000-4000-8000-00000000000a';
const TENANT_AWAY = 'ac200000-0000-4000-8000-00000000000b';
const HOME = 'bc100000-0000-4000-8000-00000000000a';
const AWAY = 'bc200000-0000-4000-8000-00000000000b';

const SUBJECT = 'cc100000-0000-4000-8000-00000000000a';
const SUBJECT_EMAIL = 'subject@access.test';
const PASSWORD = 'a perfectly ordinary passphrase';

const MEMBERSHIP_HOME = 'dc100000-0000-4000-8000-00000000000a';
const MEMBERSHIP_AWAY = 'dc200000-0000-4000-8000-00000000000b';

/**
 * Master data in the home company, so the sales cells of the matrix reach a real order.
 *
 * An allow cell has to be answered by the operation rather than by a missing record, or the
 * matrix would pass while saying nothing: a 404 for an order nobody seeded looks the same
 * whether the route authorized the caller or not.
 */
const MATRIX_CUSTOMER = 'ec100000-0000-4000-8000-00000000000a';
const MATRIX_WAREHOUSE = 'ec200000-0000-4000-8000-00000000000b';
const MATRIX_PRODUCT = 'ec300000-0000-4000-8000-00000000000c';
const MATRIX_SEQUENCE = 'ec400000-0000-4000-8000-00000000000d';

/**
 * Every protected route, described the way a caller reaches it.
 *
 * `controller` and `handler` name the route this entry covers, and the test below reads the
 * same list the guard reads and refuses any protected route that has no entry. Section 13.1
 * requires a new route with no matrix entry to fail the build, and a list matched by nothing
 * cannot do that: it agrees with the code until someone adds a route, and then agrees with the
 * bug. This list is checked against the registry rather than trusted.
 */
interface Call {
  label: string;
  controller: string;
  handler: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** A function, because the sales routes address an order seeded fresh for each test. */
  url: () => string;
  payload?: () => Record<string, unknown>;
  /** Section 11's header, which the mutating sales routes require before they will do anything. */
  idempotent?: boolean;
  permission: string;
}

/** The order every sales route in the matrix acts on, replaced before each test. */
let matrixOrder = '00000000-0000-4000-8000-000000000000';

/**
 * The confirmed order the invoice cells bill, and the draft invoice they read and edit.
 *
 * Separate from `matrixOrder`, which the sales cells confirm and cancel: an invoice can only be
 * raised from a confirmed order, and the cancel cell would otherwise leave nothing to bill. Both
 * are replaced before every test, so an allow cell is answered by the operation rather than by a
 * state an earlier cell left behind.
 */
let matrixInvoiceOrder = '00000000-0000-4000-8000-000000000001';
let matrixInvoice = '00000000-0000-4000-8000-000000000002';

/**
 * A second draft invoice, for the posting cell alone.
 *
 * Separate from `matrixInvoice`, which the edit cell rewrites: posting is irreversible, so a cell
 * that shared one document with the edit cell would be answering about whichever ran first.
 */
let matrixPostableInvoice = '00000000-0000-4000-8000-000000000003';

/** A fresh key per invocation, so an allow cell is never answered by a replay of an earlier one. */
let keySequence = 0;

let idSequence = 0;
const nextOrderId = () =>
  `fc${(idSequence += 1).toString().padStart(6, '0')}-0000-4000-8000-00000000000a`;

const CALLS: Call[] = [
  {
    label: 'list members',
    controller: 'AdministrationController',
    handler: 'members',
    method: 'GET',
    url: () => '/api/members',
    permission: 'admin:users',
  },
  {
    label: 'list roles',
    controller: 'AdministrationController',
    handler: 'roles',
    method: 'GET',
    url: () => '/api/roles',
    permission: 'admin:users',
  },
  {
    label: 'assign a role',
    controller: 'AdministrationController',
    handler: 'assignRole',
    method: 'POST',
    url: () => `/api/members/${MEMBERSHIP_HOME}/roles`,
    payload: () => ({ roleKey: 'warehouse' }),
    permission: 'admin:users',
  },
  {
    label: 'remove a role',
    controller: 'AdministrationController',
    handler: 'removeRole',
    method: 'DELETE',
    url: () => `/api/members/${MEMBERSHIP_HOME}/roles/warehouse`,
    permission: 'admin:users',
  },
  {
    label: 'read the audit trail',
    controller: 'AdministrationController',
    handler: 'auditEvents',
    method: 'GET',
    url: () => '/api/audit-events',
    permission: 'audit:view',
  },
  {
    label: 'list customers',
    controller: 'MasterDataController',
    handler: 'customers',
    method: 'GET',
    url: () => '/api/customers',
    permission: 'customers:view',
  },
  {
    label: 'list products',
    controller: 'MasterDataController',
    handler: 'products',
    method: 'GET',
    url: () => '/api/products',
    permission: 'inventory:view',
  },
  {
    label: 'list warehouses',
    controller: 'MasterDataController',
    handler: 'warehouses',
    method: 'GET',
    url: () => '/api/warehouses',
    permission: 'inventory:view',
  },
  {
    label: 'create a sales order',
    controller: 'SalesOrderController',
    handler: 'create',
    method: 'POST',
    url: () => '/api/sales-orders',
    payload: () => ({
      customerId: MATRIX_CUSTOMER,
      warehouseId: MATRIX_WAREHOUSE,
      orderDate: '2026-09-12',
      lines: [{ productId: MATRIX_PRODUCT, quantity: '1' }],
    }),
    idempotent: true,
    permission: 'sales:create',
  },
  {
    label: 'list sales orders',
    controller: 'SalesOrderController',
    handler: 'list',
    method: 'GET',
    url: () => '/api/sales-orders',
    permission: 'sales:view',
  },
  {
    label: 'read a sales order',
    controller: 'SalesOrderController',
    handler: 'get',
    method: 'GET',
    url: () => `/api/sales-orders/${matrixOrder}`,
    permission: 'sales:view',
  },
  {
    label: 'edit a sales order',
    controller: 'SalesOrderController',
    handler: 'update',
    method: 'PUT',
    url: () => `/api/sales-orders/${matrixOrder}`,
    payload: () => ({
      customerId: MATRIX_CUSTOMER,
      warehouseId: MATRIX_WAREHOUSE,
      orderDate: '2026-09-12',
      version: 1,
      lines: [{ productId: MATRIX_PRODUCT, quantity: '2' }],
    }),
    idempotent: true,
    permission: 'sales:create',
  },
  {
    label: 'confirm a sales order',
    controller: 'SalesOrderController',
    handler: 'confirm',
    method: 'POST',
    url: () => `/api/sales-orders/${matrixOrder}/confirm`,
    idempotent: true,
    permission: 'sales:confirm',
  },
  {
    label: 'cancel a sales order',
    controller: 'SalesOrderController',
    handler: 'cancel',
    method: 'POST',
    url: () => `/api/sales-orders/${matrixOrder}/cancel`,
    idempotent: true,
    permission: 'sales:cancel',
  },
  {
    label: 'create a customer invoice',
    controller: 'CustomerInvoiceController',
    handler: 'create',
    method: 'POST',
    url: () => '/api/customer-invoices',
    payload: () => ({
      salesOrderIds: [matrixInvoiceOrder],
      invoiceDate: '2026-09-15',
    }),
    idempotent: true,
    permission: 'invoices:create',
  },
  {
    label: 'edit a customer invoice',
    controller: 'CustomerInvoiceController',
    handler: 'update',
    method: 'PUT',
    url: () => `/api/customer-invoices/${matrixInvoice}`,
    payload: () => ({
      salesOrderIds: [matrixInvoiceOrder],
      invoiceDate: '2026-09-16',
      version: 1,
    }),
    idempotent: true,
    permission: 'invoices:create',
  },
  {
    label: 'post a customer invoice',
    controller: 'CustomerInvoiceController',
    handler: 'post',
    method: 'POST',
    url: () => `/api/customer-invoices/${matrixPostableInvoice}/post`,
    idempotent: true,
    permission: 'invoices:post',
  },
  {
    label: 'read a customer invoice',
    controller: 'CustomerInvoiceController',
    handler: 'get',
    method: 'GET',
    url: () => `/api/customer-invoices/${matrixInvoice}`,
    permission: 'invoices:view',
  },
  {
    label: 'read the journal entry an invoice posted',
    controller: 'CustomerInvoiceController',
    handler: 'journal',
    method: 'GET',
    url: () => `/api/customer-invoices/${matrixInvoice}/journal`,
    permission: 'accounting:view',
  },
  {
    label: 'read a customer invoice trail',
    controller: 'CustomerInvoiceController',
    handler: 'auditEvents',
    method: 'GET',
    url: () => `/api/customer-invoices/${matrixInvoice}/audit-events`,
    permission: 'audit:view',
  },
  {
    label: 'read a sales order trail',
    controller: 'SalesOrderController',
    handler: 'auditEvents',
    method: 'GET',
    url: () => `/api/sales-orders/${matrixOrder}/audit-events`,
    permission: 'audit:view',
  },
];

/** A route that requires a capability, which is what the matrix has to cover. */
type ProtectedRoute = DeclaredRoute & { access: Extract<RouteAccess, { kind: 'permission' }> };

/** Whether a matrix entry and a registered route are the same route. */
const matches = (call: Call, route: ProtectedRoute) =>
  call.controller === route.controller && call.handler === route.handler;

describe('Deny by default', () => {
  let app: NestFastifyApplication;
  let owner: Client;
  let uow: UnitOfWork;
  let provisioning: RoleProvisioningService;
  let audit: RouteDeclarationAudit;

  let homeRoles: { id: string; key: string }[] = [];
  let awayRoles: { id: string; key: string }[] = [];

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
        AdministrationModule,
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
    provisioning = moduleRef.get(RoleProvisioningService);
    audit = moduleRef.get(RouteDeclarationAudit);

    await purge();
    await seed(moduleRef.get(PasswordHasher));

    // After the seed, so the startup checks run against a database in a known state.
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await app.close();
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM sessions WHERE user_id = $1', [SUBJECT]);
    await owner.query('DELETE FROM auth_throttle');
    await clearRoles(MEMBERSHIP_HOME, TENANT_HOME, HOME);
    await freshOrder();
  });

  /**
   * One draft sales order, replaced before every test.
   *
   * The mutating cells of the matrix confirm and cancel it, so a shared order would leave
   * later cells answering 409 about a state an earlier cell put it in. That would not be the
   * matrix failing, and it would not be the matrix passing either.
   */
  async function freshOrder(): Promise<void> {
    await scopedOwner(TENANT_HOME, HOME);
    await owner.query('DELETE FROM stock_reservations WHERE company_id = $1', [HOME]);
    // Invoice rows first: their lines reference the order lines deleted below.
    await owner.query('DELETE FROM customer_invoice_lines WHERE company_id = $1', [HOME]);
    await owner.query('DELETE FROM customer_invoices WHERE company_id = $1', [HOME]);
    await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [HOME]);
    await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [HOME]);

    matrixOrder = nextOrderId();
    await owner.query(
      `INSERT INTO sales_orders (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
       VALUES ($1,$2,$3,'draft',$4,$5,current_date,'USD')`,
      [matrixOrder, TENANT_HOME, HOME, MATRIX_CUSTOMER, MATRIX_WAREHOUSE],
    );
    await owner.query(
      `INSERT INTO sales_order_lines
         (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku, product_name,
          quantity, unit_price, currency)
       VALUES ($1,$2,$3,$4,1,$5,'SKU-M','Matrix widget','1.000000','10.000000','USD')`,
      [nextOrderId(), TENANT_HOME, HOME, matrixOrder, MATRIX_PRODUCT],
    );

    // A confirmed order for the invoice cells to bill, and a draft invoice for them to read and
    // edit. Written directly, because what the invoice routes need is the stored state rather
    // than a confirmation this suite is not testing.
    matrixInvoiceOrder = nextOrderId();
    const invoiceOrderLine = nextOrderId();
    await owner.query(
      `INSERT INTO sales_orders (id, tenant_id, company_id, status, doc_number, customer_id, warehouse_id, order_date, currency)
       VALUES ($1,$2,$3,'confirmed','SO-M001',$4,$5,current_date,'USD')`,
      [matrixInvoiceOrder, TENANT_HOME, HOME, MATRIX_CUSTOMER, MATRIX_WAREHOUSE],
    );
    await owner.query(
      `INSERT INTO sales_order_lines
         (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku, product_name,
          quantity, unit_price, currency)
       VALUES ($1,$2,$3,$4,1,$5,'SKU-M','Matrix widget','5.000000','10.000000','USD')`,
      [invoiceOrderLine, TENANT_HOME, HOME, matrixInvoiceOrder, MATRIX_PRODUCT],
    );

    matrixInvoice = nextOrderId();
    await owner.query(
      `INSERT INTO customer_invoices
         (id, tenant_id, company_id, customer_id, invoice_date, currency, subtotal, tax_total, total)
       VALUES ($1,$2,$3,$4,current_date,'USD','10.0000','0.0000','10.0000')`,
      [matrixInvoice, TENANT_HOME, HOME, MATRIX_CUSTOMER],
    );
    await owner.query(
      `INSERT INTO customer_invoice_lines
         (id, tenant_id, company_id, customer_invoice_id, line_number, source_sales_order_id,
          source_sales_order_line_id, product_id, product_sku, product_name, quantity, unit_price,
          currency, line_subtotal, line_tax, line_total)
       VALUES ($1,$2,$3,$4,1,$5,$6,$7,'SKU-M','Matrix widget','1.000000','10.000000','USD','10.0000','0.0000','10.0000')`,
      [
        nextOrderId(),
        TENANT_HOME,
        HOME,
        matrixInvoice,
        matrixInvoiceOrder,
        invoiceOrderLine,
        MATRIX_PRODUCT,
      ],
    );

    // A second draft for the posting cell. Posting is irreversible, so it cannot share a document
    // with the edit cell: whichever ran first would decide what the other was answering about.
    matrixPostableInvoice = nextOrderId();
    await owner.query(
      `INSERT INTO customer_invoices
         (id, tenant_id, company_id, customer_id, invoice_date, currency, subtotal, tax_total, total)
       VALUES ($1,$2,$3,$4,current_date,'USD','10.0000','0.0000','10.0000')`,
      [matrixPostableInvoice, TENANT_HOME, HOME, MATRIX_CUSTOMER],
    );
    await owner.query(
      `INSERT INTO customer_invoice_lines
         (id, tenant_id, company_id, customer_invoice_id, line_number, source_sales_order_id,
          source_sales_order_line_id, product_id, product_sku, product_name, quantity, unit_price,
          currency, line_subtotal, line_tax, line_total)
       VALUES ($1,$2,$3,$4,1,$5,$6,$7,'SKU-M','Matrix widget','1.000000','10.000000','USD','10.0000','0.0000','10.0000')`,
      [
        nextOrderId(),
        TENANT_HOME,
        HOME,
        matrixPostableInvoice,
        matrixInvoiceOrder,
        invoiceOrderLine,
        MATRIX_PRODUCT,
      ],
    );

    // The counter posting allocates from is seeded once, with the company. Rewound here so the
    // number a posting cell issues does not depend on how many cells ran before it.
    await owner.query(
      `UPDATE document_number_sequences SET next_value = 1
        WHERE company_id = $1 AND doc_type = 'customer_invoice'`,
      [HOME],
    );
  }

  async function seed(hasher: PasswordHasher): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_HOME,
      'access-home',
      'Access Home',
      TENANT_AWAY,
      'access-away',
      'Access Away',
    ]);

    const passwordHash = await hasher.hash(PASSWORD);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_HOME }), async (r) => {
      await r.users.create({ id: SUBJECT, email: SUBJECT_EMAIL, name: 'Subject', passwordHash });
      await r.companies.create({ id: HOME, name: 'Home', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_AWAY }), async (r) => {
      await r.companies.create({ id: AWAY, name: 'Away', baseCurrency: 'EUR' });
    });
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_HOME, companyId: HOME }),
      (r) => r.memberships.create({ id: MEMBERSHIP_HOME, userId: SUBJECT }),
    );
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT_AWAY, companyId: AWAY }),
      (r) => r.memberships.create({ id: MEMBERSHIP_AWAY, userId: SUBJECT }),
    );

    homeRoles = await provisioning.seedDefaultRoles({ tenantId: TENANT_HOME, companyId: HOME });
    awayRoles = await provisioning.seedDefaultRoles({ tenantId: TENANT_AWAY, companyId: AWAY });

    // Master data and stock in the home company, so an allowed sales call is answered by the
    // operation rather than by a missing record.
    await scopedOwner(TENANT_HOME, HOME);
    await owner.query(
      'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
      [MATRIX_CUSTOMER, TENANT_HOME, HOME, 'CUST-M', 'Matrix customer'],
    );
    await owner.query(
      'INSERT INTO warehouses (id, tenant_id, company_id, code, name, is_default) VALUES ($1,$2,$3,$4,$5,true)',
      [MATRIX_WAREHOUSE, TENANT_HOME, HOME, 'WH-M', 'Matrix warehouse'],
    );
    await owner.query(
      `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
       VALUES ($1,$2,$3,'SKU-M','Matrix widget','unit','10.000000','USD')`,
      [MATRIX_PRODUCT, TENANT_HOME, HOME],
    );
    await owner.query(
      `INSERT INTO document_number_sequences (id, tenant_id, company_id, doc_type, prefix, gapless, next_value)
       VALUES ($1,$2,$3,'sales_order','SO-',true,1)`,
      [MATRIX_SEQUENCE, TENANT_HOME, HOME],
    );
    await owner.query(
      `INSERT INTO document_number_sequences (id, tenant_id, company_id, doc_type, prefix, gapless, next_value)
       VALUES ($1,$2,$3,'customer_invoice','INV-',true,1)`,
      [nextOrderId(), TENANT_HOME, HOME],
    );
    // The books a posting cell needs, so an allowed posting is answered by the operation rather
    // than by a company with no accounts configured.
    await uow.inActorScope(
      actorScope({ tenantId: TENANT_HOME, companyId: HOME, userId: SUBJECT }),
      async (repositories) => {
        const chart = await provisionChartOfAccounts(repositories);
        await provisionPostingAccounts(repositories, chart);
      },
    );

    await scopedOwner(TENANT_HOME, HOME);
    // Enough stock that a confirm cell is answered by authorization rather than by an oversell.
    await owner.query(
      `INSERT INTO stock_movements (id, tenant_id, company_id, product_id, warehouse_id, quantity, reason,
          source_doc_type, source_doc_id)
       VALUES ($1,$2,$3,$4,$5,'1000.000000','purchase_receipt','purchase_order',$6)`,
      [nextOrderId(), TENANT_HOME, HOME, MATRIX_PRODUCT, MATRIX_WAREHOUSE, nextOrderId()],
    );
    await owner.query(
      `INSERT INTO stock_balances (id, tenant_id, company_id, product_id, warehouse_id, on_hand)
       VALUES ($1,$2,$3,$4,$5,'1000.000000')`,
      [nextOrderId(), TENANT_HOME, HOME, MATRIX_PRODUCT, MATRIX_WAREHOUSE],
    );
  }

  async function purge(): Promise<void> {
    await owner.query('DELETE FROM sessions WHERE user_id = $1', [SUBJECT]);
    // Before the accounts its lines reference. The ledger refuses a delete even from the owning
    // role, per migration 0014, so the fixture truncates rather than asking for that to be
    // weakened.
    await owner.query(`SELECT set_config('app.tenant_id', '', false)`);
    await owner.query('TRUNCATE journal_lines, journal_entries');
    const scopes: [string, string][] = [
      [TENANT_HOME, HOME],
      [TENANT_AWAY, AWAY],
    ];

    for (const [tenantId, companyId] of scopes) {
      await scopedOwner(tenantId, companyId);
      await owner.query('DELETE FROM idempotency_records WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_reservations WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_movements WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_balances WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customer_invoice_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customer_invoices WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM document_number_sequences WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM company_posting_accounts WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM accounts WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM products WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM warehouses WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM membership_roles WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM role_permissions WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM roles WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM memberships WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1', [tenantId]);
    }
    await owner.query(`SELECT set_config('app.tenant_id', '', false)`);
    await owner.query(`SELECT set_config('app.company_id', '', false)`);
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM auth_throttle');
    await owner.query('DELETE FROM users WHERE id = $1', [SUBJECT]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_HOME, TENANT_AWAY]]);
  }

  async function scopedOwner(tenantId: string, companyId: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId]);
  }

  async function clearRoles(membershipId: string, tenantId: string, companyId: string) {
    await scopedOwner(tenantId, companyId);
    await owner.query('DELETE FROM membership_roles WHERE membership_id = $1', [membershipId]);
  }

  async function grant(roleKey: string, where: 'home' | 'away' = 'home'): Promise<void> {
    const target =
      where === 'home'
        ? { tenantId: TENANT_HOME, companyId: HOME, membershipId: MEMBERSHIP_HOME, roles: homeRoles }
        : { tenantId: TENANT_AWAY, companyId: AWAY, membershipId: MEMBERSHIP_AWAY, roles: awayRoles };

    const roleId = target.roles.find((role) => role.key === roleKey)?.id;
    if (!roleId) throw new Error(`No seeded role ${roleKey} in the ${where} company`);

    await scopedOwner(target.tenantId, target.companyId);
    await owner.query(
      'INSERT INTO membership_roles (tenant_id, company_id, membership_id, role_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [target.tenantId, target.companyId, target.membershipId, roleId],
    );
  }

  // -------------------------------------------------------------------------------------
  // Helpers that only speak HTTP.
  // -------------------------------------------------------------------------------------

  /**
   * Signs in the way a browser does, cookies and forgery header included.
   *
   * Section 14.4 makes every mutation carry the custom header, so a helper that omits it would
   * turn every allow cell of the matrix below into a refusal for the wrong reason.
   */
  const login = async (): Promise<string> => {
    const session = await signIn(app, { email: SUBJECT_EMAIL, password: PASSWORD });
    return session.cookie;
  };

  /** The header value, taken from the cookie the server issued. */
  const csrfOf = (cookie: string) => cookie.match(/erp_csrf=([^;]*)/)?.[1] ?? '';

  const enter = async (cookie: string, companyId: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/me/company',
      headers: { cookie, [CSRF_HEADER]: csrfOf(cookie) },
      payload: { companyId },
    });
    if (response.statusCode !== 201) {
      throw new Error(`Could not enter company: ${response.statusCode} ${response.body}`);
    }
  };

  const invoke = (call: Call, cookie?: string, extra: Record<string, string> = {}) =>
    app.inject({
      method: call.method,
      url: call.url(),
      headers: {
        ...(cookie ? { cookie, [CSRF_HEADER]: csrfOf(cookie) } : {}),
        // A fresh key each time. A reused one would answer a later cell with an earlier
        // cell's stored response, which is section 11 working and the matrix not.
        ...(call.idempotent ? { 'idempotency-key': `matrix-${(keySequence += 1)}` } : {}),
        ...extra,
      },
      ...(call.payload ? { payload: call.payload() } : {}),
    });

  /**
   * Every route the guard will demand a capability for, read from the registry.
   *
   * The same list the startup audit walks and the same metadata the guard reads, so a route
   * cannot be covered here and enforced differently there.
   */
  const protectedRoutes = (): ProtectedRoute[] =>
    audit
      .inspect()
      .declared.filter((route): route is ProtectedRoute => route.access.kind === 'permission');

  /** Signs in, enters the home company, and holds exactly the named role there. */
  const asRole = async (roleKey: RoleKey): Promise<string> => {
    await grant(roleKey);
    const cookie = await login();
    await enter(cookie, HOME);
    return cookie;
  };

  // -------------------------------------------------------------------------------------
  // Criterion 7. Every route declares, and the boot refuses otherwise.
  // -------------------------------------------------------------------------------------

  describe('every registered route declares its access', () => {
    it('finds no undeclared route in the application', () => {
      const { undeclared } = audit.inspect();

      expect(undeclared).toEqual([]);
    });

    it('has a matrix entry for every protected route the application registers', () => {
      // SECTION 13.1, AND THE REASON THIS TEST EXISTS. A new protected route with no matrix
      // entry must fail the build. The previous assertion compared list lengths, which is
      // satisfied by adding routes and no entries, so ten routes went uncovered without a
      // single test going red. This reads the registry the guard reads and names the offender.
      const uncovered = protectedRoutes()
        .filter((route) => !CALLS.some((call) => matches(call, route)))
        .map((route) => `${route.controller}.${route.handler}`);

      expect(uncovered).toEqual([]);
    });

    it('has no matrix entry for a route the application does not register', () => {
      // The other direction. An entry left behind after a route is renamed or removed would
      // otherwise keep passing against nothing.
      const orphaned = CALLS.filter(
        (call) => !protectedRoutes().some((route) => matches(call, route)),
      ).map((call) => `${call.controller}.${call.handler}`);

      expect(orphaned).toEqual([]);
    });

    it('expects the permission each route actually declares', () => {
      // An entry naming the right route and the wrong permission would compute every allow
      // and deny cell below from a capability the route does not require.
      for (const route of protectedRoutes()) {
        const call = CALLS.find((entry) => matches(entry, route));
        expect(call?.permission).toBe(route.access.permission);
      }
    });

    it('covers each protected route exactly once', () => {
      const seen = CALLS.map((call) => `${call.controller}.${call.handler}`);

      expect(new Set(seen).size).toBe(seen.length);
    });

    it('refuses to start when a route declares nothing', () => {
      // The audit is given a controller with a route and no decorator, which is what a new
      // route looks like before someone remembers. Section 6.2: it fails to register.
      const undeclaredAudit = {
        inspect: () => ({ declared: [], undeclared: ['DraftController.create'] }),
        onApplicationBootstrap: RouteDeclarationAudit.prototype.onApplicationBootstrap,
        logger: { error: () => undefined, log: () => undefined },
      };

      expect(() => undeclaredAudit.onApplicationBootstrap.call(undeclaredAudit)).toThrow(
        /must declare its access/,
      );
    });

    it('declares every protected route with a permission from the catalogue', () => {
      for (const route of protectedRoutes()) {
        expect(PERMISSIONS).toContain(route.access.permission);
      }
    });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 8. Unauthenticated, then authenticated without the permission.
  // -------------------------------------------------------------------------------------

  describe('unauthenticated requests', () => {
    /**
     * A request with no cookie at all is refused by whichever guard reaches it first.
     *
     * For a read that is the access guard, which answers 401 because there is no session. For a
     * mutation the forgery guard runs first and answers 403, because a request carrying neither
     * a session nor a token is not a signed-out user, it is a request from somewhere else. That
     * ordering is deliberate: a forgery is turned away before anything touches the database.
     */
    const refusalFor = (call: Call) => (call.method === 'GET' ? 401 : 403);

    it.each(CALLS)('refuses $label with no credentials at all', async (call) => {
      const response = await invoke(call);

      expect(response.statusCode).toBe(refusalFor(call));
    });

    it.each(CALLS)('refuses $label with an invented cookie', async (call) => {
      const response = await invoke(call, `${SESSION_COOKIE}=${'a'.repeat(43)}`);

      expect(response.statusCode).toBe(refusalFor(call));
    });

    it.each(CALLS.filter((call) => call.method !== 'GET'))(
      'still refuses $label with 401 once forgery protection is present',
      async (call) => {
        // The same mutations, this time carrying a valid token from a signed-out visit. The
        // forgery guard is satisfied and the access guard answers, so the refusal is about the
        // missing session rather than about the missing token.
        const visit = await app.inject({ method: 'GET', url: '/api/me' });
        const raw = visit.headers['set-cookie'];
        const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
        const issued = list.join(';').match(/erp_csrf=([^;]*)/)?.[1] ?? '';

        const response = await app.inject({
          method: call.method,
          url: call.url(),
          headers: {
            cookie: `erp_csrf=${issued}`,
            [CSRF_HEADER]: issued,
            ...(call.idempotent ? { 'idempotency-key': `matrix-${(keySequence += 1)}` } : {}),
          },
          ...(call.payload ? { payload: call.payload() } : {}),
        });

        expect(response.statusCode).toBe(401);
      },
    );
  });

  describe('authenticated with no company entered', () => {
    it.each(CALLS)('refuses $label with 403, because there is nothing to authorize against', async (call) => {
      await grant('administrator');
      const cookie = await login();

      // Signed in, holds the administrator role in the home company, and has not entered it.
      // Dimension 1 of section 6.1 is evaluated first and there is no company yet.
      const response = await invoke(call, cookie);

      expect(response.statusCode).toBe(403);
    });
  });

  describe('authenticated without the permission', () => {
    it.each(CALLS)('refuses $label for a member with no roles at all', async (call) => {
      const cookie = await login();
      await enter(cookie, HOME);

      const response = await invoke(call, cookie);

      expect(response.statusCode).toBe(403);
    });

    it('refuses an administration route for a warehouse operator', async () => {
      const cookie = await asRole('warehouse');

      const response = await invoke(CALLS[0]!, cookie);

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({ statusCode: 403 });
    });

    it('allows the audit route for an accountant and refuses the members route', async () => {
      // The two permissions differ, which is what makes the matrix meaningful. An accountant
      // holds audit:view and not admin:users.
      const cookie = await asRole('accountant');

      expect((await invoke(CALLS[4]!, cookie)).statusCode).toBe(200);
      expect((await invoke(CALLS[0]!, cookie)).statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 9. Every route against every role, generated from the registry.
  // -------------------------------------------------------------------------------------

  describe('the role and permission matrix', () => {
    const cells = ROLE_KEYS.flatMap((roleKey) =>
      CALLS.map((call) => ({
        roleKey,
        call,
        expected: templatePermissions(roleKey).has(call.permission as never) ? 'allow' : 'deny',
      })),
    );

    it('covers every role against every protected route', () => {
      expect(cells).toHaveLength(ROLE_KEYS.length * CALLS.length);
    });

    it.each(cells)('$roleKey $expected $call.label', async ({ roleKey, call, expected }) => {
      const cookie = await asRole(roleKey);
      const response = await invoke(call, cookie);

      if (expected === 'allow') {
        // 403 is the only failure this cell is about. A 404 from a missing membership or a 400
        // from a bad body would be a broken test rather than a denial, so the assertion is on
        // the status not being a refusal rather than on a specific success code.
        expect(response.statusCode).not.toBe(403);
        expect(response.statusCode).toBeLessThan(400);
      } else {
        expect(response.statusCode).toBe(403);
      }
    });
  });

  // -------------------------------------------------------------------------------------
  // Nothing in the request can change the answer.
  // -------------------------------------------------------------------------------------

  describe('forged authorization input', () => {
    const forgeries: [string, Record<string, string>][] = [
      ['a role header', { 'x-role': 'administrator' }],
      ['a permission header', { 'x-permissions': 'admin:users' }],
      ['a company header', { 'x-company-id': HOME }],
      ['a tenant header', { 'x-tenant-id': TENANT_HOME }],
      ['an impersonation header', { 'x-user-id': SUBJECT }],
    ];

    it.each(forgeries)('ignores %s on a route the caller may not reach', async (_label, headers) => {
      const cookie = await asRole('warehouse');

      const response = await invoke(CALLS[0]!, cookie, headers);

      expect(response.statusCode).toBe(403);
    });

    it('ignores a permission list in the body of a mutating route', async () => {
      const cookie = await asRole('warehouse');

      const response = await app.inject({
        method: 'POST',
        url: `/api/members/${MEMBERSHIP_HOME}/roles`,
        headers: { cookie, [CSRF_HEADER]: csrfOf(cookie) },
        payload: { roleKey: 'warehouse', permissions: ['admin:users'], role: 'administrator' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('ignores a role sent to /me', async () => {
      const cookie = await asRole('warehouse');

      const response = await app.inject({
        method: 'GET',
        url: '/api/me?permissions=admin:users&role=administrator',
        headers: { cookie, 'x-role': 'administrator' },
      });
      const body = JSON.parse(response.body) as { permissions: string[] };

      expect(body.permissions).toEqual([...templatePermissions('warehouse')].sort());
      expect(body.permissions).not.toContain('admin:users');
    });
  });

  // -------------------------------------------------------------------------------------
  // The company is part of the question. Criterion 17.
  // -------------------------------------------------------------------------------------

  describe('permissions are evaluated against the active company', () => {
    it('allows in the company that grants it and refuses in the one that does not', async () => {
      await grant('administrator', 'home');
      await grant('warehouse', 'away');
      const cookie = await login();

      await enter(cookie, HOME);
      expect((await invoke(CALLS[0]!, cookie)).statusCode).toBe(200);

      await enter(cookie, AWAY);
      expect((await invoke(CALLS[0]!, cookie)).statusCode).toBe(403);
    });

    it('changes the reported permissions when the company changes', async () => {
      await grant('administrator', 'home');
      await grant('warehouse', 'away');
      const cookie = await login();

      await enter(cookie, HOME);
      const inHome = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).body,
      ) as { permissions: string[] };

      await enter(cookie, AWAY);
      const inAway = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).body,
      ) as { permissions: string[] };

      expect(inHome.permissions).toContain('admin:users');
      expect(inAway.permissions).not.toContain('admin:users');
      expect(inAway.permissions).toEqual([...templatePermissions('warehouse')].sort());
    });

    it('shows one company the audit trail and never the other', async () => {
      await grant('administrator', 'home');
      await grant('administrator', 'away');
      const cookie = await login();

      // ONE EVENT PER COMPANY, WRITTEN HERE RATHER THAN RELIED ON FROM THE SEED. The read clamps
      // to the two hundred most recent events, so a seeding record from `beforeAll` can age out
      // of that window as the matrix writes more audited events. The claim is that one company
      // never sees another's trail, so the fixture makes the trail deterministic and asserts
      // exactly that.
      await owner.query(`SELECT set_config('app.tenant_id', '', false)`);
      await owner.query('TRUNCATE audit_events');

      for (const [tenantId, companyId] of [
        [TENANT_HOME, HOME],
        [TENANT_AWAY, AWAY],
      ] as const) {
        await uow.inSystemScope(
          systemScope('tenant-provisioning', { tenantId, companyId }),
          (repositories) =>
            repositories.audit.append({
              action: 'roles_seeded',
              entityType: 'company',
              entityId: companyId,
              summary: `Seeded default roles for ${companyId}`,
            }),
        );
      }

      // Read with a wide limit rather than through the matrix entry, which asks for the default
      // page. The claim being tested is about isolation, not about what fits on the first page.
      const trail = async (): Promise<{ entityId: string }[]> =>
        JSON.parse(
          (
            await app.inject({
              method: 'GET',
              url: '/api/audit-events?limit=500',
              headers: { cookie, [CSRF_HEADER]: csrfOf(cookie) },
            })
          ).body,
        ) as { entityId: string }[];

      await enter(cookie, HOME);
      const home = await trail();

      await enter(cookie, AWAY);
      const away = await trail();

      // Each company sees its own switch records and its own seeding record, and neither sees
      // the other's, which is section 2.10 rather than a filter someone remembered.
      expect(home.some((event) => event.entityId === HOME)).toBe(true);
      expect(home.some((event) => event.entityId === AWAY)).toBe(false);
      expect(away.some((event) => event.entityId === AWAY)).toBe(true);
      expect(away.some((event) => event.entityId === HOME)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------
  // Authority ending mid-session.
  // -------------------------------------------------------------------------------------

  describe('revocation during a live session', () => {
    it('stops authorizing as soon as the role is removed', async () => {
      const cookie = await asRole('administrator');
      expect((await invoke(CALLS[0]!, cookie)).statusCode).toBe(200);

      await clearRoles(MEMBERSHIP_HOME, TENANT_HOME, HOME);

      // No cache and no session to invalidate. Section 6.6, the re-derive half.
      expect((await invoke(CALLS[0]!, cookie)).statusCode).toBe(403);
    });

    it('stops authorizing as soon as the permission is revoked from the role', async () => {
      const cookie = await asRole('administrator');
      const administrator = homeRoles.find((role) => role.key === 'administrator');

      await scopedOwner(TENANT_HOME, HOME);
      await owner.query(
        'DELETE FROM role_permissions WHERE role_id = $1 AND permission = $2',
        [administrator?.id, 'admin:users'],
      );

      try {
        expect((await invoke(CALLS[0]!, cookie)).statusCode).toBe(403);
        // And a capability the same role still holds keeps working, so the refusal is about the
        // permission rather than about the role having stopped resolving.
        expect((await invoke(CALLS[4]!, cookie)).statusCode).toBe(200);
      } finally {
        await owner.query(
          'INSERT INTO role_permissions (tenant_id, company_id, role_id, permission) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [TENANT_HOME, HOME, administrator?.id, 'admin:users'],
        );
      }
    });

    it('stops authorizing as soon as the membership is suspended', async () => {
      const cookie = await asRole('administrator');

      await scopedOwner(TENANT_HOME, HOME);
      await owner.query(`UPDATE memberships SET status = 'suspended' WHERE id = $1`, [
        MEMBERSHIP_HOME,
      ]);

      try {
        // Dimension 1 fails, so the question of permissions never arises.
        expect((await invoke(CALLS[0]!, cookie)).statusCode).toBe(403);
      } finally {
        await owner.query(`UPDATE memberships SET status = 'active' WHERE id = $1`, [
          MEMBERSHIP_HOME,
        ]);
      }
    });

    it('stops authorizing after logout, with the same cookie', async () => {
      const cookie = await asRole('administrator');
      await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie, [CSRF_HEADER]: csrfOf(cookie) },
      });

      expect((await invoke(CALLS[0]!, cookie)).statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 11 over HTTP, and the audit that goes with it.
  // -------------------------------------------------------------------------------------

  describe('assigning roles through the API', () => {
    it('refuses a role wider than the caller holds', async () => {
      // The purchasing template can create a purchase order and cannot approve one, so it must
      // not be able to hand out the manager role that can.
      await grant('purchasing');
      await grant('administrator');
      const cookie = await login();
      await enter(cookie, HOME);

      // Narrow the caller to purchasing alone, keeping admin:users out of reach is not the
      // point here, so give them a role that has admin:users but not purchasing:approve.
      await scopedOwner(TENANT_HOME, HOME);
      const administrator = homeRoles.find((role) => role.key === 'administrator');
      await owner.query(
        'DELETE FROM role_permissions WHERE role_id = $1 AND permission = $2',
        [administrator?.id, 'purchasing:approve'],
      );

      try {
        const response = await app.inject({
          method: 'POST',
          url: `/api/members/${MEMBERSHIP_HOME}/roles`,
          headers: { cookie, [CSRF_HEADER]: csrfOf(cookie) },
          payload: { roleKey: 'manager' },
        });

        expect(response.statusCode).toBe(403);
        expect(JSON.parse(response.body).message).toMatch(/do not hold/);
      } finally {
        await owner.query(
          'INSERT INTO role_permissions (tenant_id, company_id, role_id, permission) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [TENANT_HOME, HOME, administrator?.id, 'purchasing:approve'],
        );
      }
    });

    it('writes an audit record for a successful assignment', async () => {
      const cookie = await asRole('administrator');
      await owner.query('TRUNCATE audit_events');

      const response = await app.inject({
        method: 'POST',
        url: `/api/members/${MEMBERSHIP_HOME}/roles`,
        headers: { cookie, [CSRF_HEADER]: csrfOf(cookie) },
        payload: { roleKey: 'sales' },
      });
      expect(response.statusCode).toBe(201);

      await scopedOwner(TENANT_HOME, HOME);
      const events = await owner.query<{ action: string; actor_user_id: string }>(
        `SELECT action, actor_user_id FROM audit_events WHERE action = 'role_assigned'`,
      );

      expect(events.rowCount).toBe(1);
      expect(events.rows[0]?.actor_user_id).toBe(SUBJECT);
    });

    it('answers a membership from another company as not found', async () => {
      const cookie = await asRole('administrator');

      const response = await app.inject({
        method: 'POST',
        url: `/api/members/${MEMBERSHIP_AWAY}/roles`,
        headers: { cookie, [CSRF_HEADER]: csrfOf(cookie) },
        payload: { roleKey: 'sales' },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
