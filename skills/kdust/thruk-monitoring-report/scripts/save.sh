#!/usr/bin/env bash
# save.sh — thruk-monitoring-report
#
# Modes:
#   save.sh init
#       stdin = JSON meta object (scope_label, since, until,
#       period_label, ...). Wipes /tmp/thruk-report, writes meta.json.
#
#   save.sh <name.json>
#       stdin = JSON array (one thruk_* MCP response),
#       written to /tmp/thruk-report/<name>.
#
#   save.sh <name.json> --from-file <path>
#       Read the JSON from <path> instead of stdin. Used when the
#       Dust runtime spills a large tool output to a conversation
#       file (e.g. `conversation/.tool_outputs/…json`) — the agent
#       hands the path to save.sh rather than re-streaming the
#       payload through stdin. Same normalisation rules.
#       Franck 2026-05-19.
#
# Strict on input: never silently corrupt the workdir.
set -euo pipefail

WORKDIR="${THRUK_REPORT_WORKDIR:-/tmp/thruk-report}"
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/_save_helper.py"

usage() {
  cat >&2 <<'USAGE'
usage: save.sh init                                 (stdin = meta JSON object)
       save.sh <filename.json>                      (stdin = MCP response)
       save.sh <filename.json> --from-file <path>   (read JSON from <path>)
USAGE
  exit 64
}

[[ $# -ge 1 ]] || usage
mode="$1"

if [[ "$mode" == "init" ]]; then
  # Wipe CONTENTS only — never the directory itself. The workdir is a
  # bind-mount shared with the thruk-mcp child container spawned by
  # mcp-gateway (see docker-compose.yml + mcp-gateway/catalogs/kdust-custom.yaml).
  # `rm -rf -- "$WORKDIR"` on a bind-mount silently leaves the previous
  # run's files around because the kernel refuses to unlink the mount
  # point (EBUSY), and `mkdir -p` then no-ops. Use `find -delete` so
  # we remove the descendants of the mount and re-create the meta file
  # in a known-clean directory.
  mkdir -p -- "$WORKDIR"
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
