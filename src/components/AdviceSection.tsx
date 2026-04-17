'use client';
import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  PlayCircle,
  RotateCw,
  MessageSquarePlus,
} from 'lucide-react';
import {
  AdvicePoint,
  AdviceSlot,
  SEVERITY_STYLE,
  ScoreBadge,
  buildChatHrefFromAdvice,
} from './advice/shared';

/**
 * "Advice" panel rendered on the project dashboard (/projects/:id).
 * Lazy-loads the advice slots (one per enabled template) and shows
 * each category's latest 3 points + category score. The per-slot
 * "Re-run" button triggers the matching cron on demand.
 *
 * The "Run all sequentially" batch button lives OUTSIDE this component
 * (on the Project crons section header) so the user can trigger a
 * rerun without scrolling to Advice. Batch progress is fed back here
 * via the `batchStartedAt` prop: when set, this component auto-polls
 * /advice every 4s and highlights categories whose cron.lastRunAt is
 * still older than the batch start.
 */
export function AdviceSection({
  projectId,
  batchStartedAt,
}: {
  projectId: string;
  /** epoch-ms when a batch "Run all" started; null = idle */
  batchStartedAt?: number | null;
}) {
  const [slots, setSlots] = useState<AdviceSlot[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningCat, setRunningCat] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/advice`);
      if (r.ok) {
        const j = await r.json();
        setSlots(j.slots ?? []);
      }
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [projectId]);

  // Auto-poll while a batch is in flight. Scoped to this component so
  // the parent doesn't need to pass a loader callback.
  useEffect(() => {
    if (!batchStartedAt) return;
    const iv = setInterval(() => void load(), 4000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchStartedAt]);

  const rerun = async (slot: AdviceSlot) => {
    if (!slot.cron) return;
    setRunningCat(slot.category);
    try {
      await fetch(`/api/crons/${slot.cron.id}/run`, { method: 'POST' });
      setTimeout(() => void load(), 5000);
    } finally {
      setRunningCat(null);
    }
  };

  if (loading && !slots) {
    return <p className="text-xs text-slate-500 p-3">Loading advice…</p>;
  }
  if (!slots) {
    return <p className="text-xs text-red-500 p-3">Unable to load advice.</p>;
  }
  if (slots.length === 0) {
    return (
      <p className="text-xs italic text-slate-500 p-3">
        No category enabled. Head to{' '}
        <a href="/settings/advice" className="underline">
          Settings › Advice
        </a>
        .
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {slots.map((slot) => {
        const hasPoints = slot.points && slot.points.length > 0;
        // "pending in batch" = batch is running AND this slot's cron
        // hasn't reported a fresh lastRunAt yet. Used to grey out the
        // card so the user sees progress visually.
        const lastRunMs = slot.cron?.lastRunAt
          ? new Date(slot.cron.lastRunAt).getTime()
          : 0;
        const pendingInBatch =
          !!batchStartedAt && !!slot.cron && lastRunMs < batchStartedAt;
        return (
          <div
            key={slot.category}
            className={
              'border rounded-lg p-3 bg-white dark:bg-slate-900 transition-opacity ' +
              (pendingInBatch
                ? 'border-amber-300 dark:border-amber-700 animate-pulse'
                : 'border-slate-200 dark:border-slate-800')
            }
          >
            <div className="flex items-center justify-between mb-2 gap-2">
              <h4 className="text-sm font-semibold flex items-center gap-1.5 min-w-0">
                <span>{slot.emoji}</span>
                <span className="truncate">{slot.label}</span>
              </h4>
              <div className="flex items-center gap-1.5 shrink-0">
                <ScoreBadge score={slot.score} />
                <button
                  onClick={() => rerun(slot)}
                  disabled={runningCat === slot.category || !slot.cron || pendingInBatch}
                  title="Re-run the cron now"
                  className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  {runningCat === slot.category || pendingInBatch ? (
                    <RotateCw size={11} className="animate-spin" />
                  ) : (
                    <PlayCircle size={11} />
                  )}
                  Re-run
                </button>
              </div>
            </div>

            <div className="text-[10px] text-slate-500 flex items-center gap-2 mb-2 flex-wrap">
              <Clock size={10} />
              {slot.generatedAt
                ? `Generated ${new Date(slot.generatedAt).toLocaleString()}`
                : 'No analysis yet'}
              {slot.cron?.lastStatus === 'failed' && (
                <span className="text-red-500 inline-flex items-center gap-1">
                  <AlertTriangle size={10} /> last run failed
                </span>
              )}
              {slot.cron?.lastStatus === 'success' && !pendingInBatch && (
                <span className="text-green-600 inline-flex items-center gap-1">
                  <CheckCircle2 size={10} /> OK
                </span>
              )}
              {!slot.cron && (
                <span className="text-orange-500">cron not provisioned</span>
              )}
            </div>

            {hasPoints ? (
              <ol className="space-y-2">
                {slot.points!.map((p: AdvicePoint, i: number) => (
                  <li
                    key={i}
                    className="border-l-2 border-slate-200 dark:border-slate-700 pl-2"
                  >
                    <div className="flex items-start gap-1.5">
                      <span
                        className={
                          'shrink-0 text-[9px] uppercase tracking-wide font-bold rounded px-1 py-0.5 ' +
                          SEVERITY_STYLE[p.severity]
                        }
                      >
                        {p.severity}
                      </span>
                      <p className="text-xs font-medium flex-1">{p.title}</p>
                      <a
                        href={buildChatHrefFromAdvice({
                          label: slot.label,
                          emoji: slot.emoji,
                          point: p,
                        })}
                        title="Open a new chat with this advice as the initial prompt"
                        className="shrink-0 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-brand-300 dark:border-brand-700 text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-950/30"
                      >
                        <MessageSquarePlus size={10} /> Chat
                      </a>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                      {p.description}
                    </p>
                    {p.refs && p.refs.length > 0 && (
                      <p className="text-[10px] font-mono text-slate-500 mt-0.5">
                        {p.refs.join(' • ')}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs italic text-slate-400">
                No advice available. Run the cron to generate the first analysis.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
