#!/usr/bin/env bash
set -euo pipefail

# Le container tourne en uid 1000 (user 'node') pour matcher l'uid hôte
# et permettre l'accès au socket ssh-agent / gnome-keyring.

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data /projects
  chown -R node:node /data /projects || true

  # Self-hosted SSH runtime dir (Franck 2026-05-09, ADR-0011).
  # When docker-compose.yml mounts a tmpfs at /run/kdust/ssh with
  # uid=1000 the directory already exists with the right perms and
  # this is a no-op. On hosts that haven't updated their compose
  # file yet we fall back to a plain dir on the container fs so the
  # bootstrap doesn't soft-fail with EACCES on mkdir under /run.
  # NB: in the fallback case keys land on the container's writable
  # layer instead of memory -- still encrypted at rest in SQLite,
  # but operators should add the tmpfs mount ASAP.
  mkdir -p /run/kdust/ssh
  chown node:node /run/kdust /run/kdust/ssh 2>/dev/null || true
  chmod 700 /run/kdust/ssh || true

  # --- Docker socket GID remap (Franck 2026-04-20 23:46) ---
  # Option A / DooD: /var/run/docker.sock is bind-mounted from the host,
  # owned by the host's `docker` group. That GID is host-specific
  # (999/998/1001 depending on distro) so we discover it at runtime
  # rather than hard-coding it in the image.
  #
  # Strategy:
  #   1. Read the socket's GID via `stat`.
  #   2. Ensure a group with that GID exists in the container (create
  #      a `docker` group if needed, or rename an existing group that
  #      already owns the GID).
  #   3. Add the `node` user to it so the process can connect to the
  #      socket without root/SUID tricks.
  #   4. If the socket is missing (docker feature disabled locally),
  #      skip silently \u2014 docker calls from the agent will just fail
  #      with a clear "Cannot connect to the Docker daemon" message.
  if [ -S /var/run/docker.sock ]; then
    DOCKER_SOCK_GID="$(stat -c %g /var/run/docker.sock 2>/dev/null || echo '')"
    if [ -n "$DOCKER_SOCK_GID" ] && [ "$DOCKER_SOCK_GID" != "0" ]; then
      EXISTING_GROUP="$(getent group "$DOCKER_SOCK_GID" | cut -d: -f1 || true)"
      if [ -z "$EXISTING_GROUP" ]; then
        # No group with this GID yet \u2014 create one named `docker`.
        # If a `docker` group already exists with a DIFFERENT GID,
        # delete-and-recreate so the name stays predictable.
        if getent group docker >/dev/null 2>&1; then
          groupdel docker || true
        fi
        groupadd -g "$DOCKER_SOCK_GID" docker
        EXISTING_GROUP=docker
      fi
      usermod -aG "$EXISTING_GROUP" node || true
      echo "[entrypoint] docker.sock detected (gid=$DOCKER_SOCK_GID, group=$EXISTING_GROUP), user 'node' granted access"
    else
      echo "[entrypoint] docker.sock present but gid lookup failed, skipping remap"
    fi
  else
    echo "[entrypoint] no /var/run/docker.sock mounted, docker CLI will not work (by design if feature unused)"
  fi

  if [ -d /host-ssh ]; then
    echo "[entrypoint] bootstrapping SSH from /host-ssh"
    ls -la /host-ssh || true
    mkdir -p /home/node/.ssh
    cp -rL /host-ssh/. /home/node/.ssh/ 2>/dev/null || true
    chown -R node:node /home/node/.ssh
    chmod 700 /home/node/.ssh
    find /home/node/.ssh -type f -exec chmod 600 {} +
    find /home/node/.ssh -name '*.pub' -exec chmod 644 {} + 2>/dev/null || true
    [ -f /home/node/.ssh/known_hosts ] && chmod 644 /home/node/.ssh/known_hosts || true
    echo "[entrypoint] /home/node/.ssh contents:"
    ls -la /home/node/.ssh
  fi

  # --- Claude Code state persistence (Franck 2026-06-04) ---
  # ~/.claude.json (config / onboarding / project trust / MCP config) and
  # ~/.claude/ (sessions, history.jsonl, projects/, settings.json, plugins)
  # are MUTABLE RUNTIME STATE. /home/node is NOT persisted, so without this
  # block they reset on every container recreate — and Watchtower pulls a
  # new image every 5 min, so that is the common case, not the exception.
  #
  # We relocate the whole Claude config onto the already-persisted /data
  # bind (./data on the host), mirroring /data/ide:
  #   - CLAUDE_CONFIG_DIR=/data/claude (set in compose) moves ~/.claude
  #   - symlink ~/.claude       -> /data/claude            (belt: any tool
  #     ignoring the env var still lands on the persisted dir)
  #   - symlink ~/.claude.json  -> /data/claude/.claude.json (some versions
  #     keep the JSON in $HOME regardless of CLAUDE_CONFIG_DIR)
  # First-boot seed: if a real (non-symlink) file/dir already exists in
  # $HOME, migrate it once before symlinking so we don't drop state.
  # node-owned, 0700 (no credentials today — auth goes through the
  # shared dust-exporter — but treated as sensitive on principle).
  CLAUDE_PERSIST_DIR=/data/claude
  install -d -o node -g node -m 700 "$CLAUDE_PERSIST_DIR"
  if [ -e /home/node/.claude ] && [ ! -L /home/node/.claude ]; then
    cp -a /home/node/.claude/. "$CLAUDE_PERSIST_DIR"/ 2>/dev/null || true
    rm -rf /home/node/.claude
  fi
  ln -sfn "$CLAUDE_PERSIST_DIR" /home/node/.claude
  if [ -e /home/node/.claude.json ] && [ ! -L /home/node/.claude.json ]; then
    if [ ! -e "$CLAUDE_PERSIST_DIR/.claude.json" ]; then
      mv /home/node/.claude.json "$CLAUDE_PERSIST_DIR/.claude.json"
    else
      rm -f /home/node/.claude.json
    fi
  fi
  ln -sfn "$CLAUDE_PERSIST_DIR/.claude.json" /home/node/.claude.json
  chown -R node:node "$CLAUDE_PERSIST_DIR"
  chown -h node:node /home/node/.claude /home/node/.claude.json 2>/dev/null || true
  echo "[entrypoint] Claude Code state persisted to $CLAUDE_PERSIST_DIR (CLAUDE_CONFIG_DIR + symlinks)"

  # --- Claude Code CLI: writable, persisted, self-updating install ---
  # (Franck 2026-06-05, ADR-0027 addendum). The image bakes a seed at
  # /opt/claude-seed but keeps it OFF the default PATH. The supported
  # RUNTIME install lives in /data/claude-cli (node-owned, on the
  # persisted ./data bind), which:
  #   * is first on PATH (Dockerfile ENV) -> the only `claude` resolved,
  #   * is writable by `node` -> Claude Code's built-in auto-updater
  #     (`npm i -g`, prefix pinned via /home/node/.npmrc) works,
  #   * survives Watchtower container recreation (./data is persisted).
  # We seed it ONCE by copying the baked version; later boots keep
  # whatever the auto-updater landed. To force a re-seed to the image's
  # baseline, `rm -rf ./data/claude-cli` on the host and restart.
  # cp -a preserves npm's relative bin symlink (bin/claude -> ../lib/...).
  CLAUDE_CLI_DIR="${CLAUDE_CLI_PREFIX:-/data/claude-cli}"
  install -d -o node -g node -m 755 "$CLAUDE_CLI_DIR"
  if [ ! -x "$CLAUDE_CLI_DIR/bin/claude" ] && [ -x /opt/claude-seed/bin/claude ]; then
    echo "[entrypoint] seeding Claude Code CLI into $CLAUDE_CLI_DIR from /opt/claude-seed"
    cp -a /opt/claude-seed/. "$CLAUDE_CLI_DIR"/ 2>/dev/null || true
    chown -R node:node "$CLAUDE_CLI_DIR"
  else
    echo "[entrypoint] Claude Code CLI present in $CLAUDE_CLI_DIR (or no seed), skipping seed"
  fi

  if [ -n "${SSH_AUTH_SOCK:-}" ]; then
    if [ -S "${SSH_AUTH_SOCK}" ]; then
      echo "[entrypoint] SSH_AUTH_SOCK=$SSH_AUTH_SOCK détecté"
    else
      echo "[entrypoint] SSH_AUTH_SOCK=$SSH_AUTH_SOCK introuvable, unset"
      unset SSH_AUTH_SOCK
    fi
  fi
