#!/usr/bin/env bash
set -euo pipefail

# Démarre en root pour (a) fixer les perms des volumes bind-mountés depuis l'hôte,
# (b) lancer prisma db push, puis drop les privilèges vers kdust via gosu.

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data /projects
  chown -R kdust:kdust /data /projects || true
fi

run_as_kdust() {
  if [ "$(id -u)" = "0" ]; then
    exec gosu kdust:kdust "$@"
  else
    exec "$@"
  fi
}

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] prisma db push ..."
  if [ "$(id -u)" = "0" ]; then
    gosu kdust:kdust node /app/node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma
  else
    node /app/node_modules/prisma/build/index.js db push --schema=/app/prisma/schema.prisma
  fi
fi

run_as_kdust "$@"
