#!/usr/bin/env bash
set -Eeuo pipefail

PORT="${PORT:-5000}"
LOCAL_URL="http://localhost:${PORT}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

if ! curl --silent --show-error --fail --max-time 3 "${LOCAL_URL}/health" >/dev/null 2>&1; then
  echo "KUQuest is not reachable at ${LOCAL_URL}/health"
  echo "Start it first in another terminal: bun run dev"
  exit 1
fi

echo "Starting a temporary Cloudflare Quick Tunnel for ${LOCAL_URL}"
echo "Keep this terminal open while Xendit sends test webhooks."
echo
echo "The helper will print copy-ready URLs as soon as cloudflared creates the tunnel."
echo "Configure both webhook URLs in Xendit test mode with the same verification token as XENDIT_WEBHOOK_TOKEN."
echo "Keep Google OAuth and the browser on ${LOCAL_URL}; do not add the temporary host as a Google callback."
echo "Stop with Ctrl+C. The temporary URL changes whenever this command starts."
echo

cloudflared tunnel --url "${LOCAL_URL}" --no-autoupdate 2>&1 | while IFS= read -r line; do
  echo "${line}"
  if [[ "${line}" =~ (https://[a-zA-Z0-9-]+\.trycloudflare\.com) ]]; then
    PUBLIC_ORIGIN="${BASH_REMATCH[1]}"
    echo
    echo "Tunnel ready. Copy these values:"
    echo "  PUBLIC_API_URL=${PUBLIC_ORIGIN}"
    echo "  Payment webhook: ${PUBLIC_ORIGIN}/v1/webhooks/xendit/payments"
    echo "  Payout webhook:  ${PUBLIC_ORIGIN}/v1/webhooks/xendit/payouts"
    echo
  fi
done
