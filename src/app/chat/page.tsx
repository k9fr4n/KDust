'use client';
import { Fragment, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/Button';
import { MessageMarkdown } from '@/components/MessageMarkdown';
import {
  MessageSquare,
  Plus,
  Send,
  Square,
  Trash2,
  Wrench,
  Clock,
  Pin,
  PinOff,
} from 'lucide-react';

type Agent = { sId: string; name: string };
type ConvSummary = {
  id: string;
  title: string;
  agentName: string | null;
  agentSId: string;
  updatedAt: string;
  projectName: string | null;
  /** Dashboard and /chat share the same pin state via /api/conversations/:id/pin. */
  pinned?: boolean;
  /** Optional — only present if the API returns it; used for tooltips. */
  createdAt?: string;
  /** Optional — count of messages for the sidebar badge. */
  messageCount?: number;
};
type Msg = { id: string; role: 'user' | 'agent' | 'system'; content: string; createdAt?: string };

/**
 * Short relative-time label ("just now", "3m", "2h", "yesterday",
 * "Mon", "12 Mar"). Kept intentionally terse for the sidebar. The
 * full timestamp remains accessible via the `title` attribute on
 * every element that uses this helper.
 */
function relTime(iso?: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d`;
  const dt = new Date(iso);
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return dt.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Short HH:MM for message bubbles. */
function clockTime(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Full human label for tooltips. */
function fullTime(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

/** Elapsed seconds → "1m 23s" / "45s" / "2h 03m". */
function elapsed(sinceIso?: string | null, nowMs?: number): string {
  if (!sinceIso) return '';
  const from = new Date(sinceIso).getTime();
  if (!Number.isFinite(from)) return '';
  const diff = Math.max(0, Math.round(((nowMs ?? Date.now()) - from) / 1000));
  if (diff < 60) return `${diff}s`;
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export default function ChatPage() {
  // Suspense boundary required by Next.js 15 because ChatPageInner calls useSearchParams().
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">Loading chat…</div>}>
      <ChatPageInner />
    </Suspense>
  );
}

function ChatPageInner() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [agentSId, setAgentSId] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [cotText, setCotText] = useState('');
  const [toolCalls, setToolCalls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentProject, setCurrentProject] = useState<string | null>(null);
  const [mcpServerId, setMcpServerId] = useState<string | null>(null);
  const [mcpStatus, setMcpStatus] = useState<'idle' | 'starting' | 'ready' | 'error'>('idle');
  // `serverStreaming` reflects server-side knowledge of an in-flight agent
  // reply. It stays true even if the user navigated away and came back,
  // as long as the Dust call is still producing tokens in the background.
  const [serverStreaming, setServerStreaming] = useState(false);
  const [serverStreamingSince, setServerStreamingSince] = useState<string | null>(null);
  // When the *local* SSE read loop starts, we record the wall-clock
  // time so the status strip can display a live "1m 23s" counter,
  // mirroring what serverStreamingSince does for detached streams.
  const [localStreamStartedAt, setLocalStreamStartedAt] = useState<string | null>(null);
  // Heartbeat tick (ms) used to re-render the relative-time labels
  // (sidebar "2h", status strip elapsed, message "just now"). Cheap
  // global re-render, gated so it only ticks while something is live.
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    // Always tick once a minute for sidebar/relative labels. Tick
    // every second when a stream is live for the elapsed counter.
    const anyStreaming = streaming || serverStreaming;
    const period = anyStreaming ? 1000 : 60_000;
    const id = setInterval(() => setNowTick(Date.now()), period);
    return () => clearInterval(id);
  }, [streaming, serverStreaming]);
  // AbortController for the current SSE fetch so the Stop button can
  // tear the client read loop down immediately, in addition to asking
  // Dust (via /cancel) to stop generating server-side.
  const streamAbortRef = useRef<AbortController | null>(null);
  const [stopping, setStopping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();

  const refreshConvs = async () => {
    const r = await fetch('/api/conversations');
    const j = await r.json();
    setConvs(j.conversations ?? []);
  };

  const loadConv = async (id: string) => {
    setCurrentId(id);
    setStreamedText('');
    setCotText('');
    setError(null);
    const r = await fetch(`/api/conversations/${id}`);
    const j = await r.json();
    const c = j.conversation;
    setMessages(c?.messages ?? []);
    setAgentSId(c?.agentSId ?? '');
    // Reflect server-side stream status so users who navigated away
    // mid-answer can still see that the reply is being produced.
    setServerStreaming(!!j.streaming);
    setServerStreamingSince(j.streamingSince ?? null);

    // Sync the current-project cookie + ProjectSwitcher with the conversation's project
    const convProject: string | null = c?.projectName ?? null;
    if (convProject !== currentProject) {
      try {
        await fetch('/api/current-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: convProject }),
        });
      } catch {
        /* ignore */
      }
      setCurrentProject(convProject);
      window.dispatchEvent(
        new CustomEvent('kdust:project-changed', { detail: { name: convProject } }),
      );
      // Re-ensure MCP fs server for the new project
      if (convProject) {
        setMcpStatus('starting');
        try {
          const rr = await fetch('/api/mcp/ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: convProject }),
          });
          const jj = await rr.json();
          if (rr.ok && jj.serverId) {
            setMcpServerId(jj.serverId);
            setMcpStatus('ready');
          } else {
            setMcpStatus('error');
          }
        } catch {
          setMcpStatus('error');
        }
      } else {
        setMcpServerId(null);
        setMcpStatus('idle');
      }
    }
  };

  useEffect(() => {
    void fetch('/api/agents')
      .then((r) => r.json())
      .then((j) => {
        const list = j.agents ?? [];
        setAgents(list);
        // Use the functional setter form: only fall back to the first agent
        // if loadConv hasn't already set one. The closure captures the initial
        // empty agentSId from mount, so a plain `!agentSId` check would race
        // with loadConv and silently overwrite the conv's actual agent.
        if (list.length) setAgentSId((prev) => prev || list[0].sId);
      })
      .catch(() => setError('Cannot list agents — are you connected to Dust?'));
    void refreshConvs();
    // If ?id=... is present, open that conversation on mount
    const requested = searchParams.get('id');
    if (requested) void loadConv(requested);

    // If ?prompt=<base64> is present, prefill the draft with the
    // decoded text (UTF-8 safe). Used by deep-links from the audit
    // panel: each point has a "Chat" shortcut that opens a new empty
    // conversation with the point description already typed in the
    // textarea so the user just has to hit Send.
    // Prompt can arrive via two channels:
    //   1. sessionStorage (preferred — used by /advices bulk chat +
    //      AuditSection) to avoid URL length limits on big prompts.
    //   2. ?prompt=<base64> query string (legacy single-point deep
    //      link from audit cards).
    // sessionStorage takes precedence and is consumed single-shot.
    if (!requested) {
      try {
        const pending = sessionStorage.getItem('kdust.chat.pendingPrompt');
        if (pending) {
          sessionStorage.removeItem('kdust.chat.pendingPrompt');
          setDraft(pending);
        } else {
          const rawPrompt = searchParams.get('prompt');
          if (rawPrompt) {
            const decoded = decodeURIComponent(escape(atob(rawPrompt)));
            setDraft(decoded);
          }
        }
      } catch {
        // malformed base64 / sessionStorage unavailable — ignore
        // rather than crash the page.
      }
    }
    // Detect current project from cookie and start MCP fs server for it
    void fetch('/api/projects/current')
      .then((r) => (r.ok ? r.json() : { name: null }))
      .then(async (j) => {
        const name = j?.name ?? null;
        setCurrentProject(name);
        if (name) {
          setMcpStatus('starting');
          try {
            const r = await fetch('/api/mcp/ensure', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectName: name }),
            });
            const jj = await r.json();
            if (r.ok && jj.serverId) {
              setMcpServerId(jj.serverId);
              setMcpStatus('ready');
            } else {
              setMcpStatus('error');
              setError(jj.error ?? 'Failed to start MCP fs server');
            }
          } catch (e: any) {
            setMcpStatus('error');
            setError(e?.message ?? String(e));
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamedText]);

  // When the server reports a stream in progress for the current conv
  // but THIS tab is not the one consuming it (e.g. user reopened the
  // conv after navigating away), poll the conv every 3s. When the
  // server clears the flag, fetch messages once more to pick up the
  // freshly-persisted agent reply.
  useEffect(() => {
    if (!currentId || !serverStreaming || streaming) return;
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`/api/conversations/${currentId}`);
        if (!r.ok) return;
        const j = await r.json();
        if (!j.streaming) {
          // stream has finished elsewhere — reload messages (includes the
          // newly-persisted agent reply) and clear the banner.
          setMessages(j.conversation?.messages ?? []);
          setServerStreaming(false);
          setServerStreamingSince(null);
        }
      } catch {
        /* transient */
      }
    }, 3000);
    return () => clearInterval(iv);
  }, [currentId, serverStreaming, streaming]);

  const newChat = () => {
    setCurrentId(null);
    setMessages([]);
    setStreamedText('');
    setCotText('');
    setError(null);
  };

  const consumeStream = async (convId: string, userMessageSId: string) => {
    setStreaming(true);
    setLocalStreamStartedAt(new Date().toISOString());
    // This tab is actively consuming the stream → mirror the server
    // flag so the banner/dot stays visible if the user briefly scrolls
    // up past the live bubble.
    setServerStreaming(true);
    setServerStreamingSince(new Date().toISOString());
    setStreamedText('');
    setCotText('');
    setToolCalls([]);
    try {
      const r = await fetch(
        `/api/conversations/${convId}/stream?userMessageSId=${encodeURIComponent(userMessageSId)}`,
      );
      if (!r.body) throw new Error('no stream');
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const ev = /^event:\s*(\w+)/.exec(frame)?.[1];
          const dataLine = /\ndata:\s*(.*)$/s.exec(frame)?.[1] ?? '';
          const data = dataLine.replace(/\\n/g, '\n');
          if (ev === 'token') setStreamedText((t) => t + data);
          else if (ev === 'cot') setCotText((t) => t + data);
          else if (ev === 'agent_message_id') {
            // Server tracks the sId itself for the /cancel endpoint.
            // We receive it purely for forward-compat / debugging.
          }
          else if (ev === 'tool_call') {
            try {
              const p = JSON.parse(data);
              const summary = `${p.tool}(${
                p.params ? JSON.stringify(p.params).slice(0, 140) : ''
              })`;
              setToolCalls((arr) => [...arr, summary]);
            } catch {
              setToolCalls((arr) => [...arr, data]);
            }
          } else if (ev === 'error') setError(data);
          else if (ev === 'done') {
            setStreamedText('');
            setCotText('');
            setToolCalls([]);
            // reload conv from server (agent message now persisted)
            await loadConv(convId);
            await refreshConvs();
          }
        }
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setStreaming(false);
      setLocalStreamStartedAt(null);
      // loadConv() above will refresh serverStreaming from the API; if the
      // stream wrapped up before we finished consuming, we still want the
      // banner gone immediately.
      setServerStreaming(false);
      setServerStreamingSince(null);
    }
  };

  // Stop the in-flight agent reply. Two concurrent actions:
  //   1) POST /cancel so Dust stops generating tokens server-side
  //      (also clears the active-streams tracker so isStreaming() flips false)
  //   2) Abort the local SSE fetch so the UI unfreezes immediately,
  //      regardless of Dust's response latency.
  const stopStream = async () => {
    if (!currentId || stopping) return;
    setStopping(true);
    try {
      void fetch(`/api/conversations/${currentId}/cancel`, { method: 'POST' }).catch(
        () => {/* best-effort */},
      );
    } finally {
      streamAbortRef.current?.abort();
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || streaming) return;
    const content = draft;
    setDraft('');
    setError(null);

    // Optimistic local append
    setMessages((m) => [
      ...m,
      { id: `tmp-${Date.now()}`, role: 'user', content },
    ]);

    try {
      const mcpServerIds = mcpServerId ? [mcpServerId] : undefined;
      if (!currentId) {
        const agentName = agents.find((a) => a.sId === agentSId)?.name;
        const r = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentSId, agentName, content, mcpServerIds }),
        });
        if (!r.ok) throw new Error((await r.json()).error?.toString() ?? 'error');
        const j = await r.json();
        setCurrentId(j.id);
        await consumeStream(j.id, j.userMessageSId);
      } else {
        const r = await fetch(`/api/conversations/${currentId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, mcpServerIds }),
        });
        if (!r.ok) throw new Error((await r.json()).error?.toString() ?? 'error');
        const j = await r.json();
        await consumeStream(currentId, j.userMessageSId);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const removeConv = async (id: string) => {
    if (!confirm('Delete this conversation?')) return;
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (currentId === id) newChat();
    await refreshConvs();
  };

  /**
   * Toggle pin status on a conversation. Uses the same endpoint as the
   * dashboard's <ConversationCard> so the two views stay in sync —
   * pin here, refresh the dashboard, the same Pin icon appears, and
   * vice-versa. Optimistic update for snappy feedback; falls back to
   * a full refresh on error to avoid drifting from server truth.
   */
  const togglePin = async (id: string, next: boolean) => {
    setConvs((prev) =>
      prev.map((c) => (c.id === id ? { ...c, pinned: next } : c)),
    );
    try {
      const r = await fetch(`/api/conversations/${id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: next }),
      });
      if (!r.ok) throw new Error('pin failed');
      // Re-sort pinned-first without a full network refresh.
      await refreshConvs();
    } catch {
      await refreshConvs();
    }
  };

  // ---- Resizable sidebar ---------------------------------------------------
  // Persist user-chosen width in localStorage so the layout feels stable
  // across reloads. Bounded to [180, 480]px to avoid unusable extremes
  // (titles get truncated aggressively below ~180px; above ~480px the
  // chat pane becomes cramped on a 1280 screen).
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 480;
  const SIDEBAR_DEFAULT = 260;
  const [sidebarW, setSidebarW] = useState<number>(SIDEBAR_DEFAULT);
  useEffect(() => {
    const saved = Number(
      typeof window !== 'undefined'
        ? window.localStorage.getItem('kdust:chat:sidebarW')
        : '',
    );
    if (Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) {
      setSidebarW(saved);
    }
  }, []);
  const draggingRef = useRef(false);
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    // We need the container's left edge to compute the desired width.
    // The handle lives inside the grid wrapper, so we walk up to the
    // element tagged with data-chat-root.
    const root = (e.currentTarget as HTMLElement).closest<HTMLElement>(
      '[data-chat-root]',
    );
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const w = Math.min(
      SIDEBAR_MAX,
      Math.max(SIDEBAR_MIN, e.clientX - rect.left),
    );
    setSidebarW(w);
  };
  const onResizeEnd = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try {
      window.localStorage.setItem('kdust:chat:sidebarW', String(Math.round(sidebarW)));
    } catch {}
  };

  // ---- Auto-growing textarea ----------------------------------------------
  // Grows from ~2 lines to ~12 lines as the user types; capped by CSS
  // max-height so the input never eats the messages pane. Using a
  // manual JS resize (vs CSS field-sizing) keeps Safari/Firefox happy.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const TEXTAREA_MAX_PX = 280; // ~12 lines at default font size
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(TEXTAREA_MAX_PX, el.scrollHeight);
    el.style.height = next + 'px';
    el.style.overflowY = el.scrollHeight > TEXTAREA_MAX_PX ? 'auto' : 'hidden';
  }, []);
  useLayoutEffect(() => {
    autoResize();
  }, [draft, autoResize]);

  const field =
    'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2';

  return (
    // Height math:
    //   - sticky <Nav/> is h-14 (3.5rem) at the top of <body>
    //   - RootLayout wraps children in <main class="py-6"> → 3rem vertical
    // So the chat surface must be calc(100dvh - 6.5rem) to fit exactly on
    // screen without producing a page-level scrollbar. dvh (vs vh) keeps it
    // stable on mobile browsers that resize the viewport with their
    // address bar. min-h-0 lets flex children shrink so only the inner
    // messages pane scrolls, never the page.
    <div
      data-chat-root
      className="flex gap-0 h-[calc(100dvh-6.5rem)] min-h-0 max-w-full"
      onPointerMove={onResizeMove}
      onPointerUp={onResizeEnd}
      onPointerCancel={onResizeEnd}
    >
      {/* Sidebar conversations (resizable) */}
      <aside
        className="flex flex-col min-h-0 border border-slate-200 dark:border-slate-800 rounded-lg shrink-0"
        style={{ width: sidebarW }}
      >
        <div className="p-3 border-b border-slate-200 dark:border-slate-800">
          <Button onClick={newChat} className="w-full justify-center">
            <Plus size={14} /> New chat
          </Button>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {convs.length === 0 && (
            <li className="p-3 text-xs text-slate-500">No conversations yet.</li>
          )}
          {convs.map((c) => (
            <li
              key={c.id}
              className={`group flex items-center gap-1 px-2 ${
                currentId === c.id ? 'bg-slate-100 dark:bg-slate-800' : ''
              }`}
            >
              <button
                onClick={() => loadConv(c.id)}
                className="flex-1 text-left px-2 py-2 min-w-0"
                title={`Last updated ${fullTime(c.updatedAt)}`}
              >
                <div className="flex items-baseline gap-2 min-w-0">
                  {c.pinned && (
                    <Pin
                      size={11}
                      className="text-amber-500 shrink-0"
                      aria-label="Pinned"
                    />
                  )}
                  <div className="text-sm font-medium truncate flex-1">{c.title}</div>
                  <span
                    className="text-[10px] text-slate-400 shrink-0"
                    data-tick={nowTick}
                  >
                    {relTime(c.updatedAt)}
                  </span>
                </div>
                <div className="text-xs text-slate-500 truncate">
                  {c.agentName ?? c.agentSId}
                  {c.projectName && <span className="ml-1">· {c.projectName}</span>}
                </div>
              </button>
              {/*
                Pin toggle. Same endpoint as the dashboard's
                ConversationCard → pinning here shows up there
                after refresh, and vice-versa.
              */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void togglePin(c.id, !c.pinned);
                }}
                className={`p-1 ${
                  c.pinned
                    ? 'text-amber-500 hover:text-amber-600'
                    : 'opacity-0 group-hover:opacity-100 text-slate-400 hover:text-amber-500'
                }`}
                title={c.pinned ? 'Unpin' : 'Pin'}
                aria-label={c.pinned ? 'Unpin conversation' : 'Pin conversation'}
              >
                {c.pinned ? <PinOff size={14} /> : <Pin size={14} />}
              </button>
              <button
                onClick={() => removeConv(c.id)}
                className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-500"
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/*
        Drag handle to resize the sidebar. 4px visual, 12px hit area
        (via padding) for a forgiving grab target. PointerEvents on
        the surrounding <div data-chat-root> track the drag so we
        don't lose it when the cursor leaves the handle.
      */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={onResizeStart}
        className="relative mx-1 w-1 cursor-col-resize shrink-0 group"
        title="Drag to resize"
      >
        <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
        <div className="h-full w-full rounded-full bg-slate-200 dark:bg-slate-800 group-hover:bg-brand-400 transition-colors" />
      </div>

      {/* Main chat pane. min-w-0 lets this flex track actually shrink
          when a message bubble contains unwrappable content (long URL,
          code line with no spaces). Without it, the track grows to fit
          the content and the whole layout overflows horizontally, which
          in turn pushes the body past 100dvh and creates a page-level
          scrollbar on the right. */}
      <section className="flex-1 flex flex-col min-h-0 min-w-0 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3">
          <MessageSquare size={18} className="text-slate-400" />
          <select
            className={field + ' max-w-xs'}
            value={agentSId}
            onChange={(e) => setAgentSId(e.target.value)}
            disabled={!!currentId}
          >
            {agents.map((a) => (
              <option
                key={a.sId}
                value={a.sId}
                className="bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100"
              >
                {a.name}
              </option>
            ))}
          </select>
          {currentId && (
            <span className="text-xs text-slate-500">
              Agent locked for this conversation
            </span>
          )}

          {currentProject && (
            <span
              className={`ml-auto flex items-center gap-1 text-xs px-2 py-1 rounded border ${
                mcpStatus === 'ready'
                  ? 'border-green-600 text-green-700 dark:text-green-400'
                  : mcpStatus === 'starting'
                    ? 'border-amber-500 text-amber-600 dark:text-amber-400'
                    : mcpStatus === 'error'
                      ? 'border-red-500 text-red-600 dark:text-red-400'
                      : 'border-slate-300 text-slate-500'
              }`}
              title={
                mcpServerId
                  ? `MCP fs tools active (serverId=${mcpServerId})`
                  : 'MCP fs tools inactive'
              }
            >
              <Wrench size={12} />
              {mcpStatus === 'ready'
                ? `fs tools · ${currentProject}`
                : mcpStatus === 'starting'
                  ? `starting fs tools…`
                  : mcpStatus === 'error'
                    ? 'fs tools error'
                    : `fs tools idle · ${currentProject}`}
            </span>
          )}
        </div>

        {/*
          Conversation info was previously duplicated here at the top of
          the pane. Removed 2026-04-18 — the persistent status strip
          just above the composer now carries the same info (message
          count, agent, timestamps) and is always in the user's
          immediate visual field regardless of scroll position.
        */}

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 min-h-0">
          {messages.map((m, i) => {
            const prev = i > 0 ? messages[i - 1] : null;
            // Day separator when the day changes between consecutive
            // messages (or at the very top). Works for missing
            // createdAt by simply skipping the separator.
            const showDay =
              !!m.createdAt &&
              (!prev?.createdAt ||
                new Date(m.createdAt).toDateString() !==
                  new Date(prev.createdAt).toDateString());
            const isUser = m.role === 'user';
            const roleLabel = isUser
              ? 'You'
              : m.role === 'system'
                ? 'System'
                : (agents.find((a) => a.sId === agentSId)?.name ?? 'Agent');
            return (
              <Fragment key={m.id}>
                {showDay && (
                  <div className="flex justify-center my-1">
                    <span className="text-[10px] uppercase tracking-wider text-slate-400 bg-white dark:bg-slate-900 px-2 py-0.5 rounded-full border border-slate-200 dark:border-slate-700">
                      {new Date(m.createdAt!).toLocaleDateString(undefined, {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </span>
                  </div>
                )}
                <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                  <div className={`flex flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'} max-w-[85%]`}>
                    <div
                      className={
                        // `break-words` + `min-w-0` on the inner bubble
                        // prevent a long unbroken token (URL, hash,
                        // long file path) from widening the flex
                        // column and forcing a horizontal scrollbar
                        // in the messages pane.
                        (isUser
                          ? 'px-3 py-2 rounded-2xl rounded-br-sm text-sm bg-blue-600 text-white shadow-sm'
                          : m.role === 'system'
                            ? 'px-3 py-2 rounded-2xl text-sm bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200 italic whitespace-pre-wrap'
                            : 'px-3 py-2 rounded-2xl rounded-bl-sm text-sm bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700') +
                        ' break-words min-w-0 overflow-hidden'
                      }
                    >
                      {m.role === 'system' ? (
                        // System messages are short diagnostic strings
                        // (errors, notices). Markdown rendering would
                        // risk mangling them; we keep the plain <pre>.
                        m.content
                      ) : (
                        <MessageMarkdown tone={isUser ? 'user' : 'agent'}>
                          {m.content}
                        </MessageMarkdown>
                      )}
                    </div>
                    <div
                      className={`text-[10px] text-slate-400 px-1 ${isUser ? 'text-right' : 'text-left'}`}
                      data-tick={nowTick}
                    >
                      <span className="font-medium">{roleLabel}</span>
                      {m.createdAt && (
                        <span title={fullTime(m.createdAt)}>
                          {' · '}
                          {clockTime(m.createdAt)}
                          <span className="ml-1 text-slate-300 dark:text-slate-600">
                            ({relTime(m.createdAt)})
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Fragment>
            );
          })}

          {toolCalls.length > 0 && (
            <div className="flex flex-col gap-1">
              {toolCalls.map((t, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-xs text-slate-500 font-mono bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 max-w-fit"
                >
                  <Wrench size={12} className="text-amber-500" />
                  {t}
                </div>
              ))}
            </div>
          )}

          {cotText && (
            <div className="flex justify-start">
              <details className="max-w-[85%] text-xs text-slate-500 italic">
                <summary className="cursor-pointer select-none">thinking…</summary>
                <pre className="whitespace-pre-wrap mt-1 pl-3 border-l-2 border-slate-300 dark:border-slate-700">
                  {cotText}
                </pre>
              </details>
            </div>
          )}

          {streamedText && (
            <div className="flex justify-start">
              <div className="max-w-[85%] px-3 py-2 rounded-2xl rounded-bl-sm text-sm bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700 break-words min-w-0 overflow-hidden">
                <MessageMarkdown tone="agent">{streamedText}</MessageMarkdown>
                <span className="inline-block w-2 h-4 -mb-0.5 ml-0.5 bg-slate-500 animate-pulse" />
              </div>
            </div>
          )}

          {error && (
            <div className="flex justify-start">
              <p className="text-red-500 text-sm">{error}</p>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/*
          Persistent status strip — ALWAYS visible directly above the
          composer so the user never loses sight of what's happening
          (idle / streaming here / streaming on server). Three states:
            - streaming       : this tab is consuming the SSE → blue
            - serverStreaming : another tab/no tab owns the stream → amber
            - idle            : nothing in flight → neutral (shows
                                message count + agent + last activity)
          Per Franck 2026-04-18: "toujours laisser visible l'état
          au-dessus de la fenêtre de saisie".
        */}
        {(() => {
          const active = streaming || serverStreaming;
          const firstAt = messages[0]?.createdAt;
          const lastAt = messages[messages.length - 1]?.createdAt;
          const currentAgent = agents.find((a) => a.sId === agentSId);
          const tone = streaming
            ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 text-blue-800 dark:text-blue-300'
            : serverStreaming
              ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300'
              : 'border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/40 text-slate-500';
          const dotOuter = streaming
            ? 'bg-blue-400'
            : serverStreaming
              ? 'bg-amber-400'
              : 'bg-slate-300 dark:bg-slate-700';
          const dotInner = streaming
            ? 'bg-blue-500'
            : serverStreaming
              ? 'bg-amber-500'
              : 'bg-slate-400 dark:bg-slate-600';
          return (
            <div
              className={`flex items-center gap-2 px-3 py-1.5 text-[11px] border-t ${tone}`}
              role="status"
              aria-live="polite"
            >
              <span className="relative flex h-2 w-2 shrink-0">
                {active && (
                  <span
                    className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${dotOuter}`}
                  />
                )}
                <span
                  className={`relative inline-flex rounded-full h-2 w-2 ${dotInner}`}
                />
              </span>
              <span
                className="flex-1 truncate flex flex-wrap items-center gap-x-2"
                data-tick={nowTick}
              >
                {streaming ? (
                  <>
                    <Clock size={11} className="shrink-0" />
                    <span>Streaming live</span>
                    {localStreamStartedAt && (
                      <span>
                        · elapsed <b>{elapsed(localStreamStartedAt, nowTick)}</b>
                      </span>
                    )}
                  </>
                ) : serverStreaming ? (
                  <>
                    <Clock size={11} className="shrink-0" />
                    <span>Agent is still replying in the background</span>
                    {serverStreamingSince && (
                      <span title={fullTime(serverStreamingSince)}>
                        · started{' '}
                        {new Date(serverStreamingSince).toLocaleTimeString()}{' '}
                        ({elapsed(serverStreamingSince, nowTick)})
                      </span>
                    )}
                  </>
                ) : !currentId ? (
                  <>
                    <MessageSquare size={11} className="shrink-0" />
                    <span>Ready — type a message to start a new conversation</span>
                    {currentAgent && (
                      <span>
                        · agent{' '}
                        <b className="text-slate-700 dark:text-slate-300">
                          {currentAgent.name}
                        </b>
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <MessageSquare size={11} className="shrink-0" />
                    <span>
                      Idle · {messages.length} message
                      {messages.length > 1 ? 's' : ''}
                    </span>
                    {currentAgent && (
                      <span>
                        · agent{' '}
                        <b className="text-slate-700 dark:text-slate-300">
                          {currentAgent.name}
                        </b>
                      </span>
                    )}
                    {lastAt && (
                      <span title={fullTime(lastAt)}>
                        · last message {relTime(lastAt)}
                      </span>
                    )}
                    {firstAt && firstAt !== lastAt && (
                      <span title={fullTime(firstAt)}>
                        · started {relTime(firstAt)}
                      </span>
                    )}
                  </>
                )}
              </span>
              {active && currentId && (
                <button
                  type="button"
                  onClick={stopStream}
                  disabled={stopping}
                  title="Stop the agent's reply"
                  className="inline-flex items-center gap-1 rounded border border-red-400 px-2 py-0.5 text-red-700 hover:bg-red-100 dark:border-red-600 dark:text-red-300 dark:hover:bg-red-900/40 disabled:opacity-50"
                >
                  <Square size={12} />
                  {stopping ? 'Stopping…' : 'Stop'}
                </button>
              )}
            </div>
          );
        })()}

        <form
          onSubmit={send}
          className="p-3 border-t border-slate-200 dark:border-slate-800 flex gap-2 items-end"
        >
          <textarea
            ref={textareaRef}
            className={field + ' resize-none leading-relaxed'}
            rows={2}
            // The height is driven by `autoResize` (see useLayoutEffect
            // on `draft`). max-height is set inline because tailwind's
            // max-h-[Xpx] works but duplicating the constant here
            // keeps the JS ceiling and the CSS ceiling in sync.
            style={{ maxHeight: TEXTAREA_MAX_PX, minHeight: '2.75rem' }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onInput={autoResize}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).form?.requestSubmit();
              }
            }}
            placeholder={currentId ? 'Reply…' : 'Ask anything to start a new conversation…'}
            disabled={streaming || !agentSId}
          />
          <Button type="submit" disabled={streaming || !draft.trim() || !agentSId}>
            <Send size={14} /> {streaming ? 'Streaming…' : 'Send'}
          </Button>
        </form>
      </section>
    </div>
  );
}

