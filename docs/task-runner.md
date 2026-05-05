# Task-runner MCP server

The task-runner is an internal MCP server exposed to Dust agents that
run inside a KDust task. It lets a run **declare its successor** —
which task to execute next, with what input — enabling multi-step
pipelines without a DAG engine, YAML, or nested orchestration.

- Source: `src/lib/mcp/task-runner-server.ts` (tools split under
  `src/lib/mcp/task-runner/tools/`).
- Registered automatically for **every** task (ADR-0008,
  2026-05-02). The legacy `taskRunnerEnabled` opt-in was retired
  along with the orchestrator/worker role distinction.
- Single server, **four tools**: `list_tasks`, `describe_task`,
  `update_task_routing`, `enqueue_followup`.
- See [README.md ADR-0008](../README.md) for the design rationale and
  the migration from the legacy hierarchical model.

### `enqueue_followup` input semantics (commit 5)

The `input` parameter is **APPENDED** to the successor's stored
prompt under a clearly-separated `# Input` section — it does NOT
replace the stored prompt. This preserves the worker's own logic
and lets predecessors forward only the parametric KEY/VALUE
bindings (WORK_DIR, ATTEMPT, FEEDBACK_FILE, …).

The `/api/task/<id>/run` POST endpoint accepts the same `input`
field with the same semantics, surfaced on the `/run` page as an
"Input variables" textarea (Shift-click the Play icon for
project-bound tasks; always shown for generic tasks).

The resolved `input` is **persisted on the TaskRun row**
(`TaskRun.inputAppend`, added 2026-05-04) so
`POST /api/run/:id/rerun` can replay it verbatim. Without this
persistence, a rerun would lose every KEY/VALUE binding the
original run received and silently degrade to the bare stored
prompt. Legacy rows predating the column read as `null` and behave
like a no-input rerun, matching pre-2026-05-04 behaviour.

---

## Mental model: decoupled chain

```
  Run A          Run B          Run C
  -----          -----          -----
  do work        do work        do work
  …              …              …
  enqueue B  ──▶  enqueue C  ──▶  (terminal)
  exit           exit           exit
```

Each run is a **fresh top-level execution**:

- No `parentRunId`, no `runDepth`, no inherited branch.
- The only inter-run linkage is a forward pointer
  `TaskRun.followupRunId` set by `enqueue_followup`.
- If a run fails or is aborted before reaching its
  `enqueue_followup` call, the successor is **never created**. This
  is the new cascade-stop semantics — simple by construction.
- Each run can be replayed in isolation: its `input` is a complete
  payload, its branch is explicit, no parent state to reconstruct.

## Authoring a chain

A chain is a set of regular Tasks. Each Task's prompt does its work
and, as the **last step**, calls `enqueue_followup` to declare the
next task. The first Task is launched normally (cron, manual run,
or MCP).

Minimal pattern (lint → test → push):

```
Task: lint
  - run lint via command-runner
  - if lint OK → enqueue_followup({ task: "test", base_branch: "<branch>" })
  - if lint KO → fail (no enqueue → chain stops)

Task: test
  - run test suite
  - if green → enqueue_followup({ task: "push", base_branch: "<branch>" })
  - if red  → fail (no enqueue → chain stops)

Task: push
  - resolve branch, push to origin, open PR, notify Teams
  - terminal: no enqueue_followup call
```

Notice:
- The branch travels through `base_branch` on every link. There is
  no auto-inherit — the prompt is responsible for threading state.
- Errors are fail-stop. The agent does not need to handle a child
  failure: if its own checks fail, it simply exits without enqueuing.
- Decisions are made BEFORE enqueue. There is no synchronous result
  channel; pipelines communicate via inputs only.

## Tools reference

### `list_tasks` — discover enqueueable tasks

Use this when your prompt doesn't hard-code successor names, or when
the agent needs to introspect the catalogue. Returns enabled tasks
only.

