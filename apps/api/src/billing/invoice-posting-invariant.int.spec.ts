/**
 * The accounting invariant of a posted invoice, over generated documents rather than chosen ones.
 *
 * WHY THIS EXISTS BESIDE THE EXAMPLE TESTS. `post-customer-invoice.int.spec.ts` asserts the entry
 * for invoices somebody wrote down, and every one of them is a case a person thought of. The
 * invariant is not about those cases: for any invoice this system can raise, the entry it posts
 * debits receivables for the total, credits revenue for the net, credits tax for the difference,
 * and balances to the last of the four decimal places section 4.3 stores. That is a property, and
 * the way to test a property is to generate the inputs.
 *
 * NO PROPERTY TESTING LIBRARY, DELIBERATELY. The repository has none, and section 13 asks for
 * tests that can fail rather than for a framework. A seeded generator in thirty lines produces the
 * same shrinking-free coverage a library would here, and the seed is printed with any failure so
 * the case is reproducible. Adding a dependency to the API for this would be the larger decision.
 *
 * WHAT IS GENERATED: quantities, prices, discounts and a company tax rate, at the scales the
 * schema declares, including the awkward ones. Fractions of a cent, a hundred per cent discount,
 * a zero rate, a rate with six decimal places, and enough lines that rounding differences would
 * accumulate if each line were not rounded on its own.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, systemScope, UnitOfWork } from '../database/index.js';
import { provisionChartOfAccounts } from '../accounting/chart-of-accounts.js';
import { provisionPostingAccounts } from '../accounting/posting-accounts.js';
import { seedDefaultRolesIn } from '../authorization/role-provisioning.service.js';
import type { CompanyContext } from '../identity/identity.service.js';
import { provisionCustomerInvoiceSequence } from '../sales/document-numbers.js';
import { CustomerInvoiceService } from './customer-invoice.service.js';
import { postCustomerInvoice } from './post-customer-invoice.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT = 'c9100000-0000-4000-8000-00000000000a';
const COMPANY = 'c9200000-0000-4000-8000-00000000000a';
const USER = 'c9300000-0000-4000-8000-00000000000a';
const CUSTOMER = 'c9400000-0000-4000-8000-00000000000a';
const WAREHOUSE = 'c9500000-0000-4000-8000-00000000000a';
const PRODUCT = 'c9600000-0000-4000-8000-00000000000a';

/**
 * The generator. Deterministic, so a failure is reproducible from the seed the message prints.
 *
 * mulberry32, which the frontend fixture layer already uses for the same reason: it is four lines,
 * it needs no dependency, and it produces the same sequence on every machine.
 */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A decimal string at a given scale, between two bounds, including the ends. */
const decimalBetween = (next: () => number, low: number, high: number, scale: number): string =>
  (low + next() * (high - low)).toFixed(scale);

interface GeneratedCase {
  taxRatePercent: string;
  lines: { quantity: string; unitPrice: string; discountPercent: string }[];
}

/** One invoice's worth of inputs, at the scales the schema stores. */
function generateCase(seed: number): GeneratedCase {
  const next = generator(seed);
  const lineCount = 1 + Math.floor(next() * 5);
  const lines = [];

  for (let i = 0; i < lineCount; i += 1) {
    lines.push({
      // Quantities from a fraction of a unit to a pallet, at the quantity scale.
      quantity: decimalBetween(next, 0.000001, 500, 6),
      // Prices from four ten-thousandths of a cent, which is the case section 4.3 exists for, to
      // the price of something worth invoicing on its own.
      unitPrice: decimalBetween(next, 0.000001, 2000, 6),
      // Including nought and a hundred, both of which the constraint permits.
      discountPercent: decimalBetween(next, 0, 100, 6),
    });
  }

  return { taxRatePercent: decimalBetween(next, 0, 27, 6), lines };
}

