/**
 * Cancelling a sales order, against a real PostgreSQL.
 *
 * Section 12.3 makes cancelling three things at once: a status change, a
 * release of everything the order holds, and an audit record. Section 12.2's shape applies to it
 * whole: all of them or none. Most of what follows is an attempt to get one of the three without
 * the others, and what must be true afterwards is always the same, that nothing survives.
 *
 * THE ROLLBACK TESTS FAIL REAL WRITES, with a trigger the owning role installs and drops, rather
 * than a seam in the production code. A seam that exists only to be failed proves the seam.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, UnitOfWork } from '../database/index.js';
import type { ActorScope } from '../database/index.js';
import type { CompanyContext } from '../identity/identity.service.js';
import { cancelSalesOrder, MAX_REASON_LENGTH, SalesOrderCancellationError } from './cancel-sales-order.js';
import { confirmSalesOrder } from './confirm-sales-order.js';
import { IllegalSalesOrderTransitionError } from './sales-order-status.js';
import { SALES_ORDER_DOC_TYPE } from './document-numbers.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'e1100000-0000-4000-8000-00000000000a';
const TENANT_B = 'e1200000-0000-4000-8000-00000000000b';

const COMPANY_A1 = 'e1300000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "same tenant, different company" is representable. */
const COMPANY_A2 = 'e1400000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'e1500000-0000-4000-8000-00000000000c';

const CANCELLER = 'e1600000-0000-4000-8000-00000000000a';
/** Holds sales:view and sales:confirm but not sales:cancel, so refusal is about the capability. */
const SELLER = 'e1700000-0000-4000-8000-00000000000b';

const CANCELLER_MEMBERSHIP: Record<string, string> = {
  [COMPANY_A1]: 'e1810000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'e1820000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'e1830000-0000-4000-8000-00000000000c',
};
const SELLER_MEMBERSHIP = 'e1900000-0000-4000-8000-00000000000b';

const membershipFor = (companyId: string, userId: string) =>
  userId === SELLER ? SELLER_MEMBERSHIP : CANCELLER_MEMBERSHIP[companyId]!;

const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'e2110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'e2120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'e2130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'e2210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'e2220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'e2230000-0000-4000-8000-00000000000c',
};
const WIDGET: Record<string, string> = {
  [COMPANY_A1]: 'e2310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'e2320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'e2330000-0000-4000-8000-00000000000c',
};
/** A second product in the acting company, so an order can hold two keys at once. */
const GADGET = 'e2410000-0000-4000-8000-00000000000a';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const ROLE: Record<string, string> = {
  [COMPANY_A1]: 'e2510000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'e2520000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'e2530000-0000-4000-8000-00000000000c',
};
const SELLER_ROLE = 'e2610000-0000-4000-8000-00000000000a';

let sequence = 0;
const nextId = (prefix: string) =>
  `${prefix}${(sequence += 1).toString().padStart(6, '0')}-0000-4000-8000-00000000000a`;

const scopeFor = (tenantId: string, companyId: string, userId = CANCELLER): ActorScope =>
  actorScope({ tenantId, companyId, userId });

const contextFor = (tenantId: string, companyId: string, userId = CANCELLER): CompanyContext => ({
  tenantId,
  companyId,
  membershipId: membershipFor(companyId, userId),
});

const IN_A1 = scopeFor(TENANT_A, COMPANY_A1);
const IN_A2 = scopeFor(TENANT_A, COMPANY_A2);
const CONTEXT_A1 = contextFor(TENANT_A, COMPANY_A1);
const CONTEXT_A2 = contextFor(TENANT_A, COMPANY_A2);

const AS_SELLER = scopeFor(TENANT_A, COMPANY_A1, SELLER);
const CONTEXT_SELLER = contextFor(TENANT_A, COMPANY_A1, SELLER);

