/**
 * The value ledger, against a real PostgreSQL.
 *
 * THIS FILE IS THE POINT OF THE PACKAGE. Section 4.1 requires that a journal entry's debits equal
 * its credits by "deferred constraint or trigger, evaluated per entry at commit", and section 9.1
 * requires that a posted entry is never edited or deleted. Both are database behaviour, so every
 * claim here is asserted against a database. Section 13.2 is explicit: a mock proves nothing about
 * a constraint, a grant or a policy, and a fake transaction always rolls back cleanly.
 *
 * THREE WAYS IN, DELIBERATELY, because they prove different things:
 *
 *   the repository        what the application does, through the scoped data layer
 *   the application role  raw SQL as `erp_app`, which is what "bypassing application validation"
 *                         actually means: the service layer skipped, the grants and policies not
 *   the owning role       raw SQL as `erp_migrator`, which is section 4.1's administrator at a
 *                         database prompt, and the reason immutability is a trigger and not only
 *                         a withheld grant
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { actorScope, systemScope, UnitOfWork } from '../database/index.js';
import type { AccountRecord } from '../database/index.js';
import { provisionChartOfAccounts } from './chart-of-accounts.js';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];
const APP_URL = process.env['DATABASE_URL'];

const TENANT_A = 'f1100000-0000-4000-8000-00000000000a';
const TENANT_B = 'f1200000-0000-4000-8000-00000000000b';
const COMPANY_A1 = 'f2100000-0000-4000-8000-00000000000a';
/** A second company in tenant A, so "wrong company, right tenant" is representable. */
const COMPANY_A2 = 'f2200000-0000-4000-8000-00000000000b';
const COMPANY_B1 = 'f2300000-0000-4000-8000-00000000000c';

const USER = 'f3100000-0000-4000-8000-00000000000a';

const SCOPES: [string, string][] = [
  [TENANT_A, COMPANY_A1],
  [TENANT_A, COMPANY_A2],
  [TENANT_B, COMPANY_B1],
];

const inA1 = () => actorScope({ tenantId: TENANT_A, companyId: COMPANY_A1, userId: USER });
const inA2 = () => actorScope({ tenantId: TENANT_A, companyId: COMPANY_A2, userId: USER });
const inB1 = () => actorScope({ tenantId: TENANT_B, companyId: COMPANY_B1, userId: USER });

const scopeFor = (companyId: string) =>
  companyId === COMPANY_A1 ? inA1() : companyId === COMPANY_A2 ? inA2() : inB1();

