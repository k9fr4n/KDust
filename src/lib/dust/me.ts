/**
 * Resolves the authenticated Dust user identity for the message
 * `context` block. Replaces the previous hardcoded
 * `username:'kdust' / fullName:'KDust' / email:null`.
 *
 * Lookup strategy:
 *   1. If the stored credential is a workspace API key (sk-...),
 *      `.me()` will fail (it's not bound to a human user); return
 *      a clearly-labelled fallback so logs make the situation
 *      obvious without spamming errors.
 *   2. Otherwise call `dustClient.me()` once per process and cache
 *      the result for 5 minutes. The token may rotate (refresh
 *      flow) but the underlying user identity does not, so a
 *      coarse TTL is fine.
 *   3. On any error, fall back to the previous hardcoded values
 *      so a Dust API blip never blocks a chat turn.
 *
 * Why this matters:
 *   - The Dust workspace usage CSV pulls `fullName` / `email` from
 *     the bearer token's user, NOT from `context`. So this patch
 *     does NOT change the export attribution. Its real impact is
 *     on the conversation metadata visible inside Dust itself
 *     (e.g. message author labels in the web UI).
 *
 * Author:        Franck SALLET
 * Last-modified: 2026-04-28
 */
import { getDustClient, getValidAccessToken } from './client';

export interface DustMe {
  username: string;
  email: string | null;
  fullName: string;
}

const FALLBACK: DustMe = {
  username: 'kdust',
  email: null,
  fullName: 'KDust',
};

const API_KEY_FALLBACK: DustMe = {
  username: 'kdust-api',
  email: null,
  fullName: 'KDust (API key)',
};

const TTL_MS = 5 * 60_000;
let cached: DustMe | null = null;
let cachedAt = 0;

/** Reset the in-memory cache (used after token swap / logout). */
export function invalidateDustMe(): void {
  cached = null;
  cachedAt = 0;
}

export async function getDustMe(): Promise<DustMe> {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;

  // Detect workspace API key — `.me()` is OAuth-only.
  try {
    const token = await getValidAccessToken();
    if (token && token.startsWith('sk-')) {
      cached = API_KEY_FALLBACK;
      cachedAt = Date.now();
      console.warn(
        '[chat/me] workspace API key detected (sk-...) — using fallback identity. ' +
          'Workspace usage export will show empty fullName/email; switch to OAuth ' +
          'device flow to attribute usage to a human user.',
      );
      return cached;
    }
  } catch (err) {
    console.warn('[chat/me] getValidAccessToken failed:', err instanceof Error ? err.message : err);
  }

  let ctx;
  try {
    ctx = await getDustClient();
  } catch (err) {
    console.warn('[chat/me] getDustClient threw:', err instanceof Error ? err.message : err);
    return FALLBACK;
  }
  if (!ctx) return FALLBACK;

  try {
    const res = await ctx.client.me();
    if (res.isErr()) {
      console.warn('[chat/me] dustClient.me() returned error:', res.error.message);
      return FALLBACK;
    }
    const u = res.value as {
      username?: string;
      email?: string | null;
      fullName?: string;
    };
    cached = {
      username: u.username ?? FALLBACK.username,
      email: u.email ?? null,
      fullName: u.fullName ?? FALLBACK.fullName,
    };
    cachedAt = Date.now();
    console.log(
      `[chat/me] resolved identity username=${cached.username} email=${cached.email ?? 'null'} fullName="${cached.fullName}"`,
    );
    return cached;
  } catch (err) {
    console.warn('[chat/me] dustClient.me() threw:', err instanceof Error ? err.message : err);
    return FALLBACK;
  }
}
