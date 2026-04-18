import Link from 'next/link';
import { MessageSquare, Pin } from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentProjectName } from '@/lib/current-project';
import { OpenConversationLink } from '@/components/OpenConversationLink';

export const dynamic = 'force-dynamic';

type SearchProps = {
  searchParams?: Promise<{ agent?: string; project?: string; q?: string; limit?: string }>;
};

/**
 * /conversations — Full list of chat conversations.
 *
 * Filters (query string):
 *   ?agent=<sId>       restrict to a single agent
 *   ?project=<name>    restrict to a project ("_global" to force global-only)
 *   ?q=<text>          case-insensitive title substring
 *   ?limit=<n>         default 100, max 500
 *
 * Scope: if a current project is selected via the top selector (cookie),
 * the default view shows that project's conversations + global ones.
 * A ?project=<name> override bypasses the cookie.
 */
export default async function ConversationsPage({ searchParams }: SearchProps) {
  const sp = (await searchParams) ?? {};
  const cookieProject = await getCurrentProjectName();
  const projectFilter = sp.project ?? undefined;
  const agentFilter = sp.agent ?? undefined;
  const q = (sp.q ?? '').trim();
  const limit = Math.min(500, Math.max(1, parseInt(sp.limit ?? '100', 10) || 100));

  const where: Record<string, unknown> = {};
  if (agentFilter) where.agentSId = agentFilter;
  if (projectFilter === '_global') where.projectName = null;
  else if (projectFilter) where.projectName = projectFilter;
  else if (cookieProject) {
    // default behaviour: project-scoped + global conversations
    where.OR = [{ projectName: cookieProject }, { projectName: null }];
  }
  if (q) where.title = { contains: q };

  const conversations = await db.conversation.findMany({
    where,
    orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
    take: limit,
    include: { _count: { select: { messages: true } } },
  });

  // Distinct agents/projects for the filter chips (from the current page result + a cheap query)
  const [allAgents, allProjects] = await Promise.all([
    db.conversation.findMany({
      select: { agentSId: true, agentName: true },
      distinct: ['agentSId'],
      take: 50,
    }),
    db.conversation.findMany({
      select: { projectName: true },
      distinct: ['projectName'],
      take: 50,
    }),
  ]);

  return (
    <div className="w-full">
      <div className="flex items-center gap-3 mb-4">
        <MessageSquare className="text-slate-400" />
        <h1 className="text-2xl font-bold">Conversations</h1>
        {cookieProject && !projectFilter && (
          <span className="text-base font-normal text-slate-500">
            · {cookieProject} + global
          </span>
        )}
        <span className="text-sm text-slate-500 ml-auto">{conversations.length} shown</span>
      </div>

      {/* Search */}
      <form method="get" action="/conversations" className="mb-4 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by title…"
          className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm"
        />
        {agentFilter && <input type="hidden" name="agent" value={agentFilter} />}
        {projectFilter && <input type="hidden" name="project" value={projectFilter} />}
        <button
          type="submit"
          className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm"
        >
          Search
        </button>
        {(q || agentFilter || projectFilter) && (
          <Link
            href="/conversations"
            className="px-3 py-1.5 rounded border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 text-sm"
          >
            Clear filters
          </Link>
        )}
      </form>

      {/* Project filter pills — hidden when a project is already
          scoped via the top switcher (cookieProject). In that case
          the scope is conveyed by the page subtitle "· {project} +
          global" and changing project is done via the top switcher,
          so this row would be redundant noise. */}
      {!cookieProject && allProjects.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-4 text-xs">
          <FilterPill label="Project:" value={projectFilter ?? 'all'} />
          <Link
            href={buildHref({ project: undefined, agent: agentFilter, q })}
            className={pillCls(!projectFilter)}
          >
            all projects
          </Link>
          <Link
            href={buildHref({ project: '_global', agent: agentFilter, q })}
            className={pillCls(projectFilter === '_global')}
          >
            global only
          </Link>
          {allProjects
            .map((p) => p.projectName)
            .filter((p): p is string => !!p)
            .sort()
            .map((p) => (
              <Link
                key={p}
                href={buildHref({ project: p, agent: agentFilter, q })}
                className={pillCls(projectFilter === p)}
              >
                {p}
              </Link>
            ))}
        </div>
      )}

      {allAgents.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-4 text-xs">
          <FilterPill label="Agent:" value={agentFilter ?? 'all'} />
          <Link
            href={buildHref({ project: projectFilter, agent: undefined, q })}
            className={pillCls(!agentFilter)}
          >
            all agents
          </Link>
          {allAgents
            .sort((a, b) => (a.agentName ?? '').localeCompare(b.agentName ?? ''))
            .map((a) => (
              <Link
                key={a.agentSId}
                href={buildHref({ project: projectFilter, agent: a.agentSId, q })}
                className={pillCls(agentFilter === a.agentSId)}
              >
                {a.agentName ?? a.agentSId}
              </Link>
            ))}
        </div>
      )}

      {conversations.length === 0 ? (
        <p className="text-slate-500 text-sm">No conversations match these filters.</p>
      ) : (
        <ul className="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-200 dark:divide-slate-800">
          {conversations.map((c) => (
            <li key={c.id}>
              <OpenConversationLink
                conversationId={c.id}
                className="block px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-900"
              >
                <div className="flex items-center gap-2">
                  {c.pinned && <Pin size={12} className="text-amber-500 shrink-0" />}
                  <span className="font-medium truncate flex-1">{c.title}</span>
                  <span className="text-xs text-slate-400 shrink-0">
                    {new Date(c.updatedAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  {/* Project first, then agent — project is the most
                      meaningful grouping dimension for users, the
                      agent is secondary metadata. */}
                  <span className="font-mono">
                    {c.projectName ? c.projectName : <em className="italic">global</em>}
                  </span>
                  <span className="inline-block px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                    {c.agentName ?? c.agentSId}
                  </span>
                  <span>· {c._count.messages} message(s)</span>
                </div>
              </OpenConversationLink>
            </li>
          ))}
        </ul>
      )}
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

function FilterPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-slate-500 self-center">
      {label} <span className="font-mono text-slate-700 dark:text-slate-300">{value}</span>
    </span>
  );
}

function buildHref({
  project,
  agent,
  q,
}: {
  project?: string;
  agent?: string;
  q?: string;
}) {
  const qs = new URLSearchParams();
  if (project) qs.set('project', project);
  if (agent) qs.set('agent', agent);
  if (q) qs.set('q', q);
  return `/conversations${qs.toString() ? `?${qs}` : ''}`;
}
