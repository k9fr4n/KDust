# Automation push pipeline

When a task has `pushEnabled = true`, KDust automates the full
post-agent git flow: branching, committing, pushing, and opening a
PR/MR. The agent only has to **edit files via fs-cli** and describe
what it did — KDust handles every `git` call from the working-tree
diff.

This doc walks through the 10-stage pipeline in `runTask()`
(`src/lib/cron/runner.ts`), the branch-policy resolution, the
guard-rails, and the PR/MR auto-opener.

---

## When does it run?

| `pushEnabled` | Pipeline behaviour |
|--|--|
| `true`  | Full 10-stage pipeline (below). Prompt is augmented with a KDust-automation context footer. |
| `false` | Prompt-only mode: agent runs, its reply is stored as `TaskRun.output`, nothing is committed/pushed. Prompt is sent verbatim. |

`pushEnabled` is forced to `false` for generic tasks (no project
→ no repo). See [`docs/task.md`](tasks.md) for the generic-task
invariants.

---

## Pipeline overview

```
                        pushEnabled = true

  [1] concurrency lock
       ↓  skip if another run of this task is still `running`
  [2] git sync
       ↓  fetch + reset --hard origin/<baseBranch> + clean -fd
  [3] branch setup
       ↓  create/checkout work branch (timestamped | stable)
       ↓  refuse if branch is in protectedBranches
  [4] MCP fs register
       ↓  expose fs-cli chrooted to /projects/<projectPath>
  [5] Dust agent run
       ↓  streamAgentReply, 10min timeout
  [6] diff measurement
       ↓  git add -A + numstat → files/lines changed
  [7] guard-rails
       ↓  if lines > maxDiffLines → abort (throw)
       ↓  if diff == 0 → status='no-op', return
  [8] commit + push
       ↓  commitAll with conventional message
       ↓  pushBranch (force-with-lease if stable mode)
       ↓  skipped if dryRun=true
  [8b] auto-open PR/MR
       ↓  if project.autoOpenPR and platform configured
       ↓  best-effort: failure doesn't fail the run
  [8c] B3 auto-merge-back  ← NEW 2026-04-24
       ↓  only when dispatched via run_task (sync) with a
       ↓  postMergeTargetBranch (i.e. parent on a work branch)
       ↓  git checkout <parent-branch>
       ↓  git merge --ff-only <this-run-branch>
       ↓  git push origin <parent-branch>
       ↓  records mergeBackStatus on the TaskRun for the UI;
       ↓  FF refusals are surfaced, NEVER silently 3-way merged
  [9] persist TaskRun
       ↓  audit trail with branch, commit, PR link, diff stats
  [10] Teams notification
       ↓  success / no-op / failure card with links
```

---

## Stage details

### [1] Concurrency lock

A per-project mutex held for the entire pipeline. Two writing
tasks on the same `projectPath` serialise to avoid racing on
`git reset --hard`, branch creation, and the working tree. If
another run of the **same task** is already `running`, this run is
refused with `status='skipped'` — prevents pile-up when a cron
period is shorter than the run duration.

Child runs spawned via `run_task` from the same orchestrator run
**bypass** the lock, otherwise an orchestrator would deadlock on
its own branch.

### [2] Pre-run git sync

```
git fetch origin
git checkout <baseBranch>
git reset --hard origin/<baseBranch>
git clean -fd
```

Guarantees every run starts from a clean, up-to-date base tree.
The agent never sees stale state from a previous run.

