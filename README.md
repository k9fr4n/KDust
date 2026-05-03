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
