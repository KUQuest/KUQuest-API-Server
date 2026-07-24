#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd "$script_dir/.." && pwd)
test_directory=$(mktemp -d "${TMPDIR:-/tmp}/kuquest-bootstrap-test.XXXXXX")
test_id="kuquest-bootstrap-test-$$"
database_container="$test_id-database"
test_image=${KUQUEST_BOOTSTRAP_TEST_IMAGE:-kuquest-api:bootstrap-test}

cleanup() {
  docker stop "$database_container" >/dev/null 2>&1 || true
  docker network rm "$test_id" >/dev/null 2>&1 || true

  if [[ "$test_directory" == */kuquest-bootstrap-test.* ]]; then
    find "$test_directory" -depth -delete
  fi
}
trap cleanup EXIT

install -d -m 700 "$test_directory/backups"
umask 077

printf '%s\n' \
  'DATABASE_URL=postgresql://kuquest:bootstrap-only@database:5432/kuquest' \
  > "$test_directory/.env"

# The Compose fixture must receive these interpolation expressions literally.
# shellcheck disable=SC2016
printf '%s\n' \
  'services:' \
  '  api:' \
  '    image: ${APP_IMAGE}' \
  '    pull_policy: never' \
  '    env_file:' \
  '      - .env' \
  '' \
  'networks:' \
  '  default:' \
  '    name: ${STAGING_NETWORK}' \
  '    external: true' \
  > "$test_directory/compose.yml"

docker build --tag "$test_image" "$repository_root"
docker network create "$test_id" >/dev/null
docker run \
  --detach \
  --rm \
  --name "$database_container" \
  --network "$test_id" \
  --network-alias database \
  --env POSTGRES_DB=kuquest \
  --env POSTGRES_PASSWORD=bootstrap-only \
  --env POSTGRES_USER=kuquest \
  postgres:17-alpine >/dev/null

for attempt in $(seq 1 30); do
  if docker exec "$database_container" \
    pg_isready -U kuquest -d kuquest >/dev/null; then
    break
  fi

  if [[ "$attempt" -eq 30 ]]; then
    docker logs "$database_container"
    exit 1
  fi

  sleep 1
done

printf '%s\n' 'RESET staging public schema' |
  APP_IMAGE="$test_image" \
  STAGING_DIR="$test_directory" \
  ENV_FILE="$test_directory/.env" \
  BACKUP_DIR="$test_directory/backups" \
  STAGING_NETWORK="$test_id" \
  bash "$script_dir/staging-operations.sh" bootstrap

mapfile -t backups < <(
  find "$test_directory/backups" \
    -maxdepth 1 \
    -type f \
    -name 'kuquest-*.dump' \
    -print
)

if (( ${#backups[@]} != 1 )); then
  printf 'Expected one verified bootstrap backup, found %d.\n' \
    "${#backups[@]}" >&2
  exit 1
fi

docker run \
  --rm \
  --volume "$test_directory/backups:/backups:ro" \
  postgres:17-alpine \
  pg_restore \
  --list \
  "/backups/$(basename "${backups[0]}")" >/dev/null

printf 'Disposable PostgreSQL 17 bootstrap verification passed.\n'
