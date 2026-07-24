#!/usr/bin/env bash
set -Eeuo pipefail

operation=${1:-}
staging_dir=${STAGING_DIR:-/opt/backend}
environment_file=${ENV_FILE:-"$staging_dir/.env"}
backup_dir=${BACKUP_DIR:-"$staging_dir/backups"}
staging_network=${STAGING_NETWORK:-kuquest-staging_default}
postgres_image=${POSTGRES_CLIENT_IMAGE:-postgres:17-alpine}

fail() {
  printf 'Staging operation failed: %s\n' "$*" >&2
  exit 1
}

read_database_url() {
  local value

  value=$(sed -n 's/^DATABASE_URL=//p' "$environment_file" | tail -n 1)
  if [[ -z "$value" ]]; then
    fail "DATABASE_URL is missing from $environment_file"
  fi

  printf '%s' "$value"
}

backup_contents_are_valid() {
  local backup_name=$1

  docker run \
    --rm \
    --volume "$backup_dir:/backups:ro" \
    "$postgres_image" \
    pg_restore \
    --list \
    "/backups/$backup_name" >/dev/null
}

create_verified_backup() {
  local database_url=$1
  local backup_name
  local partial_name
  backup_name="kuquest-$(date -u +%Y%m%dT%H%M%SZ).dump"
  partial_name="$backup_name.partial"

  install -d -m 700 "$backup_dir"
  umask 077

  if ! DATABASE_URL=$database_url docker run \
    --rm \
    --network "$staging_network" \
    --env DATABASE_URL \
    --volume "$backup_dir:/backups" \
    "$postgres_image" \
    sh \
    -c \
    'exec pg_dump --dbname "$DATABASE_URL" -Fc --file "$1"' \
    _ \
    "/backups/$partial_name"; then
    if [[ -e "$backup_dir/$partial_name" ]]; then
      rm -- "$backup_dir/$partial_name"
    fi
    printf 'Backup creation failed.\n' >&2
    return 1
  fi

  if [[ ! -s "$backup_dir/$partial_name" ]]; then
    rm -- "$backup_dir/$partial_name"
    printf 'Backup file is missing or empty.\n' >&2
    return 1
  fi

  if ! backup_contents_are_valid "$partial_name"; then
    rm -- "$backup_dir/$partial_name"
    printf 'Backup contents failed restore validation.\n' >&2
    return 1
  fi

  mv -- "$backup_dir/$partial_name" "$backup_dir/$backup_name"

  local backup_candidates=()
  local valid_backups=()
  mapfile -t backup_candidates < <(
    find "$backup_dir" \
      -maxdepth 1 \
      -type f \
      -name 'kuquest-*.dump' \
      -printf '%f\n' |
      sort --reverse
  )

  local candidate
  for candidate in "${backup_candidates[@]}"; do
    if [[ "$candidate" == "$backup_name" ]]; then
      valid_backups+=("$candidate")
    elif [[ -s "$backup_dir/$candidate" ]] &&
      backup_contents_are_valid "$candidate"; then
      valid_backups+=("$candidate")
    else
      rm -- "$backup_dir/$candidate"
    fi
  done

  if (( ${#valid_backups[@]} > 2 )); then
    local expired_backup
    for expired_backup in "${valid_backups[@]:2}"; do
      rm -- "$backup_dir/$expired_backup"
    done
  fi

  printf '%s\n' "$backup_dir/$backup_name"
}

rollout_api() {
  docker compose up \
    -d \
    --no-deps \
    --remove-orphans \
    --wait \
    --wait-timeout 60 \
    api
}

report_bootstrap_failure() {
  local status=$?
  trap - ERR
  printf 'Bootstrap failed; restore from %s\n' "$recovery_backup" >&2
  exit "$status"
}

report_deployment_failure() {
  local status=$?
  trap - ERR
  printf \
    'Deployment stopped during %s; current API was not replaced.\n' \
    "$deployment_stage" >&2
  exit "$status"
}

prepare_operation() {
  [[ -n "${APP_IMAGE:-}" ]] || fail 'APP_IMAGE is required'
  [[ -f "$environment_file" ]] ||
    fail "environment file does not exist: $environment_file"

  cd "$staging_dir"
  export APP_IMAGE
}

deploy() {
  prepare_operation

  local database_url
  local current_container
  local deployment_stage
  local previous_image=
  database_url=$(read_database_url)

  current_container=$(docker compose ps -q api)
  if [[ -n "$current_container" ]]; then
    previous_image=$(docker inspect --format '{{.Config.Image}}' "$current_container")
  fi

  trap report_deployment_failure ERR
  deployment_stage=pull
  docker compose pull api
  deployment_stage=backup
  create_verified_backup "$database_url" >/dev/null
  deployment_stage=migration
  docker compose run --rm --no-deps api bun run db:migrate
  trap - ERR

  local rollout_status
  set +e
  rollout_api
  rollout_status=$?
  set -e

  if (( rollout_status != 0 )); then
    printf 'New API image failed readiness: %s\n' "$APP_IMAGE" >&2

    if [[ -z "$previous_image" ]]; then
      fail 'no previous API image is available for rollback'
    fi

    APP_IMAGE=$previous_image
    export APP_IMAGE

    local restore_status
    set +e
    rollout_api
    restore_status=$?
    set -e

    if (( restore_status != 0 )); then
      fail "rollback also failed; previous image was $previous_image"
    fi

    docker compose ps api
    printf 'Previous API image restored: %s\n' "$previous_image" >&2
    return "$rollout_status"
  fi

  docker compose ps api
  printf 'Staging deployment succeeded: %s\n' "$APP_IMAGE"
}

bootstrap() {
  prepare_operation

  local database_url
  local recovery_backup
  database_url=$(read_database_url)

  docker compose pull api
  recovery_backup=$(create_verified_backup "$database_url")
  trap report_bootstrap_failure ERR

  printf '%s\n' \
    'This one-time operation will drop and recreate only the staging database public schema.' \
    'PostgreSQL roles, the server, and other databases are not changed.' \
    'Type exactly: RESET staging public schema' >&2

  local confirmation
  read -r confirmation
  if [[ "$confirmation" != 'RESET staging public schema' ]]; then
    fail "confirmation did not match; no schema reset was performed. Backup: $recovery_backup"
  fi

  DATABASE_URL=$database_url docker run \
    --rm \
    --network "$staging_network" \
    --env DATABASE_URL \
    "$postgres_image" \
    sh \
    -c \
    'exec psql --dbname "$DATABASE_URL" --set=ON_ERROR_STOP=1 --command "$1"' \
    _ \
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'

  docker compose run --rm --no-deps api bun run db:migrate

  local verification
  verification=$(
    DATABASE_URL=$database_url docker run \
      --rm \
      --network "$staging_network" \
      --env DATABASE_URL \
      "$postgres_image" \
      sh \
      -c \
      'exec psql --dbname "$DATABASE_URL" --tuples-only --no-align --command "$1"' \
      _ \
      "SELECT CASE WHEN
         to_regclass('public.user') IS NOT NULL AND
         to_regclass('public.account') IS NOT NULL AND
         to_regclass('public.session') IS NOT NULL AND
         to_regclass('public.verification') IS NOT NULL AND
         to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
       THEN 'ok' ELSE 'missing' END;"
  )

  if [[ "$verification" != 'ok' ]]; then
    fail "bootstrap verification failed; restore from $recovery_backup"
  fi

  local expected_journal_count
  expected_journal_count=$(
    docker compose run \
      --rm \
      --no-deps \
      api \
      bun \
      -e \
      'const journal = await Bun.file("drizzle/meta/_journal.json").json(); console.log(journal.entries.length);'
  )

  if [[ ! "$expected_journal_count" =~ ^[0-9]+$ ]] ||
    (( expected_journal_count == 0 )); then
    fail "unable to read the image migration journal; restore from $recovery_backup"
  fi

  local applied_journal_count
  applied_journal_count=$(
    DATABASE_URL=$database_url docker run \
      --rm \
      --network "$staging_network" \
      --env DATABASE_URL \
      "$postgres_image" \
      sh \
      -c \
      'exec psql --dbname "$DATABASE_URL" --tuples-only --no-align --command "$1"' \
      _ \
      'SELECT count(*) FROM drizzle.__drizzle_migrations;'
  )

  if [[ "$applied_journal_count" != "$expected_journal_count" ]]; then
    fail "migration journal is incomplete; restore from $recovery_backup"
  fi

  trap - ERR
  printf 'Staging schema bootstrap succeeded. Recovery backup: %s\n' \
    "$recovery_backup"
}

case "$operation" in
  bootstrap)
    bootstrap
    ;;
  deploy)
    deploy
    ;;
  *)
    fail 'usage: staging-operations.sh <bootstrap|deploy>'
    ;;
esac
