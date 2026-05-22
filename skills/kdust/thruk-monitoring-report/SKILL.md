---
name: thruk-monitoring-report
description: |
  Generate a deterministic HTML monitoring report from Thruk
  data and send it by email. The agent collects pre-aggregated
  JSON from the read-only `thruk_*` MCP tools (v1.1+ analytics
  included), hands each response verbatim to `scripts/save.sh`,
  then invokes `scripts/render.py` (pure-Python, stdlib only) to
  format the dumps into a fixed HTML template, and finally
  `scripts/send_mail.py` to deliver it via SMTP
  mailing.ecritel.net. Use this skill for any Thruk "daily
  alerts digest" task (Windows / Linux / network / …); the
  perimeter is parameterised by hostgroup + custom_var so the
  same skill serves multiple scopes. Read this skill BEFORE
  composing a Thruk report by hand.
whenToUse: |
  When a task asks for a scheduled or on-demand Thruk monitoring
  digest (analytics + open problems + notifications) restricted
  to a perimeter (hostgroup and/or custom_vars KERNEL=…) and
  delivered as an HTML email. Always prefer this skill over
  composing the HTML inline in the run output — the template
  here is byte-stable across runs, which is the whole point.
---

# Thruk monitoring report

Deterministic Thruk → HTML email pipeline. The agent only
orchestrates MCP calls and shell commands; **all aggregation is
done by `thruk-mcp` server-side** (v1.1+), and the HTML
formatting is done by a single schema-agnostic Python renderer.
Two runs with the same inputs produce the same report
byte-for-byte.

## Pipeline

```
LLM ── thruk_* MCP calls ─▶ save.sh ── /tmp/thruk-report/*.json
                                            │
                                            ▼
                                       render.py ── report.html
                                            │
                                            ▼
                                     send_mail.py ── SMTP
```

## Sections of the report (fixed order)

Each section corresponds to **one slot file** in
`/tmp/thruk-report/`. `render.py` is auto-table: any
list-of-dicts JSON becomes an HTML table whose columns mirror
the keys returned by `thruk-mcp`. Missing slots render as
"(slot non collecté)" — never a crash.

| # | Slot file | MCP tool | Note |
|---|---|---|---|
| 1  | `hosts_perimeter.json`       | `thruk_list_hosts`            | host inventory of the scope |
| 2  | `unacked_critical.json`      | `thruk_unacked_critical`      | CRIT/DOWN not acked for > N min |
| 3  | `oldest_problems.json`       | `thruk_oldest_problems`       | unhandled problems by age asc |
| 4  | `problems_by_hostgroup.json` | `thruk_problems_by_hostgroup` | problem counts per HG |
| 5  | `notifications.json`         | `thruk_list_notifications`    | notifications on the window |
| 6  | `alert_heatmap.json`         | `thruk_alert_heatmap`         | day × hour storm detection |
| 7  | `concurrent_failures.json`   | `thruk_concurrent_failures`   | sliding-window multi-host outages |
| 8  | `recurring_problems.json`    | `thruk_recurring_problems`    | chronic objects |
| 9  | `noisy_hosts.json`           | `thruk_top_noisy_hosts`       | hosts ranked by alert count |
| 10 | `noisy_services.json`        | `thruk_top_noisy_services`    | services ranked by alert count |
| 11 | `flap_summary.json`          | `thruk_flap_summary`          | most state transitions |
| 12 | `stale_acks.json`            | `thruk_stale_acks`            | acks older than N days |

`thruk_recent_events` is intentionally **NOT used** — the raw
event timeline drowned the mail in 1000-row tables, and every
useful angle is now exposed as a server-side aggregation.

## Working directory

`/tmp/thruk-report/` — scratch directory **inside the kdust
container only** (no host bind mount). `save.sh init` wipes its
contents (not the directory itself) before each run.

If a large MCP response is spilled by the runtime, two shapes
are possible:

- A `thruk-mcp` handle: `{ "mode": "file", "saved_to":
  "/tmp/thruk-report/…" }` (the file is already on disk because
  the path is bind-mounted into the thruk-mcp child container).
- A Dust `fil_*` reference (older fallback). Use
  `export_fil_to_workdir(file_id,
  dest_path=/tmp/thruk-report/…)` to materialise it first.

In both cases, pass the resulting path to
`save.sh <slot>.json --from-file <path>` instead of streaming
through stdin.

## Procedure for the agent

### 1. Decide the window (ISO-8601 UTC)

- Monday → `since = now − 72 h` (covers Fri 07:05 → Mon 07:05),
  `period_label='72h'`.
- Tue–Fri → `since = now − 24 h`, `period_label='24h'`.
- `until = now`.

### 2. Initialise the workdir + meta