| Arg       | Type                                | Required | Default | Description |
|-----------|-------------------------------------|:-:|---------|-------------|
| `scope`   | `'all' \| 'bound' \| 'generic'`     |   | `all`   | Filter by task scope. |
| `project` | string                              |   | —       | Project name. With `scope=all`, returns bound tasks for this project **+** all generics. |

Output shape:

```json
{
  "tasks": [
    {
      "id": "cmoxxxx",
      "name": "audit-iam",
      "scope": "generic",
      "project_path": null,
      "agent_name": "Coder",
      "push_enabled": false,
      "prompt_preview": "Audit IAM policies in {{PROJECT}}…",
      "description": "Read-only IAM posture audit. Outputs a markdown report.",
      "tags": ["audit", "iam", "readonly"],
      "side_effects": "readonly",
      "has_inputs_schema": false
    }
  ]
}
```

> The calling task appears in its own list. Self-enqueue is allowed
> by design (e.g. iterative refinement chains). There is no runner-
> level cycle guard — prompts must not loop forever.

Routing metadata (ADR-0002): `description`, `tags`, `side_effects`,
`has_inputs_schema` let an agent pick the right successor without
parsing the prompt itself. Set them via `update_task_routing` or the
`/task/[id]/edit` UI.

### `describe_task` — full detail of a single task

Returns the full prompt, the parsed JSON Schema for `input`, and
the complete routing metadata. Use when the inline `list_tasks`
summary isn't enough.

| Arg    | Type   | Required | Description |
|--------|--------|:--------:|-------------|
| `task` | string |    ✓     | Task id or exact (case-insensitive) name. |

Output:

```json
{
  "id": "cmoxxxx",
  "name": "audit-iam",
  "scope": "generic",
  "project_path": null,
  "agent_name": "Coder",
  "enabled": true,
  "schedule": "manual",
  "timezone": "Europe/Paris",
  "command_runner_enabled": true,
  "push_enabled": false,
  "dry_run": false,
  "max_runtime_ms": null,
  "prompt": "(full prompt as stored)",
  "description": "Read-only IAM posture audit…",
  "tags": ["audit", "iam", "readonly"],
  "inputs_schema": { "type": "object", "properties": { "scope": { "type": "string" } } },
  "side_effects": "readonly"
}
```

### `update_task_routing` — maintenance metadata

Allows the chat assistant (or an orchestrator-style task) to refine
the routing fields on an existing task without going through the UI.

| Arg            | Type     | Required | Description |
|----------------|----------|:-:|-------------|
| `task`         | string   | ✓ | Task id or exact name. |
| `description`  | string   |   | New description (null clears). |
| `tags`         | string[] |   | New tags array (null/[] clears). |
| `inputs_schema`| object   |   | New JSON Schema (null clears). |
| `side_effects` | enum     |   | `readonly | writes | pushes`. |

### `enqueue_followup` — declare the successor

Called at the END of a successful run to chain to the next task.
The successor runs as a brand-new top-level run.

**Dispatch timing (ADR-0009, 2026-05-05).** This tool does **not**
start the successor immediately. It validates the parameters and
records them on the parent's `TaskRun` row
(`pendingFollowup{TaskId,Input,Project,BaseBranch}`); the runner
dispatches the successor as the LAST step of the parent's success
path, **after `commit-and-push` and the success notification**. This
guarantees the parent's branch (in particular the shared
`CHAIN_BRANCH`) has reached `origin` before the successor's
pre-sync runs `git fetch`. Cascade-stop is preserved: if the parent
fails before that step, `pendingFollowup*` is silently abandoned
and the successor is never started.

