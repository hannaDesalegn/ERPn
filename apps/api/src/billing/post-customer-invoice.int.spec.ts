/**
 * Posting a customer invoice, against a real PostgreSQL.
 *
 * THE CLAIM IS THAT ALL OF IT HAPPENS OR NONE OF IT DOES. Section 12.2 permits no partial post,
 * and a posting touches six things at once: the invoice status, its number, the invoiced quantity
 * on the source lines, a balanced journal entry, the audit trail and the number counter. Every
 * test below either asserts one of those, or forces a failure and asserts that none of them
 * survived.
 *
 * WHY A REAL DATABASE. The balance invariant is a deferred trigger, the remainder check is a
 * predicate inside an UPDATE, the number is a locked counter row, and the scope is a policy.
 * Section 13.2: a mock proves nothing about any of them, and a mock lock always holds.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, systemScope, UnitOfWork } from '../database/index.js';
import type { ScopedRepositories } from '../database/index.js';
import { provisionChartOfAccounts } from '../accounting/chart-of-accounts.js';
import { provisionPostingAccounts } from '../accounting/posting-accounts.js';
import { seedDefaultRolesIn } from '../authorization/role-provisioning.service.js';
import type { CompanyContext } from '../identity/identity.service.js';
import { provisionCustomerInvoiceSequence } from '../sales/document-numbers.js';
import { CustomerInvoiceService } from './customer-invoice.service.js';
import { postCustomerInvoice } from './post-customer-invoice.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'c1100000-0000-4000-8000-00000000000a';
const TENANT_B = 'c1200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'c2100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "wrong company, right tenant" is representable. */
const COMPANY_A2 = 'c2200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'c2300000-0000-4000-8000-00000000000c';

/** Holds the accountant role, which the catalogue gives `invoices:post`. */
const POSTER = 'c3100000-0000-4000-8000-00000000000a';
/** A member of the same company holding the warehouse role, which does not. */
const CLERK = 'c3200000-0000-4000-8000-00000000000b';
/**
 * A member who may raise an invoice and may not commit one.
 *
 * No template grants that pair, so the fixture seeds a role for it. Without this actor the
 * operation's own capability check cannot be told apart from the route's: widening
 * `invoices:post` to `invoices:create` in the operation leaves every other test green, because
 * the guard refuses such a caller before the operation is reached and the warehouse clerk holds
 * neither capability either way. Section 6.2 wants both layers correct on their own.
 */
const DRAFTER = 'c3300000-0000-4000-8000-00000000000c';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'c4110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'c4120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'c4130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'c4210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'c4220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'c4230000-0000-4000-8000-00000000000c',
};
const PRODUCT: Record<string, string> = {
  [COMPANY_A1]: 'c4310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'c4320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'c4330000-0000-4000-8000-00000000000c',
};

/** The membership each actor holds, per company, filled in by the seed. */
const MEMBERSHIP: Record<string, Record<string, string>> = {};

const scopeFor = (tenantId: string, companyId: string, userId = POSTER) =>
  actorScope({ tenantId, companyId, userId });

