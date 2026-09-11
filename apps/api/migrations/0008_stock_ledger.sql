-- ---------------------------------------------------------------------------------------
-- STOCK LEDGER AND ITS MAINTAINED BALANCE
--
-- Contract section 8.1: stock is an append only ledger of immutable movement rows. There is no
-- mutable quantity field on a product, and every movement carries the document that caused it.
-- Section 8.2: a balance row per company, product and location is maintained in the same
-- transaction as the movement that changes it. The ledger stays the truth; the balance is a
-- maintained aggregate with a rebuild and verify job to come.
--
-- WHAT IS DELIBERATELY ABSENT, AND WHY.
--
--   No cost or value column on a movement. Section 8.3 rules quantity movements and value
--   entries separate records, after Business Central's Item Ledger Entry and Value Entry,
--   because quantity and cost are known at different times: goods arrive before the bill, and
--   freight lands weeks later against stock that may already be sold. The fixture model carries
--   a unit cost on the move, and that conflation is what section 8.3 exists to refuse. Value
--   entries are section 8.6's work.
--
--   No reserved quantity. Section 8.5 defines available as on hand minus reserved, but section
--   8.2 defines this balance as what the movements make it, and a reservation is not a movement.
--   Where reserved lives is the reservation increment's question, and guessing at it here would
--   put a column in the schema that nothing maintains.
--
--   No location finer than a warehouse. Section 8.2 says location; in this model that is the
--   warehouse, which is what section 8.7 records as the thing virtual locations would replace.
-- ---------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------------------
-- STOCK MOVEMENTS
--
-- QUANTITY IS SIGNED. Positive increases stock, negative decreases it. This is the existing
-- model rather than a choice made here: section 8.7 records the future move to virtual
-- locations as making quantities "conserved rather than signed", which only reads that way
-- because they are signed now.
--
-- ALWAYS IN THE PRODUCT'S STOCKING UNIT, per section 8.4. Documents may trade in cases or
-- boxes, and the conversion factor belongs on the document line so that changing it later
-- cannot alter history. Nothing here converts anything; the caller records stocking units.
--
-- REASONS ARE THE EXISTING EIGHT. Section 8.7 says `MovementReason` preserves what a
-- source and destination model would carry, which is why it is a closed list and not a free
-- text note. No reason is invented here.
--
-- THE CAUSING DOCUMENT HAS NO FOREIGN KEY, AND THAT IS A RECORDED GAP. Section 4.1 wants an
-- actual foreign key for every relationship, but the causing document is one of eight kinds and
-- seven of those tables do not exist. A column per future document type would be seven nullable
-- columns and a check constraint; a registry table would be a framework invented before its
-- second caller. So the pair is polymorphic for now, constrained in shape but not in target,
-- exactly as `sales_orders.customer_id` was until migration 0006 created the table it needed.
-- ---------------------------------------------------------------------------------------

CREATE TABLE stock_movements (
    id             uuid        PRIMARY KEY,
    tenant_id      uuid        NOT NULL,
    company_id     uuid        NOT NULL,

    product_id     uuid        NOT NULL,
    warehouse_id   uuid        NOT NULL,

    -- Signed, and never zero: a movement of nothing is not a fact worth recording.
    quantity       numeric(19,6) NOT NULL,
    reason         text        NOT NULL,

    -- Section 8.1: every movement carries the document that caused it. Both halves are NOT NULL
    -- because a movement with no legitimate source is the thing that makes a ledger untrustworthy.
    source_doc_type text       NOT NULL,
    source_doc_id   uuid       NOT NULL,

    -- When the movement happened, which is not always when the row was written. A receipt
    -- backdated to yesterday's delivery note is ordinary.
    occurred_at    timestamptz NOT NULL DEFAULT now(),

    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid,
    -- Append only, so these never change after the insert. They exist because section 4.2 lists
    -- them, and they stay equal to their created counterparts for the life of the row.
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid,

    -- No `version`. Section 4.2's second exempt shape: rows are never updated, so there is no
    -- lost update to prevent, and a column that looks like a concurrency control and is never
    -- checked is worse than an absent one. The grants below make that structural rather than
    -- a promise, in the same way section 7.1 does for the audit table.

    CONSTRAINT stock_movements_quantity_check CHECK (quantity <> 0),
    CONSTRAINT stock_movements_reason_check CHECK (
        reason IN (
            'purchase_receipt',
            'sales_delivery',
            'transfer_in',
            'transfer_out',
            'adjustment',
            'customer_return',
            'supplier_return',
            'scrap'
        )
    ),
    CONSTRAINT stock_movements_source_doc_type_check
        CHECK (source_doc_type ~ '^[a-z][a-z0-9_]{1,62}$'),
    CONSTRAINT stock_movements_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    -- Composite, so a movement cannot name a product or a warehouse belonging to another
    -- company. Section 4.1: the pairing is the thing row level security cannot catch on its own,
    -- because both rows are individually legitimate and only the combination is wrong.
    CONSTRAINT stock_movements_product_fkey
        FOREIGN KEY (tenant_id, company_id, product_id) REFERENCES products (tenant_id, company_id, id),
    CONSTRAINT stock_movements_warehouse_fkey
        FOREIGN KEY (tenant_id, company_id, warehouse_id) REFERENCES warehouses (tenant_id, company_id, id)
);

