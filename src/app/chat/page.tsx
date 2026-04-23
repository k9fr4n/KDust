'use client';
import { Fragment, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/Button';
import { MessageMarkdown } from '@/components/MessageMarkdown';
import { ChatMessageBubble } from '@/components/ChatMessageBubble';
import {
  publishConvEvent,
  subscribeConvEvents,
} from '@/lib/client/conversationsBus';
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
  Copy,
  Check,
  Paperclip,
  X as XIcon,
  Loader2,
} from 'lucide-react';

type Agent = { sId: string; name: string };
type ConvSummary = {
  id: string;
  /**
   * Dust-side conversation sId (e.g. `ZZ4Vo645fo`) \u2014 the short id
   * visible on dust.tt. Displayed in the /chat header (and used
   * for copy-to-clipboard) so users can cross-link a KDust
   * conversation with its Dust counterpart. Nullable because the
   * local row may exist before the Dust conversation has been
   * assigned an sId (should be rare; first user message creates it).
   */
  dustConversationSId?: string | null;
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
  return dt.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Short HH:MM for message bubbles. */
function clockTime(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Full human label for tooltips. */
function fullTime(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('fr-FR');
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

/**
 * Small inline copy-to-clipboard button used in the conversation
 * header strip (for the sId) and in message bubbles (for the raw
 * message content). Shows a check mark for 1.5s after a successful
 * copy; swallows errors silently (clipboard access can be denied
 * in some iframed / non-secure contexts).
 */
function CopyIdButton({
  value,
  label = 'Copy',
  size = 12,
  className = '',
}: {
  value: string;
  label?: string;
  size?: number;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        } catch {
          /* silent */
        }
      }}
      className={
        'inline-flex items-center gap-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 ' +
        className
      }
      title={done ? 'Copied!' : label}
      aria-label={label}
    >
      {done ? <Check size={size} className="text-green-600" /> : <Copy size={size} />}
    </button>
  );
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
  /**
   * Disable body-level scrolling while /chat is mounted
   * (Franck 2026-04-23 15:31). The chat surface is sized with
   * calc(100dvh - 6.5rem); any conditional element above (the
   * DustAuthBanner, browser chrome changes) can shift the math
   * by a few px and surface a useless global scrollbar. Only the
   * inner messages pane (scrollerRef) should scroll; clipping at
   * <body> is the safe belt-and-braces fix. Reverts on unmount so
   * other routes keep their normal scroll behaviour.
   */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');

  /**
   * Composer attachments (Franck 2026-04-23 16:59).
   *
   * Files go through three lifecycle stages:
   *   - 'uploading': multipart POST to /api/files/upload in flight.
   *   - 'ready':     Dust returned a file sId, ready to send.
   *   - 'error':     upload failed; shown with a red tint, user can
   *                  click the X to remove and retry.
   *
   * Using clientId (crypto.randomUUID) rather than the server sId as
   * the React key because uploads start before the sId is known. The
   * sId lands on the same row when the upload resolves.
   */
  type PendingAttachment = {
    clientId: string;
    name: string;
    size: number;
    contentType: string;
    status: 'uploading' | 'ready' | 'error';
    sId?: string;
    error?: string;
  };
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [agentSId, setAgentSId] = useState('');
  // Tracks priority of the current agent selection. See the lookup
  // in the /api/projects/current effect for the override rules.
  const [agentPickedBy, setAgentPickedBy] = useState<'none' | 'auto' | 'user' | 'conv'>('none');
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

  // --- Windowing (Franck 2026-04-20 10:15) ---
  // Long conversations (hundreds of agent messages with code blocks,
  // tables, syntax highlighting) grind the DOM \u2014 react-markdown
  // keeps the whole tree mounted on every state change. We only
  // render the last `visibleCount` messages and expose a "Show
  // earlier" button at the top. The trimmed messages stay in the
  // `messages` state (no refetch needed when expanding) but do NOT
  // cost DOM / markdown-parse cycles.
  const VISIBLE_STEP = 40;
  const [visibleCount, setVisibleCount] = useState(VISIBLE_STEP);
  // Ref to the scrolling container so we can preserve the scroll
  // position when the user clicks "Show earlier" (see useLayoutEffect).
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Heights are captured synchronously before React paints the new
  // window so we can compensate scrollTop.
  const pendingScrollAdjust = useRef<{ prevHeight: number; prevTop: number } | null>(null);

  // Reset window when we switch conversation: always start at the
  // bottom with a fresh 40-message budget.
  useEffect(() => {
    setVisibleCount(VISIBLE_STEP);
  }, [currentId]);

  // Cross-tab / cross-page sync (Franck 2026-04-20 17:04). When
  // another surface (dashboard, /conversations, a second /chat tab)
  // pins or deletes a conversation, re-pull the list so our sidebar
  // state (still used for the header pin/delete chip\u0027s pinned
  // lookup) and any in-flight state reflect the change. If the
  // current conversation was deleted, reset to a fresh \"new chat\"
  // so we do not keep posting to a dead conv.
  useEffect(() => {
    const unsub = subscribeConvEvents((ev) => {
      if (ev.type === 'deleted' && ev.id === currentId) {
        newChat();
      }
      void refreshConvs();
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // After expanding the window, keep the user\u2019s reading anchor
  // stable: newly inserted content at the top must be above the
  // current viewport, not push it down.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const pending = pendingScrollAdjust.current;
    if (el && pending) {
      const delta = el.scrollHeight - pending.prevHeight;
      el.scrollTop = pending.prevTop + delta;
      pendingScrollAdjust.current = null;
    }
  }, [visibleCount]);

  const showEarlier = () => {
    const el = scrollerRef.current;
    if (el) {
      pendingScrollAdjust.current = {
        prevHeight: el.scrollHeight,
        prevTop: el.scrollTop,
      };
    }
    setVisibleCount((v) => v + VISIBLE_STEP);
  };
  const bottomRef = useRef<HTMLDivElement>(null);

  /**
   * Auto-scroll follow state (Franck 2026-04-23 14:58).
   *
   * When a generation is streaming we auto-scroll the viewport to
   * the latest token. But if the user scrolls UP mid-stream (to
   * re-read an earlier message or copy something), we should stop
   * yanking them back down \u2014 until the NEXT generation starts,
   * at which point follow resumes automatically.
   *
   * Implementation:
   *   - `followStream` (ref, not state) \u2014 true while we are
   *     allowed to scroll-to-bottom on each token. Starts true.
   *   - On scroll events within `scrollerRef`, recompute whether
   *     the user is near the bottom (<= 80px). If they scrolled
   *     away from it, flip the flag to false.
   *   - When a new stream begins (streaming transition from false
   *     to true), flip the flag back to true.\n   *   - Auto-scroll useEffect reads the flag and skips when false.\n   *\n   * A ref, not state, to avoid re-rendering on every scroll tick\n   * (scroll events fire at ~60Hz during fast scrolling). 80px\n   * threshold matches the sticky-bottom convention used in\n   * TaskLiveStatus.tsx.\n   */
  const followStream = useRef(true);
  const NEAR_BOTTOM_PX = 80;
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
    // An open conversation \"owns\" the agent choice \u2014 beats project
    // default and beats list[0] fallback.
    if (c?.agentSId) setAgentPickedBy('conv');
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
        // Auto-fallback to list[0]. Only applied when nothing stronger
        // has claimed the selection yet. Project default (resolved
        // later in /api/projects/current) will overwrite this.
        if (list.length) {
          setAgentSId((prev) => prev || list[0].sId);
          setAgentPickedBy((p) => (p === 'none' ? 'auto' : p));
        }
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
        // Project-level default agent (Franck 2026-04-19 19:13).
        // Overrides the generic list[0] auto-fallback but yields to
        // any stronger claim ('user' manual pick, 'conv' from an
        // open conversation). Skipped entirely when the URL points
        // at a specific conversation.
        const defAgent = j?.project?.defaultAgentSId as string | null | undefined;
        const requested = searchParams.get('id');
        if (defAgent && !requested) {
          setAgentPickedBy((p) => {
            if (p === 'user' || p === 'conv') return p;
            setAgentSId(defAgent);
            return 'auto';
          });
        }
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

  // Auto-scroll to bottom on new content \u2014 but only while the
  // user hasn't manually scrolled up. See the `followStream` ref
  // definition above for the full state machine.
  useEffect(() => {
    if (!followStream.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamedText]);

  // Watch scroll position on the messages container. Any scroll
  // that leaves the near-bottom zone disables follow; scrolling
  // back to the bottom re-enables it (so the user can manually
  // re-engage follow without waiting for the next generation).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      followStream.current = distance <= NEAR_BOTTOM_PX;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // On each new streaming session, re-enable follow. Covers both
  // "send a new message" and "regenerate / continue" flows because
  // they all flip the `streaming` state false \u2192 true.
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (streaming && !prevStreamingRef.current) {
      followStream.current = true;
      // Immediate snap on kick-off so the first token is visible
      // even if the user was previously scrolled up.
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
    prevStreamingRef.current = streaming;
  }, [streaming]);

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

  /**
   * Uploads selected files to /api/files/upload sequentially, one
   * request per File so we can surface per-row errors instead of
   * failing the whole batch. Each file gets a client-side row with
   * status='uploading'; on success the row flips to 'ready' and
   * keeps its Dust sId; on failure the row shows the error message
   * with a retry-by-removal affordance.
   */
  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    // Seed placeholder rows synchronously so the UI reflects the
    // selection immediately. We upload them one by one below.
    const rows: PendingAttachment[] = list.map((f) => ({
      clientId: crypto.randomUUID(),
      name: f.name,
      size: f.size,
      contentType: f.type || 'application/octet-stream',
      status: 'uploading',
    }));
    setAttachments((prev) => [...prev, ...rows]);

    for (let i = 0; i < list.length; i += 1) {
      const file = list[i];
      const row = rows[i];
      const form = new FormData();
      form.append('files', file);
      try {
        const r = await fetch('/api/files/upload', { method: 'POST', body: form });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.detail ?? j.error ?? `HTTP ${r.status}`);
        }
        const j = await r.json();
        const uploaded = j.files?.[0];
        setAttachments((prev) =>
          prev.map((a) =>
            a.clientId === row.clientId
              ? { ...a, status: 'ready', sId: uploaded?.sId }
              : a,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setAttachments((prev) =>
          prev.map((a) =>
            a.clientId === row.clientId ? { ...a, status: 'error', error: msg } : a,
          ),
        );
      }
    }
  };

  const removeAttachment = (clientId: string) => {
    setAttachments((prev) => prev.filter((a) => a.clientId !== clientId));
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || streaming) return;
    // Block sending while attachments are still uploading \u2014 the
    // Dust postContentFragment call would otherwise fire without
    // the intended files. Failed uploads are allowed through: we
    // just drop them from the payload.
    if (attachments.some((a) => a.status === 'uploading')) {
      setError('Please wait for attachments to finish uploading.');
      return;
    }
    const readyFiles = attachments.filter(
      (a): a is PendingAttachment & { sId: string } =>
        a.status === 'ready' && !!a.sId,
    );
    const fileIds = readyFiles.map((a) => a.sId);
    const fileMetas = readyFiles.map((a) => ({
      sId: a.sId,
      name: a.name,
      contentType: a.contentType,
    }));

    const content = draft;
    // Markdown appended to the user message so the attachments
    // render in the thread (thumbnails for images, download link
    // for other files). Mirrors buildAttachmentSuffix() on the
    // server; kept client-side so the optimistic local bubble
    // shows the attachment immediately without waiting for the
    // server round-trip.
    const attachmentMarkdown =
      readyFiles.length > 0
        ? '\n\n' +
          readyFiles
            .map((f) =>
              f.contentType.startsWith('image/')
                ? `![${f.name}](${f.sId})`
                : `[\ud83d\udcce ${f.name}](/api/files/${f.sId})`,
            )
            .join('\n')
        : '';
    const contentWithAttachments = content + attachmentMarkdown;

    setDraft('');
    setAttachments([]); // clear chips so the next turn starts fresh
    setError(null);

    // Optimistic local append \u2014 use the content WITH attachment
    // markdown so the user sees their uploads in the thread
    // immediately. The server persists the same merged content,
    // so the tmp row is replaced seamlessly on refresh.
    setMessages((m) => [
      ...m,
      { id: `tmp-${Date.now()}`, role: 'user', content: contentWithAttachments },
    ]);

    // --- MCP freshness guard (Franck 2026-04-20 14:07) -----------------
    // A cached mcpServerId in React state can go stale if the server-
    // side transport was torn down (token expiry, fs invalidation,
    // cold restart). Re-ensure right before every send: idempotent on
    // the server (returns the same serverId when the handle is still
    // healthy) and prevents the "User does not have access to the
    // client-side MCP servers" 403 that Dust emits for unknown IDs.
    let effectiveMcpServerId: string | null = mcpServerId;
    if (currentProject) {
      try {
        const rr = await fetch('/api/mcp/ensure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectName: currentProject }),
        });
        const jj = await rr.json();
        if (rr.ok && jj.serverId) {
          effectiveMcpServerId = jj.serverId;
          if (jj.serverId !== mcpServerId) setMcpServerId(jj.serverId);
        }
      } catch {
        // Non-fatal \u2014 fall through to the send attempt and let the
        // 403 retry below salvage the call if needed.
      }
    }

    // Small helper: detects the misleading 403 Dust sends when a
    // client-side MCP server ID is unknown (torn down / never
    // registered). The message is verbatim from Dust; we also treat
    // generic 403 as a candidate when we do hold an MCP server id.
    const looksLikeMcpAccessError = (status: number, text: string) =>
      status === 403 &&
      /client-side MCP servers|mcp server|access to/i.test(text);

    const postWithRetry = async (
      url: string,
      body: Record<string, unknown>,
    ): Promise<Response> => {
      const ids = effectiveMcpServerId ? [effectiveMcpServerId] : undefined;
      const first = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, mcpServerIds: ids }),
      });
      if (first.ok) return first;
      // Peek error text without consuming the body for the happy path.
      const errText = await first.clone().text().catch(() => '');
      if (!looksLikeMcpAccessError(first.status, errText) || !currentProject) {
        return first;
      }
      // Retry once with a freshly-ensured serverId.
      console.warn('[chat] Dust rejected MCP serverId; re-ensuring and retrying once');
      try {
        const rr = await fetch('/api/mcp/ensure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectName: currentProject, force: true }),
        });
        const jj = await rr.json();
        if (rr.ok && jj.serverId) {
          effectiveMcpServerId = jj.serverId;
          setMcpServerId(jj.serverId);
        }
      } catch {
        /* swallow \u2014 retry regardless, worst case same error */
      }
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          mcpServerIds: effectiveMcpServerId ? [effectiveMcpServerId] : undefined,
        }),
      });
    };

    try {
      if (!currentId) {
        const agentName = agents.find((a) => a.sId === agentSId)?.name;
        const r = await postWithRetry('/api/conversations', {
          agentSId,
          agentName,
          content,
          fileIds: fileIds.length > 0 ? fileIds : undefined,
          fileMetas: fileMetas.length > 0 ? fileMetas : undefined,
        });
        if (!r.ok) throw new Error((await r.json()).error?.toString() ?? 'error');
        const j = await r.json();
        setCurrentId(j.id);
        await consumeStream(j.id, j.userMessageSId);
      } else {
        const r = await postWithRetry(`/api/conversations/${currentId}/messages`, {
          content,
          fileIds: fileIds.length > 0 ? fileIds : undefined,
          fileMetas: fileMetas.length > 0 ? fileMetas : undefined,
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
    const r = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (currentId === id) newChat();
    await refreshConvs();
    // Notify sibling tabs (dashboard / /conversations / other /chat)
    // so they drop this conv from their listings without a reload.
    if (r.ok) publishConvEvent({ type: 'deleted', id });
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
      // Notify sibling tabs (dashboard / /conversations / other /chat)
      // so their view updates without a manual reload.
      publishConvEvent({ type: 'pinned', id, pinned: next });
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
      {/* -----------------------------------------------------------------
       * Sidebar removed 2026-04-20 (Franck): the conversation list now
       * lives exclusively on the dedicated /conversations dashboard.
       * The "New chat" button was re-added inside the main header
       * (see <section> below). The <aside> block, its drag handle,
       * and the resize state (sidebarW / onResizeStart / ...) are
       * preserved as dead code inside a `false && (...)` wrapper so
       * that reintroducing the sidebar later only requires flipping
       * the flag \u2014 avoids merge churn on the ~90-line block.
       * ---------------------------------------------------------------- */}
      {false && (
      <>
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
      </>
      )}

      {/* Main chat pane. min-w-0 lets this flex track actually shrink
          when a message bubble contains unwrappable content (long URL,
          code line with no spaces). Without it, the track grows to fit
          the content and the whole layout overflows horizontally, which
          in turn pushes the body past 100dvh and creates a page-level
          scrollbar on the right. */}
      <section className="flex-1 flex flex-col min-h-0 min-w-0 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        {/* Toolbar container (Franck 2026-04-23 18:48). Two stacked
            rows in the same bordered block:
              1. Conversation identity (title + copyable Dust sId
                 + open-in-dust link). Only rendered when a
                 conversation is active.
              2. Agent picker + MCP chip + per-conversation
                 actions + New chat.
            Previously these lived in two separate border-b'd
            blocks; merging them keeps the chat header compact and
            groups all meta-info next to the agent selector. */}
        <div className="border-b border-slate-200 dark:border-slate-800">
          {currentId && (() => {
            const currentConv = convs.find((c) => c.id === currentId);
            // Prefer the Dust sId \u2014 that's what dust.tt shows and
            // what users paste for cross-tool navigation. Falls
            // back to the local cuid if the sId hasn't been synced
            // yet (pre-first-message race).
            const displayedId = currentConv?.dustConversationSId ?? currentId;
            return (
              <div className="px-3 pt-2 pb-1 flex items-center gap-3 min-w-0">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate" title={currentConv?.title}>
                    {currentConv?.title ?? 'Untitled conversation'}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                    <code className="font-mono truncate" title={displayedId}>
                      {displayedId}
                    </code>
                    <CopyIdButton value={displayedId} />
                    {currentConv?.dustConversationSId && (
                      <a
                        href={`https://dust.tt/w/0/assistant/${currentConv.dustConversationSId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                        title="Open in Dust"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}
        <div className="p-3 flex items-center gap-3">
          <MessageSquare size={18} className="text-slate-400" />
          <select
            className={field + ' max-w-xs'}
            value={agentSId}
            onChange={(e) => {
              setAgentSId(e.target.value);
              setAgentPickedBy('user');
            }}
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

          {/* Right-aligned cluster: MCP status chip (when a project
              is bound) + the "New chat" button that used to live in
              the now-removed sidebar. `ml-auto` on the wrapper keeps
              both anchored to the right regardless of whether the
              MCP chip is visible. */}
          <div className="ml-auto flex items-center gap-2">
            {currentProject && (
              <span
                className={`flex items-center gap-1 text-xs px-2 py-1 rounded border ${
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
                  ? `fs tools \u00b7 ${currentProject}`
                  : mcpStatus === 'starting'
                    ? `starting fs tools\u2026`
                    : mcpStatus === 'error'
                      ? 'fs tools error'
                      : `fs tools idle \u00b7 ${currentProject}`}
              </span>
            )}
            {/* Per-conversation actions (Franck 2026-04-20 16:46):
                pin + delete for the CURRENT conversation, always
                visible so they are discoverable on touch devices and
                match the /conversations dashboard behaviour. Same
                togglePin / removeConv handlers as the sidebar code
                and the same /api/conversations/:id/pin endpoint as
                ConversationCard \u2014 pin state is therefore shared
                across /chat and the dashboard without extra plumbing. */}
            {currentId && (() => {
              const currentConv = convs.find((c) => c.id === currentId);
              const isPinned = !!currentConv?.pinned;
              return (
                <div className="flex items-center gap-1 border border-slate-200 dark:border-slate-800 rounded px-1 py-0.5">
                  <button
                    type="button"
                    onClick={() => void togglePin(currentId, !isPinned)}
                    title={isPinned ? 'Unpin conversation' : 'Pin conversation'}
                    aria-label={isPinned ? 'Unpin conversation' : 'Pin conversation'}
                    className={`p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 ${
                      isPinned
                        ? 'text-amber-500'
                        : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
                    }`}
                  >
                    {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeConv(currentId)}
                    title="Delete conversation"
                    aria-label="Delete conversation"
                    className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950 text-slate-400 hover:text-red-500"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })()}
            {/* New chat \u2014 moved here from the removed left sidebar
                (Franck 2026-04-20 16:36). Same handler, unchanged
                behaviour. */}
            <Button onClick={newChat} title="Start a new conversation">
              <Plus size={14} /> New chat
            </Button>
          </div>
        </div>
        </div>
        {/* \u2191 closes the merged toolbar container opened above.
            Old standalone identity strip (its own border-b block)
            has been removed in favour of the row nested inside
            this container (see top of section). */}

        <div ref={scrollerRef} className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 min-h-0">
          {/* Windowing banner: only visible when the top of the
              conversation is currently trimmed out. Clicking expands
              the render window by VISIBLE_STEP messages and keeps the
              user\u0027s scroll anchor stable via useLayoutEffect. */}
          {messages.length > visibleCount && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={showEarlier}
                className="text-[11px] px-3 py-1 rounded-full border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                title={`${messages.length - visibleCount} earlier message(s) hidden for performance`}
              >
                ↑ Show {Math.min(VISIBLE_STEP, messages.length - visibleCount)} earlier message{Math.min(VISIBLE_STEP, messages.length - visibleCount) > 1 ? 's' : ''}
                <span className="ml-1 text-slate-400">
                  ({messages.length - visibleCount} hidden)
                </span>
              </button>
            </div>
          )}
          {(() => {
            // Compute the visible slice once per render. `i` in the
            // inner map is the ABSOLUTE index in `messages`, preserved
            // so the day-separator logic keeps comparing against the
            // real previous message (even when it is outside the
            // window \u2014 correct behaviour: no spurious header).
            const sliceStart = Math.max(0, messages.length - visibleCount);
            // Pre-resolve the agent label once for the whole slice
            // \u2014 agents[] + agentSId are stable during typing so
            // this string is stable across keystrokes and the memo
            // of every agent bubble short-circuits.
            const agentLabel = agents.find((a) => a.sId === agentSId)?.name ?? 'Agent';
            return messages.slice(sliceStart).map((m, relIdx) => {
              const i = sliceStart + relIdx;
              const prev = i > 0 ? messages[i - 1] : null;
              const showDay =
                !!m.createdAt &&
                (!prev?.createdAt ||
                  new Date(m.createdAt).toDateString() !==
                    new Date(prev.createdAt).toDateString());
              const roleLabel =
                m.role === 'user' ? 'You' : m.role === 'system' ? 'System' : agentLabel;
              return (
                <ChatMessageBubble
                  key={m.id}
                  id={m.id}
                  role={m.role}
                  content={m.content}
                  createdAt={m.createdAt ?? null}
                  roleLabel={roleLabel}
                  showDay={showDay}
                />
              );
            });
          })()}

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
                        {new Date(serverStreamingSince).toLocaleTimeString('fr-FR')}{' '}
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
          className="p-3 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-2"
        >
          {/* Attachment chips (Franck 2026-04-23 16:59). Rendered
              above the textarea so they don't compete horizontally
              with the send button. Each chip shows name + size,
              status indicator (spinner / ready / error), and an X
              to remove before send. */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((a) => {
                const sizeKb = Math.max(1, Math.round(a.size / 1024));
                return (
                  <span
                    key={a.clientId}
                    className={
                      'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs ' +
                      (a.status === 'error'
                        ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
                        : 'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200')
                    }
                    title={a.error ?? `${a.name} \u2022 ${sizeKb} KB`}
                  >
                    {a.status === 'uploading' && <Loader2 size={12} className="animate-spin" />}
                    {a.status === 'ready' && <Check size={12} className="text-green-600" />}
                    {a.status === 'error' && <XIcon size={12} />}
                    <span className="max-w-[180px] truncate">{a.name}</span>
                    <span className="text-slate-400">{sizeKb}K</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.clientId)}
                      className="ml-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                      aria-label="Remove"
                      title="Remove"
                    >
                      <XIcon size={12} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          <div className="flex gap-2 items-end">
            {/* Hidden input + clickable paperclip button. Multiple
                selection supported; re-opening the picker does NOT
                reset existing chips (onChange appends). */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void uploadFiles(e.target.files);
                // Reset the input so selecting the same file twice
                // in a row still fires onChange.
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming}
              className="h-[2.75rem] px-2.5 rounded-md border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
              title="Attach files"
              aria-label="Attach files"
            >
              <Paperclip size={16} />
            </button>
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
              // Drag-and-drop files onto the textarea (Franck
              // 2026-04-23 16:59). dragover must preventDefault so
              // drop fires. We accept the drop on the textarea
              // rather than a dedicated zone to keep the composer
              // compact.
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('Files')) {
                  e.preventDefault();
                }
              }}
              onDrop={(e) => {
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                  e.preventDefault();
                  void uploadFiles(e.dataTransfer.files);
                }
              }}
              placeholder={currentId ? 'Reply…' : 'Ask anything to start a new conversation…'}
              disabled={streaming || !agentSId}
            />
            <Button
              type="submit"
              disabled={
                streaming ||
                !draft.trim() ||
                !agentSId ||
                attachments.some((a) => a.status === 'uploading')
              }
            >
              <Send size={14} /> {streaming ? 'Streaming…' : 'Send'}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

