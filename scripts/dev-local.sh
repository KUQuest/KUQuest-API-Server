#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shared_env="$repo_dir/../../.env"

if [[ ! -f "$shared_env" ]]; then
  echo "Missing shared environment file: $shared_env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090 -- the shared environment path is resolved above.
source "$shared_env"
set +a

export DATABASE_URL="${KUQUEST_DATABASE_URL:-postgresql://kuquest_app:app-local-only@localhost:5432/kuquest}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:5000}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-local-development-only-secret-change-me}"
export CMS_ORIGIN="${CMS_ORIGIN:-http://localhost:5000}"

: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID in $shared_env}"
: "${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET in $shared_env}"

cd "$repo_dir"
exec bun --watch src/index.ts
