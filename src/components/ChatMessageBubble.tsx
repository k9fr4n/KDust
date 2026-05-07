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
import { Copy, Check, Wrench } from 'lucide-react';
import { MessageMarkdown } from './MessageMarkdown';
import { UI_FLASH_MS } from '@/lib/constants';

/**
 * One tool invocation as captured by streamAgentReply (Franck
 * 2026-05-07). Mirrors `StreamStats.toolInvocations[i]` in
 * src/lib/dust/chat.ts. `params` is whatever the agent sent —
 * already truncated (see toolInvocationsToJson) — so the renderer
 * just needs to display it safely.
 */
type ToolInvocation = { tool: string; params: unknown };

/**
 * Parse the JSON blob persisted on Message.toolInvocations.
 * Returns [] for null / invalid JSON / non-array — never throws.
 * The invocation list is best-effort: a malformed row should not
 * crash the bubble.
 */
function parseToolInvocations(raw: string | null | undefined): ToolInvocation[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (x): x is ToolInvocation =>
          x && typeof x === 'object' && typeof (x as ToolInvocation).tool === 'string',
      )
      .map((x) => ({ tool: x.tool, params: x.params }));
  } catch {
    return [];
  }
}

/**
 * Tool invocations panel — one foldable `<details>` per agent
 * message that ran MCP tools. Header summarises the call count
 * + distinct tool list; expanded body shows each call with its
 * params pretty-printed. Empty array renders nothing.
 *
 * Rendered both inside ChatMessageBubble (persisted history) and
 * inside the live-stream pane in _ChatClient (running reply),
 * with the same visual contract.
 */
export function ToolInvocationsPanel({
  invocations,
  defaultOpen = false,
}: {
  invocations: ToolInvocation[];
  defaultOpen?: boolean;
}) {
  const distinctNames = useMemo(() => {
    const s = new Set<string>();
    for (const i of invocations) s.add(i.tool);
    return Array.from(s);
  }, [invocations]);
  if (invocations.length === 0) return null;
  return (
    <details
      open={defaultOpen}
      className="text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 max-w-full"
    >
      <summary className="cursor-pointer select-none flex items-center gap-1.5">
        <Wrench size={12} className="text-amber-500 flex-none" />
        <span>
          {invocations.length} tool call{invocations.length > 1 ? 's' : ''}
        </span>
        <span className="text-slate-400 dark:text-slate-500 truncate font-mono">
          · {distinctNames.join(', ')}
        </span>
      </summary>
      {/* One foldable row per tool call (Franck 2026-05-07
          feedback): the outer <details> just opens the *list*; each
          call has its own nested <details> so params stay collapsed
          until you click that specific row. Keeps long runs (20+
          calls) scannable instead of dumping every JSON blob at
          once. */}
      <ol className="mt-1.5 flex flex-col gap-0.5 list-decimal list-inside marker:text-slate-400">
        {invocations.map((inv, i) => {
          let pretty: string;
          try {
            pretty = JSON.stringify(inv.params ?? null, null, 2);
          } catch {
            pretty = String(inv.params);
          }
          const hasParams = pretty && pretty !== 'null';
          return (
            <li key={i} className="pl-1">
              {hasParams ? (
                <details className="inline align-top group">
                  <summary className="cursor-pointer select-none inline-flex items-baseline gap-1 marker:hidden [&::-webkit-details-marker]:hidden">
                    <span className="font-mono text-amber-700 dark:text-amber-400">
                      {inv.tool}
                    </span>
                    <span className="text-slate-400 dark:text-slate-500 text-[10px] group-open:hidden">
                      ▸
                    </span>
                    <span className="text-slate-400 dark:text-slate-500 text-[10px] hidden group-open:inline">
                      ▾
                    </span>
                  </summary>
                  <pre className="mt-0.5 ml-4 pl-2 border-l-2 border-slate-300 dark:border-slate-700 whitespace-pre-wrap [overflow-wrap:anywhere] text-[11px] text-slate-700 dark:text-slate-300">
                    {pretty}
                  </pre>
                </details>
              ) : (
                <span className="font-mono text-amber-700 dark:text-amber-400">
                  {inv.tool}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

// Re-export the parser so non-bubble surfaces (e.g. /run/[id])
// can reuse it without duplicating the JSON guard.
export { parseToolInvocations };
export type { ToolInvocation };

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
};

function ChatMessageBubbleImpl(props: ChatBubbleProps) {
  const { role, content, createdAt, roleLabel, showDay, toolInvocationsJson } = props;
  const isUser = role === 'user';
  const invocations = useMemo(
    () => (role === 'agent' ? parseToolInvocations(toolInvocationsJson) : []),
    [role, toolInvocationsJson],
  );
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
        <div className={`flex flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'} max-w-[85%]`}>
          <div
            className={
              (isUser
                ? 'px-3 py-2 rounded-2xl rounded-br-sm text-sm bg-blue-600 text-white shadow-sm'
                : role === 'system'
                  ? 'px-3 py-2 rounded-2xl text-sm bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200 italic whitespace-pre-wrap'
                  : 'px-3 py-2 rounded-2xl rounded-bl-sm text-sm bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700') +
              // [overflow-wrap:anywhere] is more aggressive than
              // break-words: it can break inside an otherwise
              // unbreakable token (long URL, hash, base64) so very
              // long messages stay inside the bubble. We dropped
              // overflow-hidden because it was masking the tail of
              // the message when the wrap heuristic failed instead
              // of expanding to a new line. (Franck 2026-04-29)
              ' [overflow-wrap:anywhere] min-w-0'
            }
          >
            {role === 'system' ? (
              content
            ) : (
              <MessageMarkdown tone={isUser ? 'user' : 'agent'}>
                {content}
              </MessageMarkdown>
            )}
          </div>
          {/* MCP tool invocations panel (Franck 2026-05-07).
              Below the bubble, same alignment as the metadata
              row so the user can scan «what did the agent
              actually do?» without expanding by default. */}
          {invocations.length > 0 && (
            <div className="w-full max-w-full mt-0.5">
              <ToolInvocationsPanel invocations={invocations} />
            </div>
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
