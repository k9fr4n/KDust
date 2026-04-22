#!/usr/bin/env bash
# =============================================================================
# Driver : gitleaks
# -----------------------------------------------------------------------------
# Scans a project directory for secrets using gitleaks (via Docker).
# Inputs (env): PROJECT, SRC_DIR
# Exit: 0 = clean, 1 = secrets found, 2+ = tool error
# =============================================================================
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
kdust::require docker jq
: "${PROJECT:?}"; : "${SRC_DIR:?}"

OUT_DIR=$(kdust::out_dir audit-secrets "$PROJECT")
REPORT="$OUT_DIR/gitleaks.json"

kdust::log "Scanning $SRC_DIR with gitleaks..."

# Detect whether directory is a git repo; switch to --no-git if not
GIT_FLAG="--no-git"
[ -d "$SRC_DIR/.git" ] && GIT_FLAG=""

set +e
docker run --rm \
  -v "$SRC_DIR:/repo:ro" \
  -v "$OUT_DIR:/out" \
  zricethezav/gitleaks:latest \
  detect \
    --source /repo \
    --report-path /out/gitleaks.json \
    --report-format json \
    $GIT_FLAG \
    --redact \
    --exit-code 0
RC=$?
set -e

if [ $RC -ne 0 ] && [ ! -f "$REPORT" ]; then
  kdust::critical "gitleaks failed (rc=$RC) and produced no report"
  exit 2
fi

COUNT=0
[ -s "$REPORT" ] && COUNT=$(jq 'length' "$REPORT")

kdust::banner "SECRETS AUDIT — $PROJECT"
printf 'Findings : %s\nReport   : %s\n' "$COUNT" "$REPORT"

if [ "$COUNT" -gt 0 ]; then
  echo ""
  jq -r '.[] | "[\(.RuleID // .ruleID)] \(.File // .file):\(.StartLine // .startLine) — \(.Description // .description // "n/a")"' "$REPORT" | head -50
  [ "$COUNT" -gt 50 ] && echo "... ($COUNT total, truncated to 50)"
  exit 1
fi

kdust::log "No secrets detected"
exit 0
