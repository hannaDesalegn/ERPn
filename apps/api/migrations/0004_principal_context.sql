-- 0004_principal_context
--
-- Adds the transaction local user context, and one policy that uses it.
--
-- THE PROBLEM THIS SOLVES. Section 2.5 requires the active company to be resolved from the
-- server side session and validated against the user's membership rows. Section 2.6 makes a
-- user global and lets one person belong to companies in more than one tenant, the external
-- accountant case named there. Put those together and the very first question `/me` has to
-- answer is cross-tenant: which companies may this person enter?
--
-- No existing context can answer it. With a tenant set, `memberships` returns that tenant only,
-- and the tenant is precisely what is not yet known. With no tenant set, the policy denies
-- everything, which is the correct default and useless here.
--
-- The alternatives were worse. A `tenant_id` on `users` contradicts section 4.6 and the one
-- account per person ruling in 2.6. A separate directory table duplicates `memberships` and
-- becomes a second source of truth about who may enter what, which is the last place to want
-- one. Iterating every tenant and asking each in turn is a query per tenant per request and
-- scales with the customer list.
--
-- WHAT IS ADDED. A third context setting, `app.user_id`, alongside the tenant and company
-- settings from 0001, and a policy admitting a membership row when the transaction has no
-- tenant context and the row belongs to the user named in the context. That is the whole of it:
-- a person may discover their own memberships and nothing else.
--
-- WHY THIS DOES NOT WIDEN ANYTHING.
--
--   tenant set                  unchanged. The 0001 policy answers, and the clause below is
--                               false because it requires the tenant context to be empty.
--   tenant empty, user empty    denied. `user_id = NULL` is null, not true.
--   tenant empty, user set      that user's own rows, across tenants, and no one else's.
--
-- No context sees two users. No context sees a row belonging to someone else. The reach of an
-- empty tenant context grows by exactly one thing: the reader's own membership rows, which name
-- the tenants and companies that reader already belongs to.
--
-- `app.user_id` is set by the unit of work from the scope, and the scope is built from the
-- validated session. It is not a defence against the application lying to the database, any more
-- than `app.tenant_id` is; it is the second of the two layers section 2.4 requires, and it fails
-- closed when unset.

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

COMMENT ON FUNCTION app_current_user_id() IS
    'Reads the transaction local user context. Returns NULL when unset, which makes every policy comparison false and therefore denies. Contract sections 2.4 and 2.5.';

-- Permissive and additive. PostgreSQL ORs permissive policies together, so the 0001 tenant
-- policy is untouched and still answers every tenant scoped read. This one only ever fires when
-- there is no tenant to answer with.
CREATE POLICY memberships_self_discovery ON memberships
    FOR SELECT
    USING (
        app_current_tenant_id() IS NULL
        AND user_id = app_current_user_id()
    );

COMMENT ON POLICY memberships_self_discovery ON memberships IS
    'Lets a principal with no company chosen yet read their own membership rows, so company context can be resolved. Never another user''s rows, and never anything when the user context is empty.';
