#!/bin/sh
# Creates the two database roles the application design depends on.
#
# Architecture contract section 7.1, ratified: an owning role that runs migrations and holds
# DDL rights, and a restricted application role the API connects as.
#
# NEITHER OF THEM IS A SUPERUSER, and that is the point of this script rather than an
# incidental detail. A superuser bypasses row level security entirely, even on a table with
# FORCE ROW LEVEL SECURITY. If the role that owns and seeds the schema were a superuser, then
# every policy would be unenforced for it, seeded rows would skip WITH CHECK validation, and any
# test written against that role would pass whether the policies worked or not. The second
# isolation layer required by section 2.4 would be present in the catalogue and absent in
# practice.
#
# POSTGRES_USER, created by the image, is a superuser. It is used here to provision and then
# never again: it is not a connection string anything else holds.
#
# This runs only when the data volume is first initialised. After changing it, run
# `npm run db:reset` rather than `npm run db:up`, or the change will not be applied.

set -eu

: "${MIGRATION_DB_USER:?MIGRATION_DB_USER must be set}"
: "${MIGRATION_DB_PASSWORD:?MIGRATION_DB_PASSWORD must be set}"
: "${APP_DB_USER:?APP_DB_USER must be set}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
	-- ---------------------------------------------------------------------------------
	-- Owning role. Runs migrations, owns every object, holds DDL rights.
	-- ---------------------------------------------------------------------------------
	CREATE ROLE "$MIGRATION_DB_USER"
	    LOGIN
	    PASSWORD '$MIGRATION_DB_PASSWORD'
	    NOSUPERUSER
	    NOCREATEDB
	    NOCREATEROLE
	    NOBYPASSRLS;

	COMMENT ON ROLE "$MIGRATION_DB_USER" IS
	    'Owning role. Runs migrations and owns the schema. Not a superuser, so FORCE ROW LEVEL SECURITY applies to it and the policies are genuinely enforceable. See architecture contract 2.4 and 7.1.';

	-- Ownership is what gives it DDL rights without superuser. In PostgreSQL 15 and later the
	-- public schema is owned by pg_database_owner, which resolves to whoever owns the database,
	-- so transferring the database carries the schema with it. The explicit ALTER SCHEMA below
	-- is belt and braces for clarity rather than necessity.
	ALTER DATABASE "$POSTGRES_DB" OWNER TO "$MIGRATION_DB_USER";
	ALTER SCHEMA public OWNER TO "$MIGRATION_DB_USER";

	-- ---------------------------------------------------------------------------------
	-- Application role. Owns nothing, creates nothing.
	-- ---------------------------------------------------------------------------------
	CREATE ROLE "$APP_DB_USER"
	    LOGIN
	    PASSWORD '$APP_DB_PASSWORD'
	    NOSUPERUSER
	    NOCREATEDB
	    NOCREATEROLE
	    NOBYPASSRLS
	    NOINHERIT;

	COMMENT ON ROLE "$APP_DB_USER" IS
	    'Application role. Owns nothing, creates nothing, and receives table rights only through explicit grants in migrations. See architecture contract 2.4 and 7.1.';

	GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO "$APP_DB_USER";
	GRANT USAGE ON SCHEMA public TO "$APP_DB_USER";

	-- Nobody creates objects in public except the owner. PostgreSQL 15 and later already
	-- revoke this from PUBLIC by default; stated here so the guarantee does not depend on a
	-- server version default.
	REVOKE CREATE ON SCHEMA public FROM PUBLIC;

	-- Deliberately no ALTER DEFAULT PRIVILEGES. Every table grant is written explicitly in the
	-- migration that creates the table, so that the audit table receiving INSERT and SELECT and
	-- nothing else is a visible line in a reviewed migration rather than an exception carved
	-- out of a blanket grant nobody reads.
SQL

echo "Created roles: '$MIGRATION_DB_USER' owns the schema, '$APP_DB_USER' connects. Neither is a superuser."
