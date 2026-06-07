# syntax=docker/dockerfile:1.7

# ---- deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund

# ---- builder ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate
# Cache mount on .next/cache → reuses SWC/Webpack compilation artifacts across
# CI runs (per-platform scope provided by buildx). Cuts incremental builds by
# 1–3 min. The cache is NOT baked into the image (mount is build-time only).
RUN --mount=type=cache,target=/app/.next/cache npm run build

# ---- runner ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
# On r\u00e9utilise l'utilisateur "node" (uid/gid 1000) fourni par l'image de base,
# ce qui permet d'acc\u00e9der au socket ssh-agent de l'h\u00f4te (gnome-keyring est
# typiquement owned par uid 1000).
#
# Docker CLI (Franck 2026-04-20 23:46) \u2014 Option A (Docker-out-of-Docker).
# Installation du client Docker officiel depuis le d\u00e9p\u00f4t docker.com.
# Le daemon reste celui de l'h\u00f4te ; on monte juste /var/run/docker.sock
# dans docker-compose.yml. L'entrypoint aligne dynamiquement le GID du
# groupe `docker` dans le container sur le GID du socket (cf. entrypoint.sh).
#
# [CRITICAL] L'acc\u00e8s \u00e0 /var/run/docker.sock \u00e9quivaut \u00e0 root sur l'h\u00f4te
# (un container peut monter n'importe quel path avec --volume, charger
# --privileged, etc.). Assum\u00e9 en connaissance de cause : les agents
# Dust \u00e9crivent d\u00e9j\u00e0 du code ex\u00e9cut\u00e9 dans ce container.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates tini git openssh-client gosu curl gnupg rsync jq \
    ripgrep unzip xz-utils make \
    # poppler-utils provides `pdftotext` for fs-cli read_file PDF extraction
    # (ADR-0025). System binary, no npm dependency (like ripgrep above).
    poppler-utils \
    # python3 stack (Franck 2026-05-12, ADR-0016).
    # Provides a working Python runtime to skills whose
    # `scripts/` are written in Python. No pip install at image
    # build time; each skill is responsible for its own
    # `scripts/.venv` if it needs deps. python3-venv pulls
    # ensurepip; python3-pip lets a skill bootstrap its own venv.
    python3 python3-pip python3-venv \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
  # GitHub CLI (gh) — repo officiel cli.github.com, m\u00eame pattern que Docker CLI ci-dessus.
  # N\u00e9cessaire pour les tasks KDust qui d\u00e9clenchent des workflows GitHub Actions
  # (workflow_dispatch, run watch, run download).
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin gh \
  # Static-binary CLI tools (yq, glab, ruff, uv/uvx, code-server) are no longer
  # installed inline here: their pinned versions live in docker/tool-versions.env
  # and docker/install-tools.sh performs the curl/tarball/deb installs (ADR-0032).
  && apt-get purge -y gnupg \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -o node -g node -m 700 /home/node/.ssh \
  && printf 'Host *\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile /home/node/.ssh/known_hosts\n' > /home/node/.ssh/config \
  && touch /home/node/.ssh/known_hosts \
  && chown -R node:node /home/node/.ssh \
  && chmod 600 /home/node/.ssh/config /home/node/.ssh/known_hosts
# Pinned static-binary CLI tools (ADR-0032). Versions are the single source of
# truth in docker/tool-versions.env; install-tools.sh does the curl/tarball/deb
# installs with per-arch handling. Bumping a tool = edit tool-versions.env only.
# This COPY layer is intentionally early so a version bump rebuilds just this
# step and what follows, not the whole apt layer above.
COPY docker/tool-versions.env docker/install-tools.sh ./docker/
RUN bash ./docker/install-tools.sh
# Claude Code CLI (Franck 2026-06-03, ADR-0027; self-update model added
# 2026-06-05). Interactive use only — reached via
# `ssh host -t 'docker exec -it kdust kdust-claude'`, NOT part of the
# scheduler/runtime, never listens on a port.
#
# Self-updating install (ADR-0027 addendum): Claude Code ships several
# releases per week, so a hard npm-global pin in /usr/local (root-owned,
# not writable by `node`) means `claude /doctor` reports "npm global
# folder isn't writable / can't auto-update". Instead the RUNTIME install
# lives in /data/claude-cli — a node-owned, ./data-persisted npm prefix
# (PATH + /home/node/.npmrc point there) so the CLI's built-in updater
# (`npm i -g`) works AND survives Watchtower container recreation.
#
# The seed is baked at /opt/claude-seed and kept OFF the default PATH
# (single writable install at runtime -> no "multiple installations"
# warning). docker/entrypoint.sh copies it into /data/claude-cli on first
# boot; afterwards the runtime auto-updater owns it. We install @latest
# (NOT a pinned version) so each image build seeds the newest release —
# Franck: "il faut toujours mettre la dernière". Reproducibility is
# intentionally waived here: this is an interactive-only tool outside the
# scheduler/runtime, and the runtime auto-updater is the real freshness
# guarantee (the seed only matters for a cold start on empty ./data).
# NB: the Docker layer cache will reuse a previous seed across rebuilds
# unless busted (--no-cache); runtime auto-update makes that a non-issue.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --prefix /opt/claude-seed @anthropic-ai/claude-code@latest
# Runtime install dir on the persisted ./data bind (node-writable ->
# auto-update OK). The .npmrc scopes ONLY claude's self-update `npm i -g`
# to this prefix; it does not affect /app's local node_modules nor the
# prisma `db push` one-shot (which runs `node .../prisma/build/index.js`).
ENV CLAUDE_CLI_PREFIX=/data/claude-cli
ENV PATH="/data/claude-cli/bin:${PATH}"
RUN printf 'prefix=/data/claude-cli\n' > /home/node/.npmrc \
  && chown node:node /home/node/.npmrc
