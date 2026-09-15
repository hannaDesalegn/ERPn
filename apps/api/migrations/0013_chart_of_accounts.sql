-- 0013_chart_of_accounts
--
-- The accounts a company posts to, the mapping that says which account a posting uses, and the
-- tax registration numbers an invoice has to print. Schema only: nothing here posts anything.
--
-- WHY NOW, AND WHY ONLY THIS MUCH. Section 17.5 makes the first slice 3 capability the posting
-- of a customer invoice into the value ledger, and section 18.2 as amended on 2026-09-15 says
-- that posting writes receivables, revenue and tax and nothing else. Three accounts, therefore,
-- and a way to say which is which. Section 2.9 already lists both halves as company
-- configuration: "chart of accounts, and the accounts that document postings map to".
--
-- WHAT IS DELIBERATELY ABSENT, because the narrowest thing that satisfies the contract is the
-- thing to build:
--
--   parent_id, postable   A hierarchy exists so reports can subtotal, and nothing reports yet.
--                         A `postable` flag without a hierarchy marks nothing, because every
--                         account in the seeded chart is a leaf.
--   normal_balance        Determined entirely by `type`: assets and expenses increase on the
--                         debit side, everything else on the credit side. Storing it would be a
--                         second source of truth for a function of a column already here.
--   currency              Section 9.7 wants every amount in transaction and company currency
--                         both, which is a posting concern rather than an account attribute, and
--                         multi-currency is not exercised anywhere yet. The entry and its lines
--                         carry the currency in 0014.
--   is_cash_account       A dashboard's question. Nothing here answers it.
--   opening balance       Section 9.3: an opening balance is a posted journal entry like any
--                         other, never a column.
--   accounting periods    Ruled out of this increment by section 18.2 on 2026-09-15, and
--                         section 16.2 forbids a simulation of one, so there is nothing here
--                         that half implements a period.

-- ---------------------------------------------------------------------------------------
-- ACCOUNTS
--
-- Company scoped, like every other piece of master data in 0006, and for the reason 0006 gives:
-- section 2.2 makes a shared catalogue across the companies of a tenant a `[FUT]`, so an account
-- belongs to exactly one company and a posting cannot reach across.
--
-- `type` IS A CHECK CONSTRAINT, unlike `doc_type` and the permission catalogue, which are lists
-- in code. The difference is that those two are vocabularies this product invents and extends;
-- the five account types are double entry itself. Assets, liabilities, equity, revenue and
-- expenses are the accounting equation, and a sixth would not be a new configuration option but
-- a different system.
--
-- MUTABLE, SO VERSIONED. A chart is edited: accounts are renamed and retired. Section 4.2's main
-- rule applies and none of the four exempt shapes does. Retiring is `status = 'archived'` under
-- section 4.5, never a delete, and the grants below withhold DELETE to keep it that way.
-- ---------------------------------------------------------------------------------------

CREATE TABLE accounts (
    id          uuid        PRIMARY KEY,
    tenant_id   uuid        NOT NULL,
    company_id  uuid        NOT NULL,

    -- The number a bookkeeper uses. Unique within the company that owns the chart, never
    -- globally: two companies both numbering receivables 1200 is the normal case.
    code        text        NOT NULL,
    name        text        NOT NULL,
    type        text        NOT NULL,
    status      text        NOT NULL DEFAULT 'active',

    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid,
    version     integer     NOT NULL DEFAULT 1,

    -- The accounting equation, closed. See the note above on why this is a constraint rather
    -- than a catalogue in code.
    CONSTRAINT accounts_type_check
        CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
    CONSTRAINT accounts_status_check CHECK (status IN ('active', 'archived')),
    -- Trimmed and non empty, both. A code of spaces would be a second way to say "no code", and
    -- a padded one would compare unequal to the same code typed without the padding.
    CONSTRAINT accounts_code_check
        CHECK (code = btrim(code) AND length(code) BETWEEN 1 AND 32),
    CONSTRAINT accounts_name_check
        CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 200),

    CONSTRAINT accounts_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    CONSTRAINT accounts_company_code_key UNIQUE (company_id, code),
    -- Names are unique as well, which the code alone does not give. An account is chosen by
    -- name on every screen that posts, and two accounts called Sales Revenue make the choice
    -- unanswerable and the ledger unreadable afterwards.
    CONSTRAINT accounts_company_name_key UNIQUE (company_id, name),
    -- The target of the composite key on the mapping below and on journal lines in 0014.
    -- Redundant for uniqueness, and required so a referencing row must name the same tenant and
    -- the same company. The pattern 0001 established for companies and roles.
    CONSTRAINT accounts_tenant_company_id_key UNIQUE (tenant_id, company_id, id)
);

CREATE INDEX accounts_tenant_company_idx ON accounts (tenant_id, company_id);
CREATE INDEX accounts_type_idx ON accounts (tenant_id, company_id, type, code);

-- ---------------------------------------------------------------------------------------
-- COMPANY POSTING ACCOUNTS
--
-- "The accounts that document postings map to", from section 2.9's list of what a company
-- configures. One row per purpose, the purpose named by a string the code validates.
--
-- WHY A TABLE AND NOT COLUMNS ON `companies`. A column per purpose is a migration per purpose,
-- and the purposes are a list that grows with every module: payables, inventory, cost of goods
-- sold, the two interim accounts section 9.4 requires, bank, rounding, exchange difference. The
-- shape that already exists here for exactly this problem is `document_number_sequences`: per
-- company, keyed by a string, one row per key, with the vocabulary held in code per section 2.7.
-- This is that shape, deliberately, rather than a new abstraction.
--
-- WHY THE ACCOUNT KEY IS COMPOSITE. `(tenant_id, company_id, account_id)` against the unique key
-- above is what makes a mapping to another company's account unrepresentable rather than merely
-- refused. A plain `account_id` foreign key would accept any account in the deployment and leave
-- the company check to whichever caller remembered it, which section 6.3 rejects by name.
-- ---------------------------------------------------------------------------------------

