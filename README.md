# KDust

Web UI perso qui remplace `@dust-tt/dust-cli` avec en plus un scheduler de crons
qui fait éditer des projets locaux par des agents Dust et poste un rapport Teams.

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

## ADR — Telegram chat bridge (long-polling, in-process)

Status   : Accepted (Franck 2026-04-25)
Context  : L'utilisateur veut pouvoir discuter avec un agent Dust
           depuis Telegram sans exposer KDust à Internet (pas de
           webhook, pas de reverse-proxy public, pas de tunnel).
Decision : Long-polling de `api.telegram.org/getUpdates` depuis le
           process Next.js, démarré par `instrumentation.ts`. Code
           dans `src/lib/telegram/{api,bridge,poller}.ts`. La
           binding `chat_id ↔ Conversation` est persistée en base
           (`TelegramBinding`) ; chaque session Telegram est une
           Conversation KDust régulière, visible aussi dans
           `/conversation` côté web.
Consequences :
  + Aucun port entrant. Tout le trafic est sortant HTTPS.
  + Réutilisation directe de `streamAgentReply`, du Secret
    Manager, du redactor, du buffer de logs.
  + Logs unifiés dans `/logs` ; bouton on/off live dans
    `/settings/telegram`.
  - `editMessageText` est rate-limité par Telegram (~1/s par
    chat) → le streaming n'est pas token-par-token mais en
    rafales d'environ 1 update/seconde.
  - Une seule instance KDust à la fois peut long-poll un même
    bot (Telegram renvoie 409 sur deux `getUpdates` parallèles).
    Acceptable : KDust est mono-instance par design.
