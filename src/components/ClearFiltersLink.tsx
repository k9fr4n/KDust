import Link from 'next/link';

/**
 * Clear-filters link (Franck 2026-04-23 22:46).
 *
 * Identical visual treatment across /conversation, /task, /run
 * (amber outline, amber text). Centralised here so future style
 * changes don't require a search-and-replace across pages.
 */
export function ClearFiltersLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="px-3 py-1.5 rounded border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 text-sm transition-colors"
    >
      Clear filters
    </Link>
  );
}
