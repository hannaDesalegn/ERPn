/**
 * Confirming a sales order, against a real PostgreSQL.
 *
 * Section 12.2 says the confirming transaction does six things in one transaction or none of
 * them, and that there is no partial post. Almost every test here is one way of trying to get a
 * partial post out of it: fail a later line after earlier ones reserved, fail the audit after the
 * number was allocated, confirm the same order twice at once. What must be true afterwards is
 * always the same, that nothing survives.
 *
 * WHY THE FAILURES ARE REAL ONES. The rollback tests use a trigger the owning role installs and
 * drops, rather than a hook in the production code. A test seam that only exists to be failed
 * proves the seam works, not the transaction.
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
import { confirmSalesOrder, SalesOrderConfirmationError } from './confirm-sales-order.js';
import { IllegalSalesOrderTransitionError } from './sales-order-status.js';
import { SALES_ORDER_DOC_TYPE } from './document-numbers.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'b1100000-0000-4000-8000-00000000000a';
const TENANT_B = 'b1200000-0000-4000-8000-00000000000b';

const COMPANY_A1 = 'b1300000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "same tenant, different company" is representable. */
const COMPANY_A2 = 'b1400000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'b1500000-0000-4000-8000-00000000000c';

const CONFIRMER = 'b1600000-0000-4000-8000-00000000000a';
/** Holds a role with no sales:confirm, so refusal is about the capability and not the session. */
const ONLOOKER = 'b1700000-0000-4000-8000-00000000000b';

/**
 * One membership per user per company, because that is what a membership is.
 *
 * Section 2.6 gives a person one account and a membership per company they belong to, so the
 * confirmer holds three separate rows rather than one that travels.
 */
const CONFIRMER_MEMBERSHIP: Record<string, string> = {
  [COMPANY_A1]: 'b1810000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b1820000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b1830000-0000-4000-8000-00000000000c',
};
/** The onlooker belongs to the acting company only. */
const ONLOOKER_MEMBERSHIP = 'b1900000-0000-4000-8000-00000000000b';

const membershipFor = (companyId: string, userId: string) =>
  userId === ONLOOKER ? ONLOOKER_MEMBERSHIP : CONFIRMER_MEMBERSHIP[companyId]!;

const CUSTOMER: Record<string, string> = {
  [COMPANY_A1]: 'b2110000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b2120000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b2130000-0000-4000-8000-00000000000c',
};
const WAREHOUSE: Record<string, string> = {
  [COMPANY_A1]: 'b2210000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b2220000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b2230000-0000-4000-8000-00000000000c',
};
const WIDGET: Record<string, string> = {
  [COMPANY_A1]: 'b2310000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b2320000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b2330000-0000-4000-8000-00000000000c',
};
/** A second product in the acting company, so a later line can be the one that fails. */
const GADGET = 'b2410000-0000-4000-8000-00000000000a';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const ROLE: Record<string, string> = {
  [COMPANY_A1]: 'b2510000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'b2520000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'b2530000-0000-4000-8000-00000000000c',
};
const ONLOOKER_ROLE = 'b2610000-0000-4000-8000-00000000000a';

let sequence = 0;
const nextId = (prefix: string) =>
  `${prefix}${(sequence += 1).toString().padStart(6, '0')}-0000-4000-8000-00000000000a`;

const scopeFor = (tenantId: string, companyId: string, userId = CONFIRMER): ActorScope =>
  actorScope({ tenantId, companyId, userId });

const contextFor = (tenantId: string, companyId: string, userId = CONFIRMER): CompanyContext => ({
  tenantId,
  companyId,
  membershipId: membershipFor(companyId, userId),
});

const IN_A1 = scopeFor(TENANT_A, COMPANY_A1);
const IN_A2 = scopeFor(TENANT_A, COMPANY_A2);
const CONTEXT_A1 = contextFor(TENANT_A, COMPANY_A1);
const CONTEXT_A2 = contextFor(TENANT_A, COMPANY_A2);

