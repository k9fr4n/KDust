import { DustAPI } from '@dust-tt/client';
import { jwtDecode } from 'jwt-decode';
import { loadTokens, saveTokens } from './tokens';
import { refreshTokens } from './workos';
import { resolveDustUrl } from './region';

/**
 * Impersonation of the official Dust CLI.
 *
 * Since 2026-04-18 Dust's API rejects `context.origin` values that
 * don't match the caller's User-Agent. Specifically:
 *   - origin="web"  requires the web-UI fetch stack (impossible to fake)
 *   - origin="cli"  requires User-Agent = "Dust CLI"
 *   - other values  land in the billed-programmatic bucket
 *
 * Franck's policy (2026-04-18 14:11): reproduce the CLI behaviour
 * EXACTLY so every KDust call lands in the human usage bucket, same
 * as `dust` interactive. Never emit `cli_programmatic` (that's the
 * `dust -m` path and it's billed as API usage).
 *
 * The CLI version is pinned to the one currently installed locally
 * so the X-header stays consistent if Dust ever checks the tuple
 * (User-Agent, X-Dust-CLI-Version). Bump when the installed CLI bumps
 * — or automate this by reading it at build time from
 * /usr/local/lib/node_modules/@dust-tt/dust-cli/package.json.
 */
const DUST_CLI_USER_AGENT = 'Dust CLI';
const DUST_CLI_VERSION = '0.4.5';

