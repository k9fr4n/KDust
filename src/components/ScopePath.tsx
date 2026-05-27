import Link from 'next/link';
import { headers } from 'next/headers';
import { ChevronRight } from 'lucide-react';
import { breadcrumbCrumbs } from '@/lib/project-url';
import { isReservedName } from '@/lib/folder-path';

/**
 * <ScopePath fsPath="a/b/c" />
 *
 * Hierarchy breadcrumb rendered as the FIRST line of each page
 * body (Franck 2026-05-26):
 *
 *   root › L1 › L2 › project
 *
 * Navigation rules (Franck 2026-05-26 23:07):
 *   - `root`             → always `/` (explicit root scope, drops
 *                          the cookie fallback in getCurrentScope)
 *   - intermediate crumbs → PRESERVE the current sub-page tail
 *                          (`/task`, `/run`, `/conversation`)
 *                          so the user keeps the page they're on
 *                          while broadening / narrowing the scope.
 *                          e.g. clicking `Perso` from
 *                          `/Perso/fsallet/KDust/task` lands on
 *                          `/Perso/task`.
 */
export async function ScopePath({ fsPath }: { fsPath: string }) {
  // Extract the sub-page tail from the current request pathname.
  // Reserved names (RESERVED_URL_NAMES) mark its start.
  const pathname = (await headers()).get('x-pathname') ?? '';
  const parts = pathname.split('/').filter(Boolean);
  let subTail = '';
  for (let i = 0; i < parts.length; i++) {
    if (isReservedName(parts[i])) {
      subTail = '/' + parts.slice(i).join('/');
      break;
    }
  }
  const crumbs = breadcrumbCrumbs(fsPath);
  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-3 text-sm text-slate-500 dark:text-slate-400"
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
            <ChevronRight size={14} aria-hidden className="text-slate-300 dark:text-slate-600" />
            <Link
              href={`${c.href}${subTail}`}
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
