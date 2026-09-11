/**
 * The sales schema, proven against a real PostgreSQL.
 *
 * This increment adds tables and nothing else: no service, no endpoint, no numbering code. So
 * everything worth testing is a database guarantee, and every test below runs as the application
 * role with row level security in force, through raw SQL rather than through a repository. There
 * is no repository for these tables yet, and asserting the database directly is the point: these
 * are the guarantees the later increments will be built on top of and will not re-check.
 *
 * THE ONES THAT MATTER MOST are the composite keys. A line belonging to another tenant's order,
 * or carrying a currency its order does not, are both unrepresentable rather than merely
 * prevented by code that has to remember. Section 2.10 calls cross tenant leakage the highest
 * severity class of defect in this system, and a foreign key is the layer that does not forget.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Client } from 'pg';

const APP_URL = process.env['DATABASE_URL'];
const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'a5100000-0000-4000-8000-00000000000a';
const TENANT_B = 'a5200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'b5100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "wrong company, right tenant" is representable. */
const COMPANY_A2 = 'b5200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'b5300000-0000-4000-8000-00000000000c';

const ORDER_A1 = 'c5100000-0000-4000-8000-00000000000a';
const ORDER_A2 = 'c5200000-0000-4000-8000-00000000000b';
const ORDER_B1 = 'c5300000-0000-4000-8000-00000000000c';

/**
 * Master data, one row of each per company.
 *
 * Migration 0006 made these real foreign keys, so an order can no longer point at an identifier
 * that names nothing. Seeded per company rather than once, because the keys name the tenant and
 * the company as well as the row, which is what makes a cross-company pairing unrepresentable.
 */
const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'd5110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd5120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd5130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'd5210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd5220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd5230000-0000-4000-8000-00000000000c',
};
const PRODUCT: Record<string, string> = {
  [COMPANY_A1]: 'd5310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd5320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd5330000-0000-4000-8000-00000000000c',
};

const TENANTS = [TENANT_A, TENANT_B];
const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