# Login shells (bash -l, e.g. the code-server / IDE terminal) source
# /etc/profile which RESETS PATH to the Debian default, dropping the
# image-level `ENV PATH` above -> `claude` becomes "command not found"
# in interactive terminals (while kdust-claude and non-login shells are
# fine). Re-inject the runtime bin via a profile.d snippet so login
# shells also resolve claude. Non-login interactive shells already
# inherit the ENV PATH, so this only matters for login shells.
RUN printf '%s\n' 'export PATH="/data/claude-cli/bin:$PATH"' \
      > /etc/profile.d/10-claude-cli.sh \
  && chmod 644 /etc/profile.d/10-claude-cli.sh
# Shell-inject secrets (Franck 2026-06-06, ADR-0031). Login shells —
# notably the code-server / IDE web terminal (bash -l) — source
# /etc/profile.d/*.sh. This snippet eval's `kdust-env` so every
# Secret flagged `shellInject` lands in the terminal env (visible via
# `env`), exactly like the container's own .env variables.
#
# Guards:
#   * interactive shells only (case "$-" in *i*) so non-interactive
#     login shells / scripts don't pay the DB hit or get surprise env;
#   * KDUST_SHELL_SECRETS=off is a runtime kill switch (no rebuild);
#   * `|| true` + stderr to /dev/null so a DB hiccup never breaks the
#     terminal. Injected NAMES are visible in the /settings/secrets UI,
#     so suppressing the launcher's stderr here keeps prompts clean.
# POSIX sh (dash) — /etc/profile sources these with sh, not bash.
RUN printf '%s\n' \
      '# ADR-0031: expose shellInject secrets in interactive (IDE) terminals.' \
      'case "$-" in' \
      '  *i*)' \
      '    if [ "${KDUST_SHELL_SECRETS:-on}" != "off" ] && [ -x /usr/local/bin/kdust-env ]; then' \
      '      eval "$(/usr/local/bin/kdust-env 2>/dev/null)" || true' \
      '    fi' \
      '    ;;' \
      'esac' \
      > /etc/profile.d/30-kdust-secrets.sh \
  && chmod 644 /etc/profile.d/30-kdust-secrets.sh
# Dev Containers CLI (Franck 2026-06-04). Lets the agent runtime / web
# terminal build & run dev containers from a devcontainer.json (`devcontainer
# up`, `devcontainer exec`) against the host Docker daemon via the same DooD
# socket already mounted here. Interactive/tooling use only — not wired into
# the scheduler. Pinned for reproducibility like claude-code/yq/glab/ruff.
# Version pinned in docker/tool-versions.env (ADR-0032), sourced here so the
# npm cache mount on this RUN is preserved.
RUN --mount=type=cache,target=/root/.npm \
    . ./docker/tool-versions.env \
    && npm install -g "@devcontainers/cli@${DEVCONTAINERS_CLI_VERSION}"
# code-server IDE (Franck 2026-06-03, ADR-0029 — supersedes the
# ADR-0028 `kdust-ide` sidecar). code-server now runs IN this container
# (launched by docker/entrypoint.sh, bound to 127.0.0.1:8080, fronted
# by the in-process auth-proxy on :8443→:4001). This deliberately gives
# the web terminal the SAME toolchain as the agent runtime — docker
# (DooD), gh, glab, kdust-claude, rg, jq, yq, ruff — which is the whole
# point (the sidecar without docker.sock was useless for real dev).
# The host-root-via-DooD surface is already accepted for THIS container
# (see the [CRITICAL] note above); putting code-server here adds no new
# risk class.
#
# Standalone tarball (bundles its own Node), pinned for reproducibility
# like yq/glab/ruff. Install is now performed by docker/install-tools.sh
# above (version in docker/tool-versions.env, ADR-0032).
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Prisma CLI (pin\u00e9e via package.json) pour que l'entrypoint puisse faire `db push`.
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
# Skills library (Franck 2026-05-19). Previously bind-mounted from
# ./skills:/app/skills:ro at runtime; now baked into the image so
# the skills catalogue is versioned with the code and ships with
# `docker compose pull` (no separate host-side sync needed).
# The runtime user has no reason to write here (read-only by
# convention; SKILLS_DIR resolves to /app/skills via src/lib/skills/repo.ts).
COPY --from=builder /app/skills ./skills
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# Claude Code launcher (ADR-0027): resolves ANTHROPIC_* from the Secret
# Manager and execs `claude`. The .mjs lives under /app so it resolves
# @prisma/client from /app/node_modules; the shim is on PATH.
COPY docker/kdust-claude.mjs /app/bin/kdust-claude.mjs
COPY docker/kdust-claude /usr/local/bin/kdust-claude
# Shell-inject launcher (ADR-0031): resolves Secret rows flagged
# `shellInject` and emits `export NAME='value'` lines. Sourced by the
# profile.d snippet below so the code-server IDE terminal gets them in
# its env. Same /app placement as kdust-claude so @prisma/client
# resolves from /app/node_modules.
COPY docker/kdust-env.mjs /app/bin/kdust-env.mjs
COPY docker/kdust-env /usr/local/bin/kdust-env
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/kdust-claude /usr/local/bin/kdust-env && mkdir -p /data /projects && chown -R node:node /app /data /projects
# L'entrypoint d\u00e9marre en root pour fixer les perms des volumes bind-mount\u00e9s,
# puis bascule sur l'utilisateur node (uid 1000) via gosu.
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]

