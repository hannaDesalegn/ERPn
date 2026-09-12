/**
 * Editing a sales order draft, against a real PostgreSQL.
 *
 * Section 12.2 makes a draft editable and says it has no side effects, so an edit is a rewrite
 * with nothing to unwind. What is worth proving is the two things a rewrite can get wrong: that a
 * refused edit leaves the previous draft exactly as it was, and that two people editing one draft
 * resolve to one winner with the loser changing nothing at all.
 *
 * THE RACE IS COORDINATED RATHER THAN TIMED. Both editors read the same version, the first is held
 * open until the second has reached its write, and only then released. A test that fired two edits
 * and hoped they overlapped would prove nothing on a fast machine.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, ConcurrencyConflictError, UnitOfWork } from '../database/index.js';
import type { ActorScope } from '../database/index.js';
import type { CompanyContext } from '../identity/identity.service.js';
import { SalesModule } from './sales.module.js';
import { SalesOrderDraftError, SalesOrderService } from './sales-order.service.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'd5100000-0000-4000-8000-00000000000a';
const TENANT_B = 'd5200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'd5300000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "same tenant, different company" is representable. */
const COMPANY_A2 = 'd5400000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'd5500000-0000-4000-8000-00000000000c';

const USER = 'd5600000-0000-4000-8000-00000000000a';

const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'd6110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd6120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd6130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'd6210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd6220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd6230000-0000-4000-8000-00000000000c',
};
const WIDGET: Record<string, string> = {
  [COMPANY_A1]: 'd6310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'd6320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'd6330000-0000-4000-8000-00000000000c',
};
/** A second customer, warehouse and product in the acting company, so a change is visible. */
const OTHER_CUSTOMER = 'd6410000-0000-4000-8000-00000000000a';
const OTHER_WAREHOUSE = 'd6510000-0000-4000-8000-00000000000a';
const GADGET = 'd6610000-0000-4000-8000-00000000000a';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const contextFor = (tenantId: string, companyId: string): CompanyContext => ({
  tenantId,
  companyId,
  membershipId: 'd7100000-0000-4000-8000-00000000000a',
});

const scopeFor = (tenantId: string, companyId: string): ActorScope =>
  actorScope({ tenantId, companyId, userId: USER });

const IN_A1 = contextFor(TENANT_A, COMPANY_A1);
const IN_A2 = contextFor(TENANT_A, COMPANY_A2);
const SCOPE_A1 = scopeFor(TENANT_A, COMPANY_A1);

