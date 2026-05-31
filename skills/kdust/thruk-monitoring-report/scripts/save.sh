#!/usr/bin/env bash
# save.sh — thruk-monitoring-report (v2, 2026-05-31)
#
# Modes:
#   save.sh init
#       stdin = JSON meta object (scope_label, since, until,
#       period_label, ...). Wipes /tmp/thruk-report contents, writes
#       meta.json.
#
#   save.sh <name.json>
#       stdin = one thruk_* MCP response (array OR envelope object),
#       stored VERBATIM to /tmp/thruk-report/<name>. render.py unwraps
#       the envelope (`results`) and surfaces its scalars.
#
#   save.sh <name.json> --from-file <path>
#       Read the JSON from <path> instead of stdin. Used when the Dust
#       runtime spills a large tool output to a file (fil_* exported
#       via export_fil_to_workdir, or a conversation/.tool_outputs
#       path). Same validation rules.
#
# v2: the old `--merge` union mode is GONE. thruk-mcp's structured
# filter tree supports OR, so a hostgroup-OR-custom_var perimeter is
# expressed in a single MCP call (one `save.sh <slot>`), no client-
# side dedupe needed.
#
# Strict on input: never silently corrupt the workdir.
set -euo pipefail

WORKDIR="${THRUK_REPORT_WORKDIR:-/tmp/thruk-report}"
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/_save_helper.py"

usage() {
  cat >&2 <<'USAGE'
usage: save.sh init                                (stdin = meta JSON object)
       save.sh <filename.json>                     (stdin = MCP response, verbatim)
       save.sh <filename.json> --from-file <path>  (read JSON from <path>, verbatim)
USAGE
  exit 64
}

[[ $# -ge 1 ]] || usage
mode="$1"

if [[ "$mode" == "init" ]]; then
  # Wipe CONTENTS only — never the directory itself. The workdir may
  # be a bind-mount; `rm -rf -- "$WORKDIR"` would hit EBUSY on the
  # mount point and silently leave stale files. `find -delete` removes
  # descendants in a known-clean way.
  mkdir -p -- "$WORKDIR"
  chmod 1777 "$WORKDIR" 2>/dev/null || true
  find "$WORKDIR" -mindepth 1 -delete
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

shift  # consume <name>

if [[ $# -eq 0 ]]; then
  exec python3 "$HELPER" dump "$WORKDIR/$name"
fi

if [[ "$1" == "--from-file" ]]; then
  [[ $# -eq 2 ]] || { echo "save.sh: --from-file requires exactly one path" >&2 ; exit 64 ; }
  src="$2"
  [[ -n "$src" ]] || { echo "save.sh: --from-file path is empty" >&2 ; exit 64 ; }
  exec python3 "$HELPER" dump "$WORKDIR/$name" --from-file "$src"
fi

echo "save.sh: unexpected arg '$1' after '<name.json>'" >&2
usage
