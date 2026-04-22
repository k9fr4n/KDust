# Task-runner MCP server

The task-runner is an internal MCP server exposed to Dust agents that
run inside a KDust task. It lets one task ("orchestrator") invoke
other KDust tasks, enabling multi-step pipelines, parallel fan-out,
and fire-and-forget background work — all from a prompt, without any
DAG engine or YAML.

- Source: `src/lib/mcp/task-runner-server.ts`
- Registered automatically for any task with `taskRunnerEnabled=true`.
- Single server, three tools: `run_task`, `dispatch_task`,
  `wait_for_run`.

---

## Architecture

```
+------------------------------+
|  Orchestrator run (TaskRun)  |
|  taskRunnerEnabled = true    |
+--------------+---------------+
               |
               | MCP (SSE)
               v
+------------------------------+
|  task-runner MCP server      |     scope: this run only
|  (one per orchestrator run)  |     lives: until the run ends
+---+----------+----------+----+
    |          |          |
    |          |          |
  run_task  dispatch  wait_for_run
 (sync)    (detached)  (re-await)
    |          |          |
    v          v          v
+------------------------------+
|  runner.ts : runTask()       |
|  - creates TaskRun row        |
|  - acquires project lock      |
|  - spawns Dust agent stream   |
+------------------------------+
```

Every child run is a first-class `TaskRun` row linked to its parent
via `parentRunId`, with `runDepth` and `trigger='mcp'`. The full
chain is walkable in the DB and visualised as an indented tree on
`/runs?view=tree`.

---

## Tools reference

### `run_task` — synchronous dispatch

Blocks the orchestrator until the child finishes or `max_wait_ms`
expires (whichever comes first). When the budget expires, the tool
returns `{status:'pending', run_id}` so the caller can continue with
`wait_for_run`.

| Arg           | Type     | Required | Default | Description |
|---------------|----------|:-:|---------|-------------|
| `task`        | string   | ✓ | —       | Task id or exact name (case-insensitive). |
| `input`       | string   |   | (stored prompt) | Override for the child's stored prompt. |
| `project`     | string   | ✓ for generic, forbidden for bound | — | Project context for a generic (template) task. |
| `max_wait_ms` | integer  |   | 45000   | Wait budget in ms. Clamped to `[5000, 55000]` to stay under Dust's 60s MCP timeout. |

**Returns** (terminal):

```json
{
  "run_id": "...",
  "task": { "id": "...", "name": "audit-iam" },
  "status": "success | no-op | failed | aborted | skipped",
  "output": "(up to 4000 chars)",
  "error": "...",
  "files_changed": 3,
  "lines_added": 42,
  "lines_removed": 7,
  "branch": "kdust/audit-iam/20260422-1930",
  "commit_sha": "a1b2c3d...",
  "duration_ms": 12850
}
```

**Returns** (budget expired):

```json
{
  "status": "pending",
  "run_id": "...",
  "task": { "id": "...", "name": "audit-iam" },
  "waited_ms": 45000,
  "hint": "Call wait_for_run({ run_id: \"...\" }) to block up to 55s and get the final result."
}
```

---

### `dispatch_task` — fire-and-forget

Returns as soon as the child `TaskRun` row exists (<100ms typical).
The child keeps running in the background; the orchestrator may
finish before the child does.

| Arg       | Type   | Required | Description |
|-----------|--------|:-:|-------------|
| `task`    | string | ✓ | Task id or exact name. |
| `input`   | string |   | Prompt override. |
| `project` | string | ✓ for generic, forbidden for bound | Project context. |

**Returns** (normal):

```json
{
  "status": "dispatched",
  "run_id": "...",
  "task": { "id": "...", "name": "audit-iam" },
  "hint": "Call wait_for_run({ run_id: \"...\" }) later to collect its result."
}
```

**Returns** (row not created within 5s — usually concurrency lock):

