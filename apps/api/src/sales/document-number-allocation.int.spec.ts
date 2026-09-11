/**
 * Gapless document number allocation, against a real PostgreSQL.
 *
 * Section 10.4 rules that a gapless sequence forces a counter row locked inside the posting
 * transaction, and accepts the serialisation cost that comes with it. Every claim in that
 * sentence is a claim about concurrency and rollback, so none of it can be tested against a
 * mock: a fake lock always holds, and a fake transaction always rolls back cleanly.
 *
 * THE TESTS THAT MATTER ARE THE TWO THAT ARE AWKWARD TO WRITE. One holds a transaction open and
 * proves a second transaction blocks on the row rather than reading past it. The other allocates
 * and then throws, and proves the counter is where it started. Everything else here is a
 * consequence of those two.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import * as fs from 'node:fs';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, DocumentNumberSequenceMissingError, UnitOfWork } from '../database/index.js';
import type { ActorScope, ScopedRepositories } from '../database/index.js';
import { allocateSalesOrderNumber, SALES_ORDER_DOC_TYPE } from './document-numbers.js';
import { SalesModule } from './sales.module.js';
import { SalesOrderService } from './sales-order.service.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'f1100000-0000-4000-8000-00000000000a';
const TENANT_B = 'f1200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'f2100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "wrong company, right tenant" is representable. */
const COMPANY_A2 = 'f2200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'f2300000-0000-4000-8000-00000000000c';

const USER = 'f3100000-0000-4000-8000-00000000000a';

const SEQUENCE: Record<string, string> = {
  [COMPANY_A1]: 'f4100000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'f4200000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'f4300000-0000-4000-8000-00000000000c',
};
/** A second sequence in the acting company, so the doc type dimension is exercised. */
const DELIVERY_SEQUENCE = 'f4400000-0000-4000-8000-00000000000d';
const DELIVERY_DOC_TYPE = 'delivery';

const CUSTOMER = 'f5100000-0000-4000-8000-00000000000a';
const WAREHOUSE = 'f5200000-0000-4000-8000-00000000000b';
const PRODUCT = 'f5300000-0000-4000-8000-00000000000c';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const scopeFor = (tenantId: string, companyId: string): ActorScope =>
  actorScope({ tenantId, companyId, userId: USER });

const IN_A1 = scopeFor(TENANT_A, COMPANY_A1);
const IN_A2 = scopeFor(TENANT_A, COMPANY_A2);
const IN_B1 = scopeFor(TENANT_B, COMPANY_B1);

/**
 * An import reaching the frontend fixture layer, which backend document creation must never do.
 *
 * Matches the module specifier rather than the word anywhere in the file, so a comment
 * explaining why the fixtures are absent does not count as using them.
 */
const FIXTURE_IMPORT = /from\s+'[^']*(?:mocks|apps\/web)/;

