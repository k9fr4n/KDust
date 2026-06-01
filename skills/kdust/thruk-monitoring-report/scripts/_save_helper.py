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
# `results` while surfacing the envelope as a caption.
#
# v3 change (2026-06-01): `--merge` is BACK, but targeted. thruk-mcp's
# OR filter only works for the problem-intelligence (Family A) and
# perfdata (Family C) tools; the 9 log-based ANALYTICS tools (Family
# B) REJECT an OR on hostgroup/custom_var ("require a secondary /hosts
# lookup, AND-only"). A union perimeter (hostgroup ∪ custom_var) for
# Family B is therefore collected as TWO single-leaf calls and merged
# client-side here. Object-keyed rows are de-duplicated by (host,
# service): a host present in BOTH legs reports the SAME window stat,
# so its counters are kept at MAX (never summed → no double-count);
# only genuinely additive bucket rows (heatmaps, notification summary)
# are summed. Family A and C still use a single OR call (no --merge).
#
# Subcommands:
#   init  <dest>                                  — stdin = meta JSON
#   dump  <dest> [--merge] [--from-file <path>]   — stdin/<path> = MCP response
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

# ---------------------------------------------------------------------
# Family-B merge policy (--merge). Keyed on the slot's destination
# filename. Fields:
#   key:        identity fields -> dedup key (those present in a row).
#   sum:        count fields ADDED on a key collision. Use ONLY for
#               disjoint bucket/group rows (heatmaps, notif summary).
#   maxf:       count fields kept at MAX on collision. Use for per-
#               object window stats reported identically by both legs
#               (summing would double-count overlapping hosts).
#   union_list: list fields unioned on collision.
#   recount:    (target, list) -> target = len(unioned list).
#   total:      (envelope_key, source) -> recompute envelope scalar
#               from the merged results. source='_len' = row count,
#               otherwise the sum of that result field.
MERGE_POLICY = {
    "alert_heatmap.json": {
        "key": ["bucket_start"], "sum": ["count"],
        "total": ("total_alerts", "count"),
    },
    "notification_heatmap.json": {
        "key": ["bucket_start"], "sum": ["count"],
        "total": ("total_notifications", "count"),
    },
    "noisy_hosts.json": {
        "key": ["host"], "maxf": ["alert_count"],
        "total": ("total_alerts_in_window", "alert_count"),
    },
    "noisy_services.json": {
        "key": ["host", "service"], "maxf": ["alert_count"],
        "total": ("total_alerts_in_window", "alert_count"),
    },
    "recurring_problems.json": {
        "key": ["host", "service"], "maxf": ["alert_count"],
        "total": ("total_objects_above_threshold", "_len"),
    },
    "flap_summary.json": {
        "key": ["host", "service"], "maxf": ["transition_count"],
        "total": ("total_flapping_objects", "_len"),
    },
    "concurrent_failures.json": {
        "key": ["window_start", "window_end"], "union_list": ["hosts"],
        "recount": ("count", "hosts"), "total": ("total_down_events", "_len"),
    },
    "notification_summary.json": {
        "key": ["contact", "host", "service", "state", "command", "key"],
        "sum": ["count"], "total": ("total", "count"),
    },
    "reliability_report.json": {
        "key": ["host", "service"], "maxf": ["incidents"],
        "total": ("total_objects", "_len"),
    },
}


def _num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        try:
            return float(v) if ("." in v or "e" in v.lower()) else int(v)
        except ValueError:
            return None
    return None


def _split_envelope(data):
    """Return (results_list|None, envelope_dict|None, results_key|None)."""
    if isinstance(data, list):
        return data, None, None
    if isinstance(data, dict):
        for k in ("results", "data", "rows", "items"):
            if isinstance(data.get(k), list):
                return data[k], data, k
        return None, data, None
    return None, None, None


def _row_key(row, key_fields):
    if not isinstance(row, dict):
        return ("_raw", json.dumps(row, sort_keys=True))
    parts = [(f, row[f]) for f in key_fields if row.get(f) is not None]
    if parts:
        return tuple(parts)
    return ("_raw", json.dumps(row, sort_keys=True))


