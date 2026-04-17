'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type Run = {
  id: string;
  status: string;
  phase: string | null;
  phaseMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  branch: string | null;
  commitSha: string | null;
  filesChanged: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  dryRun: boolean;
};

const PHASES: { key: string; label: string }[] = [
  { key: 'queued',     label: 'Queued' },
  { key: 'syncing',    label: 'Git sync' },
  { key: 'branching',  label: 'Branch' },
  { key: 'mcp',        label: 'MCP' },
  { key: 'agent',      label: 'Agent' },
  { key: 'diff',       label: 'Diff' },
  { key: 'committing', label: 'Commit' },
  { key: 'pushing',    label: 'Push' },
  { key: 'done',       label: 'Done' },
];

export function CronLiveStatus({ cronId, initialRun }: { cronId: string; initialRun: Run | null }) {
  const router = useRouter();
  const [run, setRun] = useState<Run | null>(initialRun);

  useEffect(() => {
    if (!run || run.status !== 'running') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/crons/${cronId}`, { cache: 'no-store' });
        if (!r.ok) return;
        const data = await r.json();
        const latest: Run | undefined = data?.cron?.runs?.[0];
        if (latest && !cancelled) {
          setRun(latest);
          if (latest.status !== 'running') {
            // Completed: refresh the page so the static list below re-renders.
            router.refresh();
          }
        }
      } catch { /* ignore */ }
    };
    const id = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, [cronId, run, router]);

  if (!run || run.status !== 'running') return null;

  const startedMs = Date.now() - new Date(run.startedAt).getTime();
  const currentIdx = PHASES.findIndex((p) => p.key === run.phase);

  return (
    <section className="mb-6 rounded-lg border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-4">
      <div className="flex items-center gap-3 mb-3">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
        </span>
        <h2 className="font-semibold text-blue-900 dark:text-blue-200">Run in progress</h2>
        <span className="text-xs font-mono text-blue-700 dark:text-blue-300 ml-auto">
          {Math.floor(startedMs / 1000)}s elapsed
        </span>
      </div>

      {/* Phase stepper */}
      <ol className="flex flex-wrap gap-1 mb-3">
        {PHASES.map((p, i) => {
          const reached = currentIdx >= 0 && i <= currentIdx;
          const active  = currentIdx === i;
          return (
            <li key={p.key} className={[
              'flex items-center gap-1 px-2 py-0.5 rounded text-xs',
              active  ? 'bg-blue-600 text-white font-semibold' :
              reached ? 'bg-blue-200 dark:bg-blue-900/60 text-blue-900 dark:text-blue-200' :
                        'bg-slate-100 dark:bg-slate-800 text-slate-500'
            ].join(' ')}>
              <span className="font-mono">{i + 1}</span>
              <span>{p.label}</span>
            </li>
          );
        })}
      </ol>

      <p className="text-sm font-mono text-blue-800 dark:text-blue-200">
        {run.phaseMessage ?? run.phase ?? 'Starting…'}
      </p>
      {run.branch && (
        <p className="text-xs text-blue-700 dark:text-blue-300 mt-1 font-mono">branch: {run.branch}</p>
      )}
      <p className="text-xs text-blue-600 dark:text-blue-400 mt-2">
        Tip: open <a href="/logs" target="_blank" rel="noreferrer" className="underline">/logs</a> in another tab for raw output.
      </p>
    </section>
  );
}
