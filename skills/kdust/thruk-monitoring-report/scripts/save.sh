#!/usr/bin/env bash
# save.sh — thruk-monitoring-report
#
# Two modes:
#   save.sh init      — stdin = JSON meta object (scope_label, since, until, period_label, ...)
#                       wipes /tmp/thruk-report, writes meta.json.
#   save.sh <name>    — stdin = JSON array (one thruk_* MCP response),
#                       written to /tmp/thruk-report/<name>.
#
# Strict on input: never silently corrupt the workdir.
set -euo pipefail

WORKDIR="${THRUK_REPORT_WORKDIR:-/tmp/thruk-report}"
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/_save_helper.py"

usage() {
  cat >&2 <<'USAGE'
usage: save.sh init               (stdin = meta JSON object)
       save.sh <filename.json>    (stdin = MCP response JSON array)
USAGE
  exit 64
}

[[ $# -ge 1 ]] || usage
mode="$1"

if [[ "$mode" == "init" ]]; then
  rm -rf -- "$WORKDIR"
  mkdir -p -- "$WORKDIR"
  exec python3 "$HELPER" init "$WORKDIR/meta.json"
fi

name="$mode"
case "$name" in
  */*|..*|.*) echo "save.sh: invalid name '$name'" >&2 ; exit 64 ;;
esac
[[ "$name" == *.json ]] || { echo "save.sh: name must end in .json" >&2 ; exit 64 ; }

if [[ ! -d "$WORKDIR" ]]; then
  echo "save.sh: workdir $WORKDIR missing — call 'save.sh init' first" >&2
  exit 65
fi

exec python3 "$HELPER" dump "$WORKDIR/$name"
