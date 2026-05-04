# Tasks

A **Task** is the atomic unit of work in KDust: a prompt + an agent +
a target project + a schedule. Running a Task produces a **TaskRun**
row with the agent's output, diff stats, and a status.

Tasks live in the `Task` table (mapped to SQLite `CronJob` for
backward compat). The management UI is at:

- `/task`          — list / filter / search
- `/task/new`      — create
- `/task/[id]`     — detail, run history, "Run now"

---

## The two flavours

| Flavour       | `projectPath`        | Can run how?                                            |
|---------------|----------------------|---------------------------------------------------------|
| **Bound**     | a project name       | cron, UI Run, or chained from a predecessor via `enqueue_followup` |
| **Generic**   | `null` ("template")  | UI Run with project picker, or `enqueue_followup({task, project})` from a predecessor |

A **bound** task carries its project context in its row. A
**generic** task is a reusable template ("audit-iam", "lint-and-
fix") that doesn't know its project until invoked. Generic tasks
are forbidden from cron (no implicit project context) and from the
push pipeline (no repo to push to).

### Visual taxonomy on `/task`

Since ADR-0008 (2026-05-02) every task can chain a successor via
`enqueue_followup`, so the orchestrator/worker role distinction is
gone. Tasks are now characterized by a **single** axis:

| Axis | Values | Visual |
|------|--------|--------|
| Scope | template (generic) / project-bound | violet `TEMPLATE` pill next to the name |

The list left-border is now a uniform sky accent. Pre-ADR-0008 the
border encoded the role (amber orchestrator / sky worker); that
channel was retired with the toggle.

### Visibility across project contexts (Franck 2026-04-29)

Generic tasks are **template tasks runnable on any project**. So
they appear in the `/task` list **regardless of the active project
cookie**: when a project is selected, the page shows the union of
that project's bound tasks and **all** generic tasks. The `kind`
filter still lets you isolate one or the other (`?kind=generic` or
`?kind=project`).

The same logic applies to `/run`: a run dispatched from a generic
task with `{ project: <p> }` is visible in `<p>`'s scoped run list.
This is implemented via a dedicated `TaskRun.projectPath` column
that captures the **effective project** of each run (mirrors
`Task.projectPath` for bound tasks, holds the runtime override for
generics). Pre-2026-04-29 rows lack the column; the `/run` filter
falls back to the task join for those legacy rows.

### Generic-task invariants (enforced in `/api/task`)

When `projectPath = null`:

- `schedule = 'manual'`             — no cron scheduling
- `pushEnabled = false`             — no git automation
- `mandatory = false`               — not auto-created with a project

Violations return a structured 400 with the exact invariant that
failed.

---

## Task fields reference

### Identity

| Field        | Type     | Notes |
|--------------|----------|-------|
| `id`         | cuid     | stable, never changes |
| `name`       | string   | human-friendly, used as search key |
| `agentSId`   | string   | Dust agent short-id (the LLM used) |
| `agentName`  | string?  | cached for UI, resolved at creation |
| `prompt`     | string   | sent to the agent at run time |
| `enabled`    | bool     | `false` disables cron + UI Run |
| `mandatory`  | bool     | auto-created with a project, cannot be deleted |

### Schedule

| Field      | Type   | Default | Notes |
|------------|--------|---------|-------|
| `schedule` | string | `manual`| `manual` — no cron; OR a 5-field cron expr (`0 2 * * *`) |
| `timezone` | string | `Europe/Paris` | IANA TZ; evaluated by the internal scheduler |

Scheduler tick frequency: 30s (see `src/lib/cron/scheduler.ts`).

### Project & notification

| Field          | Type    | Notes |
|----------------|---------|-------|
| `projectPath`  | string? | null = generic. Otherwise must match a `Project.name`. |
| `teamsWebhook` | string? | optional per-task override; falls back to project webhook |

### Automation push (see [`docs/push-pipeline.md`](push-pipeline.md))

| Field               | Type    | Default          | Notes |
|---------------------|---------|------------------|-------|
| `pushEnabled`       | bool    | `true`           | master switch for the post-agent git pipeline |
| `baseBranch`        | string? | inherit project  | git base for the work branch |
| `branchPrefix`      | string? | inherit project  | prefix enforced on work branches (`kdust/...`) |
| `protectedBranches` | string? | inherit project  | CSV, never pushed to |
| `branchMode`        | string  | `timestamped`    | `timestamped` or `stable` (force-with-lease) |
| `dryRun`            | bool    | `false`          | commit locally but skip push + PR |
| `maxDiffLines`      | int     | `2000`           | abort the commit if diff exceeds (hallucination guard) |

### Capabilities (opt-in MCP servers)

| Field                  | Type | Notes |
|------------------------|------|-------|
| `commandRunnerEnabled` | bool | exposes `run_command` (chroot + denylist + Command audit log) |
| _(task-runner MCP)_    | —    | bound to **every** task since ADR-0008 (2026-05-02). Exposes `enqueue_followup` so any task can declare its successor in a forward-only chain. See [`docs/task-runner.md`](task-runner.md). |
| `secretBindings`       | TaskSecret[] | per-task env injection for `commandRunnerEnabled` children |
| `maxRuntimeMs`         | int? | wall-clock cap in ms. Null = env default. See "Runtime cap" below |

### Routing metadata (ADR-0002, 2026-04-29)

Optional fields that surface in the task-runner MCP server
(`list_tasks` / `describe_task`) so an orchestrator agent — or the
chat assistant — can pick the right task without parsing the full
prompt. The prompt is written for the *executing* agent; the
routing layer needs a different view of the task.

| Field          | Type                                    | Notes |
|----------------|-----------------------------------------|-------|
| `description`  | string?                                 | 1-3 sentences "what is this task for", written for the routing layer. Distinct from `prompt`. |
| `tags`         | JSON array of strings (stored as text)  | Cheap keyword matching: `["lint", "ci", "audit"]`. Empty list = `null`. |
| `inputsSchema` | JSON Schema (stored as text)            | Shape expected for the `input` override on dispatch. Server rejects malformed JSON. |
| `sideEffects`  | `'readonly' \| 'writes' \| 'pushes'`    | Default `'writes'`. Drives the routing-layer confirmation gate: `readonly` may be auto-enqueued, `pushes` is the highest gate. |

The full schema is exposed only via `describe_task`; `list_tasks`
returns `has_inputs_schema: true|false` to keep its payload bounded
when an installation has dozens of tasks.

### Runtime cap (wall-clock timeout)

Every run has a hard kill-timer. When it fires, the run is aborted
with `{kind:'timeout', ms:N}`. In the decoupled-chain model
(ADR-0008) successors are independent top-level runs, so a parent
timeout has no descendant to cascade-cancel — if the parent dies
before reaching its `enqueue_followup` call, the successor is
simply never created (fail-stop).

Resolution order at dispatch (unified by ADR-0008, see
`src/lib/cron/runner/timeout.ts`):

1. `Task.maxRuntimeMs` if set and in `[30s, 6h]`
2. `AppConfig.leafRunTimeoutMs` (single tunable for every run)
3. hard default: **30 min**

The AppConfig value is editable from
**`/settings/global` → Run timeouts** (entered in minutes, stored
in ms, clamp 1-360). No restart required — the runner reads
AppConfig on every dispatch. Out-of-range values silently fall
back to the hard default at the runner level.

> Pre-ADR-0008 there was a separate `orchestratorRunTimeoutMs`
> (60 min default) for tasks with `taskRunnerEnabled=true`. Both
> the column and the role distinction are gone: long pipelines are
> now expressed as multiple chained runs, each independently capped.

UI: the task form accepts the value in **minutes** (clamped 1-360)
for ergonomics. Stored as ms in DB.

Set it when:

- A single chain step legitimately needs more than 30 min (bump
  the task's cap, not the global config).
- A task must finish in &lt; 30 min by policy (tighter
  accountability, e.g. a cheap health-check).

Don't disable the cap. It's the only protection against an agent
stuck in an infinite tool-call loop.

---

## Scheduling model

Two independent triggers:

- **Cron tick**: the internal scheduler polls every 30s, matches
  schedule expressions against `now()` in each task's timezone,
  and fires `runTask(id, { trigger:'cron' })`.
- **Manual**: the UI's "Run now" button hits
  `POST /api/task/:id/run`, which calls
  `runTask(id, { trigger:'manual', triggeredBy:<email> })`.

Both dispatch the same `runTask` function in `src/lib/cron/
runner.ts`. See that file's top-of-file docblock for the full
pipeline.

### Provenance columns on `TaskRun`

Every run row carries:

| Column        | Values |
|---------------|--------|
| `trigger`     | `cron` / `manual` / `mcp` / `null` (pre-2026-04-22 legacy) |
| `triggeredBy` | cron: `null` · manual: OIDC email or `'ui'` · mcp: parent task name |

Surfaced as a coloured pill on `/run`.

---

## The prompt

`Task.prompt` is the full system+user message sent to the Dust
agent, with one piece of post-processing:

When `pushEnabled = true`, the runner appends a
**KDust automation context** footer so the agent knows not to run
`git` itself (KDust handles the commit/push from the working-tree
diff after the agent replies). The footer lists the base branch,
the branch mode, the dry-run flag, and the diff cap.

When `pushEnabled = false`, the prompt is sent verbatim — useful
for chat-style recurring tasks that don't mutate the repo.

See `composePrompt()` in `src/lib/cron/runner.ts` for the exact
format.

### `{{PROJECT}}` substitution for generic tasks

When a generic task is invoked with a `project` argument (manual
run, `enqueue_followup`, MCP), every occurrence of `{{PROJECT}}`
(and `{{PROJECT_PATH}}`) in `Task.prompt` is replaced before the
agent runs. Lets a single template work across projects without
hand-editing.

### Input append at dispatch time

`enqueue_followup` and `POST /api/task/:id/run` accept an `input`
string that is **APPENDED** under a `# Input` section, *not*
replacing the stored prompt. Persisted on `TaskRun.inputAppend`
so `POST /api/run/:id/rerun` replays it verbatim. See
[`docs/task-runner.md`](task-runner.md#enqueue_followup-input-semantics-commit-5).

---

## Creating a task

UI: `/task/new`. API: `POST /api/task`.

### Required at minimum

- `name`
- `agentSId` (picked from the Dust agent dropdown)
- `prompt`
- Either `projectPath` OR the "Generic task" toggle

### Bound task defaults

- `pushEnabled = true` — you probably want git automation
- `schedule = 'manual'`
- `branchMode = 'timestamped'`
- `maxDiffLines = 2000`

### Generic task defaults (when "Generic" toggled)

- `pushEnabled`        → forced to `false`
- `schedule`           → forced to `'manual'`

The form helper in `src/components/TaskForm.tsx` applies these
coercions on toggle so the server-side invariants never trip.

---

## Running a task

### Cron

Nothing to do: if `enabled = true` and `schedule` is a valid cron
expression, the scheduler fires it.

### Manually (UI)

1. Go to `/task/:id` or find the row on `/task`.
2. Click **Run now**.
3. For a bound task: dispatches immediately.
   For a generic task: a popover asks you to pick a project.
4. The live status appears below (phase + message refreshed every
   2s).

### From another task (orchestration)

See [`docs/task-runner.md`](task-runner.md). Four tools on the
single `task-runner` MCP server (registered for every task since
ADR-0008): `list_tasks`, `describe_task`, `update_task_routing`,
`enqueue_followup`. The first three are read-only introspection;
`enqueue_followup` declares the run's successor as a brand-new
top-level run (decoupled chain — no parent linkage).

---

## Concurrency model

- Per-project mutex on every run: two writing tasks on the same
  `projectPath` serialise. A successor enqueued via
  `enqueue_followup` is allowed to acquire the lock while its
  predecessor is still flagged `running` (the predecessor's id is
  passed as `predecessorRunId` and excluded from the lock check).
  Without this, every chain step would deadlock on its own
  predecessor's lock.
- A new run is refused (`status='skipped'`) if another run of the
  SAME task is still `running` — avoids pile-up when a task is
  slower than its cron period.

---

## Observability

| Surface              | Shows                                   |
|----------------------|-----------------------------------------|
| `/task`             | list with last run status, next fire    |
| `/task/:id`         | full config dump, live run status, run history |
| `/run`              | global run log, filters, tree view      |
| `/run/:id`          | single run: output, diff, branch/commit, PR link |
| Teams webhook        | push/no-op/failure notification per run |

---

## Troubleshooting

### `generic task invariants violated`

Generic tasks (`projectPath=null`) must have `schedule='manual'`
and `pushEnabled=false`. Check the TaskForm toggle or edit the
post body.

### `diff too large: exceeds maxDiffLines`

The agent wrote more than `maxDiffLines` lines across the working
tree. Either bump the cap (on the task, or on the project default),
or refine the prompt to produce a smaller change. Refusing is
intentional: large auto-commits are usually hallucinations.

### `aborting push: target branch is protected`

Your branch name resolves to an entry in `protectedBranches`.
For `stable` mode, the stable name must NOT collide with protected
ones; change `branchPrefix` or the stable suffix.

### Task won't fire on cron

Check in order:

1. `enabled = true`
2. `schedule` is NOT `'manual'` and is a valid 5-field cron
3. `lastStatus` isn't stuck on `'running'` (concurrency lock)
4. Scheduler process is alive — check server logs for
   `[scheduler] tick` lines

---

## See also

- [`docs/task-runner.md`](task-runner.md) — orchestration tools
- [`docs/push-pipeline.md`](push-pipeline.md) — automation push
  internals
- [`docs/push-pipeline.md`](push-pipeline.md) — automation push
  internals
