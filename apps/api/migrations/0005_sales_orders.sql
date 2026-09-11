-- 0005_sales_orders
--
-- The first business documents, and the numbering they will eventually draw from. Schema only:
-- nothing in this migration creates, confirms or numbers anything. Section 17.5 lists the
-- mechanisms slice 2 must exercise, and every one of them needs tables that did not exist.
--
-- THE SHAPE FOLLOWS THE DOMAIN MODEL, which `apps/web/src/domain/sales.ts` already states and
-- which CLAUDE.md calls the business specification. A sales order is a promise: it affects
-- nothing financially and reserves stock. Delivery, invoice and payment are separate documents
-- for separate events, and are not in this migration.
--
-- WHAT IS DELIBERATELY NOT ENFORCED HERE, and the reason is worth stating plainly rather than
-- leaving to be noticed. `customer_id`, `warehouse_id` and `product_id` name master data whose
-- tables do not exist yet. They are real columns with real values and no foreign key, because
-- there is nothing to point at. Adding the constraints belongs to the migration that creates
-- those tables, and until then nothing can create an order anyway: there is no service, no
-- endpoint and no grant path that writes one outside a test. This is the single open decision
-- in this increment and it is reported rather than resolved here.
--
-- EVERYTHING ELSE IS ENFORCED. Tenant and company on every row, composite keys that make a line
-- belonging to another tenant's order unrepresentable, row level security enabled and forced,
-- explicit grants, and an empty context that denies.

-- ---------------------------------------------------------------------------------------
-- DOCUMENT NUMBERING
--
-- Contract section 10.4: sequences are configurable per company and per document type, and
-- gapless versus gap tolerant is a per sequence setting. The distinction is legal rather than
-- technical, which is why this is a counter row rather than a PostgreSQL sequence: a sequence
-- is lock free and leaves gaps when a transaction rolls back, and gapless numbering in many
-- jurisdictions cannot have gaps at all.
--
-- ONE ROW, TWO CONCURRENCY MODELS, AND BOTH ARE DELIBERATE.
--
--   `next_value` is allocated under an explicit row lock taken inside the transaction that
--   creates the document, per 10.4. That serialises allocation for one sequence, which is the
--   cost the contract accepts in exchange for gaplessness.
--
--   `prefix` and `gapless` are configuration an administrator edits, and edits are guarded by
--   `version` under the optimistic locking in section 10.1, like any other mutable business
--   table under section 4.2.
--
-- The two do not collide: a configuration edit and an allocation both touch the row, so the
-- lock serialises them, and `version` still catches two administrators editing at once. This
-- table therefore claims no exemption from 4.2 and carries `version` like the rest.
--
-- `doc_type` IS NOT A DATABASE ENUM. It follows the pattern section 2.7 established for
-- permissions: the catalogue is code, validated on write and checked at startup, because a
-- seeded table with a foreign key would be a second source of truth for something the code
-- already defines. The format check below is the only thing the database asserts about it.
-- ---------------------------------------------------------------------------------------

CREATE TABLE document_number_sequences (
    id             uuid        PRIMARY KEY,
    tenant_id      uuid        NOT NULL,
    company_id     uuid        NOT NULL,

    -- Which document type this sequence numbers, for example 'sales_order'.
    doc_type       text        NOT NULL,
    -- Printed before the number. Empty is legitimate for a plain counter.
    prefix         text        NOT NULL DEFAULT '',
    -- Section 10.4 makes this a per sequence setting rather than a global policy, because the
    -- requirement varies by country and by document type.
    gapless        boolean     NOT NULL DEFAULT true,
    -- The counter itself. Read and incremented under a row lock, never by a sequence.
    next_value     bigint      NOT NULL DEFAULT 1,

    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid,
    version        integer     NOT NULL DEFAULT 1,

    CONSTRAINT document_number_sequences_doc_type_check
        CHECK (doc_type ~ '^[a-z][a-z0-9_]{1,62}$'),
    -- A counter that could go backwards would reissue a number that is already on a document.
    CONSTRAINT document_number_sequences_next_value_check CHECK (next_value >= 1),
    CONSTRAINT document_number_sequences_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    -- One sequence per document type per company. Two would race each other into duplicates.
    CONSTRAINT document_number_sequences_company_doc_type_key UNIQUE (company_id, doc_type)
);

CREATE INDEX document_number_sequences_tenant_company_idx
    ON document_number_sequences (tenant_id, company_id);

