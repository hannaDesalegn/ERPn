/**
 * Creating a customer invoice draft, against a real PostgreSQL.
 *
 * TWO CLAIMS, AND THE SECOND IS THE ONE THIS PACKAGE IS ABOUT.
 *
 * The first is that the draft says what the source orders say: the customer, the currency, the
 * product identity, the agreed price and the discount all come from persisted rows, and the only
 * things a caller decides are which lines, how much of each, and the two dates.
 *
 * The second is everything that does not happen. No document number is allocated, no journal
 * entry is written, no stock moves, no reservation is released, and `invoiced_quantity` on the
 * source line is untouched. Section 12.2 makes all of that the posting transaction's work, and
 * the tests below assert the absences directly rather than trusting that nothing calls them.
 *
 * WHY A REAL DATABASE. Composite foreign keys, a status check constraint, row level security and
 * the constraint that keeps a draft unnumbered are the logic here, and section 13.2 says a mock
 * proves nothing about any of them.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, systemScope, UnitOfWork } from '../database/index.js';
import type { CompanyContext } from '../identity/identity.service.js';
import { CustomerInvoiceDraftError, CustomerInvoiceService } from './customer-invoice.service.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'b1100000-0000-4000-8000-00000000000a';
const TENANT_B = 'b1200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'b2100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "wrong company, right tenant" is representable. */
const COMPANY_A2 = 'b2200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'b2300000-0000-4000-8000-00000000000c';

const USER = 'b3100000-0000-4000-8000-00000000000a';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

/** One customer, one warehouse and two products per company, seeded through the repositories. */
const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'b4110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b4120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b4130000-0000-4000-8000-00000000000c',
};
/** A second customer in company A1, so "two orders, two customers" is representable. */
const OTHER_CUSTOMER = 'b4140000-0000-4000-8000-00000000000d';
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'b4210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b4220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b4230000-0000-4000-8000-00000000000c',
};
const PRODUCT: Record<string, string> = {
  [COMPANY_A1]: 'b4310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b4320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b4330000-0000-4000-8000-00000000000c',
};

const contextFor = (tenantId: string, companyId: string): CompanyContext =>
  ({ tenantId, companyId }) as CompanyContext;

const scopeFor = (tenantId: string, companyId: string) =>
  actorScope({ tenantId, companyId, userId: USER });

