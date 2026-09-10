-- 0003_audit_platform_scope
--
-- Corrects the read policy on `audit_events` for platform level rows.
--
-- WHAT WAS WRONG. 0001 wrote the select policy as `tenant_id = app_current_tenant_id()` and a
-- comment saying authentication rows are "readable by platform administration only". Two things
-- followed that were not intended.
--
--   1. The rows could not be WRITTEN, not merely read. `AuditRepository.append` issues
--      `INSERT ... RETURNING`, and PostgreSQL applies SELECT policies to a RETURNING clause. A
--      platform row failed the select check, so the whole insert was rejected with "new row
--      violates row-level security policy". Every login, failed login and logout would have
--      thrown. Criterion 18 requires failed logins to be audited, and it was unimplementable.
--
--   2. Nothing could read them either. `FORCE ROW LEVEL SECURITY` applies to the owning role, so
--      the rows were unreadable by `erp_app` AND by `erp_migrator`. An audit trail no role can
--      read is not an audit trail. The comment in 0002 that says the application "can write
--      those rows and can never read one back" was half right and is superseded here.
--
-- THE FIX, AND WHY IT DOES NOT WEAKEN ISOLATION. A platform row is admitted for reading only
-- when the transaction has no tenant context at all:
--
--   tenant context set    sees that tenant's rows, and no platform row
--   tenant context empty  sees platform rows, and no tenant's rows
--
-- Neither direction crosses a tenant boundary, and no context sees two tenants. An empty tenant
-- context exists only inside an explicitly named system scope, which is the same context that
-- already reads `users` and `sessions` in full because those tables are global under section
-- 4.6. Platform rows carry an attempted email, an address and a user agent, which is strictly
-- less than that. Section 4.6 already states the principle this relies on: absence of a tenant
-- column is not absence of authorization, and the repository interface decides what is offered.
--
-- The check constraint added in 0001 still limits platform rows to the four authentication
-- actions, so this cannot become a route to tenant business events with the scope left off.
--
-- Platform ADMINISTRATION as a product capability is still section 2.8 and still unbuilt. This
-- migration makes the rows writable and legible to server side code; it does not expose them to
-- any tenant, any user, or any HTTP surface.

DROP POLICY audit_events_tenant_isolation ON audit_events;

CREATE POLICY audit_events_read ON audit_events
    FOR SELECT
    USING (
        tenant_id = app_current_tenant_id()
        OR (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
    );

COMMENT ON TABLE audit_events IS
    'Append only. Tenant rows are readable only in that tenant''s context; platform authentication rows only in an empty tenant context. Contract sections 7.1 and 7.3.';
