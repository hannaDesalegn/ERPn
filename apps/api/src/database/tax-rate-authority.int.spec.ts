/**
 * Where the authoritative tax rate lives.
 *
 * Section 2.9, as amended on 2026-09-11, puts the standard rate on the company beside the other
 * fiscal settings. This suite pins that decision rather than the arithmetic that will use it:
 * no rate is calculated anywhere yet, and this increment adds no calculation.
 *
 * WHAT IS WORTH PINNING, AND WHY EACH ONE.
 *
 * The rate is configuration, so two companies of the same tenant can hold different ones. A
 * product sold to two countries is the case the decision exists for, and a constant in code or a
 * tenant-wide value would make one of them wrong.
 *
 * The rate is not on the product and not on the customer. Those are the two candidates the
 * amendment rejected, and a later contributor reaching for either should meet a failing test
 * rather than a merge conflict.
 *
 * The line keeps its own rate column, which is the snapshot section 3.4 permits. Changing the
 * company's rate must not reach a document that already exists.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Client } from 'pg';

const APP_URL = process.env['DATABASE_URL'];
const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT = 'af900000-0000-4000-8000-00000000000a';
/** Two companies in one tenant, because the rate is per company and not per tenant. */
const COMPANY_HOME = 'bf910000-0000-4000-8000-00000000000a';
const COMPANY_ABROAD = 'bf920000-0000-4000-8000-00000000000b';

const CUSTOMER = 'cf910000-0000-4000-8000-00000000000a';
const WAREHOUSE = 'cf920000-0000-4000-8000-00000000000b';
const PRODUCT = 'cf930000-0000-4000-8000-00000000000c';
const ORDER = 'df910000-0000-4000-8000-00000000000a';

const SCOPES: [string, string][] = [
  [TENANT, COMPANY_HOME],
  [TENANT, COMPANY_ABROAD],
];

