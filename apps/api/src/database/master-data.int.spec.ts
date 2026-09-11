/**
 * Master data, and the keys it lets 0005 finish declaring.
 *
 * The drift suite already covers what these tables have in common with every other tenant scoped
 * table: scope columns, `version`, row level security enabled and forced, a policy, and an empty
 * context that denies. None of that is repeated here.
 *
 * WHAT IS HERE IS THE PAIRING. A sales order in one company referencing a customer in another is
 * the failure that row level security cannot catch on its own: both rows are individually
 * legitimate and only the combination is wrong. Section 4.1 answers that with a foreign key that
 * names the tenant and the company as well as the row, and these tests are what prove the key is
 * doing that rather than merely existing.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Client } from 'pg';

const APP_URL = process.env['DATABASE_URL'];
const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'a8100000-0000-4000-8000-00000000000a';
const TENANT_B = 'a8200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'b8100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "wrong company, right tenant" is representable. */
const COMPANY_A2 = 'b8200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'b8300000-0000-4000-8000-00000000000c';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'c8110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'c8120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'c8130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'c8210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'c8220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'c8230000-0000-4000-8000-00000000000c',
};
const PRODUCT: Record<string, string> = {
  [COMPANY_A1]: 'c8310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'c8320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'c8330000-0000-4000-8000-00000000000c',
};

const ORDER_A1 = 'd8100000-0000-4000-8000-00000000000a';

