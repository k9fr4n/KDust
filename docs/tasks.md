# Tasks

A **Task** is the atomic unit of work in KDust: a prompt + an agent +
a target project + a schedule. Running a Task produces a **TaskRun**
row with the agent's output, diff stats, and a status.

Tasks live in the `Task` table (mapped to SQLite `CronJob` for
backward compat). The management UI is at:

- `/tasks`          — list / filter / search
- `/tasks/new`      — create
- `/tasks/[id]`     — detail, run history, "Run now"

---

## The two flavours

| Flavour       | `projectPath`        | Can run how?                                            |
|---------------|----------------------|---------------------------------------------------------|
| **Bound**     | a project name       | cron, UI Run, or `run_task({task})` from an orchestrator |
| **Generic**   | `null` ("template")  | UI Run with project picker, or `run_task({task, project})` |

A **bound** task carries its project context in its row. A
**generic** task is a reusable template ("audit-iam", "lint-and-
fix") that doesn't know its project until invoked. Generic tasks
are forbidden from cron (no implicit project context) and from the
push pipeline (no repo to push to).

### Visual taxonomy on `/tasks`

Task kind is **two-dimensional** and rendered with two independent
channels on the list:

| Axis | Values | Visual |
|------|--------|--------|
| Role | orchestrator (`taskRunnerEnabled=true`) / worker | left-border colour (amber / sky) |
| Scope | template (generic) / project-bound | violet `TEMPLATE` pill next to the name |

Any of the four combinations is valid: a template orchestrator is
shown with an amber border **and** a violet pill, a project worker
has a sky border and no pill. The legend above the list documents
both axes.

### Generic-task invariants (enforced in `/api/tasks`)

When `projectPath = null`:

- `schedule = 'manual'`             — no cron scheduling
- `pushEnabled = false`             — no git automation
- `mandatory = false`               — not auto-created with a project
- `taskRunnerEnabled`               — allowed (reusable orchestrator)

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
| `taskRunnerEnabled`    | bool | exposes `run_task` / `dispatch_task` / `wait_for_run` — see [`docs/task-runner.md`](task-runner.md) |
| `commandRunnerEnabled` | bool | exposes `run_command` (chroot + denylist + Command audit log) |
| `secretBindings`       | TaskSecret[] | per-task env injection for `commandRunnerEnabled` children |
| `maxRuntimeMs`         | int? | wall-clock cap in ms. Null = env default. See "Runtime cap" below |

### Runtime cap (wall-clock timeout)

Every run has a hard kill-timer. When it fires, the run is aborted
with `{kind:'timeout', ms:N}` and any descendants are cascade-
cancelled (see [`docs/task-runner.md`](task-runner.md#cascade-cancellation-parent-dies-children-die)).

Resolution order at dispatch:

1. `Task.maxRuntimeMs` if set and in `[30s, 6h]`
2. `AppConfig.orchestratorRunTimeoutMs` if `taskRunnerEnabled=true`
3. `AppConfig.leafRunTimeoutMs` for leaf tasks
4. hard default: **30 min** leaf, **60 min** orchestrator

The two AppConfig values are editable from
**`/settings/global` → Run timeouts** (entered in minutes, stored
in ms, clamp 1-360). No restart required — the runner reads
AppConfig on every dispatch. Out-of-range values silently fall
back to the hard default at the runner level.

UI: the task form accepts the value in **minutes** (clamped 1-360)
for ergonomics. Stored as ms in DB.

Set it when:

- An orchestrator fans out to many children whose aggregate time
  exceeds 60 min (bump the task's cap, not the global env var).
- A leaf task must finish in &lt; 30 min by policy (tighter
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
  `POST /api/tasks/:id/run`, which calls
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

Surfaced as a coloured pill on `/runs`.

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

When a generic task is invoked via `run_task({task, project:"X"})`,
every occurrence of `{{PROJECT}}` in `Task.prompt` is replaced by
`X` before the agent runs. Lets a single template work across
projects without hand-editing.

### Prompt overrides at dispatch time

Both `run_task` and `dispatch_task` accept an `input` argument that
REPLACES (not appends) the stored prompt for that call only. See
[`docs/task-runner.md` — Passing data between tasks](task-runner.md#passing-data-between-tasks).

---

## Creating a task

UI: `/tasks/new`. API: `POST /api/tasks`.

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
- `taskRunnerEnabled`  → preserved (you can have a generic
  orchestrator, e.g. "multi-project audit template")

The form helper in `src/components/TaskForm.tsx` applies these
coercions on toggle so the server-side invariants never trip.

---

## Running a task

### Cron

Nothing to do: if `enabled = true` and `schedule` is a valid cron
expression, the scheduler fires it.

### Manually (UI)

1. Go to `/tasks/:id` or find the row on `/tasks`.
2. Click **Run now**.
3. For a bound task: dispatches immediately.
   For a generic task: a popover asks you to pick a project.
4. The live status appears below (phase + message refreshed every
   2s).

### From another task (orchestration)

See [`docs/task-runner.md`](task-runner.md). Three tools:
`run_task`, `dispatch_task`, `wait_for_run`.

---

## Concurrency model

- Per-project mutex on every run: two writing tasks on the same
  `projectPath` serialise. Child dispatches spawned via
  `run_task` from the same orchestrator run BYPASS this lock (to
  let orchestrators chain without deadlocking on their own
  branch).
- A new run is refused (`status='skipped'`) if another run of the
  SAME task is still `running` — avoids pile-up when a task is
  slower than its cron period.

---

## Observability

| Surface              | Shows                                   |
|----------------------|-----------------------------------------|
| `/tasks`             | list with last run status, next fire    |
| `/tasks/:id`         | full config dump, live run status, run history |
| `/runs`              | global run log, filters, tree view      |
| `/runs/:id`          | single run: output, diff, branch/commit, PR link |
| Teams webhook        | push/no-op/failure notification per run |

---

## Troubleshooting

### `generic task invariants violated`

Generic tasks (`projectPath=null`) must have `schedule='manual'`
and `pushEnabled=false`. Check the TaskForm toggle or edit the
post body. `taskRunnerEnabled` is allowed since 2026-04-22.

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