/** A promise with its resolver, for holding a transaction open from outside it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

const settle = (ms = 300) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Editing a sales order draft', () => {
  let sales: SalesOrderService;
  let uow: UnitOfWork;
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
    uow = moduleRef.get(UnitOfWork);
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
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [companyId]);
    }
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'edit-a',
      'Edit A',
      TENANT_B,
      'edit-b',
      'Edit B',
    ]);
    await owner.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)', [
      USER,
      'editor@edit.test',
      'Editor',
      'not-a-real-hash',
    ]);

    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query(
        `INSERT INTO companies (id, tenant_id, name, base_currency, standard_tax_rate_percent)
         VALUES ($1,$2,$3,'USD','10.000000')`,
        [companyId, tenantId, `Company ${companyId.slice(0, 4)}`],
      );
      await owner.query(
        'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
        [CUSTOMER[companyId], tenantId, companyId, 'CUST-1', 'First customer'],
      );
      await owner.query(
        'INSERT INTO warehouses (id, tenant_id, company_id, code, name, is_default) VALUES ($1,$2,$3,$4,$5,true)',
        [WAREHOUSE[companyId], tenantId, companyId, 'WH-1', 'Main'],
      );
      await owner.query(
        `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
         VALUES ($1,$2,$3,'SKU-W','Widget','unit','10.000000','USD')`,
        [WIDGET[companyId], tenantId, companyId],
      );
    }

    await ownerContext(TENANT_A, COMPANY_A1);
    await owner.query(
      'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
      [OTHER_CUSTOMER, TENANT_A, COMPANY_A1, 'CUST-2', 'Second customer'],
    );
    await owner.query(
      'INSERT INTO warehouses (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
      [OTHER_WAREHOUSE, TENANT_A, COMPANY_A1, 'WH-2', 'Overflow'],
    );
    await owner.query(
      `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
       VALUES ($1,$2,$3,'SKU-G','Gadget','unit','4.000000','USD')`,
      [GADGET, TENANT_A, COMPANY_A1],
    );
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
    await owner.query('DELETE FROM users WHERE id = $1', [USER]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  /** A draft to edit, created through the real path so its figures are the server's. */
  const createDraft = (context: CompanyContext, quantity = '2') =>
    sales.createDraft(context, USER, {
      customerId: CUSTOMER[context.companyId]!,
      warehouseId: WAREHOUSE[context.companyId]!,
      orderDate: '2026-09-11',
      lines: [{ productId: WIDGET[context.companyId]!, quantity }],
    });

  const edit = (
    context: CompanyContext,
    salesOrderId: string,
    expectedVersion: number,
    overrides: Record<string, unknown> = {},
  ) =>
    uow.inActorScope(scopeFor(context.tenantId, context.companyId), (repos) =>
      sales.updateDraftIn(repos, context.companyId, {
        salesOrderId,
        expectedVersion,
        customerId: CUSTOMER[context.companyId]!,
        warehouseId: WAREHOUSE[context.companyId]!,
        orderDate: '2026-09-11',
        lines: [{ productId: WIDGET[context.companyId]!, quantity: '5' }],
        ...overrides,
      } as Parameters<typeof sales.updateDraftIn>[2]),
    );

  const stored = async (tenantId: string, companyId: string, id: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      status: string;
      doc_number: string | null;
      version: number;
      customer_id: string;
      warehouse_id: string;
      order_date: string;
      subtotal: string;
      total: string;
    }>(
      // The date column is read as text so the driver does not turn it into a Date and shift it
      // through the local timezone on the way. What is stored is a calendar day, not an instant.
      'SELECT *, order_date::text AS order_date FROM sales_orders WHERE id = $1',
      [id],
    );
    return rows.rows[0];
  };

  const storedLines = async (tenantId: string, companyId: string, id: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      line_number: number;
      product_id: string;
      quantity: string;
      unit_price: string;
      line_total: string;
    }>('SELECT * FROM sales_order_lines WHERE sales_order_id = $1 ORDER BY line_number', [id]);
    return rows.rows;
  };

  const refusal = async (work: Promise<unknown>) => {
    const error = await work.then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).not.toBeNull();
    return error;
  };

  // -------------------------------------------------------------------------------------
  // A successful edit.
  // -------------------------------------------------------------------------------------

  describe('a draft that is edited', () => {
    it('keeps its identity and stays a draft with no number', async () => {
      const { order } = await createDraft(IN_A1);

      const edited = await edit(IN_A1, order.id, order.version);

      expect(edited.order.id).toBe(order.id);
      expect(edited.order.status).toBe('draft');
      expect(edited.order.docNumber).toBeNull();
    });

    it('advances the version by exactly one', async () => {
      // Section 10.1's token. `setTotals` runs afterwards and deliberately does not touch it, so
      // one edit is one increment however many statements it took.
      const { order } = await createDraft(IN_A1);

      const edited = await edit(IN_A1, order.id, order.version);

      expect(edited.order.version).toBe(order.version + 1);
    });

    it('takes the header fields the caller changed', async () => {
      const { order } = await createDraft(IN_A1);

      await edit(IN_A1, order.id, order.version, {
        customerId: OTHER_CUSTOMER,
        warehouseId: OTHER_WAREHOUSE,
        orderDate: '2026-09-20',
        expectedDeliveryDate: '2026-09-30',
      });

      const after = await stored(TENANT_A, COMPANY_A1, order.id);
      expect(after).toMatchObject({
        customer_id: OTHER_CUSTOMER,
        warehouse_id: OTHER_WAREHOUSE,
      });
      expect(after?.order_date).toBe('2026-09-20');
    });

    it('replaces the lines and renumbers them from one', async () => {
      const { order } = await createDraft(IN_A1);

      await edit(IN_A1, order.id, order.version, {
        lines: [
          { productId: GADGET, quantity: '3' },
          { productId: WIDGET[COMPANY_A1]!, quantity: '1' },
        ],
      });

      const lines = await storedLines(TENANT_A, COMPANY_A1, order.id);
      expect(lines.map((line) => line.line_number)).toEqual([1, 2]);
      expect(lines.map((line) => line.product_id)).toEqual([GADGET, WIDGET[COMPANY_A1]]);
    });

    it('leaves no line from the previous version behind', async () => {
      const { order, lines } = await createDraft(IN_A1);

      await edit(IN_A1, order.id, order.version, {
        lines: [{ productId: GADGET, quantity: '1' }],
      });

      const after = await storedLines(TENANT_A, COMPANY_A1, order.id);
      expect(after).toHaveLength(1);
      expect(lines[0]?.productId).toBe(WIDGET[COMPANY_A1]);
      expect(after[0]?.product_id).toBe(GADGET);
    });

    it('reprices from master data rather than from anything sent', async () => {
      // Four gadgets at the catalogue price of four, taxed at ten per cent. The caller named the
      // product and the quantity and nothing else.
      const { order } = await createDraft(IN_A1);

      await edit(IN_A1, order.id, order.version, {
        lines: [{ productId: GADGET, quantity: '4' }],
      });

      const [line] = await storedLines(TENANT_A, COMPANY_A1, order.id);
      expect(line?.unit_price).toBe('4.000000');
      expect(line?.line_total).toBe('17.6000');
      expect((await stored(TENANT_A, COMPANY_A1, order.id))?.total).toBe('17.6000');
    });

    it('recomputes the document totals from the lines it wrote', async () => {
      const { order } = await createDraft(IN_A1);

      await edit(IN_A1, order.id, order.version, {
        lines: [
          { productId: WIDGET[COMPANY_A1]!, quantity: '2' },
          { productId: GADGET, quantity: '5' },
        ],
      });

      // Two widgets at ten and five gadgets at four is forty before tax.
      expect(await stored(TENANT_A, COMPANY_A1, order.id)).toMatchObject({
        subtotal: '40.0000',
        total: '44.0000',
      });
    });

    it('can be edited again, carrying the version it just returned', async () => {
      const { order } = await createDraft(IN_A1);

      const once = await edit(IN_A1, order.id, order.version);
      const twice = await edit(IN_A1, order.id, once.order.version);

      expect(twice.order.version).toBe(order.version + 2);
    });
  });

  // -------------------------------------------------------------------------------------
  // What a caller cannot do.
  // -------------------------------------------------------------------------------------

  describe('what the caller cannot change', () => {
    it('has no field for the status, the number, the totals or the version', async () => {
      const { order } = await createDraft(IN_A1);

      const smuggled = {
        status: 'confirmed',
        docNumber: 'SO-9999',
        subtotal: '0.0001',
        total: '0.0001',
        version: 99,
        currency: 'ZZZ',
        tenantId: TENANT_B,
        companyId: COMPANY_B1,
      };

      await edit(IN_A1, order.id, order.version, smuggled);

      const after = await stored(TENANT_A, COMPANY_A1, order.id);
      expect(after).toMatchObject({ status: 'draft', doc_number: null, version: order.version + 1 });
      expect(after?.total).not.toBe('0.0001');
    });

    it('cannot smuggle a price onto a line', async () => {
      const { order } = await createDraft(IN_A1);

      await edit(IN_A1, order.id, order.version, {
        lines: [
          {
            productId: GADGET,
            quantity: '1',
            unitPrice: '0.010000',
            lineTotal: '0.0100',
            productName: 'Something else',
          },
        ],
      });

      const [line] = await storedLines(TENANT_A, COMPANY_A1, order.id);
      expect(line?.unit_price).toBe('4.000000');
      expect(line?.line_total).toBe('4.4000');
    });
  });

  // -------------------------------------------------------------------------------------
  // Scope.
  // -------------------------------------------------------------------------------------

  describe('scope', () => {
    it('refuses an order belonging to a sibling company', async () => {
      const theirs = await createDraft(IN_A2);

      const error = await refusal(edit(IN_A1, theirs.order.id, theirs.order.version));

      expect((error as SalesOrderDraftError).reason).toBe('order_not_found');
      expect((await stored(TENANT_A, COMPANY_A2, theirs.order.id))?.version).toBe(
        theirs.order.version,
      );
    });

    it('refuses an order belonging to another tenant', async () => {
      const theirs = await createDraft(contextFor(TENANT_B, COMPANY_B1));

      const error = await refusal(edit(IN_A1, theirs.order.id, theirs.order.version));

      expect((error as SalesOrderDraftError).reason).toBe('order_not_found');
    });

    it('refuses a customer from a sibling company', async () => {
      const { order } = await createDraft(IN_A1);

      const error = await refusal(
        edit(IN_A1, order.id, order.version, { customerId: CUSTOMER[COMPANY_A2] }),
      );

      expect((error as SalesOrderDraftError).reason).toBe('customer_not_found');
    });

    it('refuses a product from a sibling company', async () => {
      const { order } = await createDraft(IN_A1);

      const error = await refusal(
        edit(IN_A1, order.id, order.version, {
          lines: [{ productId: WIDGET[COMPANY_A2]!, quantity: '1' }],
        }),
      );

      expect((error as SalesOrderDraftError).reason).toBe('product_not_found');
    });
  });

  // -------------------------------------------------------------------------------------
  // A refused edit leaves the draft exactly as it was.
  // -------------------------------------------------------------------------------------

  describe('a refused edit', () => {
    it('refuses an order that is no longer a draft', async () => {
      const { order } = await createDraft(IN_A1);
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(
        `UPDATE sales_orders SET status = 'confirmed', doc_number = 'SO-0001' WHERE id = $1`,
        [order.id],
      );

      const error = await refusal(edit(IN_A1, order.id, order.version));

      expect((error as SalesOrderDraftError).reason).toBe('not_a_draft');
      expect((error as Error).message).toMatch(/confirmed sales order cannot be edited/);
    });

    it('refuses an order with no lines', async () => {
      const { order } = await createDraft(IN_A1);

      const error = await refusal(edit(IN_A1, order.id, order.version, { lines: [] }));

      expect((error as SalesOrderDraftError).reason).toBe('no_lines');
    });

    it.each(['0', '-1', 'abc'])('refuses a quantity of %s', async (quantity) => {
      const { order } = await createDraft(IN_A1);

      const error = await refusal(
        edit(IN_A1, order.id, order.version, {
          lines: [{ productId: GADGET, quantity }],
        }),
      );

      expect((error as SalesOrderDraftError).reason).toBe('invalid_quantity');
    });

    it('leaves the header and every line exactly as they were', async () => {
      // The invariant this whole capability turns on: a refused edit is not a partial edit.
      const { order } = await createDraft(IN_A1, '7');
      const before = await stored(TENANT_A, COMPANY_A1, order.id);
      const linesBefore = await storedLines(TENANT_A, COMPANY_A1, order.id);

      await refusal(
        edit(IN_A1, order.id, order.version, {
          customerId: OTHER_CUSTOMER,
          lines: [
            { productId: GADGET, quantity: '3' },
            { productId: WIDGET[COMPANY_A2]!, quantity: '1' },
          ],
        }),
      );

      expect(await stored(TENANT_A, COMPANY_A1, order.id)).toEqual(before);
      expect(await storedLines(TENANT_A, COMPANY_A1, order.id)).toEqual(linesBefore);
    });
  });

  // -------------------------------------------------------------------------------------
  // The optimistic lock, which is the point of section 10.1.
  // -------------------------------------------------------------------------------------

  describe('two people editing one draft', () => {
    it('refuses the second, who carried a version that has moved', async () => {
      const { order } = await createDraft(IN_A1);

      await edit(IN_A1, order.id, order.version);
      const error = await refusal(edit(IN_A1, order.id, order.version));

      expect(error).toBeInstanceOf(ConcurrencyConflictError);
      expect((error as Error).message).toMatch(/modified by someone else/);
    });

    it('lets exactly one of two concurrent editors through', async () => {
      const { order } = await createDraft(IN_A1);

      const held = gate();
      let secondSettled = false;

      const first = uow.inActorScope(SCOPE_A1, async (repos) => {
        await sales.updateDraftIn(repos, COMPANY_A1, {
          salesOrderId: order.id,
          expectedVersion: order.version,
          customerId: CUSTOMER[COMPANY_A1]!,
          warehouseId: WAREHOUSE[COMPANY_A1]!,
          orderDate: '2026-09-11',
          lines: [{ productId: WIDGET[COMPANY_A1]!, quantity: '11' }],
        });
        await held.promise;
      });

      await settle(150);

      const second = uow
        .inActorScope(SCOPE_A1, (repos) =>
          sales.updateDraftIn(repos, COMPANY_A1, {
            salesOrderId: order.id,
            expectedVersion: order.version,
            customerId: CUSTOMER[COMPANY_A1]!,
            warehouseId: WAREHOUSE[COMPANY_A1]!,
            orderDate: '2026-09-11',
            lines: [{ productId: GADGET, quantity: '22' }],
          }),
        )
        .then(
          () => 'succeeded' as const,
          (error: unknown) => error,
        )
        .then((outcome) => {
          secondSettled = true;
          return outcome;
        });

      await settle();
      // Blocked on the row the first transaction is updating. Without the version guard both
      // would proceed and the second would overwrite the first.
      expect(secondSettled).toBe(false);

      held.open();
      await first;
      const outcome = await second;

      expect(outcome).toBeInstanceOf(ConcurrencyConflictError);

      // The winner's order, whole: its quantity, one line, and one version increment.
      const lines = await storedLines(TENANT_A, COMPANY_A1, order.id);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.quantity).toBe('11.000000');
      expect((await stored(TENANT_A, COMPANY_A1, order.id))?.version).toBe(order.version + 1);
    });

    it('leaves the loser having changed nothing at all', async () => {
      // The half of the race that matters most. The loser priced its lines and reached the header
      // write before failing, so the question is whether any of that survived.
      const { order } = await createDraft(IN_A1);

      await edit(IN_A1, order.id, order.version, {
        lines: [{ productId: WIDGET[COMPANY_A1]!, quantity: '9' }],
      });

      const after = await stored(TENANT_A, COMPANY_A1, order.id);
      const linesAfter = await storedLines(TENANT_A, COMPANY_A1, order.id);

      await refusal(
        edit(IN_A1, order.id, order.version, {
          customerId: OTHER_CUSTOMER,
          lines: [{ productId: GADGET, quantity: '1' }],
        }),
      );

      expect(await stored(TENANT_A, COMPANY_A1, order.id)).toEqual(after);
      expect(await storedLines(TENANT_A, COMPANY_A1, order.id)).toEqual(linesAfter);
    });

    it('refuses an editor whose order was confirmed under them', async () => {
      // A version that still matches, on an order that has moved out of draft. The header write
      // asks the state question again for exactly this.
      const { order } = await createDraft(IN_A1);
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(
        `UPDATE sales_orders SET status = 'confirmed', doc_number = 'SO-0002' WHERE id = $1`,
        [order.id],
      );

      const error = await refusal(edit(IN_A1, order.id, order.version));

      expect(error).not.toBeNull();
      expect((await storedLines(TENANT_A, COMPANY_A1, order.id)).length).toBeGreaterThan(0);
    });
  });
});
