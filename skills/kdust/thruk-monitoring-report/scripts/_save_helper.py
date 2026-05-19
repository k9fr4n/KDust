#!/usr/bin/env python3
# Internal helper for save.sh. Reads JSON from stdin OR a file on
# disk, validates it, writes it to the target path.
#
# Subcommands:
#   init  <dest>                        — stdin   = meta JSON object
#   dump  <dest> [--from-file <path>]   — stdin OR <path> = MCP response
#
# The --from-file form was added (Franck 2026-05-19) to handle large
# MCP tool outputs that the Dust runtime spills to conversation files
# (e.g. `conversation/.tool_outputs/<ts>_mcp_gateway_thruk_*.json`).
# The agent cannot easily re-stream those through stdin, so it points
# save.sh at the file directly instead.
import json
import pathlib
import sys

# Allow-list of roots from which --from-file may read. Anti
# path-traversal: the agent only legitimately sees outputs spilled
# into `conversation/` or files it staged under the project tree.
ALLOWED_ROOTS = (
    pathlib.Path("/projects").resolve(),
    pathlib.Path("/tmp/thruk-report").resolve(),
    # Dust mounts the conversation FS at /home/<uid>/conversation/
    # in some images; resolve at runtime rather than hard-coding.
)

def _read_json_stdin():
    raw = sys.stdin.read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"save.sh: stdin is not valid JSON ({e})\n")
        sys.exit(2)

def _read_json_file(path_s: str):
    p = pathlib.Path(path_s).resolve()
    # Allow either an absolute path under one of ALLOWED_ROOTS, or a
    # relative path starting with `conversation/` (Dust scoped path).
    raw_in = pathlib.Path(path_s)
    is_conv = (not raw_in.is_absolute()) and raw_in.parts and raw_in.parts[0] == "conversation"
    if not is_conv and not any(str(p).startswith(str(r) + "/") or str(p) == str(r) for r in ALLOWED_ROOTS):
        sys.stderr.write(
            f"save.sh --from-file: path {p} is outside allowed roots "
            f"({', '.join(str(r) for r in ALLOWED_ROOTS)}, conversation/*)\n"
        )
        sys.exit(2)
    try:
        text = p.read_text(encoding="utf-8")
    except FileNotFoundError:
        sys.stderr.write(f"save.sh --from-file: not found: {p}\n")
        sys.exit(2)
    except OSError as e:
        sys.stderr.write(f"save.sh --from-file: read error on {p}: {e}\n")
        sys.exit(2)
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"save.sh --from-file: {p} is not valid JSON ({e})\n")
        sys.exit(2)

def _parse_dump_args(argv):
    # argv layout: [_save_helper.py, dump, <dest>, [--from-file <path>]]
    if len(argv) == 3:
        return argv[2], None
    if len(argv) == 5 and argv[3] == "--from-file":
        return argv[2], argv[4]
    sys.stderr.write(
        "_save_helper.py: usage: dump <dest> [--from-file <path>]\n"
    )
    sys.exit(64)

def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("_save_helper.py: usage: <init|dump> <dest> [--from-file <path>]\n")
        return 64
    cmd = sys.argv[1]

    if cmd == "init":
        if len(sys.argv) != 3:
            sys.stderr.write("_save_helper.py: usage: init <dest>\n")
            return 64
        dest = pathlib.Path(sys.argv[2])
        data = _read_json_stdin()
    elif cmd == "dump":
        dest_s, from_file = _parse_dump_args(sys.argv)
        dest = pathlib.Path(dest_s)
        data = _read_json_file(from_file) if from_file else _read_json_stdin()
    else:
        sys.stderr.write(f"_save_helper.py: unknown cmd: {cmd}\n")
        return 64

    if cmd == "init":
        if not isinstance(data, dict):
            sys.stderr.write("save.sh init: meta must be a JSON object\n")
            return 2
        required = ("scope_label", "since", "until", "period_label")
        missing  = [k for k in required if k not in data]
        if missing:
            sys.stderr.write(f"save.sh init: meta missing keys: {missing}\n")
            return 2
        data.setdefault("hostgroup",   None)
        data.setdefault("custom_vars", {})
        dest.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        print(f"OK: meta written to {dest}")
        return 0

    if cmd == "dump":
        # Normalise to a flat list so render.py has one shape to
        # consume. Accept:
        #   - bare array (common case)                       → as-is
        #   - dict with `data|results|rows|items` (wrappers) → unwrap
        #   - dict with `hosts` AND/OR `services`            → concat
        #     (this is the native shape of `thruk_problems`,
        #      Franck 2026-05-19)
        if isinstance(data, dict):
            unwrapped = None
            for k in ("data", "results", "rows", "items"):
                if isinstance(data.get(k), list):
                    unwrapped = data[k]
                    break
            if unwrapped is None and (
                isinstance(data.get("hosts"), list)
                or isinstance(data.get("services"), list)
            ):
                unwrapped = (
                    (data.get("hosts") or []) + (data.get("services") or [])
                )
            if unwrapped is not None:
                data = unwrapped
        if not isinstance(data, list):
            sys.stderr.write(
                f"save.sh {dest.name}: expected a JSON array (or object "
                f"with a list under data/results/rows/items, or "
                f"hosts/services), got {type(data).__name__}\n"
            )
            return 2
        dest.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        print(f"OK: {len(data)} records → {dest}")
        return 0

    sys.stderr.write(f"_save_helper.py: unknown cmd: {cmd}\n")
    return 64

if __name__ == "__main__":
    sys.exit(main())
