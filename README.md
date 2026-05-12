# KDust

Web UI perso

## Documentation

- [`docs/tasks.md`](docs/tasks.md) — Task model reference: fields,
  flavours (bound vs generic), scheduling, creation, invariants.
- [`docs/push-pipeline.md`](docs/push-pipeline.md) — automation push:
  10-stage pipeline, branch policy, guard-rails, PR/MR auto-opener,
  dry-run.
- [`docs/task-runner.md`](docs/task-runner.md) — task-runner MCP server
  (`enqueue_followup` and the decoupled chain model, ADR-0008): prompt
  patterns, passing data between tasks, invariants, troubleshooting.
- [`docs/git-cli-auth.md`](docs/git-cli-auth.md) — boot-time `gh` /
  `glab` authentication via the Secret Manager (ADR-0015).

## Features

- Authentification WorkOS Device Flow (même mécanisme que le CLI, aucune config redirect URI).
- Chat persistant multi-conversations avec sélection d'agent, upload de fichiers.
- Crons : expression cron + agent + prompt + dossier projet monté + webhook Teams.
- Pipeline push automatisé : branche dédiée par run, commit/push, ouverture PR/MR, Teams report.
- Orchestration multi-tâches via MCP `enqueue_followup` : modèle de chaîne découplée (ADR-0008), une tâche déclare son successeur en fin de prompt, qui s'exécute comme un run top-level indépendant.
- Back-office (`/settings`) pour configurer URL Dust, WorkOS, webhook Teams par défaut.
- **Bridge Telegram** (`/settings/telegram`) : chat interactif avec un agent Dust depuis l'app Telegram, en long-polling sortant — KDust n'est jamais exposé sur Internet.
- Mono-utilisateur, gate par mot de passe applicatif optionnel (`APP_PASSWORD`).

## Démarrage rapide

```bash
cp .env.example .env
# Éditer APP_ENCRYPTION_KEY (32 octets base64) et APP_PASSWORD
docker compose up --build
```

Ouvrir http://localhost:3000, se connecter (mot de passe applicatif), puis
`/dust/connect` pour lier le compte Dust via WorkOS Device Flow.

## Tests

```bash
npm test            # one-shot
npm run test:watch  # watch mode
```

Vitest (v2), colocated specs under `src/**/__tests__/*.spec.ts`. See
[`docs/testing.md`](docs/testing.md) for conventions, scope, and
limitations.

## Local build

```bash
npm run build
```

The script strips two env vars before invoking `next build` —
`__NEXT_PRIVATE_STANDALONE_CONFIG` and `__NEXT_PRIVATE_ORIGIN`.
These are injected by Next at runtime when KDust runs in
`output: 'standalone'` mode (i.e. inside the production container).
If a re-build is launched from inside that same shell session
(common when running `npm run build` from the KDust agent itself),
the standalone JSON config short-circuits `assignDefaults` in
`node_modules/next/dist/server/config.js`, drops `generateBuildId`
(JSON cannot carry the default `()=>null` function), and the build
crashes with `[TypeError: generate is not a function]`.

The `env -u` prefix in `package.json:scripts.build` makes the build
idempotent regardless of who launches it (host shell, CI runner,
in-container agent).

## Volumes

| Volume | Rôle |
|---|---|
| `./data` | Base SQLite + tokens chiffrés |
| `./projects` | Projets que les agents peuvent lire/modifier via les crons |

## Sécurité

- Les tokens OAuth sont chiffrés AES-256-GCM avec `APP_ENCRYPTION_KEY`.
- Aucune clé n'est committée. Rotation : changer `APP_ENCRYPTION_KEY` **invalide la session Dust** (relogin nécessaire).
- Le port 3000 ne doit **jamais** être exposé sur Internet sans reverse-proxy TLS + auth.

## ADRs

### ADR-0002 — Task routing metadata (2026-04-29)

**Status**: Accepted
**Date**: 2026-04-29
**Context**: An orchestrator agent (or the chat assistant) deciding
which child task to dispatch via the task-runner MCP server only had
access to a 200-char `prompt_preview`. The full prompt is written for
the *executing* agent (instructions, constraints, tool patterns) — not
for the *picker*. Names alone aren't enough either: two tasks called
`audit` can have very different scopes. Result: orchestrators had to
hard-code child task names in their prompt, which defeats the purpose
of `list_tasks`.

**Decision**: Add four additive columns to `Task`:

- `description` (`String?`) — 1-3 sentences for the routing layer.
- `tags` (`String?` JSON-encoded array) — keyword matching.
- `inputsSchema` (`String?` serialised JSON Schema) — contract for the
  `input` override at dispatch.
- `sideEffects` (`String` default `"writes"`, enum
  `'readonly'|'writes'|'pushes'`) — confirmation gate driver.

Surfaced in the MCP server through:

- `list_tasks` — adds `description`, `tags`, `side_effects`,
  `has_inputs_schema` to each summary.
- `describe_task(task)` (new tool) — returns the FULL task detail
  (full prompt, parsed JSON Schema, all flags) for one task.

Storage convention follows `Message.toolNames`: JSON-encoded
strings rather than relational tables, kept SQLite-friendly.

**Consequences**:

- Existing rows are unaffected (additive migration, conservative
  defaults). No backfill required.
- Generic tasks that already use `{{PROJECT}}` substitution gain a
  natural place to declare their input contract via `inputsSchema`.
- The `sideEffects` field is a hint, not an enforcement: it's the
  orchestrator's responsibility to honour the confirmation gate. The
  push pipeline still gates the actual `git push` independently.
- Migration history has a pre-existing shadow-DB error
  (`20260422170000`); the new migration was written manually and
  applied via `prisma db push`. The migration SQL is preserved under
  `prisma/migrations/20260429120700_task_routing_metadata/` for
  parity with history.
    rafales d'environ 1 update/seconde.
  - Une seule instance KDust à la fois peut long-poll un même
    bot (Telegram renvoie 409 sur deux `getUpdates` parallèles).
    Acceptable : KDust est mono-instance par design.

### ADR-0003 — Push pipeline as a phase pipeline (2026-04-29)

**Status**: Accepted
**Date**: 2026-04-29
**Context**: `runTask` in `src/lib/cron/runner.ts` had grown to a
single 1300-line function chaining the 10 push-pipeline stages
(project resolve → concurrency lock → branch policy → sync → branch
checkout → MCP setup → Dust conversation → agent stream → diff/cap
→ commit → push → PR/MR → merge-back → notify → cleanup). The
function held 50+ shared local variables (`branch`, `commitSha`,
`agentText`, `partial`, `pushedToOrigin`, `prUrl`, `mergeBackStatus`,
…) mutated across the entire body, with one outer `try`/`catch`/
`finally` envelope handling abort, timeout, and cleanup. ADR-0002's
"level A" refactor (commit `0f4ad08`) extracted the stateless helpers
(`AbortReason`, registry, `notify`, prompt builders, timeout resolver,
ancestors, constants) but the function body itself was untouched.

**Decision**: Decompose `runTask` into a **phase pipeline** driven by
a typed `RunContext`:

```ts
interface RunContext {
  // Immutable inputs (set once at init time)
  run: TaskRun; job: Task; project: Project;
  policy: ResolvedBranchPolicy; effectiveProjectPath: string;
  notify: NotifyFn; signal: AbortSignal; opts: RunTaskOptions;
  // Mutable state mutated by phases (always optional → undefined
  // means "not yet computed" rather than "computation failed")
  branch?: string; commitSha?: string;
  agentText?: string; diff?: DiffStat;
  prUrl?: string; mergeBackStatus?: MergeBackStatus;
}
```

Each phase is an `async function phaseX(ctx: RunContext): Promise<void>`
that mutates `ctx`. The outer `try`/`catch`/`finally` (abort, timeout,
cleanup, registry teardown, lock release) stays in `runTask` itself —
only the *body* is split.

Phase modules live under `src/lib/cron/runner/phases/`:

- `init.ts`        — project resolve + branch-policy resolve + sync
- `branch.ts`      — branch checkout (working branch or merge-back target)
- `mcp.ts`         — fs + task-runner MCP server bind
- `agent.ts`       — Dust conversation create + stream + capture
- `gitWrite.ts`    — diff/cap/commit/push as ONE phase (too coupled to split)
- `pr.ts`          — PR/MR open
- `mergeBack.ts`   — B3 fast-forward into parent branch
- `finalize.ts`    — terminal-status notify + DB write

Phase invariants are enforced via narrow type assertions (e.g.
`gitWrite.ts` requires `ctx.branch` to be set, asserted at entry).

**Consequences**:

- `runTask` body shrinks from ~1300 L to ~150 L (orchestration only).
- Each phase becomes independently readable and unit-testable.
- DB phase strings (`'syncing'`, `'branching'`, …) are **unchanged**;
  no migration, `/run` UI continues to work, historical rows still
  format correctly.
- Public exports (`runTask`, `RunTaskOptions`, `cancelTaskRun`,
  `cancelRunCascade`, `isRunActive`, `isTaskRunActive`, `AbortReason`)
  are preserved verbatim; consumers don't see the split.
- The `notify` fan-out helper from ADR-0002 (level A) is reused in
  `finalize.ts`; no duplication.
- B2 auto-inherit / B3 merge-back logic stays in `init.ts` (B2) and
  `mergeBack.ts` (B3) respectively, both reading the same `ctx`.
- This refactor is **mechanical** (no behaviour change). Validation
  still requires an end-to-end push run on a test project — `tsc`
  catches signature drift but not subtle semantic regressions in
  the git pipeline.

### ADR-0004 — Task-runner MCP tools as one-file-per-tool modules (2026-04-29)

