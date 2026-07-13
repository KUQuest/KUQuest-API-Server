#!/bin/sh
set -eu

required_variables='POSTGRES_DB KUQUEST_TEST_DB KUQUEST_MIGRATOR_PASSWORD KUQUEST_APP_PASSWORD'

for variable_name in $required_variables; do
  eval "variable_value=\${$variable_name:-}"
  if [ -z "$variable_value" ]; then
    echo "Missing required database bootstrap variable: $variable_name" >&2
    exit 1
  fi
done

case "$POSTGRES_DB:$KUQUEST_TEST_DB" in
  *[!a-zA-Z0-9_:]*)
    echo 'Database and role names may contain only letters, numbers, and underscores' >&2
    exit 1
    ;;
esac

psql --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=migrator_user=kuquest_migrator \
  --set=migrator_password="$KUQUEST_MIGRATOR_PASSWORD" \
  --set=app_user=kuquest_app \
  --set=app_password="$KUQUEST_APP_PASSWORD" <<'SQL'
CREATE ROLE :"migrator_user" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'migrator_password';
CREATE ROLE :"app_user" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
SQL

createdb \
  --username "$POSTGRES_USER" \
  --owner kuquest_migrator \
  "$KUQUEST_TEST_DB"

configure_database() {
  database_name=$1

  psql --set ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$database_name" \
    --set=database_name="$database_name" \
    --set=migrator_user=kuquest_migrator \
    --set=app_user=kuquest_app <<'SQL'
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"database_name" TO :"migrator_user";
GRANT CONNECT ON DATABASE :"database_name" TO :"app_user";

ALTER SCHEMA public OWNER TO :"migrator_user";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO :"migrator_user";
GRANT USAGE ON SCHEMA public TO :"app_user";

-- Table-specific runtime grants are applied by the reviewed security migration.
-- Do not grant broad default DML here: future tables must be deliberately exposed.
SQL
}

psql --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname postgres \
  --set=database_name="$POSTGRES_DB" \
  --set=migrator_user=kuquest_migrator <<'SQL'
ALTER DATABASE :"database_name" OWNER TO :"migrator_user";
SQL

configure_database "$POSTGRES_DB"
configure_database "$KUQUEST_TEST_DB"
