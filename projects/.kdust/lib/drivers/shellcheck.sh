#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
kdust::require docker
: "${PROJECT:?}"; : "${SRC_DIR:?}"
OUT_DIR=$(kdust::out_dir run-lint "$PROJECT")

docker run --rm \
  -v "$SRC_DIR:/mnt:ro" \
  -w /mnt \
  koalaman/shellcheck-alpine:stable \
  sh -c 'find . -type f \( -name "*.sh" -o -name "*.bash" \) -print0 | xargs -0 -r shellcheck -f json' \
  > "$OUT_DIR/shellcheck.json" || true

kdust::banner "shellcheck — $PROJECT"
kdust::log "Report: $OUT_DIR/shellcheck.json"
