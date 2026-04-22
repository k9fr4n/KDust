#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
kdust::require docker
: "${PROJECT:?}"; : "${SRC_DIR:?}"
OUT_DIR=$(kdust::out_dir run-lint "$PROJECT")

docker run --rm \
  -v "$SRC_DIR:/data:ro" \
  -v "$OUT_DIR:/out" \
  ghcr.io/terraform-linters/tflint:latest \
  --recursive --format=json --chdir=/data > "$OUT_DIR/tflint.json" || true

kdust::banner "tflint — $PROJECT"
kdust::log "Report: $OUT_DIR/tflint.json"
cat "$OUT_DIR/tflint.json" 2>/dev/null | head -100 || true