/** A promise with its resolver, for holding a transaction open from outside it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

const settle = (ms = 300) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Cancelling a sales order', () => {
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
      imports: [AppConfigModule, DatabaseModule],
    }).compile();
    await moduleRef.init();

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
      await owner.query('DELETE FROM stock_reservations WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_movements WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_balances WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [companyId]);
      await owner.query(
        'UPDATE document_number_sequences SET next_value = 1 WHERE company_id = $1',
        [companyId],
      );
    }
    await ownerContext();
    await owner.query('TRUNCATE audit_events');
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'cancel-a',
      'Cancel A',
      TENANT_B,
      'cancel-b',
      'Cancel B',
    ]);
    await owner.query(
      'INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4), ($5,$6,$7,$4)',
      [
        CANCELLER,
        'canceller@cancel.test',
        'Canceller',
        'not-a-real-hash',
        SELLER,
        'seller@cancel.test',
        'Seller',
      ],
    );

    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query(
        'INSERT INTO companies (id, tenant_id, name, base_currency) VALUES ($1,$2,$3,$4)',
        [companyId, tenantId, `Company ${companyId.slice(0, 4)}`, 'USD'],
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
         VALUES ($1,$2,$3,'SKU-W','Widget','unit','10.000000','USD')`,
        [WIDGET[companyId], tenantId, companyId],
      );
      await owner.query(
        `INSERT INTO document_number_sequences (id, tenant_id, company_id, doc_type, prefix, gapless, next_value)
         VALUES ($1,$2,$3,$4,'SO-',true,1)`,
        [nextId('e3'), tenantId, companyId, SALES_ORDER_DOC_TYPE],
      );
      await owner.query(
        'INSERT INTO roles (id, tenant_id, company_id, key, name) VALUES ($1,$2,$3,$4,$5)',
        [ROLE[companyId], tenantId, companyId, 'manager', 'Manager'],
      );
      // Confirm as well as cancel, so one user can set up the state the other tests cancel from.
      await owner.query(
        `INSERT INTO role_permissions (tenant_id, company_id, role_id, permission)
         VALUES ($1,$2,$3,$4), ($1,$2,$3,$5), ($1,$2,$3,$6)`,
        [tenantId, companyId, ROLE[companyId], 'sales:cancel', 'sales:confirm', 'sales:view'],
      );
      await owner.query(
        'INSERT INTO memberships (id, tenant_id, company_id, user_id) VALUES ($1,$2,$3,$4)',
        [CANCELLER_MEMBERSHIP[companyId], tenantId, companyId, CANCELLER],
      );
      await owner.query(
        'INSERT INTO membership_roles (tenant_id, company_id, membership_id, role_id) VALUES ($1,$2,$3,$4)',
        [tenantId, companyId, CANCELLER_MEMBERSHIP[companyId], ROLE[companyId]],
      );
    }

    await ownerContext(TENANT_A, COMPANY_A1);
    await owner.query(
      `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
       VALUES ($1,$2,$3,'SKU-G','Gadget','unit','5.000000','USD')`,
      [GADGET, TENANT_A, COMPANY_A1],
    );
    // Can raise and confirm orders, and cannot cancel them. The separation the catalogue draws.
    await owner.query(
      'INSERT INTO roles (id, tenant_id, company_id, key, name) VALUES ($1,$2,$3,$4,$5)',
      [SELLER_ROLE, TENANT_A, COMPANY_A1, 'sales', 'Sales'],
    );
    await owner.query(
      `INSERT INTO role_permissions (tenant_id, company_id, role_id, permission)
       VALUES ($1,$2,$3,$4), ($1,$2,$3,$5)`,
      [TENANT_A, COMPANY_A1, SELLER_ROLE, 'sales:view', 'sales:confirm'],
    );
    await owner.query(
      'INSERT INTO memberships (id, tenant_id, company_id, user_id) VALUES ($1,$2,$3,$4)',
      [SELLER_MEMBERSHIP, TENANT_A, COMPANY_A1, SELLER],
    );
    await owner.query(
      'INSERT INTO membership_roles (tenant_id, company_id, membership_id, role_id) VALUES ($1,$2,$3,$4)',
      [TENANT_A, COMPANY_A1, SELLER_MEMBERSHIP, SELLER_ROLE],
    );
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM stock_reservations WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_movements WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM stock_balances WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_order_lines WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM document_number_sequences WHERE company_id = $1', [companyId]);
      await owner.query(
        'DELETE FROM membership_roles WHERE membership_id IN (SELECT id FROM memberships WHERE company_id = $1)',
        [companyId],
      );
      await owner.query('DELETE FROM memberships WHERE company_id = $1', [companyId]);
      await owner.query(
        'DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE company_id = $1)',
        [companyId],
      );
      await owner.query('DELETE FROM roles WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM products WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM warehouses WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[CANCELLER, SELLER]]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  /** Puts stock on a shelf through the ledger, the way the system does. */
  const stock = (scope: ActorScope, productId: string, quantity: string) =>
    uow.inActorScope(scope, (repositories) =>
      repositories.stockLedger.record({
        id: nextId('e4'),
        productId,
        warehouseId: WAREHOUSE[scope.companyId]!,
        quantity,
        reason: 'purchase_receipt',
        sourceDocType: 'purchase_order',
        sourceDocId: nextId('e5'),
      }),
    );

  /** A draft with the lines given, written directly so its figures are the test's to choose. */
  async function draft(
    tenantId: string,
    companyId: string,
    lines: { productId: string; quantity: string }[],
  ): Promise<string> {
    const orderId = nextId('e6');
    await ownerContext(tenantId, companyId);
    await owner.query(
      `INSERT INTO sales_orders (id, tenant_id, company_id, status, customer_id, warehouse_id, order_date, currency)
       VALUES ($1,$2,$3,'draft',$4,$5,current_date,'USD')`,
      [orderId, tenantId, companyId, CUSTOMER[companyId], WAREHOUSE[companyId]],
    );

    let lineNumber = 0;
    for (const line of lines) {
      lineNumber += 1;
      await owner.query(
        `INSERT INTO sales_order_lines
           (id, tenant_id, company_id, sales_order_id, line_number, product_id, product_sku, product_name,
            quantity, unit_price, currency)
         VALUES ($1,$2,$3,$4,$5,$6,'SKU','Product',$7,'10.000000','USD')`,
        [nextId('e7'), tenantId, companyId, orderId, lineNumber, line.productId, line.quantity],
      );
    }

    return orderId;
  }

  /** A draft, confirmed. The state most of these tests cancel from. */
  async function confirmed(
    tenantId: string,
    companyId: string,
    lines: { productId: string; quantity: string }[],
  ): Promise<string> {
    const orderId = await draft(tenantId, companyId, lines);
    await uow.inActorScope(scopeFor(tenantId, companyId), (repositories) =>
      confirmSalesOrder(repositories, contextFor(tenantId, companyId), { salesOrderId: orderId }),
    );
    return orderId;
  }

  const cancel = (
    scope: ActorScope,
    context: CompanyContext,
    salesOrderId: string,
    reason?: string,
  ) =>
    uow.inActorScope(scope, (repositories) =>
      cancelSalesOrder(repositories, context, { salesOrderId, reason }),
    );

  const orderRow = async (tenantId: string, companyId: string, id: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{ status: string; doc_number: string | null; version: number }>(
      'SELECT status, doc_number, version FROM sales_orders WHERE id = $1',
      [id],
    );
    return rows.rows[0];
  };

  const counterFor = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{ next_value: string }>(
      'SELECT next_value FROM document_number_sequences WHERE company_id = $1 AND doc_type = $2',
      [companyId, SALES_ORDER_DOC_TYPE],
    );
    return rows.rows[0]?.next_value;
  };

  const reservationsIn = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      id: string;
      quantity: string;
      released_at: Date | null;
      version: number;
    }>('SELECT id, quantity, released_at, version FROM stock_reservations ORDER BY reserved_at');
    return rows.rows;
  };

  const availability = (scope: ActorScope, productId: string) =>
    uow.inActorScope(scope, (repositories) =>
      repositories.stockLedger.availabilityForUpdate(productId, WAREHOUSE[scope.companyId]!),
    );

  const cancellationAudit = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{
      action: string;
      entity_id: string;
      actor_user_id: string;
      summary: string;
      changes: Record<string, unknown>;
      xmin: string;
    }>(
      // Filtered by company as well as by action. The select policy on this table compares the
      // tenant alone, because a platform level row has no company, so a query that asked only
      // for the action would see a sibling company's row and call it this company's.
      `SELECT action, entity_id, actor_user_id, summary, changes, xmin::text AS xmin
         FROM audit_events WHERE action = 'sales_order_cancelled' AND company_id = $1`,
      [companyId],
    );
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
  // 1. Cancelling a confirmed order.
  // -------------------------------------------------------------------------------------

  describe('a confirmed order', () => {
    it('becomes cancelled and keeps the number it was issued', async () => {
      // Section 12.3: a cancelled confirmed order keeps its number, because the business did
      // raise that document. The number is not reissued and not withdrawn.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      const { order } = await cancel(IN_A1, CONTEXT_A1, orderId);

      expect(order.status).toBe('cancelled');
      expect(order.docNumber).toBe('SO-0001');
      expect(await orderRow(TENANT_A, COMPANY_A1, orderId)).toMatchObject({
        status: 'cancelled',
        doc_number: 'SO-0001',
      });
    });

    it('releases every reservation it held', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      await stock(IN_A1, GADGET, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
        { productId: GADGET, quantity: '4' },
        { productId: WIDGET[COMPANY_A1]!, quantity: '6' },
      ]);

      const { releasedReservationIds } = await cancel(IN_A1, CONTEXT_A1, orderId);

      expect(releasedReservationIds).toHaveLength(3);
      const rows = await reservationsIn(TENANT_A, COMPANY_A1);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.released_at).toBeInstanceOf(Date);
      }
    });

    it('gives the stock back to available', async () => {
      // Section 8.5's identity, after the release: available is on hand minus what is still
      // actively reserved, and a cancelled order holds nothing.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '30' },
      ]);
      expect((await availability(IN_A1, WIDGET[COMPANY_A1]!)).available).toBe('70.000000');

      await cancel(IN_A1, CONTEXT_A1, orderId);

      const after = await availability(IN_A1, WIDGET[COMPANY_A1]!);
      expect(after.reserved).toBe('0.000000');
      expect(after.available).toBe('100.000000');
      // On hand is untouched. Cancelling releases a promise, it does not move goods.
      expect(after.onHand).toBe('100.000000');
    });

    it('reports how much came back, summed exactly', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '0.000001' },
        { productId: WIDGET[COMPANY_A1]!, quantity: '0.000002' },
      ]);

      const { releasedQuantity } = await cancel(IN_A1, CONTEXT_A1, orderId);

      expect(releasedQuantity).toBe('0.000003');
    });

    it('leaves another order’s reservations alone', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const mine = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);
      const theirs = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '25' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, mine);

      expect((await availability(IN_A1, WIDGET[COMPANY_A1]!)).reserved).toBe('25.000000');
      expect((await orderRow(TENANT_A, COMPANY_A1, theirs))?.status).toBe('confirmed');
    });

    it('allocates no new number, so the series is untouched', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);
      expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('2');

      await cancel(IN_A1, CONTEXT_A1, orderId);

      expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('2');
    });

    it('moves the version on, so a stale editor cannot overwrite it', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);
      const before = (await orderRow(TENANT_A, COMPANY_A1, orderId))?.version ?? 0;

      await cancel(IN_A1, CONTEXT_A1, orderId);

      expect((await orderRow(TENANT_A, COMPANY_A1, orderId))?.version).toBe(before + 1);
    });
  });

  // -------------------------------------------------------------------------------------
  // 2. Cancelling a draft.
  // -------------------------------------------------------------------------------------

  describe('a draft', () => {
    it('becomes cancelled and stays unnumbered', async () => {
      // The half of section 12.3 that needed migration 0012. A draft raised nothing,
      // so it is not given a number on the way out.
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      const { order } = await cancel(IN_A1, CONTEXT_A1, orderId);

      expect(order.status).toBe('cancelled');
      expect(order.docNumber).toBeNull();
      expect(await orderRow(TENANT_A, COMPANY_A1, orderId)).toMatchObject({
        status: 'cancelled',
        doc_number: null,
      });
    });

    it('consumes no document number', async () => {
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, orderId);

      expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('1');
    });

    it('releases nothing, because a draft holds nothing', async () => {
      // Section 12.2: a draft has no side effects. Nothing was reserved, so nothing comes back,
      // and an empty release is a real answer rather than a special case.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      const result = await cancel(IN_A1, CONTEXT_A1, orderId);

      expect(result.releasedReservationIds).toEqual([]);
      expect(result.releasedQuantity).toBe('0.000000');
      expect((await availability(IN_A1, WIDGET[COMPANY_A1]!)).available).toBe('100.000000');
    });

    it('is still audited, because the document moved', async () => {
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, orderId);

      const [event] = await cancellationAudit(TENANT_A, COMPANY_A1);
      expect(event?.entity_id).toBe(orderId);
      // Described rather than numbered, because there is no number to name it by.
      expect(event?.summary).toBe('Cancelled a draft sales order');
    });
  });

  // -------------------------------------------------------------------------------------
  // 3. The audit record.
  // -------------------------------------------------------------------------------------

  describe('the audit record', () => {
    it('names the actor from the session and what changed', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, orderId);

      const [event] = await cancellationAudit(TENANT_A, COMPANY_A1);
      expect(event?.actor_user_id).toBe(CANCELLER);
      expect(event?.summary).toBe('Cancelled sales order SO-0001');
      expect(event?.changes).toMatchObject({
        status: { from: 'confirmed', to: 'cancelled' },
        releasedReservations: 1,
        releasedQuantity: '10.000000',
      });
    });

    it('is written in the same transaction as the change, per section 7.1', async () => {
      // The transaction id the audit row recorded against the transaction that last wrote the
      // order row. Equal means one transaction did both, which is what the clause requires.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, orderId);

      await ownerContext(TENANT_A, COMPANY_A1);
      const order = await owner.query<{ xmin: string }>(
        'SELECT xmin::text AS xmin FROM sales_orders WHERE id = $1',
        [orderId],
      );
      const [event] = await cancellationAudit(TENANT_A, COMPANY_A1);

      expect(event?.xmin).toBe(order.rows[0]?.xmin);
    });

