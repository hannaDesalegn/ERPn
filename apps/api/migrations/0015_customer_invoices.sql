-- 0015_customer_invoices
--
-- The customer invoice document and its lines. Schema only: nothing in this migration posts
-- anything, and nothing in it can. The posting transaction of section 12.2 is the next increment.
--
-- WHAT THE DOMAIN MODEL STATES, AND THIS KEEPS. `apps/web/src/domain/billing.ts` carries
-- `CustomerInvoice.salesOrderIds: ID[]` with the comment "Plural: one invoice can cover several
-- orders", and that is the semantic this schema preserves. An invoice is not a child of one
-- order.
--
-- HOW THAT RELATIONSHIP IS HELD, and why there is no junction table. Every invoice line names the
-- sales order line it bills, pinned by composite key, so the set of orders an invoice covers is
-- the distinct set of orders behind its lines. A junction table beside those lines would be a
-- second statement of the same fact, and section 12.4 is explicit about what goes wrong with a
-- stored graph: "A stored graph can drift from the facts, which is the second source of truth
-- problem this document forbids elsewhere." The link table 12.4 describes is the generic typed
-- relation between any two documents, which is a module of its own and is not this.
--
-- WHAT IS DELIBERATELY ABSENT, each for a stated reason:
--
--   paid_amount, balance_due  Section 9.2: balances are derived from the ledger, and no entity
--                             carries a stored balance treated as a source of truth. They are
--                             computed from payment allocations, which do not exist yet.
--   journal_entry_id          The journal entry already records what caused it, in
--                             `source_doc_type` and `source_doc_id` from 0014. A column here
--                             would point back along an edge that is already stored once.
--   posted_at, posted_by      Written by a posting transaction that does not exist. A column
--                             nobody writes is one a reader will eventually trust.
--   unit of measure           Section 8.4 as interpreted in section 18.2 on 2026-09-15: a
--                             product carries exactly one unit today, its stocking unit, and
--                             `sales_order_lines` holds no unit column for the same reason. When
--                             a second unit becomes possible, 8.4 requires the conversion factor
--                             on the line, and that is the migration that adds it here too.
--   due date from terms       `due_date` is stated rather than computed, because payment terms
--                             are not modelled on a customer. The column is nullable for that
--                             reason, exactly as `sales_orders.expected_delivery_date` is a
--                             caller stated date rather than a derived one.
--   account per line          The `accountCode` the domain model marks optional. Section 2.9 and
--                             migration 0013 hold the posting accounts per company, which is
--                             where the posting transaction reads them from.

-- ---------------------------------------------------------------------------------------
-- KEYS THE OWNING RELATIONSHIPS NEED
--
-- `sales_orders` has no unique key naming its scope, so nothing could point at an order and be
-- pinned to that order's company. Additive, and here so the foreign keys below can be written at
-- all. `sales_order_lines` already gained the same key in 0009.
--
-- The second key is the superkey trick 0005 used to pin a line to its order's currency and 0009
-- used to pin a reservation to its line's product: a referencing row must agree about a second
-- column rather than merely pointing at a row that exists. Here it makes an invoice line name
-- both a sales order line and the order that line belongs to, and be refused if the two disagree.
-- ---------------------------------------------------------------------------------------

ALTER TABLE sales_order_lines
    ADD CONSTRAINT sales_order_lines_id_order_key UNIQUE (id, sales_order_id);

-- ---------------------------------------------------------------------------------------
-- CUSTOMER INVOICES
--
-- THE STATUS UNION IS TWO VALUES, and the shortness is the decision. Section 12.1 gives each
-- document type its own union and requires the legal moves in an explicit transition table. The
-- domain model lists `partially_paid`, `paid` and `overdue` beside `draft` and `posted`, and all
-- three of those are conclusions rather than states somebody moves a document into: paid follows
-- from the payment allocations against it, overdue follows from the due date and the clock.
-- Section 9.2 forbids storing a derived balance as a source of truth, and a status column holding
-- the same conclusion is that column wearing a different name. `cancelled` is absent for a
-- different reason: section 12.3 requires a cancellation rule per document type, and the invoice
-- has none. It leaves cancelling a posted document to the accounting slice as a `[FUT]`, and says
-- nothing about a draft. A value the rule has not been written for would be a rule invented here.
--
-- Each of those is a migration when the module that performs it arrives, which is the same
-- posture 0009 took for `stock_reservations`: a grant is easy to add and awkward to take back.
--
-- THE NUMBER IS NULL UNTIL POSTING, AND THE DATABASE IS WHAT SAYS SO. Section 10.4 allocates
-- inside the posting transaction from the counter 0005 created and the company provisioning of
-- this slice seeded. The constraint below means a draft cannot carry a number even if some later
-- code allocated one by mistake, and a posted invoice cannot exist without one.
-- ---------------------------------------------------------------------------------------

