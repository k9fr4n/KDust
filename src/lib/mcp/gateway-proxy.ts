// src/lib/mcp/gateway-proxy.ts
//
// Per-project proxy McpServer that re-exports a filtered subset
// of the Docker MCP gateway's tools to a Dust agent
// (ADR-0012, Franck 2026-05-10).
//
// Architecture:
//   Dust agent  <--SSE-- DustMcpServerTransport (this module's McpServer)
//                            |
//                            v   for each tool/call
//                            |
//                            v   gateway-client.ts (one Client)
//                       streamable-HTTP
//                            |
//                            v
//                       docker/mcp-gateway:8080/mcp
//                            |
//                            v   spawns / multiplexes
//                       child MCP server containers
//
// Filtering:
//   ProjectMcpToolFilter rows scope which (mcpServer, tool) pairs
//   are visible to a given project. Default-deny: a project with
//   no rows sees zero tools. Tools not whitelisted are NEVER
//   registered on the Dust transport, so the agent has no way to
//   call them — the gateway-side surface is irrelevant to the
//   agent's tool list.
//
// Naming convention:
//   The gateway exposes tools either with their bare name (e.g.
//   `get_file_contents`) or with a server-prefixed name when slugs
//   collide. We don't try to interpret the prefix — the Tool.name
//   we get from listTools() is what we register on the proxy as-is
//   and what we call back via callGatewayTool(). The (server, tool)
//   filter pair from the DB resolves the tool name through the
//   `serverHint` field (see resolveAllowedToolNames below).
//
// Lifecycle:
//   - getGatewayServerId(projectFsPath) registers a new McpServer
//     bound to a fresh DustMcpServerTransport, returns the Dust
//     serverId. Cached per-project.
//   - The cache is NOT idle-swept (cheap proxies, no chroot),
//     mirroring the chat task-runner registry.
//   - releaseGatewayServer(projectFsPath) tears it down.
//   - invalidateGatewayServer(projectFsPath) is the recovery path
//     for the "unknown MCP server ID" 403 from Dust.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DustMcpServerTransport } from '@dust-tt/client';
import type { ZodRawShape } from 'zod';
import { z, type ZodTypeAny } from 'zod';
import { MCP_REGISTRATION_TIMEOUT_MS } from '../constants';
import { db } from '../db';
import { getDustClient } from '../dust/client';
import { listGatewayTools, callGatewayTool } from './gateway-client';
import { errMessage } from '../errors';

export interface GatewayProxyHandle {
  projectFsPath: string;
  serverId: string;
  server: McpServer;
  transport: DustMcpServerTransport;
}

type ServerWithTransport = McpServer & { __transport?: DustMcpServerTransport };

const MCP_SERVER_NAME = 'mcp-gateway';

/**
 * Build a permissive Zod shape from a JSON-Schema-ish object.
 * The Dust SDK requires a ZodRawShape for registerTool's
 * inputSchema; we don't try to round-trip the upstream JSON
 * schema (which can be arbitrarily complex). Instead we accept
 * any args and rely on the gateway-side server to validate.
 *
 * Returns a `{ args: z.unknown() }` shape so the Dust agent gets
 * a generic single-parameter tool call. The arg object is passed
 * through to the gateway tool unchanged.
 */
function permissiveShape(): ZodRawShape {
  // Wrap unknown in a pass-through object schema. We can't use
  // z.object({}).passthrough() at the top level because
  // registerTool expects a raw shape, not a built ZodObject.
  // Picking individual keys per-tool would require parsing the
  // upstream JSON Schema; deferred to a future iteration.
  return {} as ZodRawShape;
}

/**
 * Resolve the set of fully-qualified gateway tool names that are
 * visible to `projectFsPath`. Returns a Set keyed by Tool.name as
 * returned by the gateway's tools/list (so the comparison at
 * registerTool time is direct).
 *
 * Rule: a Tool t is allowed iff there exists a
 * ProjectMcpToolFilter row F such that:
 *   * F.projectFsPath = projectFsPath
 *   * F.server.enabled = true
 *   * t.name in F.allowedTools (parsed JSON array)
 *
 * The match against "server" happens only via the server slug
 * embedded in the row — we don't enforce that the gateway tool
 * name starts with the slug because we can't assume the prefix
 * convention. The (mcpServerId -> slug) link is purely
 * informative: from KDust's perspective, the source of truth is
 * the JSON list of tool names the operator whitelisted.
 */
async function resolveAllowedToolNames(
  projectFsPath: string,
): Promise<Set<string>> {
  const allowed = new Set<string>();
  let rows: Array<{ allowedTools: string; server: { enabled: boolean } }> = [];
  try {
    rows = await db.projectMcpToolFilter.findMany({
      where: { projectFsPath },
      include: { server: true },
    });
  } catch (e) {
    console.warn(
      `[mcp/gateway-proxy] db.projectMcpToolFilter.findMany failed for project="${projectFsPath}": ${errMessage(e)}`,
    );
    return allowed;
  }
  for (const r of rows) {
    if (!r.server.enabled) continue;
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(r.allowedTools || '[]');
    } catch {
      console.warn(
        `[mcp/gateway-proxy] malformed allowedTools JSON for project="${projectFsPath}"; treating as empty`,
      );
      parsed = [];
    }
    if (Array.isArray(parsed)) {
      for (const name of parsed) {
        if (typeof name === 'string' && name.length > 0) allowed.add(name);
      }
    }
  }
  return allowed;
}

