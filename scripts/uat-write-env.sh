#!/usr/bin/env bash
# Writes the UAT application env file from the caller's environment.
#
# Docker Compose parses env_file values: it interpolates `$`, and an unquoted value
# loses `#` comments, outer quotes, and surrounding spaces. Every caller-supplied
# value is therefore written as a double-quoted string with only `\`, `"`, and `$`
# escaped, which Compose decodes back to the exact original value.
# Fixed settings stay unquoted so scripts/uat-operations.sh can read them with sed.
set -Eeuo pipefail

output=${1:?usage: uat-write-env.sh <output-file>}

required=(
  DATABASE_URL
  BETTER_AUTH_SECRET
  ADMIN_BETTER_AUTH_SECRET
  GOOGLE_CLIENT_SECRET
  S3_ACCESS_KEY_ID
  S3_SECRET_ACCESS_KEY
  XENDIT_SECRET_KEY
  XENDIT_WEBHOOK_TOKEN
  PAYOUT_DESTINATION_ENCRYPTION_KEY
  PAYMENT_PROVIDER_EVENT_ENCRYPTION_KEY
  BETTER_AUTH_URL
  GOOGLE_CLIENT_ID
  S3_ENDPOINT
  S3_REGION
  S3_BUCKET
  CMS_ORIGIN
  TERMS_URL
  PRIVACY_URL
  DATA_USAGE_URL
  CONTACT_US_URL
)
optional=(
  PAYOUT_DESTINATION_ENCRYPTION_KEY_VERSION
  PAYMENT_PROVIDER_EVENT_ENCRYPTION_KEY_VERSION
  ANDROID_APP_LINK_TARGETS
  IOS_APP_LINK_APP_IDS
)

fail() {
  printf 'UAT env file not written: %s\n' "$*" >&2
  exit 1
}

for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || fail "missing GitHub secret or variable: $name"
done

for name in "${required[@]}" "${optional[@]}"; do
  value=${!name:-}
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
    fail "value contains a line break: $name"
done

[[ "$S3_BUCKET" != 'kuquest-uploads' ]] || fail 'UAT must not use the Staging bucket kuquest-uploads'

escape_value() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\\\$}
  printf '%s' "$value"
}

emit() {
  printf '%s="%s"\n' "$1" "$(escape_value "${!1}")"
}

umask 077
{
  printf 'NODE_ENV=production\n'
  printf 'DEPLOYMENT_ENV=uat\n'
  printf 'HOST=0.0.0.0\n'
  printf 'PORT=5000\n'
  printf 'STAGING_TEST_AUTH_ENABLED=false\n'
  printf 'LOCAL_FINANCE_TEST_ENABLED=false\n'

  for name in "${required[@]}"; do
    emit "$name"
  done

  PAYOUT_DESTINATION_ENCRYPTION_KEY_VERSION=${PAYOUT_DESTINATION_ENCRYPTION_KEY_VERSION:-v1}
  PAYMENT_PROVIDER_EVENT_ENCRYPTION_KEY_VERSION=${PAYMENT_PROVIDER_EVENT_ENCRYPTION_KEY_VERSION:-v1}
  for name in "${optional[@]}"; do
    [[ -z "${!name:-}" ]] || emit "$name"
  done
} >"$output"
