/**
 * The product repository, against a real PostgreSQL.
 *
 * Products get their own suite because two contract requirements attach to them and to nothing
 * else in master data. Section 8.4 gives every product a canonical stocking unit, without which
 * every quantity in the stock ledger becomes ambiguous. Section 3.3 makes the sales price the
 * master data the server recomputes from rather than trusting a price a form sent back, and
 * section 4.3 fixes its precision at six decimal places, because a distributor sells at a
 * fraction of a cent per unit inside a pack of a thousand.
 *
 * The scoping tests are the same shape as every other repository suite here. The seed gives all
 * three companies the same SKU, because a SKU is unique within a company and not globally, and
 * an unscoped lookup would return whichever row came back first.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../../config/config.module.js';
import { DatabaseModule } from '../database.module.js';
import {
  actorScope,
  ConcurrencyConflictError,
  RecordNotFoundError,
  systemScope,
  UnitOfWork,
} from '../index.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'aa900000-0000-4000-8000-00000000000a';
const TENANT_B = 'ab900000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'ba900000-0000-4000-8000-00000000000a';
const COMPANY_A2 = 'bb900000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'bc900000-0000-4000-8000-00000000000c';

const USER_A = 'ca900000-0000-4000-8000-00000000000a';

const PRODUCT: Record<string, string> = {
  [COMPANY_A1]: 'da900000-0000-4000-8000-00000000000a',
  [COMPANY_A2]: 'db900000-0000-4000-8000-00000000000b',
  [COMPANY_B1]: 'dc900000-0000-4000-8000-00000000000c',
};

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const inA1 = () => actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: USER_A });
const inA2 = () => actorScope({ tenantId: TENANT_A, companyId: COMPANY_A2, userId: USER_A });
const inB1 = () => actorScope({ tenantId: TENANT_B, companyId: COMPANY_B1, userId: USER_A });

describe('Product repository', () => {
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

  async function ownerContext(tenantId?: string, companyId?: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  const scopeFor = (companyId: string) =>
    companyId === COMPANY_A1 ? inA1() : companyId === COMPANY_A2 ? inA2() : inB1();

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'prod-repo-a',
      'Prod Repo A',
      TENANT_B,
      'prod-repo-b',
      'Prod Repo B',
    ]);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_A }), async (r) => {
      await r.users.create({ id: USER_A, email: 'a@prodrepo.test', name: 'A', passwordHash: 'x' });
      await r.companies.create({ id: COMPANY_A1, name: 'A One', baseCurrency: 'USD' });
      await r.companies.create({ id: COMPANY_A2, name: 'A Two', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_B }), (r) =>
      r.companies.create({ id: COMPANY_B1, name: 'B One', baseCurrency: 'EUR' }),
    );

    // The same SKU in every company, deliberately.
    for (const [, companyId] of SCOPES) {
      await uow.inActorScope(scopeFor(companyId), (r) =>
        r.products.create({
          id: PRODUCT[companyId]!,
          sku: 'SKU-1',
          name: `Widget of ${companyId.slice(0, 4)}`,
          stockingUom: 'unit',
          salesPrice: '12.345600',
          salesPriceCurrency: companyId === COMPANY_B1 ? 'EUR' : 'USD',
        }),
      );
    }
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM products WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('TRUNCATE audit_events');
    await owner.query('DELETE FROM users WHERE id = $1', [USER_A]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  // -------------------------------------------------------------------------------------
  // Scoping, the same guarantee every repository here owes.
  // -------------------------------------------------------------------------------------

  describe('scoping', () => {
    it('lists only the acting company products', async () => {
      const seen = await uow.inActorScope(inA1(), (r) => r.products.listForCompany());

      expect(seen.map((p) => p.id)).toEqual([PRODUCT[COMPANY_A1]]);
    });

    it('cannot reach a sibling company product by identifier', async () => {
      const found = await uow.inActorScope(inA1(), (r) =>
        r.products.findById(PRODUCT[COMPANY_A2]!),
      );

      expect(found).toBeNull();
    });

    it('cannot reach another tenant product by identifier', async () => {
      const found = await uow.inActorScope(inA1(), (r) =>
        r.products.findById(PRODUCT[COMPANY_B1]!),
      );

      expect(found).toBeNull();
    });

    it('makes a foreign identifier indistinguishable from a missing one', async () => {
      const foreign = await uow.inActorScope(inA1(), (r) =>
        r.products.findById(PRODUCT[COMPANY_B1]!),
      );
      const missing = await uow.inActorScope(inA1(), (r) =>
        r.products.findById('df900000-0000-4000-8000-00000000000f'),
      );

      expect(foreign).toEqual(missing);
    });

    it('resolves a shared SKU to the acting company product and no other', async () => {
      const fromA1 = await uow.inActorScope(inA1(), (r) => r.products.findBySku('SKU-1'));
      const fromA2 = await uow.inActorScope(inA2(), (r) => r.products.findBySku('SKU-1'));
      const fromB1 = await uow.inActorScope(inB1(), (r) => r.products.findBySku('SKU-1'));

      expect(fromA1?.id).toBe(PRODUCT[COMPANY_A1]);
      expect(fromA2?.id).toBe(PRODUCT[COMPANY_A2]);
      expect(fromB1?.id).toBe(PRODUCT[COMPANY_B1]);
    });

    it('stamps tenant and company from the scope, not from the caller', async () => {
      const id = 'dd900000-0000-4000-8000-00000000000d';
      const created = await uow.inActorScope(inA2(), (r) =>
        r.products.create({
          id,
          sku: 'SKU-STAMP',
          name: 'Stamped',
          stockingUom: 'box',
          salesPriceCurrency: 'USD',
        }),
      );

      expect(created.tenantId).toBe(TENANT_A);
      expect(created.companyId).toBe(COMPANY_A2);

      const fromSibling = await uow.inActorScope(inA1(), (r) => r.products.findById(id));
      expect(fromSibling).toBeNull();
    });

    it('refuses a scope naming a tenant but no company', async () => {
      await expect(
        uow.inSystemScope(systemScope('integration-test', { tenantId: TENANT_A }), (r) =>
          r.products.listForCompany(),
        ),
      ).rejects.toThrow(/no company/);
    });
  });

  // -------------------------------------------------------------------------------------
  // The two requirements that attach to products specifically.
  // -------------------------------------------------------------------------------------

  describe('section 8.4, the canonical stocking unit', () => {
    it('records the unit the caller gave', async () => {
      const found = await uow.inActorScope(inA1(), (r) => r.products.findBySku('SKU-1'));

      expect(found?.stockingUom).toBe('unit');
    });

    it('has no default, so a product cannot be created without one', async () => {
      // Section 8.4: without a canonical unit every quantity in history is ambiguous. A default
      // here would be this layer choosing a unit for a business it knows nothing about, so the
      // input type requires it and the database refuses a null.
      await expect(
        uow.inActorScope(inA1(), (r) =>
          r.products.create({
            id: 'de900000-0000-4000-8000-00000000000e',
            sku: 'SKU-NOUOM',
            name: 'No unit',
            stockingUom: undefined as unknown as string,
            salesPriceCurrency: 'USD',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('section 3.3 and 4.3, the price the server recomputes from', () => {
    it('returns the price as an exact decimal string at six places', async () => {
      // Not a number. A JavaScript number is an IEEE-754 double, and rounding the sixth place
      // away here would put the loss one layer below everything that cares about it.
      const found = await uow.inActorScope(inA1(), (r) => r.products.findBySku('SKU-1'));

      expect(typeof found?.salesPrice).toBe('string');
      expect(found?.salesPrice).toBe('12.345600');
    });

    it('keeps a fraction of a cent rather than rounding it', async () => {
      // The concrete case section 4.3 names: cable ties sold at a fraction of a cent per unit
      // inside a pack of a thousand. Two decimal places would lose money on the first price list.
      const id = 'd1900000-0000-4000-8000-00000000000a';
      const created = await uow.inActorScope(inA1(), (r) =>
        r.products.create({
          id,
          sku: 'SKU-TINY',
          name: 'Cable tie',
          stockingUom: 'unit',
          salesPrice: '0.004250',
          salesPriceCurrency: 'USD',
        }),
      );

      expect(created.salesPrice).toBe('0.004250');
    });

    it('stores a currency alongside the amount', async () => {
      const fromA1 = await uow.inActorScope(inA1(), (r) => r.products.findBySku('SKU-1'));
      const fromB1 = await uow.inActorScope(inB1(), (r) => r.products.findBySku('SKU-1'));

      expect(fromA1?.salesPriceCurrency).toBe('USD');
      expect(fromB1?.salesPriceCurrency).toBe('EUR');
    });

    it('defaults an unpriced product to zero rather than to null', async () => {
      // A real state: a service item quoted per job has no list price. Zero is a price; null
      // would be a second meaning for the same column.
      const created = await uow.inActorScope(inA1(), (r) =>
        r.products.create({
          id: 'd2900000-0000-4000-8000-00000000000b',
          sku: 'SKU-QUOTE',
          name: 'Consulting hour',
          type: 'service',
          stockingUom: 'unit',
          salesPriceCurrency: 'USD',
        }),
      );

      expect(created.salesPrice).toBe('0.000000');
      expect(created.type).toBe('service');
    });

    it('defaults a product to stockable, which is what most of a distributor catalogue is', async () => {
      const created = await uow.inActorScope(inA1(), (r) =>
        r.products.create({
          id: 'd3900000-0000-4000-8000-00000000000c',
          sku: 'SKU-DEFAULT',
          name: 'Ordinary widget',
          stockingUom: 'box',
          salesPriceCurrency: 'USD',
        }),
      );

      expect(created.type).toBe('stockable');
    });

    it('refuses a product type the domain does not define', async () => {
      await expect(
        uow.inActorScope(inA1(), (r) =>
          r.products.create({
            id: 'd4900000-0000-4000-8000-00000000000d',
            sku: 'SKU-ODD',
            name: 'Odd',
            type: 'subscription',
            stockingUom: 'unit',
            salesPriceCurrency: 'USD',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------------------
  // Archiving, which is what section 4.5 offers instead of deletion.
  // -------------------------------------------------------------------------------------

  describe('archiving', () => {
    it('archives a product and bumps its version', async () => {
      const id = 'd5900000-0000-4000-8000-00000000000e';
      const created = await uow.inActorScope(inA1(), (r) =>
        r.products.create({
          id,
          sku: 'SKU-ARCH',
          name: 'Discontinued',
          stockingUom: 'unit',
          salesPriceCurrency: 'USD',
        }),
      );

      const archived = await uow.inActorScope(inA1(), (r) =>
        r.products.archive({ id, expectedVersion: created.version }),
      );

      expect(archived.status).toBe('archived');
      expect(archived.version).toBe(created.version + 1);
    });

    it('refuses a stale version rather than overwriting', async () => {
      const id = 'd6900000-0000-4000-8000-00000000000f';
      const created = await uow.inActorScope(inA1(), (r) =>
        r.products.create({
          id,
          sku: 'SKU-STALE',
          name: 'Raced',
          stockingUom: 'unit',
          salesPriceCurrency: 'USD',
        }),
      );
      await uow.inActorScope(inA1(), (r) =>
        r.products.archive({ id, expectedVersion: created.version }),
      );

      await expect(
        uow.inActorScope(inA1(), (r) =>
          r.products.archive({ id, expectedVersion: created.version }),
        ),
      ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    });

    it('reports another company product as not found rather than as a conflict', async () => {
      // A conflict would confirm the row exists somewhere, which is exactly what section 6.1
      // says a failure at the company dimension must not disclose.
      await expect(
        uow.inActorScope(inA1(), (r) =>
          r.products.archive({ id: PRODUCT[COMPANY_A2]!, expectedVersion: 1 }),
        ),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
    });

    it('leaves the other company product untouched', async () => {
      const sibling = await uow.inActorScope(inA2(), (r) =>
        r.products.findById(PRODUCT[COMPANY_A2]!),
      );

      expect(sibling?.status).toBe('active');
    });
  });
});