fi

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] prisma db push ..."
  # --accept-data-loss (Franck 2026-04-22): schema evolutions on this
  # single-user app routinely drop tables/columns when features are
  # retired (e.g. audit subsystem nuke 2026-04-22 drops ProjectAdvice,
  # AdviceCategoryDefault and CronJob.kind/category). Without the
  # flag `db push` stops the container with exit 1 on any
  # potentially-lossy migration and kdust boot-loops. Since this app
  # is mono-user and the schema is source-of-truth, we opt-in
  # unconditionally. Operators who want to inspect before losing data
  # should do so on a staging clone before deploying the new image.
  if [ "$(id -u)" = "0" ]; then
    # See note on gosu user-vs-user:group below. Using bare `node` here
    # so the Prisma one-shot runs with the same groups as the main
    # process; no practical impact for db push, but keeps behaviour
    # symmetrical and avoids surprises if the CLI ever shells out.
    gosu node node /app/node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma --accept-data-loss
  else
    node /app/node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma --accept-data-loss
  fi
fi

# --- code-server IDE (Franck 2026-06-03, ADR-0029) ---
# code-server now runs IN this container (supersedes the ADR-0028
# `kdust-ide` sidecar) so the web terminal inherits the full agent
# toolchain (docker/DooD, gh, glab, kdust-claude, rg, jq, yq, ruff).
# It binds to loopback only (127.0.0.1:8080); the in-process auth-proxy
# (src/lib/ide/proxy.ts, IDE_PROXY_PORT 8443 -> published 4001) is the
# only reachable entry point and gates every request on the
# kdust_session JWT. Backgrounded here so it survives independently of
# Next; on `exec` it reparents to tini (PID 1), which reaps it.
#
# We launch it as `node` (uid 1000) so its terminals inherit node's
# supplementary groups (incl. `docker`, granted above via usermod +
# gosu initgroups) and match /projects ownership. Persistence lives on
# the existing /data volume (no extra named volume needed). Kill switch:
# IDE_ENABLED=false. Best-effort: a code-server failure must never block
# the KDust runtime, hence the trailing `|| true`-friendly background.
if [ "${IDE_ENABLED:-true}" != "false" ] && command -v code-server >/dev/null 2>&1; then
  echo "[entrypoint] starting in-container code-server (127.0.0.1:8080, workspace /projects)"
  # [IMPORTANT] code-server gives the `PORT` (and `HOST`) env vars
  # PRECEDENCE over both --bind-addr and config.yaml. The kdust
  # container exports PORT=3000 for the Next.js standalone server, so
  # an un-scrubbed code-server inherits PORT=3000, ignores
  # --bind-addr 127.0.0.1:8080, tries to bind :3000 and dies with
  # EADDRINUSE (Next is already there) -> the IDE proxy then returns
  # "IDE upstream unavailable". We strip PORT/HOST with `env -u` so the
  # explicit --bind-addr is honored (Franck 2026-06-03, ADR-0029 fix).
  if [ "$(id -u)" = "0" ]; then
    install -d -o node -g node -m 700 /data/ide /data/ide/user-data /data/ide/extensions 2>/dev/null || true
    gosu node env -u PORT -u HOST HOME=/home/node code-server \
      --auth none \
      --bind-addr 127.0.0.1:8080 \
      --disable-telemetry \
      --disable-update-check \
      --user-data-dir /data/ide/user-data \
      --extensions-dir /data/ide/extensions \
      /projects &
  else
    mkdir -p /data/ide/user-data /data/ide/extensions 2>/dev/null || true
    env -u PORT -u HOST HOME=/home/node code-server \
      --auth none \
      --bind-addr 127.0.0.1:8080 \
      --disable-telemetry \
      --disable-update-check \
      --user-data-dir /data/ide/user-data \
      --extensions-dir /data/ide/extensions \
      /projects &
  fi
elif [ "${IDE_ENABLED:-true}" != "false" ]; then
  echo "[entrypoint] IDE_ENABLED!=false but code-server binary not found, skipping IDE launch"
fi

# gosu(1) gotcha (Franck 2026-04-21 00:10) \u2014 IMPORTANT:
# `gosu node:node CMD` specifies BOTH user and primary group explicitly.
# In that mode gosu drops **all supplementary groups** and sets groups
# to just the specified primary group. This silently broke Docker-from-
# agent access because the `docker` group (added to `node` via
# usermod above) was not inherited by the long-running node.js process
# \u2014 even though /etc/group was correctly updated (an `id` from a new
# `docker exec` showed the group, but the already-running PID 1 did not
# pick it up).
#
# `gosu node CMD` (user only, no group) tells gosu to call initgroups(3),
# which reads /etc/group fresh and populates supplementary groups with
# every group `node` is a member of. This is what we want.
if [ "$(id -u)" = "0" ]; then
  exec gosu node "$@"
else
  exec "$@"
fi