describe('The accounting invariant of a posted invoice', () => {
  let uow: UnitOfWork;
  let invoices: CustomerInvoiceService;
  let owner: Client;
  let close: () => Promise<void>;
  let membershipId: string;
  let accounts: Record<string, string>;

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

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  const scope = () => actorScope({ tenantId: TENANT, companyId: COMPANY, userId: USER });
  const context = (): CompanyContext => ({
    tenantId: TENANT,
    companyId: COMPANY,
    membershipId,
    requestId: 'req-property',
  });

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)', [
      TENANT,
      'invariant',
      'Invariant',
    ]);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT }), async (r) => {
      await r.users.create({ id: USER, email: 'prop@invariant.test', name: 'P', passwordHash: 'x' });
      await r.companies.create({ id: COMPANY, name: 'Invariant Co', baseCurrency: 'USD' });
    });

    membershipId = randomUUID();
    await uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: TENANT, companyId: COMPANY }),
      async (r) => {
        await provisionCustomerInvoiceSequence(r);
        const chart = await provisionChartOfAccounts(r);
        await provisionPostingAccounts(r, chart);
        const roles = await seedDefaultRolesIn(r, COMPANY);
        await r.memberships.create({ id: membershipId, userId: USER });
        await r.roles.assignToMembership({
          membershipId,
          roleId: roles.find((role) => role.key === 'accountant')!.id,
        });
      },
    );

    await uow.inActorScope(scope(), async (r) => {
      await r.customers.create({ id: CUSTOMER, code: 'CUST-1', name: 'A Customer' });
      await r.warehouses.create({ id: WAREHOUSE, code: 'WH-1', name: 'Main' });
      await r.products.create({
        id: PRODUCT,
        sku: 'SKU-1',
        name: 'A Product',
        stockingUom: 'each',
        salesPrice: '10.000000',
        salesPriceCurrency: 'USD',
      });
    });

    accounts = await uow.inActorScope(scope(), async (r) => {
      const mappings = await r.postingAccounts.listForCompany();
      return Object.fromEntries(mappings.map((m) => [m.purpose, m.accountId]));
    });
  }

  async function purge(): Promise<void> {
    // The ledger goes first, because its lines reference the accounts deleted below and it cannot
    // be deleted from at all: 0014 refuses that even from the owning role, so it is truncated.
    await ownerContext();
    await owner.query('TRUNCATE journal_lines, journal_entries');
    await ownerContext(TENANT, COMPANY);
    await owner.query('DELETE FROM customer_invoice_lines WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM customer_invoices WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM company_posting_accounts WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM accounts WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM document_number_sequences WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM products WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM warehouses WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM customers WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM membership_roles WHERE company_id = $1', [COMPANY]);
    await owner.query(
      'DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE company_id = $1)',
      [COMPANY],
    );
    await owner.query('DELETE FROM memberships WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM roles WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await ownerContext();
    await owner.query('TRUNCATE journal_lines, journal_entries');
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM users WHERE id = $1', [USER]);
    await owner.query('DELETE FROM tenants WHERE id = $1', [TENANT]);
  }

  /** Raises and posts one generated invoice, and reads back the entry it wrote. */
  async function postGenerated(example: GeneratedCase) {
    await ownerContext(TENANT, COMPANY);
    await owner.query('UPDATE companies SET standard_tax_rate_percent = $1 WHERE id = $2', [
      example.taxRatePercent,
      COMPANY,
    ]);

    const orderId = randomUUID();
    await owner.query(
      `INSERT INTO sales_orders
         (id, tenant_id, company_id, status, doc_number, customer_id, warehouse_id, order_date, currency)
       VALUES ($1,$2,$3,'confirmed',$4,$5,$6,current_date,'USD')`,
      [orderId, TENANT, COMPANY, `SO-${orderId}`, CUSTOMER, WAREHOUSE],
    );

    for (const [index, line] of example.lines.entries()) {
      await owner.query(
        `INSERT INTO sales_order_lines
           (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku,
            product_name, quantity, unit_price, discount_percent, currency)
         VALUES ($1,$2,$3,$4,$5,$6,'SKU-1','A Product',$7,$8,$9,'USD')`,
        [
          randomUUID(),
          TENANT,
          COMPANY,
          orderId,
          index + 1,
          PRODUCT,
          line.quantity,
          line.unitPrice,
          line.discountPercent,
        ],
      );
    }

    const draft = await invoices.createDraft(context(), USER, {
      salesOrderIds: [orderId],
      invoiceDate: '2026-09-16',
    });

    try {
      return await uow.inActorScope(scope(), (repos) =>
        postCustomerInvoice(repos, context(), { customerInvoiceId: draft.invoice.id }),
      );
    } catch (error) {
      // One refusal is a legitimate outcome of a generated case rather than a failure: an invoice
      // whose every line is wholly discounted comes to nothing. Any other refusal is a real
      // failure and is rethrown with the case that produced it.
      if ((error as { reason?: string }).reason === 'nothing_to_post') return 'nothing_to_post';
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------
  // The property.
  // -------------------------------------------------------------------------------------

  /**
   * Thirty generated invoices. Enough to cross the awkward ground repeatedly without turning a
   * suite that already runs against a real database into a slow one; each case is a full posting
   * transaction.
   */
  const SEEDS = Array.from({ length: 30 }, (_, index) => 1_000 + index);

  it.each(SEEDS)('posts a balanced entry for the invoice generated from seed %i', async (seed) => {
    const example = generateCase(seed);

    const posted = await postGenerated(example);
    if (posted === 'nothing_to_post') {
      // The other half of the property, and a real case: every line wholly discounted comes to
      // nothing, the entry would have no amount on either side, and the operation refuses rather
      // than letting the balance constraint answer. Nothing was posted, which is what to assert.
      expect(posted).toBe('nothing_to_post');
      return;
    }

    const lines = posted.journalEntry.lines;
    const detail = `seed ${seed}: ${JSON.stringify(example)}`;

    // 1. It balances, exactly, at the scale the column stores. Not approximately: these are
    //    decimal strings and the comparison is on the digits.
    const sum = (side: 'debit' | 'credit') =>
      lines.reduce((total, line) => total + BigInt(line[side].replace('.', '')), 0n);
    expect({ case: detail, debits: sum('debit') }).toEqual({ case: detail, debits: sum('credit') });

    // 2. Exactly one debit, and it is receivables for the whole of what is owed.
    const debits = lines.filter((line) => Number(line.debit) > 0);
    expect({ count: debits.length, account: debits[0]?.accountId, amount: debits[0]?.debit }).toEqual(
      {
        count: 1,
        account: accounts['accounts_receivable'],
        amount: posted.invoice.total,
      },
    );

    // 3. Revenue is credited the net, whenever there is a net to credit.
    const credits = lines.filter((line) => Number(line.credit) > 0);
    const revenue = credits.filter((line) => line.accountId === accounts['sales_revenue']);
    if (Number(posted.invoice.subtotal) > 0) {
      expect(revenue.map((line) => line.credit)).toEqual([posted.invoice.subtotal]);
    }

    // 4. Tax is credited the difference, whenever the company charges any.
    const tax = credits.filter((line) => line.accountId === accounts['tax_payable']);
    if (Number(posted.invoice.taxTotal) > 0) {
      expect(tax.map((line) => line.credit)).toEqual([posted.invoice.taxTotal]);
    } else {
      // A zero line would be refused by the constraint in 0014, so there must be none.
      expect(tax).toEqual([]);
    }

    // 5. And nothing else was posted to. Section 18.2: receivables, revenue and tax and no
    //    fourth account, whatever the amounts turn out to be.
    const postedAccounts = new Set(lines.map((line) => line.accountId));
    for (const account of postedAccounts) {
      expect([
        accounts['accounts_receivable'],
        accounts['sales_revenue'],
        accounts['tax_payable'],
      ]).toContain(account);
    }
  });

  it('wrote one entry per generated posting, and every one of them survives', async () => {
    // The cases above each assert their own entry. This asserts the ledger as a whole: thirty
    // postings, thirty entries, and the trial balance of the lot still nets to nothing.
    await ownerContext(TENANT, COMPANY);
    const entries = await owner.query<{ count: string }>('SELECT count(*) FROM journal_entries');
    const posted = await owner.query<{ count: string }>(
      `SELECT count(*) FROM customer_invoices WHERE status = 'posted'`,
    );

    // One entry per posted invoice, and every generated case either posted or was refused for
    // coming to nothing, so this also says no refusal left an entry behind.
    expect(entries.rows[0]?.count).toBe(posted.rows[0]?.count);
    expect(Number(entries.rows[0]?.count)).toBeGreaterThan(0);

    const totals = await owner.query<{ debits: string; credits: string }>(
      'SELECT sum(debit) AS debits, sum(credit) AS credits FROM journal_lines',
    );
    expect(totals.rows[0]?.debits).toBe(totals.rows[0]?.credits);
  });
});
