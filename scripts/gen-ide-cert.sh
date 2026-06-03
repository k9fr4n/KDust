#!/usr/bin/env bash
# scripts/gen-ide-cert.sh — generate a self-signed TLS keypair for the
# KDust in-process IDE auth-proxy (Franck 2026-06-03).
#
# WHY: code-server webviews (the Claude Code chat panel, extension
# READMEs, the settings UI) are rendered by a service worker, which
# browsers only register in a *secure context* (HTTPS or localhost).
# Reaching the proxy over plain HTTP on a LAN IP (e.g.
# http://192.168.0.3:4001) leaves those webviews blank. Terminating TLS
# on the proxy makes the origin secure and the webviews load.
#
# The cert lands in ./data/ide-tls/ which is already bind-mounted into
# the kdust container at /data (see docker-compose.yml), so no new
# volume is needed. Wire it up afterwards in .env:
#
#   IDE_TLS_CERT=/data/ide-tls/cert.pem
#   IDE_TLS_KEY=/data/ide-tls/key.pem
#   IDE_PUBLIC_URL=https://<host>:4001
#
# then `docker compose restart kdust`.
#
# Usage:
#   ./scripts/gen-ide-cert.sh [host-or-ip ...]
# Examples:
#   ./scripts/gen-ide-cert.sh 192.168.0.3
#   ./scripts/gen-ide-cert.sh kdust.lan 192.168.0.3
#
# It is a SELF-SIGNED cert: the browser shows a one-time trust warning;
# accept it and the webviews render. For a CA-trusted cert, drop your
# own cert.pem/key.pem in ./data/ide-tls/ instead and skip this script.

set -euo pipefail

OUT_DIR="${IDE_TLS_DIR:-./data/ide-tls}"
DAYS="${IDE_TLS_DAYS:-3650}"
CN="${IDE_TLS_CN:-kdust-ide}"

# Build the subjectAltName list. localhost/127.0.0.1 are always added
# so an SSH tunnel (https://localhost:4001) keeps working too.
declare -a SANS=("DNS:localhost" "IP:127.0.0.1")
for host in "$@"; do
  if printf '%s' "$host" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
    SANS+=("IP:${host}")
  else
    SANS+=("DNS:${host}")
  fi
done

# De-dup while preserving order.
SAN_STR="$(printf '%s\n' "${SANS[@]}" | awk '!seen[$0]++' | paste -sd, -)"

mkdir -p "$OUT_DIR"
CERT="${OUT_DIR}/cert.pem"
KEY="${OUT_DIR}/key.pem"

echo "[gen-ide-cert] writing self-signed cert"
echo "[gen-ide-cert]   CN  = ${CN}"
echo "[gen-ide-cert]   SAN = ${SAN_STR}"
echo "[gen-ide-cert]   out = ${CERT}, ${KEY} (valid ${DAYS} days)"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY" \
  -out "$CERT" \
  -days "$DAYS" \
  -subj "/CN=${CN}" \
  -addext "subjectAltName=${SAN_STR}"

chmod 600 "$KEY"
chmod 644 "$CERT"

echo "[gen-ide-cert] done. Now set in .env:"
echo "    IDE_TLS_CERT=/data/ide-tls/cert.pem"
echo "    IDE_TLS_KEY=/data/ide-tls/key.pem"
echo "    IDE_PUBLIC_URL=https://${1:-<host>}:4001"
echo "  then: docker compose restart kdust"