**Status**: Accepted
**Date**: 2026-04-29
**Context**: `startTaskRunnerServer` in
`src/lib/mcp/task-runner-server.ts` registered 6 MCP tools
(`list_tasks`, `describe_task`, `update_task_routing`, `run_task`,
`wait_for_run`, `dispatch_task`) inline as 6 closures inside a single
factory function. Each closure was 100–320 lines; the file totalled
1737 L before ADR-0002's level A and 1485 L after. Editing or
reviewing one tool meant scrolling through hundreds of lines of
unrelated tools. The 3 inner helpers (`formatRunResult`,
`validateDispatch`, `getParentTaskName`) were captured by closure
over `orchestratorRunId` and `projectName`, which obscured the
data-flow.

**Decision**: One file per tool, with an explicit `OrchestratorContext`
passed in.

```ts
// src/lib/mcp/task-runner/context.ts
export interface OrchestratorContext {
  orchestratorRunId: string | null; // null in chat mode
  projectName: string;
}

// src/lib/mcp/task-runner/tools/<name>.ts
export function register<Name>Tool(
  server: McpServer,
  ctx: OrchestratorContext,
): void { server.registerTool(...); }
```

Layout:

```
src/lib/mcp/task-runner/
  constants.ts          ← MAX_DEPTH (already extracted in level A)
  resolve-task.ts       ← resolveTaskForProject (already extracted)
  b2b3.ts               ← resolveB2B3 (already extracted)
  context.ts            ← OrchestratorContext type (NEW)
  helpers.ts            ← formatRunResult + getParentTaskName (NEW)
  dispatch-helpers.ts   ← validateDispatch (NEW; shared by run/dispatch)
  tools/
    list-tasks.ts
    describe-task.ts
    update-task-routing.ts
    run-task.ts
    wait-for-run.ts
    dispatch-task.ts
```

`startTaskRunnerServer` becomes a ~80-line assembly: build context,
create `McpServer`, call `registerXxxTool(server, ctx)` 6 times,
attach the transport.

**Consequences**:

- `task-runner-server.ts` shrinks from 1485 L to ~80 L.
- Adding a 7th tool = create one file + one `register` call. No risk
  of accidentally breaking another tool's closure.
- `resolveB2B3` re-export from `task-runner-server.ts` (kept for
  level-A backward compat) becomes a re-export of the same module.
- The MCP wire schema is unchanged: tool names, inputSchemas,
  outputs are byte-identical to the pre-refactor versions.
- `validateDispatch`'s shared semantics between `run_task` and
  `dispatch_task` is now expressed by both tools importing the same
  helper, instead of relying on a captured closure — easier to
  audit when the contract evolves.

### ADR-0005 — Project addressing: 4 names, 1 canonical key (2026-04-29)

**Status**: Accepted

**Context**: An audit on 2026-04-29 found 429 occurrences of four
seemingly-overlapping names referring to "a project" across
`src/`:

| Name | Occurrences | Where |
|------|------------:|-------|
| `projectPath` | 156 | DB column (`Task.projectPath`, `TaskRun.projectPath`), API payloads, form props |
| `projectName` | 236 | DB column (`Conversation.projectName`, `TelegramBinding.projectName`), function args (MCP / git / telegram), display strings |
| `projectFsPath` | 19 | runner.ts local var |
| `effectiveProjectPath` | 18 | runner.ts local var |

The overlap is real but each name actually refers to a distinct
concept that we kept conflating. Three concrete pain points:

1. `projectName` as a function argument in `mcp/registry.ts`,
   `git.ts`, `telegram/bridge.ts` is a misnomer — the value passed
   is always a `fsPath` (e.g. `clients/acme/myapp`), not a leaf
   name. New contributors reasonably read it as "the project's
   short label" and break things.
2. `Conversation.projectName` (DB column) and `Task.projectPath`
   (DB column) hold the same kind of value — both are
   `Project.fsPath` references — but use different column names.
3. `effectiveProjectPath` and `projectFsPath` look interchangeable
   but solve different problems and the runner.ts code mixes them.

**Decision**:

We codify a 3-level vocabulary and forbid future drift. **No DB
renames** are scheduled (too risky for a naming-only win on a
production app without an integration suite); the convention
applies to runtime code and new schema columns.

#### Canonical addressing key

`Project.fsPath` (`String?` unique, schema line 208) is **the** key
identifying a project across the system. It is the full path under
`/projects`, e.g. `clients/acme/myapp`. Null only on legacy rows
that predate the Phase 1 folder migration; the migration backfills
it for every CRUD.

#### Foreign-key columns

Two Prisma columns hold a `Project.fsPath` value but keep their
legacy names for back-compat:

- `Task.projectPath`        → value is `Project.fsPath` (or NULL = generic).
- `TaskRun.projectPath`     → value is `Project.fsPath` (snapshot).
- `Conversation.projectName` → value is `Project.fsPath`.
- `TelegramBinding.projectName` → value is `Project.fsPath`.

The inconsistency between `projectPath` and `projectName` is
**accepted as historical debt**. New columns referencing a project
MUST be named `projectFsPath` (matching the runtime variable) and
store the same kind of value.

#### Runtime variable conventions

Three distinct local-variable names — each tied to a specific
lifecycle moment:

| Variable | Type | Meaning | Allowed callers |
|----------|------|---------|-----------------|
| `projectFsPath` | `string` | Resolved canonical path: `project.fsPath ?? project.name`. Always non-null. Always usable for `cd /projects/${projectFsPath}`, git operations, MCP server chroots. | filesystem ops, git, MCP servers, prompts after substitution |
| `effectiveProjectPath` | `string \| null` | The `Task.projectPath` *after* applying optional dispatcher override (generic-task case). Used to look up the Project row, build the prompt, populate `TaskRun.projectPath`. | `runner.ts` — pre-resolution stage only |
| `projectName` (legacy arg) | `string` | DEPRECATED as a parameter name — use `projectFsPath` in new code. Existing call sites (~80 in `mcp/registry.ts`, `telegram/bridge.ts`, `git.ts`, `fs-server.ts`) stay until a follow-up refactor with proper integration tests. | nowhere new |

The pre/post distinction matters: `effectiveProjectPath` may be
`null` mid-resolution (generic task without override = caller
error); `projectFsPath` is established only after we successfully
looked up the Project row, and is by construction non-null.

#### Phased rollout

- **Phase 0 (this ADR)**: documentation + convention. No code
  changes. Existing parameter names left in place.
- **Phase 1 (next refactor session, gated on integration tests)**:
  rename function parameters from `projectName` to `projectFsPath`
  in MCP / git / telegram modules. Tightly mechanical (sed across
  ~80 sites) but needs a test that boots the MCP fs server, opens a
  Telegram conversation, and runs a git op end-to-end first.
- **Phase 2 (deferred indefinitely)**: rename DB columns
  `Task.projectPath` → `projectFsPath` and
  `Conversation.projectName` → `projectFsPath`. Requires a Prisma
  migration with a backfill view for any external reader of the
  SQLite file. Likely never worth the cost.

**Consequences**:

- New code MUST use `projectFsPath` for runtime variables and
  function parameters. PR reviewers reject `projectName` as an
  argument name in new modules.
