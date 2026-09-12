-- ---------------------------------------------------------------------------------------
-- IDEMPOTENCY RECORDS
--
-- Contract section 11: every state changing endpoint accepts an `Idempotency-Key` header, and
-- the server stores the key, a fingerprint of the request and the response, scoped by company,
-- user and endpoint. A replay with the same key returns the stored response without re-performing
-- the operation. A replay with the same key and a different body is rejected as a conflict.
--
-- WHY THIS IS A TABLE AND NOT A CACHE. Section 11 makes it a `[DEC]` that the records live in
-- PostgreSQL with a bounded retention window. The reason it gives is the one that matters: a
-- network timeout during posting, retried by an impatient user or an automatic client, must not
-- post twice, and duplicate journal entries are far harder to unwind than a failed request. A
-- store that can lose a record under memory pressure would lose exactly the guarantee.
--
-- THE UNIQUE KEY IS THE SERIALISATION POINT, and that is the whole design. An operation claims
-- its key by inserting this row inside the same transaction that does the work. Two concurrent
-- requests carrying one key both try; the second waits on the index rather than proceeding,
-- because PostgreSQL makes a conflicting insert wait for the first transaction to finish. If the
-- first commits, the second finds the row and returns the response it stored. If the first rolls
-- back, the second's insert succeeds and it does the work itself. No second lock is needed and no
-- record can outlive the transaction that wrote it.
--
-- THE SCOPE IS FOUR DIMENSIONS, NOT ONE. Section 11 names company, user and endpoint alongside
-- the key, and section 4.6 requires the tenant on every tenant scoped table. A key is therefore
-- one person's intent at one endpoint in one company, which is what section 11 means by a key per
-- user intent: the same string from a different user, or the same user in a different company, is
-- a different intent and not a replay of this one.
-- ---------------------------------------------------------------------------------------

CREATE TABLE idempotency_records (
    id                   uuid          PRIMARY KEY,
    tenant_id            uuid          NOT NULL,
    company_id           uuid          NOT NULL,

    -- The three dimensions section 11 names, beside the tenant that section 4.6 requires.
    user_id              uuid          NOT NULL,
    endpoint             text          NOT NULL,
    idempotency_key      text          NOT NULL,

    -- A digest of the request, not the request. Section 11 rejects a replay whose body differs,
    -- and comparing digests answers that without keeping a copy of whatever the caller sent,
    -- which could carry personal data this table has no business retaining.
    request_fingerprint  text          NOT NULL,

    -- The stored response, written by the same transaction before it commits. Null only while
    -- that transaction is still running, which no other transaction can observe: a reader is
    -- either blocked on the unique index or looking at a row whose writer has committed.
    response_status      integer,
    response_body        jsonb,

    -- Section 11's bounded retention window. The expiring job is not written yet, which is
    -- recorded rather than hidden: until it exists these rows accumulate, and the column is what
    -- the job will read.
    expires_at           timestamptz   NOT NULL,

    created_at           timestamptz   NOT NULL DEFAULT now(),
    created_by           uuid,
    updated_at           timestamptz   NOT NULL DEFAULT now(),
    updated_by           uuid,

    -- No `version`, under section 4.2's fourth shape, and the four conditions are checked here
    -- rather than claimed:
    --
    --   1. Operational state, not a business record. Nothing in it appears on a document, in a
    --      ledger or in a report. It holds a copy of an HTTP response; the business content that
    --      response describes lives in `sales_orders` and is the authority for all of it.
    --   2. Ephemeral. Section 11 requires a bounded retention window and a job that expires
    --      these, and losing one costs a client a duplicate-request error rather than a
    --      transaction.
    --   3. Last write wins is the chosen model, and it is trivially satisfied: the row is written
    --      and completed by one transaction and never touched again.
    --   4. No field is edited by two actors with different intent. There is exactly one writer
    --      per row, ever, because the unique key below refuses a second one.
    --
    -- The first condition is the one worth arguing about, since the stored body contains a
    -- document number. It is a cached rendering of a fact recorded elsewhere, not the fact.

    CONSTRAINT idempotency_records_scope_key
        UNIQUE (tenant_id, company_id, user_id, endpoint, idempotency_key),
    CONSTRAINT idempotency_records_key_check
        CHECK (length(idempotency_key) BETWEEN 1 AND 255),
    CONSTRAINT idempotency_records_endpoint_check
        CHECK (endpoint ~ '^[A-Z]+ [a-z0-9/:_-]+$'),
    -- Both halves of the response arrive together or not at all. A status with no body, or a
    -- body with no status, is a half stored response that a replay could not return.
    CONSTRAINT idempotency_records_response_check CHECK (
        (response_status IS NULL AND response_body IS NULL)
        OR (response_status IS NOT NULL AND response_body IS NOT NULL)
    ),
    CONSTRAINT idempotency_records_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    CONSTRAINT idempotency_records_user_fkey FOREIGN KEY (user_id) REFERENCES users (id)
);

-- What the expiring job of section 11 will read.
CREATE INDEX idempotency_records_expires_at_idx ON idempotency_records (expires_at);

-- ---------------------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------------------

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_records_tenant_company_isolation ON idempotency_records
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

-- ---------------------------------------------------------------------------------------
-- GRANTS
--
-- UPDATE is granted because completing a claimed record is how the response gets stored. No
-- DELETE: expiry is the retention job's work under section 11, and a request path that could
-- remove its own idempotency record could replay an operation by forgetting it first.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
    app_role text := current_setting('app.provision_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        RAISE EXCEPTION 'app.provision_role must be set to the application role name before running this migration';
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON idempotency_records TO %I', app_role);
END
$$;
