'use client';
/**
 * /settings/projects — projects + folder hierarchy management.
 *
 * Reworked 2026-05-27 (Franck, ADR-0022 unbounded folder depth):
 *   - Folder taxonomy panel renders a recursive tree, indented
 *     by depth. One "+ folder" input at the top picks any parent
 *     (incl. root); each row has its own "create subfolder"
 *     button that pre-selects itself as parent.
 *   - Project create form: folder picker is optional (default =
 *     root, fsPath = name) and lists every folder regardless of
 *     depth. Pasting a git URL auto-fills the name with the
 *     repo leaf slug (offline, no platform API call).
 *   - Project list groups by full parent path (e.g. "/", "clients",
 *     "clients/acme/prod"), sorted alphabetically with root
 *     pinned first. Active text filter still degrades to a flat
 *     sorted list.
 *   - "Move…" dialog: lists every folder + a "/ (root)" option.
 *     The API refuses with 409 when a TaskRun is running/pending;
 *     the message is shown verbatim so the operator knows to
 *     wait + retry.
 *   - Inline folder rename. The API cascades the fsPath rewriting
 *     through every descendant project (mv FS dir + DB tx). The
 *     whole operation is best-effort idempotent; a partial
 *     failure is logged server-side and surfaced to the user.
 *
 * No drag-and-drop — a "Move…" modal is more accessible (keyboard
 * nav, screen reader friendly) and avoids HTML5 DnD edge cases
 * (sticky headers, scroll while dragging, mobile touch).
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  RefreshCw, Trash2, Plus, Folder, ArrowLeft, GitBranch,
  FolderOpen, X, Search, FolderTree, ChevronDown, ChevronRight,
  FolderPlus, Edit2, Move, Check,
} from 'lucide-react';
import { DocumentTitle } from '@/components/DocumentTitle';
import { PageHeader } from '@/components/PageHeader';
import { extractRepoSlugFromGitUrl } from '@/lib/git-url';

type P = {
  id: string;
  name: string;
  gitUrl: string | null;
  branch: string;
  description: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  folderId: string | null;
  fsPath: string | null;
};

type FolderNode = {
  id: string;
  name: string;
  projectCount: number;
  children?: FolderNode[];
};

type Mode = 'git' | 'sandbox';

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Derive the L1/L2 folder path from a project's fsPath. */
function folderPathOf(p: P): string {
  const fp = p.fsPath ?? p.name;
  const parts = fp.split('/');
  return parts.length >= 2 ? parts.slice(0, -1).join('/') : '(unfiled)';
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={null}>
      <DocumentTitle title="Projects" />
      <ProjectsPageInner />
    </Suspense>
  );
}

function ProjectsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const autoDeleteFiredFor = useRef<string | null>(null);

  const [projects, setProjects] = useState<P[]>([]);
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [loading, setLoading] = useState(true);

  // Folders panel: collapsed by default to keep the project list
  // primary on this page.
  const [showFolders, setShowFolders] = useState(false);

  // Per-L1 collapsed state for the grouped project list. Default:
  // all expanded so users see everything on first load. Persisted
  // to localStorage so navigating away and back keeps the user's
  // chosen layout.
  const [collapsedL1, setCollapsedL1] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem('kdust:projects:collapsedL1');
      if (raw) setCollapsedL1(new Set(JSON.parse(raw)));
    } catch { /* ignore */ }
  }, []);
  const persistCollapsed = (next: Set<string>) => {
    setCollapsedL1(next);
    try {
      localStorage.setItem(
        'kdust:projects:collapsedL1',
        JSON.stringify([...next]),
      );
    } catch { /* ignore */ }
  };

  const [showCreate, setShowCreate] = useState(false);
  const [mode, setMode] = useState<Mode>('git');
  const [form, setForm] = useState({
    name: '', gitUrl: '', branch: 'main', description: '', folderId: '',
  });
  // Tracks whether the operator has manually edited the `name`
  // field. When false (= never typed in name OR cleared after
  // reset), pasting a git URL auto-fills the name with the
  // extracted slug. As soon as the user types in name, we stop
  // overwriting (ADR-0022 §Chantier 3, option A).
  const [nameTouched, setNameTouched] = useState(false);
  const [creating, setCreating] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [filter, setFilter] = useState('');

  const [moveTarget, setMoveTarget] = useState<P | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [pr, tr] = await Promise.all([
        fetch('/api/projects', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/folders', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      setProjects(pr.projects ?? []);
      setTree(tr.tree ?? []);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void refresh(); }, []);

  // ?delete=<id> auto-trigger from /settings/projects/[id] — same
  // pattern as before phase 3.
  useEffect(() => {
    const targetId = searchParams?.get('delete');
    if (!targetId) return;
    if (autoDeleteFiredFor.current === targetId) return;
    if (projects.length === 0) return;
    const victim = projects.find((p) => p.id === targetId);
    if (!victim) return;
    autoDeleteFiredFor.current = targetId;
    router.replace('/settings/projects');
    void remove(victim.id, victim.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, projects]);

  // ?create=1[&folder=<id>] from the dashboard "+ Project" button
  // (ADR-0022 §Chantier 4). Auto-shows the create form with the
  // parent folder pre-selected. Fires once; we clear the query
  // string after to keep the URL clean and avoid re-firing on
  // back-button navigation.
  const autoCreateFired = useRef(false);
  useEffect(() => {
    if (autoCreateFired.current) return;
    if (searchParams?.get('create') !== '1') return;
    autoCreateFired.current = true;
    const folderId = searchParams.get('folder') ?? '';
    setForm((f) => ({ ...f, folderId }));
    setShowCreate(true);
    router.replace('/settings/projects');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const resetForm = () => {
    setForm({ name: '', gitUrl: '', branch: 'main', description: '', folderId: '' });
    setMode('git');
    setNameTouched(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setCreating(true);
    try {
      const payload =
        mode === 'git'
          ? {
              name: form.name.trim(),
              gitUrl: form.gitUrl.trim(),
              branch: form.branch.trim() || 'main',
              description: form.description.trim() || null,
              folderId: form.folderId || null,
            }
          : {
              name: form.name.trim(),
              gitUrl: null,
              branch: 'main',
              description: form.description.trim() || null,
              folderId: form.folderId || null,
            };
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail =
          typeof j.error === 'string'
            ? j.error
            : j.error
              ? JSON.stringify(j.error)
              : `HTTP ${r.status}`;
        const tail = j.output ? `\n\n${String(j.output).slice(-1500)}` : '';
        setMsg({ kind: 'err', text: `${detail}${tail}` });
        if (j.project) await refresh();
        return;
      }
      setMsg({
        kind: 'ok',
        text: j.sandbox
          ? `Created sandbox project "${payload.name}".`
          : `Cloned "${payload.name}" successfully.`,
      });
      resetForm();
      setShowCreate(false);
      await refresh();
    } finally {
      setCreating(false);
    }
  };

  const sync = async (id: string) => {
    setBusyId(id);
    setMsg(null);
    try {
      const r = await fetch(`/api/projects/${id}/sync`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      setMsg({
        kind: r.ok ? 'ok' : 'err',
        text: r.ok ? 'Sync OK' : `Sync failed: ${j.error ?? 'unknown'}\n${j.output ?? ''}`,
      });
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string, name: string) => {
    if (
      !confirm(
        `Delete project "${name}"?\n\n` +
          `This will permanently remove:\n` +
          `  \u2022 all conversations and messages linked to this project\n` +
          `  \u2022 all tasks and their run history\n\n` +
          `This cannot be undone.`,
      )
    ) return;
    const deleteFiles = confirm(
      `Also delete the working copy on disk?\n\n` +
        `OK  = remove files (irreversible)\n` +
        `Cancel = keep the folder`,
    );
    const r = await fetch(`/api/projects/${id}?deleteFiles=${deleteFiles ? 1 : 0}`, {
      method: 'DELETE',
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const d = j.deleted ?? {};
      setMsg({
        kind: 'ok',
        text:
          `Deleted "${name}": ${d.conversations ?? 0} conversation(s), ` +
          `${d.tasks ?? 0} task(s)` +
          (d.filesDeleted ? ', files removed.' : ', files kept.'),
      });
      await refresh();
    } else {
      setMsg({
        kind: 'err',
        text: `Delete failed: ${typeof j.error === 'string' ? j.error : `HTTP ${r.status}`}`,
      });
    }
  };

  const moveProject = async (projectId: string, folderId: string | null) => {
    const r = await fetch(`/api/projects/${projectId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      setMsg({
        kind: 'ok',
        text: `Moved "${j.oldFsPath}" → "${j.newFsPath}".`,
      });
      setMoveTarget(null);
      await refresh();
    } else {
      setMsg({
        kind: 'err',
        text:
          `Move failed: ${j.error ?? `HTTP ${r.status}`}` +
          (j.detail ? ` (${j.detail})` : '') +
          (j.error === 'busy'
            ? '\n\nA TaskRun is running or pending on this project. Wait for it to finish, then retry.'
            : ''),
      });
    }
  };

  const field =
    'w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-sm';
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  // Flat list of ALL folders (any depth, ADR-0022) for the
  // create-form picker and the move modal. Walk the recursive
  // tree, producing `{ id, path, count }` where `path` is the
  // full slash-joined ancestor chain and `count` is direct
  // projects under the folder (descendants not included).
  const allFolders = useMemo(() => {
    const out: { id: string; path: string; count: number }[] = [];
    const walk = (nodes: FolderNode[], prefix: string) => {
      for (const n of nodes) {
        const path = prefix ? `${prefix}/${n.name}` : n.name;
        out.push({ id: n.id, path, count: n.projectCount });
        if (n.children && n.children.length > 0) walk(n.children, path);
      }
    };
    walk(tree, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }, [tree]);

  // Filter behaviour:
  //   - empty filter → grouped view (by L1, then L2)
  //   - non-empty   → flat sorted list, name + description + path matched
  const filteredFlat = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    return [...projects]
      .filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q) ||
        folderPathOf(p).toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [projects, filter]);

  const grouped = useMemo(() => {
    if (filteredFlat) return null;
    // ADR-0022 / unbounded depth: group by the project's full
    // parent folder path (everything except the leaf project
    // name). Root-level projects (no folder) bucket under "/".
    // Each group is then sorted alphabetically by its full path,
    // with "/" (root) pinned first.
    const out = new Map<string, P[]>();
    for (const p of projects) {
      const fp = p.fsPath ?? p.name;
      const parts = fp.split('/').filter(Boolean);
      const parent = parts.length <= 1 ? '/' : parts.slice(0, -1).join('/');
      if (!out.has(parent)) out.set(parent, []);
      out.get(parent)!.push(p);
    }
    const sortedParents = [...out.keys()].sort((a, b) => {
      if (a === '/') return -1;
      if (b === '/') return 1;
      return a.localeCompare(b);
    });
    return sortedParents.map((parent) => ({
      parent,
      projects: out
        .get(parent)!
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    }));
  }, [projects, filteredFlat]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Folder size={20} />}
        title="Projects"
        right={
          <>
            <button
              onClick={() => setShowFolders((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm"
              title="Manage folder hierarchy"
            >
              <FolderTree size={14} /> {showFolders ? 'Hide folders' : 'Folders'}
            </button>
            <button
              onClick={() => setShowCreate((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 text-sm"
            >
              {showCreate ? <><X size={14} /> Cancel</> : <><Plus size={14} /> New project</>}
            </button>
          </>
        }
      />
      {/* Breadcrumb — same trail DSL as /settings/projects/[id]. */}
      <nav className="flex items-center gap-2 text-[15px]">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-slate-500 hover:text-brand-600"
        >
          <ArrowLeft size={16} /> Settings
        </Link>
      </nav>

      {showFolders && (
        <FoldersPanel tree={tree} onChanged={refresh} setMsg={setMsg} />
      )}

      {showCreate && (
        <form
          onSubmit={submit}
          className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-4 bg-slate-50/30 dark:bg-slate-900/20"
        >
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Mode</div>
            <div className="inline-flex rounded border border-slate-300 dark:border-slate-700 overflow-hidden text-sm">
              <button
                type="button"
                onClick={() => setMode('git')}
                className={
                  'px-3 py-1.5 inline-flex items-center gap-1.5 ' +
                  (mode === 'git'
                    ? 'bg-brand-500 text-white'
                    : 'bg-white dark:bg-slate-950 hover:bg-slate-100 dark:hover:bg-slate-800')
                }
              >
                <GitBranch size={14} /> Git repository
              </button>
              <button
                type="button"
                onClick={() => setMode('sandbox')}
                className={
                  'px-3 py-1.5 inline-flex items-center gap-1.5 border-l border-slate-300 dark:border-slate-700 ' +
                  (mode === 'sandbox'
                    ? 'bg-brand-500 text-white'
                    : 'bg-white dark:bg-slate-950 hover:bg-slate-100 dark:hover:bg-slate-800')
                }
              >
                <FolderOpen size={14} /> Sandbox (local only)
              </button>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-500">
                Name (folder) *
                {!nameTouched && form.gitUrl.trim() && form.name && (
                  <span className="ml-1 text-slate-400">(auto)</span>
                )}
              </span>
              <input
                className={field + ' font-mono'}
                value={form.name}
                onChange={(e) => {
                  setForm({ ...form, name: e.target.value });
                  setNameTouched(true);
                }}
                placeholder="my-project"
                pattern="[a-zA-Z0-9._-]+"
                title="Allowed: letters, digits, dot, dash, underscore."
                required
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">
                Folder <span className="text-slate-400">(optional)</span>
              </span>
              <select
                className={field}
                value={form.folderId}
                onChange={(e) => setForm({ ...form, folderId: e.target.value })}
              >
                <option value="">— root (no folder) —</option>
                {allFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.path}{f.count ? `  (${f.count})` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-xs text-slate-500">Description <span className="text-slate-400">(optional)</span></span>
            <input
              className={field}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Short summary shown on dashboards"
              maxLength={500}
            />
          </label>

          {mode === 'git' && (
            <div className="grid md:grid-cols-[2fr_160px] gap-3">
              <label className="block">
                <span className="text-xs text-slate-500">Repository URL *</span>
                <input
                  className={field + ' font-mono'}
                  value={form.gitUrl}
                  onChange={(e) => {
                    const gitUrl = e.target.value;
                    // Auto-fill the `name` field with the repo
                    // leaf slug as long as the operator hasn't
                    // typed in it (ADR-0022 §Chantier 3, option
                    // A: offline, slug-from-URL only).
                    const next = { ...form, gitUrl };
                    if (!nameTouched) {
                      const slug = extractRepoSlugFromGitUrl(gitUrl);
                      next.name = slug ?? '';
                    }
                    setForm(next);
                  }}
                  placeholder="git@gitlab.ecritel.net:group/repo.git"
                  required
                />
              </label>
              <label className="block">
                <span className="text-xs text-slate-500">Branch *</span>
                <input
                  className={field + ' font-mono'}
                  value={form.branch}
                  onChange={(e) => setForm({ ...form, branch: e.target.value })}
                  placeholder="main"
                  required
                />
              </label>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={creating || !form.name.trim() || (mode === 'git' && !form.gitUrl.trim())}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 disabled:opacity-50 text-sm"
            >
              {creating
                ? <><RefreshCw size={14} className="animate-spin" /> {mode === 'git' ? 'Cloning…' : 'Creating…'}</>
                : <><Plus size={14} /> {mode === 'git' ? 'Clone and add' : 'Create sandbox'}</>}
            </button>
            <button
              type="button"
              onClick={() => { setShowCreate(false); resetForm(); }}
              className="text-xs text-slate-500 hover:underline"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {msg && (
        <pre
          className={
            'whitespace-pre-wrap rounded-md p-3 text-xs ' +
            (msg.kind === 'ok'
              ? 'bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-300'
              : 'bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300')
          }
        >
          {msg.text}
        </pre>
      )}

      {projects.length > 0 && (
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className={field + ' pl-8'}
            placeholder="Filter by name, description, or folder path…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : projects.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center">
          <Folder size={24} className="text-slate-400 mx-auto mb-2" />
          <p className="text-slate-500 text-sm">
            No project registered yet. Click <strong>New project</strong> to add one.
          </p>
        </div>
      ) : filteredFlat ? (
        filteredFlat.length === 0 ? (
          <p className="text-slate-400 text-sm italic">No project matches "{filter}".</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredFlat.map((p) => (
              <ProjectCard
                key={p.id}
                p={p}
                busyId={busyId}
                stop={stop}
                onOpen={() => router.push(`/settings/projects/${p.id}`)}
                onSync={() => void sync(p.id)}
                onMove={() => setMoveTarget(p)}
                onDelete={() => void remove(p.id, p.name)}
              />
            ))}
          </div>
        )
      ) : (
        <div className="space-y-4">
          {grouped!.map(({ parent, projects: ps }) => {
            // Collapsed state key = the full parent path so the
            // map keeps working across renames (parent === '/'
            // for root-level projects).
            const isCollapsed = collapsedL1.has(parent);
            return (
              <section key={parent} className="rounded-md border border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    const next = new Set(collapsedL1);
                    if (isCollapsed) next.delete(parent); else next.add(parent);
                    persistCollapsed(next);
                  }}
                  className="w-full flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-slate-900/40 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md"
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <Folder size={14} className="text-slate-400" />
                    <span className="font-mono">{parent === '/' ? '/ (root)' : parent}</span>
                    <span className="text-xs text-slate-500">
                      ({ps.length} project{ps.length > 1 ? 's' : ''})
                    </span>
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="p-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {ps.map((p) => (
                        <ProjectCard
                          key={p.id}
                          p={p}
                          busyId={busyId}
                          stop={stop}
                          onOpen={() => router.push(`/settings/projects/${p.id}`)}
                          onSync={() => void sync(p.id)}
                          onMove={() => setMoveTarget(p)}
                          onDelete={() => void remove(p.id, p.name)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {moveTarget && (
        <MoveProjectDialog
          project={moveTarget}
          allFolders={allFolders}
          onCancel={() => setMoveTarget(null)}
          onMove={(folderId) => void moveProject(moveTarget.id, folderId)}
        />
      )}
    </div>
  );

  // ---- inline helpers (closures over state) ----
  function ProjectCard({
    p, busyId, stop, onOpen, onSync, onMove, onDelete,
  }: {
    p: P;
    busyId: string | null;
    stop: (e: React.MouseEvent) => void;
    onOpen: () => void;
    onSync: () => void;
    onMove: () => void;
    onDelete: () => void;
  }) {
    const isSandbox = !p.gitUrl;
    const accent = isSandbox
      ? 'text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800'
      : 'text-teal-600 dark:text-teal-400 bg-teal-50 dark:bg-teal-950/30';
    const path = folderPathOf(p);
    return (
      <div
        onClick={onOpen}
        className="group relative flex gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 cursor-pointer hover:border-brand-400 hover:shadow-sm transition"
        title="Click to open project settings"
      >
        <div className={'shrink-0 w-10 h-10 rounded-md flex items-center justify-center ' + accent}>
          {isSandbox ? <FolderOpen size={18} /> : <GitBranch size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium truncate">{p.name}</h3>
            {isSandbox && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 shrink-0">sandbox</span>
            )}
            {p.lastSyncStatus === 'success' && (
              <span className="text-green-600 dark:text-green-400 text-xs shrink-0" title="Last sync: success">●</span>
            )}
            {p.lastSyncStatus === 'failed' && (
              <span className="text-red-500 text-xs shrink-0" title={p.lastSyncError ?? 'Last sync failed'}>●</span>
            )}
          </div>
          <div className="text-[10px] text-slate-400 font-mono mt-0.5 truncate" title={p.fsPath ?? p.name}>
            {path}
          </div>
          <p
            className={
              'text-xs mt-0.5 line-clamp-2 ' +
              (p.description ? 'text-slate-600 dark:text-slate-400' : 'text-slate-400 italic')
            }
            title={p.description ?? ''}
          >
            {p.description || 'No description'}
          </p>
          {p.gitUrl && (
            <div className="flex items-center gap-2 mt-2 text-[11px] text-slate-500">
              <span className="inline-flex items-center gap-1 font-mono">
                <GitBranch size={11} /> {p.branch}
              </span>
              {p.lastSyncAt && (
                <span className="text-slate-400" title={new Date(p.lastSyncAt).toLocaleString('fr-FR')}>
                  · synced {relativeTime(p.lastSyncAt)}
                </span>
              )}
            </div>
          )}
        </div>
        <div
          className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition"
          onClick={stop}
        >
          <button
            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            disabled={busyId === p.id || !p.gitUrl}
            onClick={(e) => { e.stopPropagation(); onSync(); }}
            title={p.gitUrl ? 'Sync (git pull)' : 'Sandbox — no remote'}
          >
            <RefreshCw size={12} className={busyId === p.id ? 'animate-spin' : ''} />
          </button>
          <button
            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={(e) => { e.stopPropagation(); onMove(); }}
            title="Move to another folder"
          >
            <Move size={12} />
          </button>
          <button
            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete project"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    );
  }
}

/* -------------------------------------------------------------- */
/*  Folder management panel                                       */
/* -------------------------------------------------------------- */

/**
 * Best-effort stringifier for `{ error }` payloads returned by
 * /api/folders. Most routes now return a string (#5 helpers); this
 * keeps a graceful fallback for legacy zod `.format()` objects so
 * the user never sees a bare "HTTP 400".
 */
function humanizeApiError(j: unknown, status: number): string {
  if (j && typeof j === 'object' && 'error' in j) {
    const e = (j as { error: unknown }).error;
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') {
      try {
        const flat = JSON.stringify(e);
        if (flat && flat !== '{}') return flat;
      } catch { /* ignore */ }
    }
  }
  return `HTTP ${status}`;
}

function FoldersPanel({
  tree,
  onChanged,
  setMsg,
}: {
  tree: FolderNode[];
  onChanged: () => void | Promise<void>;
  setMsg: (m: { kind: 'ok' | 'err'; text: string } | null) => void;
}) {
  // Single "create" input bound to the currently-selected parent
  // (null = root). Reusing one input + one parent state across
  // depth-N keeps the panel compact and avoids the per-level
  // input proliferation the old L1/L2 panel had.
  const [newName, setNewName] = useState('');
  const [newParentId, setNewParentId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    const r = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parentId: newParentId }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      setMsg({ kind: 'ok', text: `Created folder "${name}".` });
      setNewName('');
      await onChanged();
    } else {
      setMsg({ kind: 'err', text: `Create failed: ${humanizeApiError(j, r.status)}` });
    }
  };

  const rename = async (id: string) => {
    const name = renameValue.trim();
    if (!name) { setRenamingId(null); return; }
    const r = await fetch(`/api/folders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      setMsg({
        kind: 'ok',
        text: `Renamed folder. ${j.rewired ? `Rewired ${j.rewired} project path(s).` : ''}`,
      });
      setRenamingId(null);
      await onChanged();
    } else {
      setMsg({
        kind: 'err',
        text:
          `Rename failed: ${j.error ?? `HTTP ${r.status}`}` +
          (j.detail ? ` (${j.detail})` : '') +
          (j.error === 'busy' ? '\n\nA TaskRun is active under this folder. Wait, then retry.' : ''),
      });
    }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete folder "${name}"?\n\nThe folder must be empty (the API will refuse otherwise).`)) return;
    const r = await fetch(`/api/folders/${id}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      setMsg({ kind: 'ok', text: `Deleted folder "${name}".` });
      await onChanged();
    } else {
      setMsg({
        kind: 'err',
        text:
          `Delete failed: ${j.error ?? `HTTP ${r.status}`}` +
          (j.detail ? ` (${j.detail})` : '') +
          (j.error === 'not_empty' ? '\n\nMove or delete its contents first.' : ''),
      });
    }
  };

  // Build a flat "all folders" list for the parent <select>. Same
  // walk as `allFolders` above but local to the panel (parent
  // doesn't pass it down to keep the prop surface small).
  const flatFolders = useMemo(() => {
    const out: { id: string; path: string }[] = [];
    const walk = (nodes: FolderNode[], prefix: string) => {
      for (const n of nodes) {
        const path = prefix ? `${prefix}/${n.name}` : n.name;
        out.push({ id: n.id, path });
        if (n.children && n.children.length > 0) walk(n.children, path);
      }
    };
    walk(tree, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }, [tree]);

  const inputCls =
    'rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs';
  const btnCls =
    'p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800';

  // Recursive renderer for one folder row + its descendants.
  // depth drives the left padding; no hard cap (MAX_FOLDER_DEPTH
  // is enforced server-side).
  const FolderRow = (props: { node: FolderNode; depth: number }) => {
    const { node, depth } = props;
    const indent = { paddingLeft: `${0.5 + depth * 1.25}rem` };
    return (
      <li className="border-b border-slate-100 dark:border-slate-800/40 last:border-b-0">
        <div className="flex items-center gap-2 py-1.5 pr-2 text-sm" style={indent}>
          <Folder size={depth === 0 ? 14 : 12} className="text-slate-400" />
          {renamingId === node.id ? (
            <>
              <input
                autoFocus
                className={inputCls + ' font-mono flex-1'}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void rename(node.id);
                  if (e.key === 'Escape') setRenamingId(null);
                }}
              />
              <button onClick={() => void rename(node.id)} className={btnCls} title="Save">
                <Check size={12} />
              </button>
              <button onClick={() => setRenamingId(null)} className={btnCls} title="Cancel">
                <X size={12} />
              </button>
            </>
          ) : (
            <>
              <span className="font-mono flex-1">{node.name}</span>
              <span className="text-[10px] text-slate-400">
                {node.projectCount} project(s)
                {node.children && node.children.length > 0
                  ? ` · ${node.children.length} subfolder(s)`
                  : ''}
              </span>
              <button
                onClick={() => { setNewParentId(node.id); setNewName(''); }}
                className={btnCls}
                title="Create subfolder here"
              >
                <FolderPlus size={12} />
              </button>
              <button
                onClick={() => { setRenamingId(node.id); setRenameValue(node.name); }}
                className={btnCls}
                title="Rename"
              >
                <Edit2 size={12} />
              </button>
              <button
                onClick={() => void remove(node.id, node.name)}
                className={btnCls + ' text-red-600'}
                title="Delete"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </div>
        {node.children && node.children.length > 0 && (
          <ul>
            {node.children.map((c) => (
              <FolderRow key={c.id} node={c} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/30 dark:bg-slate-900/20">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium flex items-center gap-2">
          <FolderTree size={14} /> Folder hierarchy
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <select
            className={inputCls}
            value={newParentId ?? ''}
            onChange={(e) => setNewParentId(e.target.value || null)}
            title="Parent folder for the new folder"
          >
            <option value="">/ (root)</option>
            {flatFolders.map((f) => (
              <option key={f.id} value={f.id}>{f.path}</option>
            ))}
          </select>
          <input
            className={inputCls + ' font-mono'}
            placeholder="new folder name"
            title="Allowed: letters, digits, . _ - (no spaces, no slashes, no accents)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          />
          <button onClick={() => void create()} className={btnCls} title="Create folder">
            <FolderPlus size={14} />
          </button>
        </div>
      </div>

      {tree.length === 0 ? (
        <p className="text-xs text-slate-500 italic">
          No folder yet. Use the input above to create your first one — nest as deep as you need.
        </p>
      ) : (
        <ul className="rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
          {tree.map((root) => (
            <FolderRow key={root.id} node={root} depth={0} />
          ))}
        </ul>
      )}
    </div>
  );
}

function MoveProjectDialog({
  project,
  allFolders,
  onCancel,
  onMove,
}: {
  project: P;
  allFolders: { id: string; path: string; count: number }[];
  onCancel: () => void;
  onMove: (folderId: string | null) => void;
}) {
  const currentFolderId = project.folderId;
  // Sentinel "__unselected__" lets the operator differentiate
  // "I haven't chosen yet" from "I want the root" (empty string).
  // root is now a legitimate destination (ADR-0022).
  const ROOT = '__root__';
  const NONE = '__unselected__';
  const [picked, setPicked] = useState<string>(NONE);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onCancel} />
      <div
        role="dialog"
        aria-modal
        className="fixed left-1/2 top-1/2 z-50 w-[min(420px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-4 space-y-3"
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <Move size={14} /> Move “{project.name}”
        </div>
        <div className="text-xs text-slate-500">
          Current path: <span className="font-mono">{project.fsPath ?? project.name}</span>
        </div>
        <label className="block">
          <span className="text-xs text-slate-500">Destination folder</span>
          <select
            autoFocus
            className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-sm"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
          >
            <option value={NONE}>— select a destination —</option>
            <option value={ROOT} disabled={currentFolderId === null}>
              / (root){currentFolderId === null ? '  (current)' : ''}
            </option>
            {allFolders.map((f) => (
              <option key={f.id} value={f.id} disabled={f.id === currentFolderId}>
                {f.path}{f.id === currentFolderId ? '  (current)' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[11px] text-slate-500">
          The project's working copy will be physically moved on disk. Refused if a TaskRun
          is currently running or pending on this project.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={
              picked === NONE ||
              (picked === ROOT ? currentFolderId === null : picked === currentFolderId)
            }
            onClick={() => onMove(picked === ROOT ? null : picked)}
            className="text-xs px-3 py-1.5 rounded border border-brand-500 bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50"
          >
            Move
          </button>
        </div>
      </div>
    </>
  );
}