/** A promise with its resolver, for holding a transaction open from outside it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

/** Lets pending work run, so "did the other transaction get through" has a chance to be yes. */
const settle = (ms = 250) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Document number allocation', () => {
  let uow: UnitOfWork;
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

    uow = moduleRef.get(UnitOfWork);
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
    // Every test starts from one, so an expected number is a statement about this test rather
    // than about how many ran before it.
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM sales_order_lines WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM sales_orders WHERE tenant_id = $1', [tenantId]);
      await owner.query('UPDATE document_number_sequences SET next_value = 1 WHERE tenant_id = $1', [
        tenantId,
      ]);
    }
  });

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'numbering-a',
      'Numbering A',
      TENANT_B,
      'numbering-b',
      'Numbering B',
    ]);
    await owner.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)', [
      USER,
      'clerk@numbering.test',
      'Clerk',
      'not-a-real-hash',
    ]);

    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query(
        'INSERT INTO companies (id, tenant_id, name, base_currency) VALUES ($1,$2,$3,$4)',
        [companyId, tenantId, `Company ${companyId.slice(0, 4)}`, 'USD'],
      );
      // The same prefix in every company, deliberately. A number is unique within the company
      // that issued it, not globally, so three companies may each hold SO-0001.
      await owner.query(
        `INSERT INTO document_number_sequences (id, tenant_id, company_id, doc_type, prefix)
         VALUES ($1,$2,$3,$4,'SO-')`,
        [SEQUENCE[companyId], tenantId, companyId, SALES_ORDER_DOC_TYPE],
      );
    }

    await ownerContext(TENANT_A, COMPANY_A1);
    await owner.query(
      `INSERT INTO document_number_sequences (id, tenant_id, company_id, doc_type, prefix)
       VALUES ($1,$2,$3,$4,'DN-')`,
      [DELIVERY_SEQUENCE, TENANT_A, COMPANY_A1, DELIVERY_DOC_TYPE],
    );
    await owner.query(
      'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
      [CUSTOMER, TENANT_A, COMPANY_A1, 'CUST-1', 'A Customer'],
    );
    await owner.query(
      'INSERT INTO warehouses (id, tenant_id, company_id, code, name, is_default) VALUES ($1,$2,$3,$4,$5,true)',
      [WAREHOUSE, TENANT_A, COMPANY_A1, 'WH-1', 'Main'],
    );
    await owner.query(
      `INSERT INTO products (id, tenant_id, company_id, sku, name, stocking_uom, sales_price, sales_price_currency)
       VALUES ($1,$2,$3,'SKU-1','Widget','unit','10.000000','USD')`,
      [PRODUCT, TENANT_A, COMPANY_A1],
    );
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
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
    await ownerContext();
    await owner.query('DELETE FROM users WHERE id = $1', [USER]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  /** One allocation in its own transaction, which is how confirmation will reach it. */
  const allocate = (scope: ActorScope) =>
    uow.inActorScope(scope, (repositories) => allocateSalesOrderNumber(repositories));

  const counterFor = async (tenantId: string, companyId: string, docType: string) => {
    await ownerContext(tenantId, companyId);
    const rows = await owner.query<{ next_value: string }>(
      'SELECT next_value FROM document_number_sequences WHERE company_id = $1 AND doc_type = $2',
      [companyId, docType],
    );
    return rows.rows[0]?.next_value;
  };

  // -------------------------------------------------------------------------------------
  // 1. A draft has no number.
  // -------------------------------------------------------------------------------------

  describe('a draft', () => {
    it('is created without a document number', async () => {
      const { order } = await sales.createDraft(
        { tenantId: TENANT_A, companyId: COMPANY_A1, membershipId: USER },
        USER,
        {
          customerId: CUSTOMER,
          warehouseId: WAREHOUSE,
          orderDate: '2026-09-11',
          lines: [{ productId: PRODUCT, quantity: '1' }],
        },
      );

      expect(order.docNumber).toBeNull();
      expect(order.status).toBe('draft');
    });

    it('does not advance the counter', async () => {
      // Section 12.2 allocates at confirmation, step four. A draft that consumed a number would
      // leave a hole for every draft that is edited away or abandoned.
      await sales.createDraft(
        { tenantId: TENANT_A, companyId: COMPANY_A1, membershipId: USER },
        USER,
        {
          customerId: CUSTOMER,
          warehouseId: WAREHOUSE,
          orderDate: '2026-09-11',
          lines: [{ productId: PRODUCT, quantity: '1' }],
        },
      );

      expect(await counterFor(TENANT_A, COMPANY_A1, SALES_ORDER_DOC_TYPE)).toBe('1');
    });
  });

  // -------------------------------------------------------------------------------------
  // 2 and 4. A successful allocation advances the right counter, and numbers are consecutive.
  // -------------------------------------------------------------------------------------

  describe('allocating', () => {
    it('returns the first number and advances the counter', async () => {
      const allocated = await allocate(IN_A1);

      expect(allocated.docType).toBe(SALES_ORDER_DOC_TYPE);
      expect(allocated.value).toBe(1n);
      expect(allocated.formatted).toBe('SO-0001');
      expect(await counterFor(TENANT_A, COMPANY_A1, SALES_ORDER_DOC_TYPE)).toBe('2');
    });

    it('produces consecutive numbers, with no gaps', async () => {
      const first = await allocate(IN_A1);
      const second = await allocate(IN_A1);
      const third = await allocate(IN_A1);

      expect([first.value, second.value, third.value]).toEqual([1n, 2n, 3n]);
      expect([first.formatted, second.formatted, third.formatted]).toEqual([
        'SO-0001',
        'SO-0002',
        'SO-0003',
      ]);
    });

    it('advances only the document type asked for', async () => {
      await allocate(IN_A1);
      await allocate(IN_A1);

      // The deliveries counter shares the company and is untouched. Section 10.4 makes a
      // sequence per company and per document type, not per company.
      expect(await counterFor(TENANT_A, COMPANY_A1, DELIVERY_DOC_TYPE)).toBe('1');
    });

    it('refuses when the company has no sequence for the type', async () => {
      // Loud rather than creating one. A company with no configured sequence has a provisioning
      // gap, and a counter invented here would issue number one to a company mid-trading.
      await expect(
        uow.inActorScope(IN_A1, (repositories) =>
          repositories.documentNumberSequences.allocate('purchase_order'),
        ),
      ).rejects.toBeInstanceOf(DocumentNumberSequenceMissingError);
    });
  });

  // -------------------------------------------------------------------------------------
  // 5 and 6. Companies and tenants do not interfere.
  // -------------------------------------------------------------------------------------

  describe('scope', () => {
    it('gives each company its own counter within a tenant', async () => {
      const a1 = await allocate(IN_A1);
      const a2 = await allocate(IN_A2);

      // Both are SO-0001. A number is unique within the company that issued it, per the unique
      // index, and two companies each having one is correct rather than a collision.
      expect(a1.formatted).toBe('SO-0001');
      expect(a2.formatted).toBe('SO-0001');
      expect(await counterFor(TENANT_A, COMPANY_A1, SALES_ORDER_DOC_TYPE)).toBe('2');
      expect(await counterFor(TENANT_A, COMPANY_A2, SALES_ORDER_DOC_TYPE)).toBe('2');
    });

    it('does not let one company advance another, even in the same tenant', async () => {
      await allocate(IN_A1);
      await allocate(IN_A1);
      await allocate(IN_A1);

      expect(await counterFor(TENANT_A, COMPANY_A1, SALES_ORDER_DOC_TYPE)).toBe('4');
      expect(await counterFor(TENANT_A, COMPANY_A2, SALES_ORDER_DOC_TYPE)).toBe('1');
    });

    it('does not let one tenant advance another', async () => {
      await allocate(IN_A1);
      const b = await allocate(IN_B1);

      expect(b.value).toBe(1n);
      expect(await counterFor(TENANT_B, COMPANY_B1, SALES_ORDER_DOC_TYPE)).toBe('2');
      expect(await counterFor(TENANT_A, COMPANY_A1, SALES_ORDER_DOC_TYPE)).toBe('2');
    });

    it('interleaves companies without either seeing the other', async () => {
      const [a, b, a2, b2] = await Promise.all([
        allocate(IN_A1),
        allocate(IN_B1),
        allocate(IN_A1),
        allocate(IN_B1),
      ]);

      // Each company saw exactly two allocations, whatever order they ran in.
      expect([a.value, a2.value].sort()).toEqual([1n, 2n]);
      expect([b.value, b2.value].sort()).toEqual([1n, 2n]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 3. Concurrency. The reason the row is locked.
  // -------------------------------------------------------------------------------------

  describe('two transactions at once', () => {
    it('makes the second wait for the first to finish', async () => {
      // The strongest form available: two real transactions on two real connections, the first
      // held open deliberately. If the lock were not taken, the second would read the same
      // counter value and both would return SO-0001.
      const allocated = gate();
      const hold = gate();
      let secondFinished = false;

      const first = uow.inActorScope(IN_A1, async (repositories) => {
        const number = await allocateSalesOrderNumber(repositories);
        allocated.open();
        await hold.promise;
        return number;
      });

      await allocated.promise;

      const second = uow.inActorScope(IN_A1, async (repositories) => {
        const number = await allocateSalesOrderNumber(repositories);
        secondFinished = true;
        return number;
      });

      await settle();

      // Blocked on the row lock, not merely slow: the first transaction has not committed.
      expect(secondFinished).toBe(false);

      hold.open();
      const [one, two] = await Promise.all([first, second]);

      expect(one.value).toBe(1n);
      expect(two.value).toBe(2n);
    });

    it('gives ten concurrent transactions ten distinct consecutive numbers', async () => {
      const allocations = await Promise.all(
        Array.from({ length: 10 }, () => allocate(IN_A1)),
      );

      const values = allocations.map((a) => a.value).sort((a, b) => Number(a - b));

      expect(values).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]);
      expect(new Set(allocations.map((a) => a.formatted)).size).toBe(10);
      expect(await counterFor(TENANT_A, COMPANY_A1, SALES_ORDER_DOC_TYPE)).toBe('11');
    });

    it('lets a second company allocate while the first is held', async () => {
      // The serialisation cost section 10.4 accepts is per sequence, not global. A company
      // holding its own counter must not stall everyone else's documents.
      const allocated = gate();
      const hold = gate();

      const held = uow.inActorScope(IN_A1, async (repositories) => {
        const number = await allocateSalesOrderNumber(repositories);
        allocated.open();
        await hold.promise;
        return number;
      });

      await allocated.promise;
      const elsewhere = await allocate(IN_B1);

      expect(elsewhere.value).toBe(1n);

      hold.open();
      await held;
    });
  });

  // -------------------------------------------------------------------------------------
  // 7 and 8. Rollback, which is what gapless means.
  // -------------------------------------------------------------------------------------

  describe('a transaction that fails', () => {
    class Abandoned extends Error {}

    const abandon = (scope: ActorScope, after?: (r: ScopedRepositories) => Promise<unknown>) =>
      uow
        .inActorScope(scope, async (repositories) => {
          await allocateSalesOrderNumber(repositories);
          if (after) await after(repositories);
          throw new Abandoned('abandoned on purpose');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Abandoned)) throw error;
        });

    it('consumes no number', async () => {
      await abandon(IN_A1);

      expect(await counterFor(TENANT_A, COMPANY_A1, SALES_ORDER_DOC_TYPE)).toBe('1');
    });

    it('leaves the counter for the next transaction, with no gap', async () => {
      const before = await allocate(IN_A1);
      await abandon(IN_A1);
      const after = await allocate(IN_A1);

      // SO-0002 was allocated and rolled back, so SO-0002 is what the next caller gets. A
      // database sequence would have answered SO-0003 here, which is the gap section 10.4
      // forbids on a gapless sequence.
      expect(before.value).toBe(1n);
      expect(after.value).toBe(2n);
    });

    it('leaves nothing behind when the document write fails after allocation', async () => {
      // The shape a confirmation actually has: take a number, then write, then fail. Both the
      // number and the write have to go.
      await abandon(IN_A1, (repositories) =>
        repositories.salesOrders.create({
          id: 'f6100000-0000-4000-8000-00000000000a',
          customerId: CUSTOMER,
          warehouseId: WAREHOUSE,
          orderDate: '2026-09-11',
          currency: 'USD',
        }),
      );

      await ownerContext(TENANT_A, COMPANY_A1);
      const orders = await owner.query('SELECT 1 FROM sales_orders');

      expect(orders.rowCount).toBe(0);
      expect(await counterFor(TENANT_A, COMPANY_A1, SALES_ORDER_DOC_TYPE)).toBe('1');
    });

    it('does not block the next transaction once it has rolled back', async () => {
      await abandon(IN_A1);
      const next = await allocate(IN_A1);

      // The lock is released by the rollback. A lock that outlived its transaction would hang
      // every subsequent confirmation in the company.
      expect(next.value).toBe(1n);
    });
  });

  // -------------------------------------------------------------------------------------
  // 9. The number is not the caller's to choose.
  // -------------------------------------------------------------------------------------

  describe('the caller cannot choose a number', () => {
    it('has no input anywhere that carries one', async () => {
      // The allocation takes a document type and nothing else, and creating an order takes no
      // document number. Not overridden: unrepresentable.
      const allocateArity = await uow.inActorScope(IN_A1, async (repositories) =>
        repositories.documentNumberSequences.allocate.length,
      );

      expect(allocateArity).toBe(1);
      expect(allocateSalesOrderNumber.length).toBe(1);
    });

    it('ignores a document number smuggled into a new order', async () => {
      const smuggled = {
        id: 'f6200000-0000-4000-8000-00000000000b',
        customerId: CUSTOMER,
        warehouseId: WAREHOUSE,
        orderDate: '2026-09-11',
        currency: 'USD',
        docNumber: 'SO-9999',
        status: 'confirmed',
      };

      const order = await uow.inActorScope(IN_A1, (repositories) =>
        repositories.salesOrders.create(
          smuggled as unknown as Parameters<ScopedRepositories['salesOrders']['create']>[0],
        ),
      );

      expect(order.docNumber).toBeNull();
      expect(order.status).toBe('draft');
    });

    it('refuses a number the schema did not issue, at the database', async () => {
      // Two companies each holding SO-0001 is legitimate; the same company holding it twice is
      // not, and the unique index is what says so rather than the application remembering.
      await ownerContext(TENANT_A, COMPANY_A1);
      const insert = (id: string) =>
        owner.query(
          `INSERT INTO sales_orders
             (id, tenant_id, company_id, status, doc_number, customer_id, warehouse_id, order_date, currency)
           VALUES ($1,$2,$3,'confirmed','SO-0001',$4,$5,current_date,'USD')`,
          [id, TENANT_A, COMPANY_A1, CUSTOMER, WAREHOUSE],
        );

      await insert('f6300000-0000-4000-8000-00000000000c');

      await expect(insert('f6400000-0000-4000-8000-00000000000d')).rejects.toThrow(
        /sales_orders_company_doc_number_key/,
      );
    });
  });

  // -------------------------------------------------------------------------------------
  // 10. The allocation belongs to the caller's transaction.
  // -------------------------------------------------------------------------------------

  describe('the transaction boundary', () => {
    it('writes the counter in the same transaction as the document', async () => {
      // `xmin` is the transaction that last wrote the row. If allocation ran on a connection of
      // its own, the sequence row and the order row would carry different ones. Equal is the
      // only outcome consistent with one transaction, and it is the same proof the audit trail
      // uses in section 7.1.
      const orderId = 'f6500000-0000-4000-8000-00000000000e';

      await uow.inActorScope(IN_A1, async (repositories) => {
        await allocateSalesOrderNumber(repositories);
        await repositories.salesOrders.create({
          id: orderId,
          customerId: CUSTOMER,
          warehouseId: WAREHOUSE,
          orderDate: '2026-09-11',
          currency: 'USD',
        });
      });

      await ownerContext(TENANT_A, COMPANY_A1);
      const sequence = await owner.query<{ xmin: string }>(
        'SELECT xmin::text AS xmin FROM document_number_sequences WHERE company_id = $1 AND doc_type = $2',
        [COMPANY_A1, SALES_ORDER_DOC_TYPE],
      );
      const order = await owner.query<{ xmin: string }>(
        'SELECT xmin::text AS xmin FROM sales_orders WHERE id = $1',
        [orderId],
      );

      expect(sequence.rows[0]?.xmin).toBe(order.rows[0]?.xmin);
    });

    it('cannot be reached without a unit of work', async () => {
      // There is no exported repository implementation and no exported handle, so the only way
      // to an allocation is through a callback the unit of work has already wrapped. This is the
      // structural half of the guarantee; the rollback tests above are the behavioural half.
      const dataLayer = await import('../database/index.js');

      expect(Object.keys(dataLayer)).not.toContain('DrizzleDocumentNumberSequenceRepository');
      expect(Object.keys(dataLayer)).not.toContain('documentNumberSequences');
    });
  });

  // -------------------------------------------------------------------------------------
  // 11. The fixture counter is not what is running.
  // -------------------------------------------------------------------------------------

  describe('the JavaScript fixture counter is gone from this path', () => {
    it('continues the sequence in a freshly built application', async () => {
      // The sharpest available proof that the counter lives in the database rather than in a
      // module-level variable. A JavaScript counter is process state: rebuild the module graph
      // and it starts again at one. This builds a second application with its own connection
      // pool and its own unit of work, and asks it for a number.
      const first = await allocate(IN_A1);
      expect(first.value).toBe(1n);

      const second = await Test.createTestingModule({
        imports: [AppConfigModule, DatabaseModule, SalesModule],
      }).compile();
      await second.init();

      try {
        const fresh = second.get(UnitOfWork);
        // Otherwise this would be the first application answering again, and the test would
        // prove only that one counter counts.
        expect(fresh).not.toBe(uow);

        const allocated = await fresh.inActorScope(IN_A1, (repositories) =>
          allocateSalesOrderNumber(repositories),
        );

        // Two, not one. A restarted counter would answer SO-0001 and reissue a spent number.
        expect(allocated.value).toBe(2n);
        expect(allocated.formatted).toBe('SO-0002');
      } finally {
        await second.close();
      }

      expect(await counterFor(TENANT_A, COMPANY_A1, SALES_ORDER_DOC_TYPE)).toBe('3');
    });

    it('has no path from the API to the fixture layer at all', () => {
      // The fixture generator lives in the web workspace, so backend document creation reaching
      // it would need a dependency and an import. Neither exists, and this fails if one appears.
      const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

      expect(declared).not.toContain('@erp/web');

      const offenders: string[] = [];
      let scanned = 0;
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = `${dir}/${entry.name}`;
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.ts')) {
            scanned += 1;
            const source = fs.readFileSync(full, 'utf8');
            if (FIXTURE_IMPORT.test(source)) offenders.push(full);
          }
        }
      };
      walk('src');

      // An empty result has two explanations: nothing reaches the fixtures, or the walk read
      // nothing. This is what tells the two apart, and the same omission has made assertions in
      // this repository vacuous before.
      expect(scanned).toBeGreaterThan(50);
      expect(offenders).toEqual([]);
    });
  });
});
