'use client';
import { useEffect, useRef, useState } from 'react';
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
  output: string | null;
  // Chain-of-thought stream surfaced live while the agent is
  // running (Franck 2026-04-24 18:51). Populated by the runner on
  // every cot token, throttled alongside `output` to ~500ms.
  thinkingOutput: string | null;
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

export function TaskLiveStatus({ cronId, initialRun }: { cronId: string; initialRun: Run }) {
  const router = useRouter();
  const [run, setRun] = useState<Run>(initialRun);
  const [cancelling, setCancelling] = useState(false);
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const outputRef = useRef<HTMLPreElement>(null);
  const shouldAutoScroll = useRef(true);
  // Independent auto-scroll state for the thinking pane (Franck
  // 2026-04-24 20:27). Shares the same pattern as the output
  // pane: follow the tail unless the user scrolled up manually.
  const thinkingRef = useRef<HTMLPreElement>(null);
  const shouldAutoScrollThinking = useRef(true);

  // Poll run state every 1.5s while running.
  useEffect(() => {
    if (run.status !== 'running') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/task/${cronId}`, { cache: 'no-store' });
        if (!r.ok) return;
        const data = await r.json();
        const latest: Run | undefined = data?.task?.runs?.find((x: Run) => x.id === run.id) ?? data?.task?.runs?.[0];
        if (latest && !cancelled) {
          setRun(latest);
          if (latest.status !== 'running') router.refresh();
        }
      } catch { /* ignore */ }
    };
    const id = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, [cronId, run.id, run.status, router]);

  // Tick local clock so "Xs elapsed" updates smoothly.
  useEffect(() => {
    if (run.status !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [run.status]);

  // Auto-scroll the output pane to the bottom as tokens stream in (unless
  // the user scrolled up manually, in which case we respect that).
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    if (shouldAutoScroll.current) el.scrollTop = el.scrollHeight;
  }, [run.output]);

  // Same tail-following behaviour for the thinking pane (Franck
  // 2026-04-24 20:27). Chain-of-thought is often long, so users
  // want the latest reasoning visible without manual scrolling.
  useEffect(() => {
    const el = thinkingRef.current;
    if (!el) return;
    if (shouldAutoScrollThinking.current) el.scrollTop = el.scrollHeight;
  }, [run.thinkingOutput]);

  async function onCancel() {
    if (!confirm('Cancel the running job? Any uncommitted changes will remain in /projects for inspection, nothing will be pushed.')) return;
    setCancelling(true);
    setCancelMsg(null);
    try {
      const r = await fetch(`/api/taskrun/${run.id}/cancel`, { method: 'POST' });
      if (r.ok) setCancelMsg('Abort signal sent. The run will stop within a few seconds.');
      else {
        const body = await r.json().catch(() => ({}));
        setCancelMsg(`Cancel failed: HTTP ${r.status} ${body.error ?? ''}`);
      }
    } catch (e) {
      setCancelMsg(`Cancel failed: ${(e as Error).message}`);
    } finally {
      setCancelling(false);
    }
  }

  const startedMs = now - new Date(run.startedAt).getTime();
  const currentIdx = PHASES.findIndex((p) => p.key === run.phase);
  const isRunning = run.status === 'running';

  return (
    <li className="rounded-md border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-3">
      {/* Header: live badge + elapsed + cancel */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs uppercase tracking-wide text-blue-700 dark:text-blue-400 bg-blue-100 dark:bg-blue-950/60 border-blue-300 dark:border-blue-800">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
          </span>
          running
        </span>
        {run.dryRun && (
          <span className="inline-flex items-center px-2 py-0.5 rounded border border-purple-300 text-purple-700 dark:text-purple-400 dark:border-purple-800 text-xs">
            dry-run
          </span>
        )}
        <span className="text-xs font-mono text-blue-700 dark:text-blue-300">
          {Math.floor(startedMs / 1000)}s elapsed
        </span>
        <span className="text-xs text-slate-400 ml-auto">{new Date(run.startedAt).toISOString()}</span>
        {isRunning && (
          <button
            onClick={onCancel}
            disabled={cancelling}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-red-300 dark:border-red-800 text-red-700 dark:text-red-400 text-xs hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
            title="Abort this run"
          >
            ⏹ {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </div>

      {cancelMsg && <p className="text-xs text-amber-600 dark:text-amber-400 mb-2">{cancelMsg}</p>}

      {/* Phase stepper */}
      <ol className="flex flex-wrap gap-1 mb-2">
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
        <p className="text-xs text-blue-700 dark:text-blue-300 mt-1 font-mono">
          branch: {run.branch}
        </p>
      )}

      {/* Live chain-of-thought (Franck 2026-04-24 18:51).
          Rendered BEFORE the main output so users watching a
          long-running agent see the reasoning stream before the
          final answer lands. Collapsed by default because it can
          be noisy — the label shows the char count as a
          live-updating teaser to hint there's activity. */}
      {run.thinkingOutput && (
        // Open by default (Franck 2026-04-24 20:27): the thinking
        // stream is the most informative signal during a long
        // agent run, and hiding it behind a click defeated its
        // purpose. Users can still collapse manually if they
        // want a denser view.
        <details className="mt-3" open>
          <summary className="cursor-pointer text-xs font-semibold text-purple-700 dark:text-purple-300 hover:text-purple-900">
            🧠 Live thinking ({run.thinkingOutput.length.toLocaleString('fr-FR')} chars)
          </summary>
          <pre
            ref={thinkingRef}
            onScroll={(e) => {
              // Follow tail unless the user scrolled away from the
              // bottom. 30px threshold matches the output pane's
              // behaviour so both feel the same.
              const el = e.currentTarget;
              shouldAutoScrollThinking.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 30;
            }}
            className="mt-1 whitespace-pre-wrap text-xs max-h-96 overflow-auto bg-purple-50 dark:bg-purple-950/30 rounded border border-purple-200 dark:border-purple-900 p-2 font-mono"
          >
            {run.thinkingOutput}
          </pre>
        </details>
      )}

      {/* Live agent output */}
      <details className="mt-3" open>
        <summary className="cursor-pointer text-xs font-semibold text-blue-700 dark:text-blue-300 hover:text-blue-900">
          Live output {run.output ? `(${run.output.length.toLocaleString('fr-FR')} chars)` : '(waiting…)'}
        </summary>
        <pre
          ref={outputRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            shouldAutoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          }}
          className="mt-1 whitespace-pre-wrap text-xs max-h-96 overflow-auto bg-white dark:bg-slate-950 rounded border border-blue-200 dark:border-blue-900 p-2 font-mono"
        >
          {run.output || '(no output yet — the agent has not produced any tokens)'}
        </pre>
      </details>
    </li>
  );
}