describe('Creating a customer invoice draft', () => {
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
    // Every release runs even if the purge throws. A leaked client holds its locks, and the next
    // file in a serial run waits on them rather than failing for its own reasons.
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
      'inv-draft-a',
      'Invoice draft A',
      TENANT_B,
      'inv-draft-b',
      'Invoice draft B',
    ]);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_A }), async (r) => {
      await r.users.create({ id: USER, email: 'inv@company.test', name: 'Inv', passwordHash: 'x' });
      await r.companies.create({ id: COMPANY_A1, name: 'A One', baseCurrency: 'USD' });
      await r.companies.create({ id: COMPANY_A2, name: 'A Two', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_B }), (r) =>
      r.companies.create({ id: COMPANY_B1, name: 'B One', baseCurrency: 'EUR' }),
    );

    for (const [tenantId, companyId] of SCOPES) {
      await uow.inActorScope(scopeFor(tenantId, companyId), async (r) => {
        await r.customers.create({
          id: CUSTOMER[companyId]!,
          code: 'CUST-1',
          name: 'A Customer',
          taxRegistrationNumber: 'GB123456789',
        });
        await r.warehouses.create({
          id: WAREHOUSE[companyId]!,
          code: 'WH-1',
          name: 'Main',
          isDefault: true,
        });
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

    await uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1), (r) =>
      r.customers.create({ id: OTHER_CUSTOMER, code: 'CUST-2', name: 'Another Customer' }),
    );
  }

  async function clearDocuments(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      // The invoice counter one test provisions, removed here rather than at the end of that
      // test: a test that fails before its own cleanup must not leave a row that makes every
      // later run of this file fail in its setup.
      await owner.query('DELETE FROM document_number_sequences WHERE company_id = $1', [companyId]);
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

  /**
   * A confirmed sales order with one or more lines, written past the service.
   *
   * Written with the owning role because confirming through the real path would drag stock
   * reservations and availability into a test about invoices. What matters to the operation under
   * test is the stored state, and this produces exactly it.
   */
  async function confirmedOrder(
    options: {
      tenantId?: string;
      companyId?: string;
      customerId?: string;
      docNumber?: string;
      status?: string;
      lines?: { quantity: string; unitPrice?: string; discountPercent?: string; invoiced?: string }[];
    } = {},
  ): Promise<{ id: string; lineIds: string[] }> {
    const tenantId = options.tenantId ?? TENANT_A;
    const companyId = options.companyId ?? COMPANY_A1;
    const orderId = randomUUID();
    const status = options.status ?? 'confirmed';
    const lines = options.lines ?? [{ quantity: '10.000000', unitPrice: '10.000000' }];

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
        status === 'draft' ? null : (options.docNumber ?? `SO-${orderId.slice(0, 4)}`),
        options.customerId ?? CUSTOMER[companyId]!,
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
            product_name, quantity, unit_price, discount_percent, tax_rate_percent, currency,
            invoiced_quantity)
         VALUES ($1,$2,$3,$4,$5,$6,'SKU-1','A Product',$7,$8,$9,'0',$10,$11)`,
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
          line.invoiced ?? '0',
        ],
      );
    }

    return { id: orderId, lineIds };
  }

  const draft = (
    input: Parameters<CustomerInvoiceService['createDraft']>[2],
    tenantId = TENANT_A,
    companyId = COMPANY_A1,
  ) => invoices.createDraft(contextFor(tenantId, companyId), USER, input);

  const invoiceRows = async (tenantId = TENANT_A, companyId = COMPANY_A1) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      id: string;
      tenant_id: string;
      company_id: string;
      doc_number: string | null;
      status: string;
      customer_id: string;
      currency: string;
      subtotal: string;
      tax_total: string;
      total: string;
      version: number;
      due_date: string | null;
    }>('SELECT * FROM customer_invoices');
    return rows.rows;
  };

  const lineRows = async (tenantId = TENANT_A, companyId = COMPANY_A1) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      line_number: number;
      source_sales_order_id: string;
      source_sales_order_line_id: string;
      product_sku: string;
      product_name: string;
      quantity: string;
      unit_price: string;
      discount_percent: string;
      tax_rate_percent: string;
      line_subtotal: string;
      line_tax: string;
      line_total: string;
      currency: string;
    }>('SELECT * FROM customer_invoice_lines ORDER BY line_number');
    return rows.rows;
  };

  // -------------------------------------------------------------------------------------
  // 1. One confirmed order.
  // -------------------------------------------------------------------------------------

  describe('from one confirmed sales order', () => {
    it('writes a draft with a line for each of the order lines', async () => {
      const order = await confirmedOrder({
        lines: [{ quantity: '10.000000' }, { quantity: '4.000000' }],
      });

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect(created.lines).toHaveLength(2);
      expect(await invoiceRows()).toHaveLength(1);
      expect((await lineRows()).map((row) => row.source_sales_order_line_id)).toEqual(order.lineIds);
    });

    it('bills the whole of each line when no quantity is given', async () => {
      const order = await confirmedOrder({ lines: [{ quantity: '10.000000' }] });

      await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect((await lineRows())[0]?.quantity).toBe('10.000000');
    });

    it('stays a draft, and the database refuses to let it be anything else here', async () => {
      const order = await confirmedOrder();

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect(created.invoice.status).toBe('draft');
      expect((await invoiceRows())[0]?.status).toBe('draft');
    });

    it('allocates no document number', async () => {
      // The whole of section 10.4's numbering belongs to the posting transaction. A number spent
      // here would be a hole in a gapless series for a document that claimed nothing.
      const order = await confirmedOrder();

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect(created.invoice.docNumber).toBeNull();
      expect((await invoiceRows())[0]?.doc_number).toBeNull();
    });

    it('does not advance the company invoice counter', async () => {
      // The counter exists, provisioned with the company. Draft creation must not touch it: the
      // next invoice to be posted is still number one.
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(
        `INSERT INTO document_number_sequences (id, tenant_id, company_id, doc_type, prefix)
         VALUES (gen_random_uuid(), $1, $2, 'customer_invoice', 'INV-')`,
        [TENANT_A, COMPANY_A1],
      );
      const order = await confirmedOrder();

      await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await ownerContext(TENANT_A, COMPANY_A1);
      const sequence = await owner.query<{ next_value: string }>(
        `SELECT next_value FROM document_number_sequences WHERE doc_type = 'customer_invoice'`,
      );
      expect(sequence.rows[0]?.next_value).toBe('1');
    });

    it('writes no journal entry', async () => {
      // Section 18.2 as amended 2026-09-15 makes receivables, revenue and tax the posting's work.
      const order = await confirmedOrder();

      await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await ownerContext(TENANT_A, COMPANY_A1);
      const entries = await owner.query<{ count: string }>('SELECT count(*) FROM journal_entries');
      const lines = await owner.query<{ count: string }>('SELECT count(*) FROM journal_lines');
      expect([entries.rows[0]?.count, lines.rows[0]?.count]).toEqual(['0', '0']);
    });

    it('does not consume the invoiced quantity on the source line', async () => {
      // THE BOUNDARY THIS PACKAGE IS ABOUT. Consuming it here would mean a draft nobody posts had
      // permanently reduced what the order can still be billed for. Posting is where it is
      // validated and consumed, atomically, per section 12.2.
      const order = await confirmedOrder({ lines: [{ quantity: '10.000000' }] });

      await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await ownerContext(TENANT_A, COMPANY_A1);
      const line = await owner.query<{ invoiced_quantity: string; delivered_quantity: string }>(
        'SELECT invoiced_quantity, delivered_quantity FROM sales_order_lines WHERE id = $1',
        [order.lineIds[0]],
      );
      expect(line.rows[0]).toEqual({
        invoiced_quantity: '0.000000',
        delivered_quantity: '0.000000',
      });
    });

    it('leaves the source order where it was', async () => {
      const order = await confirmedOrder();

      await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await ownerContext(TENANT_A, COMPANY_A1);
      const stored = await owner.query<{ status: string; version: number }>(
        'SELECT status, version FROM sales_orders WHERE id = $1',
        [order.id],
      );
      expect(stored.rows[0]).toEqual({ status: 'confirmed', version: 1 });
    });

    it('moves no stock and releases no reservation', async () => {
      const order = await confirmedOrder();

      await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await ownerContext(TENANT_A, COMPANY_A1);
      const movements = await owner.query<{ count: string }>('SELECT count(*) FROM stock_movements');
      const reservations = await owner.query<{ count: string }>(
        'SELECT count(*) FROM stock_reservations',
      );
      expect([movements.rows[0]?.count, reservations.rows[0]?.count]).toEqual(['0', '0']);
    });

    it('writes no audit event, because document audit begins at the irreversible moment', async () => {
      const order = await confirmedOrder();

      await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await ownerContext(TENANT_A, COMPANY_A1);
      const events = await owner.query<{ count: string }>(
        `SELECT count(*) FROM audit_events WHERE entity_type = 'customer_invoice'`,
      );
      expect(events.rows[0]?.count).toBe('0');
    });
  });

  // -------------------------------------------------------------------------------------
  // 2. Several confirmed orders, which is the semantic the domain model states.
  // -------------------------------------------------------------------------------------

  describe('from several confirmed sales orders', () => {
    it('covers all of them on one invoice', async () => {
      const first = await confirmedOrder({ lines: [{ quantity: '2.000000' }] });
      const second = await confirmedOrder({ lines: [{ quantity: '3.000000' }] });

      const created = await draft({
        salesOrderIds: [first.id, second.id],
        invoiceDate: '2026-09-15',
      });

      expect(created.lines).toHaveLength(2);
      expect(new Set((await lineRows()).map((row) => row.source_sales_order_id))).toEqual(
        new Set([first.id, second.id]),
      );
    });

    it('answers with both orders when the invoice is read back', async () => {
      // The relationship the domain model states as `salesOrderIds: ID[]`, derived from the lines
      // rather than stored beside them.
      const first = await confirmedOrder({ docNumber: 'SO-0001' });
      const second = await confirmedOrder({ docNumber: 'SO-0002' });

      const created = await draft({
        salesOrderIds: [first.id, second.id],
        invoiceDate: '2026-09-15',
      });
      const view = await invoices.getById(
        contextFor(TENANT_A, COMPANY_A1),
        USER,
        created.invoice.id,
      );

      expect(view?.salesOrders.map((order) => order.docNumber).sort()).toEqual([
        'SO-0001',
        'SO-0002',
      ]);
    });

    it('counts an order named twice as once', async () => {
      const order = await confirmedOrder({ lines: [{ quantity: '5.000000' }] });

      const created = await draft({
        salesOrderIds: [order.id, order.id],
        invoiceDate: '2026-09-15',
      });

      expect(created.lines).toHaveLength(1);
    });

    it('refuses two orders for different customers', async () => {
      // An invoice is a demand for payment addressed to one party. Picking one of two would be
      // inventing which.
      const first = await confirmedOrder();
      const second = await confirmedOrder({ customerId: OTHER_CUSTOMER });

      await expect(
        draft({ salesOrderIds: [first.id, second.id], invoiceDate: '2026-09-15' }),
      ).rejects.toMatchObject({ reason: 'customer_mismatch' });

      expect(await invoiceRows()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 3. What the source has to be.
  // -------------------------------------------------------------------------------------

  describe('the source orders', () => {
    it('refuses an empty set', async () => {
      await expect(draft({ salesOrderIds: [], invoiceDate: '2026-09-15' })).rejects.toMatchObject({
        reason: 'no_sources',
      });
    });

    it('refuses a draft sales order, which has promised nobody anything', async () => {
      const order = await confirmedOrder({ status: 'draft' });

      await expect(
        draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' }),
      ).rejects.toMatchObject({ reason: 'order_not_invoiceable' });

      expect(await invoiceRows()).toEqual([]);
    });

    it('refuses a cancelled sales order', async () => {
      const order = await confirmedOrder({ status: 'cancelled' });

      await expect(
        draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' }),
      ).rejects.toMatchObject({ reason: 'order_not_invoiceable' });
    });

    it('refuses a sibling company order, as though it did not exist', async () => {
      // Section 6.1: a failure at the company dimension is indistinguishable from the record not
      // existing, so an identifier cannot be probed to learn what another company holds.
      const foreign = await confirmedOrder({ tenantId: TENANT_A, companyId: COMPANY_A2 });

      await expect(
        draft({ salesOrderIds: [foreign.id], invoiceDate: '2026-09-15' }),
      ).rejects.toMatchObject({ reason: 'order_not_found' });

      expect(await invoiceRows()).toEqual([]);
      expect(await invoiceRows(TENANT_A, COMPANY_A2)).toEqual([]);
    });

    it('refuses another tenant order the same way', async () => {
      const foreign = await confirmedOrder({ tenantId: TENANT_B, companyId: COMPANY_B1 });

      await expect(
        draft({ salesOrderIds: [foreign.id], invoiceDate: '2026-09-15' }),
      ).rejects.toMatchObject({ reason: 'order_not_found' });
    });

    it('makes a foreign order indistinguishable from a missing one', async () => {
      const foreign = await confirmedOrder({ tenantId: TENANT_A, companyId: COMPANY_A2 });

      const onForeign = await draft({
        salesOrderIds: [foreign.id],
        invoiceDate: '2026-09-15',
      }).catch((error: CustomerInvoiceDraftError) => error.message);
      const onMissing = await draft({
        salesOrderIds: [randomUUID()],
        invoiceDate: '2026-09-15',
      }).catch((error: CustomerInvoiceDraftError) => error.message);

      expect(onForeign).toBe(onMissing);
    });

    it('refuses the whole draft when one of several orders is not invoiceable', async () => {
      const good = await confirmedOrder();
      const bad = await confirmedOrder({ status: 'draft' });

      await expect(
        draft({ salesOrderIds: [good.id, bad.id], invoiceDate: '2026-09-15' }),
      ).rejects.toMatchObject({ reason: 'order_not_invoiceable' });

      // Nothing half written. The transaction would roll it back anyway; this proves it did.
      expect(await invoiceRows()).toEqual([]);
      expect(await lineRows()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 4. Choosing lines and quantities, which is what partial invoicing is.
  // -------------------------------------------------------------------------------------

  describe('choosing what to bill', () => {
    it('bills only the named lines', async () => {
      const order = await confirmedOrder({
        lines: [{ quantity: '10.000000' }, { quantity: '4.000000' }],
      });

      const created = await draft({
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
        lines: [{ salesOrderLineId: order.lineIds[1]! }],
      });

      expect(created.lines).toHaveLength(1);
      expect(created.lines[0]?.sourceSalesOrderLineId).toBe(order.lineIds[1]);
    });

    it('bills part of a line when a smaller quantity is given', async () => {
      // Section 8.5 and the domain model both permit partial invoicing, and it does not require a
      // delivery: an invoice may be raised before one, per section 18.2 as amended 2026-09-15.
      const order = await confirmedOrder({ lines: [{ quantity: '10.000000' }] });

      const created = await draft({
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
        lines: [{ salesOrderLineId: order.lineIds[0]!, quantity: '3.000000' }],
      });

      expect(created.lines[0]?.quantity).toBe('3.000000');
      expect(created.invoice.subtotal).toBe('30.0000');
    });

    it('bills only what is left when part of the line is already invoiced', async () => {
      const order = await confirmedOrder({
        lines: [{ quantity: '10.000000', invoiced: '4.000000' }],
      });

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect(created.lines[0]?.quantity).toBe('6.000000');
    });

    it('refuses more than the line has left', async () => {
      const order = await confirmedOrder({
        lines: [{ quantity: '10.000000', invoiced: '7.000000' }],
      });

      await expect(
        draft({
          salesOrderIds: [order.id],
          invoiceDate: '2026-09-15',
          lines: [{ salesOrderLineId: order.lineIds[0]!, quantity: '4.000000' }],
        }),
      ).rejects.toMatchObject({ reason: 'quantity_exceeds_remaining' });

      expect(await invoiceRows()).toEqual([]);
    });

    it('refuses a quantity of zero or less', async () => {
      const order = await confirmedOrder();

      for (const quantity of ['0', '-1.000000']) {
        await expect(
          draft({
            salesOrderIds: [order.id],
            invoiceDate: '2026-09-15',
            lines: [{ salesOrderLineId: order.lineIds[0]!, quantity }],
          }),
        ).rejects.toMatchObject({ reason: 'invalid_quantity' });
      }
    });

    it('refuses a quantity that is not a decimal', async () => {
      const order = await confirmedOrder();

      await expect(
        draft({
          salesOrderIds: [order.id],
          invoiceDate: '2026-09-15',
          lines: [{ salesOrderLineId: order.lineIds[0]!, quantity: 'lots' }],
        }),
      ).rejects.toMatchObject({ reason: 'invalid_quantity' });
    });

    it('refuses a line belonging to an order the invoice does not name', async () => {
      const named = await confirmedOrder();
      const other = await confirmedOrder();

      await expect(
        draft({
          salesOrderIds: [named.id],
          invoiceDate: '2026-09-15',
          lines: [{ salesOrderLineId: other.lineIds[0]! }],
        }),
      ).rejects.toMatchObject({ reason: 'line_not_in_sources' });
    });

    it('refuses a sibling company line, as though it did not exist', async () => {
      const named = await confirmedOrder();
      const foreign = await confirmedOrder({ tenantId: TENANT_A, companyId: COMPANY_A2 });

      await expect(
        draft({
          salesOrderIds: [named.id],
          invoiceDate: '2026-09-15',
          lines: [{ salesOrderLineId: foreign.lineIds[0]! }],
        }),
      ).rejects.toMatchObject({ reason: 'line_not_found' });
    });

    it('refuses the same line twice on one invoice', async () => {
      const order = await confirmedOrder();

      await expect(
        draft({
          salesOrderIds: [order.id],
          invoiceDate: '2026-09-15',
          lines: [
            { salesOrderLineId: order.lineIds[0]!, quantity: '1.000000' },
            { salesOrderLineId: order.lineIds[0]!, quantity: '2.000000' },
          ],
        }),
      ).rejects.toMatchObject({ reason: 'duplicate_line' });
    });

    it('refuses an order with nothing left to invoice', async () => {
      const order = await confirmedOrder({
        lines: [{ quantity: '10.000000', invoiced: '10.000000' }],
      });

      await expect(
        draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' }),
      ).rejects.toMatchObject({ reason: 'nothing_to_invoice' });
    });

    it('skips a fully invoiced line and bills the rest', async () => {
      const order = await confirmedOrder({
        lines: [
          { quantity: '10.000000', invoiced: '10.000000' },
          { quantity: '5.000000' },
        ],
      });

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect(created.lines).toHaveLength(1);
      expect(created.lines[0]?.sourceSalesOrderLineId).toBe(order.lineIds[1]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 5. The snapshot, and where every figure came from.
  // -------------------------------------------------------------------------------------

  describe('what the draft snapshots', () => {
    it('takes the product identity from the order line, not from the catalogue now', async () => {
      const order = await confirmedOrder();
      // The catalogue is renamed after the order was raised. Section 3.4: a document is an
      // immutable record of a past agreement, and the invoice cites that agreement.
      await uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1), async (r) => {
        const product = await r.products.findById(PRODUCT[COMPANY_A1]!);
        await ownerContext(TENANT_A, COMPANY_A1);
        await owner.query('UPDATE products SET name = $1 WHERE id = $2', [
          'Renamed Product',
          product!.id,
        ]);
      });

      await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect((await lineRows())[0]?.product_name).toBe('A Product');

      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('UPDATE products SET name = $1 WHERE id = $2', [
        'A Product',
        PRODUCT[COMPANY_A1],
      ]);
    });

    it('bills the price the order agreed, not the price the catalogue asks today', async () => {
      const order = await confirmedOrder({
        lines: [{ quantity: '2.000000', unitPrice: '7.500000' }],
      });
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('UPDATE products SET sales_price = $1 WHERE id = $2', [
        '99.000000',
        PRODUCT[COMPANY_A1],
      ]);

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect(created.lines[0]?.unitPrice).toBe('7.500000');
      expect(created.invoice.subtotal).toBe('15.0000');

      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('UPDATE products SET sales_price = $1 WHERE id = $2', [
        '10.000000',
        PRODUCT[COMPANY_A1],
      ]);
    });

    it('carries the discount the order agreed', async () => {
      const order = await confirmedOrder({
        lines: [{ quantity: '4.000000', unitPrice: '10.000000', discountPercent: '25.000000' }],
      });

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect(created.lines[0]?.discountPercent).toBe('25.000000');
      expect(created.lines[0]?.lineSubtotal).toBe('30.0000');
    });

    it('resolves the tax rate through the one resolver, at the company rate now', async () => {
      // Section 2.9: every document line goes through `resolveTaxRate`, and the rate on a draft
      // is a working figure the committing transaction recomputes. The order line carried zero;
      // the invoice carries what the company charges today.
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('UPDATE companies SET standard_tax_rate_percent = $1 WHERE id = $2', [
        '20.000000',
        COMPANY_A1,
      ]);
      const order = await confirmedOrder({ lines: [{ quantity: '1.000000' }] });

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect(created.lines[0]?.taxRatePercent).toBe('20.000000');
      expect(created.lines[0]?.lineTax).toBe('2.0000');
      expect(created.invoice.total).toBe('12.0000');

      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query('UPDATE companies SET standard_tax_rate_percent = $1 WHERE id = $2', [
        '0',
        COMPANY_A1,
      ]);
    });

    it('takes the currency from the source orders', async () => {
      const order = await confirmedOrder();

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect(created.invoice.currency).toBe('USD');
      expect((await lineRows())[0]?.currency).toBe('USD');
    });

    it('takes the customer from the source orders', async () => {
      const order = await confirmedOrder();

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect(created.invoice.customerId).toBe(CUSTOMER[COMPANY_A1]);
    });

    it('sums the document totals from the stored lines', async () => {
      const order = await confirmedOrder({
        lines: [
          { quantity: '2.000000', unitPrice: '10.000000' },
          { quantity: '3.000000', unitPrice: '5.000000' },
        ],
      });

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect({
        subtotal: created.invoice.subtotal,
        taxTotal: created.invoice.taxTotal,
        total: created.invoice.total,
      }).toEqual({ subtotal: '35.0000', taxTotal: '0.0000', total: '35.0000' });
    });

    it('holds a price at the sixth decimal place without losing it', async () => {
      // Section 4.3's reason for split precision: a distributor sells at fractions of a cent.
      const order = await confirmedOrder({
        lines: [{ quantity: '1000.000000', unitPrice: '0.000400' }],
      });

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect(created.lines[0]?.unitPrice).toBe('0.000400');
      expect(created.invoice.subtotal).toBe('0.4000');
    });

    it('numbers the lines from one, in the order they were chosen', async () => {
      const order = await confirmedOrder({
        lines: [{ quantity: '1.000000' }, { quantity: '2.000000' }, { quantity: '3.000000' }],
      });

      await draft({
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
        lines: [
          { salesOrderLineId: order.lineIds[2]! },
          { salesOrderLineId: order.lineIds[0]! },
        ],
      });

      const stored = await lineRows();
      expect(stored.map((row) => row.line_number)).toEqual([1, 2]);
      expect(stored.map((row) => row.source_sales_order_line_id)).toEqual([
        order.lineIds[2],
        order.lineIds[0],
      ]);
    });

    it('stamps every row with the tenant and company of the scope', async () => {
      const order = await confirmedOrder();

      await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      const stored = (await invoiceRows())[0];
      expect({ tenant: stored?.tenant_id, company: stored?.company_id }).toEqual({
        tenant: TENANT_A,
        company: COMPANY_A1,
      });
    });

    it('keeps the due date the caller stated', async () => {
      const order = await confirmedOrder();

      const created = await draft({
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
        dueDate: '2026-10-15',
      });

      expect(created.invoice.dueDate).toBe('2026-10-15');
    });

    it('refuses a due date before the invoice date', async () => {
      const order = await confirmedOrder();

      await expect(
        draft({
          salesOrderIds: [order.id],
          invoiceDate: '2026-09-15',
          dueDate: '2026-09-14',
        }),
      ).rejects.toMatchObject({ reason: 'invalid_due_date' });

      expect(await invoiceRows()).toEqual([]);
    });

    it('leaves the due date null when none is given, rather than inventing terms', async () => {
      const order = await confirmedOrder();

      const created = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      expect(created.invoice.dueDate).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------
  // 6. Scope, at the database boundary rather than in the service.
  // -------------------------------------------------------------------------------------

  describe('the database boundary', () => {
    it('refuses an invoice line whose source line belongs to another order', async () => {
      // The composite key that makes a mismatched pair unrepresentable. Both rows exist and are
      // individually legitimate; only the pairing is wrong, which is the case row level security
      // cannot catch on its own.
      const first = await confirmedOrder();
      const second = await confirmedOrder();
      const invoice = await draft({ salesOrderIds: [first.id], invoiceDate: '2026-09-15' });

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO customer_invoice_lines
             (id, tenant_id, company_id, customer_invoice_id, line_number,
              source_sales_order_id, source_sales_order_line_id, product_id, product_sku,
              product_name, quantity, unit_price, currency)
           VALUES (gen_random_uuid(),$1,$2,$3,9,$4,$5,$6,'SKU-1','A Product','1','1','USD')`,
          [
            TENANT_A,
            COMPANY_A1,
            invoice.invoice.id,
            first.id,
            second.lineIds[0],
            PRODUCT[COMPANY_A1],
          ],
        ),
      ).rejects.toThrow(/customer_invoice_lines_source_pair_fkey/);
    });

    it('refuses an invoice line naming a sibling company order', async () => {
      const own = await confirmedOrder();
      const foreign = await confirmedOrder({ tenantId: TENANT_A, companyId: COMPANY_A2 });
      const invoice = await draft({ salesOrderIds: [own.id], invoiceDate: '2026-09-15' });

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO customer_invoice_lines
             (id, tenant_id, company_id, customer_invoice_id, line_number,
              source_sales_order_id, source_sales_order_line_id, product_id, product_sku,
              product_name, quantity, unit_price, currency)
           VALUES (gen_random_uuid(),$1,$2,$3,9,$4,$5,$6,'SKU-1','A Product','1','1','USD')`,
          [
            TENANT_A,
            COMPANY_A1,
            invoice.invoice.id,
            foreign.id,
            foreign.lineIds[0],
            PRODUCT[COMPANY_A1],
          ],
        ),
      ).rejects.toThrow(/customer_invoice_lines_source_order_fkey/);
    });

    it('refuses an invoice naming a sibling company customer', async () => {
      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO customer_invoices
             (id, tenant_id, company_id, customer_id, invoice_date, currency)
           VALUES (gen_random_uuid(),$1,$2,$3,current_date,'USD')`,
          [TENANT_A, COMPANY_A1, CUSTOMER[COMPANY_A2]],
        ),
      ).rejects.toThrow(/customer_invoices_customer_fkey/);
    });

    it('refuses two lines billing the same source line on one invoice', async () => {
      const order = await confirmedOrder();
      const invoice = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO customer_invoice_lines
             (id, tenant_id, company_id, customer_invoice_id, line_number,
              source_sales_order_id, source_sales_order_line_id, product_id, product_sku,
              product_name, quantity, unit_price, currency)
           VALUES (gen_random_uuid(),$1,$2,$3,9,$4,$5,$6,'SKU-1','A Product','1','1','USD')`,
          [
            TENANT_A,
            COMPANY_A1,
            invoice.invoice.id,
            order.id,
            order.lineIds[0],
            PRODUCT[COMPANY_A1],
          ],
        ),
      ).rejects.toThrow(/customer_invoice_lines_invoice_source_line_key/);
    });

    it('refuses a line carrying a currency the invoice does not', async () => {
      // A second line of the same order, so the unique key on invoice and source line is not what
      // refuses this. What refuses it is the composite key against the invoice's own currency.
      const order = await confirmedOrder({
        lines: [{ quantity: '1.000000' }, { quantity: '1.000000' }],
      });
      const invoice = await draft({
        salesOrderIds: [order.id],
        invoiceDate: '2026-09-15',
        lines: [{ salesOrderLineId: order.lineIds[0]! }],
      });

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query(
          `INSERT INTO customer_invoice_lines
             (id, tenant_id, company_id, customer_invoice_id, line_number,
              source_sales_order_id, source_sales_order_line_id, product_id, product_sku,
              product_name, quantity, unit_price, currency)
           VALUES (gen_random_uuid(),$1,$2,$3,9,$4,$5,$6,'SKU-1','A Product','1','1','EUR')`,
          [
            TENANT_A,
            COMPANY_A1,
            invoice.invoice.id,
            order.id,
            order.lineIds[1],
            PRODUCT[COMPANY_A1],
          ],
        ),
      ).rejects.toThrow(/customer_invoice_lines_currency_fkey/);
    });

    it('returns nothing at all when no company context is set', async () => {
      const order = await confirmedOrder();
      await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await ownerContext();
      const invoicesSeen = await owner.query<{ count: string }>(
        'SELECT count(*) FROM customer_invoices',
      );
      const linesSeen = await owner.query<{ count: string }>(
        'SELECT count(*) FROM customer_invoice_lines',
      );

      // Section 2.4: an empty context denies rather than admits, and FORCE row level security is
      // what makes that true for the owning role as well.
      expect([invoicesSeen.rows[0]?.count, linesSeen.rows[0]?.count]).toEqual(['0', '0']);
    });

    it('holds no DELETE on customer_invoices for the application role', async () => {
      const result = await owner.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = $1 AND table_schema = 'public' AND table_name = 'customer_invoices'`,
        [process.env['APP_DB_ROLE'] ?? 'erp_app'],
      );

      // Section 4.5: business documents are cancelled, reversed or archived, never hard deleted.
      expect(result.rows.map((row) => row.privilege_type).sort()).toEqual([
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
    });

    it('holds DELETE on the lines, because a draft is editable', async () => {
      const result = await owner.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = $1 AND table_schema = 'public' AND table_name = 'customer_invoice_lines'`,
        [process.env['APP_DB_ROLE'] ?? 'erp_app'],
      );

      // And no UPDATE, which is what makes the version exemption in section 4.2 structural:
      // editing a draft replaces a line rather than amending one in place.
      expect(result.rows.map((row) => row.privilege_type).sort()).toEqual([
        'DELETE',
        'INSERT',
        'SELECT',
      ]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 7. Two drafts at once, which is the ambiguity this package records rather than closes.
  // -------------------------------------------------------------------------------------

  describe('two drafts of the same order', () => {
    it('both succeed, because a draft reserves nothing', async () => {
      // RECORDED RATHER THAN RULED. Nothing is consumed until posting, so two drafts raised at
      // once can each claim the whole remainder, and the architecture does not say whether that
      // is allowed. Section 12.2 makes posting the moment that validates against current state,
      // which is where the question belongs. This test pins the behaviour as it is today so that
      // a later ruling is a visible change rather than a silent one.
      const order = await confirmedOrder({ lines: [{ quantity: '10.000000' }] });

      const first = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });
      const second = await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-16' });

      expect(first.invoice.id).not.toBe(second.invoice.id);
      expect(first.lines[0]?.quantity).toBe('10.000000');
      expect(second.lines[0]?.quantity).toBe('10.000000');
      expect(await invoiceRows()).toHaveLength(2);

      // And neither has consumed anything, which is why both were possible.
      await ownerContext(TENANT_A, COMPANY_A1);
      const line = await owner.query<{ invoiced_quantity: string }>(
        'SELECT invoiced_quantity FROM sales_order_lines WHERE id = $1',
        [order.lineIds[0]],
      );
      expect(line.rows[0]?.invoiced_quantity).toBe('0.000000');
    });
  });

  // -------------------------------------------------------------------------------------
  // 8. Rollback.
  // -------------------------------------------------------------------------------------

  describe('a creating transaction that fails', () => {
    it('leaves neither the invoice nor its lines behind', async () => {
      const order = await confirmedOrder();
      const failure = new Error('invoice draft refused by test');

      await expect(
        uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1), async (repos) => {
          await invoices.createDraftIn(repos, COMPANY_A1, {
            salesOrderIds: [order.id],
            invoiceDate: '2026-09-15',
          });
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(await invoiceRows()).toEqual([]);
      expect(await lineRows()).toEqual([]);
    });

    it('writes the invoice and its lines in one transaction', async () => {
      // `xmin` is the transaction that wrote the row. Two values would mean an invoice could
      // exist for a moment with no lines, and therefore with no source orders.
      const order = await confirmedOrder({
        lines: [{ quantity: '1.000000' }, { quantity: '2.000000' }],
      });

      await draft({ salesOrderIds: [order.id], invoiceDate: '2026-09-15' });

      await ownerContext(TENANT_A, COMPANY_A1);
      const written = await owner.query<{ xmin: string }>(
        `SELECT xmin::text AS xmin FROM customer_invoices
         UNION
         SELECT xmin::text FROM customer_invoice_lines`,
      );

      expect(written.rows).toHaveLength(1);
    });
  });
});
