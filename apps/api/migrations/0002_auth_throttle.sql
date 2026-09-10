-- 0002_auth_throttle
--
-- Login rate limiting and lockout state. Contract section 5.2 requires login to be rate limited
-- per address and per account, with progressive backoff and lockout.
--
-- WHY THIS TABLE IS GLOBAL. Contract section 4.6, amended 2026-09-10 to name it. Authentication
-- happens before any tenant is resolved, so there is no tenant to scope a row to. The
-- per-address case is sharper: an attempt against an address matching no account has no user row
-- and no tenant, and that is exactly the attempt a per-address limit exists to catch.
--
-- Two alternatives were examined and rejected, recorded here so nobody re-derives them:
--   counters on `users`  covers per-account, cannot cover per-address
--   derive from audit    the audit select policy compares tenant_id to the current context, and
--                        authentication events carry a null tenant, so the application can write
--                        those rows and can never read one back
--
-- This is not an infrastructure exemption from tenant scoping and must not be cited as one.

CREATE TABLE auth_throttle (
    -- What is being counted. `address` counts by client address, `account` by the email that
    -- was attempted, whether or not it matches a user.
    scope_kind    text        NOT NULL,
    -- The address, or the lowercased email. Part of the key rather than a column of its own so
    -- that a single row per subject can be locked and updated atomically.
    scope_key     text        NOT NULL,

    failure_count integer     NOT NULL DEFAULT 0,
    -- Failures accumulate within a rolling window. When the window elapses the count restarts,
    -- so an occasional typo months apart never accumulates into a lockout.
    window_started_at timestamptz NOT NULL DEFAULT now(),
    -- Null when not locked. Set when the count reaches the configured limit.
    locked_until  timestamptz,
    last_failure_at timestamptz,

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT auth_throttle_pkey PRIMARY KEY (scope_kind, scope_key),
    CONSTRAINT auth_throttle_kind_check CHECK (scope_kind IN ('address', 'account')),
    CONSTRAINT auth_throttle_count_check CHECK (failure_count >= 0),
    -- A key long enough to be an attack vector rather than an address or an email.
    CONSTRAINT auth_throttle_key_length_check CHECK (length(scope_key) BETWEEN 1 AND 320)
);

COMMENT ON TABLE auth_throttle IS
    'Authentication throttling state. Global by necessity: authentication precedes tenant resolution. Holds no business data and is never joined to a tenant-scoped table. See architecture contract 4.6 and 5.2.';

-- Supports the sweep that clears expired windows and locks.
CREATE INDEX auth_throttle_window_idx ON auth_throttle (window_started_at);
CREATE INDEX auth_throttle_locked_until_idx ON auth_throttle (locked_until)
    WHERE locked_until IS NOT NULL;

-- ---------------------------------------------------------------------------------------
-- No row level security.
--
-- Every other table added in 0001 that carries tenant scope has it. This one has no tenant
-- column to write a policy against, and a policy comparing a non-existent column to the current
-- context would be theatre. The protection here is different in kind: the table is reachable
-- only through the authentication path, holds no data belonging to any tenant, and is never
-- read across a boundary because there is no boundary in it.
--
-- Stated explicitly so that a future reader comparing this migration against 0001 sees a
-- deliberate decision rather than an omission.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
    app_role text := current_setting('app.provision_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        RAISE EXCEPTION 'app.provision_role must be set to the application role name before running this migration';
    END IF;

    -- SELECT, INSERT and UPDATE, because throttling is a read-modify-write on one row.
    --
    -- No DELETE. Rows are reset in place, so a delete grant would add a second way to reach
    -- the same state and one more thing to reason about. It is worth being precise about what
    -- this does and does not buy: UPDATE already lets the application zero a counter, which it
    -- must be able to do so that a successful login clears earlier typos. What the application
    -- must never do is clear a lock that is currently in force, and that is enforced in the
    -- repository predicate rather than by withholding a grant.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON auth_throttle TO %I', app_role);
END
$$;
