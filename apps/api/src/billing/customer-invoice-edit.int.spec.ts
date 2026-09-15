/**
 * Editing a customer invoice draft, and reading one back, against a real PostgreSQL.
 *
 * WHY EDITING IS IN THIS PACKAGE AT ALL. Section 12.2 states that a draft is editable and has no
 * side effects, and the invoice draft is the document where that is the point: which orders to
 * bill together, which of their lines, and how much of each is exactly what somebody decides
 * before posting. Nothing is reserved, owed or posted, so there is nothing to unwind.
 *
 * THE CLAIM UNDER TEST IS SECTION 10.1'S. The version the caller read is part of the write, so two
 * people editing one draft resolve to one winner and the loser is told the invoice moved. A mock
 * cannot prove that: the check is a predicate in an UPDATE, and what makes it correct is that the
 * database evaluates it.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, ConcurrencyConflictError, systemScope, UnitOfWork } from '../database/index.js';
import type { CompanyContext } from '../identity/identity.service.js';
import { CustomerInvoiceService } from './customer-invoice.service.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'b6100000-0000-4000-8000-00000000000a';
const TENANT_B = 'b6200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'b6300000-0000-4000-8000-00000000000a';
const COMPANY_A2 = 'b6400000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'b6500000-0000-4000-8000-00000000000c';
const USER = 'b6600000-0000-4000-8000-00000000000a';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'b7110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b7120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b7130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'b7210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b7220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b7230000-0000-4000-8000-00000000000c',
};
const PRODUCT: Record<string, string> = {
  [COMPANY_A1]: 'b7310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b7320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b7330000-0000-4000-8000-00000000000c',
};

const contextFor = (tenantId: string, companyId: string): CompanyContext =>
  ({ tenantId, companyId }) as CompanyContext;

const scopeFor = (tenantId: string, companyId: string) =>
  actorScope({ tenantId, companyId, userId: USER });

describe('Editing and reading a customer invoice draft', () => {
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
    // Every release runs even if the purge throws, so a failure here cannot leave a client
    // holding locks the next file in a serial run would wait on.
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

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'inv-edit-a',
      'Invoice edit A',
      TENANT_B,
      'inv-edit-b',
      'Invoice edit B',
    ]);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_A }), async (r) => {
      await r.users.create({ id: USER, email: 'edit@company.test', name: 'Ed', passwordHash: 'x' });
      await r.companies.create({ id: COMPANY_A1, name: 'A One', baseCurrency: 'USD' });
      await r.companies.create({ id: COMPANY_A2, name: 'A Two', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_B }), (r) =>
      r.companies.create({ id: COMPANY_B1, name: 'B One', baseCurrency: 'EUR' }),
    );

    for (const [tenantId, companyId] of SCOPES) {
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
      await owner.query('DELETE FROM customer_invoice_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customer_invoices WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [companyId]);
    }
  }

  async function purge(): Promise<void> {
    await clearDocuments();
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM products WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM warehouses WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('DELETE FROM users WHERE id = $1', [USER]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  async function confirmedOrder(
    options: { tenantId?: string; companyId?: string; lines?: { quantity: string }[] } = {},
  ): Promise<{ id: string; lineIds: string[] }> {
    const tenantId = options.tenantId ?? TENANT_A;
    const companyId = options.companyId ?? COMPANY_A1;
    const orderId = randomUUID();
    const lines = options.lines ?? [{ quantity: '10.000000' }];

    await ownerContext(tenantId, companyId);
    await owner.query(
      `INSERT INTO sales_orders
         (id, tenant_id, company_id, status, doc_number, customer_id, warehouse_id, order_date, currency)
       VALUES ($1,$2,$3,'confirmed',$4,$5,$6,current_date,$7)`,
      [
        orderId,
        tenantId,
        companyId,
        `SO-${orderId.slice(0, 4)}`,
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
            product_name, quantity, unit_price, currency)
         VALUES ($1,$2,$3,$4,$5,$6,'SKU-1','A Product',$7,'10.000000',$8)`,
        [
          lineId,
          tenantId,
          companyId,
          orderId,
          index + 1,
          PRODUCT[companyId]!,
          line.quantity,
          companyId === COMPANY_B1 ? 'EUR' : 'USD',
        ],
      );
    }

    return { id: orderId, lineIds };
  }

  const create = (
    input: Parameters<CustomerInvoiceService['createDraft']>[2],
    companyId = COMPANY_A1,
  ) => invoices.createDraft(contextFor(TENANT_A, companyId), USER, input);

  const edit = (
    input: Parameters<CustomerInvoiceService['updateDraftIn']>[2],
    companyId = COMPANY_A1,
  ) =>
    uow.inActorScope(scopeFor(TENANT_A, companyId), (repos) =>
      invoices.updateDraftIn(repos, companyId, input),
    );

  const storedLines = async (companyId = COMPANY_A1) => {
    await ownerContext(TENANT_A, companyId);
    const rows = await owner.query<{
      line_number: number;
      source_sales_order_line_id: string;
      quantity: string;
    }>('SELECT * FROM customer_invoice_lines ORDER BY line_number');
    return rows.rows;
  };

  // -------------------------------------------------------------------------------------
  // 1. Replacing a draft.
  // -------------------------------------------------------------------------------------

  describe('a replacement', () => {
    it('rewrites the lines rather than adding to them', async () => {
      const order = await confirmedOrder({
        lines: [{ quantity: '10.000000' }, { quantity: '4.000000' }],
      });
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await edit({
        customerInvoiceId: draft.invoice.id,
        expectedVersion: draft.invoice.version,
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
        lines: [{ salesOrderLineId: order.lineIds[0]!, quantity: '2.000000' }],
      });

      const lines = await storedLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]?.quantity).toBe('2.000000');
    });

    it('renumbers the lines from one, leaving no gap', async () => {
      const order = await confirmedOrder({
        lines: [{ quantity: '1.000000' }, { quantity: '2.000000' }, { quantity: '3.000000' }],
      });
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await edit({
        customerInvoiceId: draft.invoice.id,
        expectedVersion: draft.invoice.version,
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
        lines: [{ salesOrderLineId: order.lineIds[2]! }, { salesOrderLineId: order.lineIds[1]! }],
      });

      expect((await storedLines()).map((row) => row.line_number)).toEqual([1, 2]);
    });

    it('can add a second order to an invoice that had one', async () => {
      const first = await confirmedOrder();
      const second = await confirmedOrder();
      const draft = await create({ salesOrderIds: [first.id], invoiceDate: '2026-09-15' });

      const edited = await edit({
        customerInvoiceId: draft.invoice.id,
        expectedVersion: draft.invoice.version,
        salesOrderIds: [first.id, second.id],
        invoiceDate: '2026-09-15',
      });

      expect(edited.lines).toHaveLength(2);
      const view = await invoices.getById(contextFor(TENANT_A, COMPANY_A1), USER, draft.invoice.id);
      expect(view?.salesOrders.map((order) => order.id).sort()).toEqual([first.id, second.id].sort());
    });

    it('changes the dates it is given', async () => {
      const order = await confirmedOrder();
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      const edited = await edit({
        customerInvoiceId: draft.invoice.id,
        expectedVersion: draft.invoice.version,
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-20',
        dueDate: '2026-10-20',
      });

      expect({ invoiceDate: edited.invoice.invoiceDate, dueDate: edited.invoice.dueDate }).toEqual({
        invoiceDate: '2026-09-20',
        dueDate: '2026-10-20',
      });
    });

    it('re-sums the totals from the lines it wrote', async () => {
      const order = await confirmedOrder({ lines: [{ quantity: '10.000000' }] });
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });
      expect(draft.invoice.total).toBe('100.0000');

      const edited = await edit({
        customerInvoiceId: draft.invoice.id,
        expectedVersion: draft.invoice.version,
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
        lines: [{ salesOrderLineId: order.lineIds[0]!, quantity: '3.000000' }],
      });

      expect(edited.invoice.total).toBe('30.0000');
    });

    it('keeps the invoice unnumbered and in draft', async () => {
      const order = await confirmedOrder();
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      const edited = await edit({
        customerInvoiceId: draft.invoice.id,
        expectedVersion: draft.invoice.version,
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
      });

      expect({ status: edited.invoice.status, docNumber: edited.invoice.docNumber }).toEqual({
        status: 'draft',
        docNumber: null,
      });
    });

    it('consumes no quantity and writes no journal entry', async () => {
      const order = await confirmedOrder();
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await edit({
        customerInvoiceId: draft.invoice.id,
        expectedVersion: draft.invoice.version,
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
      });

      await ownerContext(TENANT_A, COMPANY_A1);
      const line = await owner.query<{ invoiced_quantity: string }>(
        'SELECT invoiced_quantity FROM sales_order_lines WHERE id = $1',
        [order.lineIds[0]],
      );
      const entries = await owner.query<{ count: string }>('SELECT count(*) FROM journal_entries');
      expect(line.rows[0]?.invoiced_quantity).toBe('0.000000');
      expect(entries.rows[0]?.count).toBe('0');
    });

    it('records no audit event, as creation does not', async () => {
      const order = await confirmedOrder();
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await edit({
        customerInvoiceId: draft.invoice.id,
        expectedVersion: draft.invoice.version,
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
      });

      await ownerContext(TENANT_A, COMPANY_A1);
      const events = await owner.query<{ count: string }>(
        `SELECT count(*) FROM audit_events WHERE entity_type = 'customer_invoice'`,
      );
      expect(events.rows[0]?.count).toBe('0');
    });
  });

  // -------------------------------------------------------------------------------------
  // 2. Optimistic locking, per section 10.1.
  // -------------------------------------------------------------------------------------

  describe('the version', () => {
    it('increments by exactly one on a successful edit', async () => {
      const order = await confirmedOrder();
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      const edited = await edit({
        customerInvoiceId: draft.invoice.id,
        expectedVersion: draft.invoice.version,
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-16',
      });

      expect(edited.invoice.version).toBe(draft.invoice.version + 1);
    });

    it('refuses a stale one, and the refusal is a conflict', async () => {
      const order = await confirmedOrder();
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });
      await edit({
        customerInvoiceId: draft.invoice.id,
        expectedVersion: draft.invoice.version,
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-16',
      });

      await expect(
        edit({
          customerInvoiceId: draft.invoice.id,
          expectedVersion: draft.invoice.version,
          salesOrderIds: [order.id],
          invoiceDate: '2026-09-17',
        }),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    });

    it('leaves the invoice exactly as it was when an edit is refused', async () => {
      // The loser removes nothing. Its update matched no row, it threw, and the transaction that
      // would have replaced the lines never committed.
      const order = await confirmedOrder({
        lines: [{ quantity: '10.000000' }, { quantity: '4.000000' }],
      });
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });
      const winner = await edit({
        customerInvoiceId: draft.invoice.id,
        expectedVersion: draft.invoice.version,
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-16',
      });

      await expect(
        edit({
          customerInvoiceId: draft.invoice.id,
          expectedVersion: draft.invoice.version,
          salesOrderIds: [order.id],
          invoiceDate: '2026-09-17',
          lines: [{ salesOrderLineId: order.lineIds[0]!, quantity: '1.000000' }],
        }),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);

      const after = await invoices.getById(
        contextFor(TENANT_A, COMPANY_A1),
        USER,
        draft.invoice.id,
      );
      expect(after?.invoiceDate).toBe('2026-09-16');
      expect(after?.version).toBe(winner.invoice.version);
      expect(after?.lines).toHaveLength(2);
    });

    it('lets only one of two concurrent edits win', async () => {
      const order = await confirmedOrder();
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      const results = await Promise.allSettled([
        edit({
          customerInvoiceId: draft.invoice.id,
          expectedVersion: draft.invoice.version,
          salesOrderIds: [order.id],
          invoiceDate: '2026-09-16',
        }),
        edit({
          customerInvoiceId: draft.invoice.id,
          expectedVersion: draft.invoice.version,
          salesOrderIds: [order.id],
          invoiceDate: '2026-09-17',
        }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

      // And the loser's lines are not in the document either: one winner, one document.
      expect(await storedLines()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------
  // 3. What an edit may not reach.
  // -------------------------------------------------------------------------------------

  describe('scope and state', () => {
    it('cannot edit a sibling company invoice, which answers as not found', async () => {
      const foreign = await confirmedOrder({ companyId: COMPANY_A2 });
      const draft = await create(
        { salesOrderIds: [foreign.id], invoiceDate: '2026-09-15' },
        COMPANY_A2,
      );

      await expect(
        edit({
          customerInvoiceId: draft.invoice.id,
          expectedVersion: draft.invoice.version,
          salesOrderIds: [foreign.id],
          invoiceDate: '2026-09-16',
        }),
      ).rejects.toMatchObject({ reason: 'invoice_not_found' });

      // And the other company's invoice is untouched.
      const after = await invoices.getById(
        contextFor(TENANT_A, COMPANY_A2),
        USER,
        draft.invoice.id,
      );
      expect(after?.invoiceDate).toBe('2026-09-15');
    });

    it('cannot pull a sibling company order into an edit', async () => {
      const own = await confirmedOrder();
      const foreign = await confirmedOrder({ companyId: COMPANY_A2 });
      const draft = await create({ salesOrderIds: [own.id], invoiceDate: '2026-09-15' });

      await expect(
        edit({
          customerInvoiceId: draft.invoice.id,
          expectedVersion: draft.invoice.version,
          salesOrderIds: [own.id, foreign.id],
          invoiceDate: '2026-09-15',
        }),
      ).rejects.toMatchObject({ reason: 'order_not_found' });

      expect(await storedLines()).toHaveLength(1);
    });

    it('cannot edit a posted invoice', async () => {
      // Nothing posts yet, so the state is written directly. Section 12.3 makes a posted document
      // immutable, and the edit has to refuse it whether or not a posting path exists.
      const order = await confirmedOrder();
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(
        `UPDATE customer_invoices SET status = 'posted', doc_number = 'INV-0001' WHERE id = $1`,
        [draft.invoice.id],
      );

      await expect(
        edit({
          customerInvoiceId: draft.invoice.id,
          expectedVersion: draft.invoice.version,
          salesOrderIds: [order.id],
          invoiceDate: '2026-09-16',
        }),
      ).rejects.toMatchObject({ reason: 'not_a_draft' });
    });

    it('refuses an edit that would empty the invoice', async () => {
      const order = await confirmedOrder();
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await expect(
        edit({
          customerInvoiceId: draft.invoice.id,
          expectedVersion: draft.invoice.version,
          salesOrderIds: [],
          invoiceDate: '2026-09-15',
        }),
      ).rejects.toMatchObject({ reason: 'no_sources' });

      expect(await storedLines()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------
  // 4. Reading one back.
  // -------------------------------------------------------------------------------------

  describe('reading an invoice', () => {
    it('answers with the document, its lines and the orders behind them', async () => {
      const order = await confirmedOrder({ lines: [{ quantity: '2.000000' }] });
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      const view = await invoices.getById(contextFor(TENANT_A, COMPANY_A1), USER, draft.invoice.id);

      expect(view?.status).toBe('draft');
      expect(view?.docNumber).toBeNull();
      expect(view?.lines).toHaveLength(1);
      expect(view?.salesOrders.map((each) => each.id)).toEqual([order.id]);
      expect(view?.customer.id).toBe(CUSTOMER[COMPANY_A1]);
    });

    it('carries the version a later edit has to quote', async () => {
      const order = await confirmedOrder();
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      const view = await invoices.getById(contextFor(TENANT_A, COMPANY_A1), USER, draft.invoice.id);

      expect(view?.version).toBe(draft.invoice.version);
    });

    it('answers nothing for a sibling company invoice', async () => {
      const foreign = await confirmedOrder({ companyId: COMPANY_A2 });
      const draft = await create(
        { salesOrderIds: [foreign.id], invoiceDate: '2026-09-15' },
        COMPANY_A2,
      );

      const view = await invoices.getById(contextFor(TENANT_A, COMPANY_A1), USER, draft.invoice.id);

      // Section 6.1: null rather than an error, so an identifier cannot be probed.
      expect(view).toBeNull();
    });

    it('answers nothing for another tenant invoice', async () => {
      const foreign = await confirmedOrder({ tenantId: TENANT_B, companyId: COMPANY_B1 });
      const draft = await invoices.createDraft(contextFor(TENANT_B, COMPANY_B1), USER, {
        salesOrderIds: [foreign.id],
        invoiceDate: '2026-09-15',
      });

      const view = await invoices.getById(contextFor(TENANT_A, COMPANY_A1), USER, draft.invoice.id);

      expect(view).toBeNull();
    });

    it('answers nothing for an invoice that does not exist', async () => {
      const view = await invoices.getById(contextFor(TENANT_A, COMPANY_A1), USER, randomUUID());

      expect(view).toBeNull();
    });

    it('names each source order once, however many lines cite it', async () => {
      const order = await confirmedOrder({
        lines: [{ quantity: '1.000000' }, { quantity: '2.000000' }],
      });
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      const view = await invoices.getById(contextFor(TENANT_A, COMPANY_A1), USER, draft.invoice.id);

      expect(view?.lines).toHaveLength(2);
      expect(view?.salesOrders).toHaveLength(1);
    });

    it('carries the source order number the posting document will cite', async () => {
      const order = await confirmedOrder();
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      const view = await invoices.getById(contextFor(TENANT_A, COMPANY_A1), USER, draft.invoice.id);

      expect(view?.salesOrders[0]?.docNumber).toMatch(/^SO-/);
    });

    it('carries the customer tax registration number a legal invoice prints', async () => {
      await uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1), async () => undefined);
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('UPDATE customers SET tax_registration_number = $1 WHERE id = $2', [
        'FR987654321',
        CUSTOMER[COMPANY_A1],
      ]);
      const order = await confirmedOrder();
      const draft = await create({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      const view = await invoices.getById(contextFor(TENANT_A, COMPANY_A1), USER, draft.invoice.id);

      expect(view?.customer.taxRegistrationNumber).toBe('FR987654321');

      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('UPDATE customers SET tax_registration_number = NULL WHERE id = $1', [
        CUSTOMER[COMPANY_A1],
      ]);
    });
  });
});
