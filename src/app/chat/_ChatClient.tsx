'use client';
import { Fragment, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { errMessage } from '@/lib/errors';
import { DocumentTitle } from '@/components/DocumentTitle';
import { usePageActions } from '@/components/PageActionsProvider';
import { useBodyScrollLock } from '@/lib/scroll-lock';
import {
  ChatMessageBubble,
  MessageTimeline,
  GeneratedFilesPanel,
  parseGeneratedFiles,
  type GeneratedFile,
} from '@/components/ChatMessageBubble';
import {
  appendTimelineEvent,
  attachToolResult,
  type TimelineEvent,
} from '@/lib/tool-invocations';
import {
  publishConvEvent,
  subscribeConvEvents,
} from '@/lib/client/conversationsBus';
import {
  Plus,
  Send,
  Square,
  Trash2,
  Pin,
  PinOff,
  Check,
  Paperclip,
  X as XIcon,
  Loader2,
} from 'lucide-react';
import {
  ConversationStatusPanel,
  type McpServerStatus,
  type McpServerView,
} from '@/components/ConversationStatusPanel';

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
  /** Dashboard and /chat share the same pin state via /api/conversation/:id/pin. */
  pinned?: boolean;
  /** Optional — only present if the API returns it; used for tooltips. */
  createdAt?: string;
  /** Optional — count of messages for the sidebar badge. */
  messageCount?: number;
};
type Msg = {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  createdAt?: string;
  /**
   * Raw JSON blob from Message.toolInvocations, surfaced from the
   * /api/conversation/:id payload (Franck 2026-05-07). Pass through
   * to ChatMessageBubble; it stays a string here so React.memo's
   * shallow compare still skips re-renders cleanly.
   */
  toolInvocations?: string | null;
  /**
   * Raw JSON blob from Message.generatedFiles (agent rows only).
   * Surfaced from /api/conversation/:id so the bubble can render
   * the same file chips Dust shows in its native UI. Kept as a
   * string to preserve React.memo shallow-compare semantics on
   * ChatMessageBubble. (Franck 2026-05-16)
   */
  generatedFiles?: string | null;
  /**
   * Raw JSON blob from Message.timeline (agent rows only,
   * Franck 2026-05-22, ADR-0017). When non-null the bubble
   * renders the inline chronological timeline; null on legacy
   * pre-ADR rows triggers the legacy grouped layout fallback.
   */
  timeline?: string | null;
};

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

/** Full human label for tooltips. */
function fullTime(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('fr-FR');
}

/** Elapsed seconds → "1m 23s" / "45s" / "2h 03m". */
// `elapsed()` helper removed (Franck 2026-05-21, second pass): only
// the status strip above the composer consumed it, and that strip
// was dropped in favour of a colour-coded send button.

/**
 * Top-level entry point shared by both route shells (Franck
 * 2026-04-25 11:43): /chat (no id) and /chat/[id] (specific
 * conversation). The Suspense boundary is required by Next.js 15
 * because ChatPageInner calls useSearchParams() for the legacy
 * ?prompt= deep-link feature.
 *
 * `initialConversationId` is the source of truth for which
 * conversation to load on mount:
 *   - null  \u2192 fresh chat surface (/chat)
 *   - "xxx" \u2192 load that conversation (/chat/xxx)
 *
 * This used to be read from `searchParams.get('id')` exclusively,
 * which made deep-links work but left the URL stuck at /chat
 * regardless of which conversation was open. Switching to a path
 * segment + this prop gives us shareable URLs without breaking
 * the existing ?prompt= deep-link path.
 */
/**
 * Hierarchy node the chat is rendering under (ADR-0020 follow-up,
 * Franck 2026-05-26 21:29). Mirrored from the server-side
 * `ResolvedScope` so the client knows which project (if any) is
 * bound, AND which folder fsPath the sidebar should narrow to in
 * folder mode. Passed in from the matching server page so we skip
 * the `/api/projects/current` round-trip on mount and operate the
 * right MCP-ensure / compose logic without guessing.
 */
export type ChatInitialScope = {
  kind: 'root' | 'folder' | 'project';
  /** Folder or project fsPath; '' at root. */
  fsPath: string;
  /** Project fsPath when kind='project', else null. Used as the
   *  initial `currentProject` and to short-circuit MCP ensure. */
  projectName: string | null;
  /** Project-level default agent override (kind='project' only). */
  defaultAgentSId: string | null;
};

export default function ChatPage({
  initialConversationId,
  initialScope,
}: {
  initialConversationId: string | null;
  initialScope: ChatInitialScope;
}) {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">Loading chat…</div>}>
      <ChatPageInner
        initialConversationId={initialConversationId}
        initialScope={initialScope}
      />
    </Suspense>
  );
}

