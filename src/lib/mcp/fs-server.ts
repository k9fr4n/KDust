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

  // verbose=true ⇒ the SDK logs SSE request/response traffic to console — invaluable
  // when diagnosing why Dust says "could not list tools for fs-cli".
  // heartbeat = 300000ms (5min) so the polyfill doesn't drop the connection between
  // user actions; default 45s caused windows where Dust requests went into the void.
  // KDUST_MCP_VERBOSE=0 in env disables it once things are stable.
  const VERBOSE = process.env.KDUST_MCP_VERBOSE !== '0';
  const HEARTBEAT_MS = 5 * 60 * 1000;

  const ready = new Promise<string>((resolve, reject) => {
    const transport = new DustMcpServerTransport(
      dust.client,
      (id: string) => {
        serverId = id;
        console.log(`[mcp/fs-server] registered fs-cli for project="${projectName}" root="${root}" serverId=${id} verbose=${VERBOSE} heartbeatMs=${HEARTBEAT_MS}`);
        resolve(id);
      },
      'fs-cli',
      VERBOSE,
      HEARTBEAT_MS,
    );

    // Catch transport errors so auth failures don't silently loop for hours.
    transport.onerror = (err: any) => {
      // err is sometimes a real Error, sometimes the raw EventSource event with
      // no usable .message (yields "[object Object]" if you concat it), and
      // sometimes a Dust SDK error object with shape
      //   { dustError: { type: 'expired_oauth_token_error', message: '...' },
      //     status: 401, url: '.../mcp/results' }
      let msg = '';
      let status: number | undefined;
      let dustErrType: string | undefined;
      if (err instanceof Error) msg = err.message;
      else if (typeof err === 'string') msg = err;
      else if (err && typeof err === 'object') {
        status = typeof err.status === 'number' ? err.status : undefined;
        dustErrType = err.dustError?.type ?? err.cause?.dustError?.type;
        msg = err.message ?? err.dustError?.message ?? err.type ?? '';
        try { msg = msg || JSON.stringify(err); } catch { /* circular */ }
      }

      // Detect auth failure from ALL the shapes we've observed in the wild:
      //   - SSE stream rejected with "401 Unauthorized"
      //   - DustAPI error with status=401 and dustError.type='expired_oauth_token_error'
      //   - Wrapped "Failed to send MCP result: [object Object]" where the root
      //     cause is a 401 but the stringified message hides it (the SDK logs
      //     the dustError separately before handing us this opaque string)
      const isAuthFailure =
        status === 401 ||
        dustErrType === 'expired_oauth_token_error' ||
        /401\s+Unauthorized/i.test(msg) ||
        /expired_oauth_token_error/i.test(msg) ||
        /access token (has )?expired/i.test(msg) ||
        /Failed to send MCP result/i.test(msg);
      if (isAuthFailure) {
        console.warn(
          `[mcp/fs-server] auth failure for project="${projectName}" (status=${status ?? '?'} dustErrType=${dustErrType ?? '?'}): invalidating cache so next call re-registers with a fresh token`,
        );
        void invalidate();
        return;
      }
      // Heartbeat drops are benign: the SDK pings on HEARTBEAT_MS and if a
      // round-trip is missed we get this message, the polyfill reconnects
      // with the current token, and all is well. Keep this one silent.
      if (!msg || /No activity within \d+ milliseconds/i.test(msg)) {
        return;
      }
      // "SSE connection error" is the SDK wrapper around an EventSource
      // failure (new Error(`SSE connection error: ${error}`) drops the
      // original .status=401 property, so we can't do isAuthFailure detection
      // on it directly). In practice these errors are caused by:
      //   a) the bearer token expiring mid-session — the polyfill keeps
      //      reconnecting every RECONNECT_DELAY_MS with the now-stale token,
      //      leaking a zombie transport that never recovers
      //   b) a transient network blip — the polyfill reconnects fine
      // The cheapest, most robust fix is to invalidate on ANY SSE connection
      // error. Our invalidate() is idempotent (guarded by `invalidated` flag)
      // and the next API request re-registers a fresh transport with a
      // freshly-refreshed token. A lost conversation's serverId is an
      // acceptable cost vs. letting a zombie loop forever.
      if (/SSE connection error/i.test(msg)) {
        console.warn(
          `[mcp/fs-server] SSE connection error for project="${projectName}" — tearing down transport so next request re-registers with a fresh token`,
        );
        void invalidate();
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
    server
      .connect(transport)
      .then(() => {
        // Monkey-patch onmessage / send AFTER connect so we log both directions.
        // McpServer sets transport.onmessage during connect; we wrap it to trace.
        const origOnMessage = transport.onmessage;
        transport.onmessage = (m: any) => {
          try {
            console.log(
              `[mcp/fs-server] <- project=${projectName} method=${m?.method ?? '?'} id=${m?.id ?? '?'} params=${JSON.stringify(m?.params ?? {}).slice(0, 200)}`,
            );
          } catch {
            /* ignore */
          }
          return origOnMessage?.(m);
        };
        const origSend = transport.send.bind(transport);
        transport.send = async (m: any) => {
          try {
            const summary =
              m?.result
                ? `result(keys=${Object.keys(m.result).join(',')})`
                : m?.error
                ? `error(${m.error.code}:${m.error.message})`
                : m?.method
                ? `req(${m.method})`
                : 'msg';
            console.log(
              `[mcp/fs-server] -> project=${projectName} id=${m?.id ?? '?'} ${summary}`,
            );
          } catch {
            /* ignore */
          }
          return origSend(m);
        };
      })
      .catch((err) => {
        console.error('[mcp/fs-server] connect failed:', err);
        reject(err);
      });
    setTimeout(() => reject(new Error('MCP server registration timed out after 15s')), 15000);
  });

  const id = await ready;
  const transport = (server as any).__transport as DustMcpServerTransport;

  return { projectName, root, serverId: id, server, transport };
}