> **`<baseBranch>` resolution (B1/B2)**. Historically `<baseBranch>`
> came from `resolveBranchPolicy(task, project)` and was usually
> `main`. Since 2026-04-24 it can be overridden per-run by the
> orchestrator dispatching this child via `run_task` / `dispatch_task`:
>
> - explicit `base_branch` argument (B1) takes precedence
> - else auto-inherit from the parent orchestrator's current
>   branch (B2) — the MCP layer also auto-pushes the parent's
>   branch to origin so the reset resolves
> - else falls through to the task/project default
>
> The provenance is persisted on `TaskRun.baseBranchSource`
> (`default | explicit | auto-inherit`) and shown as a pill on
> `/run/:id`. Full specification: [`task-runner.md § Base branch & merge-back`](task-runner.md#base-branch--merge-back-b1b2b3).

### [3] Branch setup

Two modes, selectable per task via `branchMode`:

| Mode           | Branch name | Push flags |
|----------------|-------------|------------|
| `timestamped` (default) | `<branchPrefix>/<task.name>/YYYYMMDD-HHMM`  | plain `git push` — new branch every run |
| `stable`       | `<branchPrefix>/<task.name>`               | `git push --force-with-lease` — same branch reused, PR is updated in place |

`timestamped` is the safe default: each run is an independent
branch, trivial to revert. `stable` is useful for iterative
tasks where you want a single long-lived PR that evolves.

**Override: shared chain branch (ADR-0008 commit 6, 2026-05-03).**
When `inputAppend` carries a single line `CHAIN_BRANCH: <ref>`,
the runner extracts it before phase [3] and `branch-setup`
honours it verbatim instead of composing
`<branchPrefix>/<task>/...`. Two cases:

- The branch already exists on origin → `git fetch origin <branch>`
  succeeds and `branch-setup` checks out at the remote tip
  (`checkout -B <branch> origin/<branch>`). This run's commits
  stack on top of the predecessor's work in the same chain.
- The branch does not yet exist on origin → fall back to creating
  it locally from the just-reset base (`checkoutWorkingBranch`
  semantics).

Effect: a multi-step `enqueue_followup` chain that threads
`CHAIN_BRANCH` through every successor's `input` produces
**ONE remote branch with N commits** (one per worker that wrote
to a tracked path), and **ONE PR** updated in place as the chain
progresses — auditable, reviewable, fix-loop iterations preserved
as individual commits. Used by the `terraform-provider-windows`
five-task chain (`win-spec-analyst → schema-architect →
provider-coder → test-engineer → quality-gate`).

The protected-branch check still applies regardless of override.

Before creating the branch, KDust refuses if the resolved name
matches any entry in `protectedBranches`. This is a
**belt-and-suspenders** check on top of the branch-name construction:
impossible by design in `timestamped` mode (always prefixed), but
`stable` can be misconfigured.

### [4] MCP fs register

The runner registers the `fs-cli` MCP server chrooted to
`/projects/<projectPath>` so the agent can read / write / search
within the project but nowhere else. This is the ONLY writable
filesystem surface for the agent during the run.

The `task-runner` MCP server is also registered (always since
ADR-0008, 2026-05-02) so the agent can declare its successor via
`enqueue_followup` — see [`docs/task-runner.md`](task-runner.md).

If `commandRunnerEnabled=true`, the `command-runner` MCP server is
registered with the project chroot and the task's secret bindings.

### [5] Dust agent run

`createConversation` + `streamAgentReply`, with a 10-minute
timeout. The final assistant message is stored as
`TaskRun.output`. The Dust conversation is linked from the run
page via a chat icon for post-run forensics.

The prompt sent is:

```
<Task.prompt>

---
[KDust automation context]
This run will be auto-committed (and pushed unless dry-run) by KDust after your reply.
- Base branch: <baseBranch>
- Branch mode: <branchMode>
- Branch prefix: <branchPrefix>
- Dry-run: yes|no
- Max diff lines: <maxDiffLines> (KDust aborts the push if exceeded)
Do NOT run `git add` / `git commit` / `git push` yourself — KDust handles
all git writes from the working-tree diff after your reply. Just edit files
via the fs-cli MCP server as needed and explain your changes in your reply.
```

The footer is the single most reliable way to stop agents from
running their own `git commit` via shell tools.

### [6] Diff measurement

```
git add -A
git diff --cached --numstat
```

Produces the three key metrics: `filesChanged`, `linesAdded`,
`linesRemoved`. These end up on the `TaskRun` row and in the
Teams card.

### [7] Guard-rails

| Condition              | Action                                  |
|------------------------|-----------------------------------------|
| `filesChanged == 0`    | `status='no-op'`, branch deleted locally, return. Teams card is an info banner. |
| `linesAdded + linesRemoved > maxDiffLines` | `throw` → status `'failed'`. The agent's output is preserved so you can inspect what it tried to do. |

The diff cap is the single most important **hallucination safety
net** — an agent that decides to rewrite 15 files with 3000 lines
of wrong code is refused, not pushed.

Default `maxDiffLines = 2000`. Raise per-task when needed
(refactors, generated code), never disable.

### [8] Commit + push

```
git commit -m "chore(<branchPrefix>): <task.name>

Automated by KDust cron "<task.name>".
Agent: <agentName|agentSId>
Base: origin/<baseBranch>
Files: <N> | +<linesAdded> / -<linesRemoved>"
```

Author: `KDust Bot <kdust-bot@ecritel.net>`.

Push is skipped entirely if `dryRun = true` — the commit stays
local so you can inspect it on the host's `/projects/<name>`
working tree. Status is still `success`.

### [8b] Auto-open PR/MR

Triggered when **all** of these hold:

- push actually happened (not dry-run)
- `Project.autoOpenPR = true`
- the project's platform config is valid (GitHub token or GitLab token)

Current support:

| Platform | API call | Token scope |
|----------|---------|-------------|
| GitHub   | `gh pr create` equivalent via REST | `repo` |
| GitLab   | Merge Requests API | `api` |

Failure at this stage is **non-fatal** for the run: the branch is
already pushed, `prState='failed'` is recorded, the Teams card
surfaces the error, and the user can open the MR manually.

### [9] Persist TaskRun

Final UPDATE on the `TaskRun` row:

```
status, phase='done', phaseMessage='Completed',
branch, commitSha, filesChanged, linesAdded, linesRemoved,
output (the agent reply), prUrl, prNumber, prState,
finishedAt = now()
```

Also updates `Task.lastRunAt` and `Task.lastStatus` for the list
page.

### [10] Teams notification

Adaptive card posted to `Task.teamsWebhook` (falls back to
`Project.teamsWebhook` if null). Three variants:

- **success**: green, with branch/commit/PR links, diff stats
- **no-op**: blue info banner, no links
- **failure**: red, with the error + truncated agent output

Webhook failure is swallowed (logged only) — never fails the run.

---

## Branch policy resolution

Branch-related fields have a **task overrides project** relationship.
See `src/lib/branch-policy.ts`:

| Field               | Project field          | Task field          | Resolution |
|---------------------|------------------------|---------------------|------------|
| baseBranch          | `defaultBaseBranch`    | `baseBranch`        | task ≠ null ? task : project |
| branchPrefix        | `branchPrefix`         | `branchPrefix`      | task ≠ null ? task : project |
| protectedBranches   | `protectedBranches`    | `protectedBranches` | task ≠ null ? task : project |

The `branchMode` / `dryRun` / `maxDiffLines` fields are task-only
(inherently per-task).

**Tip**: set sensible defaults on the Project once (e.g. `main`,
`kdust`, `main,master,develop`) and leave task-level overrides
NULL. Only override when a specific task needs a different rule
(e.g. a "release-notes" task targeting `release` branch).

---

## Project-level settings

Managed at `/settings/projects/<name>`:

| Field                | Purpose |
|----------------------|---------|
| `defaultBaseBranch`  | inherited by all tasks unless overridden |
| `branchPrefix`       | enforced prefix (default `kdust`) |
| `protectedBranches`  | CSV of forbidden targets |
| `autoOpenPR`         | master switch for stage [8b] |
| `platform`           | `github` / `gitlab` / `none` |
| `githubToken` / `gitlabToken` | secret (stored encrypted, rotated via UI) |
| `teamsWebhook`       | fallback for task-less webhook override |

---

## Dry-run mode (`dryRun = true`)

Stops before the network push. Useful for:

- Testing a new task's behaviour without littering the remote
- Manually reviewing commits in `/projects/<name>` before letting
  KDust push them
- CI-like sanity checks that shouldn't auto-merge

A dry-run that **succeeds** still records `status='success'`, has
a valid `commitSha`, but `prUrl=null` and no remote branch. The
working tree is cleaned up to `origin/<baseBranch>` at the NEXT
run's stage [2].

---

## Troubleshooting

### `push failed: error: failed to push some refs`

Usually a protected-branch hook on the remote rejecting the push.
Check the remote's branch-protection rules; the target branch
(the work branch, not the base) may be blocked by `required status
checks` or `allow pushes from admins only`.

### `aborting push: target branch <X> is protected`

Our own belt-and-suspenders check. `<X>` matched an entry in the
resolved `protectedBranches` list. In `stable` mode, the stable
branch name must NOT collide with protected ones — change
`branchPrefix` or the task name.

### `diff too large: exceeds maxDiffLines`

Hallucination guard tripped. Three options:

1. Bump `maxDiffLines` on the task if the change is genuinely large.
2. Refine the prompt to produce a smaller, more focused change.
3. Inspect the attempted diff in `/projects/<name>` (still in the
   working tree at that point) and decide whether it's
   salvageable manually.

### PR didn't open (`prState='failed'`)

Check:

- `Project.autoOpenPR = true`
- Platform config is set (token + platform = github/gitlab)
- Token has the right scope (`repo` / `api`)
- The Teams card's error field carries the API response body

Fix the token / config, then re-run the task; the branch is
already there, the push will no-op and the PR opener runs on the
refresh.

### Task ran but no commit appeared

Likely `status='no-op'` (no file changes) — check `/run/<id>`.
The agent ran, replied, but didn't write anything. If that's
wrong, inspect the agent's reply: it may have described changes
without actually calling fs-cli's `edit_file`.

---

## See also

- [`docs/task.md`](tasks.md) — task model reference
- [`docs/task-runner.md`](task-runner.md) — orchestration
- `src/lib/cron/runner.ts` — the implementation
- `src/lib/branch-policy.ts` — policy resolver