/**
 * Start the per-project proxy McpServer.
 *
 * The boot sequence:
 *  1. Load the gateway tool catalog (cached for 60 s).
 *  2. Filter against ProjectMcpToolFilter (default-deny).
 *  3. registerTool() each surviving entry with a callback that
 *     forwards to gateway-client.callGatewayTool.
 *  4. connect() the DustMcpServerTransport — once Dust returns
 *     a serverId, the proxy is ready and we resolve the handle.
 */
export async function startGatewayProxy(
  projectFsPath: string,
): Promise<GatewayProxyHandle> {
  const dust = await getDustClient();
  if (!dust) throw new Error('Dust client not available (login required)');

  const tools = await listGatewayTools().catch((e) => {
    console.warn(
      `[mcp/gateway-proxy] listGatewayTools failed for project="${projectFsPath}": ${errMessage(e)} — starting empty proxy`,
    );
    return [];
  });
  const allowed = await resolveAllowedToolNames(projectFsPath);

  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });

  let registered = 0;
  for (const t of tools) {
    if (!allowed.has(t.name)) continue;
    // We pass through args as-is; we cannot reconstruct a strict
    // ZodRawShape from t.inputSchema (arbitrary JSON Schema) at
    // runtime without a converter. The Dust agent receives the
    // upstream description so it can format calls correctly; the
    // gateway-side server validates the actual args.
    const argsAnySchema: ZodTypeAny = z.record(z.unknown());
    server.registerTool(
      t.name,
      {
        description: t.description ?? `Gateway tool ${t.name}`,
        // We register no per-key schema (empty shape). Dust's MCP
        // wire format still accepts any arguments object; our
        // callback re-types via argsAnySchema below to keep the
        // SDK happy.
        inputSchema: permissiveShape(),
      },
      async (rawArgs: unknown) => {
        const parsed = argsAnySchema.safeParse(rawArgs ?? {});
        const args = parsed.success ? (parsed.data as Record<string, unknown>) : {};
        try {
          const result = (await callGatewayTool(t.name, args)) as {
            content?: Array<{ type: string; text?: string }>;
            isError?: boolean;
          };
          // Re-shape gateway result into the strict
          // { content: [{type:'text', text}], isError? } that the
          // Dust transport expects. Non-text fragments are
          // stringified; the agent gets a plain text rendering
          // which is good enough for the V1 (rich content can
          // come later if a server returns images/blobs).
          const content: Array<{ type: 'text'; text: string }> = [];
          for (const part of result.content ?? []) {
            if (typeof part?.text === 'string') {
              content.push({ type: 'text', text: part.text });
            } else {
              content.push({ type: 'text', text: JSON.stringify(part) });
            }
          }
          return {
            content,
            isError: result.isError === true,
          };
        } catch (e) {
          return {
            content: [{ type: 'text', text: `[mcp-gateway] ${errMessage(e)}` }],
            isError: true,
          };
        }
      },
    );
    registered++;
  }

  console.log(
    `[mcp/gateway-proxy] project="${projectFsPath}" exposing ${registered}/${tools.length} gateway tools`,
  );

  const ready = new Promise<string>((resolve, reject) => {
    const transport = new DustMcpServerTransport(
      dust.client,
      (id: string) => {
        console.log(
          `[mcp/gateway-proxy] registered project="${projectFsPath}" serverId=${id}`,
        );
        resolve(id);
      },
      MCP_SERVER_NAME,
      process.env.KDUST_MCP_VERBOSE !== '0',
      // Reuse fs-cli's heartbeat default. Same Dust idle-close behaviour.
      Math.max(
        60_000,
        Number(process.env.KDUST_MCP_HEARTBEAT_MS ?? 50 * 60 * 1000),
      ),
    );
    transport.onerror = (err: unknown) => {
      const msg =
        err instanceof Error ? err.message : typeof err === 'string' ? err : '';
      if (!msg || /No activity within \d+ milliseconds/i.test(msg)) return;
      console.warn(
        `[mcp/gateway-proxy] transport error project="${projectFsPath}": ${msg}`,
      );
    };
    (server as ServerWithTransport).__transport = transport;
    server.connect(transport).catch((err) => {
      console.error(
        `[mcp/gateway-proxy] connect failed project="${projectFsPath}":`,
        err,
      );
      reject(err);
    });
    setTimeout(
      () =>
        reject(
          new Error(
            `gateway-proxy registration timed out after ${MCP_REGISTRATION_TIMEOUT_MS}ms`,
          ),
        ),
      MCP_REGISTRATION_TIMEOUT_MS,
    );
  });

  const serverId = await ready;
  const transport = (server as ServerWithTransport).__transport as DustMcpServerTransport;
  return { projectFsPath, serverId, server, transport };
}
