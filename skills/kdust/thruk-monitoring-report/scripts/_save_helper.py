#!/usr/bin/env python3
# Internal helper for save.sh. Reads stdin, validates JSON,
# writes it to the target path. Two subcommands: init / dump.
import json
import pathlib
import sys

def _read_json():
    raw = sys.stdin.read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"save.sh: stdin is not valid JSON ({e})\n")
        sys.exit(2)

def main() -> int:
    if len(sys.argv) != 3:
        sys.stderr.write("_save_helper.py: usage: <init|dump> <dest>\n")
        return 64
    cmd, dest_s = sys.argv[1], sys.argv[2]
    dest = pathlib.Path(dest_s)

    data = _read_json()

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
        # Accept bare arrays (the common case) and objects with a
        # top-level list under data/results/rows/items. Normalise
        # to a list so render.py has one shape to consume.
        if isinstance(data, dict):
            for k in ("data", "results", "rows", "items"):
                if isinstance(data.get(k), list):
                    data = data[k]
                    break
        if not isinstance(data, list):
            sys.stderr.write(
                f"save.sh {dest.name}: expected a JSON array (or object "
                f"with a list under data/results/rows/items), got "
                f"{type(data).__name__}\n"
            )
            return 2
        dest.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        print(f"OK: {len(data)} records → {dest}")
        return 0

    sys.stderr.write(f"_save_helper.py: unknown cmd: {cmd}\n")
    return 64

if __name__ == "__main__":
    sys.exit(main())
