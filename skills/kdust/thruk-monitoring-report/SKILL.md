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

`/tmp/thruk-report/` — single shared scratch directory. Wipe
before each run (the skill scripts do this on `save.sh init`).

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

4. **Collect monitoring data** on the window — **always push the
   perimeter filters (`hostgroup` + `custom_vars`) down to the MCP
   call**. This keeps the payload small enough to stay under Dust's
   inline cap and avoids spillage to a `fil_*` reference (which
   currently can't be read back by the LLM, see "Failure modes" /
   `export_fil_to_workdir` notes below):

   - `thruk_recent_events(only_alerts=true, hours=<24 or 72>, hostgroup='<HG>', custom_vars={…}, limit=1000)`
     → `save.sh alerts.json`.
     ⚠️ Do NOT use `thruk_list_alerts` — the Thruk REST `/alerts`
     endpoint returns `[]` on Thruk 3.26 in federated mode
     (see issue #91). `recent_events(only_alerts=true)` queries
     `/logs` with `type[~]=^(HOST|SERVICE) ALERT` and returns the
     same SERVICE/HOST ALERT records (`host_name`,
     `service_description`, `state`, `state_type`, `time`, …).
   - `thruk_list_notifications(since=<since>, hostgroup='<HG>', custom_vars={…}, limit=500)`
     → `save.sh notifications.json`.
   - `thruk_problems(hostgroup='<HG>', custom_vars={…}, limit=200)`
     → `save.sh problems.json`.

   Hostgroup + custom_vars combine logically (the `/hosts` lookup
   used to resolve them applies both filters at once). Pass BOTH
   when the perimeter is defined as a union — `render.py` will
   union the two host inventories on its side too, so any host
   matched by either filter ends up in the report.

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
| MCP response spilled to a `fil_*` reference (LLM can't `cat` it) | Payload > Dust inline cap because no perimeter filter was passed | **Always pre-filter** at the MCP call (`hostgroup=`, `custom_vars=`) — see step 4. The legacy bridge `fs_cli__export_fil_to_workdir` is currently broken: Dust API rejects both `?action=view` and `?action=download` on `useCase=tool_output` files. Until that's fixed upstream, an unfiltered call that spills is a hard stop |
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