- `effectiveProjectPath` stays a `runner.ts` -only term (the
  override-resolution moment doesn't exist anywhere else).
- The 156 + 236 = 392 occurrences of legacy column names
  (`projectPath` / `projectName`) keep referring to **the same
  underlying value**: a `Project.fsPath` (or NULL for generic
  tasks). Mental model is unified even though the spelling isn't.
- Documentation impact: `docs/tasks.md`, `docs/push-pipeline.md`
  and `docs/task-runner.md` should add a one-line pointer to this
  ADR the next time they are touched.

### ADR-0006 — RunContext split for runner.ts (2026-04-30)

**Status**: Proposed
**Author**: Franck (drafted by KDust Dev Agent)
**Supersedes**: nothing (extends ADR-0003 push pipeline)

**Context**:

`src/lib/cron/runner.ts:runTask()` has grown to a single 1500-line
function with 11 inline phases marked `[0] .. [10]` in the source.
All state — `job`, `run`, `policy`, `branch`, `protectedList`,
agent output, diff stats, abort signal, redactor, MCP handle — is
held in mutable locals threaded by closure across phases. The
runner/ subfolder already extracts pure helpers (abort, ancestors,
constants, notify, prompt, registry, timeout) but the orchestration
itself is monolithic.

Symptoms:

1. **Untestable**. With Vitest now landed (2026-04-30 commit
   `2d34252`) the rest of the test roadmap is gated on
   phase-level mocking, which the current shape forbids: there
   is no surface to mock against.
2. **High cognitive cost**. Anyone modifying phase [8] (commit +
   push) must read all of [0]–[7] to know which closure variables
   are valid at that point. This was raised by Franck during the
   2026-04-29 review of #1.
3. **Brittle ordering invariants**. `branch` is created in [3] but
   read by [8] for push and by [10] for the Teams report. The B2
   inheritance bug (Franck 2026-04-25 11:14) was caused by branch
   being persisted only at terminal points; making the branch ↔
   phase contract explicit would have made it a 1-line type error
   instead of a multi-hour debug.
4. **No clean place for new phases**. The `[2b] Audit
   short-circuit REMOVED 2026-04-22` comment is what a removed
   phase looks like in this shape. Adding one is symmetrically
   awkward.

**Decision**:

Introduce a typed `RunContext` and split `runTask()` into a fixed
sequence of phase functions. The shape:

```
type RunContext = Readonly<{
  // Immutable inputs resolved at [0]:
  task: Task;
  effectiveProjectPath: string;
  projectFsPath: string;
  policy: PushPolicy;
  options: RunTaskOptions;
  // Mutable run record + helpers shared across phases:
  run: TaskRun;             // re-fetched at each setPhase
  setPhase: (p: RunPhase, message?: string) => Promise<void>;
  abortSignal: AbortReason | null;
  redactor: (s: string) => string;
  // Per-phase outputs accumulated by `with*()` helpers:
  branch?: string;          // set by [3]
  mcpServerId?: string;     // set by [4]
  agentOutput?: AgentOutput; // set by [5]
  diff?: DiffStats;         // set by [6]
  pushOutcome?: PushOutcome; // set by [8]
}>;

type Phase = (ctx: RunContext) => Promise<RunContext>;
```

`runTask()` becomes:

```
const phases: Phase[] = [
  preflight,        // [0] resolve project, lock, create TaskRun
  preSync,          // [2]
  branchSetup,      // [3]
  setupMcp,         // [4]
  runAgent,         // [5]
  measureDiff,      // [6]
  guardLargeDiff,   // [7]
  commitAndPush,    // [8]
  notify,           // [10]
];

let ctx = await initContext(taskId, opts);
for (const p of phases) {
  if (ctx.abortSignal) break;
  ctx = await p(ctx);
}
return ctx.run.id;
```

Each phase is a top-level async function in
`src/lib/cron/runner/phases/<name>.ts`, exporting one default
function and zero free state. Tests mock the SDK / git / MCP
boundaries by passing fakes via `RunTaskOptions.deps` (a new opt
slot kept undefined in production).

**Migration plan** (incremental, 1 phase per commit):

1. **Step A** — define `RunContext` + `Phase` types in
   `src/lib/cron/runner/context.ts`. No behaviour change. (~50 LoC,
   this commit.)
2. **Step B** — extract `preflight` (current [0] + [1]) into
   `runner/phases/preflight.ts`. `runTask()` calls it but keeps
   the rest inline. Validate by running 1 manual task end-to-end.
   Vitest covers `preflight()` against a tmp sqlite + Prisma fake.
3. **Steps C..J** — extract one phase per commit, in execution
   order. Each commit:
   - moves the phase body into `phases/<name>.ts`;
   - asserts `runTask()` still type-checks and lints;
   - adds `phases/__tests__/<name>.spec.ts` with at least the
     happy path + 1 error branch.
4. **Step K** — replace the `[0..10]` if-chain inside `runTask()`
   with the `for (const p of phases)` loop. This is the
   commit where the shape change becomes visible.
5. **Step L** — convert `setPhase` into a closure built by
   `initContext()`, eliminating the last shared mutable.

Any commit may be reverted in isolation; the runner stays
runnable at every step.

**Consequences**:

Positive:
- Each phase is unit-testable against an in-memory Prisma + the new
  `deps` injection seam. Closes the test-coverage gap on the push
  pipeline.
- Adding a new phase is 1 file + 1 entry in the `phases[]` array.
  No more closure-variable archaeology.
- Type system enforces the "branch ↔ phase" invariant: phases
  past [3] can read `ctx.branch!`, prior ones cannot.
- B2 / B3 logic stays in its current files (resolveB2B3 already
  factored out). RunContext just makes its inputs (parentRunId,
  branch) cheaper to thread.

Negative:
- 1 extra layer of indirection (`RunContext` shape) — readers must
  learn one new vocabulary item. Mitigated by colocated JSDoc.
- Diff blame on `runner.ts` will be heavily perturbed during
  Steps B..J. Mitigated by adding the migration commits to
  `.git-blame-ignore-revs` (parallel follow-up).
- ~10 commits to land the full refactor. Each individually
  small; collectively a ~3-4h project gated on the test suite.

Neutral:
- The `runner/` subfolder grows a `phases/` sub-subfolder with
  one file per phase. The `__tests__/` mirror lives next to it.
- `src/lib/cron/runner.ts` shrinks from 1517 to ~120 lines
  (init + loop + exports). The rest is dispersed but each piece
  is < 200 lines.

**Out of scope**:

- Replacing the cron lib (`croner`) or the scheduler tick loop
  (`scheduler.ts`). RunContext is per-run; the scheduler doesn't
  need to know.
- Touching `src/lib/cron/runner/*.ts` helpers that already live
  outside `runner.ts` (abort, registry, timeout, …). They become
  injectable through `RunContext.deps` without rewriting them.
- Renaming any DB column. Phase 1 of ADR-0005 still applies and
  is independently sequenced.

### ADR-0007 — Split provider-orchestrator into build + finalize sub-pipelines (2026-05-01)

**Status**: Proposed
**Author**: Franck (drafted by KDust Dev Agent)
**Supersedes**: nothing (specialises ADR-0004 task-runner MCP)

**Context**:

The `provider-orchestrator` task on the `terraform-provider-windows`
project is a 6-stage Dust agent pipeline (spec → schema → code → local
tests → quality gate → real Windows GHA validation) with bounded retry
loops at stages 4, 5 and 6. Driven by the `TF-ProviderOrchestrator`
agent which enforces a strict "1 tool per step, `wait_for_run` alone"
discipline (Rules 1–4 of its system prompt) to dodge the
`multi_actions_error` planner bug.

The night of 2026-04-30/05-01 a full run terminated with
`status="success"` but the agent reply was truncated mid-step-4: no
final report, stages 5–6 never dispatched. Root cause is structural,
not a bug.

Measured cost per run:

| Source | Steps |
|---|---|
| Initial dispatch of each of the 6 stages | 6 |
| `wait_for_run` polls per long child (5–15 min) | 1–3 each |
| Forced "empty analysis step" between dispatch and next dispatch | 6 |
| Worst-case retry loops (3 + 2 + 2) at stages 4/5/6 | up to 14 extra dispatches |

Worst-case total: 70–100 agent steps. The Dust agent runtime caps an
agent run around 25–50 planner iterations, after which it forces a
final response. The pipeline thus deterministically truncates on
long-tail runs — exactly what was observed.

Secondary issue: no idempotence. Every rerun (manual or after a
truncation) replays stages 1–4 even if their artefacts are already
on disk and committed.

**Decision**:

Split `provider-orchestrator` into three tasks, all sharing the same
Dust agent (`TF-ProviderOrchestrator`) and bound to
`terraform-provider-windows`:

1. **`provider-orchestrator`** (rewritten in place, same id) —
   *thin chainer*. Dispatches `provider-pipeline-build`, then
   `provider-pipeline-finalize`. Aggregates results. Worst-case
   budget: ~6–8 steps.
2. **`provider-pipeline-build`** (NEW) — stages 1–4
   (`win-spec-analyst` → `schema-architect` → `provider-coder` initial
   → `test-engineer` + code↔test loop max 3). Worst-case budget:
   ~25–35 steps.
3. **`provider-pipeline-finalize`** (NEW) — stages 5–6
   (`quality-gate` + review↔code loop max 2, then `test-gh-runner` +
   gh↔code loop max 2). Worst-case budget: ~25–35 steps.

Each sub-pipeline contains a 1-step **idempotence preamble** that
groups `ls`/`cat` checks of WORK_DIR artefacts into a single
`fs_cli__run_command` invocation, plus an explicit `RESUME_FROM`
override. Skipped stages do not consume budget.

Each sub-pipeline returns a structured JSON tail block
(`build_status` / `finalize_status`) so the thin orchestrator can
decide in inline reasoning instead of an extra step.

The legacy thin launchers `windows_feature` and `windows_services`
are deleted: the orchestrator is now invoked directly with an
`input` override (`RESOURCE_NAME`/`DESCRIPTION`/`WORK_DIR`).

**Consequences**:

*Positive*:

- Step budget margin: each sub-pipeline runs comfortably below the
  agent ceiling. Truncation at stage 4 is no longer reachable.
- Cheap retries: a failed finalize replays only stages 5–6; a
  failed build can resume at any stage via `RESUME_FROM:N`.
- Honest status reporting: the thin orchestrator returns
  `PARTIAL`/`ESCALATED` with a precise `RESUME_FROM` recommendation
  instead of a misleading `success`.
- Same agent for the 3 tasks — no new system prompt to maintain.

*Negative*:

- Three prompts to maintain instead of one. Mitigated by storing
  human-readable specs in `docs/prompts/*.md`, the seed script
  `scripts/seed-provider-pipeline.mjs` being the single source of
  truth for DB content.
- B3 merge-back happens twice (once per sub-pipeline) instead of
  once; chain trees are deeper. Not a problem under current B3
  semantics (fast-forward only) but worth re-checking if we ever
  switch to non-FF.
- Dust agent's "step d'analyse sans outil" convention (in
  `TF-ProviderOrchestrator` system prompt) remains a small
  per-stage tax. The new prompts mitigate by combining reasoning
  with the next `run_task` call inline (allowed by Rules 1–4, just
  pessimistically un-applied in the original convention).

**Out of scope** (deliberate):

- No change to worker tasks (`win-spec-analyst`, `schema-architect`,
  `provider-coder`, `test-engineer`, `quality-gate`, `test-gh-runner`).
- No change to the `TF-ProviderOrchestrator` agent system prompt.
  A future ADR may relax the "empty analysis step" pattern.
- No parallelisation of stages 4 and 5 (would require disabling B3
  on one branch — forbidden by current safety guard-rail).
- No external scheduler / state-file model (the current Dust
  iteration cap is still livable with split + resume).

### ADR-0008 — Decoupled chain model (2026-05-02)

**Status**: Accepted (commits 1+2+3+4+5+5b+5c+6 landed on
`task-runner/decoupled-chain`)
**Date**: 2026-05-02
**Context**: The orchestrator/worker model (`run_task` synchronous,
`dispatch_task` fire-and-forget, `wait_for_run` re-await) had grown
brittle on long workflows:

- Synchronous `run_task` must complete within the 60s MCP client
  timeout. Long pipelines (5+ steps, each minutes long) cascade
  `pending` payloads that the orchestrator must re-await, doubling
  the failure surface.
- `parentRunId` / `runDepth` lineage couples a child's lifetime to
  its parent's. A parent that times out produces orphan children in
  `running` state and triggers cascade-abort logic.
- B2 auto-inherit + B3 auto-merge-back propagate failures across
  branches in non-obvious ways. Debugging a failure on a 3-level
  nested chain requires replaying 3 distinct branch states.
- The mental model ("orchestrator agent A calls worker B which
  calls worker C") doesn't match how Dust agents actually behave:
  they're stateless turn-by-turn, with no resumption guarantees
  across MCP timeouts.

**Decision**: Replace the hierarchical orchestrator/worker model
with a **decoupled chain**: each run is a fresh top-level execution;
a run announces its successor via a single MCP tool
`enqueue_followup({task, input, project?, base_branch?})` called
toward the END of its prompt. The successor runs as a brand-new
root run (`parentRunId=NULL`, `runDepth=0`, no B2/B3 inheritance);
the only inter-run linkage is a forward pointer
`TaskRun.followupRunId` set on the source run.

MCP surface contract:

| Tool                  | Verdict      |
|-----------------------|--------------|
| `list_tasks`          | Kept         |
| `describe_task`       | Kept         |
| `update_task_routing` | Kept         |
| `enqueue_followup`    | NEW          |
| `run_task`            | REMOVED (commit 2) |
| `wait_for_run`        | REMOVED (commit 2) |
| `dispatch_task`       | REMOVED (commit 2) |

Cascade-abort is replaced by a structural property: if a run fails
or is aborted before reaching the prompt step that calls
`enqueue_followup`, the successor is never created. No DB-level
cascade is needed.

Invariants:

- AT MOST ONE successor per run (enforced at write time in the
  tool: a second call returns an error, not a silent overwrite).
- Branches are NEVER auto-inherited — `base_branch` must be passed
  explicitly when the successor needs a non-default branch.
- Chain depth is NOT capped at the runner level (acceptable v1
  risk; revisit if cycles appear in production).
- Pipelines pass data via `input` (string; JSON-encoded when
  structured) — there is no synchronous return-value channel.

Rollout, in three commits on branch `task-runner/decoupled-chain`:

1. **Commit 1 (this change)**: ADR + additive Prisma migration
   (`TaskRun.followupRunId`) + `enqueue_followup` registered
   alongside the legacy trio. No behaviour change for existing
   tasks.
2. **Commit 2**: remove `run_task` / `wait_for_run` / `dispatch_task`
   tool registrations + the `task-runner/tools/{run-task,wait-for-run,
   dispatch-task}.ts` modules + the `b2b3.ts` / `dispatch-helpers.ts`
   helpers + the `is_orchestrator` flag in `list_tasks`/
   `describe_task` outputs. Update setup-mcp / preflight specs.
3. **Commit 3**: refactor `/run` UI from arborescent tree to
   linear chain (forward walk via `followupRunId`); rewrite
   `docs/task-runner.md` accordingly; scrub stale references
   to `parentRunId` / `runDepth` / `B2` / `B3` / orchestrator
   vocabulary across docs and prompts.
5. **Commit 5**: fix `input` semantics. Previously
   `enqueue_followup`'s `input` mapped to `promptOverride`,
   wholesale-replacing the successor's stored prompt — broken by
   design in the chain model since each worker would lose its
   own logic. Now `input` is APPENDED under a `# Input` section
   via a new `RunTaskOptions.inputAppend` opt; `promptOverride`
   is preserved for legacy callers that need full replacement.
   `/api/task/[id]/run` POST learns the same `input` field;
   `RunNowButton` exposes it via Shift-click (project-bound) or
   the existing popover (generic). Doc updated in
   `docs/task-runner.md`.

4. **Commit 4**: collapse the orchestrator/worker role.
   `Task.taskRunnerEnabled`, `AppConfig.orchestratorRunTimeoutMs`,
   `AppConfig.taskRunnerMaxDepth` are dropped (Prisma migration
   `20260502160000_drop_orchestrator_role`); the task-runner
   MCP server is now bound to **every** task; the run-time cap
   is unified on `leafRunTimeoutMs` (30 min default); the
   per-task UI fieldset becomes "Shell execution & secrets"
   (just command-runner + secret bindings); the
   `/settings/task-runner` page is removed; the role-based
   amber/sky border on `/task` is unified to sky. The legacy
   boolean is still accepted but ignored on the
   POST/PATCH `/api/task` endpoints for backward compat with
   pre-ADR clients.

**Consequences**:

*Positive*:

- One MCP call per chain step. No 60s timeout cascade, no `pending`
  resume dance, no nested depth budget to tune.
- Each run is independently replayable: its `input` is a complete
  payload, its branch is explicit, no parent state to reconstruct.
- `/run` becomes a flat list with forward chain links; the
  arborescent tree (and its 200-line BFS in `registry.ts`) goes
  away.
- Orchestrator/worker distinction in tasks UI collapses:
  `taskRunnerEnabled` becomes a plain ACL ("may this task enqueue
  successors?" turned out to be every task → no toggle needed),
  not a role.

*Negative*:

- Existing orchestrator-style task prompts must be REWRITTEN
  manually — the `run_task` / `wait_for_run` patterns no longer
  exist. Mitigated by the small number of orchestrator tasks in
  practice and the docs rewrite.
- No synchronous result channel: a successor cannot "answer back"
  to the source run. The source run must encode all decisions in
  the successor's `input` BEFORE enqueuing. Acceptable trade-off
  because Dust agents can run their own checks (lint, tsc, tests)
  inline via `command-runner`/`fs-cli` before deciding what to
  enqueue.
- B3 auto-merge-back disappears for chain-mode workflows. Each
  step that needs a specific branch must pass it via `base_branch`
  in the successor's `enqueue_followup` call. Long pipelines that
  accumulate commits on a shared branch are easy (just thread the
  branch through `input`); pipelines that needed FF-merging back
  into a parent branch must be redesigned.
- Cycle protection moves from runner-enforced (`runDepth` cap) to
  prompt-enforced (the agent must not re-enqueue itself). v1
  accepts this risk; v2 may add a chain-length cap walked via
  `followupRunId`.

**Follow-up commits** (chain hardening, 2026-05-02 \u2192 2026-05-03):

- **Commit 5b** \u2014 `predecessorRunId` channel on
  `RunTaskOptions`, used only by `preflight.ts`'s concurrency-lock
  bypass. The predecessor is still flagged `running` for the few
  ms between its `enqueue_followup` tool call and its own
  completion; without this bypass it was treated as a sibling
  collision and skipped the successor on the per-project lock.
  Distinct from `parentRunId` (which stays null in the decoupled
  model so no lineage is reintroduced).
- **Commit 5c** \u2014 `discardLocalBranch()` helper on `git.ts`,
  invoked by `measure-diff.ts` no-op short-circuit. When a worker
  writes only to gitignored paths (typical for chain workers in
  the `terraform-provider-windows` pipeline) the run finishes
  without commits and the local `kdust/<task>/<ts>` branch was
  left dangling. Across long fix-loop chains this accumulated
  dozens of dead local refs; cleanup is best-effort and never
  touches origin.
- **Commit 6** \u2014 **Shared chain branch**. A `CHAIN_BRANCH:`
  directive parsed out of `inputAppend` in `runner.ts` is
  forwarded to `branch-setup.ts` as `chainBranchOverride`. When
  set, the run joins an existing remote branch via
  `checkoutChainBranch()` (fetch + checkout `origin/<branch>`)
  instead of composing a fresh `kdust/<task>/<timestamp>` ref. The
  first worker creates the branch from base; subsequent workers
  in the chain stack their commits on top. Result: ONE PR per
  full chain run, with a commit per worker that produced code
  (schema, impl, tests, fix attempts, docs). Auditable history,
  reviewable diff, and fix-loop iterations stay visible as
  individual commits. Prompts of the
  `terraform-provider-windows` chain (5 tasks) were rewritten to
  emit and forward `CHAIN_BRANCH`, write to tracked paths
  (`internal/...`, `docs/resources/...`,
  `examples/resources/...`, `CHANGELOG.md`), and drop the
  former `provider-coder MODE=integrate` mass-copy step
  (no longer needed).

### ADR-0009 — Deferred chain successor dispatch (2026-05-05)

**Status**: Accepted (postmortem fix on top of ADR-0008)
**Date**: 2026-05-05
**Context**: Race condition postmortem on the
`terraform-provider-windows` chain (`windows-resource → win-spec-analyst
→ schema-architect → …`). Symptoms: every successor failed pre-sync
with `fatal: couldn't find remote ref kdust/chain/<resource>-<ts>` a
few seconds before the predecessor's own success. Timeline (UTC,
2026-05-05):

| 14:03:19 | `win-spec-analyst` starts |
| 14:06:14 | `win-spec-analyst` agent calls `enqueue_followup(schema-architect)` |
| 14:06:18 | **`schema-architect` starts** ← pre-sync fetches chain branch |
| 14:06:20 | `schema-architect` FAILS (branch absent on origin) |
| 14:06:23 | `win-spec-analyst` `commit-and-push` finishes (chain branch reaches origin) |
| 14:06:26 | `win-spec-analyst` marked `success` |

The original ADR-0008 implementation of `enqueue_followup` kicked off
the successor synchronously inside the agent's tool call (parent's
phase 5/10, `run-agent`). The parent's `commit-and-push` is phase
8/10. So the successor's pre-sync (its own phase 2) raced with the
parent's still-pending push of the chain branch — a 5-second window
where `git fetch origin <chain>` fails hard.

