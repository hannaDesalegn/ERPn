-- 0006_master_data
--
-- Customers, products and warehouses, and the three foreign keys that 0005 could not declare
-- because these tables did not exist.
--
-- WHY ALL THREE, AND WHY NOW. Section 4.1's invariant table is unambiguous: "Every foreign key
-- relationship: actual foreign keys, always." A sales order references a customer and a
-- warehouse, and a line references a product. Those are foreign key relationships, so order
-- creation cannot be implemented until they are real keys. Nothing else in slice 2 can start
-- before this.
--
-- WHY COMPANY SCOPED RATHER THAN SHARED ACROSS A TENANT. Section 2.2 describes a customer who
-- runs two trading entities that "share a user directory and possibly a product catalogue", and
-- then settles the possibly: sharing master data between companies inside one tenant is a
-- `[FUT]`, "recorded now because the identifiers exist; not built until asked". So these carry
-- `tenant_id` and `company_id` like every other tenant scoped table under 4.6, and a shared
-- catalogue becomes a later change rather than a different schema.
--
-- WHY THIS IS NOT THE INVENTORY SCHEMA. Section 8 is about the stock ledger, its materialised
-- projection, unit conversion, reservation and costing. None of those is the product or the
-- warehouse record itself, and section 2.9 lists "organisation: warehouses, branches and
-- locations" among the things a company configures. The movement ledger of 8.1 and the balance
-- rows of 8.2 are not in this migration.
--
-- WHAT IS DELIBERATELY ABSENT, because narrowest means narrowest:
--
--   costing method   Section 8.6 requires the declared method to be actually implemented, and
--                    says today's `costingMethod: 'average'` is a label. Adding the column
--                    before the calculation would recreate exactly that defect.
--   cost price       Section 8.3 separates quantity and value into linked ledgers. A static
--                    cost column is the temporary state section 16.1 already records.
--   credit limit     The rule that a confirmation exceeding it is blocked belongs to the
--                    confirming transaction, which is a later increment.
--   tax rate         Section 3.3 requires the server to recompute tax from master data, and the
--                    contract does not say whether that lives on a product, a customer or a
--                    jurisdiction table. That is a decision, not an omission, and it is reported
--                    rather than guessed.

-- ---------------------------------------------------------------------------------------
-- CUSTOMERS
--
-- A party the company sells to. Archived rather than deleted, per section 4.5.
-- ---------------------------------------------------------------------------------------

CREATE TABLE customers (
    id          uuid        PRIMARY KEY,
    tenant_id   uuid        NOT NULL,
    company_id  uuid        NOT NULL,

    -- The code humans use. Unique within the company that owns the record.
    code        text        NOT NULL,
    name        text        NOT NULL,
    status      text        NOT NULL DEFAULT 'active',

    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid,
    version     integer     NOT NULL DEFAULT 1,

    CONSTRAINT customers_status_check CHECK (status IN ('active', 'archived')),
    CONSTRAINT customers_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    CONSTRAINT customers_company_code_key UNIQUE (company_id, code),
    -- The target of the composite key on sales orders. Redundant for uniqueness, because `id`
    -- is already the primary key, and required so that a referencing row must name the same
    -- tenant and company. This is the pattern 0001 established for companies and roles.
    CONSTRAINT customers_tenant_company_id_key UNIQUE (tenant_id, company_id, id)
);

CREATE INDEX customers_tenant_company_idx ON customers (tenant_id, company_id);
CREATE INDEX customers_name_idx ON customers (tenant_id, company_id, name);

-- ---------------------------------------------------------------------------------------
-- PRODUCTS
--
-- Note the most important absence, which the domain model states and section 8.1 restates as
-- the single easiest thing for a future contributor to undo: there is no quantity column here.
-- Stock is an append only ledger of movements, not an attribute of a product.
--
-- `stocking_uom` is section 8.4's requirement: every product has a canonical stocking unit of
-- measure, and the stock ledger is always recorded in it. 8.4 says this must exist before the
-- first stock row is persisted, and the cheapest moment to satisfy that is before any product
-- row exists at all.
--
-- The valid set of units is not a check constraint here, following the pattern section 2.7
-- established for permissions and 0005 for document types: the catalogue is code, validated on
-- write. Unit conversion, which is the rest of 8.4, is a later increment and is what will need
-- that catalogue.
-- ---------------------------------------------------------------------------------------

