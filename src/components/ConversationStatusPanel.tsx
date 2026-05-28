'use client';

/**
 * <ConversationStatusPanel/>
 *
 * Topbar popover replacing the legacy "MCP tools" hover tooltip
 * (Franck 2026-05-28). New role:
 *   1. Show the live Dust context-usage gauge (tokens used / total
 *      budget, percent, model label) with a one-click Compact
 *      button that triggers a server-side POST /compactions and
 *      polls until the gauge drops.
 *   2. Open-in-Dust link (moved out of the topbar action cluster).
 *   3. Condensed MCP servers status — status dots only, no tool
 *      list.
 *
 * Triggered by click (not hover) so the button inside the popover
 * stays reachable. Click-outside and Escape close it. Mobile
 * layout: full-width bandeau under the topbar with a backdrop;
 * desktop: anchored to the trigger button, 24rem wide.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Gauge,
  ExternalLink,
  RotateCw,
  Loader2,
  X as XIcon,
} from 'lucide-react';

export type McpServerStatus =
  | 'ready'
  | 'starting'
  | 'failed'
  | 'inactive'
  | 'task-only';

export type McpServerView = {
  id: string;
  name: string;
  status: McpServerStatus;
};

type ContextUsageResp = {
  ok: boolean;
  usage?: number | null;
  size?: number | null;
  percent?: number | null;
  modelProvider?: string | null;
  modelId?: string | null;
};

const STATUS_DOT: Record<McpServerStatus, string> = {
  ready: 'bg-green-500',
  starting: 'bg-amber-500',
  failed: 'bg-red-500',
  inactive: 'bg-red-500',
  'task-only': 'bg-slate-400 dark:bg-slate-600',
};

const STATUS_LABEL: Record<McpServerStatus, string> = {
  ready: 'ready',
  starting: 'starting\u2026',
  failed: 'failed',
  inactive: 'inactive',
  'task-only': 'task-only',
};

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '\u2014';
  return new Intl.NumberFormat('fr-FR').format(n);
}

function fmtPct(p: number | null | undefined): string {
  if (p === null || p === undefined) return '\u2014';
  const v = p * 100;
  if (v < 10) return v.toFixed(1) + '\u00a0%';
  return Math.round(v) + '\u00a0%';
}

function gaugeColor(p: number | null | undefined): string {
  if (p === null || p === undefined) return 'bg-slate-300 dark:bg-slate-600';
  if (p < 0.6) return 'bg-emerald-500';
  if (p < 0.85) return 'bg-amber-500';
  return 'bg-red-500';
}

function triggerColor(p: number | null | undefined, allMcpReady: boolean): string {
  // Color priority: critical context first, then MCP health, then
  // neutral. This way an 87% context turns the icon red even if
  // MCP is fine.
  if (p !== null && p !== undefined && p >= 0.85) {
    return 'text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30';
  }
  if (p !== null && p !== undefined && p >= 0.6) {
    return 'text-amber-500 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30';
  }
  if (!allMcpReady) {
    return 'text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30';
  }
  return 'text-success-strong dark:text-green-400 hover:bg-success-subtle dark:hover:bg-green-950/30';
}

export function ConversationStatusPanel({
  conversationId,
  dustConversationSId,
  workspaceId,
  mcpServers,
  projectName,
  buttonBaseClassName,
}: {
  conversationId: string | null;
  dustConversationSId: string | null;
  workspaceId: string | null;
  mcpServers: McpServerView[];
  projectName: string | null;
  /** Base layout class shared with the other topbar action buttons. */
  buttonBaseClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<ContextUsageResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const compactInitialRef = useRef<number | null>(null);
  const compactStartRef = useRef<number>(0);

  const allMcpReady =
    mcpServers.length > 0 &&
    mcpServers.every((s) => s.status === 'ready' || s.status === 'task-only');

  const refresh = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/conversation/${conversationId}/context-usage`,
      );
      if (r.ok) {
        const j = (await r.json()) as ContextUsageResp;
        setCtx(j);
      } else {
        setCtx({ ok: false });
      }
    } catch {
      setCtx({ ok: false });
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  // Fetch on open + when conversationId changes while open.
  useEffect(() => {
    if (open && conversationId) void refresh();
  }, [open, conversationId, refresh]);

  // Auto-refresh every 15 s while open and not compacting.
  useEffect(() => {
    if (!open || compacting) return;
    const t = setInterval(() => void refresh(), 15000);
    return () => clearInterval(t);
  }, [open, compacting, refresh]);

  // Polling loop during compaction: refresh every 2 s, stop when
  // usage has dropped by >=15% from the snapshot taken at button
  // click, or after 60 s timeout.
  useEffect(() => {
    if (!compacting) return;
    let cancelled = false;
    const loop = async () => {
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 2000));
        if (cancelled) return;
        try {
          const r = await fetch(
            `/api/conversation/${conversationId}/context-usage`,
          );
          if (r.ok) {
            const j = (await r.json()) as ContextUsageResp;
            if (!cancelled) setCtx(j);
            const u = j.usage ?? null;
            const u0 = compactInitialRef.current;
            if (u !== null && u0 !== null && u <= u0 * 0.85) {
              if (!cancelled) setCompacting(false);
              return;
            }
          }
        } catch {
          /* keep polling */
        }
        if (Date.now() - compactStartRef.current > 60000) {
          if (!cancelled) setCompacting(false);
          return;
        }
      }
    };
    void loop();
    return () => {
      cancelled = true;
    };
  }, [compacting, conversationId]);

  // Click-outside + Escape to close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        panelRef.current &&
        !panelRef.current.contains(t) &&
        buttonRef.current &&
        !buttonRef.current.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onCompact = async () => {
    if (!conversationId || compacting) return;
    setError(null);
    // Snapshot the current usage BEFORE flipping into compacting
    // mode so the polling loop has a reference point.
    compactInitialRef.current = ctx?.usage ?? null;
    compactStartRef.current = Date.now();
    setCompacting(true);
    try {
      const r = await fetch(
        `/api/conversation/${conversationId}/compact`,
        { method: 'POST' },
      );
      if (!r.ok) {
        const body: { error?: unknown } = await r
          .json()
          .catch(() => ({}));
        const msg =
          (typeof body.error === 'string' ? body.error : null) ??
          `compact failed (${r.status})`;
        setError(msg);
        setCompacting(false);
        return;
      }
      // Polling loop is wired through the [compacting] effect above.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCompacting(false);
    }
  };

  const dustHref =
    dustConversationSId && workspaceId
      ? `https://app.dust.tt/w/${workspaceId}/conversation/${dustConversationSId}`
      : null;

  const ctxLoaded = ctx?.ok === true;
  const percent = ctxLoaded ? ctx?.percent ?? null : null;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Conversation status"
        aria-expanded={open}
        className={`${buttonBaseClassName} ${triggerColor(percent, allMcpReady)}`}
      >
        <Gauge size={16} />
      </button>

      {open && (
        <>
          {/* Mobile backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/30 sm:hidden"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Conversation status"
            className={
              'z-50 rounded-md border border-slate-200 dark:border-slate-700 ' +
              'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 ' +
              'shadow-lg p-3 text-xs space-y-3 ' +
              'fixed inset-x-2 top-14 sm:absolute sm:inset-auto ' +
              'sm:right-0 sm:top-full sm:mt-1 sm:w-96 ' +
              'max-h-[80vh] overflow-y-auto'
            }
          >
            {/* Mobile close affordance */}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="sm:hidden absolute top-2 right-2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              aria-label="Close"
            >
              <XIcon size={14} />
            </button>

            {/* ---- Context usage section ---- */}
            <section>
              <div className="flex items-center justify-between mb-1">
                <p className="font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                  <Gauge size={14} /> Context
                </p>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  aria-label="Refresh context usage"
                  className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 p-1 -m-1"
                  disabled={loading}
                >
                  {loading ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RotateCw size={12} />
                  )}
                </button>
              </div>
              <div className="space-y-1">
                <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    className={'h-full transition-[width] duration-500 ease-out ' + gaugeColor(percent)}
                    style={{
                      width:
                        percent !== null && percent !== undefined
                          ? `${Math.min(100, percent * 100)}%`
                          : '0%',
                    }}
                  />
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 text-[11px]">
                  <span className="font-mono">
                    {fmtNum(ctx?.usage)} / {fmtNum(ctx?.size)}
                  </span>
                  <span
                    className={
                      'font-mono font-semibold ' +
                      (percent !== null && percent !== undefined && percent >= 0.85
                        ? 'text-red-500'
                        : percent !== null && percent !== undefined && percent >= 0.6
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-slate-500 dark:text-slate-400')
                    }
                  >
                    {fmtPct(percent)}
                  </span>
                </div>
                {(ctx?.modelId || ctx?.modelProvider) && (
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono truncate">
                    {[ctx?.modelId, ctx?.modelProvider].filter(Boolean).join(' \u00b7 ')}
                  </div>
                )}
                {!ctxLoaded && !loading && (
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 italic">
                    {dustConversationSId
                      ? 'unavailable (Dust unreachable or empty conversation)'
                      : 'no Dust conversation yet'}
                  </div>
                )}
                <div className="pt-1.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={onCompact}
                    disabled={!dustConversationSId || compacting || !ctxLoaded}
                    className={
                      'inline-flex items-center gap-1.5 rounded-md ' +
                      'border border-slate-300 dark:border-slate-700 ' +
                      'px-2 py-1 text-[11px] font-medium ' +
                      'hover:bg-slate-50 dark:hover:bg-slate-800 ' +
                      'disabled:opacity-50 disabled:cursor-not-allowed'
                    }
                    title={
                      compacting
                        ? 'Compacting older messages\u2026'
                        : 'Compact older messages to free context'
                    }
                  >
                    {compacting ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RotateCw size={12} />
                    )}
                    {compacting ? 'Compacting\u2026' : 'Compact'}
                  </button>
                  {dustHref && (
                    <a
                      href={dustHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-brand-600 dark:hover:text-brand-400 underline decoration-dotted"
                    >
                      <ExternalLink size={12} /> Open in Dust
                    </a>
                  )}
                </div>
                {error && (
                  <p className="text-[11px] text-red-500 dark:text-red-400 pt-1">
                    {error}
                  </p>
                )}
              </div>
            </section>

            <div className="-mx-3 border-t border-slate-200 dark:border-slate-700" />

            {/* ---- MCP servers section ---- */}
            <section>
              <p className="font-semibold text-slate-800 dark:text-slate-100 mb-1">
                MCP servers
              </p>
              {mcpServers.length === 0 ? (
                <p className="text-[11px] text-slate-500 dark:text-slate-400 italic">
                  (none)
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {mcpServers.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between text-[11px]"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[s.status]}`}
                        />
                        <span className="font-mono truncate">{s.name}</span>
                      </span>
                      <span className="text-slate-500 dark:text-slate-400 ml-2 shrink-0">
                        {STATUS_LABEL[s.status]}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {projectName && (
                <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1.5">
                  Project:{' '}
                  <code className="font-mono">{projectName}</code>
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
