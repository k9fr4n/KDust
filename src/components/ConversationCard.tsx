'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FolderGit2, Pin, PinOff, Trash2 } from 'lucide-react';
import { OpenConversationLink } from './OpenConversationLink';

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
      if (r.ok) router.refresh();
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
        <div className="flex items-center gap-2">
          {pinned && <Pin size={12} className="text-amber-500 shrink-0" />}
          <span className="text-sm font-medium truncate flex-1">{conv.title}</span>
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
        <div className="text-xs text-slate-500 truncate">
          {conv.agentName ?? conv.agentSId}
        </div>
      </OpenConversationLink>

      <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 bg-white/90 dark:bg-slate-900/90 backdrop-blur px-1 rounded">
        <button
          onClick={togglePin}
          disabled={busy}
          title={pinned ? 'Unpin' : 'Pin'}
          className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500"
        >
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button
          onClick={del}
          disabled={busy}
          title="Delete"
          className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950 text-red-500"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  );
}
