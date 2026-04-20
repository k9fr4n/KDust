'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FolderGit2, Pin, PinOff, Trash2 } from 'lucide-react';
import { OpenConversationLink } from './OpenConversationLink';
import { publishConvEvent } from '@/lib/client/conversationsBus';

export type ConvSummary = {
  id: string;
  title: string;
  agentName: string | null;
  agentSId: string;
  projectName: string | null;
  pinned: boolean;
  updatedAt: Date;
};

function fmtRel(d: Date) {
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function ConversationCard({ conv }: { conv: ConvSummary }) {
  const router = useRouter();
  const [pinned, setPinned] = useState(conv.pinned);
  const [busy, setBusy] = useState(false);

  const togglePin = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      const next = !pinned;
      const r = await fetch(`/api/conversations/${conv.id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: next }),
      });
      if (r.ok) {
        setPinned(next);
        router.refresh();
        // Notify other tabs / pages (Franck 2026-04-20 17:04).
        publishConvEvent({ type: 'pinned', id: conv.id, pinned: next });
      }
    } finally {
      setBusy(false);
    }
  };

  const del = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete conversation "${conv.title}" ?`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/conversations/${conv.id}`, { method: 'DELETE' });
      if (r.ok) {
        router.refresh();
        publishConvEvent({ type: 'deleted', id: conv.id });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="group relative">
      <OpenConversationLink
        conversationId={conv.id}
        className="block px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-900"
      >
        {/* Layout restructure 2026-04-20 17:45 (Franck):
            \u2022 Line 1 now only shows pin + title. Right padding
              (pr-20) reserves space for the absolute-positioned
              pin/delete action cluster so it no longer occludes
              the meta row.
            \u2022 Line 2 groups agent name + project badge + relative
              timestamp together \u2014 the timestamp is now directly
              adjacent to the project name, as requested. */}
        <div className="flex items-center gap-2 pr-20">
          {pinned && <Pin size={12} className="text-amber-500 shrink-0" />}
          <span className="text-sm font-medium truncate flex-1">{conv.title}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500 min-w-0">
          <span className="truncate">{conv.agentName ?? conv.agentSId}</span>
          {conv.projectName ? (
            <span className="shrink-0 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-brand-300 text-brand-700 dark:text-brand-300 dark:border-brand-700 bg-brand-50 dark:bg-brand-950/30 font-mono">
              <FolderGit2 size={10} /> {conv.projectName}
            </span>
          ) : (
            <span className="shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700 text-slate-400 italic">
              no project
            </span>
          )}
          <span className="text-xs text-slate-400 shrink-0">{fmtRel(conv.updatedAt)}</span>
        </div>
      </OpenConversationLink>

      {/* Action cluster (pin / delete). Always visible (Franck
          2026-04-20 16:46) \u2014 the previous hover-only pattern made
          discoverability poor and was invisible on touch devices.
          The pin icon goes amber when active so the state is legible
          at a glance. */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 bg-white/70 dark:bg-slate-900/70 backdrop-blur px-1 rounded">
        <button
          onClick={togglePin}
          disabled={busy}
          title={pinned ? 'Unpin' : 'Pin'}
          aria-label={pinned ? 'Unpin conversation' : 'Pin conversation'}
          className={`p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-800 ${
            pinned ? 'text-amber-500' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
          }`}
        >
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button
          onClick={del}
          disabled={busy}
          title="Delete"
          aria-label="Delete conversation"
          className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950 text-slate-400 hover:text-red-500"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  );
}
