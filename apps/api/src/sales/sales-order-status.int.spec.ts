/**
 * The status union against the database that stores it.
 *
 * A transition table is only as good as its list of states. If migration 0005 permits a status
 * the code has no rules for, every one of the unit tests beside this one is reasoning about a
 * different set of states than the system can actually hold, and all of them still pass.
 *
 * So this reads the check constraint out of the catalogue rather than trusting the migration
 * text or anyone's memory, in the same way the drift suite does for tables and grants.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Client } from 'pg';

import { SALES_ORDER_STATUSES } from './sales-order-status.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];

/** One company with the master data an order needs, so a real row can be attempted. */
const TENANT = 'd1100000-0000-4000-8000-00000000000a';
const COMPANY = 'd1200000-0000-4000-8000-00000000000a';
const CUSTOMER = 'd1300000-0000-4000-8000-00000000000a';
const WAREHOUSE = 'd1400000-0000-4000-8000-00000000000a';

describe('The sales order status union', () => {
  let owner: Client;
  let constraint: string;

  beforeAll(async () => {
    if (!MIGRATION_URL) {
      throw new Error('MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate`.');
    }

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();
    await purge();
    await seed();

    const rows = await owner.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'sales_orders_status_check'`,
    );

    const definition = rows.rows[0]?.definition;
    if (!definition) throw new Error('sales_orders_status_check is missing from the database');
    constraint = definition;
  });

  afterAll(async () => {
    await purge();
    await owner.end();
  });

  /**
   * The owning role writes these, so the context has to be set: every tenant scoped table
   * carries FORCE ROW LEVEL SECURITY and the owner is not exempt from its own policies.
   */
  async function context(tenantId: string, companyId: string): Promise<void> {
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    await owner.query(`SELECT set_config('app.company_id', $1, false)`, [companyId]);
  }

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)', [
      TENANT,
      'so-status',
      'Status',
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
    await owner.query(
      'INSERT INTO warehouses (id, tenant_id, company_id, code, name, is_default) VALUES ($1,$2,$3,$4,$5,true)',
      [WAREHOUSE, TENANT, COMPANY, 'WH-1', 'Main'],
    );
  }

  async function purge(): Promise<void> {
    await context(TENANT, COMPANY);
    await owner.query('DELETE FROM sales_orders WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM customers WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM warehouses WHERE company_id = $1', [COMPANY]);
    await owner.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await context('', '');
    await owner.query('DELETE FROM tenants WHERE id = $1', [TENANT]);
  }

  it('matches what the database will actually store, in both directions', () => {
    // Pulled out of the constraint rather than compared by hand, so a status added to either
    // side alone fails here instead of surfacing as a row the code cannot interpret.
    const permitted = [...constraint.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();

    expect(permitted).toEqual([...SALES_ORDER_STATUSES].sort());
  });

  it('is enforced by the database, not only by the application', () => {
    // Section 4.1 keeps integrity in the database. The union in the code is what this release
    // reasons about; the constraint is what makes an unknown status unstorable at all.
    expect(constraint).toMatch(/CHECK/i);
    expect(constraint).toContain('status');
  });

  it('starts an order as a draft, which is the state the table transitions out of', () => {
    // The transition table's one legal move begins at `draft`. If the column defaulted to
    // anything else, a new order would start somewhere that move cannot reach.
    expect(SALES_ORDER_STATUSES[0]).toBe('draft');
  });

  it('has a default of draft on the column itself', async () => {
    const rows = await owner.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'sales_orders' AND column_name = 'status'`,
    );

    expect(rows.rows[0]?.column_default).toMatch(/'draft'/);
  });

  // -------------------------------------------------------------------------------------
  // The number constraint, as amended for cancellation on 2026-09-13.
  // -------------------------------------------------------------------------------------

  describe('the document number a status is allowed to carry', () => {
    let numbering: string;

    beforeAll(async () => {
      const rows = await owner.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname = 'sales_orders_draft_has_no_number_check'`,
      );

      const definition = rows.rows[0]?.definition;
      if (!definition) {
        throw new Error('sales_orders_draft_has_no_number_check is missing from the database');
      }
      numbering = definition;
    });

    /**
     * Writes one order in that state with or without a number, and says whether it was taken.
     *
     * Rolled back either way, so the table is left as it was found and the tests do not depend
     * on each other's rows.
     */
    async function accepts(status: string, docNumber: string | null): Promise<boolean> {
      await owner.query('BEGIN');
      try {
        await owner.query(
          `INSERT INTO sales_orders
             (id, tenant_id, company_id, status, doc_number, customer_id, warehouse_id, order_date, currency)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, current_date, 'USD')`,
          [TENANT, COMPANY, status, docNumber, CUSTOMER, WAREHOUSE],
        );
        return true;
      } catch {
        return false;
      } finally {
        await owner.query('ROLLBACK');
      }
    }

    it('still refuses a draft that carries a number', async () => {
      // Section 10.4 allocates in the confirming transaction. A numbered draft would mean a
      // number was issued to a document that has committed to nothing.
      expect(await accepts('draft', 'SO-0001')).toBe(false);
      expect(await accepts('draft', null)).toBe(true);
    });

    it('still refuses a confirmed order with no number', async () => {
      // The invariant the original constraint existed for, and the amendment narrowed rather
      // than loosened: a confirmation that skipped allocation cannot commit.
      expect(await accepts('confirmed', null)).toBe(false);
      expect(await accepts('confirmed', 'SO-0002')).toBe(true);
    });

    it('still refuses every other numbered state without a number', async () => {
      for (const status of ['partially_delivered', 'delivered', 'invoiced']) {
        expect(await accepts(status, null)).toBe(false);
      }
    });

    it('lets a cancelled order go either way, because it is reachable from both sides', async () => {
      // Section 12.3, ruled 2026-09-13. A cancelled draft never had a number and does not get
      // one; a cancelled confirmed order keeps the number it was issued. This is the one status
      // reachable from both sides of allocation, and the only one the constraint lets go both
      // ways.
      expect(await accepts('cancelled', null)).toBe(true);
      expect(await accepts('cancelled', 'SO-0003')).toBe(true);
    });

    it('names cancelled explicitly rather than exempting everything', async () => {
      // Read out of the catalogue, so loosening the constraint to "any status may have no
      // number" fails here rather than passing quietly.
      expect(numbering).toContain('cancelled');
      expect(numbering).toContain('draft');
    });
  });
});
