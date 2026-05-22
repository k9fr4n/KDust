#!/usr/bin/env python3
# render.py — thruk-monitoring-report
#
# Reads /tmp/thruk-report/*.json (produced by save.sh) and emits
# /tmp/thruk-report/report.html using a fixed HTML template.
#
# Deterministic: same inputs ⇒ same output, byte for byte.
# Schema-agnostic: every section JSON is rendered via the same
# auto-table renderer. Aggregations are produced server-side by
# thruk-mcp v1.1+ — this script only formats them.
#
# stdlib only (no jinja, no pip).
from __future__ import annotations

import html
import json
import os
import pathlib
import sys
from datetime import datetime, timezone

WORKDIR = pathlib.Path(os.environ.get("THRUK_REPORT_WORKDIR", "/tmp/thruk-report"))

# Ordered list of (slot, title) — drives both file lookup and
# rendering order. Keep this list stable: append-only, no reorder
# without a doc update.
SECTIONS: list[tuple[str, str]] = [
    ("hosts_perimeter",        "Périmètre"),
    ("unacked_critical",       "Problèmes critiques non-acquittés"),
    ("oldest_problems",        "Problèmes les plus anciens"),
    ("problems_by_hostgroup",  "Problèmes agrégés par hostgroup"),
    ("notifications",          "Notifications envoyées"),
    ("alert_heatmap",          "Heatmap des alertes"),
    ("concurrent_failures",    "Pannes concurrentes (storms)"),
    ("recurring_problems",     "Problèmes récurrents"),
    ("noisy_hosts",            "Top hôtes bruyants"),
    ("noisy_services",         "Top services bruyants"),
    ("flap_summary",           "Flap summary"),
    ("stale_acks",             "Acquittements périmés"),
]

MAX_ROWS_PER_SECTION = 50
MAX_COLS_PER_TABLE   = 10
MAX_CELL_CHARS       = 200

# ----- IO helpers ---------------------------------------------------

def _load(name: str, *, required: bool = False):
    p = WORKDIR / name
    if not p.exists():
        if required:
            sys.stderr.write(f"missing input: {name}\n")
            sys.exit(2)
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.stderr.write(f"corrupt input: {name} ({e})\n")
        sys.exit(2)

def _esc(s) -> str:
    return html.escape("" if s is None else str(s), quote=True)

def _fmt_cell(v) -> str:
    if v is None:
        return "—"
    if isinstance(v, bool):
        return "✓" if v else "✗"
    if isinstance(v, (int, float)):
        return _esc(v)
    if isinstance(v, (list, dict)):
        s = json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    else:
        s = str(v)
    if len(s) > MAX_CELL_CHARS:
        s = s[: MAX_CELL_CHARS - 1] + "…"
    return _esc(s)

# ----- HTML styles --------------------------------------------------

TABLE_STYLE = (
    "border-collapse:collapse;width:100%;font-family:Arial,sans-serif;"
    "font-size:13px;margin:8px 0 16px 0;"
)
TH_STYLE = (
    "background:#eceff1;color:#263238;text-align:left;padding:6px 10px;"
    "border:1px solid #cfd8dc;font-weight:600;"
)
TD_STYLE = "padding:6px 10px;border:1px solid #cfd8dc;vertical-align:top;"
SECTION_H2 = (
    "font-family:Arial,sans-serif;color:#263238;margin:24px 0 8px 0;"
    "padding-bottom:4px;border-bottom:2px solid #cfd8dc;"
)
EMPTY_NOTE = (
    '<p style="font-family:Arial,sans-serif;color:#616161;'
    'margin:8px 0 16px 0;">(aucun)</p>'
)
MISSING_NOTE = (
    '<p style="font-family:Arial,sans-serif;color:#9e9e9e;'
    'margin:8px 0 16px 0;font-style:italic;">(slot non collecté)</p>'
)

# ----- Auto-table renderer -----------------------------------------

