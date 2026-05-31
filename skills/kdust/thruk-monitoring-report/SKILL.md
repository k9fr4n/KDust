---
name: thruk-monitoring-report
description: |
  Generate a deterministic HTML monitoring report from Thruk and
  send it by email. The agent collects pre-aggregated JSON from the
  read-only `thruk_*` MCP tools — focused on the AVAILABILITY/SLA,
  ANALYTICS and PROBLEM-INTELLIGENCE families (thruk-mcp v1.8.0) —
  hands each response verbatim to `scripts/save.sh`, then runs
  `scripts/render.py` (pure-Python, stdlib only) to format the dumps
  into a fixed 3-family HTML template, and finally delivers it via
  the `ews-mcp` `send_email` tool (Exchange Web Services). Use this
  skill for any Thruk monitoring digest (Windows / Linux / network /
  …); the perimeter is parameterised by hostgroup and/or custom_var
  so the same skill serves multiple scopes. Read this skill BEFORE
  composing a Thruk report by hand.
whenToUse: |
  When a task asks for a scheduled or on-demand Thruk monitoring
  digest (SLA/availability + sliding-window analytics + open
  problems) restricted to a perimeter (hostgroup and/or custom_vars
  KERNEL=…) and delivered as an HTML email. Always prefer this skill
  over composing the HTML inline — the renderer is byte-stable across
  runs given the same inputs, which is the whole point.
---

# Thruk monitoring report

Deterministic Thruk → HTML email pipeline. The agent only orchestrates
MCP calls and shell commands; **all aggregation is done by `thruk-mcp`
server-side** (v1.8.0), and the HTML formatting is done by a single
schema-aware Python renderer. Final delivery is the `ews-mcp`
`send_email` tool. Same inputs ⇒ same report.

This v2 rewrite is built almost entirely from three read-only tool
families:

- **Problem intelligence** (current state): which problems are open,
  unacked, old, or silently broken.
- **Analytics** (sliding window over the log): noise, storms,
  flapping, recurrence, notifications, reliability (MTTR/MTBF).
- **Availability / SLA & performance**: uptime % per host/service and
  metrics about to breach their warn/crit threshold.

## Pipeline

```
LLM ── thruk_* MCP calls ─▶ save.sh ── /tmp/thruk-report/*.json
                                            │
                                            ▼
                                       render.py ── report.html
                                            │
                                            ▼
                              cat report.html → ews-mcp send_email
```

Every analytics / availability / problem-intelligence tool returns an
**envelope**: `{since, until, total_*, results:[...], _warning?}`.
`save.sh` stores the response **verbatim**; `render.py` unwraps
`results`, shows the envelope scalars (counts, window, group_by) as a
one-line caption, and renders `_warning(s)` as an orange note — nothing
is dropped.

## Sections of the report (fixed order, 3 families)

One **slot file** per row in `/tmp/thruk-report/`. Order + columns are
locked by the `SECTIONS` list in `scripts/render.py` — if you add /
remove / reorder a slot, update BOTH this table and `SECTIONS` in the
same commit. Missing slots render as "(slot non collecté)", empty
ones as "✓ (aucun)" — never a crash.

### Family A — Problem intelligence (current state)

| Slot file              | MCP tool                  | Key params |
|------------------------|---------------------------|-----------|
| `problem_counts.json`  | `thruk_problem_counts`    | filter |
| `unacked_critical.json`| `thruk_unacked_critical`  | filter, threshold_minutes=60 |
| `oldest_problems.json` | `thruk_oldest_problems`   | filter, limit=20 |
| `stale_acks.json`      | `thruk_stale_acks`        | filter, min_days=7 |
| `stale_checks.json`    | `thruk_stale_checks`      | filter |

### Family B — Analytics (sliding window)

| Slot file                  | MCP tool                      | Key params |
|----------------------------|-------------------------------|-----------|
| `alert_heatmap.json`       | `thruk_alert_heatmap`         | filter, since, bucket |
| `notification_heatmap.json`| `thruk_notification_heatmap`  | filter, since, bucket |
| `noisy_hosts.json`         | `thruk_top_noisy_hosts`       | filter, since, limit=20 |
| `noisy_services.json`      | `thruk_top_noisy_services`    | filter, since, limit=20 |
| `recurring_problems.json`  | `thruk_recurring_problems`    | filter, since, min_alerts=5 |
| `flap_summary.json`        | `thruk_flap_summary`          | filter, since, limit=20 |
| `concurrent_failures.json` | `thruk_concurrent_failures`   | filter, since, min_hosts=3 |
| `notification_summary.json`| `thruk_notification_summary`  | filter, since, group_by='host' |
| `reliability_report.json`  | `thruk_reliability_report`    | filter, since='-7d', limit=50 |

