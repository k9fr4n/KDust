/**
 * ChatMessageBubble (Franck 2026-04-20 10:50)
 * --------------------------------------------
 * A single user/agent/system message row, extracted from the chat
 * page so React.memo can bail out of reconciliation when the parent
 * re-renders for reasons unrelated to the message itself (composer
 * typing, nowTick, streaming token, etc.).
 *
 * Inputs are deliberately primitive (string / boolean / nullable
 * string) so React\u0027s default shallow compare does the right
 * thing: identical scalars → skip render entirely.
 *
 * Relative time is rendered via <LiveRelativeTime> which owns its
 * own 60s interval; it re-renders independently without triggering
 * the parent or any sibling bubbles.
 */
'use client';
import React, { Fragment, useEffect, useMemo, useState } from 'react';
import { Copy, Check, Wrench, FileText, Download } from 'lucide-react';
import { MessageMarkdown } from './MessageMarkdown';
import { UI_FLASH_MS } from '@/lib/constants';
import { useBlobDownload } from '@/lib/hooks/use-blob-download';
import {
  parseToolInvocations,
  parseTimeline,
  type ToolInvocation,
  type TimelineEvent,
} from '@/lib/tool-invocations';

/**
 * Compact one-line hint extracted from a tool call's params,
 * shown inline next to the tool name when the section is folded
 * (Franck 2026-05-08 feedback). Goal: the user can scan a long
 * tool-call list and tell what each call targets without
 * expanding it.
 *
 * Heuristic: if `params` is an object, surface the first
 * "interesting" scalar field — `path` / `url` / `command` /
 * `query` / `pattern` / `file` / `name` / `id` in that order —
 * else stringify shortly. Strings are returned as-is. Truncated
 * to 60 chars to stay on one line.
 */