-- ---------------------------------------------------------------------------------------
-- SALES ORDERS
--
-- Money is NUMERIC per section 4.3: amounts at four decimal places, unit prices at six,
-- currency stored alongside. Quantities are NUMERIC(19,6) per 4.4, because distribution sells
-- fractional kilograms and metres.
--
-- `doc_number` is NULL until the order is confirmed. Section 12.2 allocates the number as step
-- four of the confirming transaction, so a draft genuinely has none, and a placeholder would be
-- a number that later changes.
--
-- No delete grant and no soft delete flag. Section 4.5: documents are cancelled, never hard
-- deleted, and `cancelled` is one of the statuses below.
-- ---------------------------------------------------------------------------------------

CREATE TABLE sales_orders (
    id                      uuid          PRIMARY KEY,
    tenant_id               uuid          NOT NULL,
    company_id              uuid          NOT NULL,

    -- Allocated at confirmation, per section 12.2. Null while the order is a draft.
    doc_number              text,
    status                  text          NOT NULL DEFAULT 'draft',

    -- Master data references. No foreign key yet; see the note at the top of this file.
    customer_id             uuid          NOT NULL,
    warehouse_id            uuid          NOT NULL,
    -- The rep is a real user. That they are also a member of this company is a row scope rule
    -- under section 6.1 dimension two, enforced by the application rather than by this key,
    -- because `users` is global and carries no company.
    sales_rep_user_id       uuid          REFERENCES users (id),

    order_date              date          NOT NULL,
    expected_delivery_date  date,

    currency                char(3)       NOT NULL,
    subtotal                numeric(19,4) NOT NULL DEFAULT 0,
    tax_total               numeric(19,4) NOT NULL DEFAULT 0,
    total                   numeric(19,4) NOT NULL DEFAULT 0,

    created_at              timestamptz   NOT NULL DEFAULT now(),
    created_by              uuid,
    updated_at              timestamptz   NOT NULL DEFAULT now(),
    updated_by              uuid,
    version                 integer       NOT NULL DEFAULT 1,

    -- The status union from the domain model. Section 12.1: each document type has its own,
    -- and there is no global status enum.
    CONSTRAINT sales_orders_status_check CHECK (
        status IN ('draft', 'confirmed', 'partially_delivered', 'delivered', 'invoiced', 'cancelled')
    ),
    -- A draft has no number and a confirmed order must have one. Stated as a constraint so a
    -- confirmation that skipped allocation cannot commit.
    CONSTRAINT sales_orders_draft_has_no_number_check CHECK (
        (status = 'draft' AND doc_number IS NULL) OR (status <> 'draft' AND doc_number IS NOT NULL)
    ),
    CONSTRAINT sales_orders_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT sales_orders_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    -- Referenced by the lines, so a line cannot be attached to an order in another tenant or
    -- another company. This is the composite key that makes the cross-tenant child
    -- unrepresentable rather than merely unusual.
    CONSTRAINT sales_orders_tenant_company_id_key UNIQUE (tenant_id, company_id, id),
    -- Referenced by the lines together with the currency, so a line cannot carry a currency the
    -- order does not. Section 4.3 stores currency alongside every amount, and mixed currency
    -- lines on one document are the failure that makes cross-currency arithmetic guess a rate.
    CONSTRAINT sales_orders_id_currency_key UNIQUE (id, currency)
);

-- A number is unique within the company that issued it, not globally: two customers of this
-- product may both have an SO-0001 and neither is wrong.
CREATE UNIQUE INDEX sales_orders_company_doc_number_key
    ON sales_orders (company_id, doc_number)
    WHERE doc_number IS NOT NULL;

CREATE INDEX sales_orders_tenant_company_idx ON sales_orders (tenant_id, company_id);
CREATE INDEX sales_orders_customer_idx ON sales_orders (tenant_id, company_id, customer_id);
CREATE INDEX sales_orders_status_idx ON sales_orders (tenant_id, company_id, status, order_date DESC);

-- ---------------------------------------------------------------------------------------
-- SALES ORDER LINES
--
-- Mutable, and therefore versioned: `delivered_quantity` and `invoiced_quantity` are updated as
-- deliveries and invoices are raised against the order.
--
-- WHY THE PRODUCT NAME AND SKU ARE COPIED ONTO THE LINE. The domain model states it for price
-- and the same reasoning covers the rest: a document is an immutable record of a past
-- agreement. If the catalogue is renamed next month, this order must still show what the
-- customer actually agreed to.
-- ---------------------------------------------------------------------------------------

