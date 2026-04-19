import Link from 'next/link';
import { db } from '@/lib/db';
import { resolveRange, type RangeKey } from '@/lib/usage/range';
import { TimeRangeSelector } from '@/components/TimeRangeSelector';
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
  Hash,
  Wrench,
  Zap,
} from 'lucide-react';

/**
 * Approximate character-to-token ratio used across OpenAI / Anthropic
 * tokenizers for mixed English/French prose. 4 chars ~ 1 token is the
 * canonical rule of thumb. We use it here to derive a *rough* token
 * estimate from Message.content length, since KDust doesn't store the
 * exact LLM token count today (Dust's streaming API surfaces the raw
 * text deltas, not per-message usage stats). Label as "est." in UI.
 *
 * If we later instrument the stream loop in src/lib/dust/chat.ts to
 * count `generation_tokens` events and persist the true count on
 * Message, this constant becomes a fallback for legacy rows only.
 */
const CHARS_PER_TOKEN = 4;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Comprehensive usage dashboard for KDust's activity against Dust.
 *
 * Built ENTIRELY from the local KDust database (Conversation,
 * Message, Task, TaskRun, ProjectAudit) — no calls to the Dust
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
 *   5. Audit health (scores per project)
 *   6. Recent activity
 */
export default async function UsagePage({
  searchParams,
}: {
  // Next.js 15: searchParams is always a Promise in server components.
  searchParams: Promise<{ range?: string }>;
}) {
  // Grafana-style window: default 30d, URL-driven via ?range=.
  // thirtyDaysAgo / "30d" are retained as legacy variable names below
  // for minimal-diff reasons but now resolve to the user's selection.
  const sp = await searchParams;
  const range = resolveRange(sp?.range);
  const now = range.end;
  const thirtyDaysAgo = range.start;
  const rangeLabel = range.label;
  const bucketFmt = range.bucketFmt;
  const isAllTime = range.key === 'all';

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
    tokenByRoleRaw,
    tokenDailyRaw,
    // Dust stream observability (agent messages only)
    streamAggRaw,
    toolCallsDailyRaw,
    eventTypeAggRaw,
    topToolConvsRaw,
    slowestMsgsRaw,
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
    db.projectAudit.findMany({
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
      `SELECT strftime('${bucketFmt}', createdAt, 'localtime') AS day, COUNT(*) AS n
         FROM Message
         WHERE createdAt >= ?
         GROUP BY day ORDER BY day ASC`,
      thirtyDaysAgo.toISOString(),
    ),
    db.$queryRawUnsafe<{ day: string; n: bigint }[]>(
      `SELECT strftime('${bucketFmt}', startedAt, 'localtime') AS day, COUNT(*) AS n
         FROM CronRun
         WHERE startedAt >= ?
         GROUP BY day ORDER BY day ASC`,
      thirtyDaysAgo.toISOString(),
    ),
    db.$queryRawUnsafe<{ day: string; n: bigint }[]>(
      `SELECT strftime('${bucketFmt}', createdAt, 'localtime') AS day, COUNT(*) AS n
         FROM Conversation
         WHERE createdAt >= ?
         GROUP BY day ORDER BY day ASC`,
      thirtyDaysAgo.toISOString(),
    ),
    // Token-proxy aggregates (total chars by role; we divide by
    // CHARS_PER_TOKEN client-side). Single query returns user/agent
    // totals + 30d totals in one round-trip to keep the dashboard
    // load time flat regardless of message volume.
    db.$queryRawUnsafe<
      { role: string; totalChars: bigint | number; recentChars: bigint | number }[]
    >(
      `SELECT role,
              COALESCE(SUM(length(content)), 0) AS totalChars,
              COALESCE(SUM(CASE WHEN createdAt >= ? THEN length(content) ELSE 0 END), 0) AS recentChars
         FROM Message
         GROUP BY role`,
      thirtyDaysAgo.toISOString(),
    ),
    // Daily token-proxy series (chars/day, all roles mixed) for the
    // sparkline. Cheap: Message.createdAt is indexed via FK.
    db.$queryRawUnsafe<{ day: string; n: bigint | number }[]>(
      `SELECT strftime('${bucketFmt}', createdAt, 'localtime') AS day,
              COALESCE(SUM(length(content)), 0) AS n
         FROM Message
         WHERE createdAt >= ?
         GROUP BY day ORDER BY day ASC`,
      thirtyDaysAgo.toISOString(),
    ),
    // ─── Dust stream observability ─────────────────────────────
    // Aggregate tool-call / stream-duration totals (agent msgs only).
    // Legacy rows before the schema bump have toolCalls=0 & durationMs=NULL.
    db.$queryRawUnsafe<
      {
        nMsgs: bigint | number;
        nMsgsWithStats: bigint | number;
        totalToolCalls: bigint | number;
        totalDurationMs: bigint | number;
        maxToolCalls: bigint | number;
        recentToolCalls: bigint | number;
        recentDurationMs: bigint | number;
      }[]
    >(
      `SELECT
         COUNT(*) AS nMsgs,
         COALESCE(SUM(CASE WHEN streamStats IS NOT NULL THEN 1 ELSE 0 END), 0) AS nMsgsWithStats,
         COALESCE(SUM(toolCalls), 0) AS totalToolCalls,
         COALESCE(SUM(durationMs), 0) AS totalDurationMs,
         COALESCE(MAX(toolCalls), 0) AS maxToolCalls,
         COALESCE(SUM(CASE WHEN createdAt >= ? THEN toolCalls ELSE 0 END), 0) AS recentToolCalls,
         COALESCE(SUM(CASE WHEN createdAt >= ? THEN durationMs ELSE 0 END), 0) AS recentDurationMs
       FROM Message WHERE role='agent'`,
      thirtyDaysAgo.toISOString(),
      thirtyDaysAgo.toISOString(),
    ),
    // Daily tool-call sum for sparkline (30d).
    db.$queryRawUnsafe<{ day: string; n: bigint | number }[]>(
      `SELECT strftime('${bucketFmt}', createdAt, 'localtime') AS day,
              COALESCE(SUM(toolCalls), 0) AS n
         FROM Message
         WHERE role='agent' AND createdAt >= ?
         GROUP BY day ORDER BY day ASC`,
      thirtyDaysAgo.toISOString(),
    ),
    // All streamStats JSON blobs (30d window) — parsed in JS to
    // aggregate event types. streamStats is small (<300 bytes) so
    // full-text SUM would be inaccurate; parsing is the correct path.
    // We also fetch toolNames for the "top tools" leaderboard.
    db.message.findMany({
      where: {
        role: 'agent',
        createdAt: { gte: thirtyDaysAgo },
        NOT: { streamStats: null },
      },
      select: { streamStats: true, toolNames: true },
    }),
    // Conversations with the most tool-heavy agent turns (agent msg
    // with max toolCalls wins). Useful to spot "the agent did 80 tool
    // calls in one turn" outliers.
    db.message.findMany({
      where: { role: 'agent', toolCalls: { gt: 0 } },
      orderBy: { toolCalls: 'desc' },
      take: 10,
      select: {
        id: true,
        toolCalls: true,
        toolNames: true,
        durationMs: true,
        createdAt: true,
        conversation: {
          select: { id: true, title: true, agentName: true, projectName: true },
        },
      },
    }),
    // Slowest stream turns (useful to debug agent hangs).
    db.message.findMany({
      where: { role: 'agent', durationMs: { gt: 0 } },
      orderBy: { durationMs: 'desc' },
      take: 10,
      select: {
        id: true,
        durationMs: true,
        toolCalls: true,
        createdAt: true,
        conversation: {
          select: { id: true, title: true, agentName: true, projectName: true },
        },
      },
    }),
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

  /**
   * Dense time-series over the selected range. Fills missing buckets
   * with 0 so sparklines keep a stable horizontal scale and visually
   * convey "nothing happened" rather than compressing the gap.
   *
   * The bucket width (hour / day) and label formatter come from the
   * resolved range, so this helper supports all Grafana-style
   * windows from "Today" (hourly) to "All time" (365 daily buckets).
   */
  const denseSeries = (
    rows: { day: string; n: bigint }[],
  ): { day: string; n: number }[] => {
    const map = new Map(rows.map((r) => [r.day, Number(r.n)]));
    const out: { day: string; n: number }[] = [];
    for (let i = range.bucketCount - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * range.bucketMs);
      const k = range.bucketKey(d);
      out.push({ day: k, n: map.get(k) ?? 0 });
    }
    return out;
  };
  const msgDaily = denseSeries(msgDailyRaw);
  const runDaily = denseSeries(runDailyRaw);
  const convDaily = denseSeries(convDailyRaw);

  /**
   * Roll up per-role char totals into est-token figures.
   * Semantics of roles: 'user' = prompts sent to Dust (proxy for input
   * tokens), 'agent' = streamed model output (proxy for output tokens),
   * 'system' = tool/debug messages (usually negligible).
   */
  const tokensByRole: Record<'user' | 'agent' | 'system', { total: number; recent: number }> = {
    user: { total: 0, recent: 0 },
    agent: { total: 0, recent: 0 },
    system: { total: 0, recent: 0 },
  };
  for (const row of tokenByRoleRaw) {
    const bucket =
      row.role === 'user' || row.role === 'agent' || row.role === 'system'
        ? (row.role as 'user' | 'agent' | 'system')
        : null;
    if (!bucket) continue;
    tokensByRole[bucket].total = Math.round(
      Number(row.totalChars) / CHARS_PER_TOKEN,
    );
    tokensByRole[bucket].recent = Math.round(
      Number(row.recentChars) / CHARS_PER_TOKEN,
    );
  }
  const tokensTotalAll =
    tokensByRole.user.total +
    tokensByRole.agent.total +
    tokensByRole.system.total;
  const tokensRecentAll =
    tokensByRole.user.recent +
    tokensByRole.agent.recent +
    tokensByRole.system.recent;

  // Dense 30d token series: densify on chars, then convert to tokens.
  const tokenDailyChars = denseSeries(
    tokenDailyRaw.map((r) => ({ day: r.day, n: BigInt(Number(r.n)) })),
  );
  const tokenDaily = tokenDailyChars.map((r) => ({
    day: r.day,
    n: Math.round(r.n / CHARS_PER_TOKEN),
  }));

  // Stream observability aggregates.
  const streamAgg = streamAggRaw[0] ?? {
    nMsgs: 0,
    nMsgsWithStats: 0,
    totalToolCalls: 0,
    totalDurationMs: 0,
    maxToolCalls: 0,
    recentToolCalls: 0,
    recentDurationMs: 0,
  };
  const nAgentMsgs = Number(streamAgg.nMsgs);
  const nAgentMsgsWithStats = Number(streamAgg.nMsgsWithStats);
  const totalToolCalls = Number(streamAgg.totalToolCalls);
  const totalDurationMs = Number(streamAgg.totalDurationMs);
  const maxToolCalls = Number(streamAgg.maxToolCalls);
  const recentToolCalls = Number(streamAgg.recentToolCalls);
  const recentDurationMs = Number(streamAgg.recentDurationMs);
  const avgToolCalls =
    nAgentMsgsWithStats > 0 ? totalToolCalls / nAgentMsgsWithStats : 0;
  const avgDurationMs =
    nAgentMsgsWithStats > 0 ? totalDurationMs / nAgentMsgsWithStats : 0;
  const toolCallsDaily = denseSeries(
    toolCallsDailyRaw.map((r) => ({ day: r.day, n: BigInt(Number(r.n)) })),
  );

  // Parse streamStats JSON blobs + toolNames to build aggregates over
  // the 30-day window. Parsing is bounded (one row = one tiny JSON
  // object) so this is O(n) with a tiny constant — acceptable even
  // with 100k agent messages.
  const eventCountAgg = new Map<string, number>();
  const toolCountAgg = new Map<string, number>();
  for (const m of eventTypeAggRaw) {
    if (m.streamStats) {
      try {
        const obj = JSON.parse(m.streamStats) as Record<string, number>;
        for (const [k, v] of Object.entries(obj)) {
          eventCountAgg.set(k, (eventCountAgg.get(k) ?? 0) + Number(v));
        }
      } catch {
        /* skip malformed */
      }
    }
    if (m.toolNames) {
      try {
        const arr = JSON.parse(m.toolNames) as string[];
        if (Array.isArray(arr)) {
          for (const t of arr) {
            toolCountAgg.set(t, (toolCountAgg.get(t) ?? 0) + 1);
          }
        }
      } catch {
        /* skip malformed */
      }
    }
  }
  const topEventTypes = Array.from(eventCountAgg.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  const topTools = Array.from(toolCountAgg.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  const totalEventsStreamed = Array.from(eventCountAgg.values()).reduce(
    (a, b) => a + b,
    0,
  );

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
          <ArrowLeft size={14} /> Settings
        </Link>
        <div className="mt-2 flex flex-wrap items-start gap-3">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 size={22} className="text-brand-500" /> Usage dashboard
          </h1>
          <div className="ml-auto">
            <TimeRangeSelector current={range.key as RangeKey} />
          </div>
        </div>
        <p className="text-sm text-slate-500 mt-1">
          Complete stats on KDust activity against Dust. All data is
          sourced from the local KDust database — no workspace-admin
          rights required. Time window:{' '}
          <b className="text-slate-700 dark:text-slate-300">{rangeLabel}</b>
          {isAllTime ? ' (365 daily buckets rendered).' : '.'} For the
          source-of-truth ground view (including conversations started
          directly in the Dust web UI), see the official dashboard in
          your Dust workspace admin.
        </p>
      </div>

      {/* KPI cards — totals and windowed counts */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KPI
          icon={<MessageSquare size={14} />}
          label="Conversations"
          value={totalConvs}
          sub={`${recentConvs} in ${rangeLabel}`}
        />
        <KPI
          icon={<MessageSquare size={14} />}
          label="Messages"
          value={totalMsgs}
          sub={`${recentMsgs} in ${rangeLabel}`}
        />
        <KPI
          icon={<Hash size={14} />}
          label="Est. tokens"
          value={tokensTotalAll}
          sub={`~${tokensRecentAll.toLocaleString('fr-FR')} in ${rangeLabel}`}
          title={`Rough estimate from message content length (${CHARS_PER_TOKEN} chars ≈ 1 token). Not a billed figure.`}
        />
        <KPI
          icon={<Play size={14} />}
          label="Task runs"
          value={totalRuns}
          sub={`${recentRuns} in ${rangeLabel}`}
        />
        <KPI
          icon={<Activity size={14} />}
          label="Tasks"
          value={totalTasks}
          sub={`${enabledTasks} enabled`}
        />
      </div>

      {/* Token breakdown by role + daily sparkline */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card title="Est. tokens by role" icon={<Hash size={14} />}>
          <ul className="text-sm space-y-2">
            {(['user', 'agent', 'system'] as const).map((role) => {
              const t = tokensByRole[role].total;
              const pct =
                tokensTotalAll > 0
                  ? Math.round((t / tokensTotalAll) * 100)
                  : 0;
              const label =
                role === 'user'
                  ? 'user (input)'
                  : role === 'agent'
                  ? 'agent (output)'
                  : 'system';
              return (
                <li key={role} className="flex items-center gap-2">
                  <span className="w-28 text-xs font-mono text-slate-500">
                    {label}
                  </span>
                  <span className="flex-1 h-2 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                    <span
                      className={
                        'block h-full ' +
                        (role === 'user'
                          ? 'bg-sky-400'
                          : role === 'agent'
                          ? 'bg-brand-400'
                          : 'bg-slate-400')
                      }
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="w-28 text-right text-xs font-mono">
                    {t.toLocaleString('fr-FR')} ({pct}%)
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="text-[10px] text-slate-400 mt-3">
            Estimate from <code>length(content)</code> /{' '}
            {CHARS_PER_TOKEN}. Does not include tool-call inputs or
            system prompts sent by Dust to the model — the true token
            usage is higher. Not billed.
          </p>
        </Card>
        <TimelineCard
          title={`Est. tokens / bucket (${rangeLabel})`}
          total={sum(tokenDaily)}
          last7={sum(tokenDaily.slice(-7))}
        >
          <Sparkline series={tokenDaily} color="bg-sky-400" />
        </TimelineCard>
        <Card title="Token estimate context" icon={<AlertTriangle size={14} />}>
          <ul className="text-xs space-y-1.5 text-slate-600 dark:text-slate-400">
            <li>
              • KDust does <b>not</b> persist the real LLM token count
              today; Dust's streaming API surfaces text deltas, not
              usage metadata.
            </li>
            <li>
              • The &quot;Est. tokens&quot; value is a char/token
              heuristic on <code>Message.content</code>.
            </li>
            <li>
              • Hidden costs (tool descriptions, system prompt,
              retrieved documents) are <b>not</b> counted here.
            </li>
            <li>
              • These are <b>not</b> billed tokens — KDust messages are
              in Dust&apos;s human-usage bucket.
            </li>
          </ul>
        </Card>
      </section>

      {/* 30-day timelines */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <TimelineCard
          title={`Messages / bucket (${rangeLabel})`}
          total={sum(msgDaily)}
          last7={sum(msgDaily.slice(-7))}
        >
          <Sparkline series={msgDaily} color="bg-brand-400" />
        </TimelineCard>
        <TimelineCard
          title={`Runs / bucket (${rangeLabel})`}
          total={sum(runDaily)}
          last7={sum(runDaily.slice(-7))}
        >
          <Sparkline series={runDaily} color="bg-amber-400" />
        </TimelineCard>
        <TimelineCard
          title={`Conversations / bucket (${rangeLabel})`}
          total={sum(convDaily)}
          last7={sum(convDaily.slice(-7))}
        >
          <Sparkline series={convDaily} color="bg-purple-400" />
        </TimelineCard>
      </section>

      {/* ─── Dust API stream observability ─────────────────── */}
      <section>
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-2">
          <Zap size={16} className="text-amber-500" /> Dust API calls &amp; tools
          <span className="text-[10px] font-normal text-slate-400">
            ({nAgentMsgsWithStats.toLocaleString('fr-FR')} / {nAgentMsgs.toLocaleString('fr-FR')} agent messages instrumented)
          </span>
        </h2>
        {nAgentMsgsWithStats === 0 ? (
          <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-4 bg-white dark:bg-slate-900 text-sm text-slate-500">
            No stream statistics yet. Send a message or trigger a task
            after this build is deployed — new agent messages will be
            instrumented automatically.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <KPI
                icon={<Wrench size={14} />}
                label="Total tool calls"
                value={totalToolCalls}
                sub={`${recentToolCalls.toLocaleString('fr-FR')} in ${rangeLabel}`}
              />
              <KPI
                icon={<Wrench size={14} />}
                label="Avg / agent msg"
                value={Math.round(avgToolCalls * 10) / 10}
                sub={`max in a single turn: ${maxToolCalls}`}
                title="Average number of MCP tool calls per agent turn."
              />
              <KPI
                icon={<Clock size={14} />}
                label="Avg stream time"
                value={Math.round(avgDurationMs / 100) / 10}
                sub={`seconds; sum: ${(recentDurationMs / 1000 / 60).toFixed(1)} min`}
                title="Wall-clock duration of the Dust SSE stream per agent turn (sec)."
              />
              <KPI
                icon={<Activity size={14} />}
                label="Stream events"
                value={totalEventsStreamed}
                sub="all event types combined"
                title="Every SSE event Dust emitted over the stream (generation_tokens, tool_call_started, …)."
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Card title="Top tools invoked" icon={<Wrench size={14} />}>
                <RankedList
                  items={topTools.map(([name, count]) => ({
                    label: name,
                    count,
                  }))}
                  empty="No tool calls yet"
                />
                <p className="text-[10px] text-slate-400 mt-2">
                  One per distinct tool per agent turn (duplicates
                  within the same turn not counted).
                </p>
              </Card>

              <Card title={`Stream event types (${rangeLabel})`} icon={<Activity size={14} />}>
                <ul className="text-xs space-y-1 font-mono">
                  {topEventTypes.map(([name, count]) => {
                    const max = topEventTypes[0]?.[1] ?? 1;
                    const pct = Math.round((count / max) * 100);
                    return (
                      <li key={name} className="flex items-center gap-2">
                        <span
                          className="truncate text-slate-600 dark:text-slate-400"
                          title={name}
                        >
                          {name}
                        </span>
                        <span className="flex-1 h-1.5 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                          <span
                            className={
                              'block h-full ' +
                              (name === 'generation_tokens'
                                ? 'bg-brand-400'
                                : name.startsWith('tool_')
                                ? 'bg-amber-400'
                                : name === 'agent_action_success'
                                ? 'bg-green-400'
                                : 'bg-slate-400')
                            }
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                        <span className="w-12 text-right">{count.toLocaleString('fr-FR')}</span>
                      </li>
                    );
                  })}
                </ul>
              </Card>

              <TimelineCard
                title={`Tool calls / bucket (${rangeLabel})`}
                total={toolCallsDaily.reduce((a, b) => a + b.n, 0)}
                last7={toolCallsDaily.slice(-7).reduce((a, b) => a + b.n, 0)}
              >
                <Sparkline series={toolCallsDaily} color="bg-amber-400" />
              </TimelineCard>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              <Card
                title="Tool-heaviest agent turns"
                icon={<Wrench size={14} />}
              >
                <table className="w-full text-xs">
                  <thead className="text-left text-[10px] text-slate-500">
                    <tr>
                      <th className="py-1">Conversation</th>
                      <th className="py-1 text-right">Tools</th>
                      <th className="py-1 text-right">Time</th>
                      <th className="py-1 text-right">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topToolConvsRaw.map((m) => (
                      <tr
                        key={m.id}
                        className="border-t border-slate-200 dark:border-slate-800"
                      >
                        <td className="py-1">
                          <Link
                            href={`/conversations/${m.conversation.id}`}
                            className="hover:underline truncate block max-w-[14rem]"
                          >
                            {m.conversation.title}
                          </Link>
                          <span className="text-[10px] text-slate-400">
                            {m.conversation.agentName ?? '-'} ·{' '}
                            {m.conversation.projectName ?? '(global)'}
                          </span>
                        </td>
                        <td className="py-1 text-right font-mono">
                          {m.toolCalls}
                        </td>
                        <td className="py-1 text-right font-mono text-slate-500">
                          {m.durationMs
                            ? `${(m.durationMs / 1000).toFixed(1)}s`
                            : '—'}
                        </td>
                        <td className="py-1 text-right text-[10px] text-slate-400">
                          {new Date(m.createdAt).toLocaleDateString('fr-FR')}
                        </td>
                      </tr>
                    ))}
                    {topToolConvsRaw.length === 0 && (
                      <tr>
                        <td
                          colSpan={4}
                          className="py-3 text-slate-400 italic text-center"
                        >
                          No tool-using turns yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Card>

              <Card title="Slowest agent turns" icon={<Clock size={14} />}>
                <table className="w-full text-xs">
                  <thead className="text-left text-[10px] text-slate-500">
                    <tr>
                      <th className="py-1">Conversation</th>
                      <th className="py-1 text-right">Duration</th>
                      <th className="py-1 text-right">Tools</th>
                      <th className="py-1 text-right">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slowestMsgsRaw.map((m) => (
                      <tr
                        key={m.id}
                        className="border-t border-slate-200 dark:border-slate-800"
                      >
                        <td className="py-1">
                          <Link
                            href={`/conversations/${m.conversation.id}`}
                            className="hover:underline truncate block max-w-[14rem]"
                          >
                            {m.conversation.title}
                          </Link>
                          <span className="text-[10px] text-slate-400">
                            {m.conversation.agentName ?? '-'} ·{' '}
                            {m.conversation.projectName ?? '(global)'}
                          </span>
                        </td>
                        <td className="py-1 text-right font-mono">
                          {m.durationMs
                            ? `${(m.durationMs / 1000).toFixed(1)}s`
                            : '—'}
                        </td>
                        <td className="py-1 text-right font-mono text-slate-500">
                          {m.toolCalls}
                        </td>
                        <td className="py-1 text-right text-[10px] text-slate-400">
                          {new Date(m.createdAt).toLocaleDateString('fr-FR')}
                        </td>
                      </tr>
                    ))}
                    {slowestMsgsRaw.length === 0 && (
                      <tr>
                        <td
                          colSpan={4}
                          className="py-3 text-slate-400 italic text-center"
                        >
                          No instrumented turns yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Card>
            </div>
          </>
        )}
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
              <b>{kindCount.audit ?? 0}</b> audit
            </p>
            <p className="text-xs text-slate-500">
              Enabled:{' '}
              <b className="text-green-700 dark:text-green-300">{enabledTasks}</b> /
              disabled:{' '}
              <b className="text-slate-500">{totalTasks - enabledTasks}</b>
            </p>
            <p className="text-xs text-slate-500">
              Runs in {rangeLabel}: <b>{sum(runDaily)}</b>
            </p>
            <p className="text-xs text-slate-500">
              Avg runs / bucket ({rangeLabel}):{' '}
              <b>{(sum(runDaily) / Math.max(1, range.bucketCount)).toFixed(1)}</b>
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

      {/* Audit health */}
      {adviceByProject.size > 0 && (
        <Card
          title="Audit health per project"
          icon={<Activity size={14} />}
          right={<Link href="/audits" className="text-xs text-brand-500 hover:underline">view all →</Link>}
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
                      {/* Was linking to /projects/[id]#audits \u2014 the
                          per-project dashboard was removed on 2026-04-19.
                          Target /audits (global scope) instead. */}
                      <Link
                        href="/audits"
                        className="hover:underline"
                        title={project}
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
                      {a.generatedAt.toLocaleDateString('fr-FR')}
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
                    {c.createdAt.toLocaleDateString('fr-FR')}
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
                  {new Date(r.startedAt).toLocaleString('fr-FR', {
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
                  {new Date(c.createdAt).toLocaleString('fr-FR', {
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
  title,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub?: string;
  title?: string;
}) {
  return (
    <div
      className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-white dark:bg-slate-900"
      title={title}
    >
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500">
        {icon} {label}
      </div>
      <div className="text-2xl font-bold mt-1 font-mono">
        {value.toLocaleString('fr-FR')}
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