describe('The sales schema', () => {
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

  /** Sets the context the policies compare against, on whichever connection is acting. */
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
      'sales-a',
      'Sales A',
      TENANT_B,
      'sales-b',
      'Sales B',
    ]);

    for (const [tenantId, companyId] of SCOPES) {
      await context(owner, { tenantId, companyId });
      await owner.query(
        'INSERT INTO companies (id, tenant_id, name, base_currency) VALUES ($1,$2,$3,$4)',
        [companyId, tenantId, `Company ${companyId.slice(0, 4)}`, 'USD'],
      );
      await owner.query(
        'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
        [CUSTOMER[companyId], tenantId, companyId, 'CUST-1', 'A Customer'],
      );
      await owner.query(
        'INSERT INTO warehouses (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
        [WAREHOUSE[companyId], tenantId, companyId, 'WH-1', 'Main'],
      );
      await owner.query(
        `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price_currency)
         VALUES ($1,$2,$3,$4,$5,'unit','USD')`,
        [PRODUCT[companyId], tenantId, companyId, 'SKU-1', 'Widget'],
      );
    }

    // One confirmed order per company, with the same document number in two of them, which is
    // legitimate: a number is unique within the company that issued it, not globally.
    const orders: [string, string, string, string][] = [
      [ORDER_A1, TENANT_A, COMPANY_A1, 'SO-0001'],
      [ORDER_A2, TENANT_A, COMPANY_A2, 'SO-0001'],
      [ORDER_B1, TENANT_B, COMPANY_B1, 'SO-0001'],
    ];
    for (const [id, tenantId, companyId, docNumber] of orders) {
      await context(owner, { tenantId, companyId });
      await owner.query(
        `INSERT INTO sales_orders
           (id, tenant_id, company_id, doc_number, status, customer_id, warehouse_id,
            order_date, currency)
         VALUES ($1,$2,$3,$4,'confirmed',$5,$6,current_date,'USD')`,
        [id, tenantId, companyId, docNumber, CUSTOMER[companyId], WAREHOUSE[companyId]],
      );
    }
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await context(owner, { tenantId, companyId });
      await owner.query('DELETE FROM sales_order_lines WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM sales_orders WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM document_number_sequences WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM products WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM warehouses WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM customers WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await context(owner, {});
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [TENANTS]);
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

  // -------------------------------------------------------------------------------------
  // Reading.
  // -------------------------------------------------------------------------------------

  describe('what a context can read', () => {
    it('shows a company only its own orders', async () => {
      await context(app, { tenantId: TENANT_A, companyId: COMPANY_A1 });
      const rows = await app.query<{ id: string }>('SELECT id FROM sales_orders');

      expect(rows.rows.map((r) => r.id)).toEqual([ORDER_A1]);
    });

    it('hides an order in a sibling company of the same tenant', async () => {
      await context(app, { tenantId: TENANT_A, companyId: COMPANY_A1 });
      const rows = await app.query('SELECT 1 FROM sales_orders WHERE id = $1', [ORDER_A2]);

      // Section 6.1: a failure at this dimension is indistinguishable from the record not
      // existing. It is not an error, it is simply no row.
      expect(rows.rowCount).toBe(0);
    });

    it('hides an order in another tenant', async () => {
      await context(app, { tenantId: TENANT_A, companyId: COMPANY_A1 });
      const rows = await app.query('SELECT 1 FROM sales_orders WHERE id = $1', [ORDER_B1]);

      expect(rows.rowCount).toBe(0);
    });

    it.each(['document_number_sequences', 'sales_orders', 'sales_order_lines'])(
      'returns nothing from %s when the context is empty',
      async (table) => {
        await context(app, {});
        const rows = await app.query<{ count: string }>(`SELECT count(*) FROM ${table}`);

        expect(rows.rows[0]?.count).toBe('0');
      },
    );

    it('returns nothing when the tenant is named but the company is not', async () => {
      // Both halves of the policy have to match. A tenant context alone is not enough for a
      // company partitioned table, which is what separates these from `companies`.
      await context(app, { tenantId: TENANT_A });
      const rows = await app.query<{ count: string }>('SELECT count(*) FROM sales_orders');

      expect(rows.rows[0]?.count).toBe('0');
    });
  });

  // -------------------------------------------------------------------------------------
  // Writing.
  // -------------------------------------------------------------------------------------

  describe('what a context can write', () => {
    it('refuses an order stamped with another tenant', async () => {
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        `INSERT INTO sales_orders
           (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
         VALUES (gen_random_uuid(), $1, $2, 'draft', $3, $4, current_date, 'USD')`,
        [TENANT_B, COMPANY_B1, CUSTOMER[COMPANY_B1], WAREHOUSE[COMPANY_B1]],
      );

      expect(error).toMatch(/row-level security/);
    });

    it('refuses an order stamped with a sibling company of the same tenant', async () => {
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        `INSERT INTO sales_orders
           (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
         VALUES (gen_random_uuid(), $1, $2, 'draft', $3, $4, current_date, 'USD')`,
        [TENANT_A, COMPANY_A2, CUSTOMER[COMPANY_A2], WAREHOUSE[COMPANY_A2]],
      );

      expect(error).toMatch(/row-level security/);
    });

    it('accepts a draft stamped with the acting scope', async () => {
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        `INSERT INTO sales_orders
           (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
         VALUES (gen_random_uuid(), $1, $2, 'draft', $3, $4, current_date, 'USD')`,
        [TENANT_A, COMPANY_A1, CUSTOMER[COMPANY_A1], WAREHOUSE[COMPANY_A1]],
      );

      // Without this the refusals above would pass even if the table rejected everything.
      expect(error).toBeNull();
    });

    it('refuses to delete an order, because documents are cancelled rather than removed', async () => {
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        'DELETE FROM sales_orders WHERE id = $1',
        [ORDER_A1],
      );

      // Section 4.5, enforced as a missing grant rather than as a convention.
      expect(error).toMatch(/permission denied/i);
    });
  });

  // -------------------------------------------------------------------------------------
  // The composite keys, which are the reason a cross tenant child is unrepresentable.
  // -------------------------------------------------------------------------------------

  describe('lines belong to their order, in their order tenant and company', () => {
    const insertLine = `
      INSERT INTO sales_order_lines
        (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku,
         product_name, quantity, unit_price, currency)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'SKU-1', 'Widget', 1, '1.5', $6)`;

    it('accepts a line on an order in the acting scope', async () => {
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        insertLine,
        [TENANT_A, COMPANY_A1, ORDER_A1, 1, PRODUCT[COMPANY_A1], 'USD'],
      );

      expect(error).toBeNull();
    });

    it('refuses a line pointing at an order in another company', async () => {
      // Attempted from inside the order's own company, so row level security is satisfied and
      // the composite key is the only thing left to refuse it.
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A2 },
        insertLine,
        [TENANT_A, COMPANY_A2, ORDER_A1, 1, PRODUCT[COMPANY_A2], 'USD'],
      );

      expect(error).toMatch(/sales_order_lines_order_fkey|foreign key/i);
    });

    it('refuses a line pointing at an order in another tenant', async () => {
      const error = await refusedAs(
        { tenantId: TENANT_B, companyId: COMPANY_B1 },
        insertLine,
        [TENANT_B, COMPANY_B1, ORDER_A1, 1, PRODUCT[COMPANY_B1], 'USD'],
      );

      expect(error).toMatch(/sales_order_lines_order_fkey|foreign key/i);
    });

    it('refuses a line carrying a currency its order does not', async () => {
      // Section 4.3 stores currency alongside every amount. Mixed currency lines on one
      // document are what makes cross-currency arithmetic guess a rate, so the database refuses
      // rather than leaving it to a calculation to notice.
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        insertLine,
        [TENANT_A, COMPANY_A1, ORDER_A1, 2, PRODUCT[COMPANY_A1], 'EUR'],
      );

      expect(error).toMatch(/sales_order_lines_currency_fkey|foreign key/i);
    });

    it('refuses two lines with the same number on one order', async () => {
      await app.query('BEGIN');
      await context(app, { tenantId: TENANT_A, companyId: COMPANY_A1 });
      await app.query(insertLine, [TENANT_A, COMPANY_A1, ORDER_A1, 7, PRODUCT[COMPANY_A1], 'USD']);

      let message: string | null = null;
      try {
        await app.query(insertLine, [TENANT_A, COMPANY_A1, ORDER_A1, 7, PRODUCT[COMPANY_A1], 'USD']);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      await app.query('ROLLBACK');

      expect(message).toMatch(/line_number|duplicate key/i);
    });
  });

  // -------------------------------------------------------------------------------------
  // Document state and numbering, as constraints rather than as code.
  // -------------------------------------------------------------------------------------

  describe('the draft boundary and document numbers', () => {
    it('refuses a draft that already carries a number', async () => {
      // Section 12.2 allocates the number as step four of the confirming transaction, so a
      // numbered draft is a number that would later change.
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        `INSERT INTO sales_orders
           (id, tenant_id, company_id, doc_number, status, customer_id, warehouse_id,
            order_date, currency)
         VALUES (gen_random_uuid(), $1, $2, 'SO-9999', 'draft', $3, $4, current_date, 'USD')`,
        [TENANT_A, COMPANY_A1, CUSTOMER[COMPANY_A1], WAREHOUSE[COMPANY_A1]],
      );

      expect(error).toMatch(/draft_has_no_number/);
    });

    it('refuses a confirmed order with no number', async () => {
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        `INSERT INTO sales_orders
           (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
         VALUES (gen_random_uuid(), $1, $2, 'confirmed', $3, $4, current_date, 'USD')`,
        [TENANT_A, COMPANY_A1, CUSTOMER[COMPANY_A1], WAREHOUSE[COMPANY_A1]],
      );

      expect(error).toMatch(/draft_has_no_number/);
    });

    it('refuses a status the domain does not define', async () => {
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        `INSERT INTO sales_orders
           (id, tenant_id, company_id, doc_number, status, customer_id, warehouse_id,
            order_date, currency)
         VALUES (gen_random_uuid(), $1, $2, 'SO-8888', 'posted', $3, $4, current_date, 'USD')`,
        [TENANT_A, COMPANY_A1, CUSTOMER[COMPANY_A1], WAREHOUSE[COMPANY_A1]],
      );

      // Section 12.1: each document type has its own status union, and `posted` is not in this
      // one. An invoice's states are not a sales order's.
      expect(error).toMatch(/status_check/);
    });

    it('lets two companies each issue their own SO-0001', async () => {
      // Seeded that way. A number is unique within the company that issued it, not globally,
      // and a global unique index here would make one customer's numbering depend on another's.
      await context(owner, { tenantId: TENANT_A, companyId: COMPANY_A1 });
      const a1 = await owner.query('SELECT 1 FROM sales_orders WHERE doc_number = $1', ['SO-0001']);
      await context(owner, { tenantId: TENANT_B, companyId: COMPANY_B1 });
      const b1 = await owner.query('SELECT 1 FROM sales_orders WHERE doc_number = $1', ['SO-0001']);

      expect(a1.rowCount).toBe(1);
      expect(b1.rowCount).toBe(1);
    });

    it('refuses a second order with a number the company has already issued', async () => {
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        `INSERT INTO sales_orders
           (id, tenant_id, company_id, doc_number, status, customer_id, warehouse_id,
            order_date, currency)
         VALUES (gen_random_uuid(), $1, $2, 'SO-0001', 'confirmed', $3, $4, current_date, 'USD')`,
        [TENANT_A, COMPANY_A1, CUSTOMER[COMPANY_A1], WAREHOUSE[COMPANY_A1]],
      );

      expect(error).toMatch(/doc_number|duplicate key/i);
    });
  });

  describe('the number sequence', () => {
    const insertSequence = `
      INSERT INTO document_number_sequences (id, tenant_id, company_id, doc_type, prefix)
      VALUES (gen_random_uuid(), $1, $2, $3, 'SO-')`;

    it('accepts one sequence per document type in a company', async () => {
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        insertSequence,
        [TENANT_A, COMPANY_A1, 'sales_order'],
      );

      expect(error).toBeNull();
    });

    it('refuses a second sequence for the same document type', async () => {
      // Two counters for one document type race each other into duplicate numbers.
      await app.query('BEGIN');
      await context(app, { tenantId: TENANT_A, companyId: COMPANY_A1 });
      await app.query(insertSequence, [TENANT_A, COMPANY_A1, 'sales_order']);

      let message: string | null = null;
      try {
        await app.query(insertSequence, [TENANT_A, COMPANY_A1, 'sales_order']);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      await app.query('ROLLBACK');

      expect(message).toMatch(/doc_type|duplicate key/i);
    });

    it('refuses a counter below one, which would reissue a number', async () => {
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        `INSERT INTO document_number_sequences
           (id, tenant_id, company_id, doc_type, next_value)
         VALUES (gen_random_uuid(), $1, $2, 'sales_order', 0)`,
        [TENANT_A, COMPANY_A1],
      );

      expect(error).toMatch(/next_value_check/);
    });

    it('refuses to delete a sequence, because deleting one resets it', async () => {
      const error = await refusedAs(
        { tenantId: TENANT_A, companyId: COMPANY_A1 },
        'DELETE FROM document_number_sequences WHERE company_id = $1',
        [COMPANY_A1],
      );

      expect(error).toMatch(/permission denied/i);
    });

    it('can be locked for update, which is how allocation will work', async () => {
      // Section 10.4 forces a counter row locked inside the transaction, and that is only worth
      // writing down if the application role can actually take the lock.
      // The owner is inside FORCE row level security too, so its context has to name the
      // company it is writing into. A previous test left it pointing elsewhere, and the insert
      // was refused, which is the policy working rather than the test being wrong.
      await context(owner, { tenantId: TENANT_A, companyId: COMPANY_A1 });
      await owner.query(insertSequence, [TENANT_A, COMPANY_A1, 'sales_order']);

      await app.query('BEGIN');
      await context(app, { tenantId: TENANT_A, companyId: COMPANY_A1 });
      const locked = await app.query<{ next_value: string }>(
        `SELECT next_value FROM document_number_sequences
          WHERE doc_type = 'sales_order' FOR UPDATE`,
      );
      await app.query('ROLLBACK');

      expect(locked.rowCount).toBe(1);
      expect(locked.rows[0]?.next_value).toBe('1');

      await context(owner, { tenantId: TENANT_A, companyId: COMPANY_A1 });
      await owner.query('DELETE FROM document_number_sequences WHERE company_id = $1', [
        COMPANY_A1,
      ]);
    });
  });
});
