#!/usr/bin/env bash
# UAT release operations. UAT data persists between releases: this script never
# resets or seeds a database and never prunes Docker images host-wide.
set -Eeuo pipefail

operation=${1:-}
uat_dir=${UAT_DIR:-/opt/backend}
environment_file=${ENV_FILE:-"$uat_dir/.env"}
backup_dir=${BACKUP_DIR:-"$uat_dir/backups"}
release_dir=${RELEASE_DIR:-"$uat_dir/releases"}
uat_database_host=${UAT_DATABASE_HOST:-192.168.1.103}
container=${API_CONTAINER:-kuquest-uat-api}
postgres_image=${POSTGRES_CLIENT_IMAGE:-}
api_image_pattern='^ghcr\.io/kuquest/kuquest-api-server:[0-9a-f]{40}$'

fail() {
  printf 'UAT operation failed: %s\n' "$*" >&2
  exit 1
}

read_environment_value() {
  sed -n "s/^${1}=//p" "$environment_file" | tail -n 1
}

prepare_operation() {
  [[ "${APP_IMAGE:-}" =~ $api_image_pattern ]] ||
    fail 'APP_IMAGE must be ghcr.io/kuquest/kuquest-api-server:<40-character commit SHA>'
  [[ -n "$postgres_image" ]] || fail 'POSTGRES_CLIENT_IMAGE is required'
  [[ -f "$environment_file" ]] || fail "environment file does not exist: $environment_file"

  [[ "$(read_environment_value NODE_ENV)" == 'production' ]] ||
    fail "NODE_ENV=production is required in $environment_file"
  [[ "$(read_environment_value DEPLOYMENT_ENV)" == 'uat' ]] ||
    fail "DEPLOYMENT_ENV=uat is required in $environment_file"
  [[ "$(read_environment_value STAGING_TEST_AUTH_ENABLED)" != 'true' ]] ||
    fail 'STAGING_TEST_AUTH_ENABLED must not be true in UAT'

  cd "$uat_dir"
  export APP_IMAGE
  docker compose config --quiet
}

# The env file stores quoted, escaped values. Ask Compose for the exact value the
# API receives instead of parsing the file here, then check it before any release step.
resolve_database_url() {
  database_url=$(
    docker compose run --rm --no-deps -T api \
      bun -e 'process.stdout.write(process.env.DATABASE_URL ?? "")' </dev/null
  )
  [[ "$database_url" == *"@${uat_database_host}:5432/"* ]] ||
    fail "DATABASE_URL must point to the UAT database host $uat_database_host"
}

backup_contents_are_valid() {
  docker run --rm --volume "$backup_dir:/backups:ro" "$postgres_image" \
    pg_restore --list "/backups/$1" >/dev/null
}

create_verified_backup() {
  local backup_name partial_name
  backup_name="kuquest-$(date -u +%Y%m%dT%H%M%SZ).dump"
  partial_name="$backup_name.partial"

  install -d -m 700 "$backup_dir"
  umask 077

  if ! DATABASE_URL=$database_url docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env DATABASE_URL \
    --volume "$backup_dir:/backups" \
    "$postgres_image" \
    sh -c 'exec pg_dump --dbname "$DATABASE_URL" -Fc --file "$1"' _ "/backups/$partial_name"; then
    rm -f -- "$backup_dir/$partial_name"
    fail 'backup creation failed'
  fi

  if [[ ! -s "$backup_dir/$partial_name" ]] || ! backup_contents_are_valid "$partial_name"; then
    rm -f -- "$backup_dir/$partial_name"
    fail 'backup is empty or failed restore validation'
  fi

  mv -- "$backup_dir/$partial_name" "$backup_dir/$backup_name"

  # Keep the five newest backups; remove only files this script created.
  find "$backup_dir" -maxdepth 1 -type f -name 'kuquest-*.dump' -printf '%f\n' |
    sort --reverse | tail -n +6 | while read -r expired; do
      rm -- "$backup_dir/$expired"
    done

  backup_path="$backup_dir/$backup_name"
  printf 'Backup created: %s\n' "$backup_path"
}

running_image() {
  docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true
}

rollout_api() {
  docker compose up -d --no-deps --remove-orphans --wait --wait-timeout 90 api
}

record_release() {
  install -d -m 700 "$release_dir"
  printf '%s\n' "$APP_IMAGE" >"$release_dir/current"
  printf '%s %s %s previous=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$APP_IMAGE" \
    "${previous_image:-none}" >>"$release_dir/history.log"
}

# Replace the API only after backup and (for deploy) migration succeed.
release() {
  local mode=$1
  local stage=pull
  local rollout_status restore_status

  # One release at a time on this host, independent of the workflow concurrency group.
  install -d -m 700 "$release_dir"
  exec 9>"$release_dir/.lock"
  flock --nonblock 9 || fail 'another UAT release is running'

  prepare_operation
  previous_image=$(running_image)

  trap 'printf "UAT %s stopped during %s; the running API was not replaced. Pre-release backup: %s\n" "$mode" "$stage" "${backup_path:-none}" >&2' ERR

  docker compose pull api
  stage=database-check
  resolve_database_url
  stage=backup
  create_verified_backup

  if [[ "$mode" == 'deploy' ]]; then
    stage=migration
    docker compose run --rm --no-deps api bun run db:migrate
    stage=migration-verification
    docker compose run --rm --no-deps api bun run db:verify-migration-journal
  else
    printf 'Rollback mode: migrations are NOT run and the database schema is NOT reverted.\n' >&2
  fi
  trap - ERR

  set +e
  rollout_api
  rollout_status=$?
  set -e

  if ((rollout_status != 0)); then
    printf 'New API image failed readiness: %s\n' "$APP_IMAGE" >&2
    docker compose logs --no-color --tail 200 api >&2 || true
    [[ -n "$previous_image" ]] || fail 'no previous API image is available to restore'

    APP_IMAGE=$previous_image
    export APP_IMAGE
    set +e
    rollout_api
    restore_status=$?
    set -e
    ((restore_status == 0)) || fail "restore also failed; previous image was $previous_image"
    printf 'Previous API image restored: %s\n' "$previous_image" >&2
    printf 'The database schema was NOT reverted. Restore from %s only after review.\n' "$backup_path" >&2
    return "$rollout_status"
  fi

  docker compose ps api
  record_release "$mode"
  printf 'UAT %s succeeded: %s (previous: %s)\n' "$mode" "$APP_IMAGE" "${previous_image:-none}"
}

case "$operation" in
  deploy | rollback) release "$operation" ;;
  *) fail 'usage: uat-operations.sh <deploy|rollback>' ;;
esac
