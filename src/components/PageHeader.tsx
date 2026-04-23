import type { ReactNode } from 'react';

/**
 * Standard page header (Franck 2026-04-23 22:46).
 *
 * Replaces the per-page `<h1 class="text-2xl font-bold">Title
 * <span class="ml-2 ...">scope</span></h1>` hand-rolled structure
 * that drifted across /conversations, /tasks, /runs, /projects etc.
 *
 * Layout:
 *   [icon] Title · scope           [right-slot (counters, actions)]
 *
 * Props:
 *   - icon:     optional lucide icon node, rendered at 20px muted
 *   - title:    page name ("Conversations", "Runs", …)
 *   - scope:    optional suffix rendered muted and italicless
 *              (typically the current project or filter context)
 *   - right:    right-aligned slot for counters, bulk actions,
 *               toggles. Pushed with ml-auto.
 *
 * Typography: text-2xl / font-bold on the title (18 pages already
 * use this), text-base / font-normal / text-slate-500 on the
 * scope — canonicalised here once.
 */
type Props = {
  icon?: ReactNode;
  title: ReactNode;
  scope?: ReactNode;
  right?: ReactNode;
  className?: string;
};

export function PageHeader({ icon, title, scope, right, className = '' }: Props) {
  return (
    <div className={'flex items-center gap-3 mb-4 ' + className}>
      {icon && <span className="text-slate-400 shrink-0">{icon}</span>}
      <h1 className="text-2xl font-bold flex items-baseline gap-2 min-w-0">
        <span className="truncate">{title}</span>
        {scope && (
          <span className="text-base font-normal text-slate-500 truncate">
            {'\u00b7 '}
            {scope}
          </span>
        )}
      </h1>
      {right && <div className="ml-auto flex items-center gap-2 shrink-0">{right}</div>}
    </div>
  );
}
