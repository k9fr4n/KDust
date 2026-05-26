import { MessageSquare } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentScope, scopedWhere, buildProjectUrl } from '@/lib/project-url';
// OpenConversationLink is still used by ConversationCard under the
// hood; we render ConversationCard directly now so we inherit the
// always-visible pin / delete action cluster (Franck 2026-04-20 17:45).
import { ConversationCard } from '@/components/ConversationCard';
import { Pagination } from '@/components/Pagination';
import { ViewportProbe } from '@/components/ViewportProbe';
import { LiveSearchInput } from '@/components/LiveSearchInput';
import { PageHeader } from '@/components/PageHeader';
import { ScopePath } from '@/components/ScopePath';
import { ClearFiltersLink } from '@/components/ClearFiltersLink';
import { getAdaptivePageSize } from '@/lib/adaptive-page-size';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Conversations' };

// Adaptive pagination (Franck 2026-04-23 14:04). Conversation
// cards are \u224870px each (title + agent line + timestamp). Reserved
// vertical = top nav + page title + search form + agent pills
// row + pagination footer \u2248 280px. Fallback 50 matches the
// previous fixed value.
const CONV_PAGE_SIZE_CFG = {
  // Two-line card: title + agent/project row under py-2 padding.
  // Measured \u224848px. Previous 60 left a small gap at the bottom.
  rowPx: 48,
  // No table header; anchor sits at the top of the first card.
  fallback: 20,
  min: 10,
  max: 100,
};

type SearchProps = {
  searchParams?: Promise<{ q?: string; page?: string }>;
};

/**
 * /conversation — Full list of chat conversations.
 *
 * Filters (query string):
 *   ?agent=<sId>       restrict to a single agent
 *   ?q=<text>          case-insensitive title substring
 *   ?limit=<n>         default 100, max 500
 *
 * Project scope: driven by the top navbar project selector
 * (kdust_project cookie). No per-page project filter UI.
 *   - no cookie ("All projects") → every conversation, global + all projects
 *   - cookie set                 → only that project's conversations
 */
export default async function ConversationsPage({ searchParams }: SearchProps) {
  const sp = (await searchParams) ?? {};
  // ADR-0020: scope is resolved from the URL when this page is
  // rendered under /[l1]/.../conversation; falls back to the
  // kdust_project cookie for the legacy /conversation route.
  const scope = await getCurrentScope();
  const q = (sp.q ?? '').trim();
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const PAGE_SIZE = await getAdaptivePageSize(CONV_PAGE_SIZE_CFG);

  const where: Record<string, unknown> = { ...scopedWhere('projectName', scope) };
  // Live search (Franck 2026-04-30): match the query against the
  // conversation title OR any message content. SQLite `contains`
  // is a LIKE filter; acceptable at current volume, FTS5 would be
  // the next step if latency degrades.
  if (q) {
    where.OR = [
      { title: { contains: q } },
      { messages: { some: { content: { contains: q } } } },
    ];
  }

  // Parallel count + page fetch. count() respects the `where` so
  // the total reflects the active filter (project, agent, q). The
  // Pagination component computes totalPages from `total / PAGE_SIZE`.
  const [total, conversations] = await Promise.all([
    db.conversation.count({ where }),
    db.conversation.findMany({
      where,
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { _count: { select: { messages: true } } },
    }),
  ]);

  return (
    <div className="w-full">
      <ViewportProbe />
      <PageHeader
        icon={<MessageSquare size={20} />}
        title="Conversations"
      />
      <ScopePath fsPath={scope.fsPath} />

      {/* Live search (Franck 2026-04-23 22:29). Replaces the old
          form + submit button with a debounced input that updates
          the `q` query-string parameter as the user types; the
          server component re-runs on URL change. Clear-filters
          link kept for an explicit reset path (also clears the
          agent pill). Sibling query params like `agent` are
          preserved by LiveSearchInput so no hidden input is
          needed anymore. */}
      <div className="mb-4 flex gap-2">
        <LiveSearchInput placeholder="Search by title…" />
        {q && <ClearFiltersLink href={buildScopedBase(scope, 'conversation')} />}
      </div>

      <div id="rows-anchor" />
      {conversations.length === 0 ? (
        <p className="text-slate-500 text-sm">No conversations match these filters.</p>
      ) : (
        <ul className="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-200 dark:divide-slate-800">
          {conversations.map((c) => (
            <ConversationCard
              key={c.id}
              conv={{
                id: c.id,
                title: c.title,
                agentName: c.agentName,
                agentSId: c.agentSId,
                projectName: c.projectName,
                pinned: c.pinned,
                updatedAt: c.updatedAt,
              }}
            />
          ))}
        </ul>
      )}

      {/* Pagination keeps the active filters (q) so paging
          through a narrowed list works as expected. */}
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        unit="conversations"
        buildHref={(p) => buildHref(scope, { q, page: p })}
      />
    </div>
  );
}

/**
 * Base path for the conversation list under the active scope.
 * Used by ClearFiltersLink and the pagination href builder so all
 * intra-page links preserve the URL prefix (legacy /conversation,
 * folder /<l1>/.../conversation, project /<l1>/<l2>/<project>/conversation).
 */
function buildScopedBase(
  scope: { kind: 'root' | 'folder' | 'project'; fsPath: string },
  sub: string,
): string {
  if (scope.kind === 'root') return `/${sub}`;
  return buildProjectUrl(scope.fsPath, sub);
}

function buildHref(
  scope: { kind: 'root' | 'folder' | 'project'; fsPath: string },
  { q, page }: { q?: string; page?: number },
) {
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (page && page > 1) qs.set('page', String(page));
  const base = buildScopedBase(scope, 'conversation');
  return `${base}${qs.toString() ? `?${qs}` : ''}`;
}
