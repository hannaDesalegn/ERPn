-- ---------------------------------------------------------------------------------------
-- STOCK RESERVATIONS
--
-- Contract section 8.5: available equals on hand minus reserved, a salesperson is shown
-- available rather than on hand, and confirming an order that would oversell fails inside the
-- transaction. This table is where reserved comes from.
--
-- RESERVATIONS ARE RECORDS, NOT A COUNTER, and that was a decision rather than a convention.
-- Section 8.2 defines the balance as a maintained aggregate the rebuild and verify job
-- recomputes from the ledger, and requires an alert on any discrepancy between the two. A
-- reserved column on that row would be the one figure there with no ledger behind it, so it
-- could never be rebuilt and never be verified. Section 12.2 separately lists "stock movements,
-- ledger entries, reservations" as three kinds of side effect, naming reservations apart from
-- movements. And section 12.3 requires the cancellation rule to state whether cancelling
-- releases reserved stock, which needs to know whose reservations they were. A counter cannot
-- answer that; a record with an owner can.
--
-- `stock_balances` is deliberately untouched. `on_hand` remains the projection of the movement
-- ledger and nothing else, and reserved is derived from the rows here when the reservation
-- operation arrives.
--
-- WHAT THIS INCREMENT DOES NOT DECIDE. Nothing reserves anything yet. There is no availability
-- calculation, no oversell check, no release, and no cancellation rule. Those are the next
-- increments, and the grants below are written to match: this table can be inserted into and
-- read, and nothing more, because whether release deletes a row or reduces it is exactly the
-- question section 12.3 leaves open. A grant is easy to add later and awkward to take back.
-- ---------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------------------
-- KEYS THE OWNING RELATIONSHIP NEEDS
--
-- `sales_order_lines` has a bare primary key on `id` and no composite key naming its scope, so
-- nothing could yet point at a line and be pinned to that line's company. Both keys below are
-- additive and exist so the foreign keys further down can be written at all.
--
-- The second is the trick migration 0005 already used to pin a line to its order's currency:
-- a unique key on a superkey, so a referencing row must agree about a second column rather than
-- merely pointing at the right row.
-- ---------------------------------------------------------------------------------------

ALTER TABLE sales_order_lines
    ADD CONSTRAINT sales_order_lines_tenant_company_id_key UNIQUE (tenant_id, company_id, id);

ALTER TABLE sales_order_lines
    ADD CONSTRAINT sales_order_lines_id_product_key UNIQUE (id, product_id);

-- ---------------------------------------------------------------------------------------
-- THE TABLE
--
-- QUANTITY IS POSITIVE, unlike a stock movement. A movement is signed because it records a
-- direction: goods arrived or goods left. A reservation records an amount set aside, and it is
-- subtracted from on hand wherever availability is computed, so a negative one would silently
-- increase what the business believes it can sell. The order line it belongs to already refuses
-- a quantity of zero or less for the same reason.
--
-- NO STATUS COLUMN. Section 12.3 has not yet ruled what cancelling does to reserved stock, and
-- a lifecycle invented here would be that unwritten rule, guessed at, in the schema. A row
-- present is stock set aside; what removes it is the next decision to be made, not this one.
--
-- NO `version`. Nothing updates a row here: this increment only inserts them, which is section
-- 4.2's second exempt shape, and an unused version column is a defect in its own right. If
-- release turns out to reduce a reservation in place rather than remove it, the table becomes
-- mutable and gains the column in the migration that makes it so.
-- ---------------------------------------------------------------------------------------

CREATE TABLE stock_reservations (
    id                   uuid          PRIMARY KEY,
    tenant_id            uuid          NOT NULL,
    company_id           uuid          NOT NULL,

    -- Who the stock is set aside for. Section 8.1 requires a movement to carry the document
    -- that caused it, and a reservation has the stronger form of the same idea: not merely
    -- which document, but which line of it.
    sales_order_line_id  uuid          NOT NULL,

    -- Denormalised from the line and the order, because availability is read by product and
    -- warehouse and joining through two documents to answer it would be the wrong shape. The
    -- keys below are what stop the copies from disagreeing with their sources.
    product_id           uuid          NOT NULL,
    warehouse_id         uuid          NOT NULL,

    -- The stocking unit of section 8.4, at the precision every other quantity in the schema
    -- uses. Positive: see the note above.
    quantity             numeric(19,6) NOT NULL,

    reserved_at          timestamptz   NOT NULL DEFAULT now(),

    created_at           timestamptz   NOT NULL DEFAULT now(),
    created_by           uuid,
    updated_at           timestamptz   NOT NULL DEFAULT now(),
    updated_by           uuid,

    CONSTRAINT stock_reservations_quantity_check CHECK (quantity > 0),

    CONSTRAINT stock_reservations_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),

    -- The owning line, pinned to this reservation's own tenant and company. A reservation for
    -- a line in another company is not merely refused by policy; there is no combination of
    -- values that expresses it.
    CONSTRAINT stock_reservations_line_fkey
        FOREIGN KEY (tenant_id, company_id, sales_order_line_id)
        REFERENCES sales_order_lines (tenant_id, company_id, id),

    -- And the reservation must be for the product its line actually sells. Enforced against the
    -- line rather than checked in application code, so a reservation holding one product for a
    -- line that ordered another cannot exist even briefly.
    CONSTRAINT stock_reservations_line_product_fkey
        FOREIGN KEY (sales_order_line_id, product_id)
        REFERENCES sales_order_lines (id, product_id),

    -- Master data, each pinned to this company. Same composite strategy as the stock ledger:
    -- both rows are individually legitimate and only the pairing is wrong, which is the case
    -- row level security cannot catch on its own.
    CONSTRAINT stock_reservations_product_fkey
        FOREIGN KEY (tenant_id, company_id, product_id) REFERENCES products (tenant_id, company_id, id),
    CONSTRAINT stock_reservations_warehouse_fkey
        FOREIGN KEY (tenant_id, company_id, warehouse_id) REFERENCES warehouses (tenant_id, company_id, id)
);

-- The read availability will make: everything reserved against one balance key. It matches the
-- index on the movement ledger deliberately, because the two are summed for the same question.
CREATE INDEX stock_reservations_balance_key_idx
    ON stock_reservations (tenant_id, company_id, product_id, warehouse_id);

-- Finding what a line holds, which is what releasing it will need.
CREATE INDEX stock_reservations_line_idx
    ON stock_reservations (tenant_id, company_id, sales_order_line_id);

-- ---------------------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- Company partitioned, like the ledger and the balance. A reservation belongs to exactly one
-- company and nothing reads across companies.
-- ---------------------------------------------------------------------------------------

ALTER TABLE stock_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_reservations_tenant_company_isolation ON stock_reservations
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

-- ---------------------------------------------------------------------------------------
-- GRANTS
--
-- SELECT and INSERT only, and the absence is the point. Release is not designed: section 12.3
-- has not ruled whether cancelling releases reserved stock, and partial delivery may reduce a
-- reservation or close it. Granting UPDATE or DELETE now would be choosing between those in a
-- migration rather than in the increment that thinks about it.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
    app_role text := current_setting('app.provision_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        RAISE EXCEPTION 'app.provision_role must be set to the application role name before running this migration';
    END IF;

    EXECUTE format('GRANT SELECT, INSERT ON stock_reservations TO %I', app_role);
END
$$;
