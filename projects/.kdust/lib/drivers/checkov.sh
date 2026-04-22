#!/usr/bin/env bash
# =============================================================================
# Driver : checkov (IaC security scanner)
# Inputs (env): PROJECT, SRC_DIR
# =============================================================================
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
kdust::require docker
: "${PROJECT:?}"; : "${SRC_DIR:?}"

OUT_DIR=$(kdust::out_dir audit-iac "$PROJECT")

kdust::log "Running checkov on $SRC_DIR..."

set +e
docker run --rm \
  -v "$SRC_DIR:/tf:ro" \
  -v "$OUT_DIR:/out" \
  bridgecrew/checkov:latest \
  -d /tf \
  --output cli \
  --output json \
  --output-file-path /out \
  --quiet
RC=$?
set -e

kdust::banner "IAC AUDIT — $PROJECT"
kdust::log "Report directory: $OUT_DIR"
exit $RC
