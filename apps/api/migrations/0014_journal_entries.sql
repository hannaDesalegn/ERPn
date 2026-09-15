-- 0014_journal_entries
--
-- The value ledger. One balanced entry, its lines, and the database making the balance true
-- rather than the application promising it.
--
-- SECTION 4.1 NAMES THE MECHANISM, and this migration exists to obey it literally: "A journal
-- entry's debits equal its credits | deferred constraint or trigger, evaluated per entry at
-- commit". Evaluated per entry at commit is the operative phrase. No row-level CHECK can express
-- it, because the invariant is a property of a set of rows that does not hold while the set is
-- half inserted: after the first line of a two line entry, debits and credits differ, and they
-- are supposed to. A deferred constraint trigger is the one shape that waits until the
-- transaction is complete and then judges the whole entry.
--
-- SECTION 9.1 IS THE OTHER HALF. A posted entry is never edited or deleted, and corrections are
-- reversing entries. That is enforced twice below: the application role is granted only SELECT
-- and INSERT, which is the mechanism section 7.1 established for the audit table, and a trigger
-- refuses UPDATE and DELETE outright, which binds the owning role too.
--
-- WHY THERE IS NO `status` COLUMN. Section 9.1 makes an entry immutable from the moment it is
-- written, so the draft state a document has belongs to the document, not to its ledger effect:
-- a draft sales order posts nothing at all. `reversed` is not a state either, because marking
-- the original would be editing it; a reversal is a second entry that points at the first, and
-- that pointer belongs to the increment that implements reversal.
--
-- WHAT IS DELIBERATELY ABSENT:
--
--   doc_number        Section 18.2 as amended 2026-09-15 scopes this package to the customer
--                     invoice sequence. A number column with no allocator is a column nobody
--                     writes, and section 10.4 makes numbering a per document type decision
--                     rather than a thing to assume here.
--   party on a line   What breaks a receivables control account down per customer. Section 9.5
--                     reconciles it against open invoice balances instead, which is the
--                     subsidiary ledger the invoice table will be.
--   period            Ruled out of this increment by section 18.2 on 2026-09-15. Section 16.2
--                     forbids simulating one, so there is no column pretending to hold it.
--   cost of goods     Section 18.2, same ruling: invoice posting writes receivables, revenue and
--                     tax and nothing else. Quantity and cost belong to the delivery and costing
--                     path.

-- ---------------------------------------------------------------------------------------
-- JOURNAL ENTRIES
--
-- Append only, so no `version`, under section 4.2's second exempt shape. `updated_at` and
-- `updated_by` exist because 4.2 lists them and stay equal to their created counterparts for the
-- life of the row, which is the convention `stock_movements` already set in 0008.
-- ---------------------------------------------------------------------------------------