describe('Master data', () => {
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
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'master-a',
      'Master A',
      TENANT_B,
      'master-b',
      'Master B',
    ]);

    for (const [tenantId, companyId] of SCOPES) {
      await context(owner, { tenantId, companyId });
      await owner.query(
        'INSERT INTO companies (id, tenant_id, name, base_currency) VALUES ($1,$2,$3,$4)',
        [companyId, tenantId, `Company ${companyId.slice(0, 4)}`, 'USD'],
      );
      // The same code and the same SKU in every company, deliberately. Uniqueness is per
      // company, and a global unique index would make one customer's catalogue depend on
      // another's.
      await owner.query(
        'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
        [CUSTOMER[companyId], tenantId, companyId, 'CUST-1', 'Shared Code Customer'],
      );
      await owner.query(
        'INSERT INTO warehouses (id, tenant_id, company_id, code, name, is_default) VALUES ($1,$2,$3,$4,$5,true)',
        [WAREHOUSE[companyId], tenantId, companyId, 'WH-1', 'Main'],
      );
      await owner.query(
        `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
         VALUES ($1,$2,$3,$4,$5,'unit','12.345600','USD')`,
        [PRODUCT[companyId], tenantId, companyId, 'SKU-1', 'Widget'],
      );
    }

    await context(owner, { tenantId: TENANT_A, companyId: COMPANY_A1 });
    await owner.query(
      `INSERT INTO sales_orders
         (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
       VALUES ($1,$2,$3,'draft',$4,$5,current_date,'USD')`,
      [ORDER_A1, TENANT_A, COMPANY_A1, CUSTOMER[COMPANY_A1], WAREHOUSE[COMPANY_A1]],
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
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  /** Runs a statement as the application role and returns the error, or null if it succeeded. */
  async function refusedAs(
    scope: { tenantId?: string; companyId?: string },
    sql: string,
    params: unknown[] = [],
  ): Promise<string | null> {
    await app.query('BEGIN');
    try {
      await context(app, scope);
      await app.query(sql, params);
      await app.query('ROLLBACK');
      return null;
    } catch (error) {
      await app.query('ROLLBACK');
      return error instanceof Error ? error.message : String(error);
    }
  }

  const inA1 = { tenantId: TENANT_A, companyId: COMPANY_A1 };

  // -------------------------------------------------------------------------------------
  // The keys section 4.1 requires, and the pairing they refuse.
  // -------------------------------------------------------------------------------------

  describe('a document cannot reference another company master data', () => {
    const insertOrder = `
      INSERT INTO sales_orders
        (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
      VALUES (gen_random_uuid(), $1, $2, 'draft', $3, $4, current_date, 'USD')`;

    it('accepts an order naming its own company customer and warehouse', async () => {
      // Without this the refusals below would pass for a key that rejected everything.
      const error = await refusedAs(inA1, insertOrder, [
        TENANT_A,
        COMPANY_A1,
        CUSTOMER[COMPANY_A1],
        WAREHOUSE[COMPANY_A1],
      ]);

      expect(error).toBeNull();
    });

    it('refuses an order naming a sibling company customer', async () => {
      // Both rows exist and both are legitimate. Only the pairing is wrong, which is precisely
      // what row level security cannot see and what the composite key is for.
      const error = await refusedAs(inA1, insertOrder, [
        TENANT_A,
        COMPANY_A1,
        CUSTOMER[COMPANY_A2],
        WAREHOUSE[COMPANY_A1],
      ]);

      expect(error).toMatch(/sales_orders_customer_fkey/);
    });

    it('refuses an order naming another tenant customer', async () => {
      const error = await refusedAs(inA1, insertOrder, [
        TENANT_A,
        COMPANY_A1,
        CUSTOMER[COMPANY_B1],
        WAREHOUSE[COMPANY_A1],
      ]);

      expect(error).toMatch(/sales_orders_customer_fkey/);
    });

    it('refuses an order naming a sibling company warehouse', async () => {
      const error = await refusedAs(inA1, insertOrder, [
        TENANT_A,
        COMPANY_A1,
        CUSTOMER[COMPANY_A1],
        WAREHOUSE[COMPANY_A2],
      ]);

      expect(error).toMatch(/sales_orders_warehouse_fkey/);
    });

    it('refuses an order naming a customer that does not exist at all', async () => {
      // The gap this migration closes. Before it, any uuid was accepted.
      const error = await refusedAs(inA1, insertOrder, [
        TENANT_A,
        COMPANY_A1,
        'c8990000-0000-4000-8000-00000000000f',
        WAREHOUSE[COMPANY_A1],
      ]);

      expect(error).toMatch(/sales_orders_customer_fkey/);
    });

    it('refuses a line naming a sibling company product', async () => {
      const error = await refusedAs(
        inA1,
        `INSERT INTO sales_order_lines
           (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku,
            product_name, quantity, unit_price, currency)
         VALUES (gen_random_uuid(), $1, $2, $3, 1, $4, 'SKU-1', 'Widget', 1, '1.5', 'USD')`,
        [TENANT_A, COMPANY_A1, ORDER_A1, PRODUCT[COMPANY_A2]],
      );

      expect(error).toMatch(/sales_order_lines_product_fkey/);
    });

    it('accepts a line naming its own company product', async () => {
      const error = await refusedAs(
        inA1,
        `INSERT INTO sales_order_lines
           (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku,
            product_name, quantity, unit_price, currency)
         VALUES (gen_random_uuid(), $1, $2, $3, 1, $4, 'SKU-1', 'Widget', 1, '1.5', 'USD')`,
        [TENANT_A, COMPANY_A1, ORDER_A1, PRODUCT[COMPANY_A1]],
      );

      expect(error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------
  // Uniqueness is per company, not global.
  // -------------------------------------------------------------------------------------

  describe('codes and identifiers belong to the company that issued them', () => {
    it('lets every company use the same customer code and product SKU', async () => {
      // Seeded that way. A global unique index here would make one customer of this product
      // unable to use a code because another customer already had.
      await context(app, inA1);
      const mine = await app.query<{ code: string }>('SELECT code FROM customers');

      await context(app, { tenantId: TENANT_B, companyId: COMPANY_B1 });
      const theirs = await app.query<{ code: string }>('SELECT code FROM customers');

      expect(mine.rows.map((r) => r.code)).toEqual(['CUST-1']);
      expect(theirs.rows.map((r) => r.code)).toEqual(['CUST-1']);
    });

    it('refuses a second customer with a code the company already uses', async () => {
      const error = await refusedAs(
        inA1,
        'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES (gen_random_uuid(), $1, $2, $3, $4)',
        [TENANT_A, COMPANY_A1, 'CUST-1', 'Duplicate'],
      );

      expect(error).toMatch(/customers_company_code_key|duplicate key/i);
    });

    it('refuses a second product with a SKU the company already uses', async () => {
      const error = await refusedAs(
        inA1,
        `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price_currency)
         VALUES (gen_random_uuid(), $1, $2, 'SKU-1', 'Duplicate', 'unit', 'USD')`,
        [TENANT_A, COMPANY_A1],
      );

      expect(error).toMatch(/products_company_sku_key|duplicate key/i);
    });

    it('refuses a second default warehouse in one company', async () => {
      // At most one default, expressed as a partial unique index because "at most one row where
      // this is true" is not something a row level check can see.
      const error = await refusedAs(
        inA1,
        `INSERT INTO warehouses (id, tenant_id, company_id, code, name, is_default)
         VALUES (gen_random_uuid(), $1, $2, 'WH-2', 'Second', true)`,
        [TENANT_A, COMPANY_A1],
      );

      expect(error).toMatch(/warehouses_company_default_key|duplicate key/i);
    });

    it('allows a second non default warehouse', async () => {
      const error = await refusedAs(
        inA1,
        `INSERT INTO warehouses (id, tenant_id, company_id, code, name)
         VALUES (gen_random_uuid(), $1, $2, 'WH-2', 'Second')`,
        [TENANT_A, COMPANY_A1],
      );

      expect(error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------
  // The contract requirements that attach to these records specifically.
  // -------------------------------------------------------------------------------------

  describe('what the contract requires of these rows', () => {
    it('refuses a product with no stocking unit of measure', async () => {
      // Section 8.4: every product has a canonical stocking unit, and the stock ledger is always
      // recorded in it. Without one, every quantity in history is ambiguous.
      const error = await refusedAs(
        inA1,
        `INSERT INTO products (id, tenant_id, company_id, sku, name, sales_price_currency)
         VALUES (gen_random_uuid(), $1, $2, 'SKU-2', 'No unit', 'USD')`,
        [TENANT_A, COMPANY_A1],
      );

      expect(error).toMatch(/stocking_uom/);
    });

    it('defaults a warehouse to denying negative stock', async () => {
      // Section 8.5: negative stock is a policy per warehouse, defaulting to deny.
      await context(app, inA1);
      const rows = await app.query<{ allow_negative_stock: boolean }>(
        'SELECT allow_negative_stock FROM warehouses WHERE code = $1',
        ['WH-1'],
      );

      expect(rows.rows[0]?.allow_negative_stock).toBe(false);
    });

    it('refuses a product type the domain does not define', async () => {
      const error = await refusedAs(
        inA1,
        `INSERT INTO products (id, tenant_id, company_id, sku, name, type, stocking_uom, sales_price_currency)
         VALUES (gen_random_uuid(), $1, $2, 'SKU-3', 'Odd', 'subscription', 'unit', 'USD')`,
        [TENANT_A, COMPANY_A1],
      );

      expect(error).toMatch(/products_type_check/);
    });

    it('keeps the sales price as an exact decimal at six places', async () => {
      // Section 4.3: unit prices at six decimal places, because a distributor sells at a
      // fraction of a cent per unit inside a pack of a thousand.
      await context(app, inA1);
      const rows = await app.query<{ sales_price: string }>(
        'SELECT sales_price FROM products WHERE sku = $1',
        ['SKU-1'],
      );

      expect(rows.rows[0]?.sales_price).toBe('12.345600');
    });

    it.each(['customers', 'products', 'warehouses'])(
      'refuses to delete from %s, because master data is archived rather than removed',
      async (table) => {
        // Section 4.5, enforced as a missing grant rather than as a convention. A customer with
        // orders against it must not be removable.
        const error = await refusedAs(inA1, `DELETE FROM ${table} WHERE tenant_id = $1`, [
          TENANT_A,
        ]);

        expect(error).toMatch(/permission denied/i);
      },
    );

    it.each(['customers', 'products', 'warehouses'])(
      'archives a row in %s instead, which the status column exists for',
      async (table) => {
        const error = await refusedAs(
          inA1,
          `UPDATE ${table} SET status = 'archived' WHERE tenant_id = $1`,
          [TENANT_A],
        );

        expect(error).toBeNull();
      },
    );
  });

  // -------------------------------------------------------------------------------------
  // Isolation, at the level the drift suite does not reach.
  // -------------------------------------------------------------------------------------

  describe('isolation', () => {
    it.each(['customers', 'products', 'warehouses'])(
      'shows a company only its own %s',
      async (table) => {
        await context(app, inA1);
        const mine = await app.query<{ id: string }>(`SELECT id FROM ${table}`);

        expect(mine.rows).toHaveLength(1);
        expect(mine.rows[0]?.id).not.toBe(CUSTOMER[COMPANY_A2]);
      },
    );

    it.each(['customers', 'products', 'warehouses'])(
      'refuses a row in %s stamped with another company',
      async (table) => {
        const columns =
          table === 'products'
            ? `(id, tenant_id, company_id, sku, name, stocking_uom, sales_price_currency)
               VALUES (gen_random_uuid(), $1, $2, 'X-1', 'X', 'unit', 'USD')`
            : `(id, tenant_id, company_id, code, name)
               VALUES (gen_random_uuid(), $1, $2, 'X-1', 'X')`;

        const error = await refusedAs(inA1, `INSERT INTO ${table} ${columns}`, [
          TENANT_A,
          COMPANY_A2,
        ]);

        expect(error).toMatch(/row-level security/);
      },
    );
  });
});
