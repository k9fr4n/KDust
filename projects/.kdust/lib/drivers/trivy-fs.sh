#!/usr/bin/env bash
# =============================================================================
# Driver : trivy filesystem (vulnerabilities in dependencies)
# Inputs (env): PROJECT, SRC_DIR
# =============================================================================
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
kdust::require docker
: "${PROJECT:?}"; : "${SRC_DIR:?}"

OUT_DIR=$(kdust::out_dir audit-deps "$PROJECT")
REPORT="$OUT_DIR/trivy.json"

kdust::log "Running trivy fs on $SRC_DIR..."

docker run --rm \
  -v "$SRC_DIR:/scan:ro" \
  -v "$OUT_DIR:/out" \
  aquasec/trivy:latest \
  fs /scan \
  --format json \
  --output /out/trivy.json \
  --severity HIGH,CRITICAL \
  --exit-code 0 \
  --quiet

kdust::banner "DEPS AUDIT — $PROJECT"
if command -v jq >/dev/null 2>&1 && [ -s "$REPORT" ]; then
  HIGH=$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity=="HIGH")] | length' "$REPORT")
  CRIT=$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity=="CRITICAL")] | length' "$REPORT")
  printf 'CRITICAL : %s\nHIGH     : %s\nReport   : %s\n' "$CRIT" "$HIGH" "$REPORT"
  [ "$CRIT" -gt 0 ] && exit 1
fi
exit 0
