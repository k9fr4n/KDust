#!/usr/bin/env bash
# pwpush preview: GET /p/:url_token/preview.json. Read-only, no view consumed.
set -euo pipefail

[ $# -eq 1 ] || { echo "Usage: $0 <url_token>" >&2; exit 2; }
: "${PASSWORDPUSHER_TOKEN:?missing PASSWORDPUSHER_TOKEN}"

URL_TOKEN="$1"
[[ "$URL_TOKEN" =~ ^[A-Za-z0-9_-]{4,64}$ ]] || { echo "invalid url_token format" >&2; exit 2; }

BASE_URL="${PASSWORDPUSHER_URL:-https://passwordpusher.ecritel.net}"
BASE_URL="${BASE_URL%/}"
EMAIL="${PASSWORDPUSHER_EMAIL:-admin@ecritel.net}"

RESP="$(curl -fsS -X GET "$BASE_URL/p/$URL_TOKEN/preview.json" \
  -H "X-User-Email: $EMAIL" \
  -H "X-User-Token: $PASSWORDPUSHER_TOKEN" \
  -H "Accept: application/json" \
  --max-time 15)"

jq -n --arg url_token "$URL_TOKEN" \
      --arg secret_url "$BASE_URL/p/$URL_TOKEN" \
      --argjson upstream "$RESP" \
  '{status:"ok", url_token:$url_token, secret_url:$secret_url, upstream:$upstream}'
