'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  CreditCard,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Info,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/Button';

type ExportResponse = {
  table: string;
  startDate: string;
  endDate: string;
  workspaceId: string;
  columns: string[];
  rows: Record<string, string>[];
  rowCount: number;
};

/**
 * Origins that mark a message as programmatic (= billed in credits)
 * per https://docs.dust.tt/docs/programmatic-usage. Kept in sync with
 * BILLED_ORIGINS in src/lib/dust/chat.ts — this is the duplicated
 * source of truth for the UI side so the page can flag a row red even
 * if someone bypassed safeOrigin().
 */
const BILLED_SOURCES = new Set([
  'api',
  'cli_programmatic',
  'triggered_programmatic',
]);

/**
 * Heuristic: the Dust analytics `source` table exposes one row per
 * origin with a message count column. Column naming is not 100%
 * stable across versions so we probe a short list of candidates.
 */
const COUNT_COLUMN_CANDIDATES = [
  'messageCount',
  'messages',
  'count',
  'total',
  'nbMessages',
];
const SOURCE_COLUMN_CANDIDATES = ['source', 'origin', 'context', 'channel'];

function pickColumn(columns: string[], candidates: string[]): string | null {
  const lower = columns.map((c) => c.toLowerCase());
  for (const cand of candidates) {
    const i = lower.indexOf(cand.toLowerCase());
    if (i >= 0) return columns[i];
  }
  return null;
}

/**
 * Billing sanity-check page.
 *
 * KDust authenticates to Dust via WorkOS OAuth (no `sk-…` custom
 * workspace API key). Combined with `origin ∈ {web, triggered, …}`,
 * every message KDust emits SHOULD land in Dust's "human usage"
 * bucket (non-programmatic, covered by the plan). This page verifies
 * it empirically by pulling the workspace analytics `source` table:
 *
 *   - Non-billed sources (web, triggered, extension, slack, …) →
 *     listed green, thumbs-up banner at the top.
 *   - Billed sources (api, cli_programmatic, triggered_programmatic)
 *     with ANY message count > 0 → red banner, row highlighted. This
 *     is the "oh no" state meaning a KDust message leaked to the
 *     programmatic bucket and would be billed.
 *
 * NOTE: the analytics endpoint requires workspace-admin rights on
 * Dust. Non-admin users get a 403; we surface a helpful error.
 */