```json
{
  "status": "dispatching",
  "run_id": null,
  "task": { "id": "...", "name": "audit-iam" },
  "hint": "Child run row not created within 5s ... Dispatch is still in flight — check /runs in a moment or call dispatch_task again."
}
```

---

### `wait_for_run` — re-await a pending run

Blocks up to `max_wait_ms` polling the child's `TaskRun` row. If it
reaches a terminal state, returns the same payload as a successful
`run_task`. Otherwise returns `{status:'pending', run_id}` again so
the caller can loop.

| Arg           | Type    | Required | Default | Description |
|---------------|---------|:-:|---------|-------------|
| `run_id`      | string  | ✓ | —       | Run id returned by a previous `run_task` / `dispatch_task` / `wait_for_run`. |
| `max_wait_ms` | integer |   | 45000   | Wait budget (ms). Clamped to `[5000, 55000]`. |

**ACL**: the `run_id` must be a descendant (via `parentRunId`) of
the calling orchestrator run. Cross-orchestrator peeks are refused.

Poll cadence: 1.5s. Progress notifications are emitted every 15s
for clients that honour `resetTimeoutOnProgress` (Dust currently
does not — harmless no-op).

---

## Prompt patterns

### 1. Sequential (A then B)

```markdown
1. `run_task({ task: "audit-iam" })` and read `.output`.
2. `run_task({ task: "audit-s3-public" })` and read `.output`.
3. Produce a single markdown report synthesising both.
```

### 2. Parallel fan-out (same template, N projects)

```markdown
# Detached dispatch, then collection.
a = dispatch_task({ task: "audit-iam", project: "psops" })
b = dispatch_task({ task: "audit-iam", project: "pswinops" })
c = dispatch_task({ task: "audit-iam", project: "admingui" })

ra = wait_for_run({ run_id: a.run_id })
rb = wait_for_run({ run_id: b.run_id })
rc = wait_for_run({ run_id: c.run_id })

# Produce a cross-project comparison table.
```

### 3. Fire-and-forget

```markdown
dispatch_task({ task: "nightly-backup" })
Return "✅ Backup dispatched (run_id: <run_id>)." and stop.
```

### 4. Conditional branching on result

```markdown
res = run_task({ task: "run-tests" })
if res.status == "success":
  return "✅ Tests green."
elif res.output contains "lint":
  fix = run_task({ task: "auto-fix-lint" })
  if fix.status == "success":
    retest = run_task({ task: "run-tests" })
    return f"🔧 auto-fix applied, retest: {retest.status}"
else:
  return f"❌ Tests failed (non-lint). Run: {res.run_id}"
```

### 5. Long-running task with poll loop

```markdown
mig = run_task({ task: "apply-migration", max_wait_ms: 5000 })
while mig.status == "pending":
  mig = wait_for_run({ run_id: mig.run_id, max_wait_ms: 45000 })
# mig is now terminal, proceed.
```

---

## Passing data between tasks

A very common pattern is "analyse → format", "collect → synthesise",
etc. The task-runner does not have a dedicated data channel — every
child run is a fresh Dust agent session with its own prompt. Two
knobs tie parent and child together:

- **`input` arg on `run_task` / `dispatch_task`**: replaces the
  child's stored prompt for this invocation. Use it to inject data
  or redirect the agent's intent.
- **`output` field in the returned payload**: the child's final
  assistant message, truncated to 4000 characters.

### `input` semantics — replace, not append

`input` is a full **override** of the child's stored prompt, not an
addendum. The child agent receives exactly the string you pass, as
if the user typed it. If you want a stable instruction template
plus variable data, build the full string in the parent and pass
it as `input`:

```
analysis = run_task({ task: "analyze-iam" })

formatted = run_task({
  task: "iam-report",
  input:
    "You are a report formatter. Structure: exec summary, findings " +
    "by severity, recommendations. Use THIS data:\n\n" + analysis.output
})
```

