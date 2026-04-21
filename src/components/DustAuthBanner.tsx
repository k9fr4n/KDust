import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { loadTokens } from '@/lib/dust/tokens';

/**
 * Surfaces a dismissible‑looking (but non‑dismissible) banner when the
 * DustSession row is missing or the stored token has a past expiry.
 * Added after the 2026‑04‑21 incident (Franck) where the WorkOS
 * refresh grant kept returning 400 on a zombie refresh token and the
 * UI kept cascading 403s with no visible hint that re‑auth was needed.
 *
 * Runs server‑side on every navigation. Cheap (one SELECT) and
 * strictly read‑only — never triggers a refresh itself, so it can’t
 * amplify a failure loop.
 */
export async function DustAuthBanner() {
  let needsLogin = false;
  let reason: 'no-session' | 'expired' | null = null;

  try {
    const stored = await loadTokens();
    if (!stored || !stored.accessToken) {
      needsLogin = true;
      reason = 'no-session';
    } else if (stored.expiresAt && stored.expiresAt.getTime() < Date.now()) {
      // Even if the refresh flow hasn’t tried yet, an access‑token
      // that has already passed its stored expiry is a strong
      // signal the user may need to re‑auth — the refresh will
      // attempt first, but this keeps us honest in the edge case
      // where the refresh token is also dead.
      needsLogin = true;
      reason = 'expired';
    }
  } catch {
    // If the DB query fails, stay silent — we don’t want to spam the
    // user with a banner triggered by an unrelated infra issue.
    return null;
  }

  if (!needsLogin) return null;

  const headline =
    reason === 'expired'
      ? 'Your Dust session has expired.'
      : 'KDust is not connected to Dust.';

  return (
    <div
      role="alert"
      className="border-b border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <div className="px-4 lg:px-6 py-2 flex items-center gap-3 text-sm">
        <AlertTriangle size={16} className="shrink-0" />
        <span className="flex-1">
          <strong className="font-semibold">{headline}</strong>{' '}
          Agents, scheduled runs, and MCP servers will fail until you
          sign in again.
        </span>
        <Link
          href="/dust/connect"
          className="font-medium underline underline-offset-2 hover:no-underline"
        >
          Re‑authenticate with Dust →
        </Link>
      </div>
    </div>
  );
}
