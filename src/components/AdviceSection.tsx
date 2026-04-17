'use client';
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, PlayCircle, RotateCw } from 'lucide-react';
import {
  ADVICE_CATEGORIES,
  CATEGORY_EMOJI,
  CATEGORY_LABELS,
  type AdviceCategory,
} from '@/lib/advice/categories';

type Point = {
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  refs?: string[];
};
type Slot = {
  category: AdviceCategory;
  points: Point[] | null;
  generatedAt: string | null;
  cron: {
    id: string;
    schedule: string;
    enabled: boolean;
    lastRunAt: string | null;
    lastStatus: string | null;
  } | null;
};

const SEVERITY_STYLE: Record<Point['severity'], string> = {
  low: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300',
  critical: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300',
};

/**
 * "Conseils" panel embedded in the projects table. Lazy-loads the 5
 * advice slots for a project and shows each category's latest 3 points.
 * A "Re-run now" button triggers the cron on demand so users don't have
 * to wait for the next scheduled slot.
 */
export function AdviceSection({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Record<AdviceCategory, Slot> | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningCat, setRunningCat] = useState<AdviceCategory | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/advice`);
      if (r.ok) {
        const j = await r.json();
        setData(j.advice);
      }
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [projectId]);

  const rerun = async (cat: AdviceCategory) => {
    const cronId = data?.[cat]?.cron?.id;
    if (!cronId) return;
    setRunningCat(cat);
    try {
      await fetch(`/api/crons/${cronId}/run`, { method: 'POST' });
      // Advice generation takes 1–2 min typically; we just poll once
      // after a short delay. User can hit the button again for a fresh
      // pull.
      setTimeout(() => void load(), 5000);
    } finally {
      setRunningCat(null);
    }
  };

  if (loading && !data) {
    return <p className="text-xs text-slate-500 p-3">Chargement des conseils…</p>;
  }
  if (!data) {
    return <p className="text-xs text-red-500 p-3">Impossible de charger les conseils.</p>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3 p-3">
      {ADVICE_CATEGORIES.map((cat) => {
        const slot = data[cat];
        const hasPoints = slot?.points && slot.points.length > 0;
        return (
          <div
            key={cat}
            className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-white dark:bg-slate-900"
          >
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold flex items-center gap-1.5">
                <span>{CATEGORY_EMOJI[cat]}</span>
                {CATEGORY_LABELS[cat]}
              </h4>
              <button
                onClick={() => rerun(cat)}
                disabled={runningCat === cat || !slot?.cron}
                title="Relancer le cron maintenant"
                className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                {runningCat === cat ? (
                  <RotateCw size={11} className="animate-spin" />
                ) : (
                  <PlayCircle size={11} />
                )}
                Re-run
              </button>
            </div>

            <div className="text-[10px] text-slate-500 flex items-center gap-2 mb-2">
              <Clock size={10} />
              {slot.generatedAt
                ? `Généré ${new Date(slot.generatedAt).toLocaleString()}`
                : 'Pas encore d’analyse'}
              {slot.cron?.lastStatus === 'failed' && (
                <span className="text-red-500 inline-flex items-center gap-1">
                  <AlertTriangle size={10} /> dernier run échoué
                </span>
              )}
              {slot.cron?.lastStatus === 'success' && (
                <span className="text-green-600 inline-flex items-center gap-1">
                  <CheckCircle2 size={10} /> OK
                </span>
              )}
            </div>

            {hasPoints ? (
              <ol className="space-y-2">
                {slot.points!.map((p, i) => (
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
                      <p className="text-xs font-medium">{p.title}</p>
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
                Aucun conseil disponible pour le moment. Lancez le cron pour générer la première analyse.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