export default function BillingSettingsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  )
    .toISOString()
    .slice(0, 10);

  const [startDate, setStartDate] = useState(firstOfMonth);
  const [endDate, setEndDate] = useState(today);
  const [data, setData] = useState<ExportResponse | null>(null);
  const [err, setErr] = useState<{ status: number; detail?: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({
        table: 'source',
        startDate,
        endDate,
      });
      const r = await fetch(`/api/billing/usage?${qs}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr({ status: r.status, detail: j.detail ?? j.error });
        setData(null);
        return;
      }
      setData(await r.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Normalize analytics rows into { source, count, billed } with
   * best-effort column picking. Falls back to "first numeric column"
   * if the schema deviates from known aliases.
   */
  const breakdown = useMemo(() => {
    if (!data) return null;
    const sourceCol = pickColumn(data.columns, SOURCE_COLUMN_CANDIDATES);
    let countCol = pickColumn(data.columns, COUNT_COLUMN_CANDIDATES);
    if (!countCol) {
      // Probe: first column whose values look numeric.
      countCol =
        data.columns.find((c) =>
          data.rows.every((r) => /^\d+(\.\d+)?$/.test((r[c] ?? '').trim() || '0')),
        ) ?? null;
    }
    if (!sourceCol || !countCol) {
      return {
        sourceCol: sourceCol,
        countCol: countCol,
        items: [] as {
          source: string;
          count: number;
          billed: boolean;
        }[],
        billedTotal: 0,
        safeTotal: 0,
        unknown: true,
      };
    }
    const items = data.rows
      .map((r) => ({
        source: r[sourceCol!] || '(empty)',
        count: Number(r[countCol!] ?? 0) || 0,
        billed: BILLED_SOURCES.has((r[sourceCol!] ?? '').toLowerCase()),
      }))
      .sort((a, b) => b.count - a.count);
    const billedTotal = items
      .filter((i) => i.billed)
      .reduce((a, b) => a + b.count, 0);
    const safeTotal = items
      .filter((i) => !i.billed)
      .reduce((a, b) => a + b.count, 0);
    return { sourceCol, countCol, items, billedTotal, safeTotal, unknown: false };
  }, [data]);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Back-office
        </Link>
        <h1 className="text-2xl font-bold mt-2 flex items-center gap-2">
          <CreditCard size={22} className="text-brand-500" /> Billing sanity check
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Verifies that KDust's conversations are classified as human
          usage (covered by your Dust plan) and not programmatic
          usage (billed in credits).
        </p>
      </div>

      {/* How-it-works info block */}
      <div className="flex gap-2 items-start text-xs border border-slate-200 dark:border-slate-800 rounded-md p-3 bg-slate-50 dark:bg-slate-900/50">
        <Info size={14} className="shrink-0 mt-0.5 text-slate-400" />
        <div className="space-y-1 text-slate-600 dark:text-slate-400">
          <p>
            KDust authenticates via <b>WorkOS OAuth</b> (same flow as{' '}
            <code>dust chat</code> interactive), not via an{' '}
            <code>sk-…</code> custom workspace API key. Combined with{' '}
            <code>origin ∈ {'{web, triggered, …}'}</code> on every
            message, this should keep every conversation in the{' '}
            <b>non-programmatic</b> bucket.
          </p>
          <p>
            This page calls{' '}
            <a
              href="https://docs.dust.tt/reference/get_api-v1-w-wid-analytics-export"
              target="_blank"
              rel="noreferrer"
              className="underline inline-flex items-center gap-0.5"
            >
              <code>/api/v1/w/{'{wId}'}/analytics/export</code>
              <ExternalLink size={10} />
            </a>{' '}
            to pull the per-source message breakdown. A count &gt; 0
            on any of <code>api</code>, <code>cli_programmatic</code>,{' '}
            <code>triggered_programmatic</code> means a message was
            billed.
          </p>
          <p className="italic">
            Note: the endpoint requires workspace-admin rights on Dust,
            and data may lag real-time by up to a few hours.
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-end">
        <label className="text-xs">
          <span className="block text-slate-500 mb-0.5">Start date</span>
          <input
            type="date"
            value={startDate}
            max={endDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="block text-slate-500 mb-0.5">End date</span>
          <input
            type="date"
            value={endDate}
            min={startDate}
            max={today}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm"
          />
        </label>
        <Button onClick={() => void load()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      {/* Error pane */}
      {err && (
        <div className="border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 text-red-900 dark:text-red-200 rounded-md p-3 text-sm">
          <p className="font-semibold mb-1">
            Upstream error {err.status}
          </p>
          {err.status === 403 && (
            <p className="text-xs mb-1">
              The Dust analytics endpoint is{' '}
              <b>admin-only</b>. Ask a Dust workspace admin to grant
              you admin rights, or have them run the check on your
              behalf.
            </p>
          )}
          {err.status === 401 && (
            <p className="text-xs mb-1">
              No valid Dust session. Please sign in again.
            </p>
          )}
          {err.detail && (
            <pre className="text-[10px] font-mono whitespace-pre-wrap bg-red-100/50 dark:bg-red-950/40 rounded p-2 mt-1">
              {err.detail}
            </pre>
          )}
        </div>
      )}

      {/* Result */}
      {data && breakdown && !breakdown.unknown && (
        <>
          {/* Verdict banner */}
          {breakdown.billedTotal > 0 ? (
            <div className="border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-red-900 dark:text-red-200 rounded-md p-4 flex items-start gap-3">
              <ShieldAlert size={20} className="shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">
                  {breakdown.billedTotal} message(s) routed to the
                  PROGRAMMATIC (billed) bucket.
                </p>
                <p className="text-xs mt-1">
                  At least one KDust message landed under{' '}
                  <code>api</code> / <code>*_programmatic</code>. This
                  will consume Dust credits. Please open a ticket to{' '}
                  <code>support@dust.tt</code> and investigate the
                  origin field on affected conversations.
                </p>
              </div>
            </div>
          ) : (
            <div className="border border-green-300 dark:border-green-900 bg-green-50 dark:bg-green-950/30 text-green-900 dark:text-green-200 rounded-md p-4 flex items-start gap-3">
              <ShieldCheck size={20} className="shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">
                  All {breakdown.safeTotal} message(s) classified as
                  human usage — not billed as programmatic.
                </p>
                <p className="text-xs mt-1">
                  Period {data.startDate} → {data.endDate}. No messages
                  found under <code>api</code>,{' '}
                  <code>cli_programmatic</code>, or{' '}
                  <code>triggered_programmatic</code>.
                </p>
              </div>
            </div>
          )}

          {/* Breakdown table */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-left bg-slate-50 dark:bg-slate-900/80 text-slate-500">
                <tr>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2 text-right">Messages</th>
                  <th className="px-3 py-2 text-right">Billed?</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.items.map((it) => (
                  <tr
                    key={it.source}
                    className={
                      'border-t border-slate-200 dark:border-slate-800 ' +
                      (it.billed && it.count > 0
                        ? 'bg-red-50 dark:bg-red-950/20'
                        : '')
                    }
                  >
                    <td className="px-3 py-2 font-mono text-xs">{it.source}</td>
                    <td className="px-3 py-2 text-right font-mono">{it.count}</td>
                    <td className="px-3 py-2 text-right text-xs">
                      {it.billed ? (
                        <span className="text-red-700 dark:text-red-300 font-semibold">
                          yes (programmatic)
                        </span>
                      ) : (
                        <span className="text-green-700 dark:text-green-300">
                          no (human usage)
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {breakdown.items.length === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      className="px-3 py-4 text-center text-slate-400 text-xs italic"
                    >
                      No messages in this period.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot className="bg-slate-50 dark:bg-slate-900/80 text-xs font-semibold">
                <tr className="border-t border-slate-200 dark:border-slate-800">
                  <td className="px-3 py-2">Total</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {breakdown.safeTotal + breakdown.billedTotal}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="text-green-700 dark:text-green-300">
                      {breakdown.safeTotal} safe
                    </span>{' '}
                    ·{' '}
                    <span
                      className={
                        breakdown.billedTotal > 0
                          ? 'text-red-700 dark:text-red-300'
                          : 'text-slate-400'
                      }
                    >
                      {breakdown.billedTotal} billed
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="text-[10px] text-slate-400">
            Columns picked: source=<code>{breakdown.sourceCol}</code>,
            count=<code>{breakdown.countCol}</code>. Workspace{' '}
            <code>{data.workspaceId}</code>.
          </p>
        </>
      )}

      {/* Unrecognised schema fallback */}
      {data && breakdown?.unknown && (
        <div className="border border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 rounded-md p-3 text-xs">
          <p className="font-semibold">Unrecognised CSV schema</p>
          <p>
            Could not pick source / count columns from{' '}
            <code>{data.columns.join(', ')}</code>. Raw rows below —
            please check the Dust docs for schema changes and open an
            issue.
          </p>
          <pre className="mt-2 bg-amber-100/50 dark:bg-amber-950/40 rounded p-2 font-mono text-[10px] max-h-60 overflow-auto">
            {JSON.stringify(data.rows.slice(0, 20), null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