CREATE TABLE customer_invoices (
    id            uuid          PRIMARY KEY,
    tenant_id     uuid          NOT NULL,
    company_id    uuid          NOT NULL,

    -- Allocated by the posting transaction, per section 10.4. Null while the invoice is a draft.
    doc_number    text,
    status        text          NOT NULL DEFAULT 'draft',

    -- Who is being billed. One party per invoice: an invoice is a demand for payment addressed
    -- to somebody, and the orders behind it must therefore agree about who that is.
    customer_id   uuid          NOT NULL,

    -- The tax point and the accounting date. The caller's to state, like an order date.
    invoice_date  date          NOT NULL,
    -- Null until payment terms exist to derive it from. See the note at the top of this file.
    due_date      date,

    currency      char(3)       NOT NULL,
    subtotal      numeric(19,4) NOT NULL DEFAULT 0,
    tax_total     numeric(19,4) NOT NULL DEFAULT 0,
    total         numeric(19,4) NOT NULL DEFAULT 0,

    created_at    timestamptz   NOT NULL DEFAULT now(),
    created_by    uuid,
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    updated_by    uuid,
    -- Mutable while it is a draft, so section 10.1's optimistic locking applies.
    version       integer       NOT NULL DEFAULT 1,

    CONSTRAINT customer_invoices_status_check CHECK (status IN ('draft', 'posted')),
    -- A draft has no number and a posted invoice must have one. Stated as a constraint so that
    -- draft creation cannot allocate one and posting cannot forget to.
    CONSTRAINT customer_invoices_draft_has_no_number_check CHECK (
        (status = 'draft' AND doc_number IS NULL)
        OR (status = 'posted' AND doc_number IS NOT NULL)
    ),
    CONSTRAINT customer_invoices_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    -- An invoice cannot fall due before it is raised.
    CONSTRAINT customer_invoices_due_date_check CHECK (due_date IS NULL OR due_date >= invoice_date),

    CONSTRAINT customer_invoices_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    -- The customer, pinned to this company. Another company's customer is unrepresentable here
    -- rather than merely refused by whichever caller remembered to check.
    CONSTRAINT customer_invoices_customer_fkey
        FOREIGN KEY (tenant_id, company_id, customer_id)
        REFERENCES customers (tenant_id, company_id, id),
    -- Referenced by the lines, so a line cannot be attached to an invoice in another tenant or
    -- another company.
    CONSTRAINT customer_invoices_tenant_company_id_key UNIQUE (tenant_id, company_id, id),
    -- Referenced together with the currency, so a line cannot carry a currency the invoice does
    -- not, in the shape 0005 established for a sales order.
    CONSTRAINT customer_invoices_id_currency_key UNIQUE (id, currency)
);

-- A number is unique within the company that issued it, not globally, exactly as a sales order
-- number is: two customers of this product may both have an INV-0001 and neither is wrong.
CREATE UNIQUE INDEX customer_invoices_company_doc_number_key
    ON customer_invoices (company_id, doc_number)
    WHERE doc_number IS NOT NULL;

CREATE INDEX customer_invoices_tenant_company_idx ON customer_invoices (tenant_id, company_id);
CREATE INDEX customer_invoices_customer_idx ON customer_invoices (tenant_id, company_id, customer_id);
CREATE INDEX customer_invoices_status_idx
    ON customer_invoices (tenant_id, company_id, status, invoice_date DESC);

