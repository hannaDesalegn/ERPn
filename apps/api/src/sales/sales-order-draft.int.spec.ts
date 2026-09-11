/**
 * Creating a sales order draft, against a real PostgreSQL.
 *
 * The single claim worth proving here is that nothing the caller sends becomes a stored figure.
 * Section 3.3 is explicit that the frontend is never trusted with prices, discounts, tax rates or
 * costs, and that the server recomputes every monetary figure from its own master data and the
 * submitted quantities. Most of what follows is that sentence, tested from the outside.
 *
 * The seed puts a customer, a warehouse and a product in each of two companies in two tenants,
 * with the same codes and different prices. A cross-company reference is therefore a real row
 * that exists and must still be refused, which is a stronger test than referencing a value that
 * exists nowhere.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import type { CompanyContext } from '../identity/identity.service.js';
import { SalesModule } from './sales.module.js';
import { SalesOrderDraftError, SalesOrderService } from './sales-order.service.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'e1100000-0000-4000-8000-00000000000a';
const TENANT_B = 'e1200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'e2100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "wrong company, right tenant" is representable. */
const COMPANY_A2 = 'e2200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'e2300000-0000-4000-8000-00000000000c';

const USER = 'e3100000-0000-4000-8000-00000000000a';

const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'e4110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'e4120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'e4130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'e4210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'e4220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'e4230000-0000-4000-8000-00000000000c',
};
/** Priced differently per company, so a leak shows up as the wrong money. */
const WIDGET: Record<string, string> = {
  [COMPANY_A1]: 'e4310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'e4320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'e4330000-0000-4000-8000-00000000000c',
};
/** A second product in the acting company, for multi-line orders. */
const CABLE_TIE = 'e4410000-0000-4000-8000-00000000000a';
/** Archived, so "exists but is not usable" is representable. */
const DISCONTINUED = 'e4510000-0000-4000-8000-00000000000a';
/** Priced in a currency the company does not trade in. */
const IMPORTED = 'e4610000-0000-4000-8000-00000000000a';

const PRICE: Record<string, string> = {
  [COMPANY_A1]: '12.500000',
  [COMPANY_A2]: '99.990000',
  [COMPANY_B1]: '77.000000',
};

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const contextFor = (tenantId: string, companyId: string): CompanyContext => ({
  tenantId,
  companyId,
  membershipId: 'e5100000-0000-4000-8000-00000000000a',
});

const inA1 = contextFor(TENANT_A, COMPANY_A1);
const inA2 = contextFor(TENANT_A, COMPANY_A2);

