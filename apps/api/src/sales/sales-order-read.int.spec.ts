/**
 * Reading a sales order, against a real PostgreSQL.
 *
 * The read is the smaller half of this module and the easier one to get wrong quietly. A write
 * that reaches the wrong company fails on a foreign key; a read that does simply answers, and
 * nothing about the answer says it came from somewhere it should not have.
 *
 * So the seed puts a complete order in each of three companies across two tenants, with different
 * figures in each. Every cross-company case below names a real order that really exists, which is
 * a stronger test than asking for an identifier that exists nowhere.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import type { CompanyContext } from '../identity/identity.service.js';
import { SalesModule } from './sales.module.js';
import { SalesOrderService } from './sales-order.service.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'c9100000-0000-4000-8000-00000000000a';
const TENANT_B = 'c9200000-0000-4000-8000-00000000000b';

const COMPANY_A1 = 'c9300000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "same tenant, different company" is representable. */
const COMPANY_A2 = 'c9400000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'c9500000-0000-4000-8000-00000000000c';

const REP = 'c9600000-0000-4000-8000-00000000000a';

const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'ca110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'ca120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'ca130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'ca210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'ca220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'ca230000-0000-4000-8000-00000000000c',
};
const PRODUCT: Record<string, string> = {
  [COMPANY_A1]: 'ca310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'ca320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'ca330000-0000-4000-8000-00000000000c',
};
const ORDER: Record<string, string> = {
  [COMPANY_A1]: 'ca410000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'ca420000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'ca430000-0000-4000-8000-00000000000c',
};

/** Different per company, so reading the wrong one shows up as the wrong money. */
const TOTAL: Record<string, string> = {
  [COMPANY_A1]: '110.0000',
  [COMPANY_A2]: '220.0000',
  [COMPANY_B1]: '330.0000',
};

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

let sequence = 0;
const nextId = () =>
  `cb${(sequence += 1).toString().padStart(6, '0')}-0000-4000-8000-00000000000a`;

const contextFor = (tenantId: string, companyId: string): CompanyContext => ({
  tenantId,
  companyId,
  membershipId: 'cc100000-0000-4000-8000-00000000000a',
});

const IN_A1 = contextFor(TENANT_A, COMPANY_A1);
const IN_A2 = contextFor(TENANT_A, COMPANY_A2);
const IN_B1 = contextFor(TENANT_B, COMPANY_B1);

