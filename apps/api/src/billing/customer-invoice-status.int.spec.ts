/**
 * The invoice status union against the database that stores it, and the number a status may carry.
 *
 * A transition table is only as good as its list of states. If migration 0015 permits a status the
 * code has no rules for, every unit test beside this one is reasoning about a different set of
 * states than the system can hold, and all of them still pass. So this reads the check constraint
 * out of the catalogue rather than trusting the migration text or anyone's memory, in the same way
 * `sales/sales-order-status.int.spec.ts` does for the order.
 *
 * THE NUMBER CONSTRAINT IS THE OTHER HALF, and for this package it is the important one. Section
 * 10.4 allocates an invoice number inside the posting transaction, and this package must not
 * allocate one at all. The constraint is what makes that structural: a draft carrying a number
 * cannot be stored, so draft creation could not allocate one even if some later edit tried.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Client } from 'pg';

import { CUSTOMER_INVOICE_STATUSES } from './customer-invoice-status.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

const TENANT = 'd7100000-0000-4000-8000-00000000000a';
const COMPANY = 'd7200000-0000-4000-8000-00000000000a';
const CUSTOMER = 'd7300000-0000-4000-8000-00000000000a';

describe('The customer invoice status union', () => {
  let owner: Client;
  let constraint: string;

  beforeAll(async () => {
    if (!MIGRATION_URL) {
      throw new Error(
        'MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate`.',
      );
    }

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();
    await purge();
    await seed();

    const rows = await owner.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'customer_invoices_status_check'`,
    );

    const definition = rows.rows[0]?.definition;
    if (!definition) throw new Error('customer_invoices_status_check is missing from the database');
    constraint = definition;
  });

  afterAll(async () => {
    try {
      await purge();
    } finally {
      await owner.end();
    }
  });

  /**
   * The owning role writes these, so the context has to be set: every tenant scoped table carries
   * FORCE ROW LEVEL SECURITY and the owner is not exempt from its own policies.
   */
  async function context(tenantId: string, companyId: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId]);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)', [
      TENANT,
      'inv-status',
      'Invoice status',
    ]);
    await context(TENANT, COMPANY);
    await owner.query(
      'INSERT INTO companies (id, tenant_id, name, base_currency) VALUES ($1,$2,$3,$4)',
      [COMPANY, TENANT, 'Status Co', 'USD'],
    );
    await owner.query(
      'INSERT INTO customers (id, tenant_id, company_id, code, name) VALUES ($1,$2,$3,$4,$5)',
      [CUSTOMER, TENANT, COMPANY, 'CUST-1', 'A Customer'],
    );
  }

  async function purge(): Promise<void> {
    await context(TENANT, COMPANY);
    await owner.query('DELETE FROM customer_invoice_lines WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM customer_invoices WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM customers WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await owner.query(`SELECT set_config('app.tenant_id', '', false)`);
    await owner.query(`SELECT set_config('app.company_id', '', false)`);
    await owner.query('DELETE FROM tenants WHERE id = $1', [TENANT]);
  }

  /**
   * Writes one invoice in that state with or without a number, and says whether it was taken.
   *
   * Rolled back either way, so the table is left as it was found and the tests do not depend on
   * each other's rows.
   */
  async function accepts(status: string, docNumber: string | null): Promise<boolean> {
    await context(TENANT, COMPANY);
    await owner.query('BEGIN');
    try {
      await owner.query(
        `INSERT INTO customer_invoices
           (id, tenant_id, company_id, status, doc_number, customer_id, invoice_date, currency)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, current_date, 'USD')`,
        [TENANT, COMPANY, status, docNumber, CUSTOMER],
      );
      return true;
    } catch {
      return false;
    } finally {
      await owner.query('ROLLBACK');
    }
  }

  it('permits exactly the states the code defines', () => {
    const permitted = [...constraint.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();

    expect(permitted).toEqual([...CUSTOMER_INVOICE_STATUSES].sort());
  });

  it('is enforced by the database, not only by the application', () => {
    // Section 4.1 keeps integrity in the database. The union in the code is what this release
    // reasons about; the constraint is what makes an unknown status unstorable at all.
    expect(constraint).toMatch(/CHECK/i);
    expect(constraint).toContain('status');
  });

  it('refuses a status the union does not define, when one is actually attempted', async () => {
    // The assertion above reads the constraint text. This one proves the constraint bites: a
    // status the domain model mentions but this release does not define cannot be stored.
    expect(await accepts('paid', null)).toBe(false);
    expect(await accepts('cancelled', null)).toBe(false);
  });

  it('has a default of draft on the column itself', async () => {
    const rows = await owner.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'customer_invoices' AND column_name = 'status'`,
    );

    expect(rows.rows[0]?.column_default).toMatch(/'draft'/);
  });

  // -------------------------------------------------------------------------------------
  // The number a status may carry, which is what keeps a draft unnumbered.
  // -------------------------------------------------------------------------------------

  describe('the document number a status is allowed to carry', () => {
    it('refuses a draft that carries a number', async () => {
      // The structural half of "draft creation allocates no number". Section 10.4 allocates
      // inside the posting transaction, and a numbered draft would mean a number was spent on a
      // document that has claimed nothing from anybody.
      expect(await accepts('draft', 'INV-0001')).toBe(false);
      expect(await accepts('draft', null)).toBe(true);
    });

    it('refuses a posted invoice with no number', async () => {
      // The other direction: a posting that skipped allocation cannot commit.
      expect(await accepts('posted', null)).toBe(false);
      expect(await accepts('posted', 'INV-0002')).toBe(true);
    });

    it('names both states explicitly rather than exempting everything', async () => {
      const rows = await owner.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname = 'customer_invoices_draft_has_no_number_check'`,
      );

      // Read out of the catalogue, so loosening it to "any status may have no number" fails here
      // rather than passing quietly.
      const definition = rows.rows[0]?.definition ?? '';
      expect(definition).toContain('draft');
      expect(definition).toContain('posted');
    });

    it('keeps a number unique within a company but not across the platform', async () => {
      await context(TENANT, COMPANY);
      await owner.query('BEGIN');
      try {
        await owner.query(
          `INSERT INTO customer_invoices
             (id, tenant_id, company_id, status, doc_number, customer_id, invoice_date, currency)
           VALUES (gen_random_uuid(), $1, $2, 'posted', 'INV-0009', $3, current_date, 'USD')`,
          [TENANT, COMPANY, CUSTOMER],
        );

        await expect(
          owner.query(
            `INSERT INTO customer_invoices
               (id, tenant_id, company_id, status, doc_number, customer_id, invoice_date, currency)
             VALUES (gen_random_uuid(), $1, $2, 'posted', 'INV-0009', $3, current_date, 'USD')`,
            [TENANT, COMPANY, CUSTOMER],
          ),
        ).rejects.toThrow(/customer_invoices_company_doc_number_key/);
      } finally {
        await owner.query('ROLLBACK');
      }
    });

    it('lets two drafts exist at once, each with no number', async () => {
      // The unique index is partial for this reason: every draft has a null number, and null
      // numbers must not collide with each other.
      await context(TENANT, COMPANY);
      await owner.query('BEGIN');
      try {
        for (let i = 0; i < 2; i += 1) {
          await owner.query(
            `INSERT INTO customer_invoices
               (id, tenant_id, company_id, customer_id, invoice_date, currency)
             VALUES (gen_random_uuid(), $1, $2, $3, current_date, 'USD')`,
            [TENANT, COMPANY, CUSTOMER],
          );
        }

        const count = await owner.query<{ count: string }>(
          'SELECT count(*) FROM customer_invoices WHERE doc_number IS NULL',
        );
        expect(count.rows[0]?.count).toBe('2');
      } finally {
        await owner.query('ROLLBACK');
      }
    });

    it('refuses a due date that falls before the invoice date', async () => {
      await context(TENANT, COMPANY);
      await expect(
        owner.query(
          `INSERT INTO customer_invoices
             (id, tenant_id, company_id, customer_id, invoice_date, due_date, currency)
           VALUES (gen_random_uuid(), $1, $2, $3, '2026-09-15', '2026-09-14', 'USD')`,
          [TENANT, COMPANY, CUSTOMER],
        ),
      ).rejects.toThrow(/customer_invoices_due_date_check/);
    });
  });
});
