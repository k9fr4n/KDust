'use client';
import { useEffect, useState } from 'react';
import { Lightbulb } from 'lucide-react';
import {
  AdviceBrowser,
  AdviceBrowserItem,
} from '@/components/advice/AdviceBrowser';

/**
 * /advices — cross-project priority-advice browser.
 *
 * Thin wrapper that fetches /api/advice/aggregate and delegates the
 * entire UI to <AdviceBrowser>. The same component also powers the
 * per-project panel inside /projects/[id] so the two views stay
 * identical except for the project filter (hidden in project mode).
 */
export default function AdvicePage() {
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

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Lightbulb size={22} className="text-amber-500" />
          Advice
          <span className="text-xs font-normal text-slate-500">
            — cross-project priority list
          </span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Select one or more points from the same project to open a
          chat pre-filled with the full context of your selection.
          {counts && (
            <span className="ml-2">
              ({counts.projects} project(s) • {counts.advices} row(s))
            </span>
          )}
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : !items || items.length === 0 ? (
        <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-md p-6 text-center">
          <p className="text-sm text-slate-500">
            No advice generated yet. Open a project dashboard and
            click <b>Run</b> on its Priority advice task.
          </p>
        </div>
      ) : (
        <AdviceBrowser items={items} />
      )}
    </div>
  );
}
