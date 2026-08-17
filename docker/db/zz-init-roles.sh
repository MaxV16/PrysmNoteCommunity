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
    GRANT REFERENCES ON TABLE users TO prysm_app;
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
    ALTER FUNCTION rls_user_id() OWNER TO prysm_app;
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