describe('Posting a customer invoice', () => {
  let uow: UnitOfWork;
  let invoices: CustomerInvoiceService;
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
      providers: [CustomerInvoiceService],
    }).compile();
    await moduleRef.init();

    uow = moduleRef.get(UnitOfWork);
    invoices = moduleRef.get(CustomerInvoiceService);
    close = () => moduleRef.close();

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();

    await purge();
    await seed();
  });

  afterAll(async () => {
    try {
      await purge();
    } finally {
      await owner.end();
      await close();
    }
  });

  beforeEach(async () => {
    await clearDocuments();
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  const contextFor = (
    tenantId: string,
    companyId: string,
    userId = POSTER,
  ): CompanyContext => ({
    tenantId,
    companyId,
    membershipId: MEMBERSHIP[companyId]![userId]!,
    requestId: 'req-posting-test',
  });

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'post-a',
      'Posting A',
      TENANT_B,
      'post-b',
      'Posting B',
    ]);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_A }), async (r) => {
      await r.users.create({ id: POSTER, email: 'poster@post.test', name: 'Poster', passwordHash: 'x' });
      await r.users.create({ id: CLERK, email: 'clerk@post.test', name: 'Clerk', passwordHash: 'x' });
      await r.users.create({
        id: DRAFTER,
        email: 'drafter@post.test',
        name: 'Drafter',
        passwordHash: 'x',
      });
      await r.companies.create({ id: COMPANY_A1, name: 'A One', baseCurrency: 'USD' });
      await r.companies.create({ id: COMPANY_A2, name: 'A Two', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_B }), (r) =>
      r.companies.create({ id: COMPANY_B1, name: 'B One', baseCurrency: 'EUR' }),
    );

    for (const [tenantId, companyId] of SCOPES) {
      // The books, the counter and the roles: what company provisioning gives a real company,
      // built here through the same functions so the fixture cannot drift from it.
      const seeded = await uow.inSystemScope(
        systemScope('tenant-provisioning', { tenantId, companyId }),
        async (r) => {
          await provisionCustomerInvoiceSequence(r);
          const chart = await provisionChartOfAccounts(r);
          await provisionPostingAccounts(r, chart);
          return seedDefaultRolesIn(r, companyId);
        },
      );

      MEMBERSHIP[companyId] = {};

      // The role no template defines: raising an invoice without the authority to post it.
      const drafterMembership = randomUUID();
      MEMBERSHIP[companyId]![DRAFTER] = drafterMembership;
      await uow.inSystemScope(
        systemScope('tenant-provisioning', { tenantId, companyId }),
        async (r) => {
          const role = await r.roles.create({
            id: randomUUID(),
            key: 'invoice_drafter',
            name: 'Invoice Drafter',
          });
          await r.roles.grantPermissions({
            roleId: role.id,
            permissions: ['invoices:view', 'invoices:create'],
          });
          await r.memberships.create({ id: drafterMembership, userId: DRAFTER });
          await r.roles.assignToMembership({ membershipId: drafterMembership, roleId: role.id });
        },
      );

      for (const [userId, roleKey] of [
        [POSTER, 'accountant'],
        [CLERK, 'warehouse'],
      ] as const) {
        const membershipId = randomUUID();
        MEMBERSHIP[companyId]![userId] = membershipId;
        await uow.inSystemScope(
          systemScope('tenant-provisioning', { tenantId, companyId }),
          async (r) => {
            await r.memberships.create({ id: membershipId, userId });
            await r.roles.assignToMembership({
              membershipId,
              roleId: seeded.find((role) => role.key === roleKey)!.id,
            });
          },
        );
      }

      await uow.inActorScope(scopeFor(tenantId, companyId), async (r) => {
        await r.customers.create({ id: CUSTOMER[companyId]!, code: 'CUST-1', name: 'A Customer' });
        await r.warehouses.create({ id: WAREHOUSE[companyId]!, code: 'WH-1', name: 'Main' });
        await r.products.create({
          id: PRODUCT[companyId]!,
          sku: 'SKU-1',
          name: 'A Product',
          stockingUom: 'each',
          salesPrice: '10.000000',
          salesPriceCurrency: companyId === COMPANY_B1 ? 'EUR' : 'USD',
        });
      });
    }
  }

  async function clearDocuments(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      // No delete of the ledger here: 0014 refuses one even from the owning role, which is the
      // guarantee under test elsewhere. The truncate below is how this fixture works with it.
      await owner.query('DELETE FROM customer_invoice_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customer_invoices WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [companyId]);
      await owner.query('UPDATE document_number_sequences SET next_value = 1 WHERE company_id = $1', [
        companyId,
      ]);
      await owner.query('UPDATE companies SET standard_tax_rate_percent = 0 WHERE id = $1', [
        companyId,
      ]);
    }
    // The ledger is append only and refuses a delete even from the owning role, so the fixture
    // truncates rather than asking for that guarantee to be weakened.
    await ownerContext();
    await owner.query('TRUNCATE journal_lines, journal_entries');
    await owner.query('TRUNCATE audit_events');
  }

  async function purge(): Promise<void> {
    await clearDocuments();
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM company_posting_accounts WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM accounts WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM document_number_sequences WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM products WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM warehouses WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM membership_roles WHERE company_id = $1', [companyId]);
      await owner.query(
        'DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE company_id = $1)',
        [companyId],
      );
      await owner.query('DELETE FROM memberships WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM roles WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[POSTER, CLERK, DRAFTER]]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  /** A confirmed order, written directly: what posting needs is the stored state. */
  async function confirmedOrder(
    options: {
      tenantId?: string;
      companyId?: string;
      status?: string;
      lines?: { quantity: string; unitPrice?: string; discountPercent?: string }[];
    } = {},
  ): Promise<{ id: string; lineIds: string[] }> {
    const tenantId = options.tenantId ?? TENANT_A;
    const companyId = options.companyId ?? COMPANY_A1;
    const orderId = randomUUID();
    const status = options.status ?? 'confirmed';
    const lines = options.lines ?? [{ quantity: '10.000000' }];

    await ownerContext(tenantId, companyId);
    await owner.query(
      `INSERT INTO sales_orders
         (id, tenant_id, company_id, status, doc_number, customer_id, warehouse_id, order_date, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,current_date,$8)`,
      [
        orderId,
        tenantId,
        companyId,
        status,
        status === 'draft' ? null : `SO-${orderId}`,
        CUSTOMER[companyId]!,
        WAREHOUSE[companyId]!,
        companyId === COMPANY_B1 ? 'EUR' : 'USD',
      ],
    );

    const lineIds: string[] = [];
    for (const [index, line] of lines.entries()) {
      const lineId = randomUUID();
      lineIds.push(lineId);
      await owner.query(
        `INSERT INTO sales_order_lines
           (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku,
            product_name, quantity, unit_price, discount_percent, currency)
         VALUES ($1,$2,$3,$4,$5,$6,'SKU-1','A Product',$7,$8,$9,$10)`,
        [
          lineId,
          tenantId,
          companyId,
          orderId,
          index + 1,
          PRODUCT[companyId]!,
          line.quantity,
          line.unitPrice ?? '10.000000',
          line.discountPercent ?? '0',
          companyId === COMPANY_B1 ? 'EUR' : 'USD',
        ],
      );
    }

    return { id: orderId, lineIds };
  }

  const draftFor = (
    input: Parameters<CustomerInvoiceService['createDraft']>[2],
    tenantId = TENANT_A,
    companyId = COMPANY_A1,
  ) => invoices.createDraft(contextFor(tenantId, companyId), POSTER, input);

  /** Posts through a unit of work of its own, which is what the endpoint does around it. */
  const post = (
    customerInvoiceId: string,
    tenantId = TENANT_A,
    companyId = COMPANY_A1,
    userId = POSTER,
  ) =>
    uow.inActorScope(scopeFor(tenantId, companyId, userId), (repos) =>
      postCustomerInvoice(repos, contextFor(tenantId, companyId, userId), { customerInvoiceId }),
    );

  /** One confirmed order and a draft billing all of it, which most tests start from. */
  async function draftOfWholeOrder(
    lines: { quantity: string; unitPrice?: string; discountPercent?: string }[] = [
      { quantity: '10.000000' },
    ],
  ) {
    const order = await confirmedOrder({ lines });
    const draft = await draftFor({ salesOrderIds: [order.id], invoiceDate: '2026-09-16' });
    return { order, draft };
  }

  const invoiceRow = async (id: string, tenantId = TENANT_A, companyId = COMPANY_A1) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      status: string;
      doc_number: string | null;
      version: number;
      total: string;
    }>('SELECT * FROM customer_invoices WHERE id = $1', [id]);
    return rows.rows[0];
  };

  const orderLineRow = async (id: string, tenantId = TENANT_A, companyId = COMPANY_A1) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      quantity: string;
      invoiced_quantity: string;
      delivered_quantity: string;
      version: number;
    }>('SELECT * FROM sales_order_lines WHERE id = $1', [id]);
    return rows.rows[0];
  };

  const journalRows = async (tenantId = TENANT_A, companyId = COMPANY_A1) => {
    await ownerContext(tenantId, companyId);
    const entries = await owner.query<{
      id: string;
      memo: string;
      currency: string;
      entry_date: string;
      source_doc_type: string | null;
      source_doc_id: string | null;
    }>('SELECT * FROM journal_entries');
    const lines = await owner.query<{
      journal_entry_id: string;
      account_id: string;
      debit: string;
      credit: string;
      currency: string;
      line_number: number;
    }>('SELECT * FROM journal_lines ORDER BY line_number');
    return { entries: entries.rows, lines: lines.rows };
  };

  const accountsByPurpose = async (companyId = COMPANY_A1) =>
    uow.inActorScope(scopeFor(TENANT_A, companyId), async (r: ScopedRepositories) => {
      const mappings = await r.postingAccounts.listForCompany();
      return Object.fromEntries(mappings.map((m) => [m.purpose, m.accountId])) as Record<
        string,
        string
      >;
    });

  const auditRows = async (tenantId = TENANT_A, companyId = COMPANY_A1) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      summary: string;
      actor_user_id: string;
      actor_roles: string[];
      request_id: string | null;
      changes: Record<string, unknown>;
      txid: string;
    }>('SELECT * FROM audit_events ORDER BY occurred_at');
    return rows.rows;
  };

  // -------------------------------------------------------------------------------------
  // 1. What a successful posting does.
  // -------------------------------------------------------------------------------------

  describe('a posted invoice', () => {
    it('moves from draft to posted', async () => {
      const { draft } = await draftOfWholeOrder();

      const posted = await post(draft.invoice.id);

      expect(posted.invoice.status).toBe('posted');
      expect((await invoiceRow(draft.invoice.id))?.status).toBe('posted');
    });

    it('is given a number from the company counter', async () => {
      const { draft } = await draftOfWholeOrder();

      const posted = await post(draft.invoice.id);

      expect(posted.invoice.docNumber).toBe('INV-0001');
      expect((await invoiceRow(draft.invoice.id))?.doc_number).toBe('INV-0001');
    });

    it('spends exactly one number, and the next posting takes the next', async () => {
      const first = await draftOfWholeOrder();
      const second = await draftOfWholeOrder();

      await post(first.draft.invoice.id);
      const later = await post(second.draft.invoice.id);

      expect(later.invoice.docNumber).toBe('INV-0002');

      await ownerContext(TENANT_A, COMPANY_A1);
      const counter = await owner.query<{ next_value: string }>(
        `SELECT next_value FROM document_number_sequences WHERE doc_type = 'customer_invoice'`,
      );
      expect(counter.rows[0]?.next_value).toBe('3');
    });

    it('moves the version, so a stale edit of it cannot win', async () => {
      const { draft } = await draftOfWholeOrder();

      const posted = await post(draft.invoice.id);

      expect(posted.invoice.version).toBe(draft.invoice.version + 1);
    });
  });

  // -------------------------------------------------------------------------------------
  // 2. The journal entry.
  // -------------------------------------------------------------------------------------

  describe('the journal entry', () => {
    it('debits receivables, credits revenue and credits tax', async () => {
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('UPDATE companies SET standard_tax_rate_percent = 20 WHERE id = $1', [
        COMPANY_A1,
      ]);
      const { draft } = await draftOfWholeOrder([{ quantity: '10.000000' }]);
      const accounts = await accountsByPurpose();

      await post(draft.invoice.id);

      const { lines } = await journalRows();
      expect(
        lines.map((line) => ({ account: line.account_id, debit: line.debit, credit: line.credit })),
      ).toEqual([
        { account: accounts['accounts_receivable'], debit: '120.0000', credit: '0.0000' },
        { account: accounts['sales_revenue'], debit: '0.0000', credit: '100.0000' },
        { account: accounts['tax_payable'], debit: '0.0000', credit: '20.0000' },
      ]);
    });

    it('balances, which the database would refuse otherwise', async () => {
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('UPDATE companies SET standard_tax_rate_percent = 17.5 WHERE id = $1', [
        COMPANY_A1,
      ]);
      const { draft } = await draftOfWholeOrder([
        { quantity: '3.000000', unitPrice: '19.990000' },
        { quantity: '7.000000', unitPrice: '0.333300', discountPercent: '12.500000' },
      ]);

      await post(draft.invoice.id);

      const { lines } = await journalRows();
      const debits = lines.reduce((sum, line) => sum + Number(line.debit), 0);
      const credits = lines.reduce((sum, line) => sum + Number(line.credit), 0);
      expect(debits).toBeCloseTo(credits, 4);
    });

    it('debits receivables for exactly the invoice total', async () => {
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('UPDATE companies SET standard_tax_rate_percent = 20 WHERE id = $1', [
        COMPANY_A1,
      ]);
      const { draft } = await draftOfWholeOrder([{ quantity: '3.000000', unitPrice: '19.990000' }]);

      const posted = await post(draft.invoice.id);

      const { lines } = await journalRows();
      const receivable = lines.find((line) => Number(line.debit) > 0);
      expect(receivable?.debit).toBe(posted.invoice.total);
      // And the two credits come to the same figure, split between revenue and tax.
      const credited = lines.reduce((sum, line) => sum + Number(line.credit), 0);
      expect(credited).toBeCloseTo(Number(posted.invoice.total), 4);
    });

    it('omits the tax line entirely when the company charges no tax', async () => {
      // A zero line is refused by the constraint in 0014, and a company that charges nothing has
      // nothing to credit. Two lines are the whole of that entry, and it balances.
      const { draft } = await draftOfWholeOrder();

      await post(draft.invoice.id);

      const { lines } = await journalRows();
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => Number(line.debit) + Number(line.credit) > 0)).toBe(true);
    });

    it('carries the invoice currency and date', async () => {
      const { draft } = await draftOfWholeOrder();

      await post(draft.invoice.id);

      const { entries, lines } = await journalRows();
      expect(entries[0]?.currency).toBe('USD');
      expect(entries[0]?.entry_date).toBeInstanceOf(Date);
      expect(lines.every((line) => line.currency === 'USD')).toBe(true);
    });

    it('records the invoice as the document that caused it', async () => {
      // Section 12.4: the edge is stored once, on the entry, which is what makes a posting
      // explainable from the ledger side.
      const { draft } = await draftOfWholeOrder();

      const posted = await post(draft.invoice.id);

      const { entries } = await journalRows();
      expect({
        type: entries[0]?.source_doc_type,
        id: entries[0]?.source_doc_id,
        memo: entries[0]?.memo,
      }).toEqual({
        type: 'customer_invoice',
        id: draft.invoice.id,
        memo: `Customer invoice ${posted.invoice.docNumber}`,
      });
    });

    it('posts to this company own accounts', async () => {
      const own = await accountsByPurpose(COMPANY_A1);
      const { draft } = await draftOfWholeOrder();

      await post(draft.invoice.id);

      const { lines } = await journalRows();
      expect(lines.every((line) => Object.values(own).includes(line.account_id))).toBe(true);
    });

    it('writes exactly one entry per posting', async () => {
      const { draft } = await draftOfWholeOrder();

      await post(draft.invoice.id);

      expect((await journalRows()).entries).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------
  // 3. Quantity, which is the authoritative concurrency point.
  // -------------------------------------------------------------------------------------

  describe('the invoiced quantity', () => {
    it('consumes the whole remainder when the invoice bills all of it', async () => {
      const { order, draft } = await draftOfWholeOrder([{ quantity: '10.000000' }]);

      await post(draft.invoice.id);

      expect((await orderLineRow(order.lineIds[0]!))?.invoiced_quantity).toBe('10.000000');
    });

    it('consumes only what a partial invoice bills', async () => {
      const order = await confirmedOrder({ lines: [{ quantity: '10.000000' }] });
      const draft = await draftFor({
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-16',
        lines: [{ salesOrderLineId: order.lineIds[0]!, quantity: '4.000000' }],
      });

      await post(draft.invoice.id);

      expect((await orderLineRow(order.lineIds[0]!))?.invoiced_quantity).toBe('4.000000');
    });

    it('lets a second invoice bill the rest', async () => {
      const order = await confirmedOrder({ lines: [{ quantity: '10.000000' }] });
      const first = await draftFor({
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-16',
        lines: [{ salesOrderLineId: order.lineIds[0]!, quantity: '4.000000' }],
      });
      await post(first.invoice.id);

      const second = await draftFor({ salesOrderIds: [order.id], invoiceDate: '2026-09-16' });
      await post(second.invoice.id);

      expect((await orderLineRow(order.lineIds[0]!))?.invoiced_quantity).toBe('10.000000');
    });

    it('refuses a posting whose remainder was consumed after the draft was raised', async () => {
      // THE CASE SECTION 12.2 DESCRIBES. Both drafts are legitimate when raised; the second is
      // refused at posting, which is where section 12.2 puts validation against current state.
      const order = await confirmedOrder({ lines: [{ quantity: '10.000000' }] });
      const first = await draftFor({ salesOrderIds: [order.id], invoiceDate: '2026-09-16' });
      const second = await draftFor({ salesOrderIds: [order.id], invoiceDate: '2026-09-16' });

      await post(first.invoice.id);

      await expect(post(second.invoice.id)).rejects.toMatchObject({ reason: 'quantity_exceeded' });
      expect((await orderLineRow(order.lineIds[0]!))?.invoiced_quantity).toBe('10.000000');
    });

    it('reads the stored figure rather than the one the draft was raised from', async () => {
      // The draft was raised when nothing was invoiced. Something else consumed part of the line
      // in between, and posting has to see that rather than the remainder it once computed.
      const order = await confirmedOrder({ lines: [{ quantity: '10.000000' }] });
      const draft = await draftFor({ salesOrderIds: [order.id], invoiceDate: '2026-09-16' });

      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(
        `UPDATE sales_order_lines SET invoiced_quantity = '7.000000' WHERE id = $1`,
        [order.lineIds[0]],
      );

      await expect(post(draft.invoice.id)).rejects.toMatchObject({ reason: 'quantity_exceeded' });
      expect((await orderLineRow(order.lineIds[0]!))?.invoiced_quantity).toBe('7.000000');
    });

    it('leaves the delivered quantity alone', async () => {
      // Section 9.8: quantity movement belongs to the delivery path. Invoicing is not delivering.
      const { order, draft } = await draftOfWholeOrder();

      await post(draft.invoice.id);

      expect((await orderLineRow(order.lineIds[0]!))?.delivered_quantity).toBe('0.000000');
    });

    it('leaves reservations and stock alone', async () => {
      const { draft } = await draftOfWholeOrder();

      await post(draft.invoice.id);

      await ownerContext(TENANT_A, COMPANY_A1);
      const reservations = await owner.query<{ count: string }>(
        'SELECT count(*) FROM stock_reservations',
      );
      const movements = await owner.query<{ count: string }>('SELECT count(*) FROM stock_movements');
      expect([reservations.rows[0]?.count, movements.rows[0]?.count]).toEqual(['0', '0']);
    });

    it('leaves the source order status where it was', async () => {
      // The transition table permits confirmed to cancelled and nothing else. An invoiced status
      // would be a transition nobody declared, and a partially invoiced order is not invoiced.
      const { order, draft } = await draftOfWholeOrder();

      await post(draft.invoice.id);

      await ownerContext(TENANT_A, COMPANY_A1);
      const stored = await owner.query<{ status: string }>(
        'SELECT status FROM sales_orders WHERE id = $1',
        [order.id],
      );
      expect(stored.rows[0]?.status).toBe('confirmed');
    });

    it('consumes every line of a multi line invoice', async () => {
      const { order, draft } = await draftOfWholeOrder([
        { quantity: '2.000000' },
        { quantity: '5.000000' },
      ]);

      await post(draft.invoice.id);

      expect((await orderLineRow(order.lineIds[0]!))?.invoiced_quantity).toBe('2.000000');
      expect((await orderLineRow(order.lineIds[1]!))?.invoiced_quantity).toBe('5.000000');
    });

    it('takes the source lines in canonical lock order, not line order', async () => {
      // Section 10.2. The returned order is the acquisition sequence, and sorting by identifier is
      // what gives two postings sharing lines the same sequence over them.
      const { order, draft } = await draftOfWholeOrder([
        { quantity: '1.000000' },
        { quantity: '2.000000' },
        { quantity: '3.000000' },
      ]);

      const posted = await post(draft.invoice.id);

      expect(posted.consumedLines.map((line) => line.id)).toEqual(
        [...order.lineIds].sort((a, b) => (a < b ? -1 : 1)),
      );
    });
  });

  // -------------------------------------------------------------------------------------
  // 4. Concurrency.
  // -------------------------------------------------------------------------------------

  describe('two postings at once', () => {
    it('lets one consume the remainder and refuses the other', async () => {
      // THE TEST THIS PACKAGE EXISTS FOR. Two drafts, each billing the whole of one line, posted
      // at the same moment. One wins; the other must not double-consume.
      const order = await confirmedOrder({ lines: [{ quantity: '10.000000' }] });
      const first = await draftFor({ salesOrderIds: [order.id], invoiceDate: '2026-09-16' });
      const second = await draftFor({ salesOrderIds: [order.id], invoiceDate: '2026-09-16' });

      const results = await Promise.allSettled([
        post(first.invoice.id),
        post(second.invoice.id),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

      // AND THE LOSER LOST FOR THE RIGHT REASON. A deadlock or a serialization failure would also
      // leave one rejection, and would mean this test was passing while proving nothing about the
      // remainder. The refusal has to be the one section 12.2 describes.
      const rejected = results.find((result) => result.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({
        reason: 'quantity_exceeded',
      });

      // The line was consumed once, and exactly once.
      expect((await orderLineRow(order.lineIds[0]!))?.invoiced_quantity).toBe('10.000000');
      // One invoice posted, one still a draft, and one number spent.
      const { entries } = await journalRows();
      expect(entries).toHaveLength(1);
    });

    it('refuses a consumer whose read happened before the winner committed', async () => {
      // THE DISCRIMINATING CASE, and it exists because the test above does not discriminate on its
      // own. Two postings raced through `Promise.allSettled` almost always interleave so that the
      // loser reads after the winner commits, and an implementation that read the remainder in one
      // statement and consumed it in another passes that test. The difference only shows when the
      // loser's read provably happens first.
      //
      // THE ORDER IS ARRANGED RATHER THAN HOPED FOR, and both transactions are open before either
      // touches the row, so neither can be waiting on a connection while the other waits on it:
      //
      //   1. the loser opens its transaction and says so
      //   2. the winner consumes the whole remainder, taking the row, and says so
      //   3. the loser begins consuming, and blocks on that row
      //   4. the winner commits
      //
      // With the remainder tested inside the consuming statement, PostgreSQL re-evaluates the
      // predicate against the committed row and the loser matches nothing. With a read followed by
      // a write, the loser's read saw the row before the commit, found the whole remainder
      // available, and would consume it a second time.
      const order = await confirmedOrder({ lines: [{ quantity: '10.000000' }] });
      const lineId = order.lineIds[0]!;

      const signal = () => {
        let fire: () => void = () => undefined;
        const waited = new Promise<void>((resolve) => {
          fire = resolve;
        });
        return { fire: () => fire(), waited };
      };

      const loserIsOpen = signal();
      const winnerHasTheRow = signal();

      const loser = uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1), async (repos) => {
        // The transaction is open here, which is the point of signalling from inside it.
        loserIsOpen.fire();
        await winnerHasTheRow.waited;

        // Blocks on the row the winner holds, under the real implementation.
        return repos.salesOrderLines.consumeInvoicedQuantity({
          id: lineId,
          quantity: '10.000000',
        });
      });

      const winner = uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1), async (repos) => {
        await loserIsOpen.waited;
        const consumed = await repos.salesOrderLines.consumeInvoicedQuantity({
          id: lineId,
          quantity: '10.000000',
        });

        winnerHasTheRow.fire();
        // Long enough for the loser's statement to reach the row and wait on it. The transaction
        // commits when this callback returns, which is what releases it.
        await new Promise((resolve) => setTimeout(resolve, 200));
        return consumed;
      });

      const [first, second] = await Promise.all([winner, loser]);

      // One consumed it, the other was refused, and the line holds exactly what was ordered.
      expect([first, second].filter((result) => result !== null)).toHaveLength(1);
      expect((await orderLineRow(lineId))?.invoiced_quantity).toBe('10.000000');
    });

    it('lets both through when together they fit', async () => {
      const order = await confirmedOrder({ lines: [{ quantity: '10.000000' }] });
      const first = await draftFor({
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-16',
        lines: [{ salesOrderLineId: order.lineIds[0]!, quantity: '6.000000' }],
      });
      const second = await draftFor({
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-16',
        lines: [{ salesOrderLineId: order.lineIds[0]!, quantity: '4.000000' }],
      });

      const results = await Promise.allSettled([
        post(first.invoice.id),
        post(second.invoice.id),
      ]);

      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      expect((await orderLineRow(order.lineIds[0]!))?.invoiced_quantity).toBe('10.000000');
    });

    it('spends one number per posting under contention, with no gap', async () => {
      const orders = await Promise.all([
        confirmedOrder({ lines: [{ quantity: '1.000000' }] }),
        confirmedOrder({ lines: [{ quantity: '1.000000' }] }),
        confirmedOrder({ lines: [{ quantity: '1.000000' }] }),
      ]);
      const drafts = [];
      for (const order of orders) {
        drafts.push(await draftFor({ salesOrderIds: [order.id], invoiceDate: '2026-09-16' }));
      }

      const posted = await Promise.all(drafts.map((draft) => post(draft.invoice.id)));

      // Three postings, three consecutive numbers, in whatever order they finished.
      expect(posted.map((each) => each.invoice.docNumber).sort()).toEqual([
        'INV-0001',
        'INV-0002',
        'INV-0003',
      ]);
    });

    it('posts two invoices of one order concurrently without deadlocking', async () => {
      // Two invoices over the same two lines, in opposite line order. Without the canonical lock
      // order this is the textbook deadlock; with it both take the rows in the same sequence.
      const order = await confirmedOrder({
        lines: [{ quantity: '10.000000' }, { quantity: '10.000000' }],
      });
      const first = await draftFor({
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-16',
        lines: [
          { salesOrderLineId: order.lineIds[0]!, quantity: '5.000000' },
          { salesOrderLineId: order.lineIds[1]!, quantity: '5.000000' },
        ],
      });
      const second = await draftFor({
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-16',
        lines: [
          { salesOrderLineId: order.lineIds[1]!, quantity: '5.000000' },
          { salesOrderLineId: order.lineIds[0]!, quantity: '5.000000' },
        ],
      });

      const results = await Promise.allSettled([
        post(first.invoice.id),
        post(second.invoice.id),
      ]);

      // Both fit, so both must succeed. A deadlock would have failed one of them with 40P01.
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect((await orderLineRow(order.lineIds[0]!))?.invoiced_quantity).toBe('10.000000');
      expect((await orderLineRow(order.lineIds[1]!))?.invoiced_quantity).toBe('10.000000');
    });
  });

  // -------------------------------------------------------------------------------------
  // 5. Refusals.
  // -------------------------------------------------------------------------------------

  describe('what posting refuses', () => {
    it('refuses an invoice that is already posted', async () => {
      const { draft } = await draftOfWholeOrder();
      await post(draft.invoice.id);

      await expect(post(draft.invoice.id)).rejects.toThrow(/cannot move from posted to posted/);
    });

    it('refuses a sibling company invoice as though it did not exist', async () => {
      const foreign = await confirmedOrder({ companyId: COMPANY_A2 });
      const draft = await draftFor(
        { salesOrderIds: [foreign.id], invoiceDate: '2026-09-16' },
        TENANT_A,
        COMPANY_A2,
      );

      await expect(post(draft.invoice.id)).rejects.toMatchObject({ reason: 'not_found' });

      expect((await invoiceRow(draft.invoice.id, TENANT_A, COMPANY_A2))?.status).toBe('draft');
    });

    it('refuses another tenant invoice the same way', async () => {
      const foreign = await confirmedOrder({ tenantId: TENANT_B, companyId: COMPANY_B1 });
      const draft = await draftFor(
        { salesOrderIds: [foreign.id], invoiceDate: '2026-09-16' },
        TENANT_B,
        COMPANY_B1,
      );

      await expect(post(draft.invoice.id)).rejects.toMatchObject({ reason: 'not_found' });
    });

    it('refuses an invoice that does not exist', async () => {
      await expect(post(randomUUID())).rejects.toMatchObject({ reason: 'not_found' });
    });

    it('refuses an actor without the capability', async () => {
      const { draft } = await draftOfWholeOrder();

      await expect(post(draft.invoice.id, TENANT_A, COMPANY_A1, CLERK)).rejects.toMatchObject({
        reason: 'forbidden',
      });

      // And nothing was written on the way to that refusal.
      expect((await invoiceRow(draft.invoice.id))?.status).toBe('draft');
      expect((await journalRows()).entries).toEqual([]);
    });

    it('refuses an actor who may raise an invoice but not post one', async () => {
      // THE DISCRIMINATING CASE FOR THE OPERATION'S OWN CHECK. The clerk above holds neither
      // capability, so refusing them proves only that something refused. This actor holds
      // `invoices:create` and not `invoices:post`, which is exactly the pair section 6.2 keeps
      // apart: raising a document and committing it to the ledger are different authorities.
      const { draft } = await draftOfWholeOrder();

      await expect(post(draft.invoice.id, TENANT_A, COMPANY_A1, DRAFTER)).rejects.toMatchObject({
        reason: 'forbidden',
      });

      expect((await invoiceRow(draft.invoice.id))?.status).toBe('draft');
      expect((await journalRows()).entries).toEqual([]);
    });

    it('refuses when a source order was cancelled after the draft was raised', async () => {
      const { order, draft } = await draftOfWholeOrder();
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(`UPDATE sales_orders SET status = 'cancelled' WHERE id = $1`, [order.id]);

      await expect(post(draft.invoice.id)).rejects.toMatchObject({
        reason: 'order_not_invoiceable',
      });
    });

    it('refuses when the customer was archived after the draft was raised', async () => {
      const { draft } = await draftOfWholeOrder();
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(`UPDATE customers SET status = 'archived' WHERE id = $1`, [
        CUSTOMER[COMPANY_A1],
      ]);

      await expect(post(draft.invoice.id)).rejects.toMatchObject({
        reason: 'master_data_unusable',
      });

      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(`UPDATE customers SET status = 'active' WHERE id = $1`, [
        CUSTOMER[COMPANY_A1],
      ]);
    });

    it('refuses when the company standard tax rate moved under the draft', async () => {
      // Section 2.9 makes the rate on a draft a working figure the committing transaction
      // recomputes. Rewriting the amounts while posting would post a total nobody approved, so
      // the caller is told to re-read the draft, which re-derives every line at the new rate.
      const { draft } = await draftOfWholeOrder();
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('UPDATE companies SET standard_tax_rate_percent = 20 WHERE id = $1', [
        COMPANY_A1,
      ]);

      await expect(post(draft.invoice.id)).rejects.toMatchObject({ reason: 'tax_rate_changed' });
      expect((await journalRows()).entries).toEqual([]);
    });

    it('refuses a document whose stored money does not follow from its own inputs', async () => {
      const { draft } = await draftOfWholeOrder();
      await ownerContext(TENANT_A, COMPANY_A1);
      // A tampered line, which nothing in the application can produce: the grants withhold UPDATE
      // on an invoice line, so this is the owning role acting as section 4.1's administrator at a
      // database prompt. Posting must not turn it into a journal entry.
      await owner.query(
        `UPDATE customer_invoices SET total = '999.0000' WHERE id = $1`,
        [draft.invoice.id],
      );

      await expect(post(draft.invoice.id)).rejects.toMatchObject({ reason: 'incoherent_document' });
      expect((await journalRows()).entries).toEqual([]);
    });

    it('refuses an invoice that comes to nothing', async () => {
      // A hundred per cent discount is a figure a salesperson means and the constraint permits, so
      // an invoice whose every line is free is raisable. The entry for it would have no amount on
      // either side, which migration 0014 refuses, so the operation answers with the rule instead
      // of letting a constraint violation reach the caller.
      //
      // The generated cases in `invoice-posting-invariant.int.spec.ts` are what surfaced this.
      const { draft } = await draftOfWholeOrder([
        { quantity: '5.000000', unitPrice: '10.000000', discountPercent: '100.000000' },
      ]);
      expect(draft.invoice.total).toBe('0.0000');

      await expect(post(draft.invoice.id)).rejects.toMatchObject({ reason: 'nothing_to_post' });

      // And nothing was consumed or posted on the way to that refusal.
      expect((await journalRows()).entries).toEqual([]);
      expect((await invoiceRow(draft.invoice.id))?.status).toBe('draft');
    });

    it('refuses when the company has no account for a purpose', async () => {
      const { draft } = await draftOfWholeOrder();
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(
        `DELETE FROM company_posting_accounts WHERE company_id = $1 AND purpose = 'sales_revenue'`,
        [COMPANY_A1],
      );

      await expect(post(draft.invoice.id)).rejects.toMatchObject({
        reason: 'posting_accounts_missing',
      });

      // Put it back for the tests that follow, through the same function provisioning uses.
      await uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1), async (r) => {
        const chart = await provisionChartOfAccounts(r);
        await provisionPostingAccounts(r, chart);
      });
    });
  });

  // -------------------------------------------------------------------------------------
  // 6. Atomicity. Nothing survives a failed posting.
  // -------------------------------------------------------------------------------------

  describe('a posting that fails', () => {
    it('leaves no number spent when it fails after allocation', async () => {
      const { draft } = await draftOfWholeOrder();
      const failure = new Error('posting refused by test');

      await expect(
        uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1), async (repos) => {
          await postCustomerInvoice(repos, contextFor(TENANT_A, COMPANY_A1), {
            customerInvoiceId: draft.invoice.id,
          });
          // Everything the posting did is written but uncommitted at this point.
          throw failure;
        }),
      ).rejects.toBe(failure);

      await ownerContext(TENANT_A, COMPANY_A1);
      const counter = await owner.query<{ next_value: string }>(
        `SELECT next_value FROM document_number_sequences WHERE doc_type = 'customer_invoice'`,
      );
      expect(counter.rows[0]?.next_value).toBe('1');
    });

    it('leaves the invoice a draft with no number', async () => {
      const { draft } = await draftOfWholeOrder();

      await expect(
        uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1), async (repos) => {
          await postCustomerInvoice(repos, contextFor(TENANT_A, COMPANY_A1), {
            customerInvoiceId: draft.invoice.id,
          });
          throw new Error('posting refused by test');
        }),
      ).rejects.toThrow();

      const stored = await invoiceRow(draft.invoice.id);
      expect({ status: stored?.status, number: stored?.doc_number }).toEqual({
        status: 'draft',
        number: null,
      });
    });

    it('leaves the invoiced quantity unconsumed', async () => {
      const { order, draft } = await draftOfWholeOrder();

      await expect(
        uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1), async (repos) => {
          await postCustomerInvoice(repos, contextFor(TENANT_A, COMPANY_A1), {
            customerInvoiceId: draft.invoice.id,
          });
          throw new Error('posting refused by test');
        }),
      ).rejects.toThrow();

      expect((await orderLineRow(order.lineIds[0]!))?.invoiced_quantity).toBe('0.000000');
    });

    it('leaves no journal entry and no audit event', async () => {
      const { draft } = await draftOfWholeOrder();

      await expect(
        uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1), async (repos) => {
          await postCustomerInvoice(repos, contextFor(TENANT_A, COMPANY_A1), {
            customerInvoiceId: draft.invoice.id,
          });
          throw new Error('posting refused by test');
        }),
      ).rejects.toThrow();

      expect((await journalRows()).entries).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it('writes every part of a successful posting in one transaction', async () => {
      // One `xmin` across the invoice, the consumed line, the entry, its lines and the audit row.
      // More than one would mean more than one transaction, and therefore a window in which the
      // ledger and the document disagreed.
      const { order, draft } = await draftOfWholeOrder();

      await post(draft.invoice.id);

      await ownerContext(TENANT_A, COMPANY_A1);
      const written = await owner.query<{ xmin: string }>(
        `SELECT xmin::text AS xmin FROM customer_invoices WHERE id = $1
         UNION
         SELECT xmin::text FROM sales_order_lines WHERE id = $2
         UNION
         SELECT xmin::text FROM journal_entries
         UNION
         SELECT xmin::text FROM journal_lines
         UNION
         SELECT xmin::text FROM audit_events`,
        [draft.invoice.id, order.lineIds[0]],
      );

      expect(written.rows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------
  // 7. The audit record.
  // -------------------------------------------------------------------------------------

  describe('the trail', () => {
    it('records the posting, and only the posting', async () => {
      // Draft creation and editing are unaudited, per section 7.1: document audit begins at the
      // irreversible moment. One event, and it is this one.
      const { draft } = await draftOfWholeOrder();

      const posted = await post(draft.invoice.id);

      const events = await auditRows();
      expect(events).toHaveLength(1);
      expect({
        action: events[0]?.action,
        entity: events[0]?.entity_type,
        id: events[0]?.entity_id,
      }).toEqual({
        action: 'customer_invoice_posted',
        entity: 'customer_invoice',
        id: posted.invoice.id,
      });
    });

    it('names the actor, their roles and the request', async () => {
      // Section 7.3, and none of it invented: the actor is the scope's, the roles are the grants
      // the authorization step read, and the request id is the one the controller passed in.
      const { draft } = await draftOfWholeOrder();

      await post(draft.invoice.id);

      const event = (await auditRows())[0];
      expect({
        actor: event?.actor_user_id,
        roles: event?.actor_roles,
        request: event?.request_id,
      }).toEqual({
        actor: POSTER,
        roles: ['accountant'],
        request: 'req-posting-test',
      });
    });

    it('records what changed, including the number and the entry it wrote', async () => {
      const { order, draft } = await draftOfWholeOrder();

      const posted = await post(draft.invoice.id);

      const event = (await auditRows())[0];
      expect(event?.changes).toEqual({
        status: { from: 'draft', to: 'posted' },
        docNumber: posted.invoice.docNumber,
        total: posted.invoice.total,
        currency: 'USD',
        journalEntryId: posted.journalEntry.entry.id,
        salesOrders: [order.id],
      });
      expect(event?.summary).toContain(posted.invoice.docNumber!);
    });

    it('shares its transaction with the change it describes', async () => {
      // Section 7.1. The audit row's recorded txid against the invoice row's xmin, which is the
      // proof the rest of the trail already uses.
      const { draft } = await draftOfWholeOrder();

      await post(draft.invoice.id);

      await ownerContext(TENANT_A, COMPANY_A1);
      const invoice = await owner.query<{ xmin: string }>(
        'SELECT xmin::text AS xmin FROM customer_invoices WHERE id = $1',
        [draft.invoice.id],
      );
      const event = (await auditRows())[0];

      expect(event?.txid).toBe(invoice.rows[0]?.xmin);
    });
  });

  // -------------------------------------------------------------------------------------
  // 8. What a posted invoice becomes.
  // -------------------------------------------------------------------------------------

  describe('after posting', () => {
    it('cannot be edited', async () => {
      const { order, draft } = await draftOfWholeOrder();
      const posted = await post(draft.invoice.id);

      await expect(
        uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1), (repos) =>
          invoices.updateDraftIn(repos, COMPANY_A1, {
            customerInvoiceId: draft.invoice.id,
            expectedVersion: posted.invoice.version,
            salesOrderIds: [order.id],
            invoiceDate: '2026-09-20',
          }),
        ),
      ).rejects.toMatchObject({ reason: 'not_a_draft' });
    });

    it('reads back with its number, status, totals and source orders', async () => {
      const { order, draft } = await draftOfWholeOrder();
      const posted = await post(draft.invoice.id);

      const view = await invoices.getById(
        contextFor(TENANT_A, COMPANY_A1),
        POSTER,
        draft.invoice.id,
      );

      expect({
        status: view?.status,
        docNumber: view?.docNumber,
        total: view?.total,
        version: view?.version,
        orders: view?.salesOrders.map((each) => each.id),
      }).toEqual({
        status: 'posted',
        docNumber: posted.invoice.docNumber,
        total: posted.invoice.total,
        version: posted.invoice.version,
        orders: [order.id],
      });
    });
  });
});
