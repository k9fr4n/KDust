import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentProjectName } from '@/lib/current-project';
// OpenConversationLink is still used by ConversationCard under the
// hood; we render ConversationCard directly now so we inherit the
// always-visible pin / delete action cluster (Franck 2026-04-20 17:45).
import { ConversationCard } from '@/components/ConversationCard';
import { Pagination } from '@/components/Pagination';
import { ViewportProbe } from '@/components/ViewportProbe';
import { getAdaptivePageSize } from '@/lib/adaptive-page-size';

export const dynamic = 'force-dynamic';

// Adaptive pagination (Franck 2026-04-23 14:04). Conversation
// cards are \u224870px each (title + agent line + timestamp). Reserved
// vertical = top nav + page title + search form + agent pills
// row + pagination footer \u2248 280px. Fallback 50 matches the
// previous fixed value.
const CONV_PAGE_SIZE_CFG = {
  rowPx: 60,
  // No table header; anchor sits at the top of the first card.
  fallback: 20,
  min: 10,
  max: 100,
};

type SearchProps = {
  searchParams?: Promise<{ agent?: string; q?: string; page?: string }>;
};

/**
 * /conversations — Full list of chat conversations.
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
  const cookieProject = await getCurrentProjectName();
  const agentFilter = sp.agent ?? undefined;
  const q = (sp.q ?? '').trim();
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const PAGE_SIZE = await getAdaptivePageSize(CONV_PAGE_SIZE_CFG);

  const where: Record<string, unknown> = {};
  if (cookieProject) where.projectName = cookieProject;
  if (agentFilter) where.agentSId = agentFilter;
  if (q) where.title = { contains: q };

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

  const allAgents = await db.conversation.findMany({
    select: { agentSId: true, agentName: true },
    distinct: ['agentSId'],
    take: 50,
  });

  return (
    <div className="w-full">
      <ViewportProbe />
      <div className="flex items-center gap-3 mb-4">
        <MessageSquare className="text-slate-400" />
        <h1 className="text-2xl font-bold">
          Conversations
          {cookieProject && (
            <span className="ml-2 text-base font-normal text-slate-500">
              · {cookieProject}
            </span>
          )}
        </h1>
        <span className="text-sm text-slate-500 ml-auto">
          {conversations.length} shown · {total.toLocaleString('fr-FR')} total
        </span>
      </div>

      <form method="get" action="/conversations" className="mb-4 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by title…"
          className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm"
        />
        {agentFilter && <input type="hidden" name="agent" value={agentFilter} />}
        <button
          type="submit"
          className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm"
        >
          Search
        </button>
        {(q || agentFilter) && (
          <Link
            href="/conversations"
            className="px-3 py-1.5 rounded border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 text-sm"
          >
            Clear filters
          </Link>
        )}
      </form>

      {allAgents.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-4 text-xs">
          <span className="text-slate-500 self-center">
            Agent: <span className="font-mono text-slate-700 dark:text-slate-300">{agentFilter ?? 'all'}</span>
          </span>
          <Link
            href={buildHref({ agent: undefined, q })}
            className={pillCls(!agentFilter)}
          >
            all agents
          </Link>
          {allAgents
            .sort((a, b) => (a.agentName ?? '').localeCompare(b.agentName ?? ''))
            .map((a) => (
              <Link
                key={a.agentSId}
                href={buildHref({ agent: a.agentSId, q })}
                className={pillCls(agentFilter === a.agentSId)}
              >
                {a.agentName ?? a.agentSId}
              </Link>
            ))}
        </div>
      )}

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

      {/* Pagination keeps the active filters (agent, q) so paging
          through a narrowed list works as expected. */}
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        unit="conversations"
        buildHref={(p) => buildHref({ agent: agentFilter, q, page: p })}
      />
    </div>
  );
}

function pillCls(active: boolean) {
  return [
    'px-2 py-1 rounded border',
    active
      ? 'bg-brand-600 border-brand-600 text-white font-semibold'
      : 'border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800',
  ].join(' ');
}

function buildHref({ agent, q, page }: { agent?: string; q?: string; page?: number }) {
  const qs = new URLSearchParams();
  if (agent) qs.set('agent', agent);
  if (q) qs.set('q', q);
  if (page && page > 1) qs.set('page', String(page));
  return `/conversations${qs.toString() ? `?${qs}` : ''}`;
}
