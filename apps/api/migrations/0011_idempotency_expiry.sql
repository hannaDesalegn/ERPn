-- ---------------------------------------------------------------------------------------
-- EXPIRING IDEMPOTENCY RECORDS
--
-- Contract section 11: idempotency records live in PostgreSQL with a bounded retention window,
-- expired by a scheduled job. Migration 0010 created the window and deliberately withheld the
-- DELETE grant, because at that point nothing was entitled to remove a record and a request path
-- able to delete its own could replay an operation by forgetting it first.
--
-- The job now exists, so the grant has to. What follows is how that is done without handing the
-- application the ability to forget a live record.
--
-- THE POLICY IS THE CONTROL, NOT THE PREDICATE IN THE REPOSITORY. A restrictive policy is ANDed
-- with every other policy on the table rather than ORed, so a DELETE has to satisfy both this and
-- the tenant and company isolation that was already there. The effect is that no statement from
-- the application role can remove a record whose window has not closed, whatever predicate the
-- caller wrote. Section 4.1 puts integrity in the database precisely so that it does not depend
-- on every future caller remembering.
--
-- IT BINDS THE APPLICATION ROLE AND NOT THE OWNER, which is the one place this differs from the
-- isolation policies beside it. Those apply to everyone, the owner included, because tenant
-- isolation is not something any role may step outside. This is a different kind of rule: it
-- bounds what the request path may do, and the owning role is the one that runs migrations and
-- maintenance, which may legitimately have to remove a record that is still live. Naming the role
-- keeps the restriction aimed at the party it is about.
--
-- THE BOUNDARY IS `<=`, AND THIS IS WHERE IT IS DECIDED. Section 11 requires a bounded window and
-- does not say whether a record exactly at its expiry is inside or outside it. The convention
-- already in the codebase answers that: `session-policy.ts` treats a session as expired when
-- `now >= expiresAt`, so the moment named is the first moment at which the thing is gone. The
-- same rule is written here once, in the database, rather than in each caller that might read it
-- differently.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
    app_role text := current_setting('app.provision_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        RAISE EXCEPTION 'app.provision_role must be set to the application role name before running this migration';
    END IF;

    EXECUTE format(
        'CREATE POLICY idempotency_records_delete_expired_only ON idempotency_records '
        'AS RESTRICTIVE FOR DELETE TO %I USING (expires_at <= now())',
        app_role
    );
    EXECUTE format('GRANT DELETE ON idempotency_records TO %I', app_role);
END
$$;