CREATE TABLE products (
    id            uuid          PRIMARY KEY,
    tenant_id     uuid          NOT NULL,
    company_id    uuid          NOT NULL,

    sku           text          NOT NULL,
    name          text          NOT NULL,
    -- Only a stockable product participates in inventory. A delivery fee or a consulting hour
    -- is sellable and generates no movement, and modelling that now is what stops a later
    -- increment trying to reserve stock for a service line.
    type          text          NOT NULL DEFAULT 'stockable',
    stocking_uom  text          NOT NULL,

    -- Section 3.3: the server recomputes every monetary figure from its own master data rather
    -- than trusting a price sent back from a form. This is that master data. Six decimal places
    -- per section 4.3, because a distributor buys and sells at fractions of a cent per unit.
    sales_price   numeric(19,6) NOT NULL DEFAULT 0,
    -- Section 4.3 stores a currency alongside every amount.
    sales_price_currency char(3) NOT NULL,

    status        text          NOT NULL DEFAULT 'active',

    created_at    timestamptz   NOT NULL DEFAULT now(),
    created_by    uuid,
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    updated_by    uuid,
    version       integer       NOT NULL DEFAULT 1,

    CONSTRAINT products_type_check CHECK (type IN ('stockable', 'service', 'consumable')),
    CONSTRAINT products_status_check CHECK (status IN ('active', 'archived')),
    CONSTRAINT products_stocking_uom_check CHECK (stocking_uom ~ '^[a-z][a-z0-9_]{0,31}$'),
    CONSTRAINT products_sales_price_check CHECK (sales_price >= 0),
    CONSTRAINT products_currency_check CHECK (sales_price_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT products_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    CONSTRAINT products_company_sku_key UNIQUE (company_id, sku),
    CONSTRAINT products_tenant_company_id_key UNIQUE (tenant_id, company_id, id)
);

CREATE INDEX products_tenant_company_idx ON products (tenant_id, company_id);
CREATE INDEX products_name_idx ON products (tenant_id, company_id, name);

-- ---------------------------------------------------------------------------------------
-- WAREHOUSES
--
-- Company configuration under section 2.9, which lists "organisation: warehouses, branches and
-- locations" among the things a company configures through its administration UI.
--
-- `allow_negative_stock` is section 8.5's requirement: negative stock is a policy per warehouse,
-- defaulting to deny. The column carries the policy; the check that enforces it belongs to the
-- transaction that writes a movement, which is a later increment.
-- ---------------------------------------------------------------------------------------

CREATE TABLE warehouses (
    id                    uuid        PRIMARY KEY,
    tenant_id             uuid        NOT NULL,
    company_id            uuid        NOT NULL,

    code                  text        NOT NULL,
    name                  text        NOT NULL,
    status                text        NOT NULL DEFAULT 'active',
    -- One warehouse is the default source for sales and destination for purchases.
    is_default            boolean     NOT NULL DEFAULT false,
    -- Section 8.5, defaulting to deny.
    allow_negative_stock  boolean     NOT NULL DEFAULT false,

    created_at            timestamptz NOT NULL DEFAULT now(),
    created_by            uuid,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid,
    version               integer     NOT NULL DEFAULT 1,

    CONSTRAINT warehouses_status_check CHECK (status IN ('active', 'archived')),
    CONSTRAINT warehouses_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    CONSTRAINT warehouses_company_code_key UNIQUE (company_id, code),
    CONSTRAINT warehouses_tenant_company_id_key UNIQUE (tenant_id, company_id, id)
);

-- At most one default per company. A partial unique index rather than a check, because "at most
-- one row where this is true" is not something a row level check can see.
CREATE UNIQUE INDEX warehouses_company_default_key
    ON warehouses (company_id)
    WHERE is_default;

CREATE INDEX warehouses_tenant_company_idx ON warehouses (tenant_id, company_id);

-- ---------------------------------------------------------------------------------------
-- THE KEYS 0005 COULD NOT DECLARE
--
-- Section 4.1, and the reason each one names three columns rather than one. A single column key
-- would let a sales order in one company reference a customer in another, which row level
-- security would not catch: the order row and the customer row are each individually legitimate,
-- and only the pairing is wrong. Naming the tenant and the company in the key makes that pairing
-- unrepresentable.
--
-- Added as plain constraints rather than NOT VALID, because these tables have no rows: nothing
-- creates a sales order yet, which is exactly why this could be deferred to here.
-- ---------------------------------------------------------------------------------------

ALTER TABLE sales_orders
    ADD CONSTRAINT sales_orders_customer_fkey
    FOREIGN KEY (tenant_id, company_id, customer_id)
    REFERENCES customers (tenant_id, company_id, id);

ALTER TABLE sales_orders
    ADD CONSTRAINT sales_orders_warehouse_fkey
    FOREIGN KEY (tenant_id, company_id, warehouse_id)
    REFERENCES warehouses (tenant_id, company_id, id);

ALTER TABLE sales_order_lines
    ADD CONSTRAINT sales_order_lines_product_fkey
    FOREIGN KEY (tenant_id, company_id, product_id)
    REFERENCES products (tenant_id, company_id, id);

-- ---------------------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- The second of the two layers section 2.4 requires, on the same terms as every other tenant
-- scoped table. FORCE matters as much as ENABLE: without it the owning role is exempt from its
-- own policies, and the migration role owns every table here.
-- ---------------------------------------------------------------------------------------

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY customers_tenant_company_isolation ON customers
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY products_tenant_company_isolation ON products
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses FORCE ROW LEVEL SECURITY;
CREATE POLICY warehouses_tenant_company_isolation ON warehouses
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

-- ---------------------------------------------------------------------------------------
-- GRANTS
--
-- No DELETE on any of the three. Section 4.5: business records are cancelled, reversed or
-- archived, never hard deleted, and each table carries a status for exactly that. A customer
-- with orders against it must not be removable, and the archived state is what replaces it.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
    app_role text := current_setting('app.provision_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        RAISE EXCEPTION 'app.provision_role must be set to the application role name before running this migration';
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON customers TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON products TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON warehouses TO %I', app_role);
END
$$;
