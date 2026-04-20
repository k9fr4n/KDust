import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DustMcpServerTransport } from '@dust-tt/client';
import { getDustClient } from '../dust/client';
import { loadTokens } from '../dust/tokens';
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

  // verbose=true \u21d2 the SDK logs SSE request/response traffic to console \u2014 invaluable
  // when diagnosing why Dust says "could not list tools for fs-cli".
  //
  // heartbeat tuning (Franck 2026-04-20 14:33):
  // ------------------------------------------
  // The @dust-tt/client SSE polyfill treats HEARTBEAT_MS as a
  // "no-activity-from-server" watchdog: if Dust doesn\u0027t push
  // anything for that duration, the polyfill closes the socket and
  // emits `error: undefined, readyState: 2`. Dust\u0027s MCP endpoint
  // happens to stay quiet during idle \u2014 tools are pulled on
  // demand, no keepalive frames \u2014 so a too-short HEARTBEAT_MS
  // causes needless 5-min flapping even when the token is still valid.
  //
  // Previous value of 5 min matched Dust\u0027s own idle silence
  // exactly, producing the race observed on 2026-04-20 12:23\u219212:28.
  // We now default to 50 min, a comfortable margin UNDER the typical
  // WorkOS access-token TTL (~60 min); the proactive rebuild at
  // T-10min of token expiry still fires FIRST, so this watchdog is a
  // belt-and-braces fallback, not a primary mechanism.
  //
  // Override via env KDUST_MCP_HEARTBEAT_MS for on-the-fly tuning
  // without a rebuild. Values < 60s are clamped to 60s to avoid
  // shooting ourselves in the foot.
  const VERBOSE = process.env.KDUST_MCP_VERBOSE !== '0';
  const HEARTBEAT_MS_RAW = Number(process.env.KDUST_MCP_HEARTBEAT_MS ?? 50 * 60 * 1000);
  const HEARTBEAT_MS = Number.isFinite(HEARTBEAT_MS_RAW) && HEARTBEAT_MS_RAW >= 60_000
    ? HEARTBEAT_MS_RAW
    : 50 * 60 * 1000;

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
      // "SSE connection error" discrimination (Franck 2026-04-20 14:33):
      // -------------------------------------------------------------
      // This wrapper is emitted for THREE very different situations
      // which used to be treated identically (tear down + re-register):
      //
      //   a) Bearer expired mid-session \u2014 the polyfill would loop
      //      forever with a stale token. Tear-down IS the right move.
      //      Detected upstream via isAuthFailure already.
      //   b) Transient network blip \u2014 the polyfill reconnects fine
      //      if we leave it alone; tearing down costs a re-register
      //      round-trip for nothing.
      //   c) Our HEARTBEAT_MS watchdog tripping after Dust-side idle\u2014
      //      raw EventSource event with `error: undefined, readyState:2`,
      //      no informative message attached. Same story as (b): the
      //      polyfill will reconnect; tearing down makes it WORSE by
      //      invalidating the still-valid serverId upstream.
      //
      // We now only tear down when the message carries a meaningful
      // signal (a real exception, a 5xx response, a URL in the text);
      // the empty-error case from the idle watchdog is demoted to a
      // one-line warning. If the underlying polyfill can\u0027t heal
      // itself, the NEXT user message triggers re-ensure anyway
      // (chat client defensive path, commit edeca1c), so a truly
      // dead transport recovers on first use.
      if (/SSE connection error/i.test(msg)) {
        // Distinguish "empty/benign" errors from real ones. If the
        // raw event had neither a message nor a useful property, it
        // is almost certainly the watchdog timeout or a brief blip.
        const hasSignal =
          !!err?.message ||
          typeof err?.status === 'number' ||
          (typeof msg === 'string' && msg.length > 30 && !/undefined/.test(msg));
        if (!hasSignal) {
          console.warn(
            `[mcp/fs-server] transient SSE close for project="${projectName}" (no signal) \u2014 leaving transport, polyfill will reconnect or next /api/mcp/ensure will re-register`,
          );
          return;
        }
        console.warn(
          `[mcp/fs-server] SSE connection error for project="${projectName}" \u2014 tearing down transport so next request re-registers with a fresh token`,
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

  // --- Proactive rebuild before token expiry (Franck 2026-04-20 14:07) --
  // DustMcpServerTransport bakes the current Bearer into its SDK
  // client when constructed; it has no way to refresh it mid-session.
  // When the WorkOS access token ages out (~1h) the SSE heartbeat and
  // any MCP result POST start returning 401 expired_oauth_token_error,
  // then the re-register attempt does too because the cached transport
  // is still using the stale token. To avoid that failure window we
  // invalidate the handle ~10 min BEFORE the token actually expires,
  // forcing the next call to startFsServer() to build a transport with
  // a freshly-refreshed token. Falls back to a 45-min periodic rebuild
  // when the DB has no expiry stored (e.g. API-key sessions).
  try {
    const stored = await loadTokens();
    const REBUILD_BEFORE_MS = 10 * 60 * 1000;
    const FALLBACK_PERIOD_MS = 45 * 60 * 1000;
    const ttlMs = stored?.expiresAt
      ? stored.expiresAt.getTime() - Date.now() - REBUILD_BEFORE_MS
      : FALLBACK_PERIOD_MS;
    // Guard against past dates / very-short TTLs: don\u0027t schedule
    // an immediate tear-down (minimum 2 min grace).
    const delay = Math.max(2 * 60 * 1000, ttlMs);
    const t = setTimeout(() => {
      console.log(
        `[mcp/fs-server] proactive rebuild for project="${projectName}" ` +
          `(token expires at ${stored?.expiresAt?.toISOString() ?? 'unknown'})`,
      );
      void invalidate();
    }, delay);
    // unref so the timer doesn\u0027t keep the process alive in tests.
    (t as any).unref?.();
  } catch (e) {
    console.warn(`[mcp/fs-server] could not schedule proactive rebuild: ${(e as any)?.message}`);
  }

  return { projectName, root, serverId: id, server, transport };
}
