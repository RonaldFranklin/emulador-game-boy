#!/bin/sh
# Explicit maintenance/fresh installation only. Never called by the running API.
set -eu
PGPASSWORD="$(cat /run/secrets/postgres_password)"
RUNTIME_DB_PASSWORD="$(cat /run/secrets/runtime_db_password)"
export PGPASSWORD RUNTIME_DB_PASSWORD
psql --username "${POSTGRES_USER:-postgres}" --dbname "${PGDATABASE:-${POSTGRES_DB:-emulador}}" --set ON_ERROR_STOP=1 <<'SQL'
\getenv runtime_password RUNTIME_DB_PASSWORD
SELECT format('CREATE ROLE emulador_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='emulador_runtime') \gexec
DO $$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='emulador_runtime' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 OR EXISTS(SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='emulador_runtime'))
 OR EXISTS(SELECT FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname='emulador_runtime'))
 OR EXISTS(SELECT FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname='emulador_runtime'))
 OR EXISTS(SELECT FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname='emulador_runtime'))
 THEN RAISE EXCEPTION 'Papel runtime existente possui privilégios inesperados'; END IF;
END $$;
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO emulador_runtime', current_database()) \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO emulador_runtime;
SQL
unset PGPASSWORD RUNTIME_DB_PASSWORD