def _merge_row(base, new, pol):
    if not (isinstance(base, dict) and isinstance(new, dict)):
        return base
    out = dict(base)
    for f in pol.get("sum", []):
        a, b = _num(base.get(f)), _num(new.get(f))
        if a is not None or b is not None:
            out[f] = (a or 0) + (b or 0)
    for f in pol.get("maxf", []):
        a, b = _num(base.get(f)), _num(new.get(f))
        if a is None and b is None:
            continue  # neither leg carries this field — don't inject a null
        if a is None:
            out[f] = new.get(f)
        elif b is None:
            out[f] = base.get(f)
        else:
            out[f] = max(a, b)
    for f in pol.get("union_list", []):
        la = base.get(f) if isinstance(base.get(f), list) else []
        lb = new.get(f) if isinstance(new.get(f), list) else []
        seen = []
        for x in la + lb:
            if x not in seen:
                seen.append(x)
        out[f] = seen
    rc = pol.get("recount")
    if rc and isinstance(out.get(rc[1]), list):
        out[rc[0]] = len(out[rc[1]])
    # Carry over new-only fields and advance any last_* timestamp.
    for f, v in new.items():
        if f not in out:
            out[f] = v
        elif f.startswith("last") and isinstance(v, str) and isinstance(out.get(f), str):
            out[f] = max(out[f], v)
    return out


def _merge_results(old_rows, new_rows, pol):
    key_fields = pol.get("key", ["host", "service"])
    idx, order = {}, []
    for row in list(old_rows) + list(new_rows):
        k = _row_key(row, key_fields)
        if k in idx:
            idx[k] = _merge_row(idx[k], row, pol)
        else:
            idx[k] = row
            order.append(k)
    return [idx[k] for k in order]


def _recompute_total(env, results, pol):
    spec = pol.get("total")
    if not spec or not isinstance(env, dict):
        return
    key, src = spec
    if src == "_len":
        env[key] = len(results)
        return
    total, seen = 0, False
    for r in results:
        v = _num(r.get(src)) if isinstance(r, dict) else None
        if v is not None:
            total += v
            seen = True
    if seen:
        env[key] = total


def _merge_into(existing, incoming, slot_name):
    """Union two single-leaf collections of the SAME Family-B slot."""
    old_rows, old_env, old_key = _split_envelope(existing)
    new_rows, new_env, new_key = _split_envelope(incoming)
    if old_rows is None or new_rows is None:
        sys.stderr.write(
            f"save.sh --merge: {slot_name} has no 'results' list to merge "
            f"-> overwriting with the latest response\n"
        )
        return incoming
    pol = MERGE_POLICY.get(slot_name, {"key": ["host", "service"]})
    merged = _merge_results(old_rows, new_rows, pol)
    if old_env is None and new_env is None:
        return merged  # both bare lists
    env = dict(old_env) if isinstance(old_env, dict) else dict(new_env)
    env[old_key or new_key or "results"] = merged
    warns = []
    for e in (old_env, new_env):
        if not isinstance(e, dict):
            continue
        w = e.get("_warnings", e.get("_warning"))
        if isinstance(w, list):
            warns.extend(w)
        elif w:
            warns.append(w)
    if warns:
        env.pop("_warning", None)
        dedup = []
        for w in warns:
            if w not in dedup:
                dedup.append(w)
        env["_warnings"] = dedup
    _recompute_total(env, merged, pol)
    return env


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
    # argv layout: [_save_helper.py, dump, <dest>, [--merge] [--from-file <path>]]
    rest = list(argv[3:])
    from_file = None
    merge = False
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok == "--merge":
            merge = True
            i += 1
        elif tok == "--from-file":
            if i + 1 >= len(rest):
                sys.stderr.write("_save_helper.py: --from-file requires a path\n")
                sys.exit(64)
            from_file = rest[i + 1]
            i += 2
        else:
            sys.stderr.write(
                "_save_helper.py: usage: dump <dest> [--merge] [--from-file <path>]\n"
            )
            sys.exit(64)
    return argv[2], from_file, merge


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
        dest_s, from_file, merge = _parse_dump_args(sys.argv)
        dest = pathlib.Path(dest_s)
        data = _read_json_file(from_file) if from_file else _read_json_stdin()
        if not isinstance(data, (list, dict)):
            sys.stderr.write(
                f"save.sh {dest.name}: expected a JSON array or object, "
                f"got {type(data).__name__}\n"
            )
            return 2
        merged_note = ""
        if merge and dest.exists():
            try:
                existing = json.loads(dest.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:
                sys.stderr.write(
                    f"save.sh --merge: cannot read existing {dest.name} ({e})\n"
                )
                return 2
            data = _merge_into(existing, data, dest.name)
            merged_note = " (merged)"
        # Store VERBATIM (or the merged union) — render.py unwraps the envelope.
        dest.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        n = _row_count(data)
        if n is None:
            print(f"OK: object{merged_note} \u2192 {dest}")
        else:
            print(f"OK: {n} record(s){merged_note} \u2192 {dest}")
        return 0

    sys.stderr.write(f"_save_helper.py: unknown cmd: {cmd}\n")
    return 64


if __name__ == "__main__":
    sys.exit(main())
