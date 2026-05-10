// src/lib/mcp/gateway-client.ts
//
// Singleton MCP Client over Streamable HTTP to the sibling
// `mcp-gateway` Compose service (ADR-0012, Franck 2026-05-10).
//
// One Client connection per KDust process, lazily opened on first
// use and held warm for the lifetime of the container. The Client
// SDK already implements its own reconnection/backoff loop on the
// streamable-HTTP transport, so we don't add a watchdog on top.
//
// The gateway is reachable only on the Compose-internal network
// (no public ingress) and runs with DOCKER_MCP_IN_CONTAINER=1, so
// no Bearer auth header is needed for V1.
//
// This module is intentionally agnostic of the gateway's internal
// tool naming convention: it just relays whatever `tools/list`
// returns. Per-project filtering is applied later in
// gateway-proxy.ts via the ProjectMcpToolFilter table.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_URL = 'http://mcp-gateway:8080/mcp';

export interface GatewayHandle {
  client: Client;
  url: string;
}

// Module-level singletons (survive across Next.js requests).
const g = globalThis as unknown as {
  __kdustGatewayClient?: Promise<GatewayHandle>;
  __kdustGatewayToolsCache?: { tools: Tool[]; fetchedAt: number };
};

const TOOLS_CACHE_TTL_MS = Math.max(
  10_000,
  Number(process.env.KDUST_MCP_GATEWAY_TOOLS_TTL_MS ?? 60_000),
);

/**
 * Open the streamable-HTTP MCP client connection. Idempotent.
 *
 * Returns the same Promise across the whole process; if the
 * connection ever drops, the SDK reconnects internally on the
 * next request (see StreamableHTTPReconnectionOptions defaults
 * in the SDK).
 */
export async function getGatewayClient(): Promise<GatewayHandle> {
  if (g.__kdustGatewayClient) return g.__kdustGatewayClient;
  const url = process.env.MCP_GATEWAY_URL?.trim() || DEFAULT_URL;
  const promise = (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client(
      { name: 'kdust-gateway-proxy', version: '0.1.0' },
      { capabilities: {} },
    );
    transport.onerror = (err) => {
      console.warn(
        `[mcp/gateway-client] transport error url=${url}: ${err?.message ?? err}`,
      );
    };
    await client.connect(transport);
    console.log(`[mcp/gateway-client] connected url=${url}`);
    return { client, url };
  })();
  g.__kdustGatewayClient = promise;
  promise.catch((e) => {
    console.error(
      `[mcp/gateway-client] initial connect failed url=${url}: ${(e as Error).message}`,
    );
    // Drop the cached failed promise so a later call retries.
    if (g.__kdustGatewayClient === promise) g.__kdustGatewayClient = undefined;
  });
  return promise;
}

/**
 * Reset the cached client. Forces a fresh connection on the next
 * getGatewayClient() call. Used by /api/mcp/gateway-ensure when
 * the operator wants to retry after a misconfiguration.
 */
export async function invalidateGatewayClient(): Promise<void> {
  const entry = g.__kdustGatewayClient;
  g.__kdustGatewayClient = undefined;
  g.__kdustGatewayToolsCache = undefined;
  if (!entry) return;
  try {
    const handle = await entry;
    await handle.client.close().catch(() => {});
  } catch {
    /* swallow */
  }
}

/**
 * Discover the tools currently exposed by the gateway. Cached
 * for KDUST_MCP_GATEWAY_TOOLS_TTL_MS to avoid spamming
 * `tools/list` on every chat ensure.
 *
 * Pass `force=true` after a `--servers=...` change in compose to
 * pick up the new tools immediately.
 */
export async function listGatewayTools(force = false): Promise<Tool[]> {
  const cached = g.__kdustGatewayToolsCache;
  if (!force && cached && Date.now() - cached.fetchedAt < TOOLS_CACHE_TTL_MS) {
    return cached.tools;
  }
  const { client } = await getGatewayClient();
  const res = await client.listTools();
  const tools: Tool[] = res.tools ?? [];
  g.__kdustGatewayToolsCache = { tools, fetchedAt: Date.now() };
  return tools;
}

/**
 * Call a tool on the gateway. Thin wrapper that surfaces the
 * SDK's CallToolResult (content + isError) untouched so the proxy
 * server can relay it verbatim to Dust.
 *
 * Errors thrown here propagate as McpServer tool errors on the
 * Dust side.
 */
export async function callGatewayTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { client } = await getGatewayClient();
  return client.callTool({ name: toolName, arguments: args });
}
