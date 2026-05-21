'use client';

/**
 * <DocumentTitle title="…" />
 *
 * Tiny client helper that mirrors Next.js's server-side
 * `metadata.title` + `template` behaviour for pages that cannot
 * export metadata (i.e. `'use client'` pages). Renders nothing.
 *
 * Usage (anywhere inside a client page):
 *   <DocumentTitle title="Telegram" />
 *   → document.title becomes "Telegram · KDust".
 *
 * The previous title is restored on unmount so navigating away
 * doesn't leave a stale tab name briefly before the next page
 * applies its own.
 *
 * Franck 2026-05-21.
 */
import { useEffect } from 'react';

export function DocumentTitle({ title }: { title: string }) {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prev = document.title;
    document.title = title.includes('KDust') ? title : `${title} · KDust`;
    return () => {
      document.title = prev;
    };
  }, [title]);
  return null;
}