### Family C — Availability / SLA & performance

| Slot file                    | MCP tool                       | Key params |
|------------------------------|--------------------------------|-----------|
| `host_availability.json`     | `thruk_hostgroup_availability` | hostgroup, type='hosts', timeperiod |
| `service_availability.json`  | `thruk_hostgroup_availability` | hostgroup, type='services', timeperiod |
| `perfdata_near_threshold.json`| `thruk_perfdata_near_threshold`| filter, within_percent=10, limit |

> The two availability slots come from the SAME tool with a different
> `type=`. `host_availability` rows carry `time_up_percent`,
> `service_availability` rows carry `time_ok_percent` — the renderer
> sorts each worst-first and caps to 50 rows. Do **not** use
> `type='both'` into one slot (mixes the two column sets and the
> 900+ row payload always spills).

## Perimeter — one call, OR filter (no more `--merge`)

thruk-mcp's structured `filter` tree supports **OR**, so a perimeter
that is the UNION of a hostgroup and a custom_var is expressed in a
**single** MCP call. The old two-call `--merge` dance is gone.

```json
{"type":"group","operator":"or","conditions":[
  {"type":"leaf","field":"hostgroup","op":"eq","value":"HG_WINDOWS"},
  {"type":"leaf","field":"custom_var","op":"eq","value":{"var":"KERNEL","val":"windows"}}
]}
```

For a single-filter perimeter, use a bare leaf:
`{"type":"leaf","field":"hostgroup","op":"eq","value":"HG_WINDOWS"}`.

> **Availability exception**: `thruk_hostgroup_availability` takes a
> `hostgroup` NAME, not a filter tree — it cannot express the
> custom_var leg of a union. The SLA tables therefore cover the
> hostgroup only. If the perimeter has custom_vars but no hostgroup,
> skip the two availability slots (write nothing) and push a warning
> into `meta.warnings`.

## Working directory

`/tmp/thruk-report/` — scratch directory inside the kdust container.
`save.sh init` wipes its CONTENTS (not the dir) before each run.

If a large MCP response is spilled by the runtime as a Dust `fil_*`
reference, materialise it first with
`export_fil_to_workdir(file_id, dest_path=/tmp/thruk-report/<slot>.raw.json)`
then `save.sh <slot>.json --from-file /tmp/thruk-report/<slot>.raw.json`.
Allowed `--from-file` roots: `/tmp/thruk-report`, `/tmp/kdust-fil-cache`,
`/projects`, and relative `conversation/*` paths.

## Procedure for the agent

### 1. Decide the window (ISO-8601 UTC)

- Monday → `since = now − 72 h`, `period_label='72h'`.
- Tue–Fri → `since = now − 24 h`, `period_label='24h'`.
- `until = now`.
- The analytics tools also accept Thruk relative time (`-24h`,
  `-72h`, `-7d`) directly in `since=` — use that; reserve the ISO
  values for `meta` + availability `timeperiod`.
- For availability, prefer the Thruk-native `timeperiod` shortcut
  (`last24hours`, `lastweek`) over `since/until`.
- `reliability_report` is best over a longer window (`since='-7d'`).

### 2. Initialise the workdir + meta

```
run_skill_script(
  skill='kdust/thruk-monitoring-report',
  command=['scripts/save.sh', 'init'],
  stdin=JSON.stringify({
    scope_label:  'Windows',             # subject + header
    hostgroup:    'HG_WINDOWS',          # or null
    custom_vars:  { KERNEL: 'windows' }, # or {}
    since:        '<ISO UTC>',
    until:        '<ISO UTC>',
    period_label: '24h',                 # or '72h'
    warnings:     []                     # agent appends caveats here
  })
)
```

### 3. Collect each slot

For every row in the tables above: call the MCP tool with the OR
filter (or hostgroup name for availability) and persist verbatim:

```
scripts/save.sh <slot>.json                  # stdin = MCP response
scripts/save.sh <slot>.json --from-file <p>  # large response spilled to <p>
```

Typical calls (perimeter = HG_WINDOWS ∪ KERNEL=windows):