CREATE TABLE sales_order_lines (
    id                  uuid          PRIMARY KEY,
    tenant_id           uuid          NOT NULL,
    company_id          uuid          NOT NULL,
    sales_order_id      uuid          NOT NULL,

    -- Ordering on the printed document, and stable under edits to other lines.
    line_number         integer       NOT NULL,

    -- Master data reference. No foreign key yet; see the note at the top of this file.
    product_id          uuid          NOT NULL,
    -- Copied at order time, deliberately. See the note above.
    product_sku         text          NOT NULL,
    product_name        text          NOT NULL,

    quantity            numeric(19,6) NOT NULL,
    unit_price          numeric(19,6) NOT NULL,
    discount_percent    numeric(9,6)  NOT NULL DEFAULT 0,
    tax_rate_percent    numeric(9,6)  NOT NULL DEFAULT 0,

    currency            char(3)       NOT NULL,
    line_subtotal       numeric(19,4) NOT NULL DEFAULT 0,
    line_tax            numeric(19,4) NOT NULL DEFAULT 0,
    line_total          numeric(19,4) NOT NULL DEFAULT 0,

    -- How much of this line has shipped and been invoiced. Drives the partial states above.
    delivered_quantity  numeric(19,6) NOT NULL DEFAULT 0,
    invoiced_quantity   numeric(19,6) NOT NULL DEFAULT 0,

    created_at          timestamptz   NOT NULL DEFAULT now(),
    created_by          uuid,
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    updated_by          uuid,
    version             integer       NOT NULL DEFAULT 1,

    CONSTRAINT sales_order_lines_quantity_check CHECK (quantity > 0),
    CONSTRAINT sales_order_lines_unit_price_check CHECK (unit_price >= 0),
    CONSTRAINT sales_order_lines_discount_check CHECK (discount_percent >= 0 AND discount_percent <= 100),
    CONSTRAINT sales_order_lines_tax_rate_check CHECK (tax_rate_percent >= 0),
    CONSTRAINT sales_order_lines_delivered_check CHECK (delivered_quantity >= 0),
    CONSTRAINT sales_order_lines_invoiced_check CHECK (invoiced_quantity >= 0),
    CONSTRAINT sales_order_lines_line_number_check CHECK (line_number > 0),

    CONSTRAINT sales_order_lines_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    -- The composite parent key. A line can only belong to an order in its own tenant and its
    -- own company, and there is no combination of values that says otherwise.
    CONSTRAINT sales_order_lines_order_fkey
        FOREIGN KEY (tenant_id, company_id, sales_order_id)
        REFERENCES sales_orders (tenant_id, company_id, id),
    -- And it must carry its order's currency. Enforced against the order rather than checked in
    -- application code, so a mixed currency document cannot exist even briefly.
    CONSTRAINT sales_order_lines_currency_fkey
        FOREIGN KEY (sales_order_id, currency) REFERENCES sales_orders (id, currency),
    CONSTRAINT sales_order_lines_order_line_number_key UNIQUE (sales_order_id, line_number)
);

CREATE INDEX sales_order_lines_tenant_company_idx ON sales_order_lines (tenant_id, company_id);
CREATE INDEX sales_order_lines_order_idx ON sales_order_lines (sales_order_id, line_number);
CREATE INDEX sales_order_lines_product_idx ON sales_order_lines (tenant_id, company_id, product_id);

-- ---------------------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- The second of the two layers section 2.4 requires, on the same terms as every tenant scoped
-- table in 0001. Tenant and company both, because nothing needs to read a sales order across
-- the companies of a tenant: unlike `companies` and `memberships`, which company switching has
-- to read across, a document belongs to exactly one company.
--
-- FORCE matters as much as ENABLE. Without it the owning role is exempt from its own policies,
-- and the migration role owns every table here.
-- ---------------------------------------------------------------------------------------

ALTER TABLE document_number_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_number_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY document_number_sequences_tenant_company_isolation ON document_number_sequences
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_orders_tenant_company_isolation ON sales_orders
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

ALTER TABLE sales_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_order_lines_tenant_company_isolation ON sales_order_lines
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

-- ---------------------------------------------------------------------------------------
-- GRANTS
--
-- Explicit per table, contract section 7.1. Note what is absent:
--
--   no DELETE on sales_orders    Section 4.5: documents are cancelled, reversed or archived,
--                                never hard deleted. 4.5 does permit deleting a draft that was
--                                never confirmed; that grant is withheld until something needs
--                                it, because a grant is easy to add and awkward to justify
--                                taking back.
--   DELETE on sales_order_lines  A draft is editable under section 12.2, and removing a line
--                                from a draft is ordinary editing rather than deleting a
--                                document. Whether a line may be removed after confirmation is
--                                a state machine question, not a grant question.
--   no DELETE on the sequences   A counter that can be dropped and recreated is a counter that
--                                can be reset, which is how a gapless sequence reissues a
--                                number that is already printed on a document.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
    app_role text := current_setting('app.provision_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        RAISE EXCEPTION 'app.provision_role must be set to the application role name before running this migration';
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON document_number_sequences TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON sales_orders TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON sales_order_lines TO %I', app_role);
END
$$;
