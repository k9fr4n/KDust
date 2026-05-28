#!/usr/bin/env bash
# pwpush create: POST /p.json. Returns JSON to stdout with secret_url.
#
# Required env:  PASSWORDPUSHER_TOKEN
# Optional env:  PASSWORDPUSHER_EMAIL (default admin@ecritel.net)
#                PASSWORDPUSHER_URL   (default https://passwordpusher.ecritel.net)
set -euo pipefail

usage() {
  cat >&2 <<USAGE
Usage: $0 <payload> [options]
  --days N             expire_after_days (1..90, default 7)
  --views N            expire_after_views (1..100, default 1)
  --passphrase STR     require passphrase
  --note STR           audit note (push creator only)
  --no-retrieval-step  disable click-to-retrieve interstitial
  --deletable          allow viewer to delete after view
USAGE
  exit 2
}

[ $# -ge 1 ] || usage
: "${PASSWORDPUSHER_TOKEN:?missing PASSWORDPUSHER_TOKEN (bind it via TaskSecret PASSWORDPUSHER_TOKEN -> PASSWORDPUSHER_TOKEN)}"

PAYLOAD="$1"; shift
DAYS=7
VIEWS=1
RETRIEVAL_STEP=true
PASSPHRASE=""
NOTE=""
DELETABLE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="$2"; shift 2 ;;
    --views) VIEWS="$2"; shift 2 ;;
    --passphrase) PASSPHRASE="$2"; shift 2 ;;
    --note) NOTE="$2"; shift 2 ;;
    --no-retrieval-step) RETRIEVAL_STEP=false; shift ;;
    --deletable) DELETABLE=true; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

BASE_URL="${PASSWORDPUSHER_URL:-https://passwordpusher.ecritel.net}"
BASE_URL="${BASE_URL%/}"
EMAIL="${PASSWORDPUSHER_EMAIL:-admin@ecritel.net}"

ARGS=(
  -fsS -X POST "$BASE_URL/p.json"
  -H "X-User-Email: $EMAIL"
  -H "X-User-Token: $PASSWORDPUSHER_TOKEN"
  -H "Accept: application/json"
  --data-urlencode "password[payload]=$PAYLOAD"
  --data-urlencode "password[expire_after_days]=$DAYS"
  --data-urlencode "password[expire_after_views]=$VIEWS"
  --data-urlencode "password[retrieval_step]=$RETRIEVAL_STEP"
  --max-time 15
)
[ -n "$PASSPHRASE" ] && ARGS+=( --data-urlencode "password[passphrase]=$PASSPHRASE" )
[ -n "$NOTE"       ] && ARGS+=( --data-urlencode "password[note]=$NOTE" )
[ -n "$DELETABLE"  ] && ARGS+=( --data-urlencode "password[deletable_by_viewer]=$DELETABLE" )

RESP="$(curl "${ARGS[@]}")"
URL_TOKEN="$(printf '%s' "$RESP" | jq -r '.url_token // empty')"
if [ -z "$URL_TOKEN" ]; then
  printf '{"status":"error","error":"missing url_token in response","upstream":%s}\n' "$RESP" >&2
  exit 1
fi

jq -n --arg url_token "$URL_TOKEN" \
      --arg secret_url "$BASE_URL/p/$URL_TOKEN" \
      --argjson upstream "$RESP" \
  '{status:"ok", url_token:$url_token, secret_url:$secret_url,
    expire_after_days:  $upstream.expire_after_days,
    expire_after_views: $upstream.expire_after_views,
    days_remaining:     $upstream.days_remaining,
    views_remaining:    $upstream.views_remaining,
    retrieval_step:     $upstream.retrieval_step,
    expired:            $upstream.expired}'
