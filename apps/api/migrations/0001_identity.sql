-- 0001_identity
--
-- The identity foundation: tenants, companies, users, memberships, roles, permissions,
-- sessions and the audit log. Slice 1, contract section 17.2.
--
-- Runs as the OWNING role. The application role is granted explicitly at the end and owns
-- nothing, per contract sections 2.4 and 7.1.
--
-- This migration creates schema only. No rows. Companies come into existence through seeding,
-- which is application code and supplies UUIDv7 identifiers, so the tables below have no id
-- default on purpose: a missing id fails loudly rather than silently producing a v4.

-- ---------------------------------------------------------------------------------------
-- Migration bookkeeping
-- ---------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text        PRIMARY KEY,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    applied_by  text        NOT NULL DEFAULT current_user
);

COMMENT ON TABLE schema_migrations IS
    'Applied migrations and their checksums. Forward only: an applied file is never edited, and the runner refuses to start if a checksum changes.';

-- ---------------------------------------------------------------------------------------
-- GLOBAL TABLES
--
-- These three sit outside the tenant boundary. Contract section 4.6 names them as a closed
-- exception, because section 2.6 ratified one account per person reaching every company they
-- belong to, and scope columns here would force a user row per tenant.
--
-- They carry no tenant_id, no company_id, and no row level security. They are protected by
-- being reachable only through the authenticated actor's own identity, never by listing and
-- never by a client supplied identifier.
-- ---------------------------------------------------------------------------------------