const HINT_KEYS = ['path', 'url', 'command', 'query', 'pattern', 'file', 'name', 'id'] as const;
function summarizeParams(params: unknown): string {
  if (params == null) return '';
  if (typeof params === 'string') return params.slice(0, 60);
  if (typeof params === 'number' || typeof params === 'boolean') return String(params);
  if (Array.isArray(params)) {
    if (params.length === 0) return '';
    return summarizeParams(params[0]);
  }
  if (typeof params === 'object') {
    const obj = params as Record<string, unknown>;
    for (const k of HINT_KEYS) {
      const v = obj[k];
      if (typeof v === 'string' && v.length > 0) {
        return v.length > 60 ? v.slice(0, 57) + '…' : v;
      }
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
    // Fallback: first string-valued field, whatever its key.
    for (const [, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.length > 0) {
        return v.length > 60 ? v.slice(0, 57) + '…' : v;
      }
    }
  }
  return '';
}

/**
 * Tool invocations panel — one independent foldable `<details>`
 * **per call** (Franck 2026-05-08 feedback). No outer wrapper /
 * summary anymore: each call is its own top-level section, so the
 * user can open/close them individually and scan a long run as a
 * vertical list of self-contained rows.
 *
 * Each summary surfaces the tool name plus a one-line hint
 * (`summarizeParams`) so a folded list is informative on its own.
 *
 * Rendered both inside ChatMessageBubble (persisted history) and
 * inside the live-stream pane in _ChatClient (running reply),
 * with the same visual contract. Empty array renders nothing.
 */
export function ToolInvocationsPanel({
  invocations,
  defaultOpen = false,
}: {
  invocations: ToolInvocation[];
  /**
   * If true, every per-call section starts open. Used on
   * /run/[id] (post-mortem view, user already wants to see what
   * ran). /chat keeps the default `false` so calls stay folded
   * and the user can open the ones that matter.
   */
  defaultOpen?: boolean;
}) {
  if (invocations.length === 0) return null;
  return (
    <ol className="flex flex-col gap-1 max-w-full list-none">
      {invocations.map((inv, i) => {
        let pretty: string;
        try {
          pretty = JSON.stringify(inv.params ?? null, null, 2);
        } catch {
          pretty = String(inv.params);
        }
        const hasParams = Boolean(pretty) && pretty !== 'null';
        const hint = summarizeParams(inv.params);
        return (
          <li key={i} className="max-w-full">
            <details
              open={defaultOpen && hasParams}
              className="group text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 max-w-full"
            >
              <summary
                className={
                  'select-none flex items-center gap-1.5 marker:hidden [&::-webkit-details-marker]:hidden ' +
                  (hasParams ? 'cursor-pointer' : 'cursor-default')
                }
              >
                <Wrench size={12} className="text-amber-500 flex-none" />
                <span className="text-slate-400 dark:text-slate-500 text-[10px] tabular-nums flex-none">
                  {i + 1}.
                </span>
                <span className="font-mono text-amber-700 dark:text-amber-400 flex-none">
                  {inv.tool}
                </span>
                {hint && (
                  <span
                    className="text-slate-500 dark:text-slate-400 truncate font-mono text-[11px] min-w-0"
                    title={hint}
                  >
                    {hint}
                  </span>
                )}
                {hasParams && (
                  <>
                    <span className="ml-auto text-slate-400 dark:text-slate-500 text-[10px] group-open:hidden flex-none">
                      ▸
                    </span>
                    <span className="ml-auto text-slate-400 dark:text-slate-500 text-[10px] hidden group-open:inline flex-none">
                      ▾
                    </span>
                  </>
                )}
              </summary>
              {hasParams && (
                <pre className="mt-1 pl-2 border-l-2 border-slate-300 dark:border-slate-700 whitespace-pre-wrap [overflow-wrap:anywhere] text-[11px] text-slate-700 dark:text-slate-300">
                  {pretty}
                </pre>
              )}
            </details>
          </li>
        );
      })}
    </ol>
  );
}

// Re-export the parser so non-bubble surfaces (e.g. /run/[id])
// can reuse it without duplicating the JSON guard.
export type { ToolInvocation };

/**
 * Inline chronological timeline panel (Franck 2026-05-22, ADR-0017).
 *
 * Renders the agent's turn as a single ordered list interleaving
 * narration text, chain-of-thought, and tool invocations — matching
 * the Dust web reference rendering. Used by:
 *
 * - `_ChatClient.tsx` during streaming: events come from a single
 *   ordered SSE state, no separate "thinking pane" or grouped tools
 *   panel anymore.
 * - `ChatMessageBubble` for persisted agent messages whose
 *   `timeline` column is populated (post-ADR-0017 rows). Legacy
 *   rows (`timeline === null`) keep the previous grouped layout
 *   via the fallback branch in `ChatMessageBubbleImpl`.
 *
 * `streamingTail` toggles the live blinking caret on the LAST text
 * node, so the live pane has the same "answer in progress" cue the
 * old streamed bubble used to provide.
 */
export function MessageTimeline({
  events,
  streamingTail = false,
}: {
  events: TimelineEvent[];
  streamingTail?: boolean;
}) {
  if (events.length === 0) return null;
  const lastTextIdx = (() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'text') return i;
    }
    return -1;
  })();
  return (
    <ol className="flex flex-col gap-1.5 max-w-full list-none">
      {events.map((ev, i) => {
        if (ev.type === 'text') {
          const isTail = streamingTail && i === lastTextIdx;
          return (
            <li
              key={i}
              className="text-[15px] text-slate-900 dark:text-slate-100 [overflow-wrap:anywhere] min-w-0 max-w-full"
            >
              <MessageMarkdown tone="agent">{ev.content}</MessageMarkdown>
              {isTail && (
                <span className="inline-block w-2 h-4 -mb-0.5 ml-0.5 bg-slate-500 animate-pulse" />
              )}
            </li>
          );
        }
        if (ev.type === 'cot') {
          return (
            <li key={i} className="max-w-full">
              <details className="text-xs text-slate-500 italic">
                <summary className="cursor-pointer select-none">thinking…</summary>
                <pre className="whitespace-pre-wrap mt-1 pl-3 border-l-2 border-slate-300 dark:border-slate-700 [overflow-wrap:anywhere]">
                  {ev.content}
                </pre>
              </details>
            </li>
          );
        }
        // Tool event — same visual contract as ToolInvocationsPanel
        // rows so a turn that mixes timeline+legacy never looks
        // discontinuous on screen.
        let pretty: string;
        try {
          pretty = JSON.stringify(ev.params ?? null, null, 2);
        } catch {
          pretty = String(ev.params);
        }
        const hasParams = Boolean(pretty) && pretty !== 'null';
        const hint = summarizeParams(ev.params);
        return (
          <li key={i} className="max-w-full">
            <details
              className="group text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 max-w-full"
            >
              <summary
                className={
                  'select-none flex items-center gap-1.5 marker:hidden [&::-webkit-details-marker]:hidden ' +
                  (hasParams ? 'cursor-pointer' : 'cursor-default')
                }
              >
                <Wrench size={12} className="text-amber-500 flex-none" />
                <span className="font-mono text-amber-700 dark:text-amber-400 flex-none">
                  {ev.tool}
                </span>
                {hint && (
                  <span
                    className="text-slate-500 dark:text-slate-400 truncate font-mono text-[11px] min-w-0"
                    title={hint}
                  >
                    {hint}
                  </span>
                )}
                {hasParams && (
                  <>
                    <span className="ml-auto text-slate-400 dark:text-slate-500 text-[10px] group-open:hidden flex-none">
                      ▸
                    </span>
                    <span className="ml-auto text-slate-400 dark:text-slate-500 text-[10px] hidden group-open:inline flex-none">
                      ▾
                    </span>
                  </>
                )}
              </summary>
              {hasParams && (
                <pre className="mt-1 pl-2 border-l-2 border-slate-300 dark:border-slate-700 whitespace-pre-wrap [overflow-wrap:anywhere] text-[11px] text-slate-700 dark:text-slate-300">
                  {pretty}
                </pre>
              )}
            </details>
          </li>
        );
      })}
    </ol>
  );
}

