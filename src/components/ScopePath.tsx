import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { breadcrumbCrumbs } from '@/lib/project-url';

/**
 * <ScopePath fsPath="a/b/c" />
 *
 * Hierarchy breadcrumb rendered as the FIRST line of each page
 * body (Franck 2026-05-26):
 *
 *   root › L1 › L2 › project
 *
 * Pure hierarchy navigation: every crumb links to the dashboard
 * of its scope (root → `/`, L1 → `/L1`, L2 → `/L1/L2`, project →
 * `/L1/L2/project`). Sub-page (Tasks / Runs / Conversations) is
 * NOT preserved — the user explicitly walks back to a dashboard.
 *
 * Replaces the legacy hierarchy suffix that lived in the TopBar
 * title slot and the ad-hoc "↑ parent" tile on folder pages.
 */
export function ScopePath({ fsPath }: { fsPath: string }) {
  const crumbs = breadcrumbCrumbs(fsPath);
  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-3 text-xs text-slate-500 dark:text-slate-400"
    >
      <ol className="flex flex-wrap items-center gap-1">
        <li>
          <Link
            href="/"
            className="hover:text-slate-700 dark:hover:text-slate-200 hover:underline"
          >
            root
          </Link>
        </li>
        {crumbs.map((c) => (
          <li key={c.href} className="flex items-center gap-1">
            <ChevronRight size={12} aria-hidden className="text-slate-300 dark:text-slate-600" />
            <Link
              href={c.href}
              className="hover:text-slate-700 dark:hover:text-slate-200 hover:underline"
            >
              {c.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
