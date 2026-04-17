#!/usr/bin/env bash
set -euo pipefail

# Le container tourne en uid 1000 (user 'node') pour matcher l'uid hôte
# et permettre l'accès au socket ssh-agent / gnome-keyring.

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data /projects
  chown -R node:node /data /projects || true

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
  if [ "$(id -u)" = "0" ]; then
    gosu node:node node /app/node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma
  else
    node /app/node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma
  fi
fi

if [ "$(id -u)" = "0" ]; then
  exec gosu node:node "$@"
else
  exec "$@"
fi
