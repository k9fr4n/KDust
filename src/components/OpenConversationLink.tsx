'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Wraps children in an <a>-like clickable region that:
 *   1. POSTs to /api/conversation/:id/open (sets project cookie)
 *   2. Navigates to /chat?id=:id
 *
 * A plain <Link href="/api/conversation/:id/open"> cannot be used because:
 *   - Next.js may prefetch the GET on hover/visibility, firing the
 *     cookie-mutating side-effect for every card in the list;
 *   - The last-prefetched card's project would win, and clicking ANY
 *     card would land the user in the wrong project / wrong agent.
 * Forcing a POST on click guarantees the cookie reflects the user's
 * actual intent.
 */
export function OpenConversationLink({
  conversationId,
  className,
  children,
}: {
  conversationId: string;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onClick = async (e: React.MouseEvent) => {
    // Allow middle-click / ctrl+click to open in new tab with a plain GET
    // fallback to /chat?id=... (no project sync, user is expected to pick
    // the project manually in the new tab).
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      return; // let the browser handle it via the <a href>
    }
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/conversation/${conversationId}/open`, {
        method: 'POST',
      });
      if (!r.ok) throw new Error(`open failed: HTTP ${r.status}`);
      const j = await r.json();
      // HARD navigation on purpose \u2014 mirrors ProjectSwitcher.select()
      // which also does window.location.reload() after toggling the
      // project cookie. A soft router.push() would keep the persistent
      // Nav (and its ProjectSwitcher) mounted with the OLD cookie
      // value; we relied on a CustomEvent to wake the switcher, but
      // there was a race between the browser absorbing the
      // Set-Cookie header from the POST response and the switcher's
      // subsequent fetch('/api/current-project'), which could read
      // the stale cookie and leave the top selector showing the
      // previous project. window.location.href guarantees the new
      // page fully re-renders with the fresh cookie on every
      // component \u2014 switcher, guards, server layout.
      // Franck 2026-04-19 11:26: "le filtre de projet ne change pas"
      // when clicking recent-conversations on the dashboard.
      window.location.href = j.redirect ?? `/chat/${conversationId}`;
    } catch (err) {
      console.error(err);
      // Fallback: navigate anyway; the /chat layout will redirect to
      // the dashboard if the cookie is missing.
      window.location.href = `/chat/${conversationId}`;
    } finally {
      // `finally` still runs before the unload, but setBusy() here is
      // mostly cosmetic since the page is about to be replaced.
      setBusy(false);
    }
  };

  return (
    <a
      href={`/chat/${conversationId}`}
      onClick={onClick}
      className={className}
      aria-busy={busy}
    >
      {children}
    </a>
  );
}