```
run_skill_script(
  skill='kdust/thruk-monitoring-report',
  command=['scripts/save.sh', 'init'],
  stdin=JSON.stringify({
    scope_label: 'Windows',             # subject + header
    hostgroup:   'HG_WINDOWS',          # or null
    custom_vars: { KERNEL: 'windows' }, # or {}
    since:       '<ISO UTC>',
    until:       '<ISO UTC>',
    period_label:'24h',                 # or '72h'
    warnings:    []                     # filled by the agent if needed
  })
)
```

### 3. Collect each section

For every row in the table above, call the matching MCP tool
and persist the response with:

```
scripts/save.sh <slot>.json                  # stdin = MCP response array
scripts/save.sh <slot>.json --from-file <p>  # large response spilled to <p>
```

#### Union rule (perimeter = hostgroup ∪ custom_vars)

⚠️ `thruk-mcp` combines `hostgroup` and `custom_vars` filters
with **AND** at the `/hosts` pre-resolver stage. When the
perimeter is a **union** (e.g. `HG_WINDOWS` ∪ `KERNEL=windows`),
do **two MCP calls per section** and merge:

```
# call 1: hostgroup only
save.sh <slot>.json
# call 2: custom_vars only
save.sh <slot>.json --merge
```

`--merge` does union + dedupe by canonical JSON of each record.
If the perimeter is a single filter, one call is enough.

#### Tool-specific window parameters (typical values)

Most v1.1+ analytics accept a window via `hours=` or `since=`:

- `thruk_unacked_critical(min_age_minutes=15, …)`
- `thruk_oldest_problems(limit=20, …)`
- `thruk_problems_by_hostgroup(…)` (current state, no window)
- `thruk_list_notifications(since=<ISO>, limit=500, …)`
- `thruk_alert_heatmap(hours=<24|72>, …)`
- `thruk_concurrent_failures(hours=<24|72>, threshold=3, …)`
- `thruk_recurring_problems(hours=<24|72>, min_occurrences=3, …)`
- `thruk_top_noisy_hosts(hours=<24|72>, limit=20, …)`
- `thruk_top_noisy_services(hours=<24|72>, limit=20, …)`
- `thruk_flap_summary(hours=<24|72>, limit=20, …)`
- `thruk_stale_acks(min_age_days=7, …)`

Always include either `hostgroup=` or `custom_vars={…}` (one
per call — see union rule). For the perimeter inventory:
`thruk_list_hosts(columns='name', limit=10000, hostgroup=…)`.

### 4. Render the HTML

```
run_skill_script(
  skill='kdust/thruk-monitoring-report',
  command=['python3', 'scripts/render.py']
)
```

`render.py` is **schema-agnostic** — each slot is rendered as
an auto-table whose columns are the keys returned by the MCP
tool. No section-specific code, no aggregation. Stdout = a
one-line summary with row counts per slot.

### 5. Send the email

```
run_skill_script(
  skill='kdust/thruk-monitoring-report',
  command=['python3', 'scripts/send_mail.py',
          '--to', 'fsallet@ecritel.net']
)
```

Subject defaults to `[Monitoring <scope>] Rapport <period> —
<YYYY-MM-DD>`. Override with `--subject`. Stdout = `OK: mail
envoyé`.

## Read-only contract

This skill never calls `thruk_acknowledge`, `thruk_schedule_*`,
`thruk_recheck`, `thruk_remove_acknowledgement`, `thruk_delete_*`,
or any other write tool. Keep it that way — the `Thruk-Report`
task does not need write access.

## Caps & gotchas

- `thruk-mcp` pre-resolver caps `/hosts` lookups at 1000
  entries. If a perimeter exceeds 1000 hosts, push a warning
  into `meta.warnings` so the report flags it, and open an
  issue against thruk-mcp.
- Large MCP responses → handle shape
  `{"mode":"file","saved_to":…}` OR a Dust `fil_*` ref. Both
  flow through `save.sh --from-file <path>`.
- `save.sh init` wipes the workdir contents at the start of
  each run; `saved_to` paths from previous runs are invalid.
- Determinism: same JSON inputs ⇒ same `report.html` byte for
  byte. If you see drift, the bug is in `render.py` — open an
  issue, do **not** patch the task prompt.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `render.py` exits with `missing input: meta.json` | `save.sh init` not run | Run init first |
| Section shows "(slot non collecté)" | Corresponding MCP call was skipped, or returned a non-list shape the auto-renderer rejected | Re-collect that slot, or write `[]` if the slot is irrelevant for the scope |
| `save.sh --from-file: path does not exist` | Path is from a previous run, or `fil_*` not exported | Re-export with `export_fil_to_workdir`, re-run save.sh |
| `send_mail.py` SMTP timeout | `mailing.ecritel.net:25` unreachable | Surface stderr; do NOT retry blindly |

## Extending the perimeter (Linux, network, …)

Scope-agnostic by design. To add a new daily report:

1. Create a Task with a short prompt that calls this skill with
   `scope_label='Linux'`, `hostgroup='HG_LINUX'`,
   `custom_vars={"KERNEL":"linux"}` (or similar).
2. No skill code change needed.

See `references/perimeters.md` for the current Ecritel
perimeter conventions.
