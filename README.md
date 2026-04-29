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