// Re-export the timeline type for non-bubble surfaces (live pane
// in _ChatClient, future /run timeline view, etc.).
export type { TimelineEvent };

/**
 * Shape persisted on `Message.generatedFiles` and emitted on the
 * `generated_files` SSE event. Mirrors `AgentGeneratedFile` in
 * src/lib/dust/chat.ts — kept duplicated client-side rather than
 * imported to avoid pulling the server-only module into a 'use
 * client' bundle.
 */
export type GeneratedFile = {
  fileId: string;
  title: string;
  contentType: string;
  snippet?: string | null;
  hidden?: boolean;
};

/**
 * Robust JSON parser for `Message.generatedFiles`. Tolerates
 * legacy NULL rows and out-of-shape payloads (returns `[]` rather
 * than throwing) so a bad write never breaks the bubble render.
 */
export function parseGeneratedFiles(json: string | null | undefined): GeneratedFile[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is GeneratedFile =>
          !!x &&
          typeof x === 'object' &&
          typeof (x as GeneratedFile).fileId === 'string' &&
          typeof (x as GeneratedFile).title === 'string' &&
          typeof (x as GeneratedFile).contentType === 'string',
      )
      .filter((f) => !f.hidden)
      // Retroactive filter (Franck 2026-05-17): historical rows
      // persisted before the server-side guard in chat.ts may still
      // carry internal tool-I/O files where `title === fileId`. Drop
      // them at render time so we never surface a 502-ing download
      // chip. See src/lib/dust/chat.ts mergeFiles() for the upstream
      // filter that prevents new rows from accumulating these.
      .filter((f) => f.title !== f.fileId);
  } catch {
    return [];
  }
}

/**
 * Map a Dust contentType to a sensible file extension when the title
 * Dust gave us has none. Kept narrow on purpose — only the formats
 * we've actually seen agents produce. Falls back to `bin` rather
 * than guessing wildly.
 */
const EXT_BY_CT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/css': 'css',
  'text/javascript': 'js',
  'text/typescript': 'ts',
  'text/x-python': 'py',
  'application/x-sh': 'sh',
  'text/x-sh': 'sh',
  'text/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'audio/x-m4a': 'm4a',
};

/**
 * Pick a download filename for an agent-generated file. Agents usually
 * pick a sensible title ("chart.png") and we use it verbatim. When
 * the title carries no extension we append one based on contentType,
 * so the browser's "Save As" dialog never offers an extension-less
 * `fil_xxx`. Final string is also sanitised to the same charset the
 * server-side proxy accepts (see /api/files/[sId]).
 */
