import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DustMcpServerTransport } from '@dust-tt/client';
import { getDustClient } from '../dust/client';
import { allFsTools } from './fs-tools';
import { PROJECTS_ROOT } from '../projects';

export interface FsServerHandle {
  projectName: string;
  root: string;
  serverId: string;
  server: McpServer;
  transport: DustMcpServerTransport;
}

export async function startFsServer(projectName: string): Promise<FsServerHandle> {
  const root = path.resolve(PROJECTS_ROOT, projectName);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }

  const dust = await getDustClient();
  if (!dust) throw new Error('Dust client not available (login required)');

  // IMPORTANT: the server name MUST be "fs-cli" so that Dust agents configured
  // for the official dust-cli file-system MCP pick up our tools.
  const server = new McpServer({
    name: 'fs-cli',
    version: '0.1.0',
  });

  for (const tool of allFsTools) {
    server.registerTool(
      tool.name,
      {
        description: `${tool.description} (project root: ${root})`,
        inputSchema: tool.schema.shape as any,
      },
      (args: any) => tool.execute(root, args),
    );
  }

  let serverId: string | null = null;
  let invalidated = false;

  // Late-bound to avoid import cycle (registry imports this module).
  const invalidate = async () => {
    if (invalidated) return;
    invalidated = true;
    try {
      const { invalidateFsServer } = await import('./registry');
      await invalidateFsServer(projectName);
    } catch {
      /* ignore */
    }
  };

  const ready = new Promise<string>((resolve, reject) => {
    const transport = new DustMcpServerTransport(
      dust.client,
      (id: string) => {
        serverId = id;
        console.log(`[mcp/fs-server] registered fs-cli for project="${projectName}" root="${root}" serverId=${id}`);
        resolve(id);
      },
      'fs-cli',
      false,
    );

    // Catch transport errors so auth failures don't silently loop for hours.
    transport.onerror = (err: any) => {
      // err is sometimes a real Error, sometimes the raw EventSource event with
      // no usable .message (yields "[object Object]" if you concat it).
      let msg = '';
      if (err instanceof Error) msg = err.message;
      else if (typeof err === 'string') msg = err;
      else if (err && typeof err === 'object') {
        msg = err.message ?? err.type ?? '';
        try { msg = msg || JSON.stringify(err); } catch { /* circular */ }
      }

      if (/401\s+Unauthorized/i.test(msg)) {
        console.warn(
          `[mcp/fs-server] 401 on SSE stream for project="${projectName}" — access token likely expired, invalidating cache so the next call re-registers with a fresh token`,
        );
        void invalidate();
        return;
      }
      // Heartbeat / generic SSE drops are absorbed silently — the polyfill
      // auto-reconnects. Surfacing them was just noise.
      if (
        !msg ||
        /No activity within \d+ milliseconds/i.test(msg) ||
        /SSE connection error/i.test(msg)
      ) {
        return;
      }
      console.error(`[mcp/fs-server] transport error project="${projectName}": ${msg}`);
    };

    transport.onclose = () => {
      // If the transport was closed externally and we still hold a handle,
      // invalidate so the next request rebuilds from scratch.
      void invalidate();
    };

    (server as any).__transport = transport;
    server.connect(transport).catch((err) => {
      console.error('[mcp/fs-server] connect failed:', err);
      reject(err);
    });
    setTimeout(() => reject(new Error('MCP server registration timed out after 15s')), 15000);
  });

  const id = await ready;
  const transport = (server as any).__transport as DustMcpServerTransport;

  return { projectName, root, serverId: id, server, transport };
}
