'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Wraps children in an <a>-like clickable region that:
 *   1. POSTs to /api/conversations/:id/open (sets project cookie)
 *   2. Navigates to /chat?id=:id
 *
 * A plain <Link href="/api/conversations/:id/open"> cannot be used because:
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
      const r = await fetch(`/api/conversations/${conversationId}/open`, {
        method: 'POST',
      });
      if (!r.ok) throw new Error(`open failed: HTTP ${r.status}`);
      const j = await r.json();
      // Broadcast project switch so ProjectSwitcher in the shell updates.
      window.dispatchEvent(
        new CustomEvent('kdust:project-changed', {
          detail: { name: j.projectName ?? null },
        }),
      );
      router.push(j.redirect ?? `/chat?id=${conversationId}`);
    } catch (err) {
      console.error(err);
      // Fallback: navigate anyway; the /chat layout will redirect to the
      // dashboard if the cookie is missing.
      router.push(`/chat?id=${conversationId}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <a
      href={`/chat?id=${conversationId}`}
      onClick={onClick}
      className={className}
      aria-busy={busy}
    >
      {children}
    </a>
  );
}
