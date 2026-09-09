#!/bin/sh
# Creates the restricted application role.
#
# Architecture contract section 7.1, ratified: two database roles from the first migration.
# The role that owns objects and runs migrations is POSTGRES_USER, created by the image.
# This script adds the role the API actually connects as.
#
# The separation is the security boundary. An owner can always grant itself back whatever was
# revoked, so an application connecting as the owner could rewrite the audit table no matter
# what the grants say. Section 2.4 adds a second reason: a table owner is exempt from its own
# row level security policies, so an application connecting as owner would silently lose the
# second isolation layer.
#
# This runs only when the data volume is first initialised. After changing it, run
# `npm run db:reset` rather than `npm run db:up`, or the change will not be applied.

set -eu

: "${APP_DB_USER:?APP_DB_USER must be set}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
	-- NOSUPERUSER and NOCREATEDB are the defaults for CREATE ROLE, and NOBYPASSRLS is too.
	-- They are stated explicitly because they are the point of this role, not incidental.
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

	-- Deliberately no ALTER DEFAULT PRIVILEGES. Every table grant is written explicitly in the
	-- migration that creates the table, so that the audit table receiving INSERT and SELECT and
	-- nothing else is a visible line in a reviewed migration rather than an exception carved
	-- out of a blanket grant nobody reads.
SQL

echo "Created application role '$APP_DB_USER' with no ownership, no DDL rights and no RLS bypass."
