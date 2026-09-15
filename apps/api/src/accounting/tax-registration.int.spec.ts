/**
 * Tax registration numbers on the company and on the customer, against a real PostgreSQL.
 *
 * WHY THESE TESTS SIT WITH THE ACCOUNTING FOUNDATION. Section 2.9 is where the columns come from,
 * and it puts them here rather than with the identity schema: "Tax registration numbers on the
 * company and on each party already exist in the domain model and are not yet persisted. They are
 * required on a legally valid invoice and arrive with invoice posting rather than here."
 *
 * WHAT IS ACTUALLY BEING CLAIMED. Three states, not two: a number, or no number, and nothing in
 * between. Null means the party is not registered, which is a fact an invoice needs. An empty or
 * padded string would be a second way to say the same thing that compares unequal to it, and the
 * check constraint is what refuses that. No jurisdiction's format is asserted, deliberately.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, systemScope, UnitOfWork } from '../database/index.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT_A = 'a7100000-0000-4000-8000-00000000000a';
const TENANT_B = 'a7200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'a7300000-0000-4000-8000-00000000000c';
const COMPANY_A2 = 'a7400000-0000-4000-8000-00000000000d';
const COMPANY_B1 = 'a7500000-0000-4000-8000-00000000000e';
const USER = 'a7600000-0000-4000-8000-00000000000f';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const inA1 = () => actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: USER });
const inA2 = () => actorScope({ tenantId: TENANT_A, companyId: COMPANY_A2, userId: USER });

describe('Tax registration numbers', () => {
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

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'trn-a',
      'TRN A',
      TENANT_B,
      'trn-b',
      'TRN B',
    ]);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_A }), async (r) => {
      await r.users.create({ id: USER, email: 'trn@company.test', name: 'TRN', passwordHash: 'x' });
      // One registered, one not. Both are legitimate and an invoice has to tell them apart.
      await r.companies.create({
        id: COMPANY_A1,
        name: 'A One',
        baseCurrency: 'USD',
        taxRegistrationNumber: 'GB123456789',
      });
      await r.companies.create({ id: COMPANY_A2, name: 'A Two', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_B }), (r) =>
      r.companies.create({ id: COMPANY_B1, name: 'B One', baseCurrency: 'EUR' }),
    );
  }

  async function purge(): Promise<void> {
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
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

  // -------------------------------------------------------------------------------------
  // The company.
  // -------------------------------------------------------------------------------------

  describe('on a company', () => {
    it('is stored and read back exactly as given', async () => {
      const company = await uow.inActorScope(inA1(), (r) => r.companies.findById(COMPANY_A1));

      expect(company?.taxRegistrationNumber).toBe('GB123456789');
    });

    it('is null for a company that is not registered, rather than an empty string', async () => {
      const company = await uow.inActorScope(inA2(), (r) => r.companies.findById(COMPANY_A2));

      expect(company?.taxRegistrationNumber).toBeNull();
    });

    it('is refused when padded, because it would compare unequal to the same number typed plainly', async () => {
      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query('UPDATE companies SET tax_registration_number = $1 WHERE id = $2', [
          ' GB123456789 ',
          COMPANY_A1,
        ]),
      ).rejects.toThrow(/companies_tax_registration_number_check/);
    });

    it('is refused when empty, which would be a second way to say not registered', async () => {
      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query('UPDATE companies SET tax_registration_number = $1 WHERE id = $2', [
          '',
          COMPANY_A1,
        ]),
      ).rejects.toThrow(/companies_tax_registration_number_check/);
    });

    it('accepts the formats different jurisdictions actually use', async () => {
      // No pattern is asserted by the schema, on purpose: length, alphabet and check digit rules
      // differ by country, and section 9.7 puts the engine that knows which country applies in
      // the future. These are all legitimate today.
      for (const number of ['GB123456789', 'DE 123 456 789', 'IE1234567AB', '12-3456789']) {
        await ownerContext(TENANT_A, COMPANY_A2);
        await owner.query('UPDATE companies SET tax_registration_number = $1 WHERE id = $2', [
          number,
          COMPANY_A2,
        ]);

        const company = await uow.inActorScope(inA2(), (r) => r.companies.findById(COMPANY_A2));
        expect(company?.taxRegistrationNumber).toBe(number);
      }

      await ownerContext(TENANT_A, COMPANY_A2);
      await owner.query('UPDATE companies SET tax_registration_number = NULL WHERE id = $1', [
        COMPANY_A2,
      ]);
    });
  });

  // -------------------------------------------------------------------------------------
  // The customer.
  // -------------------------------------------------------------------------------------

  describe('on a customer', () => {
    const CUSTOMER_A1 = 'a8100000-0000-4000-8000-00000000000a';
    const CUSTOMER_A2 = 'a8200000-0000-4000-8000-00000000000b';

    beforeAll(async () => {
      await uow.inActorScope(inA1(), (r) =>
        r.customers.create({
          id: CUSTOMER_A1,
          code: 'CUST-1',
          name: 'Registered Buyer',
          taxRegistrationNumber: 'FR987654321',
        }),
      );
      // Same code in the sibling company, and no number. Both facts matter below.
      await uow.inActorScope(inA2(), (r) =>
        r.customers.create({ id: CUSTOMER_A2, code: 'CUST-1', name: 'Private Buyer' }),
      );
    });

    it('is stored and read back exactly as given', async () => {
      const customer = await uow.inActorScope(inA1(), (r) => r.customers.findById(CUSTOMER_A1));

      expect(customer?.taxRegistrationNumber).toBe('FR987654321');
    });

    it('is null for a buyer who has none, which is the ordinary case for a private buyer', async () => {
      const customer = await uow.inActorScope(inA2(), (r) => r.customers.findById(CUSTOMER_A2));

      expect(customer?.taxRegistrationNumber).toBeNull();
    });

    it('is reached only inside the owning company, like the rest of the record', async () => {
      const found = await uow.inActorScope(inA2(), (r) => r.customers.findById(CUSTOMER_A1));

      expect(found).toBeNull();
    });

    it('does not leak through a lookup by the code the two companies share', async () => {
      const here = await uow.inActorScope(inA1(), (r) => r.customers.findByCode('CUST-1'));
      const there = await uow.inActorScope(inA2(), (r) => r.customers.findByCode('CUST-1'));

      expect(here?.taxRegistrationNumber).toBe('FR987654321');
      expect(there?.taxRegistrationNumber).toBeNull();
    });

    it('is refused when padded or empty, exactly as on the company', async () => {
      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query('UPDATE customers SET tax_registration_number = $1 WHERE id = $2', [
          '  ',
          CUSTOMER_A1,
        ]),
      ).rejects.toThrow(/customers_tax_registration_number_check/);
    });
  });
});
