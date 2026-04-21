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
    // logger
    { error: console.error, info: console.log } as any,
  );
  return { client, workspaceId: stored.workspaceId };
}
