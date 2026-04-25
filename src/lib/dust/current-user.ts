import { loadTokens } from './tokens';

/**
 * Best-effort extraction of the current user's email from the
 * stored OIDC access token (single-user KDust: only one session row
 * exists). Decodes the JWT's payload without verifying the
 * signature — we already trust it because it was stored server-side
 * after a full auth roundtrip in src/lib/dust/workos.ts.
 *
 * Used by /api/task/:id/run to populate TaskRun.triggeredBy so the
 * /run page can show "manual by <email>". Never throws — any
 * parse error yields null.
 *
 * Why not a proper session middleware? KDust is currently
 * single-user (DustSession row id=1). When/if this becomes
 * multi-user, this helper will need to read the session cookie
 * rather than the single stored token.
 */
export async function getCurrentUserEmail(): Promise<string | null> {
  try {
    const t = await loadTokens();
    if (!t?.accessToken) return null;
    const parts = t.accessToken.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}
