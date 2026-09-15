/**
 * What is actually enforcing the ledger's invariants, read from the PostgreSQL catalogue.
 *
 * WHY THIS FILE EXISTS BESIDE THE BEHAVIOURAL ONE. `journal.int.spec.ts` proves that an
 * unbalanced entry cannot be committed and that a written entry cannot be changed. It cannot, on
 * its own, prove *what* refuses them: a behavioural test passes equally if the refusal comes from
 * the trigger section 4.1 requires, from an unrelated constraint, or from a type error. That
 * distinction matters here because section 4.1 names the mechanism, not merely the outcome:
 * "deferred constraint or trigger, evaluated per entry at commit".
 *
 * So this reads the catalogue, in the shape `schema-drift.int.spec.ts` already established for row
 * level security and grants. If the balance trigger is dropped, disabled, or quietly redefined as
 * a non-deferred one, these tests fail by name, and the behavioural ones lose the thing that was
 * making them pass. Together the two files are the mutation check that a live DDL change cannot
 * be made in this environment to perform by hand.
 *
 * The messages are pinned as well. `journal.int.spec.ts` asserts on the words "unbalanced" and
 * "at least two", and those words exist in exactly one place in the deployment: the function
 * below. A refusal carrying them cannot have come from anywhere else.
 *
 * Requires `npm run db:up` and `npm run db:migrate`.
 */

import { Client } from 'pg';

const MIGRATION_URL = process.env['MIGRATION_DATABASE_URL'];
const APP_ROLE = process.env['APP_DB_ROLE'] ?? 'erp_app';

interface TriggerRow {
  table_name: string;
  trigger_name: string;
  is_constraint: boolean;
  deferrable: boolean;
  initially_deferred: boolean;
  enabled: string;
  function_name: string;
  event_mask: number;
}

