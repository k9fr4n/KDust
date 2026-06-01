#!/usr/bin/env bash
# save.sh — thruk-monitoring-report (v3, 2026-06-01)
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
#   save.sh <name.json> --merge
#       Like above, but if <name> already exists, UNION the new
#       response into it instead of overwriting. Used by Family B
#       (log-based analytics) slots whose union perimeter must be
#       collected as two single-leaf calls (hostgroup leg +
#       custom_var leg) because thruk-mcp rejects an OR filter on
#       those tools. Dedup + sum/max rules live in _save_helper.py
#       (MERGE_POLICY). First call writes verbatim; second merges.
#
#   save.sh <name.json> [--merge] --from-file <path>
#       Read the JSON from <path> instead of stdin. Used when the Dust
#       runtime spills a large tool output to a file (fil_* exported
#       via export_fil_to_workdir, or a conversation/.tool_outputs
#       path). Same validation rules. Combines with --merge.
#
# Strict on input: never silently corrupt the workdir.
set -euo pipefail

WORKDIR="${THRUK_REPORT_WORKDIR:-/tmp/thruk-report}"
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/_save_helper.py"

usage() {
  cat >&2 <<'USAGE'
usage: save.sh init                                         (stdin = meta JSON object)
       save.sh <filename.json> [--merge]                    (stdin = MCP response)
       save.sh <filename.json> [--merge] --from-file <path> (read JSON from <path>)
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

# Remaining args — any of `--merge` and `--from-file <path>`, in any
# order — are validated by the helper's argument parser. Passing them
# through keeps a single source of truth for the flag grammar.
exec python3 "$HELPER" dump "$WORKDIR/$name" "$@"
