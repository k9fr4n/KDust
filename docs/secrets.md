# Secret Manager — threat model & usage

KDust stores credentials encrypted at rest and injects them into
running processes server-side. This doc is the authoritative threat
model referenced by `prisma/schema.prisma` (`model Secret`) and the
ADRs (ADR-0014, ADR-0027, ADR-0031).

## Storage

- `model Secret` — global, scoped-to-KDust rows. `valueEnc` is
  **AES-256-GCM** ciphertext (`ivB64.tagB64.encB64` envelope) keyed by
  `APP_ENCRYPTION_KEY` (base64 → 32 bytes), the same KDF/envelope as
  `DustSession.refreshTokenEnc`. A DB dump alone is useless without the
  env var.
- The crypto lives in `src/lib/crypto.ts`. Two stdlib-only copies exist
  for out-of-process launchers and **must stay byte-compatible**:
  `docker/kdust-claude.mjs` (ADR-0027) and `docker/kdust-env.mjs`
  (ADR-0031).

## Design rules

1. **No LLM-accessible path returns plaintext.** Listing APIs return
   metadata only (no `value` field). Plaintext is decrypted server-side
   immediately before `exec()`.
2. **No versioning / rotation flow.** Updates are in-place; a run in
   flight keeps its already-resolved env.
3. **Plaintext never appears** in logs, in stdout relayed to the LLM,
   or in audit rows. The `command-runner` builds a redactor from the
   resolved values and scrubs stdout/stderr/errorMessage before
   persistence or LLM return (`src/lib/secrets/redact.ts`).

## Injection paths

| Path | Trigger | Scope | Plaintext reaches |
|------|---------|-------|-------------------|
| **TaskSecret** (ADR-0014) | a task's `command-runner` `run_command` | per-task `(envName→secretName)` binding | the spawned child process; redacted from all LLM-visible output |
| **kdust-claude** (ADR-0027) | `docker exec -it kdust kdust-claude` | fixed `ANTHROPIC_*` names | the `claude` process env |
| **shellInject** (ADR-0031) | interactive IDE terminal (`bash -l` → `/etc/profile.d/30-kdust-secrets.sh` → `kdust-env`) | every secret with `shellInject=true`, env var name = `Secret.name` | the operator's terminal env (visible via `env`) and every child it spawns |

## ADR-0031 — `shellInject` deviation (2026-06-06)

The `shellInject` switch **deliberately deviates** from rules 1–3 above
for one narrow, human-operated context:

- It exposes plaintext in the **interactive code-server IDE terminal**,
  which is gated end-to-end by the `kdust_session` JWT on the IDE proxy
  (`src/lib/ide/proxy.ts`). The trust context is therefore the
  authenticated operator, not an autonomous agent.
- It is **opt-in per secret** (`false` by default). The per-secret
  toggle is the blast-radius control.
- The secret becomes **ambient** in that terminal's env and is inherited
  by every child process — including an interactive `claude` the
  operator launches. This is the accepted cost of the feature.
- It is **never** consumed by any LLM-orchestrated TaskRun path
  (scheduler, push pipeline, MCP servers). Those keep using the
  per-task `TaskSecret` binding exclusively.
- No redactor applies on this path (it is not LLM-facing); plaintext
  lands in terminal scrollback via `env` — by design.

### Operating the switch

1. Create a secret whose `name` is a valid POSIX identifier (no `-`;
   uppercase idiomatic, e.g. `GITLAB_TOKEN`). Non-POSIX names are
   **skipped** by `kdust-env` and flagged in the UI.
2. Toggle **Shell: on** on `/settings/secrets` (or
   `PUT /api/secrets/:name {"shellInject": true}`).
3. Open a fresh IDE terminal; `env | grep NAME` shows it. Rotation is
   picked up by newly opened terminals.

### Kill switches

- `KDUST_SHELL_SECRETS=off` — runtime, disables the profile.d auto-eval
  without a rebuild.
- `IDE_ENABLED=false` — disables the whole IDE.

Manual one-shots remain available regardless:

```sh
eval "$(kdust-env)"        # load shellInject secrets into this shell
kdust-env -- mytool --flag # run a command with them overlaid, no leak to the shell
```