describe('The authoritative tax rate', () => {
  let owner: Client;
  let app: Client;

  beforeAll(async () => {
    if (!APP_URL || !MIGRATION_URL) {
      throw new Error(
        'DATABASE_URL and MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate` first.',
      );
    }

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();
    app = new Client({ connectionString: APP_URL });
    await app.connect();

    await purge();
    await seed();
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await app.end();
  });

  async function context(
    client: Client,
    scope: { tenantId?: string; companyId?: string },
  ): Promise<void> {
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [scope.tenantId ?? '']);
    await client.query(`SELECT set_config('app.company_id', $1, false)`, [scope.companyId ?? '']);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)', [
      TENANT,
      'tax-authority',
      'Tax Authority',
    ]);

    // Two rates in one tenant. The whole point of the decision is that this is representable.
    await context(owner, { tenantId: TENANT, companyId: COMPANY_HOME });
    await owner.query(
      `INSERT INTO companies (id, tenant_id, name, base_currency, standard_tax_rate_percent)
       VALUES ($1,$2,'Home','EUR','21.000000')`,
      [COMPANY_HOME, TENANT],
    );
    await context(owner, { tenantId: TENANT, companyId: COMPANY_ABROAD });
    await owner.query(
      `INSERT INTO companies (id, tenant_id, name, base_currency, standard_tax_rate_percent)
       VALUES ($1,$2,'Abroad','EUR','7.500000')`,
      [COMPANY_ABROAD, TENANT],
    );

    await context(owner, { tenantId: TENANT, companyId: COMPANY_HOME });
    await owner.query(
      'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
      [CUSTOMER, TENANT, COMPANY_HOME, 'CUST-1', 'A Customer'],
    );
    await owner.query(
      'INSERT INTO warehouses (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
      [WAREHOUSE, TENANT, COMPANY_HOME, 'WH-1', 'Main'],
    );
    await owner.query(
      `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price_currency)
       VALUES ($1,$2,$3,'SKU-1','Widget','unit','EUR')`,
      [PRODUCT, TENANT, COMPANY_HOME],
    );
    await owner.query(
      `INSERT INTO sales_orders
         (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
       VALUES ($1,$2,$3,'draft',$4,$5,current_date,'EUR')`,
      [ORDER, TENANT, COMPANY_HOME, CUSTOMER, WAREHOUSE],
    );
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await context(owner, { tenantId, companyId });
      await owner.query('DELETE FROM sales_order_lines WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM sales_orders WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM products WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM warehouses WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM customers WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await context(owner, {});
    await owner.query('DELETE FROM tenants WHERE id = $1', [TENANT]);
  }

  const columnsOf = (table: string) =>
    owner
      .query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      )
      .then((r) => r.rows.map((row) => row.column_name));

  // -------------------------------------------------------------------------------------
  // The decision itself.
  // -------------------------------------------------------------------------------------

  describe('the rate is company configuration', () => {
    it('is held on the company', async () => {
      expect(await columnsOf('companies')).toContain('standard_tax_rate_percent');
    });

    it('differs between two companies of the same tenant', async () => {
      // The case the decision exists for. A constant in code, or a value held per tenant, makes
      // one of two companies trading in different countries wrong.
      //
      // Selected by identifier rather than by context. The policy on `companies` compares the
      // tenant alone, deliberately, because company switching has to read across the companies
      // of a tenant to offer them. A context-only query returns both rows, which is the policy
      // working and not a filter to lean on here.
      await context(app, { tenantId: TENANT, companyId: COMPANY_HOME });
      const home = await app.query<{ standard_tax_rate_percent: string }>(
        'SELECT standard_tax_rate_percent FROM companies WHERE id = $1',
        [COMPANY_HOME],
      );
      const abroad = await app.query<{ standard_tax_rate_percent: string }>(
        'SELECT standard_tax_rate_percent FROM companies WHERE id = $1',
        [COMPANY_ABROAD],
      );

      expect(home.rows[0]?.standard_tax_rate_percent).toBe('21.000000');
      expect(abroad.rows[0]?.standard_tax_rate_percent).toBe('7.500000');
    });

    it('is an exact decimal at the precision a document line can hold', async () => {
      // Section 4.3, and a practical consequence: a rate the line could not represent exactly
      // would round on its way onto the document.
      const companyRate = await owner.query<{ numeric_precision: number; numeric_scale: number }>(
        `SELECT numeric_precision, numeric_scale FROM information_schema.columns
          WHERE table_name = 'companies' AND column_name = 'standard_tax_rate_percent'`,
      );
      const lineRate = await owner.query<{ numeric_precision: number; numeric_scale: number }>(
        `SELECT numeric_precision, numeric_scale FROM information_schema.columns
          WHERE table_name = 'sales_order_lines' AND column_name = 'tax_rate_percent'`,
      );

      expect(companyRate.rows[0]).toEqual(lineRate.rows[0]);
    });

    it('defaults to charging nothing rather than to a guessed jurisdiction', async () => {
      // A company that has not configured tax charges none. Picking a rate on its behalf is how
      // a wrong invoice gets issued that nobody can explain.
      await context(owner, { tenantId: TENANT, companyId: COMPANY_HOME });
      const inserted = await owner.query<{ standard_tax_rate_percent: string }>(
        `INSERT INTO companies (id, tenant_id, name, base_currency)
         VALUES (gen_random_uuid(), $1, 'Unconfigured', 'EUR')
         RETURNING standard_tax_rate_percent`,
        [TENANT],
      );

      expect(inserted.rows[0]?.standard_tax_rate_percent).toBe('0.000000');

      await owner.query(`DELETE FROM companies WHERE name = 'Unconfigured'`);
    });

    it('refuses a rate outside nought and a hundred per cent', async () => {
      await context(owner, { tenantId: TENANT, companyId: COMPANY_HOME });

      await expect(
        owner.query(
          `INSERT INTO companies (id, tenant_id, name, base_currency, standard_tax_rate_percent)
           VALUES (gen_random_uuid(), $1, 'Impossible', 'EUR', '-1')`,
          [TENANT],
        ),
      ).rejects.toThrow(/standard_tax_rate_check/);
    });
  });

  // -------------------------------------------------------------------------------------
  // The two candidates the amendment rejected.
  // -------------------------------------------------------------------------------------

  describe('the rate is not held where it was rejected', () => {
    it('is not a column on products', async () => {
      // Rejected because reduced rates for food, books or medicine are a rate table keyed by
      // category and jurisdiction, which section 9.7 puts in the future. A column here now
      // would be that engine half built.
      const columns = await columnsOf('products');

      expect(columns.filter((c) => c.includes('tax'))).toEqual([]);
    });

    it('is not a column on customers', async () => {
      // Rejected because what varies per customer is exemption and reverse charge, not the
      // rate, and section 9.7 names both as future.
      const columns = await columnsOf('customers');

      expect(columns.filter((c) => c.includes('tax'))).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // The snapshot, which is what keeps a posted document stable.
  // -------------------------------------------------------------------------------------

  describe('a document line keeps the rate that applied when it was raised', () => {
    it('stores its own rate rather than pointing at the company', async () => {
      // Section 3.4 permits a denormalised value where it is a legal snapshot of a past
      // agreement, and an applied tax rate is exactly that.
      expect(await columnsOf('sales_order_lines')).toContain('tax_rate_percent');
    });

    it('is untouched when the company rate changes afterwards', async () => {
      await context(owner, { tenantId: TENANT, companyId: COMPANY_HOME });
      await owner.query(
        `INSERT INTO sales_order_lines
           (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku,
            product_name, quantity, unit_price, currency, tax_rate_percent)
         VALUES (gen_random_uuid(), $1, $2, $3, 1, $4, 'SKU-1', 'Widget', 1, '10', 'EUR', '21.000000')`,
        [TENANT, COMPANY_HOME, ORDER, PRODUCT],
      );

      await owner.query(
        `UPDATE companies SET standard_tax_rate_percent = '25.000000' WHERE id = $1`,
        [COMPANY_HOME],
      );

      const line = await owner.query<{ tax_rate_percent: string }>(
        'SELECT tax_rate_percent FROM sales_order_lines WHERE sales_order_id = $1',
        [ORDER],
      );

      // The rate that applied when the line was raised. A document already issued does not
      // change because configuration did.
      expect(line.rows[0]?.tax_rate_percent).toBe('21.000000');

      await owner.query(
        `UPDATE companies SET standard_tax_rate_percent = '21.000000' WHERE id = $1`,
        [COMPANY_HOME],
      );
    });
  });
});
