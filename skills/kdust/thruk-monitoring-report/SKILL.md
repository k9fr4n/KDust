---
name: thruk-monitoring-report
description: |
  Generate a deterministic HTML monitoring report from Thruk
  data and send it by email. The agent calls the read-only
  `thruk_*` MCP tools, hands every JSON response verbatim to
  `scripts/save.sh` via stdin, then invokes `scripts/render.py`
  (pure-Python, stdlib only — no jinja, no pip install) to turn
  the dumps into a fixed HTML template, and finally
  `scripts/send_mail.py` to deliver it via SMTP
  mailing.ecritel.net. Use this skill for any Thruk "daily
  alerts digest" task (Windows / Linux / network / …); the
  perimeter is parameterised by hostgroup + custom_var so the
  same skill serves multiple scopes. Read this skill BEFORE
  composing a Thruk report by hand.
whenToUse: |
  When a task asks for a scheduled or on-demand Thruk monitoring
  digest (alerts / notifications / open problems) restricted to
  a perimeter (hostgroup and/or custom_vars KERNEL=…) and
  delivered as an HTML email. Always prefer this skill over
  composing the HTML inline in the run output — the template
  here is byte-stable across runs, which is the whole point.
---

# Thruk monitoring report skill

Deterministic Thruk → HTML email pipeline. The agent orchestrates
MCP calls and shell commands; **all aggregation and HTML rendering
happen in Python** so two runs with the same inputs produce the
same report byte-for-byte.

## When to use

Load this skill whenever a task asks for a Thruk monitoring digest
(alerts + notifications + open problems) on a host perimeter
(typically `HG_WINDOWS` ∪ `KERNEL=windows`, but the skill is
scope-agnostic). It replaces the inline "compose HTML by hand"
pattern that caused two issues in earlier `Thruk-Report` runs:

- the report HTML was 40-50 kB and varied between runs (section
  order, color codes, table shapes);
- the prompt had to embed the full layout + an SMTP script
  (~5 kB) just to keep the output consistent.

With this skill the task prompt shrinks to a handful of
parameters and the report is computed deterministically.

## Architecture (option A — MCP-audited collect)

```
  ┌────────────────────────────────────────────────────────┐
  │ LLM (orchestration only — no HTML, no aggregation)     │
  └────────────────────────────────────────────────────────┘
     │  thruk_list_hosts / thruk_list_alerts /
     │  thruk_list_notifications / thruk_problems   (MCP)
     ▼
  ┌────────────────────────────────────────────────────────┐
  │ mcp-gateway → thruk-mcp → Thruk REST API                │
  └────────────────────────────────────────────────────────┘
     │  raw JSON (audited via the gateway logs)
     ▼
  scripts/save.sh   stdin → /tmp/thruk-report/<name>.json
     │
     ▼
  scripts/render.py /tmp/thruk-report/*.json + scope params
     │              → /tmp/thruk-report/report.html
     ▼
  scripts/send_mail.py  HTML → SMTP mailing.ecritel.net:25
```

