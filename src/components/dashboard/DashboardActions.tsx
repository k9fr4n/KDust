'use client';

// ---------------------------------------------------------------
// <DashboardActions> — scope-level destructive action rendered as
// a trailing chip in the children flex row, right after the
// "+ New folder" / "+ New project" create chips (Franck
// 2026-05-28). Originally lived at the top of the dashboard
// (ADR-0022); moved into the chips row so the destructive button
// reads last, after the safer create actions, instead of
// floating above the folder/project grid. Returns a bare
// <button> so it composes inside the parent flex-wrap without an
// extra wrapper div.
// ---------------------------------------------------------------

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FolderPlus, Plus, Trash2 } from 'lucide-react';

type Scope =
  | { kind: 'root' }
  | {
      kind: 'folder';
      folderId: string;
      fsPath: string;
      parentFsPath: string | null;
    }
  | { kind: 'project'; projectId: string; fsPath: string; parentFsPath: string };

export function DashboardActions({ scope }: { scope: Scope }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  if (scope.kind === 'root') return null;

  const deleteCurrent = async () => {
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
          `Delete failed: ${j.error ?? `HTTP ${r.status}`}` +
            (j.detail ? `\n${j.detail}` : ''),
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

  const btnDanger =
    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-red-300 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 text-sm';

  return (
    <button
      type="button"
      onClick={() => void deleteCurrent()}
      disabled={deleting}
      className={btnDanger}
    >
      <Trash2 size={14} /> Delete this {scope.kind}
    </button>
  );
}

// ---------------------------------------------------------------
// <DashboardCreateChips> — "+ Folder" / "+ Project" chips appended
// to the children list. Visible only when the active scope can
// host children (root or folder); a project leaf has no children
// section so the component renders null.
// ---------------------------------------------------------------

export function DashboardCreateChips({ scope }: { scope: Scope }) {
  const router = useRouter();
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (scope.kind === 'project') return null;

  const parentFolderId = scope.kind === 'folder' ? scope.folderId : null;
  const projectFolderQuery =
    scope.kind === 'folder' ? `&folder=${encodeURIComponent(scope.folderId)}` : '';

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

  const chipBase =
    'inline-flex items-center gap-2 rounded-md border bg-white text-slate-700 dark:bg-slate-800 dark:text-slate-200 px-3 py-1.5 text-sm font-medium shadow-sm transition';
  const chipFolder =
    `${chipBase} border-dashed border-amber-300 dark:border-amber-700 hover:border-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30`;
  const chipProject =
    `${chipBase} border-dashed border-teal-300 dark:border-teal-700 hover:border-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/30`;
  const btnPrimary =
    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 text-sm';
  const btnSecondary =
    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm';

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setShowFolderModal(true);
          setErr(null);
        }}
        className={chipFolder}
        title="Create a new folder under this scope"
      >
        <FolderPlus size={14} className="text-amber-500" />
        New folder
      </button>
      <a
        href={`/settings/projects?create=1${projectFolderQuery}`}
        className={chipProject}
        title="Create a new project under this scope"
      >
        <Plus size={14} className="text-teal-500" />
        New project
      </a>

      {showFolderModal && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30"
            onClick={() => setShowFolderModal(false)}
          />
          <div
            role="dialog"
            aria-modal
            className="fixed left-1/2 top-1/2 z-50 w-[min(380px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-4 space-y-3"
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
              className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-sm font-mono"
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
              <p className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap">
                {err}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowFolderModal(false)}
                className={btnSecondary + ' text-xs px-3 py-1'}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={creating || !folderName.trim()}
                onClick={() => void createFolder()}
                className={btnPrimary + ' text-xs px-3 py-1 disabled:opacity-50'}
              >
                {creating ? 'Creating\u2026' : 'Create'}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
