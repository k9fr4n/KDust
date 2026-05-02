# Task-runner MCP server

The task-runner is an internal MCP server exposed to Dust agents that
run inside a KDust task. It lets a run **declare its successor** —
which task to execute next, with what input — enabling multi-step
pipelines without a DAG engine, YAML, or nested orchestration.

- Source: `src/lib/mcp/task-runner-server.ts`
- Registered automatically for **every** task (ADR-0008,
  2026-05-02). The legacy `taskRunnerEnabled` opt-in was retired
  along with the orchestrator/worker role distinction.
- Single server, **four tools**: `list_tasks`, `describe_task`,
  `update_task_routing`, `enqueue_followup`.
- See [README.md ADR-0008](../README.md) for the design rationale and
  the migration from the legacy hierarchical model.

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

| Arg          | Type    | Required | Description |
|--------------|---------|:-:|-------------|
| `task`       | string  | ✓ | Successor task id or exact name. |
| `input`      | string  |   | Override of the successor's stored prompt. JSON-encoded for structured payloads. |
| `project`    | string  | ✓ for generic, forbidden for bound | Project context (full path or bare leaf if unique). |
| `base_branch`| string  |   | Explicit base branch for the successor (must exist on `origin`). |

Returns:

```json
{
  "status": "enqueued",
  "run_id": "cmrXXXX",
  "task": { "id": "…", "name": "test" },
  "hint": "Successor will run independently. Watch it at /run/cmrXXXX or follow the chain forward."
}
```

Invariants enforced by the tool:

1. **At most one successor per run.** A second call returns an
   error (`refused: this run already enqueued a followup…`). If
   you have branching logic, decide on the branch BEFORE enqueuing.
2. **Project contract.** Generic tasks require `project`; bound
   tasks reject it.
3. **Branch is never auto-inherited.** Pass `base_branch` explicitly
   when the successor must branch from somewhere other than the
   project default.
4. **No max-depth cap at the runner level.** Cycles
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
| `enqueue_followup` returns `refused: this run already enqueued a followup` | Prompt called the tool twice. | Branch the decision earlier, call the tool once. |
| Successor runs but has no relation back to the source in `/run`. | The pointer-write step failed (DB error logged on server). | Check server logs; the chain still executed. |
| Successor is stuck in `running` after parent completed. | Per-project concurrency lock held by another run. | Check `/run` for any running task on the same project. |
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