describe('What enforces the ledger', () => {
  let owner: Client;
  let triggers: TriggerRow[];

  beforeAll(async () => {
    if (!MIGRATION_URL) {
      throw new Error(
        'MIGRATION_DATABASE_URL is not set. These tests read the live catalogue: run `npm run db:up` and `npm run db:migrate` first.',
      );
    }

    owner = new Client({ connectionString: MIGRATION_URL });
    await owner.connect();

    const result = await owner.query<TriggerRow>(
      `SELECT c.relname        AS table_name,
              t.tgname         AS trigger_name,
              t.tgconstraint <> 0 AS is_constraint,
              t.tgdeferrable   AS deferrable,
              t.tginitdeferred AS initially_deferred,
              t.tgenabled      AS enabled,
              p.proname        AS function_name,
              t.tgtype         AS event_mask
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal
          AND c.relnamespace = 'public'::regnamespace
          AND c.relname IN ('journal_entries', 'journal_lines')
        ORDER BY c.relname, t.tgname`,
    );
    triggers = result.rows;
  });

  afterAll(async () => {
    await owner.end();
  });

  const trigger = (name: string) => triggers.find((row) => row.trigger_name === name);

  // -------------------------------------------------------------------------------------
  // The balance invariant.
  // -------------------------------------------------------------------------------------

  describe('the balance invariant', () => {
    it('exists on both tables, so an empty entry is caught as well as an unbalanced one', () => {
      // Two triggers for two different holes. The one on the lines catches an entry whose lines
      // disagree; the one on the entry catches an entry with no lines, which the line trigger
      // never fires for.
      expect(
        triggers
          .filter((row) => row.function_name === 'journal_entry_must_balance')
          .map((row) => `${row.table_name}.${row.trigger_name}`)
          .sort(),
      ).toEqual([
        'journal_entries.journal_entry_must_balance',
        'journal_lines.journal_lines_must_balance_their_entry',
      ]);
    });

    it.each([
      'journal_entry_must_balance',
      'journal_lines_must_balance_their_entry',
    ])('%s is a constraint trigger, deferred to commit, per section 4.1', (name) => {
      const row = trigger(name);

      // Not merely a trigger. A non-deferred one would fire after each statement, and an entry is
      // unbalanced after its first line by construction, so every correct multi line entry would
      // be refused. Deferred is the whole design, not a detail of it.
      expect({
        constraint: row?.is_constraint,
        deferrable: row?.deferrable,
        initiallyDeferred: row?.initially_deferred,
      }).toEqual({ constraint: true, deferrable: true, initiallyDeferred: true });
    });

    it.each([
      'journal_entry_must_balance',
      'journal_lines_must_balance_their_entry',
    ])('%s is enabled, and a disabled one would be an invariant that is not enforced', (name) => {
      // `O` is the default enabled state. `D` is disabled, which is how an invariant gets turned
      // off during an incident and left off.
      expect(trigger(name)?.enabled).toBe('O');
    });

    it('is the only thing in the deployment that says "unbalanced" or "at least two"', async () => {
      // This is what ties the behavioural suite to this mechanism. Those two phrases appear in
      // one function, so a refusal carrying either of them came from here and nowhere else.
      const result = await owner.query<{ proname: string }>(
        `SELECT proname FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND (prosrc LIKE '%unbalanced%' OR prosrc LIKE '%at least two%')
          ORDER BY proname`,
      );

      expect(result.rows.map((row) => row.proname)).toEqual(['journal_entry_must_balance']);
    });

    it('is not SECURITY DEFINER, which would make it blind to the rows it judges', async () => {
      // These tables carry FORCE row level security, so a function running as the owner with no
      // context set would see no lines, find zero equal to zero, and pass every unbalanced entry
      // ever written. Running as the invoker is what makes the sum the entry's own lines.
      const result = await owner.query<{ prosecdef: boolean }>(
        `SELECT prosecdef FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace AND proname = 'journal_entry_must_balance'`,
      );

      expect(result.rows[0]?.prosecdef).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------
  // Immutability.
  // -------------------------------------------------------------------------------------

  describe('immutability', () => {
    it('is a trigger on both tables, which binds the owning role as well as the application', () => {
      expect(
        triggers
          .filter((row) => row.function_name === 'journal_is_append_only')
          .map((row) => row.table_name)
          .sort(),
      ).toEqual(['journal_entries', 'journal_lines']);
    });

    it.each(['journal_entries_append_only', 'journal_lines_append_only'])(
      '%s fires before both an update and a delete',
      (name) => {
        const row = trigger(name);

        // `tgtype` is a bit mask, and the bits are the ones PostgreSQL defines rather than the
        // order a reader might assume: 1 is row level, 2 is BEFORE, 4 INSERT, 8 DELETE, 16
        // UPDATE. Asserted together because a trigger covering only one of the two verbs would
        // leave the other way open, and the balance triggers next door carry a different mask,
        // so this cannot pass for the wrong trigger.
        const mask = Number(row?.event_mask);

        expect({
          rowLevel: (mask & 1) === 1,
          before: (mask & 2) === 2,
          onUpdate: (mask & 16) === 16,
          onDelete: (mask & 8) === 8,
          enabled: row?.enabled,
        }).toEqual({
          rowLevel: true,
          before: true,
          onUpdate: true,
          onDelete: true,
          enabled: 'O',
        });
      },
    );

    it('refuses a line appended by a later transaction, which no sum would notice', () => {
      const row = trigger('journal_lines_belong_to_their_own_transaction');

      expect({ enabled: row?.enabled, table: row?.table_name }).toEqual({
        enabled: 'O',
        table: 'journal_lines',
      });
    });
  });

  // -------------------------------------------------------------------------------------
  // Grants. The second half of section 4.1's "trigger, or revoked grants".
  // -------------------------------------------------------------------------------------

  describe('the grants held by the application role', () => {
    it.each(['journal_entries', 'journal_lines'])(
      'holds exactly INSERT and SELECT on %s, making it append only',
      async (table) => {
        // Pinned rather than merely checked for the absence of DELETE. If UPDATE or DELETE ever
        // appears here, application code can revise the ledger, and this line is the review.
        const result = await owner.query<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE grantee = $1 AND table_schema = 'public' AND table_name = $2`,
          [APP_ROLE, table],
        );

        expect(result.rows.map((row) => row.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
      },
    );
  });

  // -------------------------------------------------------------------------------------
  // The constraints a behavioural test reaches only one case of at a time.
  // -------------------------------------------------------------------------------------

  describe('the constraints on a line', () => {
    it('keeps an amount on exactly one side, and that side positive', async () => {
      const result = await owner.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname = 'journal_lines_one_side_check'`,
      );

      // The single constraint that refuses a zero line, a negative amount, and a line claiming
      // both sides at once. Read here so that weakening it to, say, a non-negativity check is a
      // visible change rather than three behavioural tests quietly passing for a new reason.
      expect(result.rows[0]?.definition).toBe(
        'CHECK ((((debit > (0)::numeric) AND (credit = (0)::numeric)) OR ((credit > (0)::numeric) AND (debit = (0)::numeric))))',
      );
    });

    it('pins a line to an account of its own company', async () => {
      const result = await owner.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname = 'journal_lines_account_fkey'`,
      );

      // Composite, and that is the point: a plain account_id key would accept any account in the
      // deployment and leave the company check to whichever caller remembered it.
      expect(result.rows[0]?.definition).toBe(
        'FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES accounts(tenant_id, company_id, id)',
      );
    });

    it('pins a posting account mapping to an account of its own company, the same way', async () => {
      const result = await owner.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname = 'company_posting_accounts_account_fkey'`,
      );

      expect(result.rows[0]?.definition).toBe(
        'FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES accounts(tenant_id, company_id, id)',
      );
    });
  });
});
