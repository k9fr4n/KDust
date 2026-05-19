#!/usr/bin/env python3
# render.py — thruk-monitoring-report
#
# Reads /tmp/thruk-report/*.json (produced by save.sh) and emits
# /tmp/thruk-report/report.html using a fixed HTML template.
# Deterministic: same inputs ⇒ same output, byte for byte.
#
# stdlib only (no jinja, no pip).
from __future__ import annotations

import html
import json
import os
import pathlib
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

WORKDIR = pathlib.Path(os.environ.get("THRUK_REPORT_WORKDIR", "/tmp/thruk-report"))

# ----- Constants ----------------------------------------------------
# State -> (label, color). Centralised so the email is consistent.
HOST_STATE_LABEL = {0: "UP", 1: "DOWN", 2: "UNREACHABLE"}
SVC_STATE_LABEL  = {0: "OK", 1: "WARNING", 2: "CRITICAL", 3: "UNKNOWN"}
STATE_COLOR = {
    "OK":          "#2e7d32",
    "UP":          "#2e7d32",
    "WARNING":     "#ef6c00",
    "CRITICAL":    "#c62828",
    "DOWN":        "#c62828",
    "UNKNOWN":     "#616161",
    "UNREACHABLE": "#616161",
}
ALERTS_CAP = 5000  # mirrors save.sh / agent default limit

# ----- IO helpers ---------------------------------------------------

