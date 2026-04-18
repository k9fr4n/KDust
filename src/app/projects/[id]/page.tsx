'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Folder,
  Clock,
  Settings2,
  Lightbulb,
  RefreshCw,
  Play,
  Pause,
  ListChecks,
  RotateCw,
} from 'lucide-react';
import { AuditSection } from '@/components/AuditSection';
import { RunNowButton } from '@/components/RunNowButton';

type Project = {
  id: string;
  name: string;
  gitUrl: string;
  branch: string;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
};

type Task = {
  id: string;
  name: string;
  schedule: string;
  timezone: string;
  kind: 'automation' | 'audit';
  category: string | null;
  mandatory: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
};

/**
 * Per-project dashboard. Shows:
 *   - project metadata
 *   - weekly "Audit" panel (audit slots, one per enabled template)
 *   - list of every cron attached to the project, with direct link
 *     to /tasks/:id for prompt/schedule editing
 */
export default function ProjectDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  // State shared with AuditSection: epoch-ms when "Run all" kicked
  // off. The AuditSection uses it to highlight pending categories +
  // auto-poll. Null = idle. We also use it here to disable the
  // trigger button and show a progress hint.
  const [adviceBatchStartedAt, setAdviceBatchStartedAt] = useState<number | null>(
    null,
  );
  const [adviceBatchSize, setAdviceBatchSize] = useState(0);

  const loadAll = async () => {
    setLoading(true);
    const [pRes, cRes] = await Promise.all([
      fetch(`/api/projects`).then((r) => r.json()),
      fetch(`/api/projects/${id}/tasks`).then((r) => r.json()),
    ]);
    setProject((pRes.projects ?? []).find((p: Project) => p.id === id) ?? null);
    setTasks(cRes.tasks ?? []);
    setLoading(false);
  };
  useEffect(() => {
    void loadAll();
  }, [id]);

  const toggleEnabled = async (c: Task) => {
    await fetch(`/api/tasks/${c.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !c.enabled }),
    });
    await loadAll();
  };

  /**
   * Kick off the sequential "Run all audits" batch for this project.
   * The endpoint fires the loop in the background; we record the
   * timestamp so AuditSection can poll + detect completion.
   */
  const runAllAdvice = async () => {
    if (adviceBatchStartedAt) return;
    const startedAt = Date.now() - 2000; // 2s grace for client/server clock drift
    const r = await fetch(`/api/projects/${id}/audits/run-all`, {
      method: 'POST',
    });
    if (!r.ok) return;
    const j = await r.json();
    const count = typeof j.count === 'number' ? j.count : 0;
    if (count === 0) return;
    setAdviceBatchStartedAt(startedAt);
    setAdviceBatchSize(count);
    // Safety timeout: clear batch state after 20 min even if the
    // progress detection in AuditSection doesn't catch completion
    // (e.g. all categories skipped because a sibling cron was running).
    setTimeout(
      () => setAdviceBatchStartedAt((s) => (s === startedAt ? null : s)),
      20 * 60 * 1000,
    );
    // Poll cron metadata every 5s to detect completion here (the
    // AuditSection does its own audit-endpoint polling). When every
    // audit cron has a lastRunAt newer than startedAt, we can drop
    // the batch state.
    const iv = setInterval(async () => {
      const tasksRes = await fetch(`/api/projects/${id}/tasks`).then((rr) =>
        rr.json(),
      );
      const list: Task[] = tasksRes.tasks ?? [];
      setTasks(list);
      const advCrons = list.filter((c) => c.kind === 'audit' && c.enabled);
      const allDone =
        advCrons.length > 0 &&
        advCrons.every((c) => {
          const t = c.lastRunAt ? new Date(c.lastRunAt).getTime() : 0;
          return t >= startedAt;
        });
      if (allDone) {
        clearInterval(iv);
        setAdviceBatchStartedAt(null);
      }
    }, 5000);
  };

  if (loading && !project) return <p>Loading…</p>;
  if (!project)
    return (
      <div>
        <Link href="/projects" className="text-sm text-slate-500 hover:underline">
          ← Back to projects
        </Link>
        <p className="mt-4 text-red-500">Project not found.</p>
      </div>
    );

  const adviceTasks = tasks.filter((c) => c.kind === 'audit');
  const otherTasks = tasks.filter((c) => c.kind !== 'audit');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Folder size={22} /> {project.name}
        </h1>
        <p className="text-xs text-slate-500 font-mono mt-1">
          {project.gitUrl} — branch <code>{project.branch}</code>
          {project.lastSyncAt && (
            <> — last sync {new Date(project.lastSyncAt).toLocaleString()}</>
          )}
        </p>
      </div>

      {/* ====== Advices ====== */}
      <section id="audits" className="scroll-mt-20">
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
          <Lightbulb size={18} className="text-amber-500" />
          Advices
          <span className="text-xs font-normal text-slate-500">
            — weekly automated analyses
          </span>
        </h2>
        <AuditSection projectId={id} batchStartedAt={adviceBatchStartedAt} />
      </section>

      {/* ====== Project tasks ====== */}
      <section>
        <h2 className="text-lg font-semibold flex items-center gap-2 mb-3 flex-wrap">
          <Clock size={18} />
          Project tasks
          <span className="text-xs font-normal text-slate-500">
            — {tasks.length} active
          </span>
          {/* "Run all audits sequentially" button. Placed here so users
              can trigger a full batch from the tasks control centre,
              not buried inside the Audit panel. The batch state is
              lifted to this component and piped into AuditSection so
              both surfaces stay in sync. */}
          <div className="ml-auto flex items-center gap-2">
            {adviceBatchStartedAt && (
              <span className="text-xs text-amber-600 dark:text-amber-300 inline-flex items-center gap-1.5">
                <RotateCw size={11} className="animate-spin" />
                Running {adviceBatchSize} audit cron(s) sequentially…
              </span>
            )}
            <button
              onClick={runAllAdvice}
              disabled={!!adviceBatchStartedAt || adviceTasks.length === 0}
              title="Run every enabled audit cron of this project, one after the other"
              className="text-xs px-2 py-1 rounded border border-amber-400 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              <ListChecks size={12} />
              {adviceBatchStartedAt ? 'Running…' : 'Run all audits sequentially'}
            </button>
            <button
              onClick={() => void loadAll()}
              className="text-xs text-slate-500 hover:underline inline-flex items-center gap-1"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </h2>

        <TaskTable
          title="Audit (mandatory)"
          rows={adviceTasks}
          onToggle={toggleEnabled}
        />
        {otherTasks.length > 0 && (
          <div className="mt-4">
            <TaskTable
              title="Other tasks"
              rows={otherTasks}
              onToggle={toggleEnabled}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function TaskTable({
  title,
  rows,
  onToggle,
}: {
  title: string;
  rows: Task[];
  onToggle: (c: Task) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-400 mb-1">
        {title}
      </h3>
      <table className="w-full text-sm">
        <thead className="text-left text-slate-500 text-xs">
          <tr>
            <th className="py-1">Name</th>
            <th>Cat.</th>

            <th>TZ</th>
            <th>Last run</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr
              key={c.id}
              className="border-t border-slate-200 dark:border-slate-800 align-middle"
            >
              <td className="py-2">
                <Link href={`/tasks/${c.id}`} className="hover:underline">
                  {c.name}
                </Link>
                {c.mandatory && (
                  <span
                    title="Mandatory cron, cannot be deleted"
                    className="ml-2 text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 rounded px-1.5 py-0.5"
                  >
                    mandatory
                  </span>
                )}
              </td>
              <td className="text-xs text-slate-500">{c.category ?? '—'}</td>

              <td className="text-xs text-slate-500">{c.timezone}</td>
              <td className="text-xs">
                {c.lastRunAt ? new Date(c.lastRunAt).toLocaleString() : '—'}
              </td>
              <td className="text-xs">
                {c.lastStatus === 'success' ? (
                  <span className="text-green-600">success</span>
                ) : c.lastStatus === 'failed' ? (
                  <span className="text-red-500">failed</span>
                ) : (
                  <span className="text-slate-400">{c.lastStatus ?? '—'}</span>
                )}
              </td>
              <td className="text-right">
                <div className="inline-flex gap-1 items-center justify-end">
                  <RunNowButton cronId={c.id} />
                  <button
                    onClick={() => onToggle(c)}
                    className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                    title={c.enabled ? 'Disable' : 'Enable'}
                  >
                    {c.enabled ? (
                      <>
                        <Pause size={10} /> on
                      </>
                    ) : (
                      <>
                        <Play size={10} /> off
                      </>
                    )}
                  </button>
                  <Link
                    href={`/tasks/${c.id}`}
                    className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                  >
                    <Settings2 size={10} /> Edit
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