export function downloadName(f: { title: string; contentType: string; fileId: string }): string {
  const baseRaw = f.title && f.title.trim().length > 0 ? f.title.trim() : f.fileId;
  // Sanitise: keep letters, digits, common punctuation. Replace the
  // rest with '_' so we still pass the server's allow-list regex.
  const safeBase = baseRaw.replace(/[^A-Za-z0-9 _.()\-\u00C0-\u017F]/g, '_');
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(safeBase);
  if (hasExt) return safeBase.slice(0, 200);
  const ext = EXT_BY_CT[f.contentType] ?? 'bin';
  return `${safeBase}.${ext}`.slice(0, 200);
}

/**
 * Format a byte-less file size hint — we don't get a size from Dust
 * for generated files, so we lean on the content type label.
 */
function shortContentType(ct: string): string {
  if (ct === 'application/octet-stream') return 'file';
  // Strip vendor prefixes ("application/vnd.openxmlformats-…")
  const slash = ct.indexOf('/');
  const tail = slash >= 0 ? ct.slice(slash + 1) : ct;
  // Last segment after the last '.' or '-' is usually most readable.
  const segs = tail.split(/[.+-]/);
  return segs[segs.length - 1] || tail;
}

/**
 * Files generated by the agent during this turn (Franck 2026-05-16).
 *
 * Rendered BELOW the textual bubble: chronologically the agent
 * "concludes" by surfacing the files, mirroring Dust's own UI.
 * Image files (`image/*`) get an inline preview clickable through
 * to the full-size view; everything else renders as a download chip
 * pointing at `/api/files/:sId?download=1`.
 *
 * Empty array renders nothing — caller decides whether to even
 * mount this panel.
 */
export function GeneratedFilesPanel({ files }: { files: GeneratedFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 max-w-full mt-1">
      {files.map((f) => {
        const isImage = f.contentType.startsWith('image/');
        const viewHref = `/api/files/${f.fileId}`;
        const name = downloadName(f);
        // The server uses `name` to set Content-Disposition, which
        // overrides the <a download="..."> attribute — passing it
        // is what gives us a proper extension in the Save dialog.
        const dlHref = `/api/files/${f.fileId}?download=1&name=${encodeURIComponent(name)}`;
        if (isImage) {
          return (
            <div
              key={f.fileId}
              className="relative group rounded-md overflow-hidden border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-500"
            >
              <a
                href={viewHref}
                target="_blank"
                rel="noopener noreferrer"
                title={`${f.title} — open original`}
                className="block"
              >
                <img
                  src={viewHref}
                  alt={f.title}
                  loading="lazy"
                  className="block max-w-[240px] max-h-[240px] object-contain"
                />
              </a>
              {/* Download button — distinct target from the viewer
                  so the user can save the file with its proper
                  filename (extension included) without right-click
                  gymnastics. Always rendered; opacity ramps on
                  hover/focus so the tile stays clean at rest. */}
              <a
                href={dlHref}
                download={name}
                title={`Download ${name}`}
                aria-label={`Download ${name}`}
                // pointer-events-none while invisible (Franck
                // 2026-05-16): otherwise an opacity-0 link still
                // captures clicks on the image's top-right corner
                // and silently hijacks the "open original" action.
                className="absolute top-1.5 right-1.5 inline-flex items-center justify-center w-7 h-7 rounded-full bg-slate-900/70 text-white opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus:opacity-100 focus:pointer-events-auto transition-opacity"
              >
                <Download size={14} />
              </a>
            </div>
          );
        }
        return (
          <GeneratedFileChip
            key={f.fileId}
            dlHref={dlHref}
            name={name}
            snippet={f.snippet}
            contentType={f.contentType}
          />
        );
      })}
    </div>
  );
}

/**
 * Single non-image file chip. Extracted from GeneratedFilesPanel
 * so it can hold the useBlobDownload state (Franck 2026-05-17 —
 * Chrome blocks insecure HTTP downloads, see hook header).
 */
