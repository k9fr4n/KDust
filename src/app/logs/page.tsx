'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trash2, ScrollText, Pause, Play, Filter, Copy, Check, Download } from 'lucide-react';

type LogLevel = 'log' | 'info' | 'warn' | 'error';

type LogEntry = {
  id: number;
  ts: number;
  level: LogLevel;
  text: string;
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  log: 'text-slate-200',
  info: 'text-sky-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
};

// Active-button styling for each level pill, when its toggle
// is ON. Inactive state uses the neutral border below.
const LEVEL_PILL: Record<LogLevel, string> = {
  log: 'bg-slate-700 text-slate-100 border-slate-600',
  info: 'bg-sky-500/15 text-sky-300 border-sky-700',
  warn: 'bg-amber-500/15 text-amber-300 border-amber-700',
  error: 'bg-red-500/15 text-red-300 border-red-700',
};

const ALL_LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error'];

// Pixel tolerance: if the scroll viewport is within this many
// pixels of its bottom we consider the user "at bottom" and
// re-enable autoscroll. 32 leaves room for one ~3-line entry
// to appear below without flipping the state on every render.
const STICK_BOTTOM_TOLERANCE_PX = 32;

export default function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  // Per-level toggle. Default = everything on. Stored as a Set
  // (over an array) for O(1) lookup in the render loop.
  const [enabledLevels, setEnabledLevels] = useState<Set<LogLevel>>(
    () => new Set<LogLevel>(ALL_LEVELS),
  );
  const [autoscroll, setAutoscroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  // Reference to the SCROLLING viewport, not the inner content
  // div: that's what owns scrollTop / clientHeight / scrollHeight.
  const scrollRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (esRef.current) esRef.current.close();
    const es = new EventSource('/api/logs/stream');
    esRef.current = es;
    es.addEventListener('log', (e: MessageEvent) => {
      try {
        const entry = JSON.parse(e.data) as LogEntry;
        setEntries((arr) => {
          const next = [...arr, entry];
          // keep viewport reasonable
          if (next.length > 5000) next.splice(0, next.length - 5000);
          return next;
        });
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => {
      // Let browser retry automatically
    };
  }, []);

  useEffect(() => {
    if (!paused) {
      connect();
    } else {
      esRef.current?.close();
      esRef.current = null;
    }
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [paused, connect]);

  useEffect(() => {
    if (autoscroll && !paused) endRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [entries, autoscroll, paused]);

  /**
   * Smart autoscroll: the checkbox stops being a static toggle
   * and reflects the user's intent inferred from the scroll
   * position. If they scroll up (away from the bottom edge),
   * we suspend autoscroll so the read-up isn't yanked back. As
   * soon as they scroll back to the bottom, autoscroll resumes.
   *
   * Implementation note: we still expose the checkbox so the
   * user has a manual override AND a visible indicator of the
   * current mode. The setState is guarded against redundant
   * updates with a strict equality check to keep React's diff
   * cheap on every scroll event.
   */
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.clientHeight - el.scrollTop;
    const atBottom = distanceFromBottom <= STICK_BOTTOM_TOLERANCE_PX;
    setAutoscroll((prev) => (prev === atBottom ? prev : atBottom));
  }, []);

  const clear = async () => {
    await fetch('/api/logs', { method: 'DELETE' });
    setEntries([]);
  };

  const copy = async () => {
    const text = filtered
      .map(
        (e) =>
          `${new Date(e.ts).toISOString().substring(11, 23)} [${e.level}] ${e.text}`,
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: create a textarea, select and execCommand('copy')
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
  };

  /**
   * Download the currently visible (filtered) log lines as a
   * plain-text file. Filename includes a sortable timestamp so
   * multiple captures stack chronologically in the operator's
   * Downloads folder.
   *
   * Format mirrors the on-screen renderer: full ISO-8601
   * timestamp (vs the truncated HH:MM:SS.mmm shown in the
   * viewer) so the file remains useful when read out of context
   * \u2014 e.g. attached to a bug report.
   *
   * Filtered set is used (not the raw buffer) so what you see
   * is what you get \u2014 in particular, "errors only" + a text
   * filter exports exactly that scope.
   */
  const download = () => {
    const text = filtered
      .map(
        (e) =>
          `${new Date(e.ts).toISOString()} [${e.level}] ${e.text}`,
      )
      .join('\n');
    // Filesystem-friendly timestamp: YYYYMMDD-HHmmss in local
    // time. Avoids ":" which Windows refuses in filenames.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kdust_log_${ts}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer revoke so Safari has time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Per-level total counts (over the full unfiltered buffer).
  // Surfaced next to each level pill so the operator sees "you
  // have 12 errors waiting" even when the level is currently
  // hidden by the toggle.
  const levelCounts = useMemo(() => {
    const counts: Record<LogLevel, number> = {
      log: 0,
      info: 0,
      warn: 0,
      error: 0,
    };
    for (const e of entries) counts[e.level]++;
    return counts;
  }, [entries]);

  const filtered = useMemo(() => {
    const needle = filter.toLowerCase();
    return entries.filter((e) => {
      if (!enabledLevels.has(e.level)) return false;
      if (needle && !e.text.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [entries, filter, enabledLevels]);

  const toggleLevel = (lvl: LogLevel) => {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(lvl)) next.delete(lvl);
      else next.add(lvl);
      return next;
    });
  };

  const showOnlyErrors = () => setEnabledLevels(new Set<LogLevel>(['error']));
  const showAllLevels = () => setEnabledLevels(new Set<LogLevel>(ALL_LEVELS));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <ScrollText size={20} className="text-slate-400 shrink-0" />
        <h1 className="text-2xl font-bold">Container logs</h1>
        <span className="text-sm text-slate-500">
          {filtered.length} / {entries.length} lines
        </span>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Filter size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter…"
              className="pl-7 pr-2 py-1.5 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-48"
            />
          </div>

          <label
            className="text-xs flex items-center gap-1"
            title={
              autoscroll
                ? 'Following bottom — scroll up to pause'
                : 'Paused at scroll position — scroll down to resume'
            }
          >
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => {
                const next = e.target.checked;
                setAutoscroll(next);
                // Manual re-enable jumps to bottom immediately so
                // the toggle has a visible effect.
                if (next) {
                  requestAnimationFrame(() =>
                    endRef.current?.scrollIntoView({ behavior: 'auto' }),
                  );
                }
              }}
            />
            autoscroll
          </label>

          <button
            onClick={() => setPaused((p) => !p)}
            className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? 'Resume' : 'Pause'}
          </button>

          <button
            onClick={copy}
            title={`Copy ${filtered.length} line(s) to clipboard`}
            className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
            {copied ? 'Copied!' : 'Copy'}
          </button>

          <button
            onClick={download}
            title={`Download ${filtered.length} line(s) as kdust_log_<timestamp>.txt`}
            className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Download size={14} /> Download
          </button>

          <button
            onClick={clear}
            className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-red-500 text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
          >
            <Trash2 size={14} /> Clear
          </button>
        </div>
      </div>

      {/* Per-level toggle pills + quick presets. Mirrors the
          colour scheme used inside the log viewer so the
          mapping is obvious. Click a pill to hide that level;
          the count next to it always reflects the FULL buffer
          (not just what's currently visible) so the operator
          can see "12 errors waiting" even when errors are
          hidden. */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-slate-500">Levels:</span>
        {ALL_LEVELS.map((lvl) => {
          const active = enabledLevels.has(lvl);
          return (
            <button
              key={lvl}
              onClick={() => toggleLevel(lvl)}
              className={
                'px-2 py-0.5 rounded border transition ' +
                (active
                  ? LEVEL_PILL[lvl]
                  : 'border-slate-700 text-slate-500 hover:text-slate-300')
              }
              title={
                active
                  ? `Hide ${lvl} entries`
                  : `Show ${lvl} entries`
              }
            >
              {lvl}
              <span className="ml-1 text-slate-400">
                ({levelCounts[lvl]})
              </span>
            </button>
          );
        })}
        <button
          onClick={showOnlyErrors}
          className="ml-2 px-2 py-0.5 rounded border border-red-800 text-red-300 hover:bg-red-500/10"
          title="Show only error-level entries"
        >
          errors only
        </button>
        <button
          onClick={showAllLevels}
          className="px-2 py-0.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800"
          title="Re-enable all levels"
        >
          all
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="rounded-lg border border-slate-800 bg-slate-950 text-slate-100 font-mono text-xs leading-relaxed overflow-auto h-[calc(100vh-13rem)]"
      >
        <div className="p-3 whitespace-pre-wrap">
          {filtered.length === 0 && (
            <div className="text-slate-500 italic">No logs captured yet…</div>
          )}
          {filtered.map((e) => (
            <div key={e.id} className={LEVEL_COLOR[e.level]}>
              <span className="text-slate-500">
                {new Date(e.ts).toISOString().substring(11, 23)}
              </span>{' '}
              <span className="text-slate-400">[{e.level}]</span> {e.text}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}
