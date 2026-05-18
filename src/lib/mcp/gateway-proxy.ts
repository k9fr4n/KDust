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
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DustMcpServerTransport } from '@dust-tt/client';
import { MCP_REGISTRATION_TIMEOUT_MS } from '../constants';
import { db } from '../db';
import { getDustClient } from '../dust/client';
import { listGatewayTools, callGatewayTool } from './gateway-client';
import { errMessage } from '../errors';

export interface GatewayProxyHandle {
  projectFsPath: string;
  /**
   * Dust-side MCP server id. `null` when the project has zero
   * whitelisted gateway tools — in that case no proxy McpServer
   * is instantiated and no SSE transport is opened, to avoid
   * holding an idle connection that would emit periodic
   * reconnect noise (Franck 2026-05-11).
   */
  serverId: string | null;
  server: McpServer | null;
  transport: DustMcpServerTransport | null;
  /** Reason for a null serverId, for upstream API responses. */
  skipped?: 'no-tools';
}

type ServerWithTransport = McpServer & { __transport?: DustMcpServerTransport };

const MCP_SERVER_NAME = 'mcp-gateway';

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

  const allowed = await resolveAllowedToolNames(projectFsPath);

  // Short-circuit when this project has no whitelisted gateway
  // tools: a proxy registered with zero tools still opens a
  // long-lived SSE transport to Dust that periodically reconnects
  // (~5 min idle timeout), spamming logs with "SSE connection
  // error". Skip the registration entirely. Franck 2026-05-11.
  if (allowed.size === 0) {
    console.log(
      `[mcp/gateway-proxy] project="${projectFsPath}" no tools whitelisted — skipping proxy registration`,
    );
    return {
      projectFsPath,
      serverId: null,
      server: null,
      transport: null,
      skipped: 'no-tools',
    };
  }

  const tools = await listGatewayTools().catch((e) => {
    console.warn(
      `[mcp/gateway-proxy] listGatewayTools failed for project="${projectFsPath}": ${errMessage(e)} — starting empty proxy`,
    );
    return [];
  });

  // Declare the `tools` capability up-front so a project with zero
  // whitelisted tools still answers tools/list with [] cleanly,
  // instead of returning -32601 "Method not found" (which surfaces
  // as a confusing red banner in the chat). Franck 2026-05-10.
  //
  // 2026-05-18: also declare empty `prompts` and `resources`
  // capabilities AND register explicit list-handlers below. Dust
  // probes prompts/list, resources/list and resources/templates/list
  // at session start; without those, the SDK returns -32601 Method
  // not found, which Dust surfaces as
  //   "Tools from this server are not available for this message.
  //    Reason: MCP error -32601: Method not found."
  // and disables the whole server for the conversation.
  //
  // Note: the high-level McpServer SDK only registers list-handlers
  // lazily when you actually call server.prompt() / server.resource(),
  // so declaring the capability alone is NOT enough. We bypass that
  // by attaching handlers directly on the underlying low-level
  // Server below (server.server.setRequestHandler) and have them
  // answer with empty lists — which is exactly the right semantic
  // for a tools-only proxy.
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: '0.1.0' },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: {},
        resources: {},
      },
    },
  );
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [],
  }));
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));
  server.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async () => ({ resourceTemplates: [] }),
  );

  // Build the allowed-tool inventory once. We deliberately do NOT
  // use `server.registerTool` (high-level McpServer API) here
  // because it requires a ZodRawShape inputSchema that we can't
  // reconstruct from arbitrary upstream JSON Schema. Instead we
  // attach low-level handlers for `tools/list` and `tools/call`
  // on the underlying Server, which lets us forward the upstream
  // JSON Schema verbatim — preserving `properties`, `required`,
  // `enum`, descriptions, etc. so the Dust agent actually sees
  // the parameters and fills them in (Franck 2026-05-18).
  //
  // Before this fix `registerTool` published an empty `properties:
  // {}` schema, Dust stripped every argument before forwarding,
  // and upstream servers like thruk-mcp rejected calls with
  // "missing required field: host".
  const exposed = tools.filter((t) => allowed.has(t.name));
  const exposedByName = new Map(exposed.map((t) => [t.name, t]));

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposed.map((t) => ({
      name: t.name,
      description: t.description ?? `Gateway tool ${t.name}`,
      // The upstream gateway always returns a JSON-Schema-shaped
      // object here. Fall back to an empty open object if it's
      // missing so the wire payload stays spec-compliant.
      inputSchema:
        (t as { inputSchema?: Record<string, unknown> }).inputSchema ?? {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    if (!exposedByName.has(name)) {
      return {
        content: [
          { type: 'text', text: `[mcp-gateway] tool not allowed: ${name}` },
        ],
        isError: true,
      };
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    try {
      const result = (await callGatewayTool(name, args)) as {
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
        content: [
          { type: 'text', text: `[mcp-gateway] ${errMessage(e)}` },
        ],
        isError: true,
      };
    }
  });

  const registered = exposed.length;
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
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : '';
      // Filter known idle/reconnect noise. Dust closes the SSE
      // after its idle window and the SDK reconnects on the next
      // tool call; logging each drop adds zero signal and floods
      // the log buffer (Franck 2026-05-11).
      if (
        !msg ||
        /No activity within \d+ milliseconds|SSE connection error|terminated|fetch failed|ECONNRESET|socket hang up/i.test(
          msg,
        )
      )
        return;
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