def _columns_for(rows: list[dict]) -> list[str]:
    """Stable column ordering: keys present in the first row first
    (preserves the natural order returned by thruk-mcp), then any
    extra keys sorted alphabetically. Capped at MAX_COLS_PER_TABLE."""
    if not rows:
        return []
    seen: list[str] = []
    seen_set: set[str] = set()
    for k in rows[0].keys():
        if k not in seen_set:
            seen.append(k)
            seen_set.add(k)
    extras: set[str] = set()
    for r in rows[1:]:
        for k in r.keys():
            if k not in seen_set:
                extras.add(k)
    seen.extend(sorted(extras))
    return seen[:MAX_COLS_PER_TABLE]

def _render_list_of_dicts(rows: list[dict]) -> str:
    cols = _columns_for(rows)
    if not cols:
        return EMPTY_NOTE
    head = "".join(f'<th style="{TH_STYLE}">{_esc(c)}</th>' for c in cols)
    out  = [f'<table style="{TABLE_STYLE}"><thead><tr>{head}</tr></thead><tbody>']
    capped = rows[:MAX_ROWS_PER_SECTION]
    for r in capped:
        cells = "".join(
            f'<td style="{TD_STYLE}">{_fmt_cell(r.get(c))}</td>' for c in cols
        )
        out.append(f"<tr>{cells}</tr>")
    out.append("</tbody></table>")
    if len(rows) > MAX_ROWS_PER_SECTION:
        out.append(
            f'<p style="font-family:Arial,sans-serif;color:#616161;'
            f'font-size:12px;margin:0 0 16px 0;">… + {len(rows) - MAX_ROWS_PER_SECTION} '
            f"autre(s) ligne(s) tronquée(s).</p>"
        )
    return "".join(out)

def _render_dict_kv(d: dict) -> str:
    if not d:
        return EMPTY_NOTE
    items = sorted(d.items(), key=lambda kv: kv[0])
    rows = []
    for k, v in items:
        rows.append(
            f'<tr><td style="{TD_STYLE};font-weight:600;width:30%;">{_esc(k)}</td>'
            f'<td style="{TD_STYLE}">{_fmt_cell(v)}</td></tr>'
        )
    return (
        f'<table style="{TABLE_STYLE}"><thead><tr>'
        f'<th style="{TH_STYLE}">Clé</th><th style="{TH_STYLE}">Valeur</th>'
        f"</tr></thead><tbody>{''.join(rows)}</tbody></table>"
    )

def _render_list_of_scalars(items: list) -> str:
    if not items:
        return EMPTY_NOTE
    capped = items[:MAX_ROWS_PER_SECTION]
    lis = "".join(f"<li>{_fmt_cell(x)}</li>" for x in capped)
    extra = ""
    if len(items) > MAX_ROWS_PER_SECTION:
        extra = (
            f'<p style="font-family:Arial,sans-serif;color:#616161;'
            f'font-size:12px;margin:0 0 16px 0;">… + {len(items) - MAX_ROWS_PER_SECTION} '
            f"autre(s).</p>"
        )
    return (
        f'<ul style="font-family:Arial,sans-serif;font-size:13px;'
        f'margin:8px 0 16px 24px;">{lis}</ul>{extra}'
    )

def _auto_render(payload) -> tuple[str, int]:
    """Return (html_fragment, row_count). row_count is best-effort
    for the summary table; 0 for empty / unknown shapes."""
    if payload is None:
        return MISSING_NOTE, 0
    if isinstance(payload, list):
        if not payload:
            return EMPTY_NOTE, 0
        # list of dicts → auto-table; list of scalars → ul
        if all(isinstance(r, dict) for r in payload):
            return _render_list_of_dicts(payload), len(payload)
        return _render_list_of_scalars(payload), len(payload)
    if isinstance(payload, dict):
        # Some thruk-mcp tools wrap data under a known key.
        for k in ("data", "results", "rows", "items"):
            v = payload.get(k)
            if isinstance(v, list):
                return _auto_render(v)
        # heatmap-like: dict of dicts (e.g. day -> {hour: count})
        if payload and all(isinstance(v, dict) for v in payload.values()):
            # render as a list-of-dicts with an extra "_key" column
            rows = []
            for k in sorted(payload.keys()):
                row = {"_key": k}
                row.update(payload[k])
                rows.append(row)
            return _render_list_of_dicts(rows), len(rows)
        return _render_dict_kv(payload), len(payload)
    # scalar
    return f'<p style="font-family:Arial,sans-serif;">{_fmt_cell(payload)}</p>', 1