CREATE TABLE tenants (
    id          uuid        PRIMARY KEY,
    slug        text        NOT NULL,
    name        text        NOT NULL,
    status      text        NOT NULL DEFAULT 'active',
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid,
    version     integer     NOT NULL DEFAULT 1,

    CONSTRAINT tenants_status_check CHECK (status IN ('active', 'suspended')),
    -- Lowercase, url safe, so a tenant slug can appear in a hostname or path later without
    -- normalisation rules being invented at that point.
    CONSTRAINT tenants_slug_format_check CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

CREATE UNIQUE INDEX tenants_slug_key ON tenants (slug);

COMMENT ON COLUMN tenants.created_by IS
    'Null means system provisioning. Platform automation creates the first tenant before any user exists, so this cannot be NOT NULL. Application writes always set it.';

CREATE TABLE users (
    id                   uuid        PRIMARY KEY,
    email                text        NOT NULL,
    -- Nullable because contract section 5.4 anticipates an external identity provider, where
    -- there is no local credential to store. The check below keeps every row authenticable by
    -- at least one means.
    password_hash        text,
    external_subject_id  text,
    name                 text        NOT NULL,
    status               text        NOT NULL DEFAULT 'active',
    last_login_at        timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    created_by           uuid,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    updated_by           uuid,
    version              integer     NOT NULL DEFAULT 1,

    CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled')),
    CONSTRAINT users_authenticable_check
        CHECK (password_hash IS NOT NULL OR external_subject_id IS NOT NULL)
);

-- Case insensitive uniqueness without the citext extension. Addresses are stored as entered
-- so correspondence keeps the user's own capitalisation, but two rows cannot differ by case.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE UNIQUE INDEX users_external_subject_id_key ON users (external_subject_id)
    WHERE external_subject_id IS NOT NULL;

COMMENT ON COLUMN users.email IS
    'Unique across the whole deployment, per contract section 2.6: it identifies the credential, not the membership.';

CREATE TABLE sessions (
    id                 uuid        PRIMARY KEY,
    -- The cookie carries a random opaque token. Only its hash is stored, so a leak of this
    -- table does not yield usable sessions, exactly as a password hash does not yield
    -- passwords. Contract section 5.1 requires the cookie value to be opaque; this makes the
    -- stored side useless to an attacker as well.
    token_hash         text        NOT NULL,
    user_id            uuid        NOT NULL REFERENCES users (id),
    -- The active company, contract section 2.5. Nullable for the window between authenticating
    -- and resolving a company, and for a user whose memberships were all revoked mid-session.
    active_company_id  uuid,
    created_at         timestamptz NOT NULL DEFAULT now(),
    last_seen_at       timestamptz NOT NULL DEFAULT now(),
    -- Two separate expiries, contract section 5.3. Idle is extended on use; absolute never is.
    idle_expires_at    timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    revoked_at         timestamptz,
    ip_address         inet,
    user_agent         text,

    CONSTRAINT sessions_absolute_after_idle_check
        CHECK (absolute_expires_at >= idle_expires_at)
);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
-- Supports the cleanup job that removes dead sessions, and the "log out everywhere" path.
CREATE INDEX sessions_absolute_expires_at_idx ON sessions (absolute_expires_at)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------------------
-- TENANT SCOPED TABLES
--
-- Every one carries tenant_id and company_id, not nullable, leading the indexes that serve
-- list queries. Contract section 4.6.
--
-- Note the composite foreign keys. A child row does not merely reference a company, it
-- references (tenant_id, company_id) together, so a row cannot claim one tenant while pointing
-- at another tenant's company. Referential integrity enforces the boundary rather than trusting
-- the application to pass matching values.
-- ---------------------------------------------------------------------------------------

CREATE TABLE companies (
    id             uuid        PRIMARY KEY,
    tenant_id      uuid        NOT NULL REFERENCES tenants (id),
    name           text        NOT NULL,
    legal_name     text,
    base_currency  char(3)     NOT NULL,
    status         text        NOT NULL DEFAULT 'active',
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid,
    version        integer     NOT NULL DEFAULT 1,

    CONSTRAINT companies_status_check CHECK (status IN ('active', 'archived')),
    CONSTRAINT companies_currency_check CHECK (base_currency ~ '^[A-Z]{3}$'),
    -- The target of every child table's composite foreign key. Redundant with the primary key
    -- on its own, and load bearing in combination with tenant_id.
    CONSTRAINT companies_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX companies_tenant_id_idx ON companies (tenant_id);

-- sessions.active_company_id is added now that companies exists. Deferred rather than declared
-- inline because sessions is created first, being global.
ALTER TABLE sessions
    ADD CONSTRAINT sessions_active_company_id_fkey
    FOREIGN KEY (active_company_id) REFERENCES companies (id);

CREATE TABLE memberships (
    id          uuid        PRIMARY KEY,
    tenant_id   uuid        NOT NULL,
    company_id  uuid        NOT NULL,
    user_id     uuid        NOT NULL REFERENCES users (id),
    status      text        NOT NULL DEFAULT 'active',
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid,
    version     integer     NOT NULL DEFAULT 1,

    CONSTRAINT memberships_status_check CHECK (status IN ('active', 'suspended')),
    CONSTRAINT memberships_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    CONSTRAINT memberships_company_user_key UNIQUE (company_id, user_id),
    CONSTRAINT memberships_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX memberships_tenant_company_idx ON memberships (tenant_id, company_id);
CREATE INDEX memberships_user_id_idx ON memberships (user_id);

COMMENT ON TABLE memberships IS
    'Links a global user to a company, carrying their roles there. Contract section 2.6: membership is the unit a company administrator manages, and roles do not travel between companies.';

CREATE TABLE roles (
    id          uuid        PRIMARY KEY,
    tenant_id   uuid        NOT NULL,
    company_id  uuid        NOT NULL,
    -- Stable machine identifier, for example 'accountant'. Seeded from the templates in
    -- contract section 2.7, then owned by the company and editable.
    key         text        NOT NULL,
    name        text        NOT NULL,
    description text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid,
    version     integer     NOT NULL DEFAULT 1,

    CONSTRAINT roles_key_format_check CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
    CONSTRAINT roles_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    CONSTRAINT roles_company_key_key UNIQUE (company_id, key),
    CONSTRAINT roles_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX roles_tenant_company_idx ON roles (tenant_id, company_id);

CREATE TABLE role_permissions (
    tenant_id   uuid        NOT NULL,
    company_id  uuid        NOT NULL,
    role_id     uuid        NOT NULL,
    -- A capability string from the compiled catalogue, for example 'invoices:post'. There is
    -- deliberately no permissions table: contract section 2.7 rules that the catalogue is code,
    -- and a seeded table would be a second source of truth for something the code defines.
    -- Validity is enforced on write and asserted against the catalogue at startup.
    permission  text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  uuid,

    CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission),
    CONSTRAINT role_permissions_format_check CHECK (permission ~ '^[a-z_]+:[a-z_]+$'),
    CONSTRAINT role_permissions_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    CONSTRAINT role_permissions_role_fkey
        FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX role_permissions_tenant_company_idx ON role_permissions (tenant_id, company_id);

CREATE TABLE membership_roles (
    tenant_id      uuid        NOT NULL,
    company_id     uuid        NOT NULL,
    membership_id  uuid        NOT NULL,
    role_id        uuid        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid,

    CONSTRAINT membership_roles_pkey PRIMARY KEY (membership_id, role_id),
    CONSTRAINT membership_roles_company_fkey
        FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id),
    CONSTRAINT membership_roles_membership_fkey
        FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT membership_roles_role_fkey
        FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX membership_roles_tenant_company_idx ON membership_roles (tenant_id, company_id);
CREATE INDEX membership_roles_role_id_idx ON membership_roles (role_id);

-- ---------------------------------------------------------------------------------------
-- AUDIT
--
-- Contract section 7.3, amended: tenant_id and company_id are nullable on this table alone,
-- because a failed login happens before any company is known and criterion 18 requires it to be
-- audited anyway. The check constraint narrows the gap to the authentication actions only, so a
-- missing company on a document event is a constraint violation rather than a silent hole.
-- ---------------------------------------------------------------------------------------

CREATE TABLE audit_events (
    id             uuid        PRIMARY KEY,
    tenant_id      uuid,
    company_id     uuid,
    occurred_at    timestamptz NOT NULL DEFAULT now(),
    actor_user_id  uuid        REFERENCES users (id),
    -- The actor's roles as they were at the time, not looked up later. Contract section 7.3:
    -- roles change, and a record reporting today's role for last year's action is misleading.
    actor_roles    text[]      NOT NULL DEFAULT '{}',
    action         text        NOT NULL,
    entity_type    text        NOT NULL,
    entity_id      uuid,
    summary        text        NOT NULL,
    -- Structured field changes, contract section 7.2: field path with typed old and new values,
    -- never preformatted display strings. Formatting is a rendering decision and must not be
    -- frozen into a permanent legal record.
    changes        jsonb,
    request_id     text,
    ip_address     inet,
    user_agent     text,
    -- The database transaction the change was written in, so an audit record can be tied to the
    -- exact commit that produced it.
    txid           xid8        NOT NULL DEFAULT pg_current_xact_id(),

    CONSTRAINT audit_events_scope_check CHECK (
        action IN ('logged_in', 'login_failed', 'logged_out', 'session_expired')
        OR (tenant_id IS NOT NULL AND company_id IS NOT NULL)
    )
);

CREATE INDEX audit_events_tenant_company_time_idx
    ON audit_events (tenant_id, company_id, occurred_at DESC);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_user_id, occurred_at DESC);

-- ---------------------------------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- The second of the two isolation layers, contract section 2.4. The first is the scoped
-- repository; neither is permitted to stand alone.
--
-- Context arrives as transaction local settings set by the application from the server side
-- session. `current_setting(..., true)` returns NULL when unset, `nullif` turns an empty string
-- into NULL as well, and comparing anything to NULL yields NULL, which is not true, so a row is
-- not visible. An unset context therefore returns zero rows rather than every row. That
-- direction is the whole point and criterion 31 tests it.
--
-- FORCE is as important as ENABLE. Without it the table owner is exempt from its own policies,
-- and the migration role owns every table here.
-- ---------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_current_company_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;

COMMENT ON FUNCTION app_current_tenant_id() IS
    'Reads the transaction local tenant context. Returns NULL when unset, which makes every policy comparison false and therefore denies. Contract section 2.4.';

-- Tenant only. `companies` and `memberships` must be readable across the companies of a tenant,
-- because that is how a user discovers which companies they may enter and how company switching
-- validates a target. Pinning company here would make the company switch impossible to
-- implement. Company level filtering on these two is the repository's responsibility, and the
-- negative requirement in section 2.10 is covered by criterion 16.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY companies_tenant_isolation ON companies
    USING (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant_isolation ON memberships
    USING (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

-- Tenant and company. Nothing needs to read these across companies.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_tenant_company_isolation ON roles
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_tenant_company_isolation ON role_permissions
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_roles_tenant_company_isolation ON membership_roles
    USING (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id())
    WITH CHECK (tenant_id = app_current_tenant_id() AND company_id = app_current_company_id());

-- Audit rows for authentication carry no tenant, so the policy admits them for insert and
-- restricts reads to the current tenant. An authentication record is readable by platform
-- administration only, which is a separate authority under section 2.8 and not this role.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_isolation ON audit_events
    FOR SELECT
    USING (tenant_id = app_current_tenant_id());
CREATE POLICY audit_events_insert ON audit_events
    FOR INSERT
    WITH CHECK (tenant_id IS NULL OR tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------------------
-- GRANTS
--
-- Explicit per table, contract section 7.1. There is no ALTER DEFAULT PRIVILEGES anywhere in
-- this project, so every right the application holds is a visible line in a reviewed migration.
--
-- Note what is absent as much as what is present:
--   audit_events    INSERT and SELECT only. No UPDATE, no DELETE. This is the append only
--                   guarantee, enforced by the database rather than by application discipline.
--   tenants         SELECT only. Tenants are created by platform administration, section 2.8.
--   no DELETE       on tenants, companies or users, per section 4.5.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
    app_role text := current_setting('app.provision_role', true);
BEGIN
    IF app_role IS NULL OR app_role = '' THEN
        RAISE EXCEPTION 'app.provision_role must be set to the application role name before running this migration';
    END IF;

    EXECUTE format('GRANT SELECT ON tenants TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON users TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON companies TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON role_permissions TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON membership_roles TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT ON audit_events TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO %I', app_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app_current_company_id() TO %I', app_role);
END
$$;
