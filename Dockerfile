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
RUN npm run build

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
    openssl ca-certificates tini git openssh-client gosu curl gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin \
  && apt-get purge -y curl gnupg \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -o node -g node -m 700 /home/node/.ssh \
  && printf 'Host *\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile /home/node/.ssh/known_hosts\n' > /home/node/.ssh/config \
  && touch /home/node/.ssh/known_hosts \
  && chown -R node:node /home/node/.ssh \
  && chmod 600 /home/node/.ssh/config /home/node/.ssh/known_hosts
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
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /data /projects && chown -R node:node /app /data /projects
# L'entrypoint d\u00e9marre en root pour fixer les perms des volumes bind-mount\u00e9s,
# puis bascule sur l'utilisateur node (uid 1000) via gosu.
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