The original tool's docstring stated *"the current run finishes
normally; the successor runs as a fresh top-level run"* — the
**intent** was always deferred dispatch, but the **implementation**
fired the successor immediately and even bypassed the per-project
concurrency lock via `predecessorRunId` (commit 5b). The hack that
made successors not skip on the lock is exactly what made the race
visible. ADR-0008 worked for chains where successors didn't need the
parent's branch (most pre-shared-chain-branch chains); commit 6's
shared chain branch made every step depend on the predecessor's
push.

**Decision**: Genuinely defer the successor dispatch to **after**
the parent's success notification.

The `enqueue_followup` MCP tool no longer calls `runTask`. It
validates the successor's parameters and **records** them on the
parent's `TaskRun` row in four new nullable columns:

```
TaskRun.pendingFollowupTaskId       String?
TaskRun.pendingFollowupInput        String?
TaskRun.pendingFollowupProject      String?
TaskRun.pendingFollowupBaseBranch   String?
```

The runner's success path (in `src/lib/cron/runner.ts`, after
`runNotifySuccess`) reads those columns and dispatches the
successor as a fresh top-level run via a new helper
`dispatchPendingFollowup(parentRunId, parentTaskName)`. The parent's
`followupRunId` is set when the successor's run row is created,
keeping the existing `/run` forward-walk semantics.