it('records the roles the actor held at the time', async () => {
      // Section 7.3: the roles as they were, not looked up later. These are the same grants the
      // authorization step read in this transaction, so the record says what was true at the
      // moment the decision was made.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, orderId);

      await ownerContext(TENANT_A, COMPANY_A1);
      const rows = await owner.query<{ actor_roles: string[] }>(
        `SELECT actor_roles FROM audit_events WHERE action = 'sales_order_cancelled'`,
      );
      expect(rows.rows[0]?.actor_roles).toEqual(['manager']);
    });

    it('records the request the change was made by', async () => {
      // The eleventh field section 7.3 lists. Framework supplied rather than client supplied,
      // which matters because a forged correlation id in an append-only log is worth as much as
      // a forged actor.
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await uow.inActorScope(IN_A1, (repositories) =>
        cancelSalesOrder(repositories, { ...CONTEXT_A1, requestId: 'req-4242' }, {
          salesOrderId: orderId,
        }),
      );

      await ownerContext(TENANT_A, COMPANY_A1);
      const rows = await owner.query<{ request_id: string | null }>(
        `SELECT request_id FROM audit_events WHERE action = 'sales_order_cancelled'`,
      );
      expect(rows.rows[0]?.request_id).toBe('req-4242');
    });

    it('records the transaction it was written in, so it ties to the commit', async () => {
      // Section 7.3's last field, and the database supplies it. An application that could set it
      // could claim a change belonged to a transaction that never ran.
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, orderId);

      await ownerContext(TENANT_A, COMPANY_A1);
      const rows = await owner.query<{ txid: string | null }>(
        `SELECT txid::text AS txid FROM audit_events WHERE action = 'sales_order_cancelled'`,
      );
      expect(rows.rows[0]?.txid).toMatch(/^\d+$/);
    });

    it('writes no record at all when the change fails', async () => {
      // The other half of section 7.1: an audit record can never exist without its change. A
      // refusal after the reason was checked and the order was read must leave nothing.
      await stock(AS_SELLER, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await refusal(cancel(AS_SELLER, CONTEXT_SELLER, orderId, 'Not mine to cancel'));

      expect(await cancellationAudit(TENANT_A, COMPANY_A1)).toEqual([]);
    });

    it('carries the reason when one was given', async () => {
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, orderId, 'Customer changed their mind');

      const [event] = await cancellationAudit(TENANT_A, COMPANY_A1);
      expect(event?.changes).toMatchObject({ reason: 'Customer changed their mind' });
    });

    it('omits the reason when none was given, rather than recording an empty one', async () => {
      // A reader can then tell "no reason offered" from "a reason that happened to be blank".
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, orderId);

      const [event] = await cancellationAudit(TENANT_A, COMPANY_A1);
      expect(event?.changes).not.toHaveProperty('reason');
    });

    it('treats whitespace as no reason at all', async () => {
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, orderId, '   ');

      const [event] = await cancellationAudit(TENANT_A, COMPANY_A1);
      expect(event?.changes).not.toHaveProperty('reason');
    });

    it('trims a reason rather than storing the spaces around it', async () => {
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, orderId, '  Duplicate order  ');

      const [event] = await cancellationAudit(TENANT_A, COMPANY_A1);
      expect(event?.changes).toMatchObject({ reason: 'Duplicate order' });
    });

    it('writes no reason column on the order, because there is none', async () => {
      // Section 12.3 puts the reason in the payload alone. A column would make it a
      // property of the order that a later edit could rewrite.
      await ownerContext(TENANT_A, COMPANY_A1);
      const columns = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'sales_orders'`,
      );

      expect(columns.rows.map((row) => row.column_name)).not.toContain('cancellation_reason');
    });
  });

  // -------------------------------------------------------------------------------------
  // 4. Refusals.
  // -------------------------------------------------------------------------------------

  describe('what it refuses', () => {
    it('refuses a reason longer than the limit, before touching anything', async () => {
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      const error = await refusal(
        cancel(IN_A1, CONTEXT_A1, orderId, 'x'.repeat(MAX_REASON_LENGTH + 1)),
      );

      expect(error).toBeInstanceOf(SalesOrderCancellationError);
      expect((error as SalesOrderCancellationError).reason).toBe('invalid_reason');
      expect((await orderRow(TENANT_A, COMPANY_A1, orderId))?.status).toBe('draft');
    });

    it('accepts a reason exactly at the limit', async () => {
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await expect(
        cancel(IN_A1, CONTEXT_A1, orderId, 'x'.repeat(MAX_REASON_LENGTH)),
      ).resolves.toBeDefined();
    });

    it('answers not found for an order that does not exist', async () => {
      const error = await refusal(cancel(IN_A1, CONTEXT_A1, nextId('e9')));

      expect((error as SalesOrderCancellationError).reason).toBe('not_found');
    });

    it('answers not found for a sibling company’s order', async () => {
      // Section 6.1: the tenant and company dimensions answer the same as the record not
      // existing, so an identifier cannot be probed to learn what another company holds.
      const theirs = await draft(TENANT_A, COMPANY_A2, [
        { productId: WIDGET[COMPANY_A2]!, quantity: '10' },
      ]);

      const error = await refusal(cancel(IN_A1, CONTEXT_A1, theirs));

      expect((error as SalesOrderCancellationError).reason).toBe('not_found');
      expect((await orderRow(TENANT_A, COMPANY_A2, theirs))?.status).toBe('draft');
    });

    it('answers not found for another tenant’s order', async () => {
      const theirs = await draft(TENANT_B, COMPANY_B1, [
        { productId: WIDGET[COMPANY_B1]!, quantity: '10' },
      ]);

      const error = await refusal(cancel(IN_A1, CONTEXT_A1, theirs));

      expect((error as SalesOrderCancellationError).reason).toBe('not_found');
      expect((await orderRow(TENANT_B, COMPANY_B1, theirs))?.status).toBe('draft');
    });

    it('refuses a member of this company who lacks sales:cancel', async () => {
      // The capability, not the session. This user may raise and confirm orders in this very
      // company, which is the separation the permission catalogue draws.
      await stock(AS_SELLER, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      const error = await refusal(cancel(AS_SELLER, CONTEXT_SELLER, orderId));

      expect((error as SalesOrderCancellationError).reason).toBe('forbidden');
      expect((await orderRow(TENANT_A, COMPANY_A1, orderId))?.status).toBe('confirmed');
      // And the stock stays held, because the refusal rolled the whole transaction back.
      expect((await availability(IN_A1, WIDGET[COMPANY_A1]!)).reserved).toBe('10.000000');
    });

    it('refuses to cancel an order that is already cancelled', async () => {
      // The state guard section 11 requires independently of any idempotency record.
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);
      await cancel(IN_A1, CONTEXT_A1, orderId);

      const error = await refusal(cancel(IN_A1, CONTEXT_A1, orderId));

      expect(error).toBeInstanceOf(IllegalSalesOrderTransitionError);
      expect((error as IllegalSalesOrderTransitionError).from).toBe('cancelled');
      expect((error as IllegalSalesOrderTransitionError).to).toBe('cancelled');
    });

    it('writes one audit record for one cancellation, not two', async () => {
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);
      await cancel(IN_A1, CONTEXT_A1, orderId);
      await refusal(cancel(IN_A1, CONTEXT_A1, orderId));

      expect(await cancellationAudit(TENANT_A, COMPANY_A1)).toHaveLength(1);
    });

    it('refuses to cancel an order in a state the table does not permit', async () => {
      // `partially_delivered` is refused for a stated reason: goods are with a customer and
      // undoing that is a return. Written directly, because no operation can reach that state.
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);
      await ownerContext(TENANT_A, COMPANY_A1);
      await owner.query(
        `UPDATE sales_orders SET status = 'partially_delivered', doc_number = 'SO-9001' WHERE id = $1`,
        [orderId],
      );

      const error = await refusal(cancel(IN_A1, CONTEXT_A1, orderId));

      expect(error).toBeInstanceOf(IllegalSalesOrderTransitionError);
      expect((error as IllegalSalesOrderTransitionError).from).toBe('partially_delivered');
    });
  });

  // -------------------------------------------------------------------------------------
  // 5. All of it or none of it.
  // -------------------------------------------------------------------------------------

  describe('a cancellation that fails part way', () => {
    it('leaves the order confirmed and its stock still held', async () => {
      // The audit write is the last thing that happens, so failing it is the hardest case: the
      // release and the status write have both already run. Section 12.2 permits no partial
      // post, and the same reasoning governs this transition.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '30' },
      ]);

      await owner.query(`
        CREATE FUNCTION erp_test_block_cancel_audit() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.action = 'sales_order_cancelled' THEN
            RAISE EXCEPTION 'blocked by the test';
          END IF;
          RETURN NEW;
        END
        $fn$;
        CREATE TRIGGER erp_test_block_cancel_audit_trigger
          BEFORE INSERT ON audit_events
          FOR EACH ROW EXECUTE FUNCTION erp_test_block_cancel_audit();
      `);

      try {
        await refusal(cancel(IN_A1, CONTEXT_A1, orderId));

        expect((await orderRow(TENANT_A, COMPANY_A1, orderId))?.status).toBe('confirmed');
        const rows = await reservationsIn(TENANT_A, COMPANY_A1);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.released_at).toBeNull();
        // And the stock is still held, which is the figure a salesperson would have been shown.
        expect((await availability(IN_A1, WIDGET[COMPANY_A1]!)).available).toBe('70.000000');
      } finally {
        await owner.query('DROP TRIGGER erp_test_block_cancel_audit_trigger ON audit_events');
        await owner.query('DROP FUNCTION erp_test_block_cancel_audit()');
      }
    });
  });

  // -------------------------------------------------------------------------------------
  // 6. Concurrency.
  // -------------------------------------------------------------------------------------

  describe('two cancellations of the same order at once', () => {
    it('lets exactly one of them through', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '30' },
      ]);

      const held = gate();
      let secondSettled = false;

      const first = uow.inActorScope(IN_A1, async (repositories) => {
        await cancelSalesOrder(repositories, CONTEXT_A1, { salesOrderId: orderId });
        await held.promise;
      });

      await settle(150);

      const second = uow
        .inActorScope(IN_A1, (repositories) =>
          cancelSalesOrder(repositories, CONTEXT_A1, { salesOrderId: orderId }),
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
      // Blocked on the balance row the first transaction locked before releasing. Both read the
      // order as confirmed, so the transition check alone cannot separate them.
      expect(secondSettled).toBe(false);

      held.open();
      await first;

      expect(await second).not.toBe('succeeded');

      expect((await orderRow(TENANT_A, COMPANY_A1, orderId))?.status).toBe('cancelled');
      expect(await cancellationAudit(TENANT_A, COMPANY_A1)).toHaveLength(1);
      // Released once. A second stamp would have moved the moment the stock came back.
      const rows = await reservationsIn(TENANT_A, COMPANY_A1);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.version).toBe(2);
    });

it('lets exactly one of them through for a draft, which holds nothing to serialise on', async () => {
      // The case with no balance row lock in it at all. A draft has no reservations, so nothing
      // in the stock layer separates two cancellations arriving together, and the guard on the
      // transition write is the only thing standing between them and two cancellations of one
      // document. Section 10.1 is why it carries the version the caller read, and section 12.1's
      // table is why it carries the status too.
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () =>
          uow
            .inActorScope(IN_A1, (repositories) =>
              cancelSalesOrder(repositories, CONTEXT_A1, { salesOrderId: orderId }),
            )
            .then(
              () => 'ok' as const,
              () => 'refused' as const,
            ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(1);
      expect(await cancellationAudit(TENANT_A, COMPANY_A1)).toHaveLength(1);
      // One move, so one version bump. Two would mean the document was cancelled twice.
      expect((await orderRow(TENANT_A, COMPANY_A1, orderId))?.version).toBe(2);
    });

    it('releases the stock exactly once when many try at once', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '30' },
      ]);

      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () =>
          uow
            .inActorScope(IN_A1, (repositories) =>
              cancelSalesOrder(repositories, CONTEXT_A1, { salesOrderId: orderId }),
            )
            .then(
              () => 'ok' as const,
              () => 'refused' as const,
            ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(1);
      expect((await availability(IN_A1, WIDGET[COMPANY_A1]!)).available).toBe('100.000000');
      expect(await cancellationAudit(TENANT_A, COMPANY_A1)).toHaveLength(1);
    });
  });

  describe('a cancellation racing a confirmation', () => {
    it('cannot both succeed for the same order', async () => {
      // The two operations that move a draft, arriving together. Whichever wins, the other must
      // find the order somewhere its own transition cannot start from.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '30' },
      ]);

      const outcomes = await Promise.all([
        uow
          .inActorScope(IN_A1, (repositories) =>
            confirmSalesOrder(repositories, CONTEXT_A1, { salesOrderId: orderId }),
          )
          .then(
            () => 'confirmed' as const,
            () => 'refused' as const,
          ),
        uow
          .inActorScope(IN_A1, (repositories) =>
            cancelSalesOrder(repositories, CONTEXT_A1, { salesOrderId: orderId }),
          )
          .then(
            () => 'cancelled' as const,
            () => 'refused' as const,
          ),
      ]);

      const succeeded = outcomes.filter((outcome) => outcome !== 'refused');
      expect(succeeded).toHaveLength(1);

      // And whichever won, availability agrees with the order's state rather than with neither.
      const row = await orderRow(TENANT_A, COMPANY_A1, orderId);
      const position = await availability(IN_A1, WIDGET[COMPANY_A1]!);
      if (row?.status === 'confirmed') {
        expect(position.available).toBe('70.000000');
      } else {
        expect(row?.status).toBe('cancelled');
        expect(position.available).toBe('100.000000');
      }
    });

    it('leaves availability consistent when a confirmation lands first', async () => {
      // Ordered rather than raced, so the assertion is about the outcome rather than about who
      // got there first: cancelling after a confirmation releases exactly what it reserved.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '30' },
      ]);

      await uow.inActorScope(IN_A1, (repositories) =>
        confirmSalesOrder(repositories, CONTEXT_A1, { salesOrderId: orderId }),
      );
      const { releasedQuantity } = await cancel(IN_A1, CONTEXT_A1, orderId);

      expect(releasedQuantity).toBe('30.000000');
      expect((await availability(IN_A1, WIDGET[COMPANY_A1]!)).available).toBe('100.000000');
    });

it('makes a confirmation for the same key wait for it, rather than reading around it', async () => {
      // THE TEST THAT JUSTIFIES THE LOCK, and it is here because removing the lock left every
      // other test in this file still passing. Two cancellations serialise on the reservation
      // row itself, so they prove nothing about the balance row.
      //
      // What the balance lock is actually for is a reader of a different order deciding, on the
      // strength of section 8.5's availability, whether there is enough stock. All the shelf's
      // stock is held by the first order. The second cannot be confirmed while that is true.
      //
      // The cancellation releases and then holds its transaction open. Under the lock, the
      // confirmation blocks at `availabilityForUpdate` until the release commits, and then reads
      // a shelf with the stock back on it. Without the lock it would not block: at READ
      // COMMITTED it would read the uncommitted release as though it had not happened, and
      // refuse an order that in fact had stock. Worse, if that cancellation later rolled back, a
      // confirmation that had read around it would have reserved stock that was still promised.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const first = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '100' },
      ]);
      const second = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '100' },
      ]);

      const held = gate();
      let confirmationSettled = false;

      const cancelling = uow.inActorScope(IN_A1, async (repositories) => {
        await cancelSalesOrder(repositories, CONTEXT_A1, { salesOrderId: first });
        await held.promise;
      });

      await settle(150);

      const confirming = uow
        .inActorScope(IN_A1, (repositories) =>
          confirmSalesOrder(repositories, CONTEXT_A1, { salesOrderId: second }),
        )
        .then(
          () => 'confirmed' as const,
          (error: unknown) => error,
        )
        .then((outcome) => {
          confirmationSettled = true;
          return outcome;
        });

      await settle();
      expect(confirmationSettled).toBe(false);

      held.open();
      await cancelling;

      expect(await confirming).toBe('confirmed');
      expect((await availability(IN_A1, WIDGET[COMPANY_A1]!)).available).toBe('0.000000');
    });

    it('lets another order take the stock a cancellation just released', async () => {
      // What the release is for. The second order could not be confirmed while the first held
      // the stock, and can be once it does not.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const first = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '100' },
      ]);
      const second = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '100' },
      ]);

      await refusal(
        uow.inActorScope(IN_A1, (repositories) =>
          confirmSalesOrder(repositories, CONTEXT_A1, { salesOrderId: second }),
        ),
      );

      await cancel(IN_A1, CONTEXT_A1, first);

      await expect(
        uow.inActorScope(IN_A1, (repositories) =>
          confirmSalesOrder(repositories, CONTEXT_A1, { salesOrderId: second }),
        ),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------------------
  // 7. Isolation, from the other side.
  // -------------------------------------------------------------------------------------

  describe('across companies', () => {
    it('does not release a sibling company’s stock', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      await stock(IN_A2, WIDGET[COMPANY_A2]!, '100');
      const mine = await confirmed(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);
      await confirmed(TENANT_A, COMPANY_A2, [{ productId: WIDGET[COMPANY_A2]!, quantity: '40' }]);

      await cancel(IN_A1, CONTEXT_A1, mine);

      expect((await availability(IN_A2, WIDGET[COMPANY_A2]!)).reserved).toBe('40.000000');
    });

    it('records the cancellation in the acting company only', async () => {
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, orderId);

      expect(await cancellationAudit(TENANT_A, COMPANY_A1)).toHaveLength(1);
      expect(await cancellationAudit(TENANT_A, COMPANY_A2)).toHaveLength(0);
    });

    it('cancels each company’s own order without touching the other', async () => {
      const mine = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);
      const theirs = await draft(TENANT_A, COMPANY_A2, [
        { productId: WIDGET[COMPANY_A2]!, quantity: '10' },
      ]);

      await cancel(IN_A1, CONTEXT_A1, mine);
      await cancel(IN_A2, CONTEXT_A2, theirs);

      expect((await orderRow(TENANT_A, COMPANY_A1, mine))?.status).toBe('cancelled');
      expect((await orderRow(TENANT_A, COMPANY_A2, theirs))?.status).toBe('cancelled');
    });
  });
});
