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
#   save.sh <name.json> --merge [--from-file <path>]
#       Union+dedupe the incoming JSON array with the existing
#       contents of <name.json>. Dedup key = canonical
#       json.dumps(record, sort_keys=True). Used when a perimeter
#       is defined as the UNION of several MCP filters (e.g.
#       hostgroup HG_WINDOWS ∪ custom_vars KERNEL=windows): the
#       agent does one MCP call per filter, the first one writes
#       the file with `save.sh <name>.json`, subsequent ones
#       append with `--merge`. Franck 2026-05-20.
#
# Strict on input: never silently corrupt the workdir.
set -euo pipefail

WORKDIR="${THRUK_REPORT_WORKDIR:-/tmp/thruk-report}"
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/_save_helper.py"

usage() {
  cat >&2 <<'USAGE'
usage: save.sh init                                          (stdin = meta JSON object)
       save.sh <filename.json>                               (stdin = MCP response, overwrites)
       save.sh <filename.json> --from-file <path>            (read JSON from <path>, overwrites)
       save.sh <filename.json> --merge                       (stdin = MCP response, union+dedup)
       save.sh <filename.json> --merge --from-file <path>    (read JSON from <path>, union+dedup)
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
  # Defensive chmod 1777 (tmpfs-like, sticky bit).
  # The bind mount is shared with the thruk-mcp child container,
  # which runs as uid 1001 / gid 999 (image
  # ghcr.io/k9fr4n/thruk-mcp) while kdust runs as uid 1000. No
  # common owner/group ⇒ 0775 is insufficient and thruk-mcp falls
  # back to inline payload (then Dust spills to fil_*, breaking
  # save.sh --from-file). 1777 mirrors /tmp semantics and is
  # idempotent — chmod by the dir owner (uid 1000) succeeds even
  # if mode is already 1777. Franck 2026-05-20.
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

merge_flag=()
if [[ $# -gt 0 && "$1" == "--merge" ]]; then
  merge_flag=(--merge)
  shift
fi

if [[ $# -eq 0 ]]; then
  exec python3 "$HELPER" dump "$WORKDIR/$name" "${merge_flag[@]}"
fi

if [[ "$1" == "--from-file" ]]; then
  [[ $# -eq 2 ]] || { echo "save.sh: --from-file requires exactly one path" >&2 ; exit 64 ; }
  src="$2"
  [[ -n "$src" ]] || { echo "save.sh: --from-file path is empty" >&2 ; exit 64 ; }
  exec python3 "$HELPER" dump "$WORKDIR/$name" "${merge_flag[@]}" --from-file "$src"
fi

echo "save.sh: unexpected arg '$1' after '<name.json>'" >&2
usage
