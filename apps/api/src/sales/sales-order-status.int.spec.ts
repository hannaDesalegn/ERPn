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

describe('The sales order status union', () => {
  let owner: Client;
  let constraint: string;

  beforeAll(async () => {
    if (!MIGRATION_URL) {
      throw new Error('MIGRATION_DATABASE_URL must be set. Run `npm run db:up` and `npm run db:migrate`.');
    }

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();

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
    await owner.end();
  });

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
});
