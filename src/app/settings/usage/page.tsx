import Link from 'next/link';
import { db } from '@/lib/db';
import {
  ArrowLeft,
  BarChart3,
  MessageSquare,
  Folder,
  Bot,
  Activity,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Play,
  Clock,
  Minus,
} from 'lucide-react';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Comprehensive usage dashboard for KDust's activity against Dust.
 *
 * Built ENTIRELY from the local KDust database (Conversation,
 * Message, Task, TaskRun, ProjectAdvice) — no calls to the Dust
 * analytics API, which requires workspace-admin rights the user
 * doesn't have. Every conversation KDust ever initiated is persisted
 * locally (see runner.ts and /chat), so the local view is an
 * accurate mirror of the subset of Dust activity that flows through
 * KDust. (It will NOT include conversations you started directly in
 * the Dust web UI — those live only in Dust's backend.)
 *
 * Sections:
 *   1. Headline KPIs (total / 30d)
 *   2. 30-day timelines (messages, runs, conversations)
 *   3. Top agents / top projects / top tasks
 *   4. Run status breakdown
 *   5. Advice health (scores per project)
 *   6. Recent activity
 */
export default async function UsagePage() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  // Parallelise every aggregate query. Prisma doesn't have COUNT DISTINCT
  // so we fall back to findMany({distinct}) or raw groupBy where needed.
  const [
    totalConvs,
    totalMsgs,
    totalTasks,
    enabledTasks,
    totalRuns,
    recentConvs,
    recentMsgs,
    recentRuns,
    runsByStatus,
    tasksByKind,
    convsByAgent,
    convsByProject,
    runsByTask,
    biggestConvs,
    lastRuns,
    lastConvs,
    adviceRows,
    // Daily series for sparklines
    msgDailyRaw,
    runDailyRaw,
    convDailyRaw,
  ] = await Promise.all([
    db.conversation.count(),
    db.message.count(),
    db.task.count(),
    db.task.count({ where: { enabled: true } }),
    db.taskRun.count(),
    db.conversation.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    db.message.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    db.taskRun.count({ where: { startedAt: { gte: thirtyDaysAgo } } }),
    db.taskRun.groupBy({ by: ['status'], _count: { _all: true } }),
    db.task.groupBy({ by: ['kind'], _count: { _all: true } }),
    db.conversation.groupBy({
      by: ['agentSId', 'agentName'],
      _count: { _all: true },
      orderBy: { _count: { agentSId: 'desc' } },
      take: 10,
    }),
    db.conversation.groupBy({
      by: ['projectName'],
      _count: { _all: true },
      orderBy: { _count: { projectName: 'desc' } },
      take: 10,
    }),
    db.taskRun.groupBy({
      by: ['taskId'],
      _count: { _all: true },
      orderBy: { _count: { taskId: 'desc' } },
      take: 10,
    }),
    // Conversations ranked by message count. groupBy on Message is cheap
    // since we have an index on conversationId.
    db.message.groupBy({
      by: ['conversationId'],
      _count: { _all: true },
      orderBy: { _count: { conversationId: 'desc' } },
      take: 10,
    }),
    db.taskRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 8,
      include: {
        task: { select: { id: true, name: true, projectPath: true } },
      },
    }),
    db.conversation.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        id: true,
        title: true,
        agentName: true,
        projectName: true,
        createdAt: true,
        _count: { select: { messages: true } },
      },
    }),
    db.projectAdvice.findMany({
      orderBy: { generatedAt: 'desc' },
      select: {
        projectName: true,
        category: true,
        score: true,
        generatedAt: true,
        points: true,
      },
    }),
    // Use raw SQL for date bucketing — SQLite strftime. Safe: no user input.
    db.$queryRawUnsafe<{ day: string; n: bigint }[]>(
      `SELECT strftime('%Y-%m-%d', createdAt) AS day, COUNT(*) AS n
         FROM Message
         WHERE createdAt >= ?
         GROUP BY day ORDER BY day ASC`,
      thirtyDaysAgo.toISOString(),
    ),
    db.$queryRawUnsafe<{ day: string; n: bigint }[]>(
      `SELECT strftime('%Y-%m-%d', startedAt) AS day, COUNT(*) AS n
         FROM CronRun
         WHERE startedAt >= ?
         GROUP BY day ORDER BY day ASC`,
      thirtyDaysAgo.toISOString(),
    ),
    db.$queryRawUnsafe<{ day: string; n: bigint }[]>(
      `SELECT strftime('%Y-%m-%d', createdAt) AS day, COUNT(*) AS n
         FROM Conversation
         WHERE createdAt >= ?
         GROUP BY day ORDER BY day ASC`,
      thirtyDaysAgo.toISOString(),
    ),
  ]);

  // Resolve run-by-task groupBy → task metadata in a separate findMany.
  const runTaskIds = runsByTask.map((r) => r.taskId);
  const runTaskMeta = runTaskIds.length
    ? await db.task.findMany({
        where: { id: { in: runTaskIds } },
        select: { id: true, name: true, projectPath: true, kind: true },
      })
    : [];
  const runTaskById = new Map(runTaskMeta.map((t) => [t.id, t]));

  // Resolve biggest-convs groupBy → conversation metadata.
  const bigConvIds = biggestConvs.map((b) => b.conversationId);
  const bigConvMeta = bigConvIds.length
    ? await db.conversation.findMany({
        where: { id: { in: bigConvIds } },
        select: {
          id: true,
          title: true,
          agentName: true,
          projectName: true,
          createdAt: true,
        },
      })
    : [];
  const bigConvById = new Map(bigConvMeta.map((c) => [c.id, c]));

  // Build a dense 30-day series (fill missing days with 0).
  const denseSeries = (
    rows: { day: string; n: bigint }[],
  ): { day: string; n: number }[] => {
    const map = new Map(rows.map((r) => [r.day, Number(r.n)]));
    const out: { day: string; n: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
      const k = d.toISOString().slice(0, 10);
      out.push({ day: k, n: map.get(k) ?? 0 });
    }
    return out;
  };
  const msgDaily = denseSeries(msgDailyRaw);
  const runDaily = denseSeries(runDailyRaw);
  const convDaily = denseSeries(convDailyRaw);

  const sum = (s: { n: number }[]) => s.reduce((a, b) => a + b.n, 0);
  const runStatus = Object.fromEntries(
    runsByStatus.map((r) => [r.status, r._count._all]),
  );
  const kindCount = Object.fromEntries(
    tasksByKind.map((r) => [r.kind, r._count._all]),
  );
  const adviceByProject = new Map<
    string,
    { score: number | null; generatedAt: Date; pointsCount: number }
  >();
  for (const a of adviceRows) {
    const prev = adviceByProject.get(a.projectName);
    if (!prev || a.generatedAt > prev.generatedAt) {
      let pointsCount = 0;
      try {
        const parsed = JSON.parse(a.points);
        if (Array.isArray(parsed)) pointsCount = parsed.length;
      } catch {
        /* ignore malformed JSON */
      }
      adviceByProject.set(a.projectName, {
        score: a.score,
        generatedAt: a.generatedAt,
        pointsCount,
      });
    }
  }

  // Sparkline helper: inline div bars, max-height scaled by series max.
  const Sparkline = ({
    series,
    color = 'bg-brand-400',
    height = 40,
  }: {
    series: { day: string; n: number }[];
    color?: string;
    height?: number;
  }) => {
    const max = Math.max(1, ...series.map((s) => s.n));
    return (
      <div className="flex items-end gap-0.5" style={{ height }}>
        {series.map((s) => (
          <div
            key={s.day}
            className={`${color} rounded-sm w-1.5 opacity-80 hover:opacity-100`}
            style={{ height: `${Math.max(2, (s.n / max) * height)}px` }}
            title={`${s.day}: ${s.n}`}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Back-office
        </Link>
        <h1 className="text-2xl font-bold mt-2 flex items-center gap-2">
          <BarChart3 size={22} className="text-brand-500" /> Usage dashboard
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Complete stats on KDust activity against Dust. All data is
          sourced from the local KDust database — no workspace-admin
          rights required. For the source-of-truth ground view
          (including conversations started directly in the Dust web
          UI), see the official dashboard in your Dust workspace
          admin.
        </p>
      </div>

      {/* KPI cards — total and 30d */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI
          icon={<MessageSquare size={14} />}
          label="Conversations"
          value={totalConvs}
          sub={`${recentConvs} in last 30d`}
        />
        <KPI
          icon={<MessageSquare size={14} />}
          label="Messages"
          value={totalMsgs}
          sub={`${recentMsgs} in last 30d`}
        />
        <KPI
          icon={<Play size={14} />}
          label="Task runs"
          value={totalRuns}
          sub={`${recentRuns} in last 30d`}
        />
        <KPI
          icon={<Activity size={14} />}
          label="Tasks"
          value={totalTasks}
          sub={`${enabledTasks} enabled`}
        />
      </div>

      {/* 30-day timelines */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <TimelineCard
          title="Messages / day (30d)"
          total={sum(msgDaily)}
          last7={sum(msgDaily.slice(-7))}
        >
          <Sparkline series={msgDaily} color="bg-brand-400" />
        </TimelineCard>
        <TimelineCard
          title="Runs / day (30d)"
          total={sum(runDaily)}
          last7={sum(runDaily.slice(-7))}
        >
          <Sparkline series={runDaily} color="bg-amber-400" />
        </TimelineCard>
        <TimelineCard
          title="Conversations / day (30d)"
          total={sum(convDaily)}
          last7={sum(convDaily.slice(-7))}
        >
          <Sparkline series={convDaily} color="bg-purple-400" />
        </TimelineCard>
      </section>

      {/* Run status distribution + task kind */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card title="Run status distribution" icon={<Activity size={14} />}>
          <ul className="text-sm space-y-1">
            {[
              ['success', 'text-green-700 dark:text-green-300', <CheckCircle2 key="i" size={12} />],
              ['failed', 'text-red-700 dark:text-red-300', <XCircle key="i" size={12} />],
              ['aborted', 'text-orange-700 dark:text-orange-300', <XCircle key="i" size={12} />],
              ['running', 'text-blue-700 dark:text-blue-300', <Play key="i" size={12} />],
              ['no-op', 'text-slate-500', <Minus key="i" size={12} />],
              ['skipped', 'text-amber-700 dark:text-amber-300', <AlertTriangle key="i" size={12} />],
            ].map(([key, cls, icon]) => {
              const n = runStatus[key as string] ?? 0;
              const pct = totalRuns > 0 ? Math.round((n / totalRuns) * 100) : 0;
              return (
                <li key={key as string} className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1 w-20 ${cls as string}`}>
                    {icon}
                    <span className="text-xs font-mono">{key as string}</span>
                  </span>
                  <span className="flex-1 h-2 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                    <span
                      className="block h-full bg-brand-400"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="w-16 text-right text-xs font-mono">
                    {n} ({pct}%)
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title="Task breakdown" icon={<Activity size={14} />}>
          <div className="text-sm space-y-2">
            <p className="text-xs text-slate-500">
              By kind:{' '}
              <b>{kindCount.automation ?? 0}</b> automation ·{' '}
              <b>{kindCount.advice ?? 0}</b> advice
            </p>
            <p className="text-xs text-slate-500">
              Enabled:{' '}
              <b className="text-green-700 dark:text-green-300">{enabledTasks}</b> /
              disabled:{' '}
              <b className="text-slate-500">{totalTasks - enabledTasks}</b>
            </p>
            <p className="text-xs text-slate-500">
              Runs over last 7d:{' '}
              <b>{sum(runDaily.slice(-7))}</b> · over 30d:{' '}
              <b>{sum(runDaily)}</b>
            </p>
            <p className="text-xs text-slate-500">
              Avg runs/day (30d):{' '}
              <b>{(sum(runDaily) / 30).toFixed(1)}</b>
            </p>
          </div>
        </Card>
      </section>

      {/* Top agents / projects / tasks */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card title="Top agents" icon={<Bot size={14} />}>
          <RankedList
            items={convsByAgent.map((r) => ({
              label: r.agentName ?? r.agentSId.slice(0, 10),
              sub: r.agentSId,
              count: r._count._all,
            }))}
            empty="No conversations yet"
          />
        </Card>
        <Card title="Top projects" icon={<Folder size={14} />}>
          <RankedList
            items={convsByProject.map((r) => ({
              label: r.projectName ?? '(global)',
              count: r._count._all,
            }))}
            empty="No conversations yet"
          />
        </Card>
        <Card title="Top tasks (by runs)" icon={<Play size={14} />}>
          <RankedList
            items={runsByTask.map((r) => {
              const t = runTaskById.get(r.taskId);
              return {
                label: t?.name ?? '(deleted)',
                sub: t?.projectPath,
                count: r._count._all,
                href: t ? `/tasks/${t.id}` : undefined,
              };
            })}
            empty="No runs yet"
          />
        </Card>
      </section>

      {/* Advice health */}
      {adviceByProject.size > 0 && (
        <Card
          title="Advice health per project"
          icon={<Activity size={14} />}
          right={<Link href="/advice" className="text-xs text-brand-500 hover:underline">view all →</Link>}
        >
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-1">Project</th>
                <th className="py-1 text-right">Score</th>
                <th className="py-1 text-right">Points</th>
                <th className="py-1 text-right">Last update</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(adviceByProject.entries())
                .sort(
                  ([, a], [, b]) =>
                    (a.score ?? 101) - (b.score ?? 101),
                )
                .slice(0, 15)
                .map(([project, a]) => (
                  <tr
                    key={project}
                    className="border-t border-slate-200 dark:border-slate-800"
                  >
                    <td className="py-1">
                      <Link
                        href={`/projects/${encodeURIComponent(project)}#advice`}
                        className="hover:underline"
                      >
                        {project}
                      </Link>
                    </td>
                    <td className="py-1 text-right font-mono">
                      {a.score !== null ? (
                        <span
                          className={
                            a.score < 50
                              ? 'text-red-600'
                              : a.score < 70
                              ? 'text-amber-600'
                              : 'text-green-600'
                          }
                        >
                          {a.score}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="py-1 text-right font-mono">{a.pointsCount}</td>
                    <td className="py-1 text-right text-xs text-slate-500">
                      {a.generatedAt.toLocaleDateString()}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Biggest conversations */}
      <Card
        title="Largest conversations (by message count)"
        icon={<MessageSquare size={14} />}
      >
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="py-1">Title</th>
              <th className="py-1">Agent</th>
              <th className="py-1">Project</th>
              <th className="py-1 text-right">Msgs</th>
              <th className="py-1 text-right">Started</th>
            </tr>
          </thead>
          <tbody>
            {biggestConvs.map((b) => {
              const c = bigConvById.get(b.conversationId);
              if (!c) return null;
              return (
                <tr
                  key={c.id}
                  className="border-t border-slate-200 dark:border-slate-800"
                >
                  <td className="py-1">
                    <Link
                      href={`/conversations/${c.id}`}
                      className="hover:underline truncate block max-w-xs"
                    >
                      {c.title}
                    </Link>
                  </td>
                  <td className="py-1 text-xs">{c.agentName ?? '-'}</td>
                  <td className="py-1 text-xs font-mono text-slate-500">
                    {c.projectName ?? '(global)'}
                  </td>
                  <td className="py-1 text-right font-mono">
                    {b._count._all}
                  </td>
                  <td className="py-1 text-right text-xs text-slate-500">
                    {c.createdAt.toLocaleDateString()}
                  </td>
                </tr>
              );
            })}
            {biggestConvs.length === 0 && (
              <tr>
                <td colSpan={5} className="py-3 text-xs text-slate-400 italic text-center">
                  No conversations yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Recent activity */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card
          title="Recent runs"
          icon={<Clock size={14} />}
          right={<Link href="/runs" className="text-xs text-brand-500 hover:underline">all →</Link>}
        >
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {lastRuns.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 py-1.5 text-xs"
              >
                <StatusDot status={r.status} />
                <span className="truncate flex-1">
                  {r.task ? (
                    <Link
                      href={`/tasks/${r.task.id}`}
                      className="hover:underline"
                    >
                      {r.task.name}
                    </Link>
                  ) : (
                    <span className="text-slate-400">(deleted)</span>
                  )}
                </span>
                <span className="text-slate-400">
                  {new Date(r.startedAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </li>
            ))}
            {lastRuns.length === 0 && (
              <li className="py-3 text-slate-400 italic text-center">
                No runs yet.
              </li>
            )}
          </ul>
        </Card>

        <Card
          title="Recent conversations"
          icon={<MessageSquare size={14} />}
          right={<Link href="/conversations" className="text-xs text-brand-500 hover:underline">all →</Link>}
        >
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {lastConvs.map((c) => (
              <li key={c.id} className="flex items-center gap-2 py-1.5 text-xs">
                <span className="truncate flex-1">
                  <Link href={`/conversations/${c.id}`} className="hover:underline">
                    {c.title}
                  </Link>
                </span>
                <span className="text-slate-500 font-mono">{c._count.messages}m</span>
                <span className="text-slate-400">
                  {new Date(c.createdAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </li>
            ))}
            {lastConvs.length === 0 && (
              <li className="py-3 text-slate-400 italic text-center">
                No conversations yet.
              </li>
            )}
          </ul>
        </Card>
      </section>

      <p className="text-[10px] text-slate-400 pt-4 border-t border-slate-200 dark:border-slate-800">
        KDust mirrors conversations it initiates into its local DB. The
        Dust workspace may contain additional activity (users chatting
        directly in the web UI, Slack, extensions, …) not shown here.
        For the authoritative cross-surface view, see your Dust
        workspace admin dashboard. Timestamps use server local time.
      </p>
    </div>
  );
}

/* ------------------ Small presentational helpers ------------------ */

function KPI({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub?: string;
}) {
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-white dark:bg-slate-900">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500">
        {icon} {label}
      </div>
      <div className="text-2xl font-bold mt-1 font-mono">
        {value.toLocaleString()}
      </div>
      {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
    </div>
  );
}

function Card({
  title,
  icon,
  right,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-white dark:bg-slate-900">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 inline-flex items-center gap-1">
          {icon} {title}
        </h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function TimelineCard({
  title,
  total,
  last7,
  children,
}: {
  title: string;
  total: number;
  last7: number;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-white dark:bg-slate-900">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-400">
          {title}
        </h3>
        <span className="text-[10px] text-slate-400 font-mono">
          {total} · 7d: {last7}
        </span>
      </div>
      {children}
    </div>
  );
}

function RankedList({
  items,
  empty,
}: {
  items: {
    label: string;
    sub?: string;
    count: number;
    href?: string;
  }[];
  empty: string;
}) {
  if (items.length === 0)
    return (
      <p className="text-xs text-slate-400 italic text-center py-3">{empty}</p>
    );
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="space-y-1 text-xs">
      {items.map((it, i) => (
        <li key={`${it.label}-${i}`} className="flex items-center gap-2">
          <span className="w-4 text-slate-400 text-right font-mono">{i + 1}</span>
          <span className="flex-1 min-w-0">
            {it.href ? (
              <Link href={it.href} className="hover:underline truncate block">
                {it.label}
              </Link>
            ) : (
              <span className="truncate block">{it.label}</span>
            )}
            {it.sub && (
              <span className="text-[10px] text-slate-400 font-mono truncate block">
                {it.sub}
              </span>
            )}
          </span>
          <span className="w-16 h-1.5 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
            <span
              className="block h-full bg-brand-400"
              style={{ width: `${(it.count / max) * 100}%` }}
            />
          </span>
          <span className="w-10 text-right font-mono">{it.count}</span>
        </li>
      ))}
    </ul>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'success'
      ? 'bg-green-500'
      : status === 'failed'
      ? 'bg-red-500'
      : status === 'aborted'
      ? 'bg-orange-500'
      : status === 'running'
      ? 'bg-blue-500'
      : 'bg-slate-400';
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full ${color}`}
      title={status}
    />
  );
}