- `thruk_problem_counts(filter=<OR>)`
- `thruk_unacked_critical(filter=<OR>, threshold_minutes=60)`
- `thruk_oldest_problems(filter=<OR>, limit=20)`
- `thruk_stale_acks(filter=<OR>, min_days=7)`
- `thruk_stale_checks(filter=<OR>)`
- `thruk_alert_heatmap(filter=<OR>, since='-24h', bucket='1h')`
- `thruk_notification_heatmap(filter=<OR>, since='-24h', bucket='1h')`
- `thruk_top_noisy_hosts(filter=<OR>, since='-24h', limit=20)`
- `thruk_top_noisy_services(filter=<OR>, since='-24h', limit=20)`
- `thruk_recurring_problems(filter=<OR>, since='-24h', min_alerts=5)`
- `thruk_flap_summary(filter=<OR>, since='-24h', limit=20)`
- `thruk_concurrent_failures(filter=<OR>, since='-24h', min_hosts=3)`
- `thruk_notification_summary(filter=<OR>, since='-24h', group_by='host')`
- `thruk_reliability_report(filter=<OR>, since='-7d', limit=50)`
- `thruk_hostgroup_availability(hostgroup='HG_WINDOWS', type='hosts', timeperiod='last24hours')` → `host_availability.json`
- `thruk_hostgroup_availability(hostgroup='HG_WINDOWS', type='services', timeperiod='last24hours')` → `service_availability.json`
- `thruk_perfdata_near_threshold(filter=<OR>, within_percent=10, limit=200)`

### 4. Render the HTML

```
run_skill_script(
  skill='kdust/thruk-monitoring-report',
  command=['python3', 'scripts/render.py']
)
```

Stdout = a one-line summary with row counts per slot (`NA` = slot not
collected). The HTML lands at `/tmp/thruk-report/report.html`.

### 5. Send the email (via `ews-mcp`)

1. Read the HTML: `run_command(cat /tmp/thruk-report/report.html)`.
   Typically 30–200 KB — well under the tool body cap. If it ever
   overflows, lower `MAX_ROWS_PER_SECTION` / `limit=`, never truncate
   at the agent level.
2. Build the subject from `meta.json`:
   `[Monitoring <scope_label>] Rapport <period_label> — <YYYY-MM-DD>`
3. Call `send_email`:
   ```
   send_email(
     to:          ["fsallet@ecritel.net"],
     subject:     "<built above>",
     body:        "<contents of report.html>",
     body_format: "html",
     importance:  "Normal"
   )
   ```
   Do **not** set `target_mailbox` (the bound mailbox is the right
   From:), do **not** add a plain-text part, do **not** attach the
   HTML as a file — the HTML IS the body. Surface the returned
   `message_id` in the run output.

## Read-only contract

This skill NEVER calls `thruk_acknowledge`, `thruk_schedule_*`,
`thruk_recheck`, `thruk_remove_acknowledgement`, `thruk_delete_*`,
`thruk_checks`, `thruk_notifications`, or any other write tool. Keep
it that way — the report task needs read access only.

## Caps & gotchas

- Analytics tools cap the log scan at 10000 entries (`_warning` in the
  envelope, rendered as an orange note). Narrow `since=` if you hit it.
- `thruk_hostgroup_availability(type='both')` returns hosts+services
  in one shot (900+ rows) and always spills — use two `type=` calls.
- `save.sh init` wipes the workdir contents; `saved_to` / spill paths
  from previous runs are invalid afterwards.
- Determinism: same JSON inputs ⇒ same `report.html` (only
  `meta.generated_at`, defaulted to now, varies — set it explicitly
  for byte-stable output). If you see drift, the bug is in
  `render.py`; open an issue, do not patch the task prompt.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `render.py` exits `missing input: meta.json` | `save.sh init` not run | Run init first |
| Section shows "(slot non collecté)" | MCP call skipped | Collect that slot (or leave it — it is optional) |
| Section shows "✓ (aucun)" | Tool returned an empty `results` | Nothing to do — healthy perimeter |
| `save.sh: stdin is not valid JSON` | Streamed a non-JSON blob | Re-collect, or use `--from-file` for spilled payloads |
| `--from-file: path outside allowed roots` | Spill landed elsewhere | Re-export with `export_fil_to_workdir` to `/tmp/thruk-report/` |
| `send_email` auth / mailbox error | `ews-mcp` secret rotated / unbound | Re-bind the Secret in `/settings/mcp`, retry once |

## Extending the perimeter (Linux, network, …)

Scope-agnostic by design. To add a report: create a Task whose prompt
calls this skill with `scope_label`, `hostgroup` and/or `custom_vars`
set for the scope. No skill code change needed. See
`references/perimeters.md` for Ecritel perimeter conventions.
