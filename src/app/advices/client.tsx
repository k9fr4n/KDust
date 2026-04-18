'use client';
import { useEffect, useState } from 'react';
import { Lightbulb } from 'lucide-react';
import {
  AdviceBrowser,
  AdviceBrowserItem,
} from '@/components/advice/AdviceBrowser';

/**
 * Client companion of /advices/page.tsx. Fetches the aggregate
 * dataset, then hands it to <AdviceBrowser>. The project scope is
 * driven entirely by `scopedProjectId` which the server component
 * derives from the top navbar selector cookie.
 */
export function AdvicesClient({
  scopedProjectId,
  scopedProjectName,
}: {
  scopedProjectId: string | null;
  scopedProjectName: string | null;
}) {
  const [items, setItems] = useState<AdviceBrowserItem[] | null>(null);
  const [counts, setCounts] = useState<{
    projects: number;
    advices: number;
    withScore: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const r = await fetch('/api/advice/aggregate');
        const j = await r.json();
        setItems(j.items ?? []);
        setCounts(j.counts ?? null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // The aggregate endpoint returns data for every project. When the
  // top selector scopes to one project, keep only its rows so the
  // tiles, the list, and the counts reflect that project only.
  const scopedItems = scopedProjectId
    ? (items ?? []).filter((it) => it.projectId === scopedProjectId)
    : items;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Lightbulb size={22} className="text-amber-500" />
          Advice
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

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : !scopedItems || scopedItems.length === 0 ? (
        <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-md p-6 text-center">
          <p className="text-sm text-slate-500">
            {scopedProjectName
              ? <>No advice generated yet for <b>{scopedProjectName}</b>. Open its dashboard and click <b>Run</b> on the Priority advice task.</>
              : <>No advice generated yet. Open a project dashboard and click <b>Run</b> on its Priority advice task.</>}
          </p>
        </div>
      ) : (
        <AdviceBrowser
          items={scopedItems}
          scopedProjectId={scopedProjectId}
        />
      )}
    </div>
  );
}