CREATE TABLE journal_entries (
    id              uuid        PRIMARY KEY,
    tenant_id       uuid        NOT NULL,
    company_id      uuid        NOT NULL,

    -- The accounting date, which is not always the date the row was written: an invoice raised
    -- on the first of the month for work in the previous one posts to the date it is dated.
    entry_date      date        NOT NULL,
    -- The human label, for example 'Customer invoice INV-0001'. Not a formatted display string
    -- of the lines, which section 7.2 refuses for the audit trail and the same reasoning covers
    -- here: rendering is a decision, and a permanent record should not freeze one.
    memo            text        NOT NULL,
    -- Section 4.3 stores a currency alongside every amount. Held on the entry and pinned onto
    -- every line by the composite key below, so one entry cannot mix currencies.
    currency        char(3)     NOT NULL,

    -- What caused this entry. The pattern `stock_movements` uses in 0008, including the absence
    -- of a foreign key: the document tables it will name do not exist yet.
    --
    -- Nullable here, unlike on a movement, because a manual adjustment entry has no source
    -- document and that is a legitimate entry an auditor scrutinises rather than an impossible
    -- one. Both halves or neither, so a half stated provenance cannot be recorded.
    source_doc_type text,
    source_doc_id   uuid,

    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid,

    -- The transaction that wrote the entry, defaulted by the database and never supplied by a
    -- caller, exactly as `audit_events.txid` is. Read by the trigger below, which refuses a line
    -- inserted by any later transaction: appending to a committed entry is an edit of it.
    created_txid    xid8        NOT NULL DEFAULT pg_current_xact_id(),

    CONSTRAINT journal_entries_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT journal_entries_memo_check
        CHECK (memo = btrim(memo) AND length(memo) BETWEEN 1 AND 500),
    CONSTRAINT journal_entries_source_doc_type_check
        CHECK (source_doc_type IS NULL OR source_doc_type ~ '^[a-z][a-z0-9_]{1,62}$'),
    CONSTRAINT journal_entries_source_check CHECK (
        (source_doc_type IS NULL AND source_doc_id IS NULL)
        OR (source_doc_type IS NOT NULL AND source_doc_id IS NOT NULL)
    ),

    CONSTRAINT journal_entries_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    -- Referenced by the lines, so a line cannot be attached to an entry in another tenant or
    -- another company. The composite key that makes the cross-tenant child unrepresentable.
    CONSTRAINT journal_entries_tenant_company_id_key UNIQUE (tenant_id, company_id, id),
    -- Referenced together with the currency, so a line cannot carry a currency its entry does
    -- not. Summing debits against credits across two currencies is not an invariant at all.
    CONSTRAINT journal_entries_id_currency_key UNIQUE (id, currency)
);

CREATE INDEX journal_entries_tenant_company_idx ON journal_entries (tenant_id, company_id);
CREATE INDEX journal_entries_date_idx ON journal_entries (tenant_id, company_id, entry_date DESC);
CREATE INDEX journal_entries_source_idx
    ON journal_entries (tenant_id, company_id, source_doc_type, source_doc_id);

-- ---------------------------------------------------------------------------------------
-- JOURNAL LINES
--
-- One side of the entry. Exactly one of debit and credit carries an amount, and it is positive.
--
-- WHY NOT ONE SIGNED COLUMN. A signed amount makes "debit 100" and "credit -100" two spellings
-- of the same fact, and a ledger that admits both has to normalise before it can sum. Two
-- columns with the constraint below leave one spelling per fact, which is what makes the balance
-- check a comparison rather than an interpretation.
--
-- WHY ZERO IS REFUSED ON BOTH SIDES. A line that moves nothing is not a fact, and a pair of them
-- would satisfy any balance check while saying nothing. Section 4.1 wants the invariant to mean
-- something, so the degenerate entry is refused at the line.
-- ---------------------------------------------------------------------------------------

