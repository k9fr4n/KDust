# KDust

Web UI perso

## Documentation

- [`docs/tasks.md`](docs/tasks.md) — Task model reference: fields,
  flavours (bound vs generic), scheduling, creation, invariants.
- [`docs/push-pipeline.md`](docs/push-pipeline.md) — automation push:
  10-stage pipeline, branch policy, guard-rails, PR/MR auto-opener,
  dry-run.
- [`docs/task-runner.md`](docs/task-runner.md) — task-runner MCP server
  (`run_task`, `dispatch_task`, `wait_for_run`), prompt patterns,
  passing data between tasks, invariants, troubleshooting, ADR.

## Features

- Authentification WorkOS Device Flow (même mécanisme que le CLI, aucune config redirect URI).
- Chat persistant multi-conversations avec sélection d'agent, upload de fichiers.
- Crons : expression cron + agent + prompt + dossier projet monté + webhook Teams.
- Pipeline push automatisé : branche dédiée par run, commit/push, ouverture PR/MR, Teams report.
- Orchestration multi-tâches via MCP `run_task` / `dispatch_task` / `wait_for_run`, avec auto-inherit de la branche parent (B2) et auto-merge-back fast-forward (B3).
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
