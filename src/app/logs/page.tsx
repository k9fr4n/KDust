'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, ScrollText, Pause, Play, Filter, Copy, Check } from 'lucide-react';

type LogEntry = {
  id: number;
  ts: number;
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
};

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  log: 'text-slate-200',
  info: 'text-sky-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
};

export default function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
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

  const filtered = filter
    ? entries.filter((e) => e.text.toLowerCase().includes(filter.toLowerCase()))
    : entries;

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

          <label className="text-xs flex items-center gap-1">
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
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
            onClick={clear}
            className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-red-500 text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
          >
            <Trash2 size={14} /> Clear
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-950 text-slate-100 font-mono text-xs leading-relaxed overflow-auto h-[calc(100vh-11rem)]">
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
