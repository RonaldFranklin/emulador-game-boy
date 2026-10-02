#!/bin/sh
set -eu
APP_DB_PASSWORD="$(cat /run/secrets/app_db_password)"
export APP_DB_PASSWORD
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password APP_DB_PASSWORD
CREATE ROLE emulador LOGIN PASSWORD :'app_password';
ALTER DATABASE emulador OWNER TO emulador;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO emulador;
SQL
unset APP_DB_PASSWORD
# This file runs only for a new data directory. Upgrade uses the explicit
# provision-runtime service before migration 010, after a verified backup.
sh /opt/emulador/provision-runtime.sh
