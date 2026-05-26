import Link from 'next/link';
import { headers } from 'next/headers';
import { ChevronRight } from 'lucide-react';
import { breadcrumbCrumbs } from '@/lib/project-url';
import { isReservedName } from '@/lib/folder-path';

/**
 * <ScopePath fsPath="a/b/c" />
 *
 * Server component rendering the current hierarchy location as the
 * FIRST line of a page body (Franck 2026-05-26):
 *   root › L1 › L2 › project
 *
 * Replaces the legacy scope suffix that used to be shown in the
 * <TopBar> next to the page title. Each crumb is a navigable link
 * that PRESERVES the current sub-page tail (`/task`, `/run`,
 * `/conversation`, ...) so the user can broaden / narrow the scope
 * without losing the page they were on.
 *
 * `root` always links to the application root for the same sub-page.
 */
export async function ScopePath({ fsPath }: { fsPath: string }) {
  // Extract the sub-page tail from the current request pathname so
  // that, e.g. on `/Perso/fsallet/KDust/run?foo=bar`, the crumbs
  // link to `/run`, `/Perso/run`, `/Perso/fsallet/run`,
  // `/Perso/fsallet/KDust/run`. Reserved names (see
  // RESERVED_URL_NAMES) mark the start of the sub-page tail.
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
  const rootHref = subTail || '/';

  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-3 text-xs text-slate-500 dark:text-slate-400"
    >
      <ol className="flex flex-wrap items-center gap-1">
        <li>
          <Link
            href={rootHref}
            className="hover:text-slate-700 dark:hover:text-slate-200 hover:underline"
          >
            root
          </Link>
        </li>
        {crumbs.map((c) => (
          <li key={c.href} className="flex items-center gap-1">
            <ChevronRight size={12} aria-hidden className="text-slate-300 dark:text-slate-600" />
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
