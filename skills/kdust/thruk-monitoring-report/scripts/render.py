#!/usr/bin/env python3
# render.py — thruk-monitoring-report (v2, 2026-05-31)
#
# Reads /tmp/thruk-report/*.json (raw thruk-mcp responses dumped by
# save.sh) and emits /tmp/thruk-report/report.html.
#
# v2 redesign — the report is now built almost entirely from the
# read-only ANALYTICS / AVAILABILITY / PROBLEM-INTELLIGENCE families
# of thruk-mcp (v1.8.0). Every one of those tools returns an
# ENVELOPE — {since, until, total_*, results:[...], _warning?} — so
# this renderer:
#   1. unwraps `results` (falls back to a bare list / dict);
#   2. surfaces envelope scalars as a one-line caption and
#      _warning(s) as an orange note — nothing is silently dropped;
#   3. projects a CURATED column set per slot with friendly French
#      headers, %/duration/list formatters and a deterministic
#      worst-first sort where it matters.
#
# stdlib only. Deterministic given inputs (meta.generated_at falls
# back to now() only when the caller omits it).
from __future__ import annotations

import html
import json
import os
import pathlib
import sys
from datetime import datetime, timezone

WORKDIR = pathlib.Path(os.environ.get("THRUK_REPORT_WORKDIR", "/tmp/thruk-report"))

MAX_ROWS_PER_SECTION = 50
MAX_CELL_CHARS = 240

# ----- Column spec --------------------------------------------------
# A column is (key, header, fmt). key may be a list of candidate keys
# (first present wins) so one spec covers host time_up_percent AND
# service time_ok_percent. A column renders only if at least one row
# carries a value. fmt in {text,int,pct,dur_min,dur_s,list,bool}.