-- ---------------------------------------------------------------------------------------
-- CUSTOMER INVOICE LINES
--
-- WHAT EACH LINE SNAPSHOTS, and where each figure comes from. Section 3.4 makes a document an
-- immutable record of a past agreement, and section 3.3 makes every monetary figure the server's
-- to compute rather than the caller's to send:
--
--   product_sku, product_name   the sales order line, which already snapshotted them when the
--                               order was raised. Renaming the catalogue afterwards must not
--                               change what either document says.
--   unit_price, discount        the sales order line. What the customer owes is what they agreed
--                               to, so an invoice bills the agreed price rather than today's
--                               list price. This is the one place the source is the document
--                               rather than master data, and it follows from 3.4 rather than
--                               from convenience.
--   tax_rate_percent           `tax/tax-rate.ts`, the single resolver section 2.9 requires every
--                               document line to go through. Section 2.9 also makes the rate on
--                               a draft a working figure recomputed when the document is
--                               committed, which is the posting transaction's step one.
--   quantity                    the caller, bounded by what the source line has left uninvoiced.
--   the three money columns     computed here from the above, never sent.
--
-- SOURCE IDENTITY IS TWO COLUMNS AND IT IS NOT REDUNDANT. The line is what carries the
-- relationship to the order, so the order is named beside the line and the composite key below
-- refuses a pair that disagrees. It is the same denormalisation `stock_reservations` makes for
-- the product and warehouse of its line, and for the same reason: the query that asks which
-- orders an invoice covers should not have to join through a document to find out.
--
-- NO `version`. Section 4.2's first exempt shape, insert and delete only: editing a draft
-- replaces its lines, as editing a sales order draft does, and nothing ever updates one in place.
-- The quantities on a sales order line are updated, which is why that table carries a version and
-- this one does not.
-- ---------------------------------------------------------------------------------------

CREATE TABLE customer_invoice_lines (
    id                       uuid          PRIMARY KEY,
    tenant_id                uuid          NOT NULL,
    company_id               uuid          NOT NULL,
    customer_invoice_id      uuid          NOT NULL,

    -- Ordering on the printed document, stable under edits to other lines.
    line_number              integer       NOT NULL,

    -- What this line bills. Both NOT NULL: every line of an invoice raised from sales orders has
    -- a source, and a line with none would be a manual charge, which is a later decision rather
    -- than a nullable column waiting for one.
    source_sales_order_id      uuid        NOT NULL,
    source_sales_order_line_id uuid        NOT NULL,

    product_id               uuid          NOT NULL,
    product_sku              text          NOT NULL,
    product_name             text          NOT NULL,

    quantity                 numeric(19,6) NOT NULL,
    unit_price               numeric(19,6) NOT NULL,
    discount_percent         numeric(9,6)  NOT NULL DEFAULT 0,
    tax_rate_percent         numeric(9,6)  NOT NULL DEFAULT 0,

    currency                 char(3)       NOT NULL,
    line_subtotal            numeric(19,4) NOT NULL DEFAULT 0,
    line_tax                 numeric(19,4) NOT NULL DEFAULT 0,
    line_total               numeric(19,4) NOT NULL DEFAULT 0,

    created_at               timestamptz   NOT NULL DEFAULT now(),
    created_by               uuid,
    updated_at               timestamptz   NOT NULL DEFAULT now(),
    updated_by               uuid,

    CONSTRAINT customer_invoice_lines_quantity_check CHECK (quantity > 0),
    CONSTRAINT customer_invoice_lines_unit_price_check CHECK (unit_price >= 0),
    CONSTRAINT customer_invoice_lines_discount_check
        CHECK (discount_percent >= 0 AND discount_percent <= 100),
    CONSTRAINT customer_invoice_lines_tax_rate_check CHECK (tax_rate_percent >= 0),
    CONSTRAINT customer_invoice_lines_line_number_check CHECK (line_number > 0),

    CONSTRAINT customer_invoice_lines_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    -- The composite parent key. A line belongs to an invoice in its own tenant and company, and
    -- there is no combination of values that says otherwise.
    CONSTRAINT customer_invoice_lines_invoice_fkey
        FOREIGN KEY (tenant_id, company_id, customer_invoice_id)
        REFERENCES customer_invoices (tenant_id, company_id, id),
    -- And it carries its invoice's currency, enforced against the invoice rather than in
    -- application code, so a mixed currency document cannot exist even briefly.
    CONSTRAINT customer_invoice_lines_currency_fkey
        FOREIGN KEY (customer_invoice_id, currency)
        REFERENCES customer_invoices (id, currency),

    -- The source order and the source line, each pinned to this company.
    CONSTRAINT customer_invoice_lines_source_order_fkey
        FOREIGN KEY (tenant_id, company_id, source_sales_order_id)
        REFERENCES sales_orders (tenant_id, company_id, id),
    CONSTRAINT customer_invoice_lines_source_line_fkey
        FOREIGN KEY (tenant_id, company_id, source_sales_order_line_id)
        REFERENCES sales_order_lines (tenant_id, company_id, id),
    -- And the two must agree: the source line must belong to the source order. Without this a
    -- line could name one order and bill a line of another, and both keys above would be
    -- satisfied because each row individually exists.
    CONSTRAINT customer_invoice_lines_source_pair_fkey
        FOREIGN KEY (source_sales_order_line_id, source_sales_order_id)
        REFERENCES sales_order_lines (id, sales_order_id),
    -- The product must be the one the source line sells. Same reasoning as the pair above, and
    -- the same key `stock_reservations` uses to stop a reservation holding the wrong product.
    CONSTRAINT customer_invoice_lines_source_product_fkey
        FOREIGN KEY (source_sales_order_line_id, product_id)
        REFERENCES sales_order_lines (id, product_id),

    CONSTRAINT customer_invoice_lines_invoice_line_number_key
        UNIQUE (customer_invoice_id, line_number),
    -- One line per source line per invoice. Two lines billing the same order line on one
    -- invoice would be two figures for one obligation, and the caller meant one line with the
    -- sum of the quantities.
    CONSTRAINT customer_invoice_lines_invoice_source_line_key
        UNIQUE (customer_invoice_id, source_sales_order_line_id)
);

