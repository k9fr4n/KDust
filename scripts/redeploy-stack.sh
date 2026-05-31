#!/usr/bin/env bash
#
# redeploy-stack.sh — refresh the KDust deployment files and restart the stack.
#
# Designed for the compose-only hosts (e.g. the Pi at ~/docker/KDust) which are
# NOT a git checkout. It re-downloads the canonical deployment files from the
# repo, refreshes the thruk-mcp child image, validates the compose file, brings
# the stack up, and force-reloads the MCP gateway so a changed catalog is
# actually picked up.
#
# Usage:
#   ./redeploy-stack.sh                 # uses defaults (ref=main)
#   KDUST_REF=feat/x ./redeploy-stack.sh
#   ./redeploy-stack.sh --no-pull       # skip thruk-mcp pull (compose still pulls kdust/gateway)
#
# Pre-requisites on the host:
#   - run it FROM the deployment dir (where .env / data / projects live)
#   - docker login ghcr.io   (read:packages scope) — kdust image is private
#
set -euo pipefail

# --------------------------------------------------------------------------- #
# Config (override via env)
# --------------------------------------------------------------------------- #
KDUST_REPO_RAW="${KDUST_REPO_RAW:-https://raw.githubusercontent.com/k9fr4n/KDust}"
KDUST_REF="${KDUST_REF:-main}"
THRUK_IMAGE="${THRUK_IMAGE:-ghcr.io/k9fr4n/thruk-mcp:latest}"

# Files to refresh (path is relative to the deployment dir == path in repo).
FILES=(
  "docker-compose.yml"
  "mcp-gateway/catalogs/kdust-custom.yaml"
)

PULL_THRUK=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL_THRUK=0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m[redeploy]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[redeploy:ERR]\033[0m %s\n' "$*" >&2; }

# --------------------------------------------------------------------------- #
# 0. Safety: must run from the deployment dir
# --------------------------------------------------------------------------- #
if [[ ! -f .env ]]; then
  err "No .env in $(pwd). Run this script FROM the deployment dir (e.g. ~/docker/KDust)."
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  err "docker not found on PATH."
  exit 1
fi
# 'docker compose' (v2) is required.
if ! docker compose version >/dev/null 2>&1; then
  err "'docker compose' (v2) not available."
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR=".redeploy-backup/${TS}"
mkdir -p "$BACKUP_DIR"

# --------------------------------------------------------------------------- #
# 1. Download deployment files (backup first, atomic replace)
# --------------------------------------------------------------------------- #
log "Refreshing deployment files from ${KDUST_REPO_RAW}/${KDUST_REF}"
for f in "${FILES[@]}"; do
  url="${KDUST_REPO_RAW}/${KDUST_REF}/${f}"
  tmp="$(mktemp)"
  log "  GET ${f}"
  if ! curl -fsSL "$url" -o "$tmp"; then
    err "download failed: $url"
    rm -f "$tmp"
    exit 1
  fi
  # Reject empty / HTML error bodies.
  if [[ ! -s "$tmp" ]]; then
    err "downloaded file is empty: $url"
    rm -f "$tmp"
    exit 1
  fi
  mkdir -p "$(dirname "$f")"
  if [[ -f "$f" ]]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    cp -p "$f" "$BACKUP_DIR/$f"
  fi
  mv "$tmp" "$f"
done
log "Backup of previous files: ${BACKUP_DIR}"

# --------------------------------------------------------------------------- #
# 2. Validate the compose file BEFORE touching the running stack
# --------------------------------------------------------------------------- #
log "Validating docker-compose.yml"
if ! docker compose config -q; then
  err "compose file invalid — restoring backups and aborting."
  for f in "${FILES[@]}"; do
    [[ -f "$BACKUP_DIR/$f" ]] && cp -p "$BACKUP_DIR/$f" "$f"
  done
  exit 1
fi

# --------------------------------------------------------------------------- #
# 3. Refresh the thruk-mcp child image (gateway does NOT auto-pull it)
# --------------------------------------------------------------------------- #
if [[ "$PULL_THRUK" -eq 1 ]]; then
  log "Pulling ${THRUK_IMAGE}"
  docker pull "$THRUK_IMAGE"
else
  log "Skipping thruk-mcp pull (--no-pull)"
fi

# --------------------------------------------------------------------------- #
# 4. Bring the stack up (kdust + gateway have pull_policy: always -> auto-pull)
# --------------------------------------------------------------------------- #
log "docker compose up -d"
docker compose up -d

# --------------------------------------------------------------------------- #
# 5. Force the gateway to reload the catalog.
#    --additional-catalog is read at process start only; 'up -d' won't recreate
#    the gateway if its image/config is unchanged -> restart to load new tools.
# --------------------------------------------------------------------------- #
log "Restarting mcp-gateway to reload the catalog"
docker compose restart mcp-gateway

# --------------------------------------------------------------------------- #
# 6. Status
# --------------------------------------------------------------------------- #
log "Stack status:"
docker compose ps
log "Done. The gateway respawns the thruk-mcp child on the next tool call."
log "Verify tools in /settings/mcp (expect 57 thruk_* tools for v1.8.0)."
