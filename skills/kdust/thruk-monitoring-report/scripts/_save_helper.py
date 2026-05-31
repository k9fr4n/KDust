#!/usr/bin/env python3
# Internal helper for save.sh (v2, 2026-05-31).
#
# Reads JSON from stdin OR a file on disk, validates that it parses,
# and writes it to the target path VERBATIM (no flattening, no merge).
#
# v2 change: thruk-mcp analytics/availability/problem-intelligence
# tools return an ENVELOPE ({since, until, total_*, results:[...]})
# whose scalar fields (counts, window, warnings) are meaningful. The
# old helper flattened everything to a bare list and DROPPED that
# envelope. We now store the raw response and let render.py unwrap
# `results` while surfacing the envelope as a caption. The `--merge`
# union hack is gone too: the structured filter tree supports OR, so
# a hostgroup-OR-custom_var perimeter is one MCP call, not two.
#
# Subcommands:
#   init  <dest>                       — stdin   = meta JSON object
#   dump  <dest> [--from-file <path>]  — stdin OR <path> = MCP response
import json
import pathlib
import sys

# Anti path-traversal allow-list for --from-file. The agent only
# legitimately points save.sh at outputs spilled under the workdir,
# the project tree, or the Dust conversation FS.
ALLOWED_ROOTS = (
    pathlib.Path("/projects").resolve(),
    pathlib.Path("/tmp/thruk-report").resolve(),
    pathlib.Path("/tmp/kdust-fil-cache").resolve(),
)


def _read_json_stdin():
    raw = sys.stdin.read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"save.sh: stdin is not valid JSON ({e})\n")
        sys.exit(2)


def _read_json_file(path_s):
    p = pathlib.Path(path_s).resolve()
    raw_in = pathlib.Path(path_s)
    is_conv = (
        (not raw_in.is_absolute())
        and raw_in.parts
        and raw_in.parts[0] == "conversation"
    )
    if not is_conv and not any(
        str(p).startswith(str(r) + "/") or str(p) == str(r) for r in ALLOWED_ROOTS
    ):
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
    rest = list(argv[3:])
    from_file = None
    if rest:
        if len(rest) == 2 and rest[0] == "--from-file":
            from_file = rest[1]
        else:
            sys.stderr.write(
                "_save_helper.py: usage: dump <dest> [--from-file <path>]\n"
            )
            sys.exit(64)
    return argv[2], from_file


def _row_count(data):
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        for k in ("results", "data", "rows", "items"):
            if isinstance(data.get(k), list):
                return len(data[k])
    return None


def main():
    if len(sys.argv) < 3:
        sys.stderr.write(
            "_save_helper.py: usage: <init|dump> <dest> [--from-file <path>]\n"
        )
        return 64
    cmd = sys.argv[1]

    if cmd == "init":
        if len(sys.argv) != 3:
            sys.stderr.write("_save_helper.py: usage: init <dest>\n")
            return 64
        dest = pathlib.Path(sys.argv[2])
        data = _read_json_stdin()
        if not isinstance(data, dict):
            sys.stderr.write("save.sh init: meta must be a JSON object\n")
            return 2
        required = ("scope_label", "since", "until", "period_label")
        missing = [k for k in required if k not in data]
        if missing:
            sys.stderr.write(f"save.sh init: meta missing keys: {missing}\n")
            return 2
        data.setdefault("hostgroup", None)
        data.setdefault("custom_vars", {})
        data.setdefault("warnings", [])
        dest.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        print(f"OK: meta written to {dest}")
        return 0

    if cmd == "dump":
        dest_s, from_file = _parse_dump_args(sys.argv)
        dest = pathlib.Path(dest_s)
        data = _read_json_file(from_file) if from_file else _read_json_stdin()
        if not isinstance(data, (list, dict)):
            sys.stderr.write(
                f"save.sh {dest.name}: expected a JSON array or object, "
                f"got {type(data).__name__}\n"
            )
            return 2
        # Store VERBATIM — render.py unwraps the envelope.
        dest.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        n = _row_count(data)
        if n is None:
            print(f"OK: object \u2192 {dest}")
        else:
            print(f"OK: {n} record(s) \u2192 {dest}")
        return 0

    sys.stderr.write(f"_save_helper.py: unknown cmd: {cmd}\n")
    return 64


if __name__ == "__main__":
    sys.exit(main())
