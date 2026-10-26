#!/bin/bash
# Creates the non-superuser app roles used for row-level security enforcement,
# and grants them schema/table access. Runs only on first database init
# (docker-entrypoint-initdb.d), after init.sql has created the baseline schema.
#
# Roles are only created when their password env var is provided, so deployments
# that don't use RLS enforcement (or rely on a previously-provisioned DB) are
# unaffected. Everything is idempotent.
set -euo pipefail

_db="${POSTGRES_DB:-prysm_note}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

# Extensions need a superuser (the postgres image's POSTGRES_USER). Creating
# them here means the server's own provisioning, which runs as a non-superuser
# app/system role, never hits "permission denied to create extension".
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$_db" -c "
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";
"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$_db" -c "
  GRANT CREATE ON DATABASE $_db TO prysm_app;
  GRANT CREATE ON DATABASE $_db TO prysm_system;
" >/dev/null 2>&1 || true

if [[ -n "${DB_APP_PASSWORD:-}" ]]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$_db" -c "
    DO \$\$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='prysm_app') THEN
        CREATE ROLE prysm_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${DB_APP_PASSWORD}';
      END IF;
    END \$\$;
  "
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$_db" -c "
    GRANT CONNECT ON DATABASE $_db TO prysm_app;
    GRANT USAGE, CREATE ON SCHEMA public TO prysm_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prysm_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prysm_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO prysm_app;
    -- Allow the app role to create tables that reference users via FK (needed by EE tables created at boot).
    DO \$\$ BEGIN
      IF to_regclass('public.users') IS NOT NULL THEN
        EXECUTE 'GRANT REFERENCES ON TABLE public.users TO prysm_app';
      END IF;
    END \$\$;
  "
  # The app role owns the schema objects so startup create_all, Alembic migrations,
  # and idempotent ALTERs can run as the app role. Ownership does NOT grant
  # BYPASSRLS, so row-level security is still enforced on its connection.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$_db" -c "
    DO \$\$ DECLARE r RECORD;
    BEGIN
      FOR r IN
        SELECT 'ALTER TABLE ' || quote_ident(schemaname) || '.' || quote_ident(tablename) || ' OWNER TO prysm_app' AS q
        FROM pg_tables WHERE schemaname = 'public'
        UNION ALL
        SELECT 'ALTER SEQUENCE ' || quote_ident(sequence_schema) || '.' || quote_ident(sequence_name) || ' OWNER TO prysm_app'
        FROM information_schema.sequences WHERE sequence_schema = 'public'
      LOOP EXECUTE r.q; END LOOP;
    END \$\$;
    DO \$\$ BEGIN
      IF to_regprocedure('public.rls_user_id()') IS NOT NULL THEN
        EXECUTE 'ALTER FUNCTION public.rls_user_id() OWNER TO prysm_app';
      END IF;
    END \$\$;
  "
fi

if [[ -n "${DB_SYSTEM_PASSWORD:-}" ]]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$_db" -c "
    DO \$\$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='prysm_system') THEN
        CREATE ROLE prysm_system LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${DB_SYSTEM_PASSWORD}';
      END IF;
    END \$\$;
  "
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$_db" -c "
    GRANT CONNECT ON DATABASE $_db TO prysm_system;
    GRANT USAGE, CREATE ON SCHEMA public TO prysm_system;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prysm_system;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prysm_system;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO prysm_system;
  "
fi

# Tables are created at runtime by the app role (startup create_all + Alembic),
# so the one-time GRANT ... ON ALL TABLES above does not cover them and the
# BYPASSRLS system role gets "permission denied for table <new_table>". Set
# default privileges so every object the app role creates is automatically
# usable by the system role. Needs both roles to exist.
if [[ -n "${DB_APP_PASSWORD:-}" && -n "${DB_SYSTEM_PASSWORD:-}" ]]; then
  # The server provisions its schema on first boot through the SYSTEM pool, and
  # Postgres refuses schema-changing DDL ("must be owner of table users") to a
  # role that neither owns the table nor is a member of the owner. Membership
  # grants the ownership check without handing the app role BYPASSRLS.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$_db" -c "
    GRANT prysm_app TO prysm_system;
  "
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$_db" -c "
    ALTER DEFAULT PRIVILEGES FOR ROLE prysm_app IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prysm_system;
    ALTER DEFAULT PRIVILEGES FOR ROLE prysm_app IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO prysm_system;
    ALTER DEFAULT PRIVILEGES FOR ROLE prysm_app IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO prysm_system;
    -- The other direction matters for a fresh database: the server provisions
    -- the embedded schema through the SYSTEM pool, so those objects are
    -- system-owned and the app role needs access to them (RLS still applies to
    -- the app role, which never gets BYPASSRLS).
    ALTER DEFAULT PRIVILEGES FOR ROLE prysm_system IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prysm_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE prysm_system IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO prysm_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE prysm_system IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO prysm_app;
  "
fi
