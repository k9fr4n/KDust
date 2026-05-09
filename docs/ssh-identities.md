# SSH identities (self-hosted)

_KDust ADR-0011, Franck 2026-05-09._

KDust no longer needs the operator to forward `ssh-agent` or bind-
mount `~/.ssh` to push to git. Private keys can now be stored in the
KDust DB (encrypted with `APP_ENCRYPTION_KEY`, AES-256-GCM) and
materialised at boot to an in-memory tmpfs.

## How it works

```
  /settings/ssh   ----CRUD---->   SshIdentity table (encrypted)
                                          |
                                          | instrumentation hook
                                          v
  /run/kdust/ssh/                  src/lib/ssh/bootstrap.ts
    id_<name>          0600
    config             0600        <- generated ssh_config
    known_hosts        0644        <- copied from /home/node/.ssh
                                          |
                                          | exports
                                          v
  process.env.GIT_SSH_COMMAND  =  ssh -F /run/kdust/ssh/config ...
                                          |
                                          v
  src/lib/git.ts spawns git with that env
```

## Priority

For every git push KDust does, ssh tries credentials in this order
(unchanged for hosts that don't migrate):

1. `SSH_AUTH_SOCK` (host ssh-agent forwarded into the container).
2. Identities listed in the generated config (`/run/kdust/ssh/config`).
3. Legacy `/home/node/.ssh/id_*` if `SSH_AUTH_SOCK` is unset and no
   identity is configured.

This means you can migrate gradually -- both modes coexist.

## Adding a key

1. Generate one without passphrase:
   ```bash
   ssh-keygen -t ed25519 -N "" -f kdust-github -C "kdust@$(hostname)"
   ```
2. Open `/settings/ssh`, click **New identity**, paste the **private**
   key and a host pattern (`github.com`, `gitlab.ecritel.net`, `*`).
3. KDust derives the public key + fingerprint via `ssh-keygen` and
   shows them so you can copy the **public** line into the remote's
   deploy-keys page.
4. Use the **Reachability probe** at the bottom of the page to test
   `ssh -vT git@<host>`.

## Rotation

Click **Rotate** on a row, paste the new private key. The tmpfs is
rewritten immediately -- in-flight runs already have their handles
open, so they finish on the old key.

## Disabling without deleting

Click **Disable**: the row is kept, but excluded from the next
materialisation. Re-enable any time.

## Threat model

* Encrypted at rest in SQLite (`APP_ENCRYPTION_KEY`, AES-256-GCM).
* Private bytes only ever touch RAM (tmpfs `/run/kdust/ssh`,
  `mode=0700,uid=1000`). Lost on container restart, regenerated from
  the DB on boot.
* Backup: `kdust.db` + `APP_ENCRYPTION_KEY`. Lose either, you lose
  the keys. Same backup story as `Secret`.
* Never logged. The bootstrap module logs identity NAMES only.
* The HTTP API never returns ciphertext or plaintext (only metadata
  + the public key, which is public by design).
* Encrypted/passphrase-protected keys are **rejected** at create time
  -- they would either hang the unattended pipeline or require a
  passphrase the agent has no way to supply.

## Deploying

The tmpfs mount must exist:

```yaml
# docker-compose.yml (already shipped on main after this PR)
services:
  kdust:
    tmpfs:
      - /run/kdust/ssh:size=1m,mode=0700,uid=1000,gid=1000
```

A host that hasn't picked up the new compose file falls back to a
plain directory on the container's writable layer (entrypoint
creates it). Still encrypted at rest in SQLite, but you should add
the tmpfs mount ASAP -- `docker compose up -d` is enough.