The LLM still sees the raw `thruk_*` JSON in tool outputs (that
is option A's contract: keep the MCP audit trail). The win is on
the **rendering** side: HTML and aggregations are pulled out of
the LLM, so the report is stable and the run output stays short.

## Working directory

`/tmp/thruk-report/` — scratch directory **inside the kdust container
only** (no host bind mount, no cross-container sharing). Used by
`save.sh` / `render.py` / `send_mail.py`. `save.sh init` wipes the
**contents** (not the directory itself) before each run.

Historical note (Franck 2026-05-21): an earlier version of thruk-mcp
spilled large responses to this same path via `THRUK_MCP_WORKDIR`
(issue k9fr4n/thruk-mcp#49). That mechanism was removed upstream;
large MCP payloads now come back as Dust `fil_*` references and the
agent uses `export_fil_to_workdir` to drop them into
`/tmp/thruk-report/` before passing the path to `save.sh --from-file`.

File naming convention (consumed by `render.py`):

| File | Source | Required |
|---|---|---|
| `hosts_hostgroup.json` | `thruk_list_hosts` with `hostgroup=<HG>` | yes (or empty array) |
| `hosts_custom_var.json` | `thruk_list_hosts` with `custom_vars={...}` | yes (or empty array) |
| `alerts.json` | `thruk_recent_events(only_alerts=true)` over the window (see issue #91) | yes |
| `notifications.json` | `thruk_list_notifications` since the window | yes |
| `problems.json` | `thruk_problems` | yes |
| `meta.json` | written by `save.sh init` | yes (auto) |

If a perimeter source is unused (e.g. scope = Linux, no hostgroup),
the agent MUST still write an empty array `[]` to the corresponding
file so `render.py` does not crash.

## Step-by-step procedure for the agent

1. **Decide the window.** ISO-8601 UTC.
   - Monday → `since` = now − 72 h (covers Fri 07:05 → Mon 07:05).
   - Tue–Fri → `since` = now − 24 h.
   - `until` = now.

2. **Init the workdir + meta:**

   ```
   run_skill_script(
     skill='kdust/thruk-monitoring-report',
     command=['scripts/save.sh', 'init'],
     stdin=JSON.stringify({
       scope_label: 'Windows',           # shown in subject + header
       hostgroup:   'HG_WINDOWS',        # or null
       custom_vars: { KERNEL: 'windows' },# or {}
       since:       '<ISO UTC>',
       until:       '<ISO UTC>',
       period_label:'24h',               # or '72h'
     })
   )
   ```

3. **Collect host perimeter** (one MCP call per source, pipe each
   verbatim into `save.sh`):

   - `thruk_list_hosts(hostgroup='HG_WINDOWS', columns='name', limit=5000)`
     → pipe stdout (the JSON array) to
     `save.sh hosts_hostgroup.json`.
   - `thruk_list_hosts(custom_vars={"KERNEL":"windows"}, columns='name', limit=10000)`
     → pipe to `save.sh hosts_custom_var.json`.

   Reminder: `_KERNEL=windows` is a native Thruk filter. Do NOT use
   `thruk_query` with `q="custom_variables…"` — that filter is
   silently dropped by the Thruk parser.

4. **Collect monitoring data** on the window.

   ⚠️ **One MCP filter per call (union, not AND).** `thruk-mcp`
   combines `hostgroup` + `custom_vars` with **AND** at the
   `/hosts` pre-resolver stage (`_resolve_hosts_to_regex`). When
   the perimeter is defined as a **union** (e.g. `HG_WINDOWS` ∪
   `KERNEL=windows`), passing both filters in the same call
   drops every host matched by only one of them. Do one MCP call
   per filter, save the first one with `save.sh <name>.json`,
   then merge subsequent ones with `save.sh <name>.json --merge`
   — that mode unions + dedupes on canonical-JSON of each
   record (Franck 2026-05-20).

   Concretely for the Windows perimeter, each of `alerts.json`,
   `notifications.json`, `problems.json` is produced by TWO MCP
   calls: one with `hostgroup='HG_WINDOWS'` (no `custom_vars`),
   one with `custom_vars={"KERNEL":"windows"}` (no `hostgroup`).

   **Two response shapes to expect from `thruk_*`** (since
   thruk-mcp v0.8 — issue k9fr4n/thruk-mcp#49):

   - **Inline JSON array** (payload ≤ ~256 KB) — same as before.
     Pipe verbatim through `save.sh <name>.json` (stdin).
   - **Spill handle** (payload > threshold) — a small JSON object:
     ```json
     {
       "mode": "file",
       "saved_to": "/tmp/thruk-report/thruk_recent_events_20260520T091200_a3f1c9b2.json",
       "rows": 1842,
       "bytes": 2938104,
       "sha256": "…",
       "filters": { … }
     }
     ```
     The file is ALREADY on disk in the shared workdir (see
     "Working directory" — same path bind-mounted into the
     thruk-mcp child container). In that case call
     `save.sh <name>.json --from-file <saved_to>` to copy/rename
     it into the slot `render.py` expects.

   Detection rule (cheap): if the tool response starts with `{` and
   contains `"mode": "file"` → it's a handle, use `--from-file`.
   Otherwise it's an inline array — pipe stdin as before.

   For each dataset, run the call with `hostgroup` first, save
   it, then run the call with `custom_vars` and `--merge`:

   - Alerts (⚠️ Do NOT use `thruk_list_alerts` — Thruk REST
     `/alerts` returns `[]` on Thruk 3.26 federated, issue #91):
     1. `thruk_recent_events(only_alerts=true, hours=<24|72>, hostgroup='HG_WINDOWS', limit=1000)`
        → `save.sh alerts.json` (or `--from-file <saved_to>`).
     2. `thruk_recent_events(only_alerts=true, hours=<24|72>, custom_vars={"KERNEL":"windows"}, limit=1000)`
        → `save.sh alerts.json --merge` (or `--merge --from-file <saved_to>`).
   - Notifications:
     1. `thruk_list_notifications(since=<since>, hostgroup='HG_WINDOWS', limit=500)`
        → `save.sh notifications.json`.
     2. `thruk_list_notifications(since=<since>, custom_vars={"KERNEL":"windows"}, limit=500)`
        → `save.sh notifications.json --merge`.
   - Open problems:
     1. `thruk_problems(hostgroup='HG_WINDOWS', limit=200)`
        → `save.sh problems.json`.
     2. `thruk_problems(custom_vars={"KERNEL":"windows"}, limit=200)`
        → `save.sh problems.json --merge`.

   `render.py` then sees the union and unions the host inventory
   on its side too, so any host matched by either filter ends up
   in the report.

   **Resolution cap (thruk-mcp)**: `_resolve_hosts_to_regex` caps
   the `/hosts` lookup at 1000 entries. If a hostgroup has more
   than 1000 hosts, alerts from hosts 1001+ are silently dropped
   from the pre-filter. Today no Ecritel perimeter exceeds that
   cap; surface a warning in the report and open an issue
   against thruk-mcp if the inventory grows past 1000.

5. **Render the report:**

   ```
   run_skill_script(
     skill='kdust/thruk-monitoring-report',
     command=['python3', 'scripts/render.py']
   )
   ```

   On success the script prints a one-line summary to stdout
   (counts only — safe to surface in the run output) and writes
   `/tmp/thruk-report/report.html`. Exit code 0 = OK.

6. **Send the email:**

   ```
   run_skill_script(
     skill='kdust/thruk-monitoring-report',
     command=['python3', 'scripts/send_mail.py',
             '--to', 'fsallet@ecritel.net']
   )
   ```

   Subject is built from `meta.json`: `[Monitoring <scope>]
   Rapport alertes <period> — <YYYY-MM-DD>`. Override with
   `--subject` if needed. Stdout = `OK: mail envoyé`.

## Read-only contract

This skill is strictly read-only on the monitoring side. It never
calls `thruk_acknowledge`, `thruk_schedule_*`, `thruk_recheck`,
or any write tool. Keep it that way; the `Thruk-Report` task does
not need write access.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `render.py` exits with `missing input: X.json` | An MCP step was skipped | Re-run that `save.sh` step (empty array is fine if scope unused) |
| `alerts.json` truncated at the requested `limit` | Thruk `/logs` hit the cap | Re-collect with a smaller window or set `meta.alerts_truncated=true` so the report header flags it |
| MCP response spilled to a `fil_*` reference (LLM can't `cat` it) | Expected behaviour since the upstream `THRUK_MCP_WORKDIR` spill was removed: large payloads come back as Dust `fil_*` refs | Use `export_fil_to_workdir(file_id, dest_path=/tmp/thruk-report/<name>.json)` to materialise the file inside the kdust container, then pass that path to `save.sh --from-file` |
| `save.sh: --from-file path does not exist` | The agent passed a `saved_to` from a previous run, OR the `fil_*` was not exported first | Re-run `export_fil_to_workdir` for the current run's `fil_*` ref (paths are not persistent across runs — `save.sh init` wipes `/tmp/thruk-report/` at the start of each run) |
| `send_mail.py` SMTP timeout | `mailing.ecritel.net:25` unreachable | Check egress; surface stderr in the run output, do NOT retry blindly |
| HTML differs across runs | Bug in `render.py` (must be deterministic) | Open an issue — same JSON in MUST yield same HTML out |

## Extending the perimeter (Linux, network, …)

The skill is scope-agnostic. To add a new daily report:

1. Create a new Task with a short prompt that calls this skill
   with `scope_label='Linux'`, `hostgroup='HG_LINUX'`,
   `custom_vars={"KERNEL":"linux"}` (or similar).
2. No skill code change needed.

See `references/perimeters.md` for the current Ecritel perimeter
conventions.