Cascade-stop is preserved by construction: if the parent fails at
any phase before the post-notify dispatch step, control jumps to the
`catch{}` and `runHandleFailure` runs instead — the
`pendingFollowup*` columns stay set on the row but are never
consumed. Surfaced in `/run` as a postmortem signal ("agent declared
a successor that was never dispatched") rather than as a phantom
successor in `running` state.

The `predecessorRunId` lock-bypass channel (commit 5b) becomes
moot: by the time `dispatchPendingFollowup` runs, the parent's
`TaskRun.status` is already `success`, so preflight's per-project
concurrency check (which filters on `status='running'`) doesn't
treat the parent as a sibling. We keep the `predecessorRunId`
parameter on `RunTaskOptions` for compat (legacy chat-mode
dispatchers still pass it; preflight ignores absent rows) but
`enqueue_followup` no longer sets it.

**Invariants preserved**:

- AT MOST ONE successor per run. The tool checks both
  `followupRunId` (post-dispatch) and `pendingFollowupTaskId`
  (pre-dispatch) before writing.
- Branches are NEVER auto-inherited. `base_branch` is recorded
  verbatim and replayed by the deferred dispatch.
- The tool now operates in **two modes**, auto-detected from the
  MCP context (chat-mode regression fix, 2026-05-05b — initial
  ADR-0009 wording said chat-mode would be rejected; that broke
  the human-driven "lance la task X" UX in `/chat`):
  - **chain mode** (`orchestratorRunId` set): record-only,
    deferred dispatch by the runner after notify-success — the
    ADR-0009 fix described above.
  - **chat mode** (`orchestratorRunId` null): immediate
    fire-and-forget via `runTask()`, returns the `run_id`. No
    parent commit-and-push exists to wait for, so the race
    ADR-0009 protects against doesn't apply. This is the
    original ADR-0008 path, kept for chat-mode only. The
    at-most-one-successor invariant is enforced in chain mode
    only; chat-mode each call is independent.

**Migration**: `20260505160000_deferred_followup` — purely additive,
4 nullable columns on `CronRun` (Prisma `TaskRun`). Applied via
`prisma db push` (project convention); SQL recorded under
`prisma/migrations/` for trace.

**Consequences**:

*Positive*:

- Race is structurally impossible: the chain branch is on origin
  before the successor's pre-sync runs.
- Implementation matches the documented intent ("current run
  finishes normally; successor runs as a fresh top-level run").
- One less concurrency-lock special case (`predecessorRunId`
  bypass), although the channel is kept for safety.
- Failed parent → unconsumed `pendingFollowup*` is a useful
  postmortem signal in `/run`.

*Negative*:

- Successor's `run_id` is no longer available at the moment the
  agent calls the tool. The tool now returns
  `{status: 'scheduled', task: {id, name}}` instead of
  `{status: 'enqueued', run_id}`. No prompt currently consumes
  `run_id` so this is a transparent change for agents.
- A successor that depends on the parent's notification side
  effects (Teams card posted, etc.) was already racing under the
  old model; under ADR-0009 it now runs strictly after, which is
  also the only reasonable order.
- Adds one DB write per `enqueue_followup` call (recording the
  pending columns) and one DB read at end-of-run. Trivial cost.

**Follow-ups**:

- `/run` UI: surface `pendingFollowupTaskId` as an "abandoned
  successor" pill on failed runs. Read-only, postmortem aid.
- Remove the `predecessorRunId` channel entirely once we confirm
  no chat-mode caller depends on it (grep-clean as of this ADR;
  defer one release for safety).

### ADR-0010 — Dispatch deferred successor on no-op runs (2026-05-09)

**Status**: Accepted (extends ADR-0009)
**Date**: 2026-05-09
**Context**: Postmortem of run `cmoy3enpf006xxsp03l4v4ubu`
(`test-engineer` ATTEMPT 2, chain `windows_winget_package-ds`).
Symptom: the chain stopped silently after a green re-test.
Timeline:

| 08:39:18 | `test-engineer` ATTEMPT 2 starts (re-test after `provider-coder` fix) |
| 08:50:45 | tests pass (coverage 69.2%); agent calls `enqueue_followup(quality-gate)` and emits its verdict report |
| 08:50:45 | run terminates as `no-op` — `filesChanged === 0` (the agent only updated a YAML report which happened to be byte-identical to the previous attempt's) |
| —        | **`quality-gate` is never dispatched**; `/run` shows the abandoned-successor pill ("never ran") |

ADR-0009's deferred dispatch is wired to the **success path only**
(`runner.ts`, after `runNotifySuccess`). Phase [6] `measureDiff`
short-circuits the run as `no-op` and returns immediately — phase
[11] (`dispatchPendingFollowup`) is never reached. The
`pendingFollowup*` columns stay set, the `/run` UI surfaces them as
*abandoned successor*, but no successor runs.

This was tolerable when no-op was a rare "agent had nothing to do"
outcome. With **verifier-style agents** (`test-engineer` in re-test
mode after an upstream fix; lint-only; security-audit; coverage
gate), the legitimate output is a **verdict** carried by
`enqueue_followup`, not a git diff. Conflating *zero diff* with
*nothing to chain* breaks every such chain.

**Decision**: Extend the deferred dispatch to fire from the no-op
short-circuit too, when (and only when) the agent recorded a
`pendingFollowupTaskId` on the parent row.

Implementation (`src/lib/cron/runner/phases/measure-diff.ts`):
immediately after the no-op DB persistence + Teams notify, before
returning `{ ok: false }`, dynamically import
`dispatchPendingFollowup` from `runner.ts` and invoke it. The
import is dynamic to break the runner.ts ↔ measure-diff.ts module
cycle (runner.ts owns `runTask`, which `dispatchPendingFollowup`
needs; measure-diff.ts is imported by runner.ts). Errors from the
dispatch are logged and swallowed: the no-op TaskRun row is
already persisted, the success card already posted, and the
at-most-one-successor invariant is enforced inside the helper
(belt-and-braces against double-dispatch).

`/run` pill semantics updated: the "pending dispatch failed"
(orange `⚠`) variant now triggers on `status === 'success' || status === 'no-op'`
(both should have dispatched and didn't). Failed/cancelled runs
keep the "abandoned" (`🚫`) variant — cascade-stop is unchanged.

**Invariants preserved**:

- Cascade-stop on **failure**: control still jumps from any phase
  ≤ [6] to `runHandleFailure` via the runner's `catch{}`, never
  reaching the new no-op dispatch hook. `pendingFollowup*` stays
  abandoned (postmortem signal).
- AT MOST ONE successor per run: enforced inside
  `dispatchPendingFollowup` (checks `followupRunId` before
  starting `runTask`). Calling the helper twice (once from no-op,
  once from success — impossible since the two paths are
  exclusive, but defensive) is a no-op the second time.
- Branches NEVER auto-inherit: `pendingFollowupBaseBranch` is
  replayed verbatim, same as ADR-0009.
- No new prompt or schema change. Same DB columns, same MCP tool
  contract.

**Migration**: none. Code-only change.

**Consequences**:

*Positive*:

- Verifier agents can chain forward without producing a
  cosmetic-only commit (no more `touch` hacks).
- Sets a clean separation between "agent had nothing to do" (no
  `enqueue_followup` call, no diff → run ends, chain stops
  naturally) and "agent had a verdict to forward" (called
  `enqueue_followup`, no diff → chain continues).
- The `/run` abandoned-successor pill becomes a tighter signal
  (only fires on real failures or actual dispatch crashes).

*Negative*:

- A no-op run now incurs the cost of starting a successor
  (preflight, branch checkout, agent boot). Negligible vs. the
  alternative of breaking the chain.
- Adds a second call site for `dispatchPendingFollowup`. Mitigated
  by the at-most-one invariant inside the helper and by the
  exclusivity of the two paths (no-op short-circuit returns; the
  success path is gated on `filesChanged > 0`).

**Follow-ups**:

- Add a `Risks` note to `docs/tasks.md` so authors of new
  verifier-style tasks know they don't need a fake commit.
- Consider an explicit `escalated` status for agents that
  *refuse* to act (cf. provider-coder's `ESCALATE` convention,
  see run `cmoy19nem005fxsp0o5b6g8mj` postmortem). Distinct from
  `no-op` because semantics differ (refusal vs. nothing-to-do).

### ADR-0010 — Task attachments (2026-05-09)

**Status**: Accepted

**Context**:

The `/chat` composer has supported file attachments since
2026-04-23, but Tasks (cron + manual + MCP-dispatched) had no
equivalent: a task whose prompt referenced "the attached spec"
could not actually pass the file to the agent. Workarounds (paste
the content into the prompt, host the file in the project repo)
are clunky for binary files like PDFs.

**Decision**:

New `TaskAttachment` model with bytes stored on disk under
`KDUST_ATTACHMENTS_DIR` (default `/projects/.kdust-attachments`).
The runner re-uploads each blob to Dust on every run and passes
the resulting `fileIds` to `createDustConversation`, which already
supports the wire shape from the chat composer. Caps: 50 MB / file,
200 MB total per task.

Dust file ids are not cached: they are short-lived and
conversation-bound, so re-uploading is the only correct approach.

See `docs/task-attachments.md` for full details.

**Consequences**:

*Positive*:

- Tasks with binary inputs (PDFs, Office docs, screenshots) are
  finally first-class.
- Single source of truth for MIME normalisation
  (`src/lib/dust/content-type.ts`), shared between the chat
  composer and the cron runner.

*Negative*:

- Adds a per-run network round-trip per attachment to Dust's
  `uploadFile`. Negligible at our scale (few attachments, sequential
  upload).
- Adds a new on-disk persistence root that must be backed up if
  attachments matter operationally.

## ADR-0011 — Self-hosted SSH identities (Franck 2026-05-09)

**Status**: Proposed.

**Date**: 2026-05-09.

**Context**:

Until now, KDust relied on the host's `ssh-agent` (forwarded via
`SSH_AUTH_SOCK`) and a read-only bind mount of `${HOME}/.ssh` at
`/host-ssh` to authenticate the git push pipeline. Both mechanisms
tie KDust to the operator's desktop session: an agent that dies, a
locked workstation, or a Pi that boots without an interactive login
breaks every scheduled run.

**Decision**:

Introduce a `SshIdentity` model holding the private key encrypted at
rest (AES-256-GCM, same envelope as `Secret.valueEnc`). At boot,
`src/lib/ssh/bootstrap.ts` decrypts every enabled identity, writes
them to a tmpfs at `/run/kdust/ssh` (mode 0700, uid 1000), generates
an ssh config block per identity, and sets `process.env.GIT_SSH_COMMAND`
so `src/lib/git.ts` picks them up.

The legacy `SSH_AUTH_SOCK` and `/host-ssh` paths are kept as
fallbacks: ssh tries the agent first regardless, and `git.ts` still
defaults to `/home/node/.ssh/known_hosts` when no identity is
configured. Migration is therefore zero-downtime: the operator can
add identities one at a time, verify with the new reachability probe
at `/settings/ssh`, then unmount the host bind mount in a follow-up.

A new settings page at `/settings/ssh` hosts identity CRUD, public-
key copy buttons, fingerprint display, enable/disable, rotation, and
a stripped-down debug panel that runs `ssh -vT git@<host>` against
the generated config (replaces the standalone `/api/ssh-debug`).

**Consequences**:

*Positive*:

- The push pipeline becomes self-contained: a fresh deploy of KDust
  on a server with no operator login can push to git as long as
  `APP_ENCRYPTION_KEY` and `kdust.db` are restored.
- Identity rotation is now a 5-second UI action -- no redeploy.
- Per-host identities map cleanly to deploy-key UX on GitHub /
  GitLab.
- One-stop shop in `/settings/ssh` for operators (keys + diagnostics).

*Negative*:

- One more thing to back up alongside `APP_ENCRYPTION_KEY`. Losing
  the key still bricks restore -- same as `Secret`.
- The decrypted private bytes live in tmpfs while the container is
  running; a host root attacker can read them. This is acceptable
  given the existing DooD docker.sock mount already grants host
  root.
- Encrypted/passphrase-protected keys are rejected (would hang the
  unattended pipeline). Operators must generate fresh keys with
  `ssh-keygen -N ""`.

See `docs/ssh-identities.md` for the full operator handbook.

### ADR-0012 — Docker MCP Gateway integration (2026-05-10)

**Status**: Accepted (V2 — UI shipped 2026-05-10).

**Date**: 2026-05-10.

**Context**:

Docker Hub publishes a curated catalog of MCP servers
(`hub.docker.com/mcp`, 1900+ entries via the community registry)
covering GitHub, Discord, Context7, Brave Search, Postgres, etc.
KDust today ships only three in-process MCP servers (`fs-cli`,
`task-runner`, `command-runner`) and has no way to consume any of
the catalog servers — neither from `/chat` nor from Tasks.

We considered three integration paths:

1. **Proxy-per-image** — KDust spawns one stdio MCP container per
   server slug, on demand, mirrored as a `DustMcpServerTransport`.
   Native per-project sandboxing but N spawns per chat, all the
   sandbox/secret/catalog plumbing on us.
2. **Community gateway** (`hwdsl2/mcp-gateway`) — plug-and-play but
   single-maintainer, fixed catalog of 8 servers, no extension
   path.
3. **Official `docker/mcp-gateway`** — Docker-published image,
   `--transport streaming` HTTP endpoint, multiplexes N servers in
   one process, native flags for sandboxing
   (`--cpus --memory --block-network --block-secrets
   --verify-signatures`), supports OCI catalogs and 1900+ community
   servers. Authentication can be skipped on a private Docker
   network with `DOCKER_MCP_IN_CONTAINER=1`.

**Decision**:

Adopt option 3 in **HTTP streaming long-lived** mode: a single
`mcp-gateway` service is added to `docker-compose.yml` next to
`kdust` and `watchtower`. KDust opens **one** MCP `Client` over
streamable HTTP at `http://mcp-gateway:8080/mcp` from
`instrumentation.ts`, lists tools at boot, and re-exports them via
a new module `src/lib/mcp/gateway-proxy.ts` that creates one
`DustMcpServerTransport`-backed `McpServer` per project on demand.
The connection is held by a singleton handle; per-chat / per-run
acquisition mirrors the existing `getFsServerId` pattern.

The gateway is reachable only on the Compose-internal network
(`expose: 8080`, no `ports:`). No public ingress, no Bearer auth
needed for V1.

**Per-project scoping** is enforced in KDust, not in the gateway:
a new `ProjectMcpToolFilter` row whitelists `(server, tool)` pairs
per project. Default-deny: an unconfigured project sees zero tools
even if the gateway exposes them.

**Secret injection** keeps the existing `Secret` model authoritative.
KDust writes a `0600` env file to a tmpfs-backed bind mount
(`./mcp-gateway/secrets/kdust-mcp.env`) after resolving each
`McpServerSecret` row, and the gateway is started with
`--secrets=/secrets/kdust-mcp.env`. Rotation = re-write the file
+ HUP / restart the gateway.

**V1 scope is one server**: `github-official`, requiring a single
`GITHUB_PERSONAL_ACCESS_TOKEN` secret. The catalog server `docker`
is **explicitly excluded** from V1: it exposes a single
`docker(args: string[])` tool that is an unbounded shell on the
host docker socket (read host env, dump kdust.db, exec into any
container) — incompatible with the existing `Secret` /
`TaskSecret` redaction guarantees. A future ADR will define a
KDust-managed Docker-introspection MCP tool with a hard-coded
sub-command whitelist (`ps`, `logs`, `inspect`, `stats`) instead.

Reconfiguring the active server list in V1 is a compose edit
(`command: --servers=github-official,context7,...`) followed by
`docker compose up -d mcp-gateway`. A future ADR will introduce
a Prisma-backed registry.yaml watched by the gateway via `--watch`
for runtime add/remove without compose churn.

**Consequences**:

*Positive*:

- Unlocks 1900+ community MCP servers behind one stable contract,
  without writing one proxy module per image.
- Sandboxing (`--cpus`, `--memory`, `--block-network`,
  `--verify-signatures`) handled by the gateway, audited by Docker.
- Adding a new server = `--servers=...` flag edit + secret CRUD,
  not a code change.
- Per-project tool filtering remains a first-class KDust concept,
  consistent with how chat / orchestrator / push pipeline already
  scope capabilities.
- No new top-level npm dependency: `@modelcontextprotocol/sdk`
  already provides `Client` + streamable-HTTP transport.

*Negative*:

- One more long-lived container with `/var/run/docker.sock`
  mounted. Mitigation: the gateway image is signed by Docker
  (`--verify-signatures`) and Watchtower auto-updates it on the
  same `kdust-autoupdate` scope as `kdust` itself.
- "DooD inception": KDust → docker.sock → mcp-gateway →
  docker.sock → child MCP containers. Auditable but increases
  blast radius of a gateway compromise to whatever the gateway
  spawns. Per-server `--cpus`/`--memory`/`--block-network`
  defaults applied for V1.
- Catalog servers requiring OAuth-via-Docker-Desktop are out of
  scope. Workaround: provide raw tokens via `Secret`. Documented
  in `docs/mcp-gateway.md`.
- Secret rotation requires a gateway restart (no live SIGHUP path
  yet on `--secrets=path`). Acceptable at our scale.

See `docs/mcp-gateway.md` for the operator handbook (compose
snippet, adding/removing a server, secret rotation, debugging).

**V1 implementation notes (2026-05-10):**

- `McpServerSecret.envName` was renamed to `secretKey` before any
  `db push` ran; the field semantically holds the gateway-catalog
  key (e.g. `github.personal_access_token`), not a POSIX env var.
  The gateway resolves catalog keys to image-side env vars itself.
- New modules: `src/lib/mcp/gateway-client.ts` (singleton MCP
  Client over streamable HTTP), `src/lib/mcp/gateway-proxy.ts`
  (per-project `DustMcpServerTransport`), `src/lib/mcp/gateway-
  secrets.ts` (writes `${MCP_GATEWAY_SECRETS_DIR}/kdust-mcp.env`
  at mode 0600 on boot).
- New API routes: `POST /api/mcp/gateway-ensure`,
  `GET /api/mcp/gateway-tools`. The chat client folds the new
  ensure into the existing parallel-ensure flow next to fs-cli
  and task-runner.
- **UI** (`/settings/mcp`, V2 2026-05-10): three sections —
  Servers (slug, name, enabled toggle, delete), per-server Secret
  bindings (`secretKey` → `Secret.name`, with a dropdown sourced
  from `listSecrets()`), and per-project tool filters (multi-select
  modal against the live tools list from the gateway). An "Apply
  changes" button calls `POST /api/mcp/regenerate-secrets` which
  rewrites `kdust-mcp.env` and `docker restart`s the gateway
  container via the host socket (DooD). The `seed-mcp-gateway.mjs`
  script is kept as a fallback for scripted installs.
- **Default-deny defect fix** (V2 2026-05-10): the proxy now
  declares the `tools` capability up-front in the `McpServer`
  ctor so a project with zero whitelisted tools answers
  `tools/list` with `[]` cleanly instead of raising `-32601 Method
  not found` — the latter surfaced as a confusing red banner in
  /chat for any unconfigured project.
- The proxy registers tools with a permissive (empty) input
  schema — the gateway-side server validates args. A future pass
  could convert each tool's JSON Schema to a Zod shape for tighter
  agent-side hints.

### ADR-0013 — CLI tools over MCP servers when a mature CLI exists (2026-05-10)

**Status**: Accepted.

**Date**: 2026-05-10.

**Context**:

The MCP ecosystem grows fast and it is tempting to wire every
new server (zereight/gitlab-mcp, Atlassian community variants,
etc.) into the `docker/mcp-gateway` from ADR-0012. Each new MCP
adds: a sidecar container, a secret binding in `kdust-mcp.env`,
tool descriptions consuming context window, and a fresh attack
surface to audit.

For a large class of services, an agent running inside the
KDust container can already do the same job with a native CLI:
`gh` for GitHub, `glab` for GitLab, `curl` for arbitrary HTTP,
`rg`/`fd`/`make` for local code operations. KDust's secret
pipeline already injects `TaskSecret` values as environment
variables into the child process spawned by `command-runner`
(`src/lib/mcp/command-runner-server.ts`), and the log buffer
auto-redacts those plaintexts (`src/lib/logs/buffer.ts`,
"DYNAMIC RUN LAYER"). So binding `GITHUB_TOKEN` or `GITLAB_TOKEN`
to a task is enough for `gh` / `glab` to authenticate, with full
redaction guarantees — no MCP server required.

The trade-off is asymmetric:

- Adding a CLI to the image: one apt-get / .deb line, no runtime
  cost when unused, secrets work "for free" via env vars.
- Adding an MCP server: a sidecar process, secret broker entry,
  signature-verification decision, and tools/list tokens spent
  on every chat ensure.

**Decision**:

When a service offers both a mature CLI and an MCP server, KDust
prefers the CLI route by default. MCP servers are only added
when at least one of the following holds:

1. No mature CLI exists (e.g. Sentry, Atlassian, Playwright).
2. Structured (JSON-Schema-validated) output is required for
   reliable agent chaining across many calls.
3. A narrow per-tool whitelist (< 5 tools) provides a strict
   security boundary that a generic shell cannot.

Concretely this ADR adds the following CLIs to the runner stage
of the Dockerfile:

- `curl` — kept at runtime (previously purged at the end of the
  apt layer alongside `gnupg`).
- `glab` v1.94.0 — official GitLab CLI from
  `gitlab.com/gitlab-org/cli`, pinned `.deb` from the release.
- `ripgrep` — fast, gitignore-aware code search.
- `unzip`, `xz-utils` — extract release archives commonly
  shipped by GitHub/GitLab/Linux projects.
- `make` — canonical entry point for most repository tasklets
  (`make test`, `make lint`, …).

This explicitly **does not** introduce a generic MCP proxy (Option
B/C from the 2026-05-10 discussion) — the `docker/mcp-gateway`
stays the sole MCP entry point.

**Consequences**:

- The Tier-1 CLI list (`gh`, `glab`, `curl`, `rg`, `unzip`,
  `xz-utils`, `make`, plus the pre-existing `git`, `jq`, `yq`,
  `rsync`, `openssh-client`, `docker`, `docker-compose-plugin`)
  is now part of the runtime contract. Removing one of them is
  a breaking change for tasks that grew to rely on it.
- The `mcp/gitlab` catalog server (archived upstream) is **not**
  enabled. Agents talk to GitLab via `glab` + `GITLAB_TOKEN`
  TaskSecret binding. Same pattern as `gh` + `GITHUB_TOKEN`.
- Future MCP additions must justify against the three criteria
  above in the PR description or a follow-up ADR.
- Image size: +~22 MB (glab ~15 MB, Tier-1 utilities ~7 MB).
  Acceptable given the runner stage already weights several
  hundred MB.
- No change to push-pipeline, secrets, MCP gateway, or run-depth
  semantics. Pure runtime tooling addition.

### ADR-0014 — Push-pipeline credentials via Secret Manager (2026-05-10)

**Status**: Accepted (supersedes the Phase 2 "env var name"
decision from `src/lib/git-platform/README.md`).

**Date**: 2026-05-10.

**Context**:

Up to this point KDust had **two parallel secret backends**:

- The **Secret Manager** (`Secret` / `TaskSecret` models,
  AES-256-GCM at rest, UI-driven rotation, `Secret.lastUsedAt`
  audit, plaintext redaction via `src/lib/secrets/redact.ts`) —
  used by `command-runner` to inject env vars into TaskRun
  child processes. This is the path agents use when invoking
  `gh`, `glab`, `curl`, etc.
- A **legacy `process.env` lookup** (`Project.platformTokenRef`
  -> `process.env[name]`) — used by `src/lib/git-platform/`
  to obtain the PAT that opens PRs/MRs after a successful push.

The asymmetry was real and unjustified:

| Aspect | Secret Manager path | `process.env` path |
|---|---|---|
| At-rest encryption | AES-256-GCM | none (cleartext in `.env`) |
| Rotation UX | UI, no restart | edit `.env` + restart container |
| Audit | `Secret.lastUsedAt` | none |
| Leak radius | run-scoped child env | whole-container `process.env` |
| Redaction | runtime redactor attached | none |

ADR-0013 (2026-05-10) committed the project to a single credential
backend for agents ("CLIs + TaskSecret"). This ADR aligns the push
pipeline with the same backend, removing the parallel path.

An audit of the maintainer instance (Franck, Ecritel, 2026-05-10)
showed no projects with an active `platformTokenRef` binding, which
made the window for a clean break (no rollback path needed) optimal.

**Decision**:

1. Drop `Project.platformTokenRef` (string column).
2. Add `Project.platformSecretName` (string column, nullable),
   the name of a row in the `Secret` table.
3. Make `resolveGitPlatform()` **async** and resolve the token via
   `db.secret.findUnique({ where: { name } })` + `decrypt(valueEnc)`.
   Best-effort bump of `Secret.lastUsedAt` for audit parity with
   `resolveForRun()`.
4. Implement `gitlab.ts` adapter (was a Phase 3 placeholder returning
   `not implemented yet`). GitLab v4 REST over `fetch`, mirrors
   `github.ts` in shape and error handling. Project ID = URL-encoded
   `group/sub/repo`. Auth = `PRIVATE-TOKEN` header.
5. UI `/settings/projects/:id`: replace the free-text
   `platformTokenRef` input with a `<select>` populated from
   `GET /api/secrets`. Missing-binding case kept visible to nudge
   the user toward re-selection.

**Consequences**:

- The push pipeline now requires a `Secret` row, **not** a
  container env var. Operators must create the secret via
  `/settings/secrets` and bind it on the project edit page.
- The same secret can be reused as a `TaskSecret` binding
  (env var `GITHUB_TOKEN` / `GITLAB_TOKEN`) so agents invoking
  `gh`/`glab` and the push pipeline opening the PR/MR share one
  source of truth for the PAT. Rotation is one UI edit.
- `resolveGitPlatform()` is now async; the only caller
  (`src/lib/cron/runner/phases/commit-and-push.ts`) was updated to
  `await` it. No other callsite touches the function.
- Backward incompatibility: external instances with an active
  `platformTokenRef` binding lose auto-PR until they re-bind via
  the new mechanism. The pre-existing skip-with-warning behaviour
  means the **push itself** keeps working; only the PR/MR opening
  step is gated. This is acceptable for a personal-scale
  self-hosted product (no announced external users at this date).
- GitLab support unlocks the next class of use cases (Ecritel
  self-hosted GitLab) without further schema changes. The same
  `Secret` table powers it.
- No new dependency. `@gitbeaker/*` was considered and rejected
  for the same reason `@octokit/rest` was rejected in Phase 2:
  the 3-endpoint surface does not justify the maintenance cost.
- The master key `APP_ENCRYPTION_KEY` becomes the single point of
  compromise for both Tasks and the push pipeline. This is
  unchanged in nature (Tasks were already covered) and acceptable
  given the alternative (two parallel key managements with worse
  ergonomics).

### ADR-0015 — Boot-time `gh` / `glab` authentication (2026-05-11)

**Status**: Accepted.

**Context**. Several flows need the GitHub / GitLab CLIs to be
ready to use without bespoke per-task wiring:

- The push pipeline (PR/MR opening, soon).
- Agents in the chat that shell out via `fs_cli__run_command`
  (e.g. `gh pr view 42`, `glab mr list`).
- Manual `docker exec` operator workflows.

Until now both CLIs were installed in the image but unauthenticated.
Every caller had to inject a `GH_TOKEN` / `GITLAB_TOKEN` env var on
the fly, which (a) leaked the token to argv-readers inside the
container, (b) required each Task to bind a `TaskSecret` even for
read-only operations, and (c) made the chat surface unusable for
GitHub/GitLab queries without a dedicated MCP wrapper.

The Secret Manager (ADR-0014) already holds the same PATs the push
pipeline uses. Reusing them at boot is one DB read + one stdin
pipe per CLI.

**Decision**:

1. Add `src/lib/git-cli/bootstrap.ts` exposing
   `bootstrapGitCliAuth()`. Reads `GH_TOKEN`, `GH_HOST`,
   `GITLAB_TOKEN`, `GITLAB_HOST` from the `Secret` table.
2. Hook it into `src/instrumentation.ts` **before** the scheduler
   so the first scheduled push pipeline already sees an
   authenticated CLI.
3. Tokens are piped on stdin to `gh auth login --with-token` and
   `glab auth login --stdin`. Argv stays free of secrets.
4. Each decrypted token is registered with the log-buffer
   redactor before invoking the CLI.
5. Missing token Secret → silent skip. Missing host Secret → fall
   back to `github.com` / `gitlab.com`. Bootstrap never throws.
6. v1 is stateless: no volume, the CLIs are re-authenticated on
   every boot.

**Consequences**:

- New operator setup step: create `GH_TOKEN` / `GITLAB_TOKEN`
  (and host overrides as needed) in `/settings/secrets`, then
  restart the container.
- The chat surface gains usable `gh` / `glab` commands without a
  new MCP server (`fs_cli__run_command` is already exposed to dev
  agents). For less-privileged future agents, a dedicated
  allow-listed MCP wrapper remains a v2 option.
- The push pipeline’s credential helper path (ADR-0014) is
  untouched. Unifying `gh auth setup-git` with the existing
  helper is intentionally deferred.
- A single host per CLI in v1. Multi-host (`github.com` +
  `github.ecritel.com` simultaneously) is a v2 deferred to first
  concrete demand.
- Container restart is required to pick up a `GH_TOKEN` rotation;
  the instrumentation hook does not hot-reload.
- New file under `src/lib/git-cli/`. No schema change. No new
  dependency.

### ADR-0016 — Skills library (2026-05-12)

**Status**: Proposed.

**Context**. KDust agents repeatedly need the same domain-specific
know-how: "how do I encrypt with Caesar cipher", "how do I run a
SEO audit on a static site", "how do I draft a Teams release
note". Today this knowledge is duplicated across Task prompts,
agent system messages, and operator notes. There is no reusable
unit, no progressive disclosure, no way to ship a capability
("here is a script that does X, here is the markdown that
explains when to use it") as a single artifact.

Anthropic's "Agent Skills" pattern (also adopted by skills.sh)
solves this with a filesystem layout: one directory per skill,
each containing a `SKILL.md` with frontmatter (`name`,
`description`) plus a body and optional `references/` and
`scripts/` sub-folders. The agent discovers skills via a tool
catalogue, drills down into the body when relevant, reads
references on demand, and executes scripts when needed.

Three implementation shapes were considered:

1. **Dust-only** — inject the catalogue + full bodies into the
   prompt; expose resources via the existing `fs` MCP server
   extended with a second read-only root; reuse `command-runner`
   for script execution. Smaller code footprint (~210 LOC), but
   dispersed across the prompt builder, `fs-tools.ts`, and
   `command-runner`; no script execution in `/chat` because
   `command-runner` is task-scoped by design; modifies a shared
   `fs` module so any regression blast-radius is large.

2. **Hybrid** — inject the catalogue, extend `fs` for resources,
   add a single MCP tool for execution. Splits the skill domain
   across two MCP kinds and one prompt hook.

3. **Dedicated `skills` MCP server** — one new server kind exposing
   four tools (`list_skills`, `read_skill`, `read_skill_resource`,
   `run_skill_script`). The skill domain lives in one module, the
   blast-radius of any change is confined, and the script
   execution path is available identically in `/chat` and in
   TaskRuns. Discovery is delegated to `list_skills` (no
   system-prompt injection), mirroring the existing `list_tasks`
   pattern in `task-runner`.

Option 3 is more code (~260 LOC) than option 1 (~210 LOC) but
follows the established "one domain = one MCP server" rule
already applied by `fs`, `task-runner`, and `command-runner`.

**Decision**:

1. Skills are filesystem artifacts under `KDust/skills/<name>/`,
   bind-mounted read-only into the container at `/app/skills`
   via `docker-compose.yml` (`./skills:/app/skills:ro`). The
   target path is a hard-coded constant `SKILLS_DIR` in
   `src/lib/skills/repo.ts` — no environment variable, the
   layout is part of the contract.
2. Each skill directory contains a `SKILL.md` with YAML
   frontmatter (`name`, `description`, both required). Optional
   `references/*.md` and `scripts/*` sub-folders are free-form;
   any executable path is fair game, no whitelist in
   frontmatter. Frontmatter is parsed by a hand-rolled minimal
   parser in `repo.ts` to avoid adding `gray-matter` as a
   dependency.
3. Skill names are constrained to `/^[a-z0-9][a-z0-9-]{1,63}$/`
   and equal the directory name. Validated in `repo.ts` and at
   the API boundary.
4. A new MCP server kind `skills` is added with scope `chat`
   (so it is attached to `/chat` sessions and to TaskRuns via
   `setup-mcp` phase, mirroring `fs` and `task-runner`). It
   exposes four tools:
   - `list_skills` (readonly) — returns `[{name, description}]`.
   - `read_skill` (readonly) — returns the body of `SKILL.md`
     stripped of its frontmatter.
   - `read_skill_resource` (readonly) — returns the contents of
     a file under the skill directory. The `path` argument is
     resolved via `realpath` and must stay inside the skill
     directory; `..`, absolute paths, and symlinks escaping the
     skill root are rejected.
   - `run_skill_script` (shell exec) — spawns a child process
     with `shell:false`, `cwd` forced to the skill directory,
     a 30 s timeout, `stdout`/`stderr` capped at 1 MB each, env
     restricted to a `PATH` passthrough plus task-resolved
     secrets (same path as `command-runner`). The agent passes
     `command: string[]` (not a free string) and an optional
     `stdin`. Output is run through the secret redactor before
     being returned. Each call is logged via `logMcpCall`.
5. **No binding model.** Skills are global. The `skills` MCP
   server is always registered — for every `/chat` session and
   every TaskRun, exactly like `fs-cli` and `task-runner`. There
   is no `TaskSkill` table, no `skillsEnabled` column, no
   per-Task allow-list. Rationale: the catalogue lives in
   `KDust/skills/` under git review, so the on-disk presence IS
   the authorization, and the sandbox controls on
   `run_skill_script` (forced `cwd`, no shell, 30s timeout,
   output cap, redact, log) provide the defense-in-depth that
   a whitelist would have added. If fine-grained scoping turns
   out to be needed, it can be added later additively.
6. **Discovery**: agents learn about skills by calling
   `list_skills`. There is no catalogue injection in the prompt,
   neither in task nor in chat mode. The tool description on
   `list_skills` is engineered to cue the agent to call it
   ("ALWAYS call list_skills near the start of a task..."). This
   matches the existing `list_tasks` pattern in `task-runner`.
7. **Filesystem mount**: `./skills:/app/skills:ro` added to
   `docker-compose.yml` (and the prod variant). The dev
   workflow is "create a folder under `KDust/skills/`,
   container picks it up at next request" — no rebuild
   required for content changes. A rebuild **is** required for
   the Dockerfile change below.
8. **Dockerfile**: `python3`, `python3-pip`, `python3-venv`
   added to the `runner` stage so skill scripts written in
   Python can run out of the box. No pip install at image build
   time; each skill is responsible for its own `scripts/.venv`
   if it needs Python deps.
9. **No UI**: skills are managed entirely on disk via git. A
   future `/skills` read-only browser page may be added; no
   Task form change is needed because there is nothing to bind.

**Consequences**:

- New filesystem dependency: the host must bind a `./skills/`
  directory next to `docker-compose.yml`. The repo ships a
  `KDust/skills/` folder with one example skill
  (`caesar-cipher`) and a README so the layout is
  self-documenting.
- New image size: `python3` + `pip` + `venv` adds ~50 MB to the
  runner stage. Rebuild required at first deploy.
- No schema change: option 3 drops the `TaskSkill` table that
  was originally planned (and prototyped on branch
  `feat/skills-library` before being reverted in the same
  branch). Zero migration footprint.
- New shell-exec surface: `run_skill_script` is a fourth
  shell-exec path in KDust (after `fs.run_command`,
  `command-runner.run_command`, and the push pipeline). It is
  the most restricted of the four (forced `cwd`, `shell:false`,
  no whitelist needed because the skill directory is the
  whitelist). Secrets are resolved through the same path as
  `command-runner` and redacted on output.
- Token cost: zero, because nothing is injected in the prompt.
  The agent pays the cost of one `list_skills` call when it
  decides to look — same trade-off as `list_tasks`.
- The Dust agent must learn to call `list_skills` and
  `read_skill` when relevant. If the agent ignores the
  catalogue, the feature is dormant — no harm done.
- No new top-level dependency. No change to
  `instrumentation.ts`. Container restart is required only
  because the Dockerfile and `docker-compose.yml` change.
- `command-runner` is unchanged. The two shell-exec servers
  coexist: `command-runner` for free-form shell in a TaskRun,
  `skills.run_skill_script` for invoking a skill's script
  with the skill directory as cwd and the skill's documented
  semantics.
