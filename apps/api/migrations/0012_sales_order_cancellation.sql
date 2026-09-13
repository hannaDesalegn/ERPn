-- ---------------------------------------------------------------------------------------
-- SALES ORDER CANCELLATION
--
-- Contract section 12.3, ruled 2026-09-13. That clause has always required cancellation rules
-- to be explicit per document type, including whether cancelling releases reserved stock and
-- what accounting consequence it carries. Until the rule was written the schema said so by
-- withholding: `stock_reservations` was granted INSERT and SELECT and nothing else, and this
-- migration is the one that thinks about release, exactly as 0009 said it would be.
--
-- WHAT THE RULE SAYS, AND WHAT EACH HALF OF IT COSTS HERE:
--
--   a draft may be cancelled and keeps a null document number   the check constraint below
--   a confirmed order may be cancelled                          nothing, already representable
--   cancelling releases every reservation the order holds       released_at, and the UPDATE grant
--   reservations are released, never deleted                    no DELETE grant, deliberately
--   no accounting consequence                                   nothing, there is no ledger yet
--   an optional reason lives in the audit payload               no column, deliberately
--
-- NO `reason` COLUMN ON `sales_orders`. The ruling puts the reason in the audit record's change
-- payload, which section 7.2 already stores as structured data. A column would make it a mutable
-- property of the order rather than something somebody said once about a transition.
-- ---------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------------------
-- A CANCELLED DRAFT KEEPS ITS NULL NUMBER
--
-- The original constraint read "a draft has no number, anything else has one", which was right
-- while confirming was the only way out of a draft. It refuses a cancelled draft, because such
-- an order is not a draft and has no number.
--
-- The alternative was allocating a number when cancelling a draft, and section 10.4 is why not.
-- Numbering is gapless because a number, once issued, is a fact about a document the business
-- raised. An abandoned draft raised nothing. Spending a number on it would leave the series
-- intact and the meaning of the series full of holes, which is the worse of the two gaps.
--
-- THE INVARIANT THAT MATTERS IS PRESERVED, and narrowed rather than loosened: every state that
-- is reached by allocating a number still requires one. Only `cancelled` may go either way, and
-- only because it is reachable from both sides of the allocation. A cancelled order that was
-- confirmed keeps the number it was issued; one that was a draft never had one.
-- ---------------------------------------------------------------------------------------

ALTER TABLE sales_orders
    DROP CONSTRAINT sales_orders_draft_has_no_number_check;

ALTER TABLE sales_orders
    ADD CONSTRAINT sales_orders_draft_has_no_number_check CHECK (
        (status = 'draft' AND doc_number IS NULL)
        OR (status = 'cancelled')
        OR (status NOT IN ('draft', 'cancelled') AND doc_number IS NOT NULL)
    );

-- ---------------------------------------------------------------------------------------
-- RELEASING A RESERVATION
--
-- A stamp, not a delete. Section 12.3's ruling keeps the history of what was held, for which
-- line, and until when. A delete would answer today's availability question just as well and
-- would leave nobody able to ask why stock was unavailable last Tuesday.
--
-- `released_at` IS THE WHOLE OF THE STATE. There is no status column and no reason column here:
-- a row with a null stamp is active, a row with one is not, and why it was released is the
-- cancelling order's audit record to explain. Two columns that can disagree about the same fact
-- are how a second source of truth starts.
--
-- WHAT READS IT. Availability sums only the rows where it is null, which is section 8.5's
-- reserved figure and the only place reserved is computed. That sum runs under the balance row
-- lock of section 10.2, and so does every write below, so a release and a reservation for the
-- same key serialise against each other rather than both reading the pre-release position.
-- ---------------------------------------------------------------------------------------

ALTER TABLE stock_reservations
    ADD COLUMN released_at timestamptz;

-- ---------------------------------------------------------------------------------------
-- THE TABLE IS NOW MUTABLE, SO IT CARRIES `version`
--
-- Section 4.2's main rule, applied rather than argued around. A row can now be updated after it
-- is written, which is the only circumstance in which a lost update is possible, so the column
-- is required. None of the four exemptions fits: the first two describe tables that are never
-- updated, the third describes a table whose `updated_at` never changes, and the fourth needs
-- operational state that appears in no document, no report and no audit trail, which a
-- reservation fails on its first condition because it is what availability is computed from.
--
-- AND IT IS ACTUALLY CHECKED. Section 4.2 is equally explicit that an unused `version` is a
-- defect in its own right, because a column that looks like a concurrency control and is never
-- read is worse than an absent one. The release predicate carries it, alongside the requirement
-- that the row is still active, so a release that lost a race matches no row and says so.
--
-- The default is 1 and the column is not null, which is what every other versioned table here
-- does and what the rows already written need.
-- ---------------------------------------------------------------------------------------

ALTER TABLE stock_reservations
    ADD COLUMN version integer NOT NULL DEFAULT 1;

-- The read availability makes, now that it has a predicate. Partial, because the active rows are
-- the only ones summed and a released row is dead weight in that index forever.
CREATE INDEX stock_reservations_active_balance_key_idx
    ON stock_reservations (tenant_id, company_id, product_id, warehouse_id)
    WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------------------
-- GRANTS
--
-- UPDATE, and nothing else added. Section 12.3's ruling is that reservations are released rather
-- than deleted, so the absence of DELETE is the ruling enforced by the database rather than by
-- the application remembering. `sales_orders` gains nothing: it was already updatable, and it
-- still holds no DELETE grant, per section 4.5.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
    app_role text := current_setting('app.provision_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        RAISE EXCEPTION 'app.provision_role must be set to the application role name before running this migration';
    END IF;

    EXECUTE format('GRANT UPDATE ON stock_reservations TO %I', app_role);
END
$$;