CREATE TABLE company_posting_accounts (
    id          uuid        PRIMARY KEY,
    tenant_id   uuid        NOT NULL,
    company_id  uuid        NOT NULL,

    -- What this account is used for, for example 'accounts_receivable'. Validated against a
    -- catalogue in code, per the pattern section 2.7 set for permissions: a seeded table with a
    -- foreign key would be a second source of truth for something the code already defines.
    purpose     text        NOT NULL,
    account_id  uuid        NOT NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid,
    -- Mutable: remapping revenue to a different account is ordinary configuration under section
    -- 2.9, and two administrators doing it at once is the lost update section 10.1 prevents.
    version     integer     NOT NULL DEFAULT 1,

    CONSTRAINT company_posting_accounts_purpose_check
        CHECK (purpose ~ '^[a-z][a-z0-9_]{1,62}$'),
    CONSTRAINT company_posting_accounts_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    -- See the note above. This is the constraint that forbids a cross-company mapping.
    CONSTRAINT company_posting_accounts_account_fkey
        FOREIGN KEY (tenant_id, company_id, account_id)
        REFERENCES accounts (tenant_id, company_id, id),
    -- One account per purpose per company. Two rows for 'revenue' would make the account a
    -- posting picks depend on which row it read first.
    CONSTRAINT company_posting_accounts_company_purpose_key UNIQUE (company_id, purpose)
);

CREATE INDEX company_posting_accounts_tenant_company_idx
    ON company_posting_accounts (tenant_id, company_id);
CREATE INDEX company_posting_accounts_account_idx
    ON company_posting_accounts (tenant_id, company_id, account_id);

-- ---------------------------------------------------------------------------------------
-- TAX REGISTRATION NUMBERS
--
-- Section 2.9: "Tax registration numbers on the company and on each party already exist in the
-- domain model and are not yet persisted. They are required on a legally valid invoice and
-- arrive with invoice posting rather than here." This is that arrival, one column each.
--
-- NULLABLE, DELIBERATELY. Not every company is registered for a turnover tax, and not every
-- customer has a number to quote. Null says exactly that. What is refused is the third state: an
-- empty or padded string that means the same thing while comparing unequal to it.
--
-- NO FORMAT CHECK BEYOND THAT, ALSO DELIBERATELY. Registration numbers differ by jurisdiction in
-- length, in alphabet and in check digit rule. A pattern here would encode one country's rule
-- for every tenant, which is the invention section 9.7 defers when it puts jurisdictions in the
-- future. Validating a specific country's format belongs with the tax engine that knows which
-- country applies.
-- ---------------------------------------------------------------------------------------

ALTER TABLE companies ADD COLUMN tax_registration_number text;

ALTER TABLE companies
    ADD CONSTRAINT companies_tax_registration_number_check CHECK (
        tax_registration_number IS NULL
        OR (
            tax_registration_number = btrim(tax_registration_number)
            AND length(tax_registration_number) BETWEEN 1 AND 64
        )
    );

COMMENT ON COLUMN companies.tax_registration_number IS
    'The company tax registration number printed on an invoice, per section 2.9. Null when the company is not registered.';

ALTER TABLE customers ADD COLUMN tax_registration_number text;

ALTER TABLE customers
    ADD CONSTRAINT customers_tax_registration_number_check CHECK (
        tax_registration_number IS NULL
        OR (
            tax_registration_number = btrim(tax_registration_number)
            AND length(tax_registration_number) BETWEEN 1 AND 64
        )
    );

COMMENT ON COLUMN customers.tax_registration_number IS
    'The customer tax registration number printed on an invoice raised for them, per section 2.9. Null when they have none.';

-- ---------------------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- The second of the two layers section 2.4 requires, on the same terms as every tenant scoped
-- table before these. Tenant and company both: an account belongs to one company and nothing
-- reads a chart across the companies of a tenant.
--
-- FORCE matters as much as ENABLE, because the migration role owns these tables and would
-- otherwise be exempt from their policies.
-- ---------------------------------------------------------------------------------------

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY accounts_tenant_company_isolation ON accounts
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

ALTER TABLE company_posting_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_posting_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY company_posting_accounts_tenant_company_isolation ON company_posting_accounts
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

-- ---------------------------------------------------------------------------------------
-- GRANTS
--
-- Explicit per table, contract section 7.1. Neither table gets DELETE:
--
--   accounts                   Section 4.5. An account that has been posted to is part of the
--                              ledger's meaning, so a chart is tidied by archiving. Deleting one
--                              would orphan history that section 9.1 makes permanent.
--   company_posting_accounts   Removing a mapping does not correct it; it leaves the company
--                              unable to post with nothing saying why. A wrong mapping is
--                              repointed, which is an UPDATE.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
    app_role text := current_setting('app.provision_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        RAISE EXCEPTION 'app.provision_role must be set to the application role name before running this migration';
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON accounts TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON company_posting_accounts TO %I', app_role);
END
$$;
