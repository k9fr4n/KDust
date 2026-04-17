import { DustAPI } from '@dust-tt/client';
import { jwtDecode } from 'jwt-decode';
import { loadTokens, saveTokens } from './tokens';
import { refreshTokens } from './workos';
import { resolveDustUrl } from './region';

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
  const client = new DustAPI(
    { url },
    { workspaceId: stored.workspaceId, apiKey: token },
    // logger
    { error: console.error, info: console.log } as any,
  );
  return { client, workspaceId: stored.workspaceId };
}