-- The read the rebuild and verify job of section 8.2 makes: every movement for one balance key,
-- which is also the shape a product's movement history screen wants.
CREATE INDEX stock_movements_balance_key_idx
    ON stock_movements (tenant_id, company_id, product_id, warehouse_id, occurred_at);

-- Finding every movement a document caused, which is what tracing a posting backwards needs.
CREATE INDEX stock_movements_source_idx
    ON stock_movements (tenant_id, company_id, source_doc_type, source_doc_id);

-- ---------------------------------------------------------------------------------------
-- STOCK BALANCES
--
-- The maintained aggregate of section 8.2. One row per company, product and warehouse, holding
-- what the movements for that key sum to.
--
-- IT CARRIES `version`, AND THE VERSION IS CHECKED. Section 4.2 requires it of every mutable
-- business table and calls an unused one a defect in its own right, so the update below matches
-- on it and treats a miss as an error. Section 10.2 separately requires the row to be locked
-- with SELECT FOR UPDATE when stock moves, which is the mechanism that actually prevents the
-- lost update; the version check is the assertion that the lock was taken, and it is what would
-- fail first if a future change dropped it.
--
-- ON HAND MAY GO NEGATIVE, AND ONLY POLICY SAYS OTHERWISE. Section 8.5 makes negative stock a
-- per warehouse policy defaulting to deny, and `warehouses.allow_negative_stock` already holds
-- it. A blanket check constraint here would make the policy unexpressible, so the rule belongs
-- where the policy is read rather than in the column.
-- ---------------------------------------------------------------------------------------

CREATE TABLE stock_balances (
    id             uuid        PRIMARY KEY,
    tenant_id      uuid        NOT NULL,
    company_id     uuid        NOT NULL,

    product_id     uuid        NOT NULL,
    warehouse_id   uuid        NOT NULL,

    -- The sum of every movement for this key, in the product's stocking unit.
    on_hand        numeric(19,6) NOT NULL DEFAULT 0,

    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid,
    version        integer     NOT NULL DEFAULT 1,

    -- One balance per key. Two rows for the same product in the same warehouse would each hold
    -- half the truth, and neither would be wrong on its own.
    CONSTRAINT stock_balances_key_key UNIQUE (company_id, product_id, warehouse_id),
    CONSTRAINT stock_balances_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    CONSTRAINT stock_balances_product_fkey
        FOREIGN KEY (tenant_id, company_id, product_id) REFERENCES products (tenant_id, company_id, id),
    CONSTRAINT stock_balances_warehouse_fkey
        FOREIGN KEY (tenant_id, company_id, warehouse_id) REFERENCES warehouses (tenant_id, company_id, id)
);

CREATE INDEX stock_balances_tenant_company_idx
    ON stock_balances (tenant_id, company_id);

-- ---------------------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- Both tables are partitioned by company: a balance belongs to exactly one, and nothing needs
-- to read either across companies.
-- ---------------------------------------------------------------------------------------

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movements_tenant_company_isolation ON stock_movements
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

ALTER TABLE stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_balances_tenant_company_isolation ON stock_balances
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

-- ---------------------------------------------------------------------------------------
-- GRANTS
--
-- `stock_movements` gets SELECT and INSERT and nothing else. Section 8.1 calls the ledger append
-- only and immutable, and section 7.1 already established that the way to mean it is to withhold
-- the grant rather than to rely on every future caller behaving. An UPDATE against history is
-- then refused by the database, not by a code review.
--
-- `stock_balances` gets UPDATE, because maintaining it is the whole point. No DELETE: a balance
-- that can be dropped is a balance that can be silently re-derived as zero, and the rebuild job
-- of section 8.2 corrects drift by recomputing the number, never by removing the row.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
    app_role text := current_setting('app.provision_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        RAISE EXCEPTION 'app.provision_role must be set to the application role name before running this migration';
    END IF;

    EXECUTE format('GRANT SELECT, INSERT ON stock_movements TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON stock_balances TO %I', app_role);
END
$$;
