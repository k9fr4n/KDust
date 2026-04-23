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
import React, { Fragment, useEffect, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { MessageMarkdown } from './MessageMarkdown';

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
          window.setTimeout(() => setDone(false), 1500);
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
};

function ChatMessageBubbleImpl(props: ChatBubbleProps) {
  const { role, content, createdAt, roleLabel, showDay } = props;
  const isUser = role === 'user';
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
              ' break-words min-w-0 overflow-hidden'
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