/** A promise with its resolver, for holding a transaction open from outside it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

const settle = (ms = 300) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Confirming a sales order', () => {
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
      await owner.query('UPDATE document_number_sequences SET next_value = 1 WHERE company_id = $1', [
        companyId,
      ]);
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
      'confirm-a',
      'Confirm A',
      TENANT_B,
      'confirm-b',
      'Confirm B',
    ]);
    await owner.query(
      'INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4), ($5,$6,$7,$4)',
      [
        CONFIRMER,
        'confirmer@confirm.test',
        'Confirmer',
        'not-a-real-hash',
        ONLOOKER,
        'onlooker@confirm.test',
        'Onlooker',
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
        [nextId('b3'), tenantId, companyId, SALES_ORDER_DOC_TYPE],
      );
      // A role carrying the capability, and the membership that holds it.
      await owner.query(
        'INSERT INTO roles (id, tenant_id, company_id, key, name) VALUES ($1,$2,$3,$4,$5)',
        [ROLE[companyId], tenantId, companyId, 'sales', 'Sales'],
      );
      await owner.query(
        `INSERT INTO role_permissions (tenant_id, company_id, role_id, permission)
         VALUES ($1,$2,$3,$4), ($1,$2,$3,$5)`,
        [tenantId, companyId, ROLE[companyId], 'sales:confirm', 'sales:view'],
      );
      await owner.query(
        'INSERT INTO memberships (id, tenant_id, company_id, user_id) VALUES ($1,$2,$3,$4)',
        [CONFIRMER_MEMBERSHIP[companyId], tenantId, companyId, CONFIRMER],
      );
      await owner.query(
        'INSERT INTO membership_roles (tenant_id, company_id, membership_id, role_id) VALUES ($1,$2,$3,$4)',
        [tenantId, companyId, CONFIRMER_MEMBERSHIP[companyId], ROLE[companyId]],
      );
    }

    await ownerContext(TENANT_A, COMPANY_A1);
    await owner.query(
      `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
       VALUES ($1,$2,$3,'SKU-G','Gadget','unit','5.000000','USD')`,
      [GADGET, TENANT_A, COMPANY_A1],
    );
    // A membership that can see sales but not confirm them.
    await owner.query(
      'INSERT INTO roles (id, tenant_id, company_id, key, name) VALUES ($1,$2,$3,$4,$5)',
      [ONLOOKER_ROLE, TENANT_A, COMPANY_A1, 'warehouse', 'Warehouse'],
    );
    await owner.query(
      'INSERT INTO role_permissions (tenant_id, company_id, role_id, permission) VALUES ($1,$2,$3,$4)',
      [TENANT_A, COMPANY_A1, ONLOOKER_ROLE, 'sales:view'],
    );
    await owner.query(
      'INSERT INTO memberships (id, tenant_id, company_id, user_id) VALUES ($1,$2,$3,$4)',
      [ONLOOKER_MEMBERSHIP, TENANT_A, COMPANY_A1, ONLOOKER],
    );
    await owner.query(
      'INSERT INTO membership_roles (tenant_id, company_id, membership_id, role_id) VALUES ($1,$2,$3,$4)',
      [TENANT_A, COMPANY_A1, ONLOOKER_MEMBERSHIP, ONLOOKER_ROLE],
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
    await owner.query('DELETE FROM users WHERE id = ANY($1)', [[CONFIRMER, ONLOOKER]]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  /** Puts stock on a shelf through the ledger, the way the system does. */
  const stock = (scope: ActorScope, productId: string, quantity: string) =>
    uow.inActorScope(scope, (repositories) =>
      repositories.stockLedger.record({
        id: nextId('b4'),
        productId,
        warehouseId: WAREHOUSE[scope.companyId]!,
        quantity,
        reason: 'purchase_receipt',
        sourceDocType: 'purchase_order',
        sourceDocId: nextId('b5'),
      }),
    );

  /** A draft with the lines given, written directly so its figures are the test's to choose. */
  async function draft(
    tenantId: string,
    companyId: string,
    lines: { productId: string; quantity: string }[],
  ): Promise<string> {
    const orderId = nextId('b6');
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
        [nextId('b7'), tenantId, companyId, orderId, lineNumber, line.productId, line.quantity],
      );
    }

    return orderId;
  }

  const confirm = (scope: ActorScope, context: CompanyContext, salesOrderId: string) =>
    uow.inActorScope(scope, (repositories) =>
      confirmSalesOrder(repositories, context, { salesOrderId }),
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
    const rows = await owner.query<{ id: string; quantity: string }>(
      'SELECT id, quantity FROM stock_reservations',
    );
    return rows.rows;
  };

  const auditIn = async (tenantId: string, companyId: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{ action: string; entity_id: string; xmin: string }>(
      `SELECT action, entity_id, xmin::text AS xmin FROM audit_events WHERE action = 'sales_order_confirmed'`,
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
  // 1, 5, 8, 10 and 12. A confirmation that works.
  // -------------------------------------------------------------------------------------

  describe('a valid draft', () => {
    it('becomes confirmed with a document number', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      const { order } = await confirm(IN_A1, CONTEXT_A1, orderId);

      expect(order.status).toBe('confirmed');
      expect(order.docNumber).toBe('SO-0001');
      expect(await orderRow(TENANT_A, COMPANY_A1, orderId)).toMatchObject({
        status: 'confirmed',
        doc_number: 'SO-0001',
      });
    });

    it('reserves every line', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      await stock(IN_A1, GADGET, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
        { productId: GADGET, quantity: '4' },
        { productId: WIDGET[COMPANY_A1]!, quantity: '6' },
      ]);

      const { reservationIds } = await confirm(IN_A1, CONTEXT_A1, orderId);

      expect(reservationIds).toHaveLength(3);
      const reservations = await reservationsIn(TENANT_A, COMPANY_A1);
      expect(reservations.map((row) => row.quantity).sort()).toEqual([
        '10.000000',
        '4.000000',
        '6.000000',
      ]);
    });

    it('reserves the quantity on the line rather than anything the caller said', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '7.500000' },
      ]);

      // The request carries an identifier and nothing else. A quantity sent anyway is a field
      // the operation does not read.
      await uow.inActorScope(IN_A1, (repositories) =>
        confirmSalesOrder(repositories, CONTEXT_A1, {
          salesOrderId: orderId,
          quantity: '1',
        } as unknown as Parameters<typeof confirmSalesOrder>[2]),
      );

      expect((await reservationsIn(TENANT_A, COMPANY_A1))[0]?.quantity).toBe('7.500000');
    });

    it('advances the counter, so the next order gets the next number', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const first = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '1' },
      ]);
      const second = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '1' },
      ]);

      expect((await confirm(IN_A1, CONTEXT_A1, first)).order.docNumber).toBe('SO-0001');
      expect((await confirm(IN_A1, CONTEXT_A1, second)).order.docNumber).toBe('SO-0002');
      expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('3');
    });

    it('writes the audit record in the same transaction as the status change', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await confirm(IN_A1, CONTEXT_A1, orderId);

      const events = await auditIn(TENANT_A, COMPANY_A1);
      expect(events).toHaveLength(1);
      expect(events[0]?.entity_id).toBe(orderId);

      // Section 7.1's proof: the record and the change it describes share a transaction.
      await ownerContext(TENANT_A, COMPANY_A1);
      const order = await owner.query<{ xmin: string }>(
        'SELECT xmin::text AS xmin FROM sales_orders WHERE id = $1',
        [orderId],
      );
      expect(events[0]?.xmin).toBe(order.rows[0]?.xmin);
    });

    it('writes the reservations in that same transaction too', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await confirm(IN_A1, CONTEXT_A1, orderId);

      await ownerContext(TENANT_A, COMPANY_A1);
      const written = await owner.query<{ xmin: string }>(
        `SELECT xmin::text AS xmin FROM sales_orders WHERE id = $1
         UNION
         SELECT xmin::text FROM stock_reservations
         UNION
         SELECT xmin::text FROM audit_events WHERE entity_id = $1`,
        [orderId],
      );

      // One transaction wrote all three. Three values would mean three windows in which the
      // order was confirmed but not yet reserved, or reserved but not yet recorded.
      expect(written.rows).toHaveLength(1);
    });

    it('bumps the version, so a stale editor is refused afterwards', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '1' },
      ]);
      const before = await orderRow(TENANT_A, COMPANY_A1, orderId);

      await confirm(IN_A1, CONTEXT_A1, orderId);

      expect((await orderRow(TENANT_A, COMPANY_A1, orderId))?.version).toBe(
        (before?.version ?? 0) + 1,
      );
    });
  });

  // -------------------------------------------------------------------------------------
  // 2 and 13. The transition table decides.
  // -------------------------------------------------------------------------------------

  describe('the current state', () => {
    it('refuses a second confirmation of the same order', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);
      await confirm(IN_A1, CONTEXT_A1, orderId);

      const error = await refusal(confirm(IN_A1, CONTEXT_A1, orderId));

      // Section 12.1's table, not a status compared in place. This is also section 11's
      // requirement that the state machine guards a replay independently of any idempotency
      // record having expired.
      expect(error).toBeInstanceOf(IllegalSalesOrderTransitionError);
      expect((error as IllegalSalesOrderTransitionError).from).toBe('confirmed');
      expect((error as IllegalSalesOrderTransitionError).to).toBe('confirmed');
    });

    it('does not reserve or renumber on the refused second attempt', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);
      await confirm(IN_A1, CONTEXT_A1, orderId);

      await refusal(confirm(IN_A1, CONTEXT_A1, orderId));

      expect(await reservationsIn(TENANT_A, COMPANY_A1)).toHaveLength(1);
      expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('2');
      expect((await orderRow(TENANT_A, COMPANY_A1, orderId))?.doc_number).toBe('SO-0001');
    });

    it('refuses an order with no lines', async () => {
      const orderId = await draft(TENANT_A, COMPANY_A1, []);

      const error = await refusal(confirm(IN_A1, CONTEXT_A1, orderId));

      expect((error as SalesOrderConfirmationError).reason).toBe('no_lines');
      expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('1');
    });
  });

  // -------------------------------------------------------------------------------------
  // 3 and 4. Authorization and row scope.
  // -------------------------------------------------------------------------------------

  describe('authorization', () => {
    it('refuses an actor without sales:confirm', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      const error = await refusal(
        uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1, ONLOOKER), (repositories) =>
          confirmSalesOrder(repositories, contextFor(TENANT_A, COMPANY_A1, ONLOOKER), {
            salesOrderId: orderId,
          }),
        ),
      );

      expect((error as SalesOrderConfirmationError).reason).toBe('forbidden');
    });

    it('writes nothing at all when the actor is refused', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await refusal(
        uow.inActorScope(scopeFor(TENANT_A, COMPANY_A1, ONLOOKER), (repositories) =>
          confirmSalesOrder(repositories, contextFor(TENANT_A, COMPANY_A1, ONLOOKER), {
            salesOrderId: orderId,
          }),
        ),
      );

      expect(await reservationsIn(TENANT_A, COMPANY_A1)).toEqual([]);
      expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('1');
      expect((await orderRow(TENANT_A, COMPANY_A1, orderId))?.status).toBe('draft');
      expect(await auditIn(TENANT_A, COMPANY_A1)).toEqual([]);
    });

    it('refuses an order belonging to a sibling company', async () => {
      await stock(IN_A2, WIDGET[COMPANY_A2]!, '100');
      const theirs = await draft(TENANT_A, COMPANY_A2, [
        { productId: WIDGET[COMPANY_A2]!, quantity: '10' },
      ]);

      const error = await refusal(confirm(IN_A1, CONTEXT_A1, theirs));

      // Section 6.1: the same answer as a missing order, so identifiers cannot be probed.
      expect((error as SalesOrderConfirmationError).reason).toBe('not_found');
      expect((await orderRow(TENANT_A, COMPANY_A2, theirs))?.status).toBe('draft');
    });

    it('refuses an order belonging to another tenant', async () => {
      const theirs = await draft(TENANT_B, COMPANY_B1, [
        { productId: WIDGET[COMPANY_B1]!, quantity: '1' },
      ]);

      const error = await refusal(confirm(IN_A1, CONTEXT_A1, theirs));

      expect((error as SalesOrderConfirmationError).reason).toBe('not_found');
      expect((await orderRow(TENANT_B, COMPANY_B1, theirs))?.status).toBe('draft');
    });

    it('reads the capability in the acting company, not wherever the actor holds it', async () => {
      // The confirmer holds the sales role in every company here, so this proves the read is
      // scoped rather than proving they have no role at all: company A2's own order confirms.
      await stock(IN_A2, WIDGET[COMPANY_A2]!, '100');
      const theirs = await draft(TENANT_A, COMPANY_A2, [
        { productId: WIDGET[COMPANY_A2]!, quantity: '10' },
      ]);

      const { order } = await confirm(IN_A2, CONTEXT_A2, theirs);

      expect(order.status).toBe('confirmed');
    });
  });

  // -------------------------------------------------------------------------------------
  // 6, 7 and 9. Stock, and the rollback when there is not enough.
  // -------------------------------------------------------------------------------------

  describe('when a line cannot be reserved', () => {
    it('refuses the confirmation', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '5');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await refusal(confirm(IN_A1, CONTEXT_A1, orderId));

      expect((await orderRow(TENANT_A, COMPANY_A1, orderId))?.status).toBe('draft');
    });

    it('rolls back the lines that were already reserved', async () => {
      // The first line has stock and the third does not. Section 12.2 permits no partial post,
      // and this is the case where that is easiest to get wrong.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      await stock(IN_A1, GADGET, '2');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
        { productId: WIDGET[COMPANY_A1]!, quantity: '5' },
        { productId: GADGET, quantity: '50' },
      ]);

      await refusal(confirm(IN_A1, CONTEXT_A1, orderId));

      expect(await reservationsIn(TENANT_A, COMPANY_A1)).toEqual([]);
    });

    it('consumes no document number', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '5');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await refusal(confirm(IN_A1, CONTEXT_A1, orderId));

      // Still one. A database sequence would have left a hole here, which is why section 10.4
      // insists on a counter row locked inside the transaction.
      expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('1');
    });

    it('leaves the next order free to take the first number', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '10');
      const doomed = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '50' },
      ]);
      const fine = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await refusal(confirm(IN_A1, CONTEXT_A1, doomed));

      expect((await confirm(IN_A1, CONTEXT_A1, fine)).order.docNumber).toBe('SO-0001');
    });

    it('writes no audit record for a confirmation that did not happen', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '5');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      await refusal(confirm(IN_A1, CONTEXT_A1, orderId));

      expect(await auditIn(TENANT_A, COMPANY_A1)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 11. A failure at the last step still undoes everything before it.
  // -------------------------------------------------------------------------------------

  describe('when the audit write fails', () => {
    it('rolls back the status, the number and every reservation', async () => {
      // The audit append is the last thing the operation does, so a failure there is the latest
      // possible one. A trigger the owning role installs and drops is used rather than a hook in
      // the production code, because a test seam would prove the seam works.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
        { productId: WIDGET[COMPANY_A1]!, quantity: '5' },
      ]);

      await owner.query(`
        CREATE FUNCTION erp_test_block_confirm_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.action = 'sales_order_confirmed' THEN
            RAISE EXCEPTION 'audit write refused by test';
          END IF;
          RETURN NEW;
        END
        $fn$;
        CREATE TRIGGER erp_test_block_confirm_audit_trigger
          BEFORE INSERT ON audit_events
          FOR EACH ROW EXECUTE FUNCTION erp_test_block_confirm_audit();
      `);

      try {
        await refusal(confirm(IN_A1, CONTEXT_A1, orderId));

        expect((await orderRow(TENANT_A, COMPANY_A1, orderId))?.status).toBe('draft');
        expect((await orderRow(TENANT_A, COMPANY_A1, orderId))?.doc_number).toBeNull();
        expect(await reservationsIn(TENANT_A, COMPANY_A1)).toEqual([]);
        expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('1');
      } finally {
        await owner.query('DROP TRIGGER erp_test_block_confirm_audit_trigger ON audit_events');
        await owner.query('DROP FUNCTION erp_test_block_confirm_audit()');
      }
    });
  });

  // -------------------------------------------------------------------------------------
  // 14 and 15. Concurrency.
  // -------------------------------------------------------------------------------------

  describe('two confirmations of the same order at once', () => {
    it('lets exactly one of them through', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '100');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '10' },
      ]);

      const held = gate();
      let secondSettled = false;

      const first = uow.inActorScope(IN_A1, async (repositories) => {
        await confirmSalesOrder(repositories, CONTEXT_A1, { salesOrderId: orderId });
        await held.promise;
      });

      await settle(150);

      const second = uow
        .inActorScope(IN_A1, (repositories) =>
          confirmSalesOrder(repositories, CONTEXT_A1, { salesOrderId: orderId }),
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
      // Blocked on the balance row the first transaction locked while reserving. Both read the
      // order as a draft, so the transition check alone cannot separate them; the row lock and
      // the version guard are what do.
      expect(secondSettled).toBe(false);

      held.open();
      await first;
      const outcome = await second;

      expect(outcome).not.toBe('succeeded');

      // Exactly one confirmation happened, with one number, one reservation and one audit row.
      const row = await orderRow(TENANT_A, COMPANY_A1, orderId);
      expect(row?.status).toBe('confirmed');
      expect(row?.doc_number).toBe('SO-0001');
      expect(await reservationsIn(TENANT_A, COMPANY_A1)).toHaveLength(1);
      expect(await auditIn(TENANT_A, COMPANY_A1)).toHaveLength(1);
      expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('2');
    });

    it('issues one number even when many try at once', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '1000');
      const orderId = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '1' },
      ]);

      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () =>
          uow
            .inActorScope(IN_A1, (repositories) =>
              confirmSalesOrder(repositories, CONTEXT_A1, { salesOrderId: orderId }),
            )
            .then(
              () => 'ok' as const,
              () => 'refused' as const,
            ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(1);
      expect(await reservationsIn(TENANT_A, COMPANY_A1)).toHaveLength(1);
      expect(await auditIn(TENANT_A, COMPANY_A1)).toHaveLength(1);
      expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('2');
    });
  });

  describe('two orders racing for the last unit', () => {
    it('confirms only the one that got there first', async () => {
      // The guarantee the reservation increment proved, still intact now that reservations are
      // composed into confirmation.
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '1');
      const mine = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '1' },
      ]);
      const yours = await draft(TENANT_A, COMPANY_A1, [
        { productId: WIDGET[COMPANY_A1]!, quantity: '1' },
      ]);

      const held = gate();

      const first = uow.inActorScope(IN_A1, async (repositories) => {
        await confirmSalesOrder(repositories, CONTEXT_A1, { salesOrderId: mine });
        await held.promise;
      });

      await settle(150);

      const second = uow
        .inActorScope(IN_A1, (repositories) =>
          confirmSalesOrder(repositories, CONTEXT_A1, { salesOrderId: yours }),
        )
        .then(
          () => 'ok' as const,
          () => 'refused' as const,
        );

      await settle();
      held.open();
      await first;

      expect(await second).toBe('refused');
      expect((await orderRow(TENANT_A, COMPANY_A1, mine))?.status).toBe('confirmed');
      expect((await orderRow(TENANT_A, COMPANY_A1, yours))?.status).toBe('draft');
      expect(await reservationsIn(TENANT_A, COMPANY_A1)).toHaveLength(1);
      // The loser consumed no number, so the next order still gets SO-0002.
      expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('2');
    });

    it('never confirms more orders than the stock allows', async () => {
      await stock(IN_A1, WIDGET[COMPANY_A1]!, '3');
      // Built one at a time: these share the owning connection, and the driver deprecates
      // pipelining queries onto it. The confirmations below are the part that runs in parallel.
      const orders: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        orders.push(
          await draft(TENANT_A, COMPANY_A1, [{ productId: WIDGET[COMPANY_A1]!, quantity: '1' }]),
        );
      }

      const outcomes = await Promise.all(
        orders.map((orderId) =>
          uow
            .inActorScope(IN_A1, (repositories) =>
              confirmSalesOrder(repositories, CONTEXT_A1, { salesOrderId: orderId }),
            )
            .then(
              () => 'ok' as const,
              () => 'refused' as const,
            ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(3);
      expect(await reservationsIn(TENANT_A, COMPANY_A1)).toHaveLength(3);
      // Three numbers issued and no gaps, which is the gapless promise under real contention.
      expect(await counterFor(TENANT_A, COMPANY_A1)).toBe('4');
    });
  });
});