SECTIONS = [
    # ---------- Family A — problem intelligence (current state) ----------
    {
        "slot": "problem_counts", "family": "pi",
        "title": "Compteurs de probl\u00e8mes (\u00e9tat courant)",
        "columns": None, "summary": [], "sort": None,
    },
    {
        "slot": "unacked_critical", "family": "pi",
        "title": "Critiques / DOWN non acquitt\u00e9s",
        "columns": [
            ("host", "H\u00f4te", "text"),
            ("service", "Service", "text"),
            ("state", "\u00c9tat", "text"),
            ("duration_minutes", "Depuis", "dur_min"),
        ],
        "summary": [], "sort": ("duration_minutes", "desc"),
    },
    {
        "slot": "oldest_problems", "family": "pi",
        "title": "Probl\u00e8mes non trait\u00e9s les plus anciens",
        "columns": [
            ("host", "H\u00f4te", "text"),
            ("service", "Service", "text"),
            ("state", "\u00c9tat", "text"),
            ("since", "Depuis le", "text"),
            ("duration_human", "Dur\u00e9e", "text"),
        ],
        "summary": [], "sort": None,
    },
    {
        "slot": "stale_acks", "family": "pi",
        "title": "Acquittements p\u00e9rim\u00e9s",
        "columns": [
            ("host", "H\u00f4te", "text"),
            ("service", "Service", "text"),
            ("state", "\u00c9tat", "text"),
            ("author", "Auteur", "text"),
            (["age_days", "age_human"], "\u00c2ge", "text"),
            ("comment", "Commentaire", "text"),
        ],
        "summary": [], "sort": None,
    },
    {
        "slot": "stale_checks", "family": "pi",
        "title": "Checks fig\u00e9s (false green)",
        "columns": [
            ("host", "H\u00f4te", "text"),
            ("service", "Service", "text"),
            ("reason", "Raison", "text"),
            (["last_check", "last_check_human"], "Dernier check", "text"),
            (["age_seconds", "age_human"], "\u00c2ge", "text"),
        ],
        "summary": ["staleness_factor", "latency_threshold_s", "passive_max_age_s"],
        "sort": None,
    },
    # ---------- Family B — analytics (sliding window) ----------
    {
        "slot": "alert_heatmap", "family": "an",
        "title": "Heatmap des alertes",
        "columns": [("bucket_start", "Tranche", "text"), ("count", "Alertes", "int")],
        "summary": ["total_alerts", "bucket", "since", "until"], "sort": None,
    },
    {
        "slot": "notification_heatmap", "family": "an",
        "title": "Heatmap des notifications",
        "columns": [("bucket_start", "Tranche", "text"), ("count", "Notifications", "int")],
        "summary": ["total_notifications", "bucket", "since", "until"], "sort": None,
    },
    {
        "slot": "noisy_hosts", "family": "an",
        "title": "H\u00f4tes les plus bruyants",
        "columns": [
            ("host", "H\u00f4te", "text"),
            ("alert_count", "Alertes", "int"),
            ("last_state", "Dernier \u00e9tat", "text"),
            ("last_alert_time", "Derni\u00e8re alerte", "text"),
        ],
        "summary": ["total_alerts_in_window", "since", "until"],
        "sort": ("alert_count", "desc"),
    },
    {
        "slot": "noisy_services", "family": "an",
        "title": "Services les plus bruyants",
        "columns": [
            ("host", "H\u00f4te", "text"),
            ("service", "Service", "text"),
            ("alert_count", "Alertes", "int"),
            ("last_state", "Dernier \u00e9tat", "text"),
            ("last_alert_time", "Derni\u00e8re alerte", "text"),
        ],
        "summary": ["total_alerts_in_window", "since", "until"],
        "sort": ("alert_count", "desc"),
    },
    {
        "slot": "recurring_problems", "family": "an",
        "title": "Probl\u00e8mes r\u00e9currents (chroniques)",
        "columns": [
            ("host", "H\u00f4te", "text"),
            ("service", "Service", "text"),
            ("alert_count", "Alertes", "int"),
            ("first_seen", "Premi\u00e8re", "text"),
            ("last_seen", "Derni\u00e8re", "text"),
            ("last_state", "Dernier \u00e9tat", "text"),
        ],
        "summary": ["total_objects_above_threshold", "min_alerts"],
        "sort": ("alert_count", "desc"),
    },
    {
        "slot": "flap_summary", "family": "an",
        "title": "Flapping (transitions d'\u00e9tat)",
        "columns": [
            ("host", "H\u00f4te", "text"),
            ("service", "Service", "text"),
            ("transition_count", "Transitions", "int"),
            ("states_seen", "\u00c9tats vus", "list"),
            ("last_state", "Dernier \u00e9tat", "text"),
            ("last_alert_time", "Derni\u00e8re", "text"),
        ],
        "summary": ["total_flapping_objects", "min_transitions"],
        "sort": ("transition_count", "desc"),
    },
    {
        "slot": "concurrent_failures", "family": "an",
        "title": "Pannes concurrentes (storms multi-h\u00f4tes)",
        "columns": [
            ("window_start", "D\u00e9but", "text"),
            ("window_end", "Fin", "text"),
            ("count", "H\u00f4tes", "int"),
            ("hosts", "Liste des h\u00f4tes", "list"),
        ],
        "summary": ["total_down_events", "window_minutes", "min_hosts"],
        "sort": ("count", "desc"),
    },
    {
        "slot": "notification_summary", "family": "an",
        "title": "Notifications agr\u00e9g\u00e9es",
        "columns": [
            (["contact", "host", "service", "state", "command", "key"], "Cl\u00e9", "text"),
            ("count", "Notifications", "int"),
            ("last_time", "Derni\u00e8re", "text"),
        ],
        "summary": ["group_by", "total", "since", "until"],
        "sort": ("count", "desc"),
    },
    {
        "slot": "reliability_report", "family": "an",
        "title": "Fiabilit\u00e9 \u2014 MTTR / MTBF / incidents",
        "columns": [
            ("host", "H\u00f4te", "text"),
            ("service", "Service", "text"),
            ("incidents", "Incidents", "int"),
            ("mttr_human", "MTTR", "text"),
            ("mtbf_human", "MTBF", "text"),
            ("total_downtime_human", "Indispo cumul\u00e9e", "text"),
            ("longest_incident_human", "Plus long", "text"),
            ("ongoing", "En cours", "bool"),
        ],
        "summary": ["total_objects", "since", "until"],
        "sort": ("total_downtime_seconds", "desc"),
    },
    # ---------- Family C — availability / SLA & performance ----------
    {
        "slot": "host_availability", "family": "av",
        "title": "Disponibilit\u00e9 \u2014 h\u00f4tes (pire au mieux)",
        "columns": [
            ("host", "H\u00f4te", "text"),
            ("time_up_percent", "Dispo %", "pct"),
            ("time_down_percent", "DOWN %", "pct"),
            ("scheduled_time_down_percent", "Downtime planifi\u00e9 %", "pct"),
            ("time_indeterminate_outside_timeperiod_percent", "Ind\u00e9termin\u00e9 %", "pct"),
        ],
        "summary": ["hostgroup", "total", "timeperiod"],
        "sort": ("time_up_percent", "asc"),
    },
    {
        "slot": "service_availability", "family": "av",
        "title": "Disponibilit\u00e9 \u2014 services (pire au mieux)",
        "columns": [
            ("host", "H\u00f4te", "text"),
            ("service", "Service", "text"),
            ("time_ok_percent", "OK %", "pct"),
            ("time_critical_percent", "CRIT %", "pct"),
            ("time_warning_percent", "WARN %", "pct"),
            ("time_unknown_percent", "UNKNOWN %", "pct"),
        ],
        "summary": ["hostgroup", "total", "timeperiod"],
        "sort": ("time_ok_percent", "asc"),
    },
    {
        "slot": "perfdata_near_threshold", "family": "av",
        "title": "Perfdata proches du seuil (warn/crit)",
        "columns": [
            ("host", "H\u00f4te", "text"),
            ("service", "Service", "text"),
            ("label", "M\u00e9trique", "text"),
            ("value", "Valeur", "text"),
            ("uom", "Unit\u00e9", "text"),
            ("warn", "Warn", "text"),
            ("crit", "Crit", "text"),
            ("headroom_percent", "Marge %", "pct"),
            ("breached", "D\u00e9pass\u00e9", "bool"),
        ],
        "summary": ["within_percent", "total"],
        "sort": ("headroom_percent", "asc"),
    },
]