function GeneratedFileChip({
  dlHref,
  name,
  snippet,
  contentType,
}: {
  dlHref: string;
  name: string;
  snippet?: string | null;
  contentType: string;
}) {
  const { download, isDownloading, error } = useBlobDownload();
  return (
    <button
      type="button"
      onClick={() => void download(dlHref, name)}
      disabled={isDownloading}
      title={
        error
          ? `Download failed: ${error}`
          : snippet
            ? `${name}\n\n${snippet}`
            : name
      }
      className="inline-flex items-center gap-2 max-w-full px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs text-slate-700 dark:text-slate-200 disabled:opacity-60 disabled:cursor-progress"
    >
      <FileText size={14} className="text-blue-500 flex-none" />
      <span className="truncate font-medium min-w-0">{name}</span>
      <span className="text-[10px] text-slate-400 dark:text-slate-500 flex-none uppercase">
        {shortContentType(contentType)}
      </span>
      <Download size={12} className="text-slate-400 flex-none" />
    </button>
  );
}

/**
 * Local copy-to-clipboard button (Franck 2026-04-23 15:31). Kept
 * here rather than imported from /chat/page to avoid pulling the
 * whole chat page into the bubble memoisation unit. Swallows
 * clipboard errors silently (secure-context / iframe denial).
 */
function CopyContentButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          window.setTimeout(() => setDone(false), UI_FLASH_MS);
        } catch {
          /* silent */
        }
      }}
      className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
      title={done ? 'Copied!' : 'Copy message'}
      aria-label="Copy message"
    >
      {done ? <Check size={11} className="text-green-600" /> : <Copy size={11} />}
    </button>
  );
}

/** Short HH:MM. Kept here to avoid a prop — pure function of ISO. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function fullTime(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR');
}

/** Relative time string — drops to 's', 'm', 'h', 'd', absolute date. */
function relTime(iso: string): string {
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
    day: 'numeric', month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * Live relative time — self-subscribing so it does not force the
 * parent to re-render every minute. 60s tick is fine; switches to
 * 5s for timestamps younger than a minute so "just now" feels fresh.
 */
function LiveRelativeTimeImpl({ iso }: { iso: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const age = Date.now() - new Date(iso).getTime();
    const period = age < 60_000 ? 5_000 : 60_000;
    const id = setInterval(() => force((n) => n + 1), period);
    return () => clearInterval(id);
  }, [iso]);
  return <>{relTime(iso)}</>;
}
const LiveRelativeTime = React.memo(LiveRelativeTimeImpl);

export type ChatBubbleProps = {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  createdAt?: string | null;
  /** Pre-computed agent display label; string so memo is happy. */
  roleLabel: string;
  /** Whether to render a day separator ABOVE this bubble. */
  showDay: boolean;
  /**
   * Raw JSON blob from Message.toolInvocations (agent rows only).
   * Kept as a string prop so React's shallow compare still works:
   * we parse inside ChatMessageBubble to render the foldable
   * `<details>` panel. null / undefined / empty string => no panel.
   * (Franck 2026-05-07)
   */
  toolInvocationsJson?: string | null;
  /**
   * Raw JSON blob from Message.generatedFiles (agent rows only).
   * Same string-prop discipline as toolInvocationsJson so React.memo
   * shallow compare keeps bubbles from re-rendering when a sibling
   * row updates. Parsing happens inside the bubble.
   * (Franck 2026-05-16)
   */
  generatedFilesJson?: string | null;
  /**
   * Raw JSON blob from Message.timeline (agent rows only, Franck
   * 2026-05-22, ADR-0017). When non-null the bubble switches to the
   * inline chronological renderer (`MessageTimeline`) and the legacy
   * grouped `ToolInvocationsPanel` + markdown bubble layout is
   * skipped. null / undefined / empty string => legacy layout
   * (covers all pre-ADR rows; no retroactive backfill).
   */
  timelineJson?: string | null;
  /**
   * Wall-clock duration of the agent turn, milliseconds (agent
   * rows only, Franck 2026-05-22). When timeline rendering is
   * active the bubble wraps the timeline in a collapsed-by-default
   * `<details>` headed by "Completed in <duration>", mirroring
   * the Dust web reference: a finished turn collapses to a single
   * line, click-to-expand reveals the chronological feed. Null
   * degrades the label to a plain "Completed" (legacy rows or
   * aborted streams).
   */
  durationMs?: number | null;
};

