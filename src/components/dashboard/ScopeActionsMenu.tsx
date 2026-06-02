'use client';

// ---------------------------------------------------------------
// <ScopeActionsMenu> — consolidates every scope-level action into
// a single kebab (⋮) dropdown, aligned to the right of the
// breadcrumb path (Franck 2026-06-02). Replaces the former inline
// button row / chips (<DashboardActions> + <DashboardCreateChips>,
// ADR-0022 / 2026-05-28).
//
// Menu contents are contextual to the active scope:
//   root    → New folder · New project
//   folder  → New folder · New project · Delete this folder
//   project → New chat · Open repo (if gitUrl) · Delete this project
//
// Rendered as a client component (interactive: dropdown + the
// "New folder" name modal). The breadcrumb itself stays a server
// component; the page lays them out on one flex row.
// ---------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ExternalLink,
  FolderPlus,
  MessageSquarePlus,
  MoreVertical,
  Plus,
  Trash2,
} from 'lucide-react';
import { gitUrlToWebUrl } from '@/lib/git-web-url';

export type ScopeActions =
  | { kind: 'root' }
  | {
      kind: 'folder';
      folderId: string;
      fsPath: string;
      parentFsPath: string | null;
    }
  | {
      kind: 'project';
      projectId: string;
      fsPath: string;
      parentFsPath: string;
      // Raw git remote (ssh or https), or null when unset → the
      // "Open repo" item is shown only when it resolves to a web URL.
      gitUrl: string | null;
    };

export function ScopeActionsMenu({ scope }: { scope: ScopeActions }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
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

  const canCreate = scope.kind !== 'project';
  const parentFolderId = scope.kind === 'folder' ? scope.folderId : null;
  const projectFolderQuery =
    scope.kind === 'folder' ? `&folder=${encodeURIComponent(scope.folderId)}` : '';
  const repoWebUrl = scope.kind === 'project' ? gitUrlToWebUrl(scope.gitUrl) : null;

  const deleteCurrent = async () => {
    if (scope.kind === 'root') return;
    const kindLabel = scope.kind === 'folder' ? 'folder' : 'project';
    if (
      !confirm(
        `Delete this ${kindLabel} ("${scope.fsPath}")?\n\n${
          scope.kind === 'folder'
            ? 'The folder must be empty (the API will refuse otherwise).'
            : 'This will permanently remove the project, all its conversations, tasks and run history.'
        }`,
      )
    )
      return;
    setDeleting(true);
    try {
      const url =
        scope.kind === 'folder'
          ? `/api/folders/${scope.folderId}`
          : `/api/projects/${scope.projectId}?deleteFiles=0`;
      const r = await fetch(url, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(
          `Delete failed: ${j.error ?? `HTTP ${r.status}`}` + (j.detail ? `\n${j.detail}` : ''),
        );
        return;
      }
      const parent = scope.parentFsPath;
      router.push(parent ? `/${parent}` : '/');
      router.refresh();
    } finally {
      setDeleting(false);
    }
  };

  const createFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    setCreating(true);
    setErr(null);
    try {
      const r = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId: parentFolderId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error ?? `HTTP ${r.status}`);
        return;
      }
      setFolderName('');
      setShowFolderModal(false);
      router.refresh();
    } finally {
      setCreating(false);
    }
  };

  const itemBase =
    'flex w-full items-center gap-2 px-3 py-2 text-sm text-left hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50';
  const btnPrimary =
    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 text-sm';
  const btnSecondary =
    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Scope actions"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        <MoreVertical size={18} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-56 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {scope.kind === 'project' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  router.push(`/${scope.fsPath}/chat`);
                }}
                className={itemBase}
              >
                <MessageSquarePlus size={15} className="text-brand-500" /> New chat
              </button>
              {repoWebUrl && (
                <a
                  role="menuitem"
                  href={repoWebUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className={itemBase}
                >
                  <ExternalLink size={15} className="text-slate-500" /> Open repo
                </a>
              )}
            </>
          )}

          {canCreate && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setErr(null);
                  setShowFolderModal(true);
                }}
                className={itemBase}
              >
                <FolderPlus size={15} className="text-amber-500" /> New folder
              </button>
              <a
                role="menuitem"
                href={`/settings/projects?create=1${projectFolderQuery}`}
                onClick={() => setOpen(false)}
                className={itemBase}
              >
                <Plus size={15} className="text-teal-500" /> New project
              </a>
            </>
          )}

          {scope.kind !== 'root' && (
            <>
              <div className="my-1 h-px bg-slate-200 dark:bg-slate-700" />
              <button
                type="button"
                role="menuitem"
                disabled={deleting}
                onClick={() => {
                  setOpen(false);
                  void deleteCurrent();
                }}
                className={`${itemBase} text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30`}
              >
                <Trash2 size={15} /> Delete this {scope.kind}
              </button>
            </>
          )}
        </div>
      )}

      {showFolderModal && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30"
            onClick={() => setShowFolderModal(false)}
          />
          <div
            role="dialog"
            aria-modal
            className="fixed left-1/2 top-1/2 z-50 w-[min(380px,90vw)] -translate-x-1/2 -translate-y-1/2 space-y-3 rounded-lg border border-slate-300 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <FolderPlus size={14} /> New folder
            </div>
            <div className="text-xs text-slate-500">
              Parent:{' '}
              <span className="font-mono">
                {scope.kind === 'folder' ? scope.fsPath : '/ (root)'}
              </span>
            </div>
            <input
              autoFocus
              className="w-full rounded border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm dark:border-slate-700 dark:bg-slate-950"
              placeholder="folder name"
              pattern="[a-zA-Z0-9._-]+"
              title="Allowed: letters, digits, . _ - (no spaces, no slashes, no accents)"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFolder();
                if (e.key === 'Escape') setShowFolderModal(false);
              }}
            />
            {err && (
              <p className="whitespace-pre-wrap text-xs text-red-600 dark:text-red-400">{err}</p>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowFolderModal(false)}
                className={btnSecondary + ' px-3 py-1 text-xs'}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={creating || !folderName.trim()}
                onClick={() => void createFolder()}
                className={btnPrimary + ' px-3 py-1 text-xs disabled:opacity-50'}
              >
                {creating ? 'Creating\u2026' : 'Create'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
