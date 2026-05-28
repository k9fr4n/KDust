#!/usr/bin/env bash
# pwpush expire: DELETE /p/:url_token.json. Idempotent.
set -euo pipefail

[ $# -eq 1 ] || { echo "Usage: $0 <url_token>" >&2; exit 2; }
: "${PASSWORDPUSHER_TOKEN:?missing PASSWORDPUSHER_TOKEN}"

URL_TOKEN="$1"
[[ "$URL_TOKEN" =~ ^[A-Za-z0-9_-]{4,64}$ ]] || { echo "invalid url_token format" >&2; exit 2; }

BASE_URL="${PASSWORDPUSHER_URL:-https://passwordpusher.ecritel.net}"
BASE_URL="${BASE_URL%/}"
EMAIL="${PASSWORDPUSHER_EMAIL:-admin@ecritel.net}"

HTTP_CODE="$(curl -fsS -o /tmp/pwpush_expire_$$.json -w '%{http_code}' \
  -X DELETE "$BASE_URL/p/$URL_TOKEN.json" \
  -H "X-User-Email: $EMAIL" \
  -H "X-User-Token: $PASSWORDPUSHER_TOKEN" \
  -H "Accept: application/json" \
  --max-time 15 || echo 000)"
RESP="$(cat /tmp/pwpush_expire_$$.json 2>/dev/null || echo 'null')"
rm -f /tmp/pwpush_expire_$$.json

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ] || [ "$HTTP_CODE" = "404" ]; then
  jq -n --arg url_token "$URL_TOKEN" --arg code "$HTTP_CODE" --argjson upstream "${RESP:-null}" \
    '{status:"ok", url_token:$url_token, http_code:$code, upstream:$upstream}'
else
  jq -n --arg code "$HTTP_CODE" --argjson upstream "${RESP:-null}" \
    '{status:"error", http_code:$code, upstream:$upstream}' >&2
  exit 1
fi