# ----- Main ---------------------------------------------------------

meta = _load("meta.json", required=True)
if not isinstance(meta, dict):
    sys.stderr.write("meta.json is not a JSON object\n")
    sys.exit(2)

scope_label  = str(meta.get("scope_label", "—"))
period_label = str(meta.get("period_label", "—"))
since        = str(meta.get("since", "—"))
until        = str(meta.get("until", "—"))
hostgroup    = meta.get("hostgroup") or "—"
custom_vars  = meta.get("custom_vars") or {}
cv_str       = ", ".join(f"{k}={v}" for k, v in sorted(custom_vars.items())) or "—"
warnings     = meta.get("warnings") or []

parts: list[str] = []
parts.append('<div style="font-family:Arial,sans-serif;color:#263238;max-width:1200px;">')
parts.append(
    f'<h1 style="color:#263238;margin:0 0 8px 0;">Rapport monitoring '
    f'{_esc(scope_label)} — {_esc(period_label)}</h1>'
)
parts.append(
    f'<p style="margin:0 0 4px 0;">Fenêtre : du <b>{_esc(since)}</b> '
    f'au <b>{_esc(until)}</b>.</p>'
)
parts.append(
    f'<p style="margin:0 0 4px 0;">Filtres : hostgroup=<b>{_esc(hostgroup)}</b>, '
    f'custom_vars=<b>{_esc(cv_str)}</b>.</p>'
)
for w in warnings:
    parts.append(
        f'<p style="color:#ef6c00;font-weight:600;margin:4px 0;">⚠️ {_esc(w)}</p>'
    )

# Table of contents + row counts (computed as we render).
section_render: list[tuple[str, str, int]] = []
for slot, title in SECTIONS:
    payload = _load(f"{slot}.json", required=False)
    body, count = _auto_render(payload)
    section_render.append((title, body, count))

# TOC
parts.append(f'<h2 style="{SECTION_H2}">Synthèse</h2>')
toc_rows = []
for title, _body, count in section_render:
    toc_rows.append(
        f'<tr><td style="{TD_STYLE}">{_esc(title)}</td>'
        f'<td style="{TD_STYLE};text-align:right;width:120px;">{_esc(count)}</td></tr>'
    )
parts.append(
    f'<table style="{TABLE_STYLE}"><thead><tr>'
    f'<th style="{TH_STYLE}">Section</th>'
    f'<th style="{TH_STYLE};text-align:right;">Lignes</th>'
    f"</tr></thead><tbody>{''.join(toc_rows)}</tbody></table>"
)

# Sections
for title, body, _count in section_render:
    parts.append(f'<h2 style="{SECTION_H2}">{_esc(title)}</h2>')
    parts.append(body)

parts.append(
    f'<p style="font-family:Arial,sans-serif;color:#616161;font-size:11px;'
    f'margin-top:24px;">Généré par <code>kdust/thruk-monitoring-report</code> — '
    f'{_esc(datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))}</p>'
)
parts.append("</div>")

html_doc = (
    '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">'
    f"<title>Monitoring {_esc(scope_label)} {_esc(period_label)}</title>"
    "</head><body>" + "".join(parts) + "</body></html>"
)

out_path = WORKDIR / "report.html"
out_path.write_text(html_doc, encoding="utf-8")

counts = ", ".join(f"{t}={c}" for t, _b, c in section_render)
print(f"OK: report.html written ({len(html_doc)} bytes) — {counts}")
