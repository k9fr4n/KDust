'use client';
import { useEffect, useState } from 'react';
import { Lightbulb, RefreshCw, PlayCircle } from 'lucide-react';
import {
  AuditBrowser,
  AuditBrowserItem,
} from '@/components/audit/AuditBrowser';

/**
 * Client companion of /audits/page.tsx. Fetches the aggregate
 * dataset, then hands it to <AuditBrowser>. The project scope is
 * driven entirely by `scopedProjectId` which the server component
 * derives from the top navbar selector cookie.
 */
export function AuditsClient({
  scopedProjectId,
  scopedProjectName,
}: {
  scopedProjectId: string | null;
  scopedProjectName: string | null;
}) {
  const [items, setItems] = useState<AuditBrowserItem[] | null>(null);
  const [counts, setCounts] = useState<{
    projects: number;
    advices: number;
    withScore: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  // Rerun-all state (Franck 2026-04-19 20:48). Sequential runs happen
  // server-side (fire-and-forget IIFE in /api/audits/rerun); the UI
  // only reports what was queued vs skipped.
  const [rerunning, setRerunning] = useState(false);
  const [rerunMsg, setRerunMsg] = useState<
    { kind: 'ok' | 'err'; text: string } | null
  >(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/audits/aggregate', { cache: 'no-store' });
      const j = await r.json();
      setItems(j.items ?? []);
      setCounts(j.counts ?? null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const rerunAudits = async () => {
    setRerunning(true);
    setRerunMsg(null);
    try {
      const qs = scopedProjectId ? `?projectId=${encodeURIComponent(scopedProjectId)}` : '';
      const r = await fetch(`/api/audits/rerun${qs}`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) {
        setRerunMsg({ kind: 'err', text: typeof j.error === 'string' ? j.error : `HTTP ${r.status}` });
        return;
      }
      if (j.total === 0) {
        setRerunMsg({
          kind: 'err',
          text: scopedProjectName
            ? `Aucune tâche d'audit configurée pour « ${scopedProjectName} ».`
            : `Aucune tâche d'audit configurée.`,
        });
        return;
      }
      setRerunMsg({
        kind: 'ok',
        text:
          `${j.queuedCount} tâche${j.queuedCount > 1 ? 's' : ''} en file d'attente` +
          (j.skippedCount ? `, ${j.skippedCount} ignorée${j.skippedCount > 1 ? 's' : ''} (déjà en cours)` : '') +
          `. Exécution séquentielle — les résultats apparaîtront au fur et à mesure.`,
      });
    } catch (e: any) {
      setRerunMsg({ kind: 'err', text: e?.message ?? String(e) });
    } finally {
      setRerunning(false);
    }
  };

  // The aggregate endpoint returns data for every project. When the
  // top selector scopes to one project, keep only its rows so the
  // tiles, the list, and the counts reflect that project only.
  const scopedItems = scopedProjectId
    ? (items ?? []).filter((it) => it.projectId === scopedProjectId)
    : items;

  // Diagnose a common situation: the user has audit rows but no
  // scores at all (parse failures, legacy rows, etc). v5: each row
  // carries a single category-level score on `it.score`, so this is
  // a one-line scan.
  const hasAnyScore =
    !!scopedItems &&
    scopedItems.some((it) => typeof it.score === 'number');
  const showLegacyBanner =
    !loading && !!scopedItems && scopedItems.length > 0 && !hasAnyScore;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Lightbulb size={22} className="text-amber-500" />
            Audits
            {scopedProjectName ? (
              <span className="text-base font-normal text-slate-500">
                · {scopedProjectName}
              </span>
            ) : (
              <span className="text-xs font-normal text-slate-500">
                — cross-project priority list
              </span>
            )}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Select one or more points from the same project to open a
            chat pre-filled with the full context of your selection.
            {counts && !scopedProjectId && (
              <span className="ml-2">
                ({counts.projects} project(s) • {counts.advices} row(s))
              </span>
            )}
          </p>
        </div>

        {/* Actions: refresh + relaunch all audit tasks. Scoped to the
            current project when one is selected in the top navbar;
            otherwise fires every audit task registered across all
            projects. */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 text-sm"
            title="Refresh audit data"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={rerunAudits}
            disabled={rerunning}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-amber-500 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 hover:bg-amber-100 disabled:opacity-50 text-sm"
            title={
              scopedProjectName
                ? `Relancer les tâches d'audit de « ${scopedProjectName} » séquentiellement`
                : "Relancer toutes les tâches d'audit séquentiellement"
            }
          >
            {rerunning
              ? <><RefreshCw size={14} className="animate-spin" /> Lancement…</>
              : <><PlayCircle size={14} /> Relancer les audits</>}
          </button>
        </div>
      </div>

      {rerunMsg && (
        <div
          className={
            'rounded-md p-3 text-xs ' +
            (rerunMsg.kind === 'ok'
              ? 'bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-300 border border-green-200 dark:border-green-900'
              : 'bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300 border border-red-200 dark:border-red-900')
          }
        >
          {rerunMsg.text}
        </div>
      )}

      {showLegacyBanner && (
        <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
          <b className="text-amber-800 dark:text-amber-300">
            Scores missing on {scopedItems!.length} audit row(s).
          </b>{' '}
          <span className="text-amber-900/80 dark:text-amber-200/80">
            These rows were generated by an older audit format (no
            per-axis scoring). Re-run the <b>Priority audit</b> task on{' '}
            {scopedProjectName
              ? <>project <b>{scopedProjectName}</b></>
              : 'each affected project'}{' '}
            to populate the 6-axis scoring tiles.
          </span>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : !scopedItems || scopedItems.length === 0 ? (
        <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-md p-6 text-center">
          <p className="text-sm text-slate-500">
            {scopedProjectName
              ? <>No audit generated yet for <b>{scopedProjectName}</b>. Open its dashboard and click <b>Run</b> on the Priority audit task.</>
              : <>No audit generated yet. Open a project dashboard and click <b>Run</b> on its Priority audit task.</>}
          </p>
        </div>
      ) : (
        <AuditBrowser
          items={scopedItems}
          scopedProjectId={scopedProjectId}
        />
      )}
    </div>
  );
}
