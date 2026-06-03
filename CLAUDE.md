# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What KDust is

A single-user Next.js 15 (App Router) web UI that orchestrates [Dust](https://dust.tt)
agents. It persists multi-conversation chats, runs agents on cron schedules against
mounted project folders, and pushes the resulting changes back to git platforms
(GitHub/GitLab) via an automated PR/MR pipeline. It also bridges a Dust agent to
Telegram. Runs as a Docker container (`ghcr.io/k9fr4n/kdust:latest`); the host port
must never be exposed to the internet without a TLS reverse-proxy.

## Commands

```bash
npm run dev          # next dev (local development)
npm run build        # prisma generate + next build (see "Build gotcha" below)
npm start            # next start -p 3000 -H 0.0.0.0 (production)

npm test             # vitest run (one-shot, CI-ready)
npm run test:watch   # vitest watch mode (TUI)
npx vitest run src/lib/__tests__/git.spec.ts   # run a single spec file

npm run lint         # eslint .
npm run lint:fix     # eslint . --fix
npx tsc --noEmit     # type-check (specs are first-class TS, must pass this)

npm run db:push      # prisma db push (apply schema.prisma to SQLite)
npm run db:studio    # prisma studio
```

Pre-push gate (deterministic, run all four): `npx tsc --noEmit && npm run lint && npm test && npm run build`.

**Build gotcha:** `package.json:scripts.build` prefixes `next build` with
`env -u __NEXT_PRIVATE_STANDALONE_CONFIG -u __NEXT_PRIVATE_ORIGIN`. These vars are
injected by Next at runtime in `output: 'standalone'` mode (the prod container). If a
rebuild is launched from inside that same shell — common when the KDust agent rebuilds
itself — the standalone JSON config short-circuits `assignDefaults`, drops
`generateBuildId`, and the build crashes with `[TypeError: generate is not a function]`.
Keep the `env -u` prefix; do not call bare `next build`.

## Architecture

### Stack
- **Next.js 15 App Router** under `src/app/` — pages and `src/app/api/*/route.ts` handlers.
- **Prisma + SQLite** (`prisma/schema.prisma`, ~17 models). The DB file lives in the
  `./data` volume (`DATABASE_URL=file:/data/kdust.db`). `src/lib/db.ts` exports a
  global-singleton `PrismaClient` (one per Node process, not per request).
- **TypeScript strict**, path alias `@/* → src/*` (honoured in both runtime and tests).
- Tailwind + a small `src/components/ui` kit; `lucide-react` icons.

### Boot sequence — `src/instrumentation.ts`
Next's `register()` hook runs once on server startup (node runtime only) and wires the
whole backend: installs log capture, tunes the undici global dispatcher (ADR-0017 — wins
the keep-alive close race vs. Dust's LB to kill spurious `TypeError: terminated`), boots
the cron scheduler, and runs `gh`/`glab` + SSH credential bootstrap. Most "where does
this start?" questions resolve here.

### Cron scheduler & task runner — the core engine
- `src/lib/cron/scheduler.ts` — `reloadScheduler()` registers one `croner` Cron per
  enabled, non-`manual` Task. Called from every task CRUD endpoint and from the boot hook
  so the live job set always mirrors the DB. **Concurrency: no overlap per task, no
  queue** — a fire landing while the previous run is still active is skipped and logged
  (tracked by `activeRuns` in the runner registry). No global cap across different tasks.
- `src/lib/cron/runner.ts` — orchestrates a run as an ordered **phase pipeline**
  (ADR-0003/0006). Each phase is its own module under `src/lib/cron/runner/phases/`:
  preflight → pre-sync → branch-setup → setup-mcp → run-agent → measure-diff →
  guard-large-diff → commit-and-push → notify-success (or handle-failure). Phases take a
  `RunContext` (`runner/context.ts`) so they're unit-testable in isolation.
- A run = dedicated branch → agent does work via MCP fs tools → commit/push → open PR/MR
  → Teams report. See `docs/push-pipeline.md`.

### MCP servers — `src/lib/mcp/`
KDust hosts several in-process MCP servers and exposes them to Dust agents. `registry.ts`
holds **module-level singleton caches** (keyed per project/run) on `globalThis`, with an
idle-TTL sweeper for fs-server handles (NOT for task-runner handles — those are released
by the runner's `finally` block). Servers:
- `fs-server` / `fs-tools.ts` — filesystem tools the agent uses to read/edit project
  files (`read_file`, `edit_file`, `apply_patch`). Has a read-before-write freshness
  guard, PDF text extraction + binary guard, curly-quote normalization (ADRs 24/25/26).
  See `docs/fs-tools.md`.
- `task-runner-server.ts` — `enqueue_followup` / `list_tasks`: the **decoupled chain
  model** (ADR-0008). A task declares its successor at the end of its prompt; the
  successor runs as an independent top-level run, not nested. See `docs/task-runner.md`.
- `command-runner-server.ts` — runs allow-listed shell commands.
- `gateway-proxy.ts` — proxies to the external Docker MCP Gateway (ADR-0012/0019).
- `skills-server.ts` — exposes the skills library (ADR-0016, `docs/skills.md`).

### Dust integration — `src/lib/dust/`
`client.ts` wraps `@dust-tt/client`; `chat.ts` drives streaming conversations;
`workos.ts` + `tokens.ts` handle **WorkOS Device Flow** auth (same mechanism as the Dust
CLI — no redirect URI config). OAuth tokens are stored AES-256-GCM encrypted (`crypto.ts`,
keyed by `APP_ENCRYPTION_KEY`); only the encrypted blob hits the DB.

### Git platform — `src/lib/git-platform/`
`index.ts` is a factory returning a `GitPlatformAdapter` (github/gitlab). Auto-detects
platform + owner/repo from the git remote. Credentials come from the **Secret Manager**
(`Secret` model) — the Project row stores only the secret *name*, never the token
(ADR-0014). Returns `{ ok: false }` (push but skip PR) when there's no remote / autoOpenPR
off / platform 'none' / secret missing.

### Other subsystems
- `src/lib/secrets/` — encrypted Secret Manager + a log redactor (`redact.ts`) registered
  per-run so secret values never leak into captured logs.
- `src/lib/telegram/` — outbound long-polling bridge (`poller.ts`/`bridge.ts`); KDust is
  never exposed inbound.
- `src/lib/logs/buffer.ts` — in-memory log capture surfaced at `/logs`.
- Project addressing has 4 names but 1 canonical key (ADR-0005); folders form an unbounded
  hierarchy with project-scoped URLs (ADR-0020/0022/0023) — middleware handles
  unbounded-depth routing.

## Testing conventions (`docs/testing.md`)
- Vitest v2, `environment: 'node'`, **globals off** — `import { describe, it, expect } from 'vitest'` explicitly.
- Specs are **colocated**: `src/<area>/__tests__/<module>.spec.ts`.
- **No mocking framework** — prefer dependency injection (pass a `Date`, a getter fn) over `vi.mock()`.
- Each spec opens with a JSDoc header stating *which production invariant it protects*; canonical example `src/lib/secrets/__tests__/redact.spec.ts`.
- **In scope:** pure helpers, security boundaries (redactor/crypto), Prisma-contract narrowing, domain calculators (cron, branch policy). **Out of scope (until RunContext fully lands):** runner/push-pipeline/MCP integration tests (too many boundaries to mock).

## Conventions & docs
- The README carries a numbered **ADR log** (ADR-0002 … ADR-0026) — the authoritative
  record of *why* the architecture is shaped this way. Read the relevant ADR before
  reworking the scheduler, runner phases, task chaining, MCP wiring, or credentials. Note
  some ADR numbers are duplicated (two ADR-0010, two ADR-0017, two ADR-0022) — disambiguate
  by date/title.
- Topic docs in `docs/`: `tasks.md`, `push-pipeline.md`, `task-runner.md`, `mcp-gateway.md`,
  `fs-tools.md`, `chat.md`, `skills.md`, `git-cli-auth.md`, `ssh-identities.md`,
  `task-attachments.md`, `observability.md`, `mobile-ui.md`, `testing.md`.
- Code comments here are unusually rich and history-aware (dated, often attributed to
  Franck, cross-referencing ADRs). Match that style: when you change non-obvious behaviour,
  explain the *why* and the failure mode it guards against, not just the *what*.
- `scripts/` holds disposable diagnostic scripts (not built, not imported from `src/`). Run
  with `npx tsx scripts/<name>.ts` and an explicit `DATABASE_URL` override.

## Secrets / safety
- Required env (see `.env.example`): `APP_ENCRYPTION_KEY` (base64 32 bytes), `SESSION_SECRET`,
  `APP_PASSWORD` (app gate). Rotating `APP_ENCRYPTION_KEY` invalidates the Dust session (relogin).
- Volumes: `./data` (SQLite + encrypted tokens), `./projects` (repos the agents read/modify).
