'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Card-shaped clickable link that:
 *   1. POSTs /api/current-project to set the project cookie,
 *   2. Dispatches `kdust:project-changed` so ProjectSwitcher stays in sync,
 *   3. Navigates to / (the project-scoped dashboard will render).
 *
 * Renders as a plain <a href="/"> for keyboard a11y and middle-click
 * open-in-new-tab. Left-click is intercepted to run the POST first.
 */
export function ProjectOpenLink({
  projectName,
  className,
  children,
}: {
  projectName: string;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onClick = async (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.button === 1) return; // let browser handle
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/current-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: projectName }),
      });
      if (!r.ok) throw new Error(`switch failed: HTTP ${r.status}`);
      window.dispatchEvent(
        new CustomEvent('kdust:project-changed', { detail: { name: projectName } }),
      );
      router.push('/');
      router.refresh();
    } catch (err) {
      console.error(err);
      // Fallback: navigate home anyway; user can pick the project from the
      // switcher if the cookie didn't get set.
      router.push('/');
    } finally {
      setBusy(false);
    }
  };

  return (
    <a href="/" onClick={onClick} className={className} aria-busy={busy}>
      {children}
    </a>
  );
}