describe('The journal', () => {
  let uow: UnitOfWork;
  let owner: Client;
  let app: Client;
  let close: () => Promise<void>;

  /** The chart of each company, by company, so a test can name a real account to post to. */
  const chart: Record<string, AccountRecord[]> = {};

  const accountOf = (companyId: string, code: string) =>
    chart[companyId]!.find((account) => account.code === code)!.id;

  const receivable = (companyId = COMPANY_A1) => accountOf(companyId, '1200');
  const revenue = (companyId = COMPANY_A1) => accountOf(companyId, '4000');
  const tax = (companyId = COMPANY_A1) => accountOf(companyId, '2200');

  beforeAll(async () => {
    if (!MIGRATION_URL || !APP_URL) {
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
    app = new Client({ connectionString: APP_URL });
    await app.connect();

    await purge();
    await seed();
  });

  afterAll(async () => {
    await purge();
    await app.end();
    await owner.end();
    await close();
  });

  beforeEach(async () => {
    await clearJournal();
  });

  async function contextOn(client: Client, tenantId?: string, companyId?: string): Promise<void> {
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId ?? '']);
    await client.query(`SELECT set_config('app.company_id', $1, false)`, [companyId ?? '']);
  }

  const ownerContext = (tenantId?: string, companyId?: string) =>
    contextOn(owner, tenantId, companyId);

  async function seed(): Promise<void> {
    await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3), ($4,$5,$6)', [
      TENANT_A,
      'journal-a',
      'Journal A',
      TENANT_B,
      'journal-b',
      'Journal B',
    ]);

    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_A }), async (r) => {
      await r.users.create({ id: USER, email: 'journal@company.test', name: 'J', passwordHash: 'x' });
      await r.companies.create({ id: COMPANY_A1, name: 'A One', baseCurrency: 'USD' });
      await r.companies.create({ id: COMPANY_A2, name: 'A Two', baseCurrency: 'USD' });
    });
    await uow.inSystemScope(systemScope('tenant-provisioning', { tenantId: TENANT_B }), (r) =>
      r.companies.create({ id: COMPANY_B1, name: 'B One', baseCurrency: 'EUR' }),
    );

    for (const [, companyId] of SCOPES) {
      chart[companyId] = await uow.inActorScope(scopeFor(companyId), (r) =>
        provisionChartOfAccounts(r),
      );
    }
  }

  async function clearJournal(): Promise<void> {
    // TRUNCATE rather than DELETE, because the trigger in 0014 refuses a delete even from the
    // owning role. That is the guarantee under test, so the teardown works with it rather than
    // asking for it to be weakened: truncation needs ownership, which the application role does
    // not have and cannot be granted.
    await ownerContext();
    await owner.query('TRUNCATE journal_lines, journal_entries');
  }

  async function purge(): Promise<void> {
    await clearJournal();
    for (const [tenantId, companyId] of SCOPES) {
      await ownerContext(tenantId, companyId);
      await owner.query('DELETE FROM company_posting_accounts WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM accounts WHERE company_id = $1', [companyId]);
      await owner.query('DELETE FROM companies WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        companyId,
      ]);
    }
    await ownerContext();
    await owner.query('DELETE FROM users WHERE id = $1', [USER]);
    await owner.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  }

  /** The invoice entry this whole package exists for: debit receivables, credit revenue and tax. */
  const invoiceEntry = (id = randomUUID(), companyId = COMPANY_A1) => ({
    id,
    entryDate: '2026-09-15',
    memo: 'Customer invoice',
    currency: 'USD',
    lines: [
      { accountId: receivable(companyId), debit: '120.0000' },
      { accountId: revenue(companyId), credit: '100.0000' },
      { accountId: tax(companyId), credit: '20.0000' },
    ],
  });

  const entryRows = async (tenantId = TENANT_A, companyId = COMPANY_A1) => {
    await ownerContext(tenantId, companyId);
    const result = await owner.query('SELECT * FROM journal_entries');
    return result.rows;
  };

  const lineRows = async (tenantId = TENANT_A, companyId = COMPANY_A1) => {
    await ownerContext(tenantId, companyId);
    const result = await owner.query<{
      journal_entry_id: string;
      line_number: number;
      account_id: string;
      debit: string;
      credit: string;
      currency: string;
    }>('SELECT * FROM journal_lines ORDER BY line_number');
    return result.rows;
  };

  /**
   * Writes an entry as the application role, past the repository entirely.
   *
   * This is what "bypassing application validation" means in practice: the service layer is not
   * involved, so nothing in TypeScript has an opinion about the entry. The grants, the policies
   * and the triggers are all that remain.
   */
  async function insertRaw(
    client: Client,
    input: {
      tenantId?: string;
      companyId?: string;
      entryId?: string;
      currency?: string;
      lines: { accountId: string; debit: string; credit: string }[];
      commit?: boolean;
    },
  ): Promise<string> {
    const tenantId = input.tenantId ?? TENANT_A;
    const companyId = input.companyId ?? COMPANY_A1;
    const entryId = input.entryId ?? randomUUID();

    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await client.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
      await client.query(
        `INSERT INTO journal_entries (id, tenant_id, company_id, entry_date, memo, currency)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [entryId, tenantId, companyId, '2026-09-15', 'Raw entry', input.currency ?? 'USD'],
      );

      let lineNumber = 0;
      for (const line of input.lines) {
        lineNumber += 1;
        await client.query(
          `INSERT INTO journal_lines
             (id, tenant_id, company_id, journal_entry_id, line_number, account_id, debit, credit, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            tenantId,
            companyId,
            entryId,
            lineNumber,
            line.accountId,
            line.debit,
            line.credit,
            input.currency ?? 'USD',
          ],
        );
      }

      await client.query(input.commit === false ? 'ROLLBACK' : 'COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    return entryId;
  }

  // -------------------------------------------------------------------------------------
  // 1. A balanced entry.
  // -------------------------------------------------------------------------------------

  describe('a balanced entry', () => {
    it('is written with its lines', async () => {
      const recorded = await uow.inActorScope(inA1(), (r) => r.journal.record(invoiceEntry()));

      expect(recorded.lines).toHaveLength(3);
      expect(await entryRows()).toHaveLength(1);
      expect(await lineRows()).toHaveLength(3);
    });

    it('numbers its lines from the order they were given', async () => {
      await uow.inActorScope(inA1(), (r) => r.journal.record(invoiceEntry()));

      const stored = await lineRows();
      expect(stored.map((row) => row.line_number)).toEqual([1, 2, 3]);
      expect(stored.map((row) => row.account_id)).toEqual([
        receivable(),
        revenue(),
        tax(),
      ]);
    });

    it('keeps each amount on exactly one side', async () => {
      await uow.inActorScope(inA1(), (r) => r.journal.record(invoiceEntry()));

      const stored = await lineRows();
      expect(stored.map((row) => `${row.debit}/${row.credit}`)).toEqual([
        '120.0000/0.0000',
        '0.0000/100.0000',
        '0.0000/20.0000',
      ]);
    });

    it('stamps every row with the tenant and company of the scope', async () => {
      const recorded = await uow.inActorScope(inA1(), (r) => r.journal.record(invoiceEntry()));

      expect({ tenant: recorded.entry.tenantId, company: recorded.entry.companyId }).toEqual({
        tenant: TENANT_A,
        company: COMPANY_A1,
      });
      expect(recorded.lines.every((line) => line.companyId === COMPANY_A1)).toBe(true);
    });

    it('reads back with its lines in order', async () => {
      const id = randomUUID();
      await uow.inActorScope(inA1(), (r) => r.journal.record(invoiceEntry(id)));

      const found = await uow.inActorScope(inA1(), (r) => r.journal.findById(id));

      expect(found?.entry.memo).toBe('Customer invoice');
      expect(found?.lines.map((line) => line.lineNumber)).toEqual([1, 2, 3]);
    });

    it('balances across many lines on each side', async () => {
      // Four lines, two on each side, with the totals equal only when all four are counted. An
      // implementation that compared the first debit with the first credit would pass the three
      // line case above and fail here.
      const id = randomUUID();
      await uow.inActorScope(inA1(), (r) =>
        r.journal.record({
          id,
          entryDate: '2026-09-15',
          memo: 'Two invoices settled together',
          currency: 'USD',
          lines: [
            { accountId: receivable(), debit: '60.0000' },
            { accountId: receivable(), debit: '60.0000' },
            { accountId: revenue(), credit: '100.0000' },
            { accountId: tax(), credit: '20.0000' },
          ],
        }),
      );

      expect(await lineRows()).toHaveLength(4);
    });

    it('balances to the fourth decimal place, where a double would not', async () => {
      // Section 4.3 stores amounts as exact NUMERIC for this case. Three tenths of a cent split
      // across two credits sums exactly here and would not in floating point.
      const id = randomUUID();
      await uow.inActorScope(inA1(), (r) =>
        r.journal.record({
          id,
          entryDate: '2026-09-15',
          memo: 'Fractional split',
          currency: 'USD',
          lines: [
            { accountId: receivable(), debit: '0.3000' },
            { accountId: revenue(), credit: '0.1000' },
            { accountId: tax(), credit: '0.2000' },
          ],
        }),
      );

      expect(await entryRows()).toHaveLength(1);
    });

    it('records the document that caused it, when there is one', async () => {
      const id = randomUUID();
      const source = randomUUID();
      await uow.inActorScope(inA1(), (r) =>
        r.journal.record({ ...invoiceEntry(id), sourceDocType: 'customer_invoice', sourceDocId: source }),
      );

      const found = await uow.inActorScope(inA1(), (r) =>
        r.journal.listForSourceDocument('customer_invoice', source),
      );

      expect(found.map((entry) => entry.entry.id)).toEqual([id]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 2. The balance invariant, which is the whole reason this schema exists.
  // -------------------------------------------------------------------------------------

  describe('an unbalanced entry', () => {
    it('is refused, and the refusal names the constraint', async () => {
      const error = await uow
        .inActorScope(inA1(), (r) =>
          r.journal.record({
            id: randomUUID(),
            entryDate: '2026-09-15',
            memo: 'Unbalanced',
            currency: 'USD',
            lines: [
              { accountId: receivable(), debit: '120.0000' },
              { accountId: revenue(), credit: '100.0000' },
            ],
          }),
        )
        .catch((thrown: unknown) => thrown);

      expect(causeChain(error)).toMatch(/unbalanced/i);
    });

    it('leaves nothing behind, neither the entry nor the lines that did balance', async () => {
      // The whole write rolls back. An entry row with two of its three lines would be a ledger
      // that says something false, which is worse than a failed request.
      await uow
        .inActorScope(inA1(), (r) =>
          r.journal.record({
            id: randomUUID(),
            entryDate: '2026-09-15',
            memo: 'Unbalanced',
            currency: 'USD',
            lines: [
              { accountId: receivable(), debit: '120.0000' },
              { accountId: revenue(), credit: '100.0000' },
            ],
          }),
        )
        .catch(() => undefined);

      expect(await entryRows()).toEqual([]);
      expect(await lineRows()).toEqual([]);
    });

    it('is refused by a tenth of a cent, not merely by a large difference', async () => {
      const error = await uow
        .inActorScope(inA1(), (r) =>
          r.journal.record({
            id: randomUUID(),
            entryDate: '2026-09-15',
            memo: 'Nearly',
            currency: 'USD',
            lines: [
              { accountId: receivable(), debit: '100.0001' },
              { accountId: revenue(), credit: '100.0000' },
            ],
          }),
        )
        .catch((thrown: unknown) => thrown);

      expect(causeChain(error)).toMatch(/unbalanced/i);
      expect(await entryRows()).toEqual([]);
    });

    it('is refused when the entry has no lines at all', async () => {
      // The line trigger cannot see this one, because it never fires. The trigger on the entry
      // is what catches it.
      const error = await uow
        .inActorScope(inA1(), (r) =>
          r.journal.record({
            id: randomUUID(),
            entryDate: '2026-09-15',
            memo: 'Empty',
            currency: 'USD',
            lines: [],
          }),
        )
        .catch((thrown: unknown) => thrown);

      expect(causeChain(error)).toMatch(/at least two/i);
      expect(await entryRows()).toEqual([]);
    });

    it('is refused when the entry has a single line, however it is signed', async () => {
      const error = await uow
        .inActorScope(inA1(), (r) =>
          r.journal.record({
            id: randomUUID(),
            entryDate: '2026-09-15',
            memo: 'One sided',
            currency: 'USD',
            lines: [{ accountId: receivable(), debit: '100.0000' }],
          }),
        )
        .catch((thrown: unknown) => thrown);

      expect(causeChain(error)).toMatch(/at least two/i);
    });
  });

  // -------------------------------------------------------------------------------------
  // 3. Bypassing the application entirely.
  // -------------------------------------------------------------------------------------

  describe('raw SQL as the application role', () => {
    it('writes a balanced entry, so the harness itself is not the thing refusing', async () => {
      // Without this, every refusal below could be a broken insert rather than an invariant.
      const id = await insertRaw(app, {
        lines: [
          { accountId: receivable(), debit: '120.0000', credit: '0' },
          { accountId: revenue(), credit: '120.0000', debit: '0' },
        ],
      });

      expect((await entryRows()).map((row) => row.id)).toEqual([id]);
    });

    it('cannot commit an unbalanced entry', async () => {
      // Section 4.1: an invariant enforced only in application code is not enforced. This is the
      // proof that the enforcement is not in application code.
      await expect(
        insertRaw(app, {
          lines: [
            { accountId: receivable(), debit: '120.0000', credit: '0' },
            { accountId: revenue(), credit: '100.0000', debit: '0' },
          ],
        }),
      ).rejects.toThrow(/unbalanced/i);

      expect(await entryRows()).toEqual([]);
      expect(await lineRows()).toEqual([]);
    });

    it('cannot commit an entry with no lines', async () => {
      await expect(insertRaw(app, { lines: [] })).rejects.toThrow(/at least two/i);
    });

    it('cannot write a line with nothing on either side', async () => {
      // A pair of empty lines would satisfy any sum comparison while recording nothing, which is
      // why the degenerate line is refused at the line rather than at the entry.
      await expect(
        insertRaw(app, {
          lines: [
            { accountId: receivable(), debit: '0', credit: '0' },
            { accountId: revenue(), debit: '0', credit: '0' },
          ],
        }),
      ).rejects.toThrow(/journal_lines_one_side_check/);
    });

    it('cannot write a line claiming both a debit and a credit', async () => {
      await expect(
        insertRaw(app, {
          lines: [
            { accountId: receivable(), debit: '120.0000', credit: '120.0000' },
            { accountId: revenue(), debit: '0', credit: '120.0000' },
          ],
        }),
      ).rejects.toThrow(/journal_lines_one_side_check/);
    });

    it('cannot write a negative amount, which would be a credit spelled as a debit', async () => {
      await expect(
        insertRaw(app, {
          lines: [
            { accountId: receivable(), debit: '-120.0000', credit: '0' },
            { accountId: revenue(), debit: '0', credit: '-120.0000' },
          ],
        }),
      ).rejects.toThrow(/journal_lines_one_side_check/);
    });

    it('cannot balance an entry with two negative lines, which arithmetic alone would allow', async () => {
      // -100 debit and -100 credit sum equal. The one side constraint is what stops the ledger
      // admitting two spellings of the same fact and calling them balanced.
      await expect(
        insertRaw(app, {
          lines: [
            { accountId: receivable(), debit: '-100.0000', credit: '0' },
            { accountId: revenue(), debit: '0', credit: '-100.0000' },
          ],
        }),
      ).rejects.toThrow(/journal_lines_one_side_check/);
    });

    it('cannot post a line to another company account', async () => {
      await expect(
        insertRaw(app, {
          lines: [
            { accountId: receivable(COMPANY_A2), debit: '120.0000', credit: '0' },
            { accountId: revenue(), debit: '0', credit: '120.0000' },
          ],
        }),
      ).rejects.toThrow(/journal_lines_account_fkey/);
    });

    it('cannot write an entry into a company the transaction has not entered', async () => {
      // Row level security, the second layer of section 2.4. The insert names a sibling company
      // while the context holds this one, and the policy's WITH CHECK refuses it. Asserted on
      // the policy's own message, so it cannot pass because of the balance trigger instead.
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
        await app.query(`SELECT set_config('app.company_id', $1, true)`, [COMPANY_A1]);

        await expect(
          app.query(
            `INSERT INTO journal_entries (id, tenant_id, company_id, entry_date, memo, currency)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [randomUUID(), TENANT_A, COMPANY_A2, '2026-09-15', 'Elsewhere', 'USD'],
          ),
        ).rejects.toThrow(/row-level security/i);
      } finally {
        await app.query('ROLLBACK');
      }
    });

    it('cannot write a line into a company the transaction has not entered', async () => {
      // THE POLICY IS NOT WHAT REFUSES THIS, and the test says so rather than claiming a
      // guarantee it is not demonstrating. A line naming another company can only reach the
      // policy through an entry in that company, and the trigger that refuses a line appended to
      // an entry from another transaction fires first, before the row is checked. Both orders
      // end in a refusal and a rolled back transaction; only the message differs.
      //
      // The line policy itself is covered on the read side, by the empty context test below, and
      // its existence is pinned in `schema-drift.int.spec.ts` with every other policy.
      const id = randomUUID();
      await uow.inActorScope(inA2(), (r) => r.journal.record(invoiceEntry(id, COMPANY_A2)));

      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
        await app.query(`SELECT set_config('app.company_id', $1, true)`, [COMPANY_A1]);

        await expect(
          app.query(
            `INSERT INTO journal_lines
               (id, tenant_id, company_id, journal_entry_id, line_number, account_id, debit, credit, currency)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [randomUUID(), TENANT_A, COMPANY_A2, id, 4, receivable(COMPANY_A2), '1.0000', '0', 'USD'],
          ),
        ).rejects.toThrow(/another transaction/i);
      } finally {
        await app.query('ROLLBACK');
      }

      // And nothing was added to the sibling company's entry either way.
      expect(await lineRows(TENANT_A, COMPANY_A2)).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------------------
  // 4. Immutability.
  // -------------------------------------------------------------------------------------

  describe('a written entry', () => {
    const written = async () => {
      const id = randomUUID();
      await uow.inActorScope(inA1(), (r) => r.journal.record(invoiceEntry(id)));
      return id;
    };

    it('cannot be updated by the application role, which holds no grant', async () => {
      const id = await written();

      await contextOn(app, TENANT_A, COMPANY_A1);
      await expect(
        app.query('UPDATE journal_entries SET memo = $1 WHERE id = $2', ['Rewritten', id]),
      ).rejects.toThrow(/permission denied/i);
    });

    it('cannot be deleted by the application role, which holds no grant', async () => {
      const id = await written();

      await contextOn(app, TENANT_A, COMPANY_A1);
      await expect(app.query('DELETE FROM journal_entries WHERE id = $1', [id])).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('cannot have a line updated by the application role', async () => {
      await written();

      await contextOn(app, TENANT_A, COMPANY_A1);
      await expect(app.query('UPDATE journal_lines SET debit = 1')).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('cannot be updated by the owning role either, because immutability is a trigger', async () => {
      // Section 4.1 opens by naming exactly this bypass: an administrator at a database prompt.
      // A withheld grant does not bind the owner, so the trigger does.
      const id = await written();

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(
        owner.query('UPDATE journal_entries SET memo = $1 WHERE id = $2', ['Rewritten', id]),
      ).rejects.toThrow(/append only/i);
    });

    it('cannot be deleted by the owning role either', async () => {
      const id = await written();

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(owner.query('DELETE FROM journal_entries WHERE id = $1', [id])).rejects.toThrow(
        /append only/i,
      );

      expect(await entryRows()).toHaveLength(1);
    });

    it('cannot have a line deleted by the owning role', async () => {
      await written();

      await ownerContext(TENANT_A, COMPANY_A1);
      await expect(owner.query('DELETE FROM journal_lines')).rejects.toThrow(/append only/i);

      expect(await lineRows()).toHaveLength(3);
    });

    it('cannot gain a line afterwards, which would be an edit the sums would not notice', async () => {
      // Two balanced lines appended to yesterday's entry keep every total equal and change what
      // the entry says. The transaction check is what refuses it.
      const id = await written();

      await expect(
        (async () => {
          await app.query('BEGIN');
          try {
            await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
            await app.query(`SELECT set_config('app.company_id', $1, true)`, [COMPANY_A1]);
            await app.query(
              `INSERT INTO journal_lines
                 (id, tenant_id, company_id, journal_entry_id, line_number, account_id, debit, credit, currency)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9), ($10,$2,$3,$4,$11,$12,$13,$14,$9)`,
              [
                randomUUID(), TENANT_A, COMPANY_A1, id, 4, receivable(), '5.0000', '0', 'USD',
                randomUUID(), 5, revenue(), '0', '5.0000',
              ],
            );
            await app.query('COMMIT');
          } catch (error) {
            await app.query('ROLLBACK').catch(() => undefined);
            throw error;
          }
        })(),
      ).rejects.toThrow(/another transaction/i);

      expect(await lineRows()).toHaveLength(3);
    });

    it('is corrected by a second entry, which is what section 9.1 asks for', async () => {
      // The reversal has no special support and needs none: it is an ordinary balanced entry
      // with the sides swapped, and both remain visible.
      const original = await written();
      const reversal = randomUUID();

      await uow.inActorScope(inA1(), (r) =>
        r.journal.record({
          id: reversal,
          entryDate: '2026-09-16',
          memo: 'Reversal of customer invoice',
          currency: 'USD',
          lines: [
            { accountId: revenue(), debit: '100.0000' },
            { accountId: tax(), debit: '20.0000' },
            { accountId: receivable(), credit: '120.0000' },
          ],
        }),
      );

      const stored = await entryRows();
      expect(stored.map((row) => row.id).sort()).toEqual([original, reversal].sort());
    });
  });

  // -------------------------------------------------------------------------------------
  // 5. Scope.
  // -------------------------------------------------------------------------------------

  describe('company and tenant scope', () => {
    it('cannot read a sibling company entry by identifier', async () => {
      const id = randomUUID();
      await uow.inActorScope(inA2(), (r) => r.journal.record(invoiceEntry(id, COMPANY_A2)));

      const found = await uow.inActorScope(inA1(), (r) => r.journal.findById(id));

      expect(found).toBeNull();
    });

    it('cannot read another tenant entry by identifier', async () => {
      const id = randomUUID();
      await uow.inActorScope(inB1(), (r) => r.journal.record(invoiceEntry(id, COMPANY_B1)));

      const found = await uow.inActorScope(inA1(), (r) => r.journal.findById(id));

      expect(found).toBeNull();
    });

    it('cannot reach a sibling company entry through its source document either', async () => {
      const source = randomUUID();
      await uow.inActorScope(inA2(), (r) =>
        r.journal.record({
          ...invoiceEntry(randomUUID(), COMPANY_A2),
          sourceDocType: 'customer_invoice',
          sourceDocId: source,
        }),
      );

      const found = await uow.inActorScope(inA1(), (r) =>
        r.journal.listForSourceDocument('customer_invoice', source),
      );

      expect(found).toEqual([]);
    });

    it('refuses a line posted to a sibling company account through the repository', async () => {
      const error = await uow
        .inActorScope(inA1(), (r) =>
          r.journal.record({
            id: randomUUID(),
            entryDate: '2026-09-15',
            memo: 'Cross company',
            currency: 'USD',
            lines: [
              { accountId: receivable(COMPANY_A2), debit: '100.0000' },
              { accountId: revenue(), credit: '100.0000' },
            ],
          }),
        )
        .catch((thrown: unknown) => thrown);

      expect(causeChain(error)).toMatch(/journal_lines_account_fkey/);
    });

    it('returns nothing at all when no company context is set', async () => {
      await uow.inActorScope(inA1(), (r) => r.journal.record(invoiceEntry()));

      await contextOn(app);
      const entries = await app.query<{ count: string }>('SELECT count(*) FROM journal_entries');
      const lines = await app.query<{ count: string }>('SELECT count(*) FROM journal_lines');

      // Section 2.4: an empty context denies rather than admits.
      expect([entries.rows[0]?.count, lines.rows[0]?.count]).toEqual(['0', '0']);
    });

    it('keeps each company ledger separate, with the same amounts in each', async () => {
      await uow.inActorScope(inA1(), (r) => r.journal.record(invoiceEntry()));
      await uow.inActorScope(inA2(), (r) =>
        r.journal.record(invoiceEntry(randomUUID(), COMPANY_A2)),
      );

      expect(await entryRows(TENANT_A, COMPANY_A1)).toHaveLength(1);
      expect(await entryRows(TENANT_A, COMPANY_A2)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------
  // 6. Concurrency.
  // -------------------------------------------------------------------------------------

  describe('two transactions writing at once', () => {
    it('judges each entry on its own lines, not on what is uncommitted elsewhere', async () => {
      // The discriminating case for a balance check written as a query over the whole company
      // rather than over one entry: two entries, each balanced, whose halves would sum wrongly if
      // one transaction could see the other's uncommitted lines.
      const first = randomUUID();
      const second = randomUUID();

      await Promise.all([
        uow.inActorScope(inA1(), (r) =>
          r.journal.record({
            id: first,
            entryDate: '2026-09-15',
            memo: 'First',
            currency: 'USD',
            lines: [
              { accountId: receivable(), debit: '10.0000' },
              { accountId: revenue(), credit: '10.0000' },
            ],
          }),
        ),
        uow.inActorScope(inA1(), (r) =>
          r.journal.record({
            id: second,
            entryDate: '2026-09-15',
            memo: 'Second',
            currency: 'USD',
            lines: [
              { accountId: receivable(), debit: '25.0000' },
              { accountId: revenue(), credit: '25.0000' },
            ],
          }),
        ),
      ]);

      expect((await entryRows()).map((row) => row.id).sort()).toEqual([first, second].sort());
    });

    it('commits the balanced one and refuses the unbalanced one, whichever order they finish in', async () => {
      const good = randomUUID();

      const results = await Promise.allSettled([
        uow.inActorScope(inA1(), (r) => r.journal.record(invoiceEntry(good))),
        uow.inActorScope(inA1(), (r) =>
          r.journal.record({
            id: randomUUID(),
            entryDate: '2026-09-15',
            memo: 'Unbalanced',
            currency: 'USD',
            lines: [
              { accountId: receivable(), debit: '99.0000' },
              { accountId: revenue(), credit: '1.0000' },
            ],
          }),
        ),
      ]);

      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
      expect((await entryRows()).map((row) => row.id)).toEqual([good]);
    });

    it('cannot be split across two transactions to look balanced', async () => {
      // One transaction writes the debit half and commits; the other would supply the credit.
      // The first commit is judged alone and fails, so the second has nothing to complete.
      const id = randomUUID();

      await expect(
        insertRaw(app, {
          entryId: id,
          lines: [{ accountId: receivable(), debit: '120.0000', credit: '0' }],
        }),
      ).rejects.toThrow();

      expect(await entryRows()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------
  // 7. When the check happens.
  // -------------------------------------------------------------------------------------

  describe('the timing of the check', () => {
    it('allows an entry to be unbalanced in the middle of its own transaction', async () => {
      // This is why section 4.1 says deferred. After the first line of a three line entry the
      // sums differ, and they are supposed to. A constraint evaluated per statement would refuse
      // every entry with more than one line, including every correct one.
      const id = randomUUID();

      const recorded = await uow.inActorScope(inA1(), async (r) => {
        const written = await r.journal.record(invoiceEntry(id));
        // Read back inside the same transaction, after every line is in but before commit.
        const found = await r.journal.findById(id);
        expect(found?.lines).toHaveLength(3);
        return written;
      });

      expect(recorded.entry.id).toBe(id);
    });

    it('refuses at commit, so a caller cannot ignore the failure and keep the rows', async () => {
      const id = randomUUID();

      await expect(
        uow.inActorScope(inA1(), async (r) => {
          await r.journal.record({
            id,
            entryDate: '2026-09-15',
            memo: 'Unbalanced',
            currency: 'USD',
            lines: [
              { accountId: receivable(), debit: '120.0000' },
              { accountId: revenue(), credit: '100.0000' },
            ],
          });
          // The repository returned normally. Nothing has refused anything yet, which is exactly
          // the window a per statement check would have closed and a deferred one leaves open.
          return 'written';
        }),
      ).rejects.toThrow();

      expect(await entryRows()).toEqual([]);
    });
  });
});

/** Drizzle wraps driver errors, so a constraint name has to be read through the chain. */
function causeChain(error: unknown): string {
  const messages: string[] = [];

  for (let current = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }

  return messages.join(' | ');
}