/**
 * Format a wall-clock duration for the collapsed-turn header
 * ("3s", "47s", "1min 23s", "12min 4s"). Drops the seconds unit
 * once we hit the hour mark to keep the label short. Returns
 * 'Completed' for non-positive / null inputs so the header stays
 * sensible on aborted runs.
 */
function formatTurnDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return 'Completed';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `Completed in ${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) {
    return sec === 0
      ? `Completed in ${totalMin}min`
      : `Completed in ${totalMin}min ${sec}s`;
  }
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `Completed in ${hr}h ${min}min`;
}

function ChatMessageBubbleImpl(props: ChatBubbleProps) {
  const {
    role,
    content,
    createdAt,
    roleLabel,
    showDay,
    toolInvocationsJson,
    generatedFilesJson,
    timelineJson,
    durationMs,
  } = props;
  const isUser = role === 'user';
  const timeline = useMemo(
    () => (role === 'agent' ? parseTimeline(timelineJson) : []),
    [role, timelineJson],
  );
  const useTimeline = timeline.length > 0;
  const invocations = useMemo(
    () => (role === 'agent' ? parseToolInvocations(toolInvocationsJson) : []),
    [role, toolInvocationsJson],
  );
  const generatedFiles = useMemo(
    () => (role === 'agent' ? parseGeneratedFiles(generatedFilesJson) : []),
    [role, generatedFilesJson],
  );
  /**
   * fileId → desired download filename map (Franck 2026-05-16).
   * Threaded into MessageMarkdown so inline `![](fil_xxx)` images
   * get the same proper-extension Save dialog as the panel chips.
   */
  const fileNamesByFileId = useMemo(() => {
    const m: Record<string, string> = {};
    for (const f of generatedFiles) m[f.fileId] = downloadName(f);
    return m;
  }, [generatedFiles]);
  /**
   * Panel-eligible files: the agent often inlines images as
   * `![](fil_xxx)` in its markdown reply, and MessageMarkdown
   * renders those via <ChatImage />. Showing the same file in the
   * panel below would duplicate it. Substring match against the
   * raw content is sufficient here because Dust fileIds are
   * `fil_<base62>` with no collision-prone substrings.
   */
  const panelFiles = useMemo(() => {
    if (generatedFiles.length === 0) return generatedFiles;
    return generatedFiles.filter((f) => !content.includes(f.fileId));
  }, [generatedFiles, content]);
  return (
    <Fragment>
      {showDay && createdAt && (
        <div className="flex justify-center my-1">
          <span className="text-[10px] uppercase tracking-wider text-slate-400 bg-white dark:bg-slate-900 px-2 py-0.5 rounded-full border border-slate-200 dark:border-slate-700">
            {new Date(createdAt).toLocaleDateString('fr-FR', {
              weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
            })}
          </span>
        </div>
      )}
      <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
        {/* `min-w-0` is critical here: this wrapper is a flex item of
            the outer `flex justify-start/end` row, whose default
            `min-width` is `min-content`. Without `min-w-0`, a child
            with large intrinsic width (e.g. a markdown <table> whose
            cells are now allowed to keep their natural width, see
            MessageMarkdown.tsx) would force this wrapper to exceed
            its own `max-w-[85%]`, defeating the inner table's
            `overflow-x-auto` and making the entire chat column
            scroll horizontally instead of just the table.
            (Franck 2026-05-22) */}
        <div className={`flex flex-col gap-0.5 min-w-0 ${isUser ? 'items-end' : 'items-start'} max-w-[85%]`}>
          {/*
            Inline timeline branch (Franck 2026-05-22, ADR-0017).
            When the persisted Message.timeline is non-null we
            render the agent turn as a single chronological list
            (narration / thinking / tool calls interleaved in
            arrival order) instead of the legacy "tools panel
            above the bubble" layout. The legacy branch (else)
            is preserved verbatim for pre-ADR rows (no
            retroactive backfill) and for user/system messages.
           */}
          {role === 'agent' && useTimeline ? (
            // Collapsed-by-default turn wrapper (Franck 2026-05-22).
            // Mirrors Dust's web rendering: a completed turn folds
            // into a single "Completed in Xmin Ys ▸" header; the
            // user expands to see the full chronological feed.
            // During streaming the LIVE timeline is rendered
            // separately in `_ChatClient.tsx` without this wrapper
            // (always expanded with a blinking caret), so this
            // branch is only reached for persisted (terminated)
            // turns where collapsing is the right default.
            <div className="w-full max-w-full">
              <details className="group w-full">
                <summary
                  className="cursor-pointer select-none flex items-center gap-1.5 text-[12px] text-slate-500 dark:text-slate-400 marker:hidden [&::-webkit-details-marker]:hidden hover:text-slate-700 dark:hover:text-slate-300"
                >
                  <span className="text-[10px] flex-none group-open:hidden">▸</span>
                  <span className="text-[10px] flex-none hidden group-open:inline">▾</span>
                  <span>{formatTurnDuration(durationMs)}</span>
                </summary>
                <div className="mt-1.5">
                  <MessageTimeline events={timeline} />
                </div>
              </details>
            </div>
          ) : (
            <>
              {/* MCP tool invocations panel (Franck 2026-05-08).
                  Rendered ABOVE the agent bubble: chronologically
                  tools run before the textual answer, and keeping
                  them on top lets the user scan "what was queried"
                  first. Folded by default — each row carries an
                  inline hint (path / url / command / …) so a
                  collapsed list is still informative. */}
              {invocations.length > 0 && (
                <div className="w-full max-w-full mb-0.5">
                  <ToolInvocationsPanel invocations={invocations} />
                </div>
              )}
              <div
                className={
                  (isUser
                    ? 'px-3 py-2 rounded-2xl rounded-br-sm text-[15px] bg-blue-600 text-white shadow-sm'
                    : role === 'system'
                      ? 'px-3 py-2 rounded-2xl text-[15px] bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200 italic whitespace-pre-wrap'
                      : 'px-3 py-2 rounded-2xl rounded-bl-sm text-[15px] bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700') +
                  // See 2026-04-29 / 2026-05-22 notes on
                  // [overflow-wrap:anywhere] + max-w-full +
                  // overflow-hidden interaction with markdown tables.
                  ' [overflow-wrap:anywhere] min-w-0 max-w-full overflow-hidden'
                }
              >
                {role === 'system' ? (
                  content
                ) : (
                  <MessageMarkdown
                    tone={isUser ? 'user' : 'agent'}
                    fileNamesByFileId={fileNamesByFileId}
                  >
                    {content}
                  </MessageMarkdown>
                )}
              </div>
            </>
          )}
          {/* Files surfaced by the agent during this turn (Franck
              2026-05-16). Rendered BELOW the bubble — keeps the
              visual flow "agent says X, attaches Y". Hidden when
              empty so non-file turns stay compact. */}
          {panelFiles.length > 0 && (
            <GeneratedFilesPanel files={panelFiles} />
          )}
          {/* Metadata row (Franck 2026-04-23 15:31):
              - timestamp bumped 10px \u2192 11px (old was hard to read),
              - copy button on the opposite side of the role label so
                it's always reachable regardless of user/agent alignment. */}
          <div
            className={`text-[11px] text-slate-500 dark:text-slate-400 px-1 flex items-center gap-1.5 ${
              isUser ? 'flex-row-reverse' : 'flex-row'
            }`}
          >
            <span className="font-medium">{roleLabel}</span>
            {createdAt && (
              <span title={fullTime(createdAt)}>
                {'· '}
                {clockTime(createdAt)}
                <span className="ml-1 text-slate-400 dark:text-slate-500">
                  (<LiveRelativeTime iso={createdAt} />)
                </span>
              </span>
            )}
            {role !== 'system' && content && <CopyContentButton value={content} />}
          </div>
        </div>
      </div>
    </Fragment>
  );
}

/** Shallow-compare memo: re-renders only when one of the primitive
 *  props actually changes (content edit, new day separator decision,
 *  agent name resolution after agents fetch completes). */
export const ChatMessageBubble = React.memo(ChatMessageBubbleImpl);