The stored prompt of `iam-report` is ignored for this call. (If
you need the stored prompt to always apply, keep instructions in
the prompt and pass only the *data* in `input` prefixed with a
clear marker like `DATA:\n\n...`. The child agent will see both
through its system-message + user-message pair once it parses
the combined text.)

### Size limits — output is truncated at 4k

The `output` field in the structured response is **capped at 4000
characters** (`formatRunResult` in `task-runner-server.ts`). If
the child's final message is larger, the excess is silently
dropped from the return payload. The full output is preserved on
the child's `TaskRun.output` column and visible on `/runs/<id>`.

For pipelines that shuttle large artefacts between tasks, don't
rely on `output` \u2014 use the filesystem.

### Pattern — large artefacts via files

The child writes to a path inside `/projects/<name>/`; the parent
passes the **path** (not the contents) to the next stage:

```
# Parent orchestrator prompt (excerpt):
1. Call run_task({
     task: "collect-aws-inventory"
   })
   The child writes /projects/psops/reports/inventory-2026-04-22.json
   and returns that path in its output.

2. Call run_task({
     task: "inventory-diff",
     input:
       "Compare the current inventory at " +
       "/projects/psops/reports/inventory-2026-04-22.json " +
       "against the previous one at " +
       "/projects/psops/reports/inventory-2026-04-15.json " +
       "and produce a markdown diff report."
   })
```

Benefits:

- No 4k-char cliff.
- The artefact survives after the run, usable for audit / re-runs /
  manual inspection.
- Re-running the formatter without re-running the collector is a
  single prompt change.

Caveat: files persist in the project tree. Either clean up in a
final task step, store them in a sub-directory your git policy
ignores, or rely on `dryRun=true` on the parent (which resets the
working tree after the run).

### Pattern — structured data in JSON blocks

For medium-sized structured outputs that *do* fit under 4k chars
(typical: ~50 findings, summary stats), have the child end its
message with a fenced `json` block so the parent can parse it
cleanly:

Child's prompt ends with:
```
Return a brief human summary, then append a final fenced code block:

```json
{ "findings": [...], "severity_counts": {...} }
```
```

Parent extracts the block from `result.output` and uses the
structured data directly — far more reliable than asking the
parent LLM to re-parse free-form prose.

### `input` is not persisted

The value of `input` is passed to the runner and ends up in the
child's agent conversation, but it is **not** stored on the child
`TaskRun` row. For debugging, inspect the child's Dust
conversation (linked from `/runs/<id>` via the chat icon) — the
effective user message is visible there.

---

## Constraints & invariants

### Project scope and project-arg contract

The orchestrator's context exposes only tasks usable in its project:

| Orchestrator is… | Can dispatch… | `project` arg is… |
|---|---|---|
| Bound to `psops` | Other tasks bound to `psops` | forbidden |
| Bound to `psops` | Generic tasks | required (names an existing project) |
| Generic (invoked with `project=psops`) | Tasks bound to `psops` | forbidden |
| Generic | Other generic tasks | required |

Violating the contract returns a structured error, never crashes.

### `MAX_DEPTH` guard

Nested orchestrators are allowed (a child with
`taskRunnerEnabled=true` can itself dispatch). The only safety net
is the depth counter, incremented at every dispatch and walked via
`parentRunId`. Configurable:

```
env KDUST_MAX_RUN_DEPTH  (default 10)
```

When the limit is reached, the dispatch is refused with a clear
error so runaway recursion (A → B → A) terminates after 10 runs.

### Per-project concurrency lock

`runTask` acquires a per-project mutex before touching the working
tree. Two writing tasks on the same `projectPath` **serialise**
even if dispatched via `dispatch_task`. Real parallelism is only
achieved when children target different projects or are dry-run /
audit tasks that don't write to the FS.

### Dust 60s MCP timeout

Dust's MCP client enforces `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`
with `resetTimeoutOnProgress: false`. That is why:

- `run_task` clamps `max_wait_ms` to 55s.
- `wait_for_run` exists: each call is a fresh MCP request, each
  bounded under 55s, so arbitrarily long waits are possible by
  looping.
- Server-side heartbeats (`notifications/progress`) are emitted
  but currently ignored by Dust. No-op, zero harm.

---

## TaskRun provenance

Every run row carries two columns that answer "who launched this?":

| Column        | Values |
|---------------|--------|
| `trigger`     | `cron`, `manual`, `mcp`, `null` (pre-2026-04-22 legacy) |
| `triggeredBy` | cron: `null` · manual: OIDC email or `'ui'` · mcp: parent task name |

On `/runs`, a coloured pill surfaces the combo at a glance
(indigo=cron, sky=manual, fuchsia=mcp).

---

## Observability

- **Tree view**: `/runs?view=tree` groups rows by root ancestor and
  indents children with ASCII connectors. Missing ancestors are
  auto-fetched so filtered lists never render orphans. The view
  choice persists in a cookie `kdust_runs_view`.
- **Lineage**: `parentRunId` + `runDepth` on every `TaskRun`.
- **Run detail page** (`/tasks/:id`): full config dump including
  `taskRunnerEnabled` / `commandRunnerEnabled` badges and secret
  bindings preview.
- **Server logs**: dispatches, nested-orchestrator notices, and
  heartbeat notifications are logged under `[mcp/task-runner]`.

---

## Troubleshooting

### `MCP error -32001: Request timed out` on `run_task`

Dust's client killed the request at 60s. Fix by switching to the
async pattern:

```
res = run_task({ task: "...", max_wait_ms: 5000 })
while res.status == "pending":
  res = wait_for_run({ run_id: res.run_id, max_wait_ms: 45000 })
```

Or use `dispatch_task` if you don't need the result inline.

### `refused: task "X" is a generic template and requires a "project" argument`

Generic tasks have no built-in project context. Pass the target
project explicitly:

```
run_task({ task: "audit-iam", project: "psops" })
```

### `refused: task "X" is bound to a specific project; the "project" argument is only allowed for generic (template) tasks`

Bound tasks carry their project in their own row. Don't override:

```
run_task({ task: "deploy-prod" })    // no project arg
```

### `refused: unknown project "X"`

`X` must exist in `/settings/projects`. Declare it there first.

### `max run depth exceeded`

The chain is about to exceed `KDUST_MAX_RUN_DEPTH`. Either shorten
the chain, bump the env var, or check for an accidental cycle (the
tree view on `/runs` makes these obvious).

### `generic task invariants violated`

See `docs/tasks.md` (to be written) for the full generic-task
contract. Short version: generic tasks must have
`schedule='manual'` and `pushEnabled=false`. `taskRunnerEnabled` is
fine since 2026-04-22.

---

## ADR — Three tools instead of one mode flag

**Status**: Accepted — 2026-04-22

**Context**: After the async-dispatch refactor, `run_task` already
had `max_wait_ms` for the timeout-vs-long-run trade-off. Adding a
`detached: boolean` flag would have covered the fire-and-forget
case without a new tool.

**Decision**: Ship a dedicated `dispatch_task` instead of a flag.

**Consequences**:

- ✅ Tool name = intent. An agent that wants fan-out reaches for
  `dispatch_task` directly; no prompt paragraph explaining
  `detached: true` semantics.
- ✅ `description` strings stay focused and short — LLMs pick the
  right tool more reliably.
- ✅ Internal validation is shared via `validateDispatch()` so the
  two tools cannot diverge on scope / contract / depth checks.
- ❌ Three tools to keep in sync on schema changes. Mitigation: a
  single `formatRunResult()` helper owns the output serialisation
  for `run_task` and `wait_for_run`.
- ❌ Slightly larger MCP `tools/list` payload. Negligible.
