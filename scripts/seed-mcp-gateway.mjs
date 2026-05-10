#!/usr/bin/env node
//
// scripts/seed-mcp-gateway.mjs
//
// One-shot seeder for the Docker MCP gateway integration
// (ADR-0012, Franck 2026-05-10). Pre-populates:
//   1. McpGatewayServer       — one row per server we know about
//   2. McpServerSecret         — binding (server, secretKey) -> Secret
//   3. ProjectMcpToolFilter    — per-project whitelist of tools
//
// Usage (inside the kdust container, where /data/kdust.db is live):
//
//   docker exec -it kdust node scripts/seed-mcp-gateway.mjs
//
// Pre-requisites:
//   * The KDust Secret rows must already exist (e.g. via
//     /settings/secrets) for any binding to resolve.
//   * The targeted Project (Project.fsPath) must already exist.
//   * docker-compose.yml `--servers=...` must list the slugs that
//     this script seeds, otherwise the gateway will not expose the
//     corresponding tools and the proxy will register zero tools.
//
// This is voluntarily idempotent (upserts on natural keys) so re-
// running after editing the SEED_DATA constant is safe.
//
// IMPORTANT: edit the SEED_DATA constant below before running. The
// defaults are illustrative — they assume:
//   * github-official enabled
//   * a Secret named "github_pat_mcp" already exists
//   * a Project at fsPath "Perso/fsallet/KDust"

import { PrismaClient } from '@prisma/client';

const SEED_DATA = {
  servers: [
    {
      slug: 'github-official',
      name: 'GitHub (official)',
      description: 'Official GitHub MCP server (read PRs/issues, code search).',
      imageRef: 'mcp/github-official',
      enabled: true,
      secrets: [
        // (catalog secret key) -> (Secret.name as stored in KDust)
        { secretKey: 'github.personal_access_token', secretName: 'github_pat_mcp' },
      ],
    },
  ],
  filters: [
    {
      projectFsPath: 'Perso/fsallet/KDust',
      serverSlug: 'github-official',
      // Whitelist a small starter set. Adjust after running
      //   curl -s http://localhost:3000/api/mcp/gateway-tools?force=1 | jq
      // to see the actual tool names exposed by the gateway.
      allowedTools: [
        'get_file_contents',
        'list_branches',
        'list_pull_requests',
        'get_pull_request',
        'search_code',
      ],
    },
  ],
};

const db = new PrismaClient();

async function upsertServer(s) {
  const row = await db.mcpGatewayServer.upsert({
    where: { slug: s.slug },
    create: {
      slug: s.slug,
      name: s.name,
      description: s.description ?? null,
      imageRef: s.imageRef ?? null,
      enabled: s.enabled,
    },
    update: {
      name: s.name,
      description: s.description ?? null,
      imageRef: s.imageRef ?? null,
      enabled: s.enabled,
    },
  });
  console.log(`[seed] server slug=${s.slug} id=${row.id} enabled=${row.enabled}`);
  for (const sec of s.secrets ?? []) {
    const exists = await db.secret.findUnique({
      where: { name: sec.secretName },
      select: { name: true },
    });
    if (!exists) {
      console.warn(
        `[seed]   MISSING Secret "${sec.secretName}" — create it via /settings/secrets first; binding skipped`,
      );
      continue;
    }
    await db.mcpServerSecret.upsert({
      where: {
        mcpServerId_secretKey: { mcpServerId: row.id, secretKey: sec.secretKey },
      },
      create: {
        mcpServerId: row.id,
        secretKey: sec.secretKey,
        secretName: sec.secretName,
      },
      update: { secretName: sec.secretName },
    });
    console.log(`[seed]   bound key=${sec.secretKey} -> Secret "${sec.secretName}"`);
  }
  return row;
}

async function upsertFilter(f, serverIdBySlug) {
  const id = serverIdBySlug.get(f.serverSlug);
  if (!id) {
    console.warn(
      `[seed] filter for project=${f.projectFsPath} -> unknown server slug "${f.serverSlug}", skipped`,
    );
    return;
  }
  await db.projectMcpToolFilter.upsert({
    where: {
      projectFsPath_mcpServerId: {
        projectFsPath: f.projectFsPath,
        mcpServerId: id,
      },
    },
    create: {
      projectFsPath: f.projectFsPath,
      mcpServerId: id,
      allowedTools: JSON.stringify(f.allowedTools ?? []),
    },
    update: {
      allowedTools: JSON.stringify(f.allowedTools ?? []),
    },
  });
  console.log(
    `[seed] filter project=${f.projectFsPath} server=${f.serverSlug} tools=${(f.allowedTools ?? []).length}`,
  );
}

async function main() {
  const serverIdBySlug = new Map();
  for (const s of SEED_DATA.servers) {
    const row = await upsertServer(s);
    serverIdBySlug.set(s.slug, row.id);
  }
  for (const f of SEED_DATA.filters) {
    await upsertFilter(f, serverIdBySlug);
  }
  console.log('[seed] done. Restart kdust (or curl /api/mcp/gateway-ensure) to pick up changes.');
}

main()
  .catch((e) => {
    console.error('[seed] failed:', e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