FAMILY_TITLES = {
    "pi": "A \u2014 Problem intelligence (\u00e9tat courant)",
    "an": "B \u2014 Analytics (fen\u00eatre glissante)",
    "av": "C \u2014 Disponibilit\u00e9 / SLA & performance",
}

# ----- IO helpers ---------------------------------------------------

def _load(name, *, required=False):
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


def _esc(s):
    return html.escape("" if s is None else str(s), quote=True)


def _resolve(row, key):
    if isinstance(key, (list, tuple)):
        for k in key:
            v = row.get(k)
            if v is not None:
                return v
        return None
    return row.get(key)


def _human_minutes(mins):
    if mins < 0:
        return str(mins)
    d, rem = divmod(mins, 1440)
    h, m = divmod(rem, 60)
    out = []
    if d:
        out.append(f"{d}j")
    if h:
        out.append(f"{h}h")
    if m or not out:
        out.append(f"{m}m")
    return " ".join(out)


def _fmt(v, fmt):
    if v is None or v == "":
        return "\u2014"
    if fmt == "bool":
        if isinstance(v, bool):
            return "\u2713" if v else "\u2014"
        return _esc(v)
    if fmt == "int":
        try:
            return _esc(int(v))
        except (TypeError, ValueError):
            return _esc(v)
    if fmt == "pct":
        try:
            f = float(v)
        except (TypeError, ValueError):
            return _esc(v)
        s = f"{f:.2f}".rstrip("0").rstrip(".")
        return _esc(s + "\u00a0%")
    if fmt == "dur_min":
        try:
            return _esc(_human_minutes(int(v)))
        except (TypeError, ValueError):
            return _esc(v)
    if fmt == "dur_s":
        try:
            return _esc(_human_minutes(int(v) // 60))
        except (TypeError, ValueError):
            return _esc(v)
    if fmt == "list":
        if isinstance(v, (list, tuple)):
            joined = ", ".join(str(x) for x in v)
            prefix = f"{len(v)}\u00d7 " if len(v) > 1 else ""
            s = prefix + joined
        else:
            s = str(v)
        if len(s) > MAX_CELL_CHARS:
            s = s[: MAX_CELL_CHARS - 1] + "\u2026"
        return _esc(s)
    if isinstance(v, (list, dict)):
        s = json.dumps(v, sort_keys=True, ensure_ascii=False)
    else:
        s = str(v)
    if len(s) > MAX_CELL_CHARS:
        s = s[: MAX_CELL_CHARS - 1] + "\u2026"
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
FAMILY_H = (
    "font-family:Arial,sans-serif;color:#fff;background:#37474f;"
    "margin:32px 0 4px 0;padding:8px 12px;border-radius:4px;"
)
SECTION_H2 = (
    "font-family:Arial,sans-serif;color:#263238;margin:20px 0 4px 0;"
    "padding-bottom:4px;border-bottom:2px solid #cfd8dc;"
)
CAPTION = (
    "font-family:Arial,sans-serif;color:#546e7a;font-size:12px;"
    "margin:0 0 6px 0;"
)
EMPTY_NOTE = (
    '<p style="font-family:Arial,sans-serif;color:#2e7d32;'
    'margin:4px 0 16px 0;">\u2713 (aucun)</p>'
)
MISSING_NOTE = (
    '<p style="font-family:Arial,sans-serif;color:#9e9e9e;'
    'margin:4px 0 16px 0;font-style:italic;">(slot non collect\u00e9)</p>'
)


def _warn_note(text):
    return (
        f'<p style="font-family:Arial,sans-serif;color:#ef6c00;'
        f'font-size:12px;margin:0 0 6px 0;">\u26a0\ufe0f {_esc(text)}</p>'
    )


# ----- Envelope unwrap ----------------------------------------------

def _unwrap(payload):
    warnings = []
    if payload is None:
        return None, {}, warnings
    if isinstance(payload, list):
        return payload, {}, warnings
    if isinstance(payload, dict):
        scalars = {}
        rows = None
        for k, v in payload.items():
            if k == "_warning":
                if v:
                    warnings.append(str(v))
            elif k == "_warnings":
                warnings.extend(str(x) for x in (v or []))
            elif isinstance(v, list) and k in ("results", "data", "rows", "items"):
                rows = v
            elif isinstance(v, (str, int, float, bool)) or v is None:
                scalars[k] = v
        if rows is not None:
            return rows, scalars, warnings
        sub = {k: v for k, v in payload.items()
               if isinstance(v, dict) and not k.startswith("_")}
        if sub:
            flat = []
            for gk in sorted(sub.keys()):
                row = {"_groupe": gk}
                row.update(sub[gk])
                flat.append(row)
            return flat, {}, warnings
        return [], scalars, warnings
    return [{"valeur": payload}], {}, warnings


def _sort_rows(rows, sort):
    if not sort:
        return rows
    key, order = sort
    rev = order == "desc"

    def k(r):
        v = _resolve(r, key)
        if v is None:
            return (1, 0)
        try:
            return (0, float(v))
        except (TypeError, ValueError):
            return (0, str(v))

    return sorted(rows, key=k, reverse=rev)


def _columns_present(rows, columns):
    if columns is None:
        seen = []
        for r in rows:
            if isinstance(r, dict):
                for kk in r.keys():
                    if kk not in seen:
                        seen.append(kk)
        return [(c, c, "text") for c in seen[:12]]
    out = []
    for key, header, fmt in columns:
        if any(isinstance(r, dict) and _resolve(r, key) is not None for r in rows):
            out.append((key, header, fmt))
    return out


def _render_table(rows, columns):
    cols = _columns_present(rows, columns)
    if not cols:
        return EMPTY_NOTE
    head = "".join(f'<th style="{TH_STYLE}">{_esc(h)}</th>' for _k, h, _f in cols)
    out = [f'<table style="{TABLE_STYLE}"><thead><tr>{head}</tr></thead><tbody>']
    capped = rows[:MAX_ROWS_PER_SECTION]
    for r in capped:
        if not isinstance(r, dict):
            r = {"valeur": r}
        cells = "".join(
            f'<td style="{TD_STYLE}">{_fmt(_resolve(r, k), f)}</td>'
            for k, _h, f in cols
        )
        out.append(f"<tr>{cells}</tr>")
    out.append("</tbody></table>")
    if len(rows) > MAX_ROWS_PER_SECTION:
        out.append(
            f'<p style="font-family:Arial,sans-serif;color:#616161;'
            f'font-size:12px;margin:0 0 16px 0;">\u2026 + '
            f"{len(rows) - MAX_ROWS_PER_SECTION} ligne(s) tronqu\u00e9e(s).</p>"
        )
    return "".join(out)


def _caption(scalars, keys):
    if keys is not None:
        items = [(k, scalars[k]) for k in keys
                 if k in scalars and scalars[k] not in (None, "")]
    else:
        items = [(k, v) for k, v in sorted(scalars.items()) if v not in (None, "")]
    if not items:
        return ""
    body = " \u00b7 ".join(f"{_esc(k)}=<b>{_esc(v)}</b>" for k, v in items)
    return f'<p style="{CAPTION}">{body}</p>'

# ----- Main ---------------------------------------------------------

def main():
    meta = _load("meta.json", required=True)
    if not isinstance(meta, dict):
        sys.stderr.write("meta.json is not a JSON object\n")
        return 2

    scope_label = str(meta.get("scope_label", "\u2014"))
    period_label = str(meta.get("period_label", "\u2014"))
    since = str(meta.get("since", "\u2014"))
    until = str(meta.get("until", "\u2014"))
    hostgroup = meta.get("hostgroup") or "\u2014"
    custom_vars = meta.get("custom_vars") or {}
    cv_str = ", ".join(f"{k}={v}" for k, v in sorted(custom_vars.items())) or "\u2014"
    warnings = meta.get("warnings") or []
    generated_at = meta.get("generated_at") or datetime.now(timezone.utc).strftime(
        "%Y-%m-%d %H:%M UTC"
    )

    parts = []
    parts.append('<div style="font-family:Arial,sans-serif;color:#263238;max-width:1200px;">')
    parts.append(
        f'<h1 style="color:#263238;margin:0 0 8px 0;">Rapport monitoring '
        f'{_esc(scope_label)} \u2014 {_esc(period_label)}</h1>'
    )
    parts.append(
        f'<p style="margin:0 0 4px 0;">Fen\u00eatre : du <b>{_esc(since)}</b> '
        f'au <b>{_esc(until)}</b>.</p>'
    )
    parts.append(
        f'<p style="margin:0 0 4px 0;">P\u00e9rim\u00e8tre : hostgroup=<b>{_esc(hostgroup)}</b>, '
        f'custom_vars=<b>{_esc(cv_str)}</b>.</p>'
    )
    for w in warnings:
        parts.append(_warn_note(str(w)))

    rendered = []
    for spec in SECTIONS:
        payload = _load(f"{spec['slot']}.json", required=False)
        if payload is None:
            rendered.append((spec["family"], spec["title"], MISSING_NOTE, -1))
            continue
        rows, scalars, env_warn = _unwrap(payload)
        if rows is None:
            rendered.append((spec["family"], spec["title"], MISSING_NOTE, -1))
            continue
        rows = [r for r in rows if isinstance(r, dict)]
        rows = _sort_rows(rows, spec.get("sort"))
        body_parts = [_caption(scalars, spec.get("summary"))]
        for w in env_warn:
            body_parts.append(_warn_note(w))
        if not rows:
            body_parts.append(EMPTY_NOTE)
        else:
            body_parts.append(_render_table(rows, spec.get("columns")))
        rendered.append((spec["family"], spec["title"], "".join(body_parts), len(rows)))

    parts.append(f'<h2 style="{SECTION_H2}">Synth\u00e8se</h2>')
    toc_rows = []
    for family, title, _body, count in rendered:
        cnt = "\u2014" if count < 0 else count
        toc_rows.append(
            f'<tr><td style="{TD_STYLE}">{_esc(FAMILY_TITLES.get(family, family))}</td>'
            f'<td style="{TD_STYLE}">{_esc(title)}</td>'
            f'<td style="{TD_STYLE};text-align:right;width:90px;">{_esc(cnt)}</td></tr>'
        )
    parts.append(
        f'<table style="{TABLE_STYLE}"><thead><tr>'
        f'<th style="{TH_STYLE}">Famille</th>'
        f'<th style="{TH_STYLE}">Section</th>'
        f'<th style="{TH_STYLE};text-align:right;">Lignes</th>'
        f"</tr></thead><tbody>{''.join(toc_rows)}</tbody></table>"
    )

    current_family = None
    for family, title, body, _count in rendered:
        if family != current_family:
            parts.append(
                f'<h2 style="{FAMILY_H}">{_esc(FAMILY_TITLES.get(family, family))}</h2>'
            )
            current_family = family
        parts.append(f'<h3 style="{SECTION_H2}">{_esc(title)}</h3>')
        parts.append(body)

    parts.append(
        f'<p style="font-family:Arial,sans-serif;color:#616161;font-size:11px;'
        f'margin-top:24px;">G\u00e9n\u00e9r\u00e9 par <code>kdust/thruk-monitoring-report</code> \u2014 '
        f'{_esc(generated_at)}</p>'
    )
    parts.append("</div>")

    html_doc = (
        '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">'
        f"<title>Monitoring {_esc(scope_label)} {_esc(period_label)}</title>"
        "</head><body>" + "".join(parts) + "</body></html>"
    )

    out_path = WORKDIR / "report.html"
    out_path.write_text(html_doc, encoding="utf-8")

    counts = ", ".join(
        f"{t}={c if c >= 0 else 'NA'}" for _f, t, _b, c in rendered
    )
    print(f"OK: report.html written ({len(html_doc)} bytes) \u2014 {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
