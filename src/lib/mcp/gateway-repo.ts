// src/lib/mcp/gateway-repo.ts
//
// Repository helpers for the Docker MCP gateway DB tables
// (McpGatewayServer, McpServerSecret, ProjectMcpToolFilter).
// Powers the /settings/mcp UI introduced 2026-05-10 to replace
// the seeder script of the V1 release.
//
// All exports are framework-agnostic (no Next types) and return
// plain DTOs that are safe to send over the wire — no encrypted
// values, no Prisma Decimal, no Date objects (ISO strings).

import { db } from '../db';
import { normalizeProjectFsPath } from './gateway-path-match';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SECRET_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/;
// Literal paths (e.g. "Perso/fsallet/KDust") AND glob patterns
// (Franck 2026-05-27). Allowed glob chars: `*`, `?`. See
// ./gateway-path-match.ts for the matching semantics.
const PROJECT_FS_PATH_RE = /^[A-Za-z0-9._/*?-]{1,256}$/;

export { normalizeProjectFsPath, pathMatchesPattern, isPatternFsPath } from './gateway-path-match';

export function validateServerSlug(slug: string): string | null {
  if (!SLUG_RE.test(slug)) {
    return 'Slug must match /^[a-z0-9][a-z0-9-]{0,62}$/. Lowercase letters, digits, dashes; starts with [a-z0-9].';
  }
  return null;
}
export function validateSecretKey(k: string): string | null {
  if (!SECRET_KEY_RE.test(k)) {
    return 'Secret key must match /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/. The Docker MCP catalog typically uses a dotted form like "github.personal_access_token".';
  }
  return null;
}
export function validateProjectFsPath(p: string): string | null {
  if (!PROJECT_FS_PATH_RE.test(p)) {
    return 'Invalid projectFsPath. Allowed: A-Z a-z 0-9 . _ - / and glob meta * ? (use `**` for recursive match).';
  }
  return null;
}

export interface ServerDto {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  imageRef: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  bindings: Array<{
    id: number;
    secretKey: string;
    secretName: string;
    secretExists: boolean;
  }>;
}

export async function listServers(): Promise<ServerDto[]> {
  const rows = await db.mcpGatewayServer.findMany({
    orderBy: { slug: 'asc' },
    include: { secrets: { include: { secret: { select: { name: true } } } } },
  });
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    imageRef: r.imageRef,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    bindings: r.secrets.map((b) => ({
      id: b.id,
      secretKey: b.secretKey,
      secretName: b.secretName,
      secretExists: !!b.secret,
    })),
  }));
}

export async function createServer(input: {
  slug: string;
  name: string;
  description?: string | null;
  imageRef?: string | null;
  enabled?: boolean;
}) {
  const err = validateServerSlug(input.slug);
  if (err) throw new Error(err);
  return db.mcpGatewayServer.create({
    data: {
      slug: input.slug,
      name: input.name.trim() || input.slug,
      description: input.description ?? null,
      imageRef: input.imageRef ?? null,
      enabled: input.enabled ?? true,
    },
  });
}

export async function updateServer(
  id: number,
  patch: Partial<{
    name: string;
    description: string | null;
    imageRef: string | null;
    enabled: boolean;
  }>,
) {
  return db.mcpGatewayServer.update({ where: { id }, data: patch });
}

export async function deleteServer(id: number) {
  // Cascade clears McpServerSecret + ProjectMcpToolFilter (FK rules
  // declared in schema.prisma).
  return db.mcpGatewayServer.delete({ where: { id } });
}

export async function addSecretBinding(input: {
  mcpServerId: number;
  secretKey: string;
  secretName: string;
}) {
  const err = validateSecretKey(input.secretKey);
  if (err) throw new Error(err);
  // We do NOT verify the Secret exists here — the FK Restrict
  // semantics will reject it at insert time if needed.
  return db.mcpServerSecret.create({
    data: {
      mcpServerId: input.mcpServerId,
      secretKey: input.secretKey,
      secretName: input.secretName,
    },
  });
}

export async function deleteSecretBinding(id: number) {
  return db.mcpServerSecret.delete({ where: { id } });
}

export interface FilterDto {
  id: number;
  projectFsPath: string;
  mcpServerId: number;
  serverSlug: string;
  allowedTools: string[];
  updatedAt: string;
}

export async function listFilters(projectFsPath?: string): Promise<FilterDto[]> {
  const rows = await db.projectMcpToolFilter.findMany({
    where: projectFsPath ? { projectFsPath } : undefined,
    include: { server: true },
    orderBy: [{ projectFsPath: 'asc' }, { mcpServerId: 'asc' }],
  });
  return rows.map((r) => {
    let allowed: string[] = [];
    try {
      const parsed = JSON.parse(r.allowedTools || '[]');
      if (Array.isArray(parsed)) allowed = parsed.filter((x) => typeof x === 'string');
    } catch {
      /* malformed = empty */
    }
    return {
      id: r.id,
      projectFsPath: r.projectFsPath,
      mcpServerId: r.mcpServerId,
      serverSlug: r.server.slug,
      allowedTools: allowed,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

/**
 * Upsert a (projectFsPath, mcpServerId) filter row. `allowedTools`
 * fully replaces the previous list. Pass [] to keep the row
 * present but empty (= still default-deny, just explicitly).
 * Use deleteFilter(id) to remove the row entirely.
 */
export async function upsertFilter(input: {
  projectFsPath: string;
  mcpServerId: number;
  allowedTools: string[];
}) {
  const projectFsPath = normalizeProjectFsPath(input.projectFsPath);
  const err = validateProjectFsPath(projectFsPath);
  if (err) throw new Error(err);
  return db.projectMcpToolFilter.upsert({
    where: {
      projectFsPath_mcpServerId: {
        projectFsPath,
        mcpServerId: input.mcpServerId,
      },
    },
    create: {
      projectFsPath,
      mcpServerId: input.mcpServerId,
      allowedTools: JSON.stringify(input.allowedTools),
    },
    update: { allowedTools: JSON.stringify(input.allowedTools) },
  });
}

export async function deleteFilter(id: number) {
  return db.projectMcpToolFilter.delete({ where: { id } });
}