def _load(name: str, *, required: bool = True):
    p = WORKDIR / name
    if not p.exists():
        if required:
            sys.stderr.write(f"missing input: {name}\n")
            sys.exit(2)
        return [] if name != "meta.json" else {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.stderr.write(f"corrupt input: {name} ({e})\n")
        sys.exit(2)

def _fmt_duration(seconds: float | int | None) -> str:
    if seconds is None:
        return "—"
    try:
        s = int(seconds)
    except (TypeError, ValueError):
        return "—"
    if s < 0:
        return "—"
    days, s = divmod(s, 86400)
    hours, s = divmod(s, 3600)
    mins, _ = divmod(s, 60)
    if days:
        return f"{days}j {hours}h"
    if hours:
        return f"{hours}h {mins:02d}m"
    return f"{mins}m"

def _fmt_ts(ts: float | int | None) -> str:
    if not ts:
        return "—"
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    except (TypeError, ValueError, OSError):
        return "—"

def _esc(s) -> str:
    return html.escape("" if s is None else str(s), quote=True)

def _state_label(rec: dict) -> str:
    # A record is a host event if it has no service description.
    svc = rec.get("service_description") or rec.get("description") or ""
    state = rec.get("state")
    if svc == "":
        return HOST_STATE_LABEL.get(state, str(state) if state is not None else "—")
    return SVC_STATE_LABEL.get(state, str(state) if state is not None else "—")

# ----- Load inputs --------------------------------------------------

meta          = _load("meta.json")
hosts_hg      = _load("hosts_hostgroup.json", required=False)
hosts_cv      = _load("hosts_custom_var.json", required=False)
alerts        = _load("alerts.json")
notifications = _load("notifications.json")
problems      = _load("problems.json")

if not isinstance(meta, dict):
    sys.stderr.write("meta.json is not a JSON object\n")
    sys.exit(2)

# ----- Perimeter ----------------------------------------------------

def _names(records):
    out = set()
    for r in records or []:
        n = r.get("name") or r.get("host_name")
        if isinstance(n, str) and n:
            out.add(n)
    return out

win_hosts = _names(hosts_hg) | _names(hosts_cv)

def _keep(rec):
    h = rec.get("host_name") or rec.get("name")
    return isinstance(h, str) and h in win_hosts

if win_hosts:
    alerts        = [r for r in alerts        if _keep(r)]
    notifications = [r for r in notifications if _keep(r)]
    problems      = [r for r in problems      if _keep(r)]

# ----- Aggregations -------------------------------------------------

hard_count = sum(1 for r in alerts if int(r.get("hard", 0) or 0) == 1
                                   or r.get("state_type") in (1, "HARD"))
soft_count = len(alerts) - hard_count

by_state = Counter(_state_label(r) for r in alerts)

noisy_hosts = Counter()
noisy_pairs = Counter()
for r in alerts:
    h = r.get("host_name") or "—"
    s = r.get("service_description") or r.get("description") or ""
    noisy_hosts[h] += 1
    noisy_pairs[(h, s if s else "<host>")] += 1

transitions = defaultdict(int)
for r in alerts:
    h = r.get("host_name") or "—"
    s = r.get("service_description") or r.get("description") or ""
    transitions[(h, s)] += 1
flapping = sorted(
    ((h, s, n) for (h, s), n in transitions.items() if n >= 5),
    key=lambda t: (-t[2], t[0], t[1]),
)

notif_contacts = Counter()
for r in notifications:
    c = r.get("contact_name") or r.get("contact") or "—"
    notif_contacts[c] += 1

# Open problems: services in WARN/CRIT/UNK, hosts DOWN/UNREACH, NOT acked.
open_problems = []
for r in problems:
    acked = bool(r.get("acknowledged") or r.get("problem_has_been_acknowledged"))
    if acked:
        continue
    state = r.get("state")
    svc   = r.get("service_description") or r.get("description") or ""
    if svc:
        if state in (1, 2, 3):
            open_problems.append(r)
    else:
        if state in (1, 2):
            open_problems.append(r)

def _sort_problem_key(r):
    # Order: severity (CRIT/DOWN first, then WARN, then UNK/UNREACH),
    # then duration desc, then host/service.
    lbl = _state_label(r)
    sev = {"DOWN": 0, "CRITICAL": 1, "WARNING": 2, "UNKNOWN": 3, "UNREACHABLE": 4}.get(lbl, 9)
    now = int(datetime.now(timezone.utc).timestamp())
    last = int(r.get("last_state_change") or r.get("last_hard_state_change") or now)
    dur  = max(0, now - last)
    return (sev, -dur, r.get("host_name") or "", r.get("service_description") or "")

open_problems.sort(key=_sort_problem_key)

# We can't reliably infer a cap hit post-filter; the agent should
# set `alerts_truncated=true` in meta if it observed `len(response)`
# equal to the requested limit on the raw thruk_list_alerts call.
alerts_truncated = bool(meta.get("alerts_truncated", False))

# ----- HTML rendering ----------------------------------------------

def _color(label: str) -> str:
    return STATE_COLOR.get(label, "#424242")

def _state_pill(label: str) -> str:
    return (
        f'<span style="display:inline-block;padding:2px 8px;border-radius:10px;'
        f'background:{_color(label)};color:#fff;font-weight:600;font-size:11px;'
        f'">{_esc(label)}</span>'
    )

TABLE_STYLE = (
    'border-collapse:collapse;width:100%;font-family:Arial,sans-serif;'
    'font-size:13px;margin:8px 0 16px 0;'
)
TH_STYLE = (
    'background:#eceff1;color:#263238;text-align:left;padding:6px 10px;'
    'border:1px solid #cfd8dc;font-weight:600;'
)
TD_STYLE = 'padding:6px 10px;border:1px solid #cfd8dc;vertical-align:top;'
SECTION_H2 = (
    'font-family:Arial,sans-serif;color:#263238;margin:24px 0 8px 0;'
    'padding-bottom:4px;border-bottom:2px solid #cfd8dc;'
)

def _table(headers, rows) -> str:
    if not rows:
        return '<p style="font-family:Arial,sans-serif;color:#616161;">(aucun)</p>'
    out = [f'<table style="{TABLE_STYLE}"><thead><tr>']
    for h in headers:
        out.append(f'<th style="{TH_STYLE}">{_esc(h)}</th>')
    out.append('</tr></thead><tbody>')
    for row in rows:
        out.append('<tr>')
        for cell in row:
            out.append(f'<td style="{TD_STYLE}">{cell}</td>')
        out.append('</tr>')
    out.append('</tbody></table>')
    return ''.join(out)

scope_label  = str(meta.get("scope_label", "—"))
period_label = str(meta.get("period_label", "—"))
since        = str(meta.get("since", "—"))
until        = str(meta.get("until", "—"))
hostgroup    = meta.get("hostgroup") or "—"
custom_vars  = meta.get("custom_vars") or {}
cv_str       = ", ".join(f"{k}={v}" for k, v in sorted(custom_vars.items())) or "—"

parts = []
parts.append(
    '<div style="font-family:Arial,sans-serif;color:#263238;max-width:1100px;">'
)
parts.append(
    f'<h1 style="color:#263238;margin:0 0 8px 0;">Rapport monitoring {_esc(scope_label)} '
    f'— {_esc(period_label)}</h1>'
)
parts.append(
    f'<p style="margin:0 0 4px 0;">Période couverte : <b>{_esc(period_label)}</b> '
    f'(du {_esc(since)} au {_esc(until)}).</p>'
)
parts.append(
    f'<p style="margin:0 0 4px 0;">Périmètre : hostgroup=<b>{_esc(hostgroup)}</b>, '
    f'custom_vars=<b>{_esc(cv_str)}</b>, <b>{len(win_hosts)}</b> hôte(s).</p>'
)
if not win_hosts:
    parts.append(
        '<p style="color:#c62828;font-weight:600;">Aucun hôte identifié dans le '
        'périmètre — le rapport ci-dessous est vide par construction.</p>'
    )
if alerts_truncated:
    parts.append(
        f'<p style="color:#ef6c00;font-weight:600;">⚠️ thruk_list_alerts a atteint '
        f'le cap de {ALERTS_CAP} entrées — les chiffres ci-dessous sont un minorant.</p>'
    )

# ----- Synthèse -----------------------------------------------------
parts.append(f'<h2 style="{SECTION_H2}">Synthèse</h2>')
parts.append(_table(
    ["Indicateur", "Valeur"],
    [
        ["Alertes (total)",          _esc(len(alerts))],
        ["Alertes HARD",             _esc(hard_count)],
        ["Alertes SOFT",             _esc(soft_count)],
        ["Notifications envoyées",   _esc(len(notifications))],
        ["Problèmes ouverts (non-ack)", _esc(len(open_problems))],
        ["Hôtes dans le périmètre",  _esc(len(win_hosts))],
    ],
))

# ----- Répartition par état ---------------------------------------
parts.append(f'<h2 style="{SECTION_H2}">Répartition par état (alertes)</h2>')
state_order = ["OK", "UP", "WARNING", "CRITICAL", "DOWN", "UNKNOWN", "UNREACHABLE"]
rows = []
for s in state_order:
    if by_state.get(s):
        rows.append([_state_pill(s), _esc(by_state[s])])
for s, n in sorted(by_state.items()):
    if s not in state_order:
        rows.append([_state_pill(s), _esc(n)])
parts.append(_table(["État", "Nombre"], rows))

# ----- Top hôtes ----------------------------------------------------
parts.append(f'<h2 style="{SECTION_H2}">Top 10 hôtes les plus bruyants</h2>')
parts.append(_table(
    ["Hôte", "Alertes"],
    [[_esc(h), _esc(n)] for h, n in noisy_hosts.most_common(10)],
))

# ----- Top couples --------------------------------------------------
parts.append(f'<h2 style="{SECTION_H2}">Top 15 couples hôte / service</h2>')
parts.append(_table(
    ["Hôte", "Service", "Alertes"],
    [[_esc(h), _esc(s), _esc(n)] for (h, s), n in noisy_pairs.most_common(15)],
))

# ----- Flapping -----------------------------------------------------
parts.append(f'<h2 style="{SECTION_H2}">Flapping suspecté (≥ 5 transitions)</h2>')
parts.append(_table(
    ["Hôte", "Service", "Transitions"],
    [[_esc(h), _esc(s), _esc(n)] for (h, s, n) in flapping],
))

# ----- Notifications ------------------------------------------------
parts.append(f'<h2 style="{SECTION_H2}">Notifications</h2>')
parts.append(_table(
    ["Indicateur", "Valeur"],
    [
        ["Total notifications", _esc(len(notifications))],
    ],
))
parts.append('<p style="font-family:Arial,sans-serif;margin:8px 0 4px 0;">'
             'Top 5 contacts notifiés :</p>')
parts.append(_table(
    ["Contact", "Notifications"],
    [[_esc(c), _esc(n)] for c, n in notif_contacts.most_common(5)],
))

# ----- Problèmes ouverts -------------------------------------------
parts.append(f'<h2 style="{SECTION_H2}">Problèmes ouverts à traiter</h2>')
now_ts = int(datetime.now(timezone.utc).timestamp())
rows = []
for r in open_problems:
    lbl  = _state_label(r)
    last = r.get("last_state_change") or r.get("last_hard_state_change")
    dur  = (now_ts - int(last)) if last else None
    rows.append([
        _esc(r.get("host_name") or "—"),
        _esc(r.get("service_description") or ""),
        _state_pill(lbl),
        _esc(_fmt_ts(last)),
        _esc(_fmt_duration(dur)),
        _esc((r.get("plugin_output") or "").strip()[:200]),
    ])
parts.append(_table(
    ["Hôte", "Service", "État", "Depuis", "Durée", "Sortie plugin"],
    rows,
))

parts.append(
    f'<p style="font-family:Arial,sans-serif;color:#616161;font-size:11px;'
    f'margin-top:24px;">Généré par <code>kdust/thruk-monitoring-report</code> '
    f'— {_esc(datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))}</p>'
)
parts.append('</div>')

html_doc = (
    '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">'
    f'<title>Monitoring {_esc(scope_label)} {_esc(period_label)}</title>'
    '</head><body>' + "".join(parts) + '</body></html>'
)

out_path = WORKDIR / "report.html"
out_path.write_text(html_doc, encoding="utf-8")

# Tiny stdout summary (intentionally short — it ends up in the
# run output that goes back to the LLM).
print(
    f"OK: report.html written ({len(html_doc)} bytes) — hosts={len(win_hosts)} "
    f"alerts={len(alerts)} notifications={len(notifications)} "
    f"problems={len(open_problems)}"
)