CREATE TABLE journal_lines (
    id                uuid          PRIMARY KEY,
    tenant_id         uuid          NOT NULL,
    company_id        uuid          NOT NULL,
    journal_entry_id  uuid          NOT NULL,

    -- Ordering on the printed entry, and stable under the order the rows were inserted in.
    line_number       integer       NOT NULL,

    account_id        uuid          NOT NULL,

    -- Section 4.3: amounts at four decimal places, exact numeric, never floating point.
    debit             numeric(19,4) NOT NULL DEFAULT 0,
    credit            numeric(19,4) NOT NULL DEFAULT 0,
    currency          char(3)       NOT NULL,

    created_at        timestamptz   NOT NULL DEFAULT now(),
    created_by        uuid,
    updated_at        timestamptz   NOT NULL DEFAULT now(),
    updated_by        uuid,

    -- No `version`, section 4.2's second exempt shape, enforced by the grants below.

    CONSTRAINT journal_lines_line_number_check CHECK (line_number > 0),
    -- Exactly one side, and that side positive. This one constraint refuses a negative amount,
    -- a zero line, and a line that claims both sides at once.
    CONSTRAINT journal_lines_one_side_check CHECK (
        (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
    ),

    CONSTRAINT journal_lines_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    -- The composite parent key. A line belongs to an entry in its own tenant and company, and
    -- there is no combination of values that says otherwise.
    CONSTRAINT journal_lines_entry_fkey
        FOREIGN KEY (tenant_id, company_id, journal_entry_id)
        REFERENCES journal_entries (tenant_id, company_id, id),
    -- And it carries its entry's currency, enforced against the entry rather than in application
    -- code, so a mixed currency entry cannot exist even briefly.
    CONSTRAINT journal_lines_currency_fkey
        FOREIGN KEY (journal_entry_id, currency) REFERENCES journal_entries (id, currency),
    -- The account posted to, pinned to this line's own company. A line posting to another
    -- company's account is unrepresentable, not merely refused.
    CONSTRAINT journal_lines_account_fkey
        FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES accounts (tenant_id, company_id, id),
    CONSTRAINT journal_lines_entry_line_number_key UNIQUE (journal_entry_id, line_number)
);

CREATE INDEX journal_lines_tenant_company_idx ON journal_lines (tenant_id, company_id);
CREATE INDEX journal_lines_entry_idx ON journal_lines (journal_entry_id, line_number);
-- The index a ledger and a trial balance read: every line on one account, in date order.
CREATE INDEX journal_lines_account_idx ON journal_lines (tenant_id, company_id, account_id);

-- ---------------------------------------------------------------------------------------
-- THE BALANCE INVARIANT
--
-- Section 4.1, the first row of its table. A deferred constraint trigger, evaluated per entry at
-- commit.
--
-- HOW IT BEHAVES, precisely, because the timing is the whole design:
--
--   1. A transaction inserts an entry and its lines in any order. Nothing is judged yet.
--   2. At COMMIT, PostgreSQL fires the deferred triggers. Each one re-reads the whole entry and
--      compares the two sums.
--   3. An unbalanced entry raises here, and the raise is inside the commit, so the entire
--      transaction rolls back. There is no moment at which an unbalanced entry is visible to
--      another session, and no way to leave one behind.
--
-- TWO TRIGGERS, FOR TWO DIFFERENT HOLES. The one on the lines catches an entry whose lines do
-- not agree. The one on the entry catches an entry with no lines at all, which the line trigger
-- cannot see because it never fires.
--
-- AT LEAST TWO LINES, NOT MERELY EQUAL SUMS. Double entry means a transaction recorded in at
-- least two places. A single line cannot satisfy the line constraint above and balance at the
-- same time, so this is belt and braces, and it states the rule in the error message where
-- someone will read it.
--
-- WHY THE FUNCTION IS NOT `SECURITY DEFINER`. It would run as the table owner, and these tables
-- carry FORCE ROW LEVEL SECURITY, so the owner is subject to the policies with no context set:
-- the sum would see zero rows, find zero equal to zero, and pass every unbalanced entry ever
-- written. Running as the invoker, inside the transaction that is committing, the context is
-- still set and the entry's own lines are exactly what it sees.
-- ---------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION journal_entry_must_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    entry_id     uuid;
    line_count   integer;
    debit_total  numeric(19,4);
    credit_total numeric(19,4);
BEGIN
    IF TG_TABLE_NAME = 'journal_entries' THEN
        entry_id := NEW.id;
    ELSE
        entry_id := NEW.journal_entry_id;
    END IF;

    SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
      INTO line_count, debit_total, credit_total
      FROM journal_lines
     WHERE journal_entry_id = entry_id;

    IF line_count < 2 THEN
        RAISE EXCEPTION
            'Journal entry % has % line(s). Double entry records a transaction in at least two places.',
            entry_id, line_count
            USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_must_balance';
    END IF;

    IF debit_total <> credit_total THEN
        RAISE EXCEPTION
            'Journal entry % is unbalanced: debits %, credits %.',
            entry_id, debit_total, credit_total
            USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_must_balance';
    END IF;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION journal_entry_must_balance() IS
    'Contract section 4.1: a journal entry''s debits equal its credits, evaluated per entry at commit. Deliberately not SECURITY DEFINER, because FORCE row level security would hide the lines from the owner and make every entry appear balanced.';

CREATE CONSTRAINT TRIGGER journal_entry_must_balance
    AFTER INSERT ON journal_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION journal_entry_must_balance();

CREATE CONSTRAINT TRIGGER journal_lines_must_balance_their_entry
    AFTER INSERT ON journal_lines
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION journal_entry_must_balance();

-- ---------------------------------------------------------------------------------------
-- IMMUTABILITY
--
-- Section 9.1: a posted entry is never edited or deleted. Section 4.1 accepts either a trigger
-- or revoked grants; this migration uses both, because they bind different people. The grants
-- stop the application, which is what section 7.1 does for the audit table. The triggers stop
-- anyone at a database prompt holding the owning role, which is precisely the bypass section 4.1
-- opens with: "Application code can be bypassed by a migration script, a maintenance task, a
-- background job or an administrator at a database prompt."
--
-- TRUNCATE IS NOT GUARDED, and that is a decision rather than an oversight. Truncating requires
-- ownership, which the application role does not have and cannot be granted by anything here, so
-- a guard would bind only the owner. The owner is how a development database is reset between
-- test files, and taking that away would buy nothing an attacker does not already have by
-- holding the owning role.
--
-- APPENDING TO A COMMITTED ENTRY IS AN EDIT, which the two triggers above do not catch on their
-- own: a later transaction could add a balanced pair of lines to yesterday's entry and every sum
-- would still agree. `journal_lines_belong_to_their_own_transaction` closes that by refusing a
-- line whose entry was written by a different transaction. An entry's line set is therefore
-- fixed at the moment it is written, which is what immutability has to mean for a parent row.
-- ---------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION journal_is_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION
        'The ledger is append only: % on % is refused. Section 9.1 corrects a posted entry with a reversing entry.',
        TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION journal_is_append_only() IS
    'Contract sections 9.1 and 4.1: posted journal entries are never updated or deleted. Binds the owning role as well as the application role, which the grants alone cannot.';

CREATE TRIGGER journal_entries_append_only
    BEFORE UPDATE OR DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION journal_is_append_only();

CREATE TRIGGER journal_lines_append_only
    BEFORE UPDATE OR DELETE ON journal_lines
    FOR EACH ROW EXECUTE FUNCTION journal_is_append_only();

CREATE OR REPLACE FUNCTION journal_lines_belong_to_their_own_transaction() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    entry_txid xid8;
BEGIN
    SELECT created_txid INTO entry_txid
      FROM journal_entries
     WHERE id = NEW.journal_entry_id;

    IF entry_txid IS DISTINCT FROM pg_current_xact_id() THEN
        RAISE EXCEPTION
            'Journal entry % was written by another transaction. A line cannot be added to an entry that already exists.',
            NEW.journal_entry_id
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER journal_lines_belong_to_their_own_transaction
    BEFORE INSERT ON journal_lines
    FOR EACH ROW EXECUTE FUNCTION journal_lines_belong_to_their_own_transaction();

-- ---------------------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- The second of the two layers section 2.4 requires. Tenant and company both: an entry belongs
-- to one company's books and nothing reads a ledger across the companies of a tenant.
-- ---------------------------------------------------------------------------------------

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY journal_entries_tenant_company_isolation ON journal_entries
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY journal_lines_tenant_company_isolation ON journal_lines
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

-- ---------------------------------------------------------------------------------------
-- GRANTS
--
-- SELECT and INSERT, nothing else, on both tables. The same grant shape section 7.1 gives the
-- audit table and 0008 gives the stock ledger, and for the same reason: an append only guarantee
-- is a grant rather than a convention.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
    app_role text := current_setting('app.provision_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        RAISE EXCEPTION 'app.provision_role must be set to the application role name before running this migration';
    END IF;

    EXECUTE format('GRANT SELECT, INSERT ON journal_entries TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT ON journal_lines TO %I', app_role);
END
$$;