describe('Reading a sales order', () => {
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

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'read-a',
      'Read A',
      TENANT_B,
      'read-b',
      'Read B',
    ]);
    await owner.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)', [
      REP,
      'rep@read.test',
      'Rita Rep',
      'not-a-real-hash',
    ]);

    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query(
        'INSERT INTO companies (id, tenant_id, name, base_currency) VALUES ($1,$2,$3,$4)',
        [companyId, tenantId, `Company ${companyId.slice(0, 4)}`, 'USD'],
      );
      await owner.query(
        'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
        [CUSTOMER[companyId], tenantId, companyId, 'CUST-1', `Buyer of ${companyId.slice(0, 4)}`],
      );
      await owner.query(
        'INSERT INTO warehouses (id, tenant_id, company_id, code, name, is_default) VALUES ($1,$2,$3,$4,$5,true)',
        [WAREHOUSE[companyId], tenantId, companyId, 'WH-1', `Depot ${companyId.slice(0, 4)}`],
      );
      await owner.query(
        `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
         VALUES ($1,$2,$3,'SKU-W','Widget','unit','10.000000','USD')`,
        [PRODUCT[companyId], tenantId, companyId],
      );
      await owner.query(
        `INSERT INTO sales_orders
           (id, tenant_id, company_id, status, customer_id, warehouse_id, sales_rep_user_id,
            order_date, expected_delivery_date, currency, subtotal, tax_total, total)
         VALUES ($1,$2,$3,'draft',$4,$5,$6,'2026-09-11','2026-09-20','USD','100.0000','10.0000',$7)`,
        [
          ORDER[companyId],
          tenantId,
          companyId,
          CUSTOMER[companyId],
          WAREHOUSE[companyId],
          REP,
          TOTAL[companyId],
        ],
      );
      await owner.query(
        `INSERT INTO sales_order_lines
           (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku, product_name,
            quantity, unit_price, discount_percent, tax_rate_percent, currency,
            line_subtotal, line_tax, line_total, delivered_quantity)
         VALUES ($1,$2,$3,$4,1,$5,'SKU-W','Widget at order time','10.000000','10.000000','5.000000',
                 '10.000000','USD','95.0000','9.5000','104.5000','2.000000')`,
        [nextId(), tenantId, companyId, ORDER[companyId], PRODUCT[companyId]],
      );
    }
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM products WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM warehouses WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('DELETE FROM users WHERE id = $1', [REP]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  const read = (context: CompanyContext, orderId: string) =>
    sales.getById(context, REP, orderId);

  // -------------------------------------------------------------------------------------
  // What it returns.
  // -------------------------------------------------------------------------------------

  describe('an order in the acting company', () => {
    it('is returned with the document the database holds', async () => {
      const order = await read(IN_A1, ORDER[COMPANY_A1]!);

      expect(order).toMatchObject({
        id: ORDER[COMPANY_A1],
        status: 'draft',
        docNumber: null,
        orderDate: '2026-09-11',
        expectedDeliveryDate: '2026-09-20',
        currency: 'USD',
        subtotal: '100.0000',
        taxTotal: '10.0000',
        total: '110.0000',
      });
    });

    it('names the customer, the warehouse and the sales rep', async () => {
      const order = await read(IN_A1, ORDER[COMPANY_A1]!);

      expect(order?.customer).toEqual({ id: CUSTOMER[COMPANY_A1], name: 'Buyer of c930' });
      expect(order?.warehouse).toEqual({ id: WAREHOUSE[COMPANY_A1], name: 'Depot c930' });
      expect(order?.salesRep).toEqual({ id: REP, name: 'Rita Rep' });
    });

    it('returns the lines with the figures stored on them', async () => {
      const order = await read(IN_A1, ORDER[COMPANY_A1]!);

      expect(order?.lines).toHaveLength(1);
      expect(order?.lines[0]).toMatchObject({
        lineNumber: 1,
        productSku: 'SKU-W',
        quantity: '10.000000',
        unitPrice: '10.000000',
        discountPercent: '5.000000',
        taxRatePercent: '10.000000',
        lineSubtotal: '95.0000',
        lineTax: '9.5000',
        lineTotal: '104.5000',
        deliveredQuantity: '2.000000',
      });
    });

    it('returns the line\'s own product name rather than the catalogue\'s', async () => {
      // Section 3.4: a document records what was agreed. The product is called "Widget" today and
      // the line says "Widget at order time", which is the copy that must survive.
      const order = await read(IN_A1, ORDER[COMPANY_A1]!);

      expect(order?.lines[0]?.productName).toBe('Widget at order time');
    });

    it('carries the version, so a later edit can say what it read', async () => {
      const order = await read(IN_A1, ORDER[COMPANY_A1]!);

      expect(order?.version).toBe(1);
    });

    it('reflects a change made in the database rather than any cached copy', async () => {
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(`UPDATE sales_orders SET total = '999.0000' WHERE id = $1`, [
        ORDER[COMPANY_A1],
      ]);

      try {
        expect((await read(IN_A1, ORDER[COMPANY_A1]!))?.total).toBe('999.0000');
      } finally {
        await ownerContext(TENANT_A, COMPANY_A1);
        await owner.query('UPDATE sales_orders SET total = $2 WHERE id = $1', [
          ORDER[COMPANY_A1],
          TOTAL[COMPANY_A1],
        ]);
      }
    });

    it('omits what the backend has no source for, rather than inventing it', async () => {
      // The screen also shows an invoiced total, related documents and notes. None of those has a
      // table yet, and section 12.4 is explicit that a stored links array is the wrong answer. So
      // they are absent here rather than guessed.
      const order = await read(IN_A1, ORDER[COMPANY_A1]!);

      expect(order).not.toHaveProperty('invoicedTotal');
      expect(order).not.toHaveProperty('links');
      expect(order).not.toHaveProperty('notes');
    });
  });

  // -------------------------------------------------------------------------------------
  // What it refuses.
  // -------------------------------------------------------------------------------------

  describe('an order it may not see', () => {
    it('answers nothing for an order in a sibling company', async () => {
      // A real order that really exists. Row level security and the scoped predicate both refuse
      // it, and the answer is the same as for an order that exists nowhere.
      expect(await read(IN_A1, ORDER[COMPANY_A2]!)).toBeNull();
    });

    it('answers nothing for an order in another tenant', async () => {
      expect(await read(IN_A1, ORDER[COMPANY_B1]!)).toBeNull();
    });

    it('answers nothing for an order that does not exist', async () => {
      expect(await read(IN_A1, 'ca990000-0000-4000-8000-00000000000f')).toBeNull();
    });

    it('gives each company its own order under the same call', async () => {
      // The clearest form of the isolation: one function, three scopes, three answers, and the
      // figures differ so a leak would be visible as the wrong money rather than as a match.
      expect((await read(IN_A1, ORDER[COMPANY_A1]!))?.total).toBe('110.0000');
      expect((await read(IN_A2, ORDER[COMPANY_A2]!))?.total).toBe('220.0000');
      expect((await read(IN_B1, ORDER[COMPANY_B1]!))?.total).toBe('330.0000');
    });

    it('returns no lines from another company even when the order is refused', async () => {
      const order = await read(IN_A1, ORDER[COMPANY_B1]!);

      expect(order).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------
  // The nullable rep.
  // -------------------------------------------------------------------------------------

  describe('an order with nobody recorded as its rep', () => {
    it('answers null rather than an empty person', async () => {
      // The column permits it, so the read has to. A fabricated name would be a person who does
      // not exist appearing on a document.
      const orderId = nextId();
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(
        `INSERT INTO sales_orders
           (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
         VALUES ($1,$2,$3,'draft',$4,$5,current_date,'USD')`,
        [orderId, TENANT_A, COMPANY_A1, CUSTOMER[COMPANY_A1], WAREHOUSE[COMPANY_A1]],
      );

      try {
        const order = await read(IN_A1, orderId);

        expect(order?.salesRep).toBeNull();
        expect(order?.lines).toEqual([]);
      } finally {
        await ownerContext(TENANT_A, COMPANY_A1);
        await owner.query('DELETE FROM sales_orders WHERE id = $1', [orderId]);
      }
    });
  });
});