CREATE INDEX customer_invoice_lines_tenant_company_idx
    ON customer_invoice_lines (tenant_id, company_id);
CREATE INDEX customer_invoice_lines_invoice_idx
    ON customer_invoice_lines (customer_invoice_id, line_number);
-- The index the relationship is read through: every invoice line billing one order, which is
-- what answers "which invoices cover this order" without a junction table.
CREATE INDEX customer_invoice_lines_source_order_idx
    ON customer_invoice_lines (tenant_id, company_id, source_sales_order_id);
CREATE INDEX customer_invoice_lines_source_line_idx
    ON customer_invoice_lines (source_sales_order_line_id);

-- ---------------------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- The second of the two layers section 2.4 requires, on the same terms as every tenant scoped
-- table before these. FORCE matters as much as ENABLE, because the migration role owns them.
-- ---------------------------------------------------------------------------------------

ALTER TABLE customer_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_invoices_tenant_company_isolation ON customer_invoices
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

ALTER TABLE customer_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_invoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_invoice_lines_tenant_company_isolation ON customer_invoice_lines
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

-- ---------------------------------------------------------------------------------------
-- GRANTS
--
-- The shape 0005 gives the sales order and its lines, for the same reasons:
--
--   no DELETE on customer_invoices        Section 4.5: business documents are cancelled,
--                                         reversed or archived, never hard deleted. 4.5 permits
--                                         deleting a draft that was never posted; that grant is
--                                         withheld until something needs it, because a grant is
--                                         easy to add and awkward to take back, and because
--                                         section 12.3 has not ruled what abandoning an invoice
--                                         draft means.
--   DELETE on the lines                   A draft is editable under section 12.2, and replacing
--                                         its lines is ordinary editing rather than deleting a
--                                         document.
--   no UPDATE on the lines                And this one is the reason the table carries no
--                                         `version`. Editing a draft replaces its lines rather
--                                         than amending one in place, so section 4.2's first
--                                         exempt shape applies, insert and delete only. Granting
--                                         UPDATE would leave a table that claims the exemption
--                                         and can be edited anyway, which is the mismatch the
--                                         exemption rule exists to prevent. `sales_order_lines`
--                                         does hold UPDATE, because deliveries and invoices
--                                         raised against an order amend its quantities; nothing
--                                         is ever raised against an invoice line.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
    app_role text := current_setting('app.provision_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        RAISE EXCEPTION 'app.provision_role must be set to the application role name before running this migration';
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON customer_invoices TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON customer_invoice_lines TO %I', app_role);
END
$$;