describe('Sales order draft creation', () => {
  let sales: SalesOrderService;
  let owner: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    if (!MIGRATION_URL || !process.env['DATABASE_URL']) {
      throw new Error(
        'DATABASE_URL and MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate` first.',
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule, SalesModule],
    }).compile();
    await moduleRef.init();

    sales = moduleRef.get(SalesOrderService);
    close = () => moduleRef.close();

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();

    await purge();
    await seed();
  });

  afterAll(async () => {
    await purge();
    await owner.end();
    await close();
  });

  beforeEach(async () => {
    // Every test starts with no orders, so "no partial order was left behind" is a statement
    // about this test rather than about whatever ran before it.
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM sales_order_lines WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM sales_orders WHERE tenant_id = $1', [tenantId]);
    }
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'draft-a',
      'Draft A',
      TENANT_B,
      'draft-b',
      'Draft B',
    ]);

    await owner.query(
      'INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)',
      [USER, 'rep@draft.test', 'Rep', 'not-a-real-hash'],
    );

    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      // A 21 per cent standard rate in tenant A, 7.5 in tenant B, so a leak of the rate shows
      // up as the wrong tax rather than as a matching number.
      await owner.query(
        `INSERT INTO companies (id, tenant_id, name, base_currency, standard_tax_rate_percent)
         VALUES ($1,$2,$3,'USD',$4)`,
        [companyId, tenantId, `Company ${companyId.slice(0, 4)}`, tenantId === TENANT_A ? '21.000000' : '7.500000'],
      );
      await owner.query(
        'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
        [CUSTOMER[companyId], tenantId, companyId, 'CUST-1', 'A Customer'],
      );
      await owner.query(
        'INSERT INTO warehouses (id, tenant_id, company_id, code, name, is_default) VALUES ($1,$2,$3,$4,$5,true)',
        [WAREHOUSE[companyId], tenantId, companyId, 'WH-1', 'Main'],
      );
      await owner.query(
        `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
         VALUES ($1,$2,$3,'SKU-WIDGET','Widget','unit',$4,'USD')`,
        [WIDGET[companyId], tenantId, companyId, PRICE[companyId]],
      );
    }

    await ownerContext(TENANT_A, COMPANY_A1);
    await owner.query(
      `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
       VALUES ($1,$2,$3,'SKU-TIE','Cable tie','unit','0.004250','USD')`,
      [CABLE_TIE, TENANT_A, COMPANY_A1],
    );
    await owner.query(
      `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency, status)
       VALUES ($1,$2,$3,'SKU-OLD','Discontinued','unit','5.000000','USD','archived')`,
      [DISCONTINUED, TENANT_A, COMPANY_A1],
    );
    await owner.query(
      `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
       VALUES ($1,$2,$3,'SKU-IMPORT','Imported','unit','10.000000','EUR')`,
      [IMPORTED, TENANT_A, COMPANY_A1],
    );
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
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
    await ownerContext();
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM users WHERE id = $1', [USER]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  /** A draft in the acting company, with whatever lines the test cares about. */
  const draft = (lines: { productId: string; quantity: string; discountPercent?: string }[]) =>
    sales.createDraft(inA1, USER, {
      customerId: CUSTOMER[COMPANY_A1]!,
      warehouseId: WAREHOUSE[COMPANY_A1]!,
      orderDate: '2026-09-11',
      lines,
    });

  const ordersIn = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{ id: string }>('SELECT id FROM sales_orders');
    return rows.rows;
  };

  const linesIn = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{ id: string }>('SELECT id FROM sales_order_lines');
    return rows.rows;
  };

  // -------------------------------------------------------------------------------------
  // What a valid draft looks like.
  // -------------------------------------------------------------------------------------

  describe('a valid draft', () => {
    it('is created with the price from master data', async () => {
      const { order, lines } = await draft([{ productId: WIDGET[COMPANY_A1]!, quantity: '2' }]);

      expect(order.companyId).toBe(COMPANY_A1);
      expect(lines).toHaveLength(1);
      // 12.50, the acting company's price, not the 99.99 of the company next door.
      expect(lines[0]?.unitPrice).toBe('12.500000');
    });

    it('recomputes the line amounts from that price and the submitted quantity', async () => {
      const { lines } = await draft([{ productId: WIDGET[COMPANY_A1]!, quantity: '2' }]);

      // 2 x 12.50 = 25.0000, tax at 21 per cent = 5.2500, total 30.2500.
      expect(lines[0]?.lineSubtotal).toBe('25.0000');
      expect(lines[0]?.lineTax).toBe('5.2500');
      expect(lines[0]?.lineTotal).toBe('30.2500');
    });

    it('applies a discount the caller is allowed to choose', async () => {
      const { lines } = await draft([
        { productId: WIDGET[COMPANY_A1]!, quantity: '2', discountPercent: '10' },
      ]);

      // 25.00 less ten per cent is 22.50, tax 4.7250, total 27.2250.
      expect(lines[0]?.discountPercent).toBe('10.000000');
      expect(lines[0]?.lineSubtotal).toBe('22.5000');
      expect(lines[0]?.lineTax).toBe('4.7250');
    });

    it('keeps a fraction of a cent over a large quantity', async () => {
      // Section 4.3's own example. A double would already have lost this.
      const { lines } = await draft([{ productId: CABLE_TIE, quantity: '1000' }]);

      expect(lines[0]?.unitPrice).toBe('0.004250');
      expect(lines[0]?.lineSubtotal).toBe('4.2500');
    });

    it('snapshots the product sku and name from master data', async () => {
      // Section 3.4: a document is an immutable record of a past agreement, so the name is
      // copied rather than joined, and it is copied from the product rather than the caller.
      const { lines } = await draft([{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }]);

      expect(lines[0]?.productSku).toBe('SKU-WIDGET');
      expect(lines[0]?.productName).toBe('Widget');
    });

    it('trades in the company base currency, on the header and every line', async () => {
      const { order, lines } = await draft([{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }]);

      expect(order.currency).toBe('USD');
      expect(lines[0]?.currency).toBe('USD');
    });
  });

  // -------------------------------------------------------------------------------------
  // Totals.
  // -------------------------------------------------------------------------------------

  describe('document totals', () => {
    it('equal the sum of the stored line totals', async () => {
      const { order, lines } = await draft([
        { productId: WIDGET[COMPANY_A1]!, quantity: '2' },
        { productId: CABLE_TIE, quantity: '1000' },
      ]);

      const subtotal = lines.reduce((sum, l) => sum + Number(l.lineSubtotal), 0);
      const tax = lines.reduce((sum, l) => sum + Number(l.lineTax), 0);

      // Compared as numbers only because the assertion is about agreement, not about precision:
      // the stored strings are the authority and are checked exactly below.
      expect(Number(order.subtotal)).toBeCloseTo(subtotal, 4);
      expect(Number(order.taxTotal)).toBeCloseTo(tax, 4);
      expect(order.subtotal).toBe('29.2500');
      expect(order.taxTotal).toBe('6.1425');
      expect(order.total).toBe('35.3925');
    });

    it('are read back from the database rather than from what was computed', async () => {
      const { order } = await draft([{ productId: WIDGET[COMPANY_A1]!, quantity: '3' }]);

      await ownerContext(TENANT_A, COMPANY_A1);
      const stored = await owner.query<{ subtotal: string; tax_total: string; total: string }>(
        'SELECT subtotal, tax_total, total FROM sales_orders WHERE id = $1',
        [order.id],
      );

      expect(stored.rows[0]).toEqual({
        subtotal: order.subtotal,
        tax_total: order.taxTotal,
        total: order.total,
      });
    });
  });

  // -------------------------------------------------------------------------------------
  // The tax rate, and where it came from.
  // -------------------------------------------------------------------------------------

  describe('the tax rate', () => {
    it('is resolved from the company and snapshotted onto every line', async () => {
      const { lines } = await draft([
        { productId: WIDGET[COMPANY_A1]!, quantity: '1' },
        { productId: CABLE_TIE, quantity: '1' },
      ]);

      expect(lines.map((l) => l.taxRatePercent)).toEqual(['21.000000', '21.000000']);
    });

    it('does not change on a draft already created when the company rate changes', async () => {
      // Section 3.4: the line holds what applied when it was raised. Configuration changing
      // later must not reach a document that already exists.
      const { order } = await draft([{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }]);

      await owner.query(
        `UPDATE companies SET standard_tax_rate_percent = '25.000000' WHERE id = $1`,
        [COMPANY_A1],
      );

      try {
        await ownerContext(TENANT_A, COMPANY_A1);
        const stored = await owner.query<{ tax_rate_percent: string; line_tax: string }>(
          'SELECT tax_rate_percent, line_tax FROM sales_order_lines WHERE sales_order_id = $1',
          [order.id],
        );

        expect(stored.rows[0]?.tax_rate_percent).toBe('21.000000');
        expect(stored.rows[0]?.line_tax).toBe('2.6250');
      } finally {
        await owner.query(
          `UPDATE companies SET standard_tax_rate_percent = '21.000000' WHERE id = $1`,
          [COMPANY_A1],
        );
      }
    });

    it('takes the acting company rate, not another company of the same tenant', async () => {
      const here = await draft([{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }]);
      const there = await sales.createDraft(inA2, USER, {
        customerId: CUSTOMER[COMPANY_A2]!,
        warehouseId: WAREHOUSE[COMPANY_A2]!,
        orderDate: '2026-09-11',
        lines: [{ productId: WIDGET[COMPANY_A2]!, quantity: '1' }],
      });

      expect(here.lines[0]?.unitPrice).toBe('12.500000');
      expect(there.lines[0]?.unitPrice).toBe('99.990000');
    });
  });

  // -------------------------------------------------------------------------------------
  // Section 3.3, which is what this service exists to enforce.
  // -------------------------------------------------------------------------------------

  describe('nothing the caller sends becomes a stored figure', () => {
    it('has nowhere on the input to put a price, a tax rate or a total', async () => {
      // The strongest form of the guarantee: not overridden, unrepresentable. A caller sending
      // these is sending fields the operation does not read.
      const smuggled = {
        customerId: CUSTOMER[COMPANY_A1]!,
        warehouseId: WAREHOUSE[COMPANY_A1]!,
        orderDate: '2026-09-11',
        subtotal: '0.0001',
        taxTotal: '0.0001',
        total: '0.0001',
        currency: 'ZZZ',
        lines: [
          {
            productId: WIDGET[COMPANY_A1]!,
            quantity: '2',
            unitPrice: '0.010000',
            taxRatePercent: '0.000000',
            lineTotal: '0.0100',
            productName: 'Something else',
            productSku: 'SKU-FAKE',
          },
        ],
      };

      const { order, lines } = await sales.createDraft(
        inA1,
        USER,
        smuggled as unknown as Parameters<SalesOrderService['createDraft']>[2],
      );

      // Every authoritative value is the one from master data, and none is the smuggled one.
      expect(lines[0]?.unitPrice).toBe('12.500000');
      expect(lines[0]?.taxRatePercent).toBe('21.000000');
      expect(lines[0]?.lineTotal).toBe('30.2500');
      expect(lines[0]?.productName).toBe('Widget');
      expect(lines[0]?.productSku).toBe('SKU-WIDGET');
      expect(order.currency).toBe('USD');
      expect(order.total).toBe('30.2500');
    });

    it('stamps the company from the scope even when the input names another', async () => {
      const smuggled = {
        customerId: CUSTOMER[COMPANY_A1]!,
        warehouseId: WAREHOUSE[COMPANY_A1]!,
        orderDate: '2026-09-11',
        tenantId: TENANT_B,
        companyId: COMPANY_B1,
        lines: [{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }],
      };

      const { order } = await sales.createDraft(
        inA1,
        USER,
        smuggled as unknown as Parameters<SalesOrderService['createDraft']>[2],
      );

      expect(order.tenantId).toBe(TENANT_A);
      expect(order.companyId).toBe(COMPANY_A1);
      expect(await ordersIn(TENANT_B, COMPANY_B1)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // Validation, and what it refuses.
  // -------------------------------------------------------------------------------------

  describe('validation', () => {
    const rejection = async (promise: Promise<unknown>) => {
      const error = await promise.then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(SalesOrderDraftError);
      return error as SalesOrderDraftError;
    };

    it('refuses an order with no lines', async () => {
      const error = await rejection(draft([]));

      expect(error.reason).toBe('no_lines');
      expect(await ordersIn(TENANT_A, COMPANY_A1)).toEqual([]);
    });

    it('refuses a customer that does not exist', async () => {
      const error = await rejection(
        sales.createDraft(inA1, USER, {
          customerId: 'e4990000-0000-4000-8000-00000000000f',
          warehouseId: WAREHOUSE[COMPANY_A1]!,
          orderDate: '2026-09-11',
          lines: [{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }],
        }),
      );

      expect(error.reason).toBe('customer_not_found');
    });

    it('refuses a customer from a sibling company of the same tenant', async () => {
      // A real row, in a real company, that this company may not reference. Section 6.1 makes
      // the answer identical to the missing case above.
      const error = await rejection(
        sales.createDraft(inA1, USER, {
          customerId: CUSTOMER[COMPANY_A2]!,
          warehouseId: WAREHOUSE[COMPANY_A1]!,
          orderDate: '2026-09-11',
          lines: [{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }],
        }),
      );

      expect(error.reason).toBe('customer_not_found');
      expect(error.message).toBe('Customer not found');
    });

    it('refuses a customer from another tenant', async () => {
      const error = await rejection(
        sales.createDraft(inA1, USER, {
          customerId: CUSTOMER[COMPANY_B1]!,
          warehouseId: WAREHOUSE[COMPANY_A1]!,
          orderDate: '2026-09-11',
          lines: [{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }],
        }),
      );

      expect(error.reason).toBe('customer_not_found');
    });

    it('refuses a warehouse from another company', async () => {
      const error = await rejection(
        sales.createDraft(inA1, USER, {
          customerId: CUSTOMER[COMPANY_A1]!,
          warehouseId: WAREHOUSE[COMPANY_A2]!,
          orderDate: '2026-09-11',
          lines: [{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }],
        }),
      );

      expect(error.reason).toBe('warehouse_not_found');
    });

    it('refuses a product from another company', async () => {
      const error = await rejection(draft([{ productId: WIDGET[COMPANY_A2]!, quantity: '1' }]));

      expect(error.reason).toBe('product_not_found');
    });

    it('refuses a product from another tenant', async () => {
      const error = await rejection(draft([{ productId: WIDGET[COMPANY_B1]!, quantity: '1' }]));

      expect(error.reason).toBe('product_not_found');
    });

    it('refuses an archived product, which exists and is no longer usable', async () => {
      const error = await rejection(draft([{ productId: DISCONTINUED, quantity: '1' }]));

      expect(error.reason).toBe('product_not_found');
    });

    it('refuses a product priced in a currency the company does not trade in', async () => {
      // No exchange rate exists on a sales order, and inventing one is the guess the domain
      // refuses when it says cross-currency arithmetic throws.
      const error = await rejection(draft([{ productId: IMPORTED, quantity: '1' }]));

      expect(error.reason).toBe('currency_mismatch');
    });

    it.each(['0', '-1', '0.000000'])('refuses a quantity of %s', async (quantity) => {
      const error = await rejection(draft([{ productId: WIDGET[COMPANY_A1]!, quantity }]));

      expect(error.reason).toBe('invalid_quantity');
    });

    it.each(['', 'abc', '1e3', '1.2.3', 'NaN', '1.1234567'])(
      'refuses a malformed quantity of %s rather than coercing it',
      async (quantity) => {
        // Every one of these is something a number parser either accepts or turns into NaN.
        // Section 14.2 rejects rather than ignores.
        const error = await rejection(draft([{ productId: WIDGET[COMPANY_A1]!, quantity }]));

        expect(error.reason).toBe('invalid_quantity');
      },
    );

    it.each(['-1', '101', 'abc'])('refuses a discount of %s', async (discountPercent) => {
      const error = await rejection(
        draft([{ productId: WIDGET[COMPANY_A1]!, quantity: '1', discountPercent }]),
      );

      expect(error.reason).toBe('invalid_discount');
    });

    it('writes nothing at all when validation refuses', async () => {
      await rejection(draft([{ productId: WIDGET[COMPANY_A2]!, quantity: '1' }]));

      expect(await ordersIn(TENANT_A, COMPANY_A1)).toEqual([]);
      expect(await linesIn(TENANT_A, COMPANY_A1)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // Atomicity.
  // -------------------------------------------------------------------------------------

  describe('the whole order or none of it', () => {
    it('writes a multi-line order as one unit', async () => {
      const { order, lines } = await draft([
        { productId: WIDGET[COMPANY_A1]!, quantity: '1' },
        { productId: CABLE_TIE, quantity: '500' },
        { productId: WIDGET[COMPANY_A1]!, quantity: '2', discountPercent: '5' },
      ]);

      expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3]);
      expect(await linesIn(TENANT_A, COMPANY_A1)).toHaveLength(3);
      // 12.5000 plus 2.1250 plus 23.7500, the third line being two widgets less five per cent.
      expect(order.subtotal).toBe('38.3750');
    });

    it('refuses the whole order when one line names an unusable product', async () => {
      // The second line is another company's. Nothing is written, including the first line and
      // the header, which is what one transaction buys.
      await expect(
        draft([
          { productId: WIDGET[COMPANY_A1]!, quantity: '1' },
          { productId: WIDGET[COMPANY_B1]!, quantity: '1' },
          { productId: CABLE_TIE, quantity: '1' },
        ]),
      ).rejects.toBeInstanceOf(SalesOrderDraftError);

      expect(await ordersIn(TENANT_A, COMPANY_A1)).toEqual([]);
      expect(await linesIn(TENANT_A, COMPANY_A1)).toEqual([]);
    });

    it('leaves no header when a line write fails after the header was written', async () => {
      // The validation above fails before anything is written, which proves the check and not
      // the transaction. This fails inside the write itself, so only a rollback can explain an
      // empty table afterwards. The trigger fires for one product name and nothing else.
      await owner.query(`
        CREATE FUNCTION erp_test_block_line() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.product_name = 'Cable tie' THEN
            RAISE EXCEPTION 'line write refused by test';
          END IF;
          RETURN NEW;
        END
        $fn$;
        CREATE TRIGGER erp_test_block_line_trigger
          BEFORE INSERT ON sales_order_lines
          FOR EACH ROW EXECUTE FUNCTION erp_test_block_line();
      `);

      try {
        await expect(
          draft([
            { productId: WIDGET[COMPANY_A1]!, quantity: '1' },
            { productId: CABLE_TIE, quantity: '1' },
          ]),
        ).rejects.toThrow();

        // The header and the first line were written and are both gone.
        expect(await ordersIn(TENANT_A, COMPANY_A1)).toEqual([]);
        expect(await linesIn(TENANT_A, COMPANY_A1)).toEqual([]);
      } finally {
        await owner.query('DROP TRIGGER erp_test_block_line_trigger ON sales_order_lines');
        await owner.query('DROP FUNCTION erp_test_block_line()');
      }
    });
  });

  // -------------------------------------------------------------------------------------
  // What a draft is not.
  // -------------------------------------------------------------------------------------

  describe('it is only a draft', () => {
    it('is created as a draft with no document number', async () => {
      const { order } = await draft([{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }]);

      // Section 12.2 allocates the number as step four of the confirming transaction, and this
      // operation does not confirm anything.
      expect(order.status).toBe('draft');
      expect(order.docNumber).toBeNull();
    });

    it('allocates nothing from the number sequence', async () => {
      await draft([{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }]);

      await ownerContext(TENANT_A, COMPANY_A1);
      const sequences = await owner.query('SELECT 1 FROM document_number_sequences');

      expect(sequences.rowCount).toBe(0);
    });

    it('writes no audit event, which arrives with confirmation', async () => {
      await draft([{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }]);

      await ownerContext(TENANT_A, COMPANY_A1);
      const events = await owner.query('SELECT 1 FROM audit_events');

      expect(events.rowCount).toBe(0);
    });

    it('leaves delivered and invoiced quantities at nothing', async () => {
      const { lines } = await draft([{ productId: WIDGET[COMPANY_A1]!, quantity: '5' }]);

      expect(lines[0]?.deliveredQuantity).toBe('0.000000');
      expect(lines[0]?.invoicedQuantity).toBe('0.000000');
    });
  });
});
