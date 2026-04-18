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

export async function getDustClient(): Promise<{
  client: DustAPI;
  workspaceId: string;
} | null> {
  const stored = await loadTokens();
  if (!stored || !stored.workspaceId) return null;

  const token = await getValidAccessToken();
  if (!token) return null;

  const url = await resolveDustUrl(stored.region);
  // Legacy 4-arg constructor kept (still supported by the SDK) — the
  // new single-options constructor exposes `extraHeaders` cleanly, but
  // the 4-arg form doesn't, so we pass headers by casting the legacy
  // config block. Both signatures end up writing to `_options`.
  const client = new DustAPI(
    { url },
    {
      workspaceId: stored.workspaceId,
      apiKey: token,
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