/**
 * Returns a valid access token, refreshing if needed.
 * API keys (starting with sk-) are passed through as-is.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const stored = await loadTokens();
  if (!stored) return null;

  if (stored.accessToken.startsWith('sk-')) return stored.accessToken;

  // Refresh proactively 5 minutes before expiry. The previous 30s window
  // left too tight a margin: long agent turns that started close to expiry
  // would see their MCP result POSTs fail with expired_oauth_token_error
  // mid-flight because the cached token aged out between the initial
  // handshake and the async tool callbacks.
  const REFRESH_BEFORE_S = 5 * 60;
  let needRefresh = false;
  try {
    const decoded = jwtDecode<{ exp?: number }>(stored.accessToken);
    const now = Math.floor(Date.now() / 1000);
    const ttl = (decoded.exp ?? 0) - now;
    if (ttl < REFRESH_BEFORE_S) needRefresh = true;
  } catch {
    needRefresh = true;
  }

  if (!needRefresh) return stored.accessToken;

  try {
    const refreshed = await refreshTokens(stored.refreshToken);
    await saveTokens(refreshed.access_token, refreshed.refresh_token, {
      region: stored.region,
      expiresAt: refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000)
        : null,
    });
    return refreshed.access_token;
  } catch {
    return null;
  }
}

// Historical note (removed 2026-04-21 18:30, Franck):
// `startTokenRefreshWatchdog` used to rotate `client._options.apiKey`
// every 30 min to keep long-lived MCP handles using a fresh bearer.
// It has been deleted because getDustClient() now passes `apiKey` as
// an async callable \u2014 the SDK resolves the token on every HTTP call,
// which is both simpler and race-free. See the docblock on
// getDustClient() below and the official Dust CLI
// (dust-cli/src/utils/dustClient.ts) for the same pattern.

export async function getDustClient(): Promise<{
  client: DustAPI;
  workspaceId: string;
} | null> {
  const stored = await loadTokens();
  if (!stored || !stored.workspaceId) return null;

  // Early existence check — if no token is available at all, don\u2019t
  // return a client. The apiKey callable below is only invoked by the
  // SDK on the first HTTP call, so without this guard we\u0027d return a
  // useless client that errors late.
  const probe = await getValidAccessToken();
  if (!probe) return null;

  const url = await resolveDustUrl(stored.region);
  // Legacy 4-arg constructor kept (still supported by the SDK) — the
  // new single-options constructor exposes `extraHeaders` cleanly, but
  // the 4-arg form doesn't, so we pass headers by casting the legacy
  // config block. Both signatures end up writing to `_options`.
  //
  // Token rotation (Franck 2026-04-21 18:05)
  // ----------------------------------------
  // `apiKey` is passed as an async FUNCTION, not a string. The SDK
  // (@dust-tt/client client.cjs.development.js:5852-5855) checks
  // `typeof this._credentials.apiKey === "function"` on every HTTP
  // call and invokes it to resolve the bearer. This gives us a fresh
  // token on every request \u2014 including long-running heartbeats and
  // MCP re-registers \u2014 without a watchdog. Same pattern as the
  // official Dust CLI (dust-cli/src/utils/dustClient.ts).
  //
  // This supersedes the previous approach (string apiKey + periodic
  // mutation of _options.apiKey via startTokenRefreshWatchdog). The
  // watchdog is kept as a compatibility shim returning a no-op cleanup
  // function \u2014 call sites that still invoke it don\u0027t need to change.
  // We wrap the SDK's error channel to downgrade cooperative-
  // cancellation chatter to a one-liner info log. When the caller
  // aborts an SSE stream (user clicks "Stop" → /api/taskruns/:id/
  // cancel fires AbortController.abort()), the SDK's event-stream
  // loop catches the resulting AbortError, calls
  //   logger.error({ error: e }, "Failed processing event stream")
  // THEN checks `signal.aborted` and returns silently. So the error
  // is logged even though it's the normal abort path. We detect the
  // shape (AbortError + that exact message) and demote it to a
  // console.log one-liner; everything else keeps the full error path.
  const smartErrorLogger = (first: unknown, ...rest: unknown[]) => {
    try {
      const msg =
        typeof rest[0] === 'string'
          ? rest[0]
          : typeof first === 'string'
            ? first
            : '';
      const errObj = (first as any)?.error ?? first;
      const isAbort =
        errObj?.name === 'AbortError' ||
        errObj?.code === 20 ||
        /aborted/i.test(String(errObj?.message ?? '')) ||
        // Dust SDK cooperative-cancel shape (Franck 2026-04-24 22:30):
        // when the user clicks Stop and /api/taskruns/:id/cancel
        // fires, the SDK surfaces a Dust-typed error `{kind:'user'}`
        // (distinct from the raw AbortError above) before the SSE
        // loop notices `signal.aborted`. Same expected path, same
        // demotion to a single info line rather than a scary
        // [error] that operators read as a crash.
        errObj?.kind === 'user';
      if (isAbort && /event stream/i.test(msg)) {
        console.log('[dust/sdk] event stream aborted by caller (cooperative cancel)');
        return;
      }
      // Dust idle-SSE connection drops (Franck 2026-04-24 09:08).
      // When a tool call (e.g. task_runner.wait_for_run) blocks
      // for minutes and Dust/its reverse proxy silently drops the
      // keep-alive TCP connection, undici surfaces the body read
      // as `TypeError: terminated` with `cause.code === 'ETIMEDOUT'`.
      // The SDK logs it via "Failed processing event stream", our
      // for-await loop upstream catches the iterator rejection and
      // the unhandledRejection dampener in instrumentation.ts
      // handles any stray promise. No action required \u2014 just
      // demote the log from scary [error] to a single [warn] line
      // so ops dashboards don't raise a false alarm.
      const isTerminated =
        errObj?.name === 'TypeError' && /terminated/i.test(String(errObj?.message ?? ''));
      const isFetchTimeout =
        errObj?.cause?.code === 'ETIMEDOUT' || errObj?.code === 'ETIMEDOUT';
      if ((isTerminated || isFetchTimeout) && /event stream/i.test(msg)) {
        console.warn(
          `[dust/sdk] event stream dropped by peer (ETIMEDOUT) \u2014 ` +
            `usually an idle long-poll tool call; will surface as a stream error upstream`,
        );
        return;
      }
    } catch {
      /* fall through to plain error log */
    }
    console.error(first, ...rest);
  };

  const client = new DustAPI(
    { url },
    {
      workspaceId: stored.workspaceId,
      apiKey: async () => (await getValidAccessToken()) ?? '',
      // Impersonate the official Dust CLI so `origin: "cli"` is
      // accepted and the conversation lands in the human usage
      // bucket. See docblock at the top of the file.
      extraHeaders: {
        'User-Agent': DUST_CLI_USER_AGENT,
        'X-Dust-CLI-Version': DUST_CLI_VERSION,
      },
    } as any,
    // logger — `error` is wrapped to demote AbortError chatter.
    { error: smartErrorLogger, info: console.log } as any,
  );

  // ---------------------------------------------------------------
  // Retry wrapper around postMCPResults (Franck 2026-04-22 18:53).
  //
  // The SDK's DustMcpServerTransport.send() calls client.postMCPResults()
  // exactly ONCE. When eu.dust.tt has a transient blip and returns
  // an HTML 502/503/504 body, the Result is marked Err with
  // `dustError.type === 'unexpected_response_format'` and the
  // transport logs a scary "Failed to send MCP result" transport
  // error, even though Dust itself recommends "try again in 30s".
  //
  // We wrap the method so that these retryable errors are silently
  // re-tried with exponential backoff. Non-retryable errors (4xx
  // auth/permission, invalid serverId) are returned on the first
  // attempt so they surface immediately.
  //
  // Attempts: up to 4 (initial + 3 retries). Delays: 2s, 6s, 15s.
  // Total worst-case latency added: ~23s, comfortably under the
  // ~30s window Dust suggests.
  // ---------------------------------------------------------------
  const original = client.postMCPResults.bind(client);
  (client as any).postMCPResults = async (args: any) => {
    const delays = [2000, 6000, 15000];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const res = await original(args);
      if (!res.isErr()) return res;
      const err: any = res.error;
      // Only retry on clearly-transient conditions. Everything else
      // (auth error, schema error, unknown serverId) returns now so
      // the caller can fail fast.
      const status = err?.status;
      const type = err?.dustError?.type ?? err?.type;
      const isTransient =
        (typeof status === 'number' && status >= 500 && status <= 599) ||
        type === 'unexpected_response_format' ||
        type === 'connection_error' ||
        type === 'fetch_error';
      if (!isTransient || attempt === delays.length) {
        return res;
      }
      const delay = delays[attempt];
      console.warn(
        `[dust/client] postMCPResults transient error (attempt ${attempt + 1}/${delays.length + 1}): ` +
          `status=${status ?? '?'} type=${type ?? '?'} — retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    // Unreachable (loop always returns), but keeps TS happy.
    return original(args);
  };

  return { client, workspaceId: stored.workspaceId };
}
