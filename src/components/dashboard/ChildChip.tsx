'use client';

// ---------------------------------------------------------------
// <ChildChip> — dashboard child link with hover-delete (ADR-0022).
//
// Renders the same chip the dashboard used to render inline
// (FolderGit2 icon + label + optional sub-count) but adds a tiny
// "x" button on hover that fires DELETE /api/folders/:id or
// /api/projects/:id with a confirm dialog. Errors are surfaced
// verbatim from the API ("folder not empty", "task is running",
// …) so the operator sees the same error language as in
// /settings/projects.
//
// Kept a client component because it needs onClick + state for
// the busy indicator. Lives next to the Server Component
// `src/app/page.tsx` which composes the dashboard layout.
// ---------------------------------------------------------------

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FolderGit2, X } from 'lucide-react';

export function ChildChip(props: {
  kind: 'folder' | 'project';
  id: string;
  label: string;
  href: string;
  sub?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const onDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const kindLabel = props.kind === 'folder' ? 'folder' : 'project';
    if (!confirm(`Delete ${kindLabel} "${props.label}"?\n\n${
      props.kind === 'folder'
        ? 'The folder must be empty (the API will refuse otherwise).'
        : 'This will permanently remove the project, all its conversations, tasks and run history.'
    }`)) return;
    setBusy(true);
    try {
      const url =
        props.kind === 'folder'
          ? `/api/folders/${props.id}`
          : `/api/projects/${props.id}?deleteFiles=0`;
      const r = await fetch(url, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(
          `Delete failed: ${j.error ?? `HTTP ${r.status}`}` +
            (j.detail ? `\n${j.detail}` : ''),
        );
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Link
      href={props.href}
      className="group relative inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:shadow dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-slate-600 px-3 py-1.5 pr-7 text-sm font-medium shadow-sm transition"
    >
      <FolderGit2
        size={14}
        className={props.kind === 'folder' ? 'text-amber-500' : 'text-teal-500'}
      />
      {props.label}
      {props.sub ? <span className="text-xs text-slate-400">({props.sub})</span> : null}
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        title={`Delete ${props.kind}`}
        className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 hover:opacity-100 focus:opacity-100 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/40 rounded p-0.5 transition disabled:opacity-50"
      >
        <X size={12} />
      </button>
    </Link>
  );
}