| Arg          | Type    | Required | Description |
|--------------|---------|:-:|-------------|
| `task`       | string  | ✓ | Successor task id or exact name. |
| `input`      | string  |   | Variable bindings **APPENDED** to the successor's stored prompt under a `# Input` section (does NOT replace the prompt). Idiomatic format: newline-separated `KEY: VALUE` lines. Persisted on `TaskRun.inputAppend` for replay on rerun. |
| `project`    | string  | ✓ for generic, forbidden for bound | Project context (full path or bare leaf if unique). |
| `base_branch`| string  |   | Explicit base branch for the successor (must exist on `origin` **at dispatch time**, i.e. after the parent's push). No auto-inherit in the decoupled chain model — pass explicitly when needed. |

Returns:

```json
{
  "status": "scheduled",
  "task": { "id": "…", "name": "test" },
  "hint": "Successor recorded on the current run. It will start as a fresh top-level run after this run's commit-and-push and success notification have completed. Follow the chain forward from the current run in /run once it's dispatched."
}
```

The successor's `run_id` is **not** known at the moment of the
tool call (the run row doesn't exist yet). Consumers that need the
forward link should walk `TaskRun.followupRunId` from the parent
run's `/run/[id]` page once the parent is `success`.

Invariants enforced by the tool:

1. **Tool requires a parent run row.** Calls outside a TaskRun
   (chat mode, no `orchestratorRunId`) are refused — there is no
   anchor row to record onto. Use `run_task` / the `/run` UI
   instead.
2. **At most one successor per run.** A second call returns an
   error. Both `pendingFollowupTaskId` (pre-dispatch) and
   `followupRunId` (post-dispatch) count as "already enqueued".
   If you have branching logic, decide on the branch BEFORE
   enqueuing.
3. **Project contract.** Generic tasks require `project`; bound
   tasks reject it.
4. **Branch is never auto-inherited.** Pass `base_branch` explicitly
   when the successor must branch from somewhere other than the
   project default.
5. **No max-depth cap at the runner level.** Cycles
   (`A → B → A → …`) are the prompt's responsibility.

## UI

`/run` lists all runs flat. Click a run to see `/run/[id]`, where
the **Run lineage** section surfaces:

- `◀ Previous run in chain` — the run whose `followupRunId` points
  to the current run (reverse walk on the index).
- `▶ Successor enqueued` — the run referenced by the current run's
  `followupRunId`.
- (Legacy) `Parent run` / `Child runs` — hierarchical lineage from
  the pre-ADR-0008 model. Only populated for historical rows.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `enqueue_followup` returns `refused: this run already enqueued a followup` (or `recorded a pending followup`). | Prompt called the tool twice. | Branch the decision earlier, call the tool once. |
| Successor runs but has no relation back to the source in `/run`. | The pointer-write step failed (DB error logged on server). | Check server logs; the chain still executed. |
| Parent succeeded but successor never started (no `▶ Successor enqueued` link). | Deferred dispatch failed (logs `[cron] post-success followup dispatch failed`). | Check `pendingFollowupTaskId` on the parent run; rerun the successor manually with the same `base_branch` and `input`. |
| Successor failed pre-sync with `couldn't find remote ref <chain_branch>`. | Pre-ADR-0009 race (parent hadn't pushed yet). | Should no longer happen. If it does: confirm the parent's `commit-and-push` actually ran (look for `chore(kdust): <task>` commit on `origin/<chain>`). |
| Successor branches from `main` instead of the parent's branch. | `base_branch` not passed in `enqueue_followup`. | Thread the branch explicitly. |
| Want to broadcast to N successors. | Not supported in v1 (one followup per run). | Have the agent enqueue a fan-out task that itself enqueues N siblings sequentially. |

## Migration from the legacy model

The old hierarchical tools (`run_task`, `dispatch_task`,
`wait_for_run`, `B2`/`B3`) were removed by ADR-0008. Existing tasks
with prompts referencing those tools will fail with
`tool not found`. Rewrite the prompt to follow the chain pattern:

```
# Before (legacy, removed)
run_task({ task: "test", base_branch: "$BR" })
if (result.status === "success") run_task({ task: "push", base_branch: "$BR" })

# After (decoupled chain)
# do all work first, then at the end:
enqueue_followup({ task: "test", base_branch: "$BR" })
# the test task is responsible for enqueuing "push" itself if green.
```

The legacy `parentRunId` / `runDepth` columns remain on `TaskRun`
for historical row visibility. They are not populated for new runs.
