#!/usr/bin/env bash
# Driver: terraform fmt (format check when FIX=0, apply when FIX=1)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
kdust::require docker
: "${PROJECT:?}"; : "${SRC_DIR:?}"
FIX="${FIX:-0}"

MODE="-check -diff"; MOUNT="ro"
[ "$FIX" = "1" ] && { MODE="-diff"; MOUNT="rw"; }

docker run --rm \
  -v "$SRC_DIR:/tf:$MOUNT" \
  -w /tf \
  hashicorp/terraform:latest \
  fmt -recursive $MODE