function ChatPageInner({
  initialConversationId,
  initialScope,
}: {
  initialConversationId: string | null;
  initialScope: ChatInitialScope;
}) {
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
  // Use the shared ref-counted lock instead of the ad-hoc
  // snapshot/restore dance: it composes safely with SideNav's mobile
  // sheet lock (Franck 2026-05-21 sixth pass: 'des fois quand je
  // change de page, pas de scroll possible' — race between two
  // independent lockers leaked an outdated baseline).
  useBodyScrollLock(true);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  /**
   * Current Dust workspace sId (from DustSession.workspaceId,
   * returned alongside the conversations list). Used to build
   * https://dust.tt/w/<wsSId>/assistant/<convSId> links so the
   * "Open in Dust" icon lands on the right workspace. null until
   * the first /api/conversation fetch completes; the link is
   * hidden while that's the case.
   */
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
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
   * Using clientId (genClientId) rather than the server sId as the
   * React key because uploads start before the sId is known. The sId
   * lands on the same row when the upload resolves.
   *
   * NOTE on the helper: we cannot rely on crypto.randomUUID() because
   * Web Crypto's randomUUID is only exposed in secure contexts (HTTPS
   * or localhost). KDust is frequently accessed over plain HTTP on a
   * LAN IP/hostname, where window.crypto.randomUUID is undefined and
   * throws "is not a function" — which previously broke both file
   * picker upload and clipboard image paste (Franck 2026-05-01). The
   * id is purely client-side React-key plumbing, no security need.
   */
  const genClientId = (): string => {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c?.randomUUID) return c.randomUUID();
    return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  };
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
  // Tracks priority of the current agent selection across user
  // picks, conversation hydration, and project-default fallback.
  // The current value is read inside `setAgentPickedBy(p => ...)`
  // callbacks (via React's prev-state arg), never directly — hence
  // the empty destructure slot.
  const [, setAgentPickedBy] = useState<'none' | 'auto' | 'user' | 'conv'>('none');
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [cotText, setCotText] = useState('');
  // Parse a raw 'tool_call' SSE payload — sent by the server as
  // JSON.stringify({tool, params}) — into the structured form the
  // ToolInvocationsPanel consumes. Pre-2026-05-07 this returned a
  // pre-formatted single string truncated at 140 chars; we now
  // keep the full structured params so the live pane and the
  // post-`done` persisted view share the same renderer.
  // (Franck 2026-05-07)
  const parseToolCallPayload = (data: string): { tool: string; params: unknown } | null => {
    try {
      const p = JSON.parse(data);
      if (p && typeof p === 'object' && typeof p.tool === 'string') {
        return { tool: p.tool, params: p.params ?? null };
      }
    } catch {
      /* malformed frame — drop silently, the count is still in StreamStats */
    }
    return null;
  };
  const [toolCalls, setToolCalls] = useState<Array<{ tool: string; params: unknown }>>([]);
  /**
   * Inline chronological timeline of the in-flight reply (Franck
   * 2026-05-22, ADR-0017). Single ordered array of text / cot /
   * tool events appended in SSE arrival order via
   * `appendTimelineEvent` (coalesces consecutive text-or-cot runs).
   * Renders through `<MessageTimeline streamingTail>` and replaces
   * the 3-block stacked live layout. The legacy `streamedText`,
   * `cotText` and `toolCalls` states are kept populated for the
   * cross-tab replay seeding path until that endpoint is migrated
   * to read `streamEvents` exclusively (no functional UI impact —
   * those states are not rendered anymore).
   */
  const [streamEvents, setStreamEvents] = useState<TimelineEvent[]>([]);
  /**
   * Live generated-files list for the in-flight agent reply
   * (Franck 2026-05-16). The server emits the FULL deduped list
   * on every `generated_files` SSE event, so we simply replace
   * the state on each frame — no merging required. Cleared on
   * `done` (the persisted Message row then carries the same
   * payload and the standard bubble takes over).
   */
  const [streamGeneratedFiles, setStreamGeneratedFiles] = useState<GeneratedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Initial project comes from the server-resolved scope (ADR-0020
  // follow-up). At folder OR project scope, holds the fsPath and
  // the chat ensures fs-cli / task-runner / skills rooted there
  // (Franck 2026-05-27, feat/folder-scope-mcp). Gateway is per-
  // project and self-skips at folder scope (no ProjectMcpToolFilter
  // rows match -> serverId: null). Null only when scope is root:
  // chat then runs MCP-less.
  const [currentProject, setCurrentProject] = useState<string | null>(
    initialScope.projectName,
  );
  // Base href for /chat URLs preserving the URL-scope segment
  // (root: `/chat`, folder/project: `/<fsPath>/chat`). Used by
  // router.replace + history.pushState so navigating between the
  // empty surface and a deep-link `[id]` page keeps the user
  // inside the same folder/project context. Franck 2026-05-27.
  const chatBaseHref = initialScope.fsPath
    ? `/${initialScope.fsPath}/chat`
    : '/chat';
  const [mcpServerId, setMcpServerId] = useState<string | null>(null);
  const [mcpStatus, setMcpStatus] = useState<'idle' | 'starting' | 'ready' | 'error'>('idle');
  // Chat-mode task-runner MCP serverId (Franck 2026-04-25 11:31).
  // Started in parallel with the fs-cli MCP whenever a project is
  // selected; passed alongside `mcpServerId` in `mcpServerIds` so
  // the agent can call list_tasks / run_task / dispatch_task /
  // wait_for_run from chat. null when no project is active or the
  // ensure call failed (chat then degrades to fs-cli only).
  const [taskRunnerServerId, setTaskRunnerServerId] = useState<string | null>(null);
  // Skills MCP serverId (Franck 2026-05-12, ADR-0016). Same
  // lifecycle as task-runner: ensured in parallel on project
  // change, included in mcpServerIds at message-send, null when
  // no project or ensure failed (chat then degrades to the other
  // MCPs only -- list_skills/read_skill/run_skill_script become
  // unavailable but list_tasks etc. keep working).
  const [skillsServerId, setSkillsServerId] = useState<string | null>(null);
  // Docker MCP gateway proxy serverId (Franck 2026-05-10, ADR-0012).
  // null when no project is active, the gateway is unreachable, or
  // the project has no whitelisted tools — chat degrades gracefully
  // to fs-cli + task-runner only in any of those cases.
  const [gatewayServerId, setGatewayServerId] = useState<string | null>(null);
  // PasswordPusher MCP serverId (Franck 2026-05-27). Singleton server,
  // project-agnostic. Ensured alongside the other MCPs whenever a
  // project is active, so the agent can call pwpush_create from any
  // project chat. null when the ensure call fails (e.g. the
  // PASSWORDPUSHER_TOKEN Secret hasn't been created yet) — chat then
  // degrades to the other MCPs only.
  const [passwordPusherServerId, setPasswordPusherServerId] = useState<string | null>(null);
  // MCP catalog (Franck 2026-05-09). Fetched once at mount from
  // /api/mcp/catalog; powers the header bubble so the list of MCPs
  // and tools stays in sync with the server-side registry rather
  // than being hardcoded in JSX.
  const [mcpCatalog, setMcpCatalog] = useState<
    | {
        id: string;
        name: string;
        description: string;
        scope: 'chat' | 'task';
        tools: { name: string; description?: string }[];
      }[]
    | null
  >(null);
  // `serverStreaming` reflects server-side knowledge of an in-flight agent
  // reply. It stays true even if the user navigated away and came back,
  // as long as the Dust call is still producing tokens in the background.
  const [serverStreaming, setServerStreaming] = useState(false);
  // Wall-clock timestamps recorded when a stream starts (server-side
  // for cross-tab takeover, local for THIS tab's SSE loop). The
  // status strip above the composer used to display a live "1m 23s"
  // counter from these; that strip was removed (Franck 2026-05-21,
  // second pass), but the setters are still called by the stream
  // lifecycle code, so we keep the state in case a future iteration
  // wants to surface it again (e.g. inside the send button tooltip).
  const [_serverStreamingSince, setServerStreamingSince] = useState<string | null>(null);
  const [_localStreamStartedAt, setLocalStreamStartedAt] = useState<string | null>(null);
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

  // Fetch MCP catalog once at mount (Franck 2026-05-09). Static
  // data, drives the header bubble. Soft-fails: if the call errors
  // we leave the state null and the bubble falls back to the
  // hardcoded chat-scope MCPs (fs + task-runner) so the indicator
  // never goes blank.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/mcp/catalog');
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled && Array.isArray(j.catalog)) setMcpCatalog(j.catalog);
      } catch {
        /* leave null; bubble has a fallback */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Cross-tab / cross-page sync (Franck 2026-04-20 17:04). When
  // another surface (dashboard, /conversation, a second /chat tab)
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
  const router = useRouter();

  const refreshConvs = async () => {
    // Scope the sidebar to the server-resolved hierarchy node
    // (ADR-0020 follow-up). The API accepts `scope` (fsPath) and
    // `scopeKind` query params and falls back to its legacy
    // cookie-based filter when both are absent.
    const qs = new URLSearchParams();
    if (initialScope.kind !== 'root') {
      qs.set('scopeKind', initialScope.kind);
      qs.set('scope', initialScope.fsPath);
    }
    const r = await fetch(`/api/conversation${qs.toString() ? `?${qs}` : ''}`);
    const j = await r.json();
    setConvs(j.conversations ?? []);
    // Workspace sId travels on the same payload so we only pay
    // for one round-trip; stays pinned to the most recent value
    // the server knows about.
    if (typeof j.workspaceId === 'string') setWorkspaceId(j.workspaceId);
  };

  const loadConv = async (id: string) => {
    setCurrentId(id);
    // Keep the URL in sync with the active conversation (Franck
    // 2026-04-25 11:43). replace() rather than push() so back/
    // forward inside the chat list doesn't fill the history with
    // intermediate states the user can't meaningfully revisit.
    // Guarded against redundant navigation: skip when we're
    // already on /chat/<id> (e.g. arriving via the route shell).
    if (typeof window !== 'undefined' && window.location.pathname !== `${chatBaseHref}/${id}`) {
      router.replace(`${chatBaseHref}/${id}`);
    }
    setError(null);
    const r = await fetch(`/api/conversation/${id}`);
    const j = await r.json();
    const c = j.conversation;
    setMessages(c?.messages ?? []);
    setAgentSId(c?.agentSId ?? '');
    // Seed streaming bubbles from the server replay buffer
    // (Franck 2026-04-25 19:36). On a fresh load of an active
    // stream this gives the user immediate "thinking" visibility
    // instead of an empty bubble + opaque banner. When the conv
    // has no active stream we clear stale tokens.
    if (j.streaming) {
      setStreamedText(j.streamContent ?? '');
      setCotText(j.streamCot ?? '');
      setToolCalls(
        Array.isArray(j.streamToolCalls)
          ? j.streamToolCalls
              .map(parseToolCallPayload)
              .filter((x: { tool: string; params: unknown } | null): x is { tool: string; params: unknown } => x !== null)
          : [],
      );
      // Seed the inline timeline from the server replay buffer so a
      // tab joining mid-stream renders the chronological feed as the
      // owning tab sees it (Franck 2026-05-22, ADR-0017). The
      // payload is already ordered and coalesced server-side; we
      // accept it verbatim, dropping events with unexpected shapes.
      setStreamEvents(
        Array.isArray(j.streamEvents)
          ? (j.streamEvents as unknown[])
              .map((x): TimelineEvent | null => {
                if (!x || typeof x !== 'object') return null;
                const ev = x as Record<string, unknown>;
                if (ev.type === 'text' && typeof ev.content === 'string') {
                  return { type: 'text', content: ev.content };
                }
                if (ev.type === 'cot' && typeof ev.content === 'string') {
                  return { type: 'cot', content: ev.content };
                }
                if (ev.type === 'tool' && typeof ev.tool === 'string') {
                  return {
                    type: 'tool',
                    tool: ev.tool,
                    params: ev.params ?? null,
                    result:
                      typeof ev.result === 'string' ? ev.result : null,
                  };
                }
                return null;
              })
              .filter((x): x is TimelineEvent => x !== null)
          : [],
      );
      // Seed the live generated-files chips from the replay buffer
      // so a tab joining mid-stream sees what the agent already
      // surfaced. (Franck 2026-05-16)
      setStreamGeneratedFiles(parseGeneratedFiles(j.streamGeneratedFiles ?? null));
    } else {
      setStreamedText('');
      setCotText('');
      setToolCalls([]);
      setStreamEvents([]);
      setStreamGeneratedFiles([]);
    }
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
      // Re-ensure MCP servers for the new project (fs-cli + task-runner).
      // Run them in parallel \u2014 they're independent and the agent
      // benefits from having both available before the next message.
      // Franck 2026-04-25 11:31.
      if (convProject) {
        setMcpStatus('starting');
        const [fsRes, trRes, gwRes, skRes, pwRes] = await Promise.allSettled([
          fetch('/api/mcp/ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: convProject }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          fetch('/api/mcp/task-runner-ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: convProject }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          fetch('/api/mcp/gateway-ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectFsPath: convProject }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          fetch('/api/mcp/skills-ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: convProject }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          fetch('/api/mcp/passwordpusher-ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
        ]);
        if (fsRes.status === 'fulfilled' && fsRes.value.ok && fsRes.value.j.serverId) {
          setMcpServerId(fsRes.value.j.serverId);
          setMcpStatus('ready');
        } else {
          setMcpStatus('error');
        }
        // Task-runner failure is non-fatal: chat still works with
        // fs-cli alone, just no task dispatch from conversation.
        if (trRes.status === 'fulfilled' && trRes.value.ok && trRes.value.j.serverId) {
          setTaskRunnerServerId(trRes.value.j.serverId);
        } else {
          setTaskRunnerServerId(null);
          console.warn('[chat] task-runner MCP ensure failed; list_tasks/run_task unavailable');
        }
        // Gateway failure is non-fatal too: chat still works with
        // fs-cli + task-runner alone if the gateway is down or no
        // tools are whitelisted for this project.
        if (gwRes.status === 'fulfilled' && gwRes.value.ok && gwRes.value.j.serverId) {
          setGatewayServerId(gwRes.value.j.serverId);
        } else {
          setGatewayServerId(null);
          // Distinguish "no whitelisted tools" (legitimate skip,
          // silent) from an actual ensure failure (warn).
          const skipped =
            gwRes.status === 'fulfilled' && gwRes.value.ok && gwRes.value.j.skipped;
          if (!skipped)
            console.warn('[chat] gateway MCP ensure failed; catalog tools unavailable');
        }
        // Skills MCP failure is non-fatal: chat still works with
        // the other MCPs alone, just no list_skills / read_skill /
        // run_skill_script in this session.
        if (skRes.status === 'fulfilled' && skRes.value.ok && skRes.value.j.serverId) {
          setSkillsServerId(skRes.value.j.serverId);
        } else {
          setSkillsServerId(null);
          console.warn('[chat] skills MCP ensure failed; skills unavailable');
        }
        // PasswordPusher failure is non-fatal: pwpush_* tools just
        // won't be exposed. Most common cause is the
        // PASSWORDPUSHER_TOKEN Secret not being set yet.
        if (pwRes.status === 'fulfilled' && pwRes.value.ok && pwRes.value.j.serverId) {
          setPasswordPusherServerId(pwRes.value.j.serverId);
        } else {
          setPasswordPusherServerId(null);
          console.warn('[chat] passwordpusher MCP ensure failed; pwpush_* unavailable');
        }
      } else {
        setMcpServerId(null);
        setMcpStatus('idle');
        setTaskRunnerServerId(null);
        setGatewayServerId(null);
        setSkillsServerId(null);
        setPasswordPusherServerId(null);
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
    // Open the requested conversation on mount. Source of truth is
    // the prop fed by the route shell:
    //   - /chat/[id]  \u2192 initialConversationId = params.id
    //   - /chat       \u2192 initialConversationId = null
    // The legacy ?id= query string is still respected as a fallback
    // so any old bookmarks keep working through one redirect cycle.
    // Franck 2026-04-25 11:43.
    const requested = initialConversationId ?? searchParams.get('id');
    if (requested) {
      void loadConv(requested);
      // Migrate legacy ?id= URL to the canonical path form so the
      // address bar reflects the conversation cleanly. replace()
      // (not push) to avoid a duplicate history entry on the
      // refresh that just landed.
      if (!initialConversationId && searchParams.get('id')) {
        router.replace(`${chatBaseHref}/${requested}`);
      }
    }

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
      // No conversation pre-selected \u2014 honour the ?prompt= /
      // sessionStorage deep-link path that prefills the textarea
      // with a description, untouched by the URL refactor.
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
    // ADR-0020 follow-up: project + default-agent come from the
    // server-resolved scope passed in as a prop, so we skip the
    // /api/projects/current round-trip entirely. MCPs are only
    // ensured when scope.kind === 'project' \u2014 folder / root modes
    // run MCP-less (no fs-cli, no task-runner, no gateway, no
    // skills). The composer still works in those modes but the
    // resulting conversation is created with projectName=null,
    // matching the legacy "root" path.
    void (async () => {
      const name = initialScope.projectName;
      const defAgent = initialScope.defaultAgentSId;
      // Project-level default agent (Franck 2026-04-19 19:13).
      // Overrides the generic list[0] auto-fallback but yields to
      // any stronger claim ('user' manual pick, 'conv' from an
      // open conversation). Skipped entirely when the URL points
      // at a specific conversation.
      const requested = initialConversationId ?? searchParams.get('id');
      if (defAgent && !requested) {
        setAgentPickedBy((p) => {
          if (p === 'user' || p === 'conv') return p;
          setAgentSId(defAgent);
          return 'auto';
        });
      }
      {
        if (name) {
          setMcpStatus('starting');
          // Mount-time parallel ensure of both MCPs. Same rationale
          // as the project-change handler above. Franck 2026-04-25 11:31.
          const [fsRes, trRes, gwRes, skRes, pwRes] = await Promise.allSettled([
            fetch('/api/mcp/ensure', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectName: name }),
            }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
            fetch('/api/mcp/task-runner-ensure', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectName: name }),
            }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
            fetch('/api/mcp/gateway-ensure', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectFsPath: name }),
            }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
            fetch('/api/mcp/skills-ensure', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectName: name }),
            }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
            fetch('/api/mcp/passwordpusher-ensure', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          ]);
          if (fsRes.status === 'fulfilled' && fsRes.value.ok && fsRes.value.j.serverId) {
            setMcpServerId(fsRes.value.j.serverId);
            setMcpStatus('ready');
          } else {
            setMcpStatus('error');
            const errMsg =
              fsRes.status === 'fulfilled'
                ? fsRes.value.j?.error ?? 'Failed to start MCP fs server'
                : (fsRes as PromiseRejectedResult).reason?.message ?? 'fs ensure rejected';
            setError(typeof errMsg === 'string' ? errMsg : 'Failed to start MCP fs server');
          }
          if (trRes.status === 'fulfilled' && trRes.value.ok && trRes.value.j.serverId) {
            setTaskRunnerServerId(trRes.value.j.serverId);
          } else {
            console.warn('[chat] task-runner MCP ensure failed at mount; chat will run without task tools');
          }
          if (gwRes.status === 'fulfilled' && gwRes.value.ok && gwRes.value.j.serverId) {
            setGatewayServerId(gwRes.value.j.serverId);
          } else {
            const skipped =
              gwRes.status === 'fulfilled' && gwRes.value.ok && gwRes.value.j.skipped;
            if (!skipped)
              console.warn('[chat] gateway MCP ensure failed at mount; chat will run without gateway tools');
          }
          if (skRes.status === 'fulfilled' && skRes.value.ok && skRes.value.j.serverId) {
            setSkillsServerId(skRes.value.j.serverId);
          } else {
            console.warn('[chat] skills MCP ensure failed at mount; chat will run without skill tools');
          }
          if (pwRes.status === 'fulfilled' && pwRes.value.ok && pwRes.value.j.serverId) {
            setPasswordPusherServerId(pwRes.value.j.serverId);
          } else {
            console.warn('[chat] passwordpusher MCP ensure failed at mount; chat will run without pwpush_* tools');
          }
        }
      }
    })().catch(() => {});
    // Mount-only effect: hydrate the initial conversation + project
    // context, then ensure both MCP servers exactly once. The deps
    // we read inside (initialConversationId is a prop snapshot,
    // searchParams/router are stable hook handles, loadConv would
    // recreate every render) MUST NOT trigger a re-run; doing so
    // would cycle MCP registrations on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to bottom on new content \u2014 but only while the
  // user hasn't manually scrolled up. See the `followStream` ref
  // definition above for the full state machine.
  // Franck 2026-05-21 bug fix:
  //  1. Dependencies now include `cotText` and `toolCalls` so the
  //     view follows reasoning blocks and fs_tools pills, not just
  //     plain message tokens. Previously, the thinking phase (or
  //     a tool-call pill appearing without a streamedText update)
  //     would leave the user scrolled above the new content.
  //  2. `behavior: 'auto'` (instant) instead of 'smooth'. The
  //     smooth variant animates over ~300ms and fires intermediate
  //     `scroll` events at each frame; those frames are mid-flight
  //     so `distance > NEAR_BOTTOM_PX` and the scroll handler
  //     flipped `followStream` to false on the FIRST token,
  //     killing auto-follow for the rest of the stream. Instant
  //     scroll yields a single scroll event at distance ~= 0,
  //     keeping the flag stable.
  useEffect(() => {
    if (!followStream.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages, streamedText, cotText, toolCalls]);

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
        const r = await fetch(`/api/conversation/${currentId}`);
        if (!r.ok) return;
        const j = await r.json();
        if (!j.streaming) {
          // stream has finished elsewhere — reload messages (includes the
          // newly-persisted agent reply) and clear the banner + bubbles.
          setMessages(j.conversation?.messages ?? []);
          setStreamedText('');
          setCotText('');
          setToolCalls([]);
          setStreamEvents([]);
          setServerStreaming(false);
          setServerStreamingSince(null);
        } else {
          // Stream still running. Refresh the streaming bubbles from
          // the server replay buffer (Franck 2026-04-25 19:36) so the
          // user sees a live-feeling "thinking..." preview without
          // owning the SSE subscription. The buffer is cumulative,
          // so a plain assignment is correct (no diff math needed).
          setStreamedText(j.streamContent ?? '');
          setCotText(j.streamCot ?? '');
          // Tool-call pills (Franck 2026-04-25 19:45, refactored
          // 2026-05-07 to keep structured payloads instead of
          // truncated strings — same parser as the live SSE path).
          setToolCalls(
            Array.isArray(j.streamToolCalls)
              ? j.streamToolCalls
                  .map(parseToolCallPayload)
                  .filter((x: { tool: string; params: unknown } | null): x is { tool: string; params: unknown } => x !== null)
              : [],
          );
          // Inline timeline replay (Franck 2026-05-22, ADR-0017) —
          // same shape as the live SSE accumulator; the server
          // already ordered & coalesced the events, we just adopt
          // the latest snapshot.
          setStreamEvents(
            Array.isArray(j.streamEvents)
              ? (j.streamEvents as unknown[])
                  .map((x): TimelineEvent | null => {
                    if (!x || typeof x !== 'object') return null;
                    const ev = x as Record<string, unknown>;
                    if (ev.type === 'text' && typeof ev.content === 'string') {
                      return { type: 'text', content: ev.content };
                    }
                    if (ev.type === 'cot' && typeof ev.content === 'string') {
                      return { type: 'cot', content: ev.content };
                    }
                    if (ev.type === 'tool' && typeof ev.tool === 'string') {
                      return {
                        type: 'tool',
                        tool: ev.tool,
                        params: ev.params ?? null,
                        result:
                          typeof ev.result === 'string' ? ev.result : null,
                      };
                    }
                    return null;
                  })
                  .filter((x): x is TimelineEvent => x !== null)
              : [],
          );
        }
      } catch {
        /* transient */
      }
    }, 1500);
    return () => clearInterval(iv);
  }, [currentId, serverStreaming, streaming]);

  const newChat = () => {
    setCurrentId(null);
    // Drop the conversation segment from the URL so reload of the
    // page truly lands on a blank chat. Same replace() rationale
    // as loadConv. Franck 2026-04-25 11:43.
    if (typeof window !== 'undefined' && window.location.pathname !== chatBaseHref) {
      router.replace(chatBaseHref);
    }
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
    setStreamGeneratedFiles([]);
    try {
      const r = await fetch(
        `/api/conversation/${convId}/stream?userMessageSId=${encodeURIComponent(userMessageSId)}`,
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
          // SSE spec: strip EXACTLY ONE leading space after `data:`.
          // The previous `\s*` was greedy and ate legitimate leading
          // spaces inside the payload itself, producing concatenated
          // words in the live "thinking…" pane (e.g. "Ineed",
          // "TerraformPlugin", "v1.13.0might"). The server always
          // emits `data: ${payload}` with a single delimiter space,
          // so `: ?` is the correct, lossless strip.
          // (Franck 2026-05-07)
          const dataLine = /\ndata: ?(.*)$/s.exec(frame)?.[1] ?? '';
          const data = dataLine.replace(/\\n/g, '\n');
          if (ev === 'token') {
            setStreamedText((t) => t + data);
            setStreamEvents((evs) =>
              appendTimelineEvent(evs, { type: 'text', content: data }),
            );
          }
          else if (ev === 'cot') {
            setCotText((t) => t + data);
            setStreamEvents((evs) =>
              appendTimelineEvent(evs, { type: 'cot', content: data }),
            );
          }
          else if (ev === 'agent_message_id') {
            // Server tracks the sId itself for the /cancel endpoint.
            // We receive it purely for forward-compat / debugging.
          }
          else if (ev === 'tool_call') {
            const parsed = parseToolCallPayload(data);
            if (parsed) {
              setToolCalls((arr) => [...arr, parsed]);
              setStreamEvents((evs) =>
                appendTimelineEvent(evs, {
                  type: 'tool',
                  tool: parsed.tool,
                  params: parsed.params,
                }),
              );
            }
          } else if (ev === 'tool_result') {
            // Attach the tool's output to the most recent matching
            // timeline entry without one (Franck 2026-05-28). Powers
            // the bottom-sheet detail view for tool rows.
            try {
              const parsed = JSON.parse(data);
              if (
                parsed &&
                typeof parsed.tool === 'string' &&
                typeof parsed.result === 'string'
              ) {
                setStreamEvents((evs) =>
                  attachToolResult(evs, parsed.tool, parsed.result),
                );
              }
            } catch {
              /* malformed — ignore, the result simply won't surface */
            }
          } else if (ev === 'generated_files') {
            // Server already emits the full deduped JSON list each
            // time, so we just replace — no reconciliation needed.
            setStreamGeneratedFiles(parseGeneratedFiles(data));
          } else if (ev === 'error') setError(data);
          else if (ev === 'done') {
            setStreamedText('');
            setCotText('');
            setToolCalls([]);
            setStreamEvents([]);
            setStreamGeneratedFiles([]);
            // reload conv from server (agent message now persisted)
            await loadConv(convId);
            await refreshConvs();
          }
        }
      }
    } catch (e: unknown) {
      setError(errMessage(e));
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
      void fetch(`/api/conversation/${currentId}/cancel`, { method: 'POST' }).catch(
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
      clientId: genClientId(),
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
    let effectiveTaskRunnerServerId: string | null = taskRunnerServerId;
    let effectiveGatewayServerId: string | null = gatewayServerId;
    let effectiveSkillsServerId: string | null = skillsServerId;
    let effectivePasswordPusherServerId: string | null = passwordPusherServerId;
    if (currentProject) {
      // Re-ensure all MCPs in parallel just before sending so a
      // serverId that Dust evicted server-side is refreshed before
      // we hit the 403 path. Franck 2026-04-25 11:31.
      try {
        const [fsRes, trRes, gwRes, skRes, pwRes] = await Promise.allSettled([
          fetch('/api/mcp/ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: currentProject }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          fetch('/api/mcp/task-runner-ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: currentProject }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          fetch('/api/mcp/gateway-ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectFsPath: currentProject }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          fetch('/api/mcp/skills-ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: currentProject }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          fetch('/api/mcp/passwordpusher-ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
        ]);
        if (fsRes.status === 'fulfilled' && fsRes.value.ok && fsRes.value.j.serverId) {
          effectiveMcpServerId = fsRes.value.j.serverId;
          if (fsRes.value.j.serverId !== mcpServerId) setMcpServerId(fsRes.value.j.serverId);
        }
        if (trRes.status === 'fulfilled' && trRes.value.ok && trRes.value.j.serverId) {
          effectiveTaskRunnerServerId = trRes.value.j.serverId;
          if (trRes.value.j.serverId !== taskRunnerServerId)
            setTaskRunnerServerId(trRes.value.j.serverId);
        }
        if (gwRes.status === 'fulfilled' && gwRes.value.ok && gwRes.value.j.serverId) {
          effectiveGatewayServerId = gwRes.value.j.serverId;
          if (gwRes.value.j.serverId !== gatewayServerId)
            setGatewayServerId(gwRes.value.j.serverId);
        }
        if (skRes.status === 'fulfilled' && skRes.value.ok && skRes.value.j.serverId) {
          effectiveSkillsServerId = skRes.value.j.serverId;
          if (skRes.value.j.serverId !== skillsServerId)
            setSkillsServerId(skRes.value.j.serverId);
        }
        if (pwRes.status === 'fulfilled' && pwRes.value.ok && pwRes.value.j.serverId) {
          effectivePasswordPusherServerId = pwRes.value.j.serverId;
          if (pwRes.value.j.serverId !== passwordPusherServerId)
            setPasswordPusherServerId(pwRes.value.j.serverId);
        }
      } catch {
        // Non-fatal \u2014 fall through to the send attempt and let the
        // 403 retry below salvage the call if needed.
      }
    }

    // Build the MCP server ID array: fs-cli first (primary tool
    // surface), task-runner second (delegation tools), gateway
    // third (Docker MCP catalog tools). Any of them can be absent
    // independently \u2014 chat with none of them still works for
    // plain conversational turns. Filter nulls before passing.
    const buildMcpIds = () =>
      [
        effectiveMcpServerId,
        effectiveTaskRunnerServerId,
        effectiveGatewayServerId,
        effectiveSkillsServerId,
        effectivePasswordPusherServerId,
      ].filter((x): x is string => !!x);

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
      const idsArr = buildMcpIds();
      const ids = idsArr.length > 0 ? idsArr : undefined;
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
      // Retry once with freshly-ensured serverIds. Re-evict and
      // re-create BOTH (we don't know which one Dust rejected, and
      // forcing both is cheap). Franck 2026-04-25 11:31.
      console.warn('[chat] Dust rejected MCP serverId; re-ensuring all MCPs and retrying once');
      try {
        const [fsRes, trRes, gwRes, skRes, pwRes] = await Promise.allSettled([
          fetch('/api/mcp/ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: currentProject, force: true }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          fetch('/api/mcp/task-runner-ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: currentProject, force: true }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          fetch('/api/mcp/gateway-ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectFsPath: currentProject, force: true }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          fetch('/api/mcp/skills-ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: currentProject, force: true }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
          fetch('/api/mcp/passwordpusher-ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: true }),
          }).then((r) => r.json().then((j) => ({ ok: r.ok, j }))),
        ]);
        if (fsRes.status === 'fulfilled' && fsRes.value.ok && fsRes.value.j.serverId) {
          effectiveMcpServerId = fsRes.value.j.serverId;
          setMcpServerId(fsRes.value.j.serverId);
        }
        if (trRes.status === 'fulfilled' && trRes.value.ok && trRes.value.j.serverId) {
          effectiveTaskRunnerServerId = trRes.value.j.serverId;
          setTaskRunnerServerId(trRes.value.j.serverId);
        }
        if (gwRes.status === 'fulfilled' && gwRes.value.ok && gwRes.value.j.serverId) {
          effectiveGatewayServerId = gwRes.value.j.serverId;
          setGatewayServerId(gwRes.value.j.serverId);
        }
        if (skRes.status === 'fulfilled' && skRes.value.ok && skRes.value.j.serverId) {
          effectiveSkillsServerId = skRes.value.j.serverId;
          setSkillsServerId(skRes.value.j.serverId);
        }
        if (pwRes.status === 'fulfilled' && pwRes.value.ok && pwRes.value.j.serverId) {
          effectivePasswordPusherServerId = pwRes.value.j.serverId;
          setPasswordPusherServerId(pwRes.value.j.serverId);
        }
      } catch {
        /* swallow \u2014 retry regardless, worst case same error */
      }
      const retryIds = buildMcpIds();
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          mcpServerIds: retryIds.length > 0 ? retryIds : undefined,
        }),
      });
    };

    try {
      if (!currentId) {
        const agentName = agents.find((a) => a.sId === agentSId)?.name;
        const r = await postWithRetry('/api/conversation', {
          agentSId,
          agentName,
          content,
          fileIds: fileIds.length > 0 ? fileIds : undefined,
          fileMetas: fileMetas.length > 0 ? fileMetas : undefined,
          // Attach the URL-scoped project/folder so the new
          // Conversation row is wired to the correct hierarchy
          // node regardless of the cookie. null at root scope.
          // Franck 2026-05-27.
          projectName: initialScope.projectName,
        });
        if (!r.ok) throw new Error((await r.json()).error?.toString() ?? 'error');
        const j = await r.json();
        setCurrentId(j.id);
        // Promote the URL to /chat/<id> WITHOUT triggering a Next.js
        // route change (Franck 2026-04-25 19:36). router.push would
        // unmount this ChatClient instance (mounted from /chat) and
        // re-mount the one from /chat/[id], orphaning the SSE
        // consumeStream() about to fire below \u2014 the user would then
        // see the "Agent is still replying in the background" banner
        // for their VERY FIRST reply, instead of the live thinking
        // bubble. window.history.pushState updates the address bar
        // (so a refresh lands on the right conv, and Back returns
        // to /chat) without remounting the page component.
        if (typeof window !== 'undefined' && window.location.pathname !== `${chatBaseHref}/${j.id}`) {
          window.history.pushState({}, '', `${chatBaseHref}/${j.id}`);
        }
        await consumeStream(j.id, j.userMessageSId);
      } else {
        const r = await postWithRetry(`/api/conversation/${currentId}/messages`, {
          content,
          fileIds: fileIds.length > 0 ? fileIds : undefined,
          fileMetas: fileMetas.length > 0 ? fileMetas : undefined,
        });
        if (!r.ok) throw new Error((await r.json()).error?.toString() ?? 'error');
        const j = await r.json();
        await consumeStream(currentId, j.userMessageSId);
      }
    } catch (e: unknown) {
      setError(errMessage(e));
    }
  };

  const removeConv = async (id: string) => {
    if (!confirm('Delete this conversation?')) return;
    const r = await fetch(`/api/conversation/${id}`, { method: 'DELETE' });
    if (currentId === id) newChat();
    await refreshConvs();
    // Notify sibling tabs (dashboard / /conversation / other /chat)
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
      const r = await fetch(`/api/conversation/${id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: next }),
      });
      if (!r.ok) throw new Error('pin failed');
      // Re-sort pinned-first without a full network refresh.
      await refreshConvs();
      // Notify sibling tabs (dashboard / /conversation / other /chat)
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

  // Document title (Franck 2026-05-21): the global TopBar shows the
  // page title to the right of the K, with /chat showing the
  // CURRENT CONVERSATION title instead. We feed <DocumentTitle> the
  // active conv's title, falling back to "Chat" before any
  // conversation is selected.
  const docTitle =
    (currentId && convs.find((c) => c.id === currentId)?.title) || 'Chat';

  // Page-level action cluster (Franck 2026-05-21, second pass +
  // fifth pass v2). Portaled into the global <TopBar> via
  // <PageActionsSlot/>; the returned JSX (portal node) is rendered
  // inline below so React's reconciler keeps actions in sync with
  // _ChatClient state without re-rendering the TopBar itself.
  //
  // Visual contract (Franck 2026-05-22): every icon button in this
  // cluster is exactly 32×32 (w-8 h-8), rounded-md, holds a 16px
  // lucide icon, and shares the SAME base layout class so spacing
  // stays uniform. Only color/hover differs (Wrench reflects MCP
  // status, others are neutral). Extracted into ACTION_BTN_BASE to
  // make future drift impossible to introduce by accident.
  const ACTION_BTN_BASE =
    'inline-flex items-center justify-center w-8 h-8 rounded-md transition-colors';
  const pageActions = usePageActions(
    <>
      {/* Conversation status panel (Franck 2026-05-28). Replaces the
          legacy "MCP tools" hover tooltip + the standalone Open-in-Dust
          button. Combines:
            1. Live Dust context-usage gauge + Compact button
            2. Open-in-Dust link (moved into the panel)
            3. Condensed MCP servers status
          Click to open; click-outside / Escape to close. Mobile
          layout is a full-width bandeau under the topbar. */}
      {(() => {
        const statusFor = (
          id: string,
          scope: 'chat' | 'task',
        ): McpServerStatus => {
          if (scope === 'task') return 'task-only';
          if (id === 'fs') {
            if (mcpStatus === 'ready') return 'ready';
            if (mcpStatus === 'starting') return 'starting';
            if (mcpStatus === 'error') return 'failed';
            return 'inactive';
          }
          if (id === 'task-runner') return taskRunnerServerId ? 'ready' : 'inactive';
          if (id === 'mcp-gateway') return gatewayServerId ? 'ready' : 'inactive';
          if (id === 'skills') return skillsServerId ? 'ready' : 'inactive';
          if (id === 'passwordpusher') return passwordPusherServerId ? 'ready' : 'inactive';
          return 'inactive';
        };
        const catalog = mcpCatalog ?? [
          { id: 'fs', name: 'fs', description: '', scope: 'chat' as const, tools: [] },
          { id: 'task-runner', name: 'task-runner', description: '', scope: 'chat' as const, tools: [] },
        ];
        const mcpServers: McpServerView[] = catalog
          .filter((c) => c.scope === 'chat')
          .map((c) => ({
            id: c.id,
            name: c.name,
            status: statusFor(c.id, c.scope),
          }));
        const conv = currentId ? convs.find((c) => c.id === currentId) : null;
        return (
          <ConversationStatusPanel
            conversationId={currentId}
            dustConversationSId={conv?.dustConversationSId ?? null}
            workspaceId={workspaceId}
            mcpServers={mcpServers}
            projectName={currentProject}
            buttonBaseClassName={ACTION_BTN_BASE}
          />
        );
      })()}
      {/* "+ New chat" button removed from the topbar (Franck 2026-05-28).
          A new conversation is now started either by clicking the
          chat icon in the sidebar (which lands on /chat with no id)
          or via the /conversation dashboard. Keeps the topbar
          uncluttered on /chat. */}
    </>,
  );

  return (
    // Height math:
    //   - /chat/layout.tsx sizes its wrapper to
    //     calc(100dvh - 3rem) on every viewport (TopBar always
    //     eats 3rem now), so this div just needs h-full.
    //   - min-h-0 lets flex children shrink so only the inner
    //     messages pane scrolls, never the page.
    <>
      <DocumentTitle title={docTitle} />
      {pageActions}
    <div
      data-chat-root
      className="flex gap-0 h-full min-h-0 max-w-full"
      onPointerMove={onResizeMove}
      onPointerUp={onResizeEnd}
      onPointerCancel={onResizeEnd}
    >
      {/* -----------------------------------------------------------------
       * Sidebar removed 2026-04-20 (Franck): the conversation list now
       * lives exclusively on the dedicated /conversation dashboard.
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
      <section className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
        {/* Chat-internal top toolbar removed (Franck 2026-05-21,
            second pass). The action icons (MCP indicator, Open-in-
            Dust, New chat) moved up into the global <TopBar> via
            the page-actions slot — see the `usePageActions(...)`
            call earlier in this component. The agent picker moved
            DOWN into the composer card (claude.ai-style), see the
            composer card below.

            The section's outer border was dropped at the same time
            so the chat surface flows edge-to-edge into the chrome
            without a hard rectangle. */}

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
                  toolInvocationsJson={m.toolInvocations ?? null}
                  generatedFilesJson={m.generatedFiles ?? null}
                  timelineJson={m.timeline ?? null}
                />
              );
            });
          })()}

          {/*
            Live inline timeline (Franck 2026-05-22, ADR-0017).
            Single chronological feed interleaving narration / CoT
            / tool calls in Dust SSE arrival order, replacing the
            former 3 stacked blocks (tools panel + thinking
            details + streamed bubble). `streamingTail` adds the
            blinking caret on the trailing text node so the
            "answer in progress" cue is preserved.

            When the conv is streaming but `streamEvents` is still
            empty (very first frame), we render a minimal
            placeholder so the user doesn't see an empty viewport.
           */}
          {streamEvents.length > 0 && (
            <div className="flex justify-start">
              <div className="max-w-[85%] w-full min-w-0">
                <MessageTimeline events={streamEvents} streamingTail />
              </div>
            </div>
          )}
          {streamEvents.length === 0 && (streaming || serverStreaming) && (
            <div className="flex justify-start">
              <div className="max-w-[85%] text-xs text-slate-500 italic">
                thinking…
              </div>
            </div>
          )}

          {/* Live generated-files chips (Franck 2026-05-16). Shown
              under the streaming bubble while the agent is still
              replying, then handed off to the persisted-bubble
              renderer when `done` fires (state cleared above). */}
          {streamGeneratedFiles.length > 0 && (
            <div className="flex justify-start">
              <div className="max-w-[85%] w-full">
                <GeneratedFilesPanel files={streamGeneratedFiles} />
              </div>
            </div>
          )}

          {error && (
            <div className="flex justify-start">
              <p className="text-danger-strong dark:text-red-400 text-sm">{error}</p>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Status strip removed (Franck 2026-05-21, second pass).
            The streaming state is now signalled by the send button
            color in the composer; the Stop control merges with the
            send button (becomes a red square while streaming).
            Idle metadata (message count, last activity) was
            informational only and is dropped to keep the surface
            clean. Server-streaming awareness is preserved through
            the send-button color (amber while another tab owns the
            stream). */}

        {/* Composer — Franck 2026-05-21: claude.ai-style refresh.
            The hard border-t is replaced with a soft top fade
            (gradient overlay rendered absolutely just above the
            card). The textarea + action buttons now live INSIDE a
            single rounded card with a transparent backdrop, no
            inner borders, ghost icon-buttons at the bottom \u2014
            mirroring the visual reference. */}
        <form onSubmit={send} className="relative p-3 flex flex-col gap-2">
          <div
            aria-hidden
            className="pointer-events-none absolute left-0 right-0 -top-6 h-6 bg-gradient-to-t from-white dark:from-slate-950 to-transparent"
          />
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

          {/* Single rounded card (Franck 2026-05-21). All three
              interactive elements \u2014 textarea, attach button, send
              button \u2014 share one backdrop with no inner separators.
              `focus-within` lifts the border tone so the user gets
              the same focus affordance the old per-element border
              used to provide. */}
          <div className="rounded-2xl border border-slate-200/70 dark:border-slate-800/70 bg-slate-50/80 dark:bg-slate-900/60 focus-within:border-slate-300 dark:focus-within:border-slate-700 transition-colors px-3 pt-3 pb-2">
            {/* Hidden input for the paperclip button (Franck
                2026-04-29). Multiple selection supported; re-opening
                the picker does NOT reset existing chips (onChange
                appends). */}
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
            <textarea
              ref={textareaRef}
              className="w-full bg-transparent border-0 outline-none resize-none leading-relaxed text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 px-0 py-0"
              rows={2}
              // The height is driven by `autoResize` (see useLayoutEffect
              // on `draft`). max-height is set inline because tailwind's
              // max-h-[Xpx] works but duplicating the constant here
              // keeps the JS ceiling and the CSS ceiling in sync.
              // minHeight 3rem (~48px ~ 2 lines of leading-relaxed)
              // gives the composer a comfortable two-line rest height
              // \u2014 claude.ai uses a similar baseline. The action row
              // below has its own height (h-8), so the card no longer
              // needs to match a stacked button column.
              style={{ maxHeight: TEXTAREA_MAX_PX, minHeight: '3rem' }}
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
              // Clipboard paste of files / images (Franck 2026-04-29).
              // Browsers expose pasted images as DataTransferItem entries
              // with kind='file'. We only intercept when at least one
              // such file is present so plain-text paste keeps its
              // native behavior (cursor position, undo stack, …).
              // Clipboard images carry a generic name like "image.png";
              // we rename them with a timestamp to avoid collisions
              // when several screenshots are pasted in a row.
              onPaste={(e) => {
                const items = e.clipboardData?.items;
                if (!items || items.length === 0) return;
                const files: File[] = [];
                for (let i = 0; i < items.length; i += 1) {
                  const it = items[i];
                  if (it.kind !== 'file') continue;
                  const f = it.getAsFile();
                  if (!f) continue;
                  // Rename clipboard images so each paste yields a
                  // unique, recognizable filename.
                  const isGeneric = !f.name || /^image\.[a-z0-9]+$/i.test(f.name);
                  if (isGeneric && f.type.startsWith('image/')) {
                    const ext = f.type.split('/')[1] || 'png';
                    const ts = new Date()
                      .toISOString()
                      .replace(/[:.]/g, '-')
                      .replace('T', '_')
                      .slice(0, 19);
                    files.push(
                      new File([f], `pasted-${ts}.${ext}`, { type: f.type }),
                    );
                  } else {
                    files.push(f);
                  }
                }
                if (files.length > 0) {
                  e.preventDefault();
                  void uploadFiles(files);
                }
              }}
              placeholder={currentId ? 'Reply…' : 'Ask anything to start a new conversation…'}
              disabled={streaming || !agentSId}
            />
            {/* Bottom action row (Franck 2026-05-21, second pass).
                Three slots, claude.ai-style:
                  - left: attach (ghost paperclip)
                  - center: agent picker (selectable before the first
                    message; read-only label once a conversation
                    exists, because Dust pins the agent at conv
                    creation time)
                  - right: send / stop. The single primary button
                    morphs:
                      idle           \u2192 brand send icon
                      streaming      \u2192 red square, click = stop
                      serverStream   \u2192 amber square, click = stop
                    The colour is the new streaming indicator that
                    replaced the status strip above the composer. */}
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={streaming}
                title="Attach files"
                aria-label="Attach files"
                className="inline-flex items-center justify-center h-8 w-8 rounded-full text-slate-500 hover:text-slate-700 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-700/60 transition-colors disabled:opacity-40 disabled:pointer-events-none shrink-0"
              >
                <Paperclip size={16} />
              </button>

              {/* Agent picker. Native <select> kept on purpose: it's
                  cheap, accessible, and matches the existing chrome.
                  Once a conversation exists, the agent is pinned by
                  Dust at creation time, so the picker degrades to a
                  read-only label (the previous toolbar did the same).
                  `flex-1 min-w-0` lets the picker absorb the
                  horizontal slack between paperclip and send, with
                  truncate kicking in for long agent names. */}
              <div className="flex-1 min-w-0 flex justify-center">
                {currentId ? (
                  <span
                    className="px-2 py-1 text-xs text-slate-500 dark:text-slate-400 truncate"
                    title={agents.find((a) => a.sId === agentSId)?.name ?? 'Agent'}
                  >
                    {agents.find((a) => a.sId === agentSId)?.name ?? 'Agent'}
                  </span>
                ) : (
                  <select
                    value={agentSId}
                    onChange={(e) => {
                      setAgentSId(e.target.value);
                      setAgentPickedBy('user');
                    }}
                    aria-label="Select agent"
                    className="max-w-full bg-transparent text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 cursor-pointer outline-none rounded px-2 py-1 hover:bg-slate-200/60 dark:hover:bg-slate-700/40 transition-colors truncate"
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
                )}
              </div>

              {(() => {
                // Send / Stop morphing button.
                const active = streaming || serverStreaming;
                const tone = streaming
                  // This tab owns the SSE: red, clear "stop NOW".
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : serverStreaming
                    // Another tab owns it: amber, "stop in background".
                    ? 'bg-amber-500 text-white hover:bg-amber-600'
                    // Idle: primary brand CTA.
                    : 'bg-brand-600 text-white hover:bg-brand-700';
                const sendDisabled =
                  !active &&
                  (!draft.trim() ||
                    !agentSId ||
                    attachments.some((a) => a.status === 'uploading'));
                return (
                  <button
                    type={active ? 'button' : 'submit'}
                    onClick={active ? () => void stopStream() : undefined}
                    disabled={active ? stopping : sendDisabled}
                    title={
                      streaming
                        ? 'Stop streaming'
                        : serverStreaming
                          ? 'Stop the background stream'
                          : 'Send'
                    }
                    aria-label={active ? 'Stop' : 'Send'}
                    className={`inline-flex items-center justify-center h-8 w-8 rounded-full transition-colors disabled:opacity-40 disabled:pointer-events-none shrink-0 ${tone}`}
                  >
                    {active ? <Square size={14} /> : <Send size={16} />}
                  </button>
                );
              })()}
            </div>
          </div>
        </form>
      </section>
    </div>
    </>
  );
}

