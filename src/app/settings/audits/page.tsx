'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Plus,
  Save,
  Trash2,
  Lock,
  Lightbulb,
  AlertTriangle,
  Info,
  Archive,
} from 'lucide-react';
import { Button } from '@/components/Button';

type Def = {
  id: string;
  key: string;
  label: string;
  emoji: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  sortOrder: number;
  builtIn: boolean;
};

/** v1 legacy builtin slugs, demoted by the v3 one-shot migration. */
const LEGACY_KEYS = new Set([
  'security',
  'performance',
  'code_quality',
  'improvement',
  'documentation',
  'code_coverage',
]);

/**
 * Admin page to manage advice category templates.
 *
 * v3 model (2026-04-18): the default ships a SINGLE built-in
 * "priority" category that covers security, performance, code
 * quality, improvement, documentation and test coverage in ONE pass
 * and returns a global TOP-15 ranked list. The former 6 per-area
 * builtins are preserved in the DB (demoted to non-builtin, disabled)
 * so the user can review history and explicitly clean them up.
 *
 * Schedule field is NOT editable: KDust v2 removed the cron scheduler
 * so every task is manual-trigger. We keep the column in the schema
 * for back-compat but hide it from the UI.
 */
export default function AdviceSettingsPage() {
  const [defs, setDefs] = useState<Def[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    const r = await fetch('/api/advice/defaults');
    const j = await r.json();
    setDefs(j.defaults ?? []);
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, []);

  const notify = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 5000);
  };

  const save = async (d: Def) => {
    const r = await fetch(`/api/advice/defaults/${d.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: d.label,
        emoji: d.emoji,
        prompt: d.prompt,
        enabled: d.enabled,
        sortOrder: d.sortOrder,
      }),
    });
    if (r.ok) {
      notify(
        'ok',
        `"${d.label}" saved. Use “Overwrite everywhere” to also push this to existing projects.`,
      );
      await load();
    } else {
      const j = await r.json().catch(() => ({}));
      notify('err', typeof j.error === 'string' ? j.error : 'Save error');
    }
  };

  const remove = async (d: Def) => {
    if (d.builtIn) return;
    if (
      !confirm(
        `Delete category "${d.label}"?\n\n` +
          `This will also delete all advice tasks and past results for this category on EVERY project.`,
      )
    )
      return;
    const r = await fetch(`/api/advice/defaults/${d.id}`, { method: 'DELETE' });
    if (r.ok) {
      const j = await r.json();
      notify(
        'ok',
        `Deleted. Cascaded: ${j.cascade.tasks} task(s) + ${j.cascade.advices} advice row(s).`,
      );
      await load();
    } else {
      const j = await r.json().catch(() => ({}));
      notify('err', typeof j.error === 'string' ? j.error : 'Delete error');
    }
  };

  const overwrite = async (d: Def) => {
    if (
      !confirm(
        `GLOBAL OVERWRITE for "${d.label}"?\n\n` +
          `Rewrites prompt + label on ALL existing project tasks in this ` +
          `category (losing local customisations) and creates the task ` +
          `on projects that don't have it yet.`,
      )
    )
      return;
    const r = await fetch(`/api/advice/defaults/${d.id}/overwrite`, {
      method: 'POST',
    });
    if (r.ok) {
      const j = await r.json();
      notify(
        'ok',
        `${j.updated} task(s) overwritten, ${j.created} task(s) created.`,
      );
    } else {
      notify('err', 'Overwrite error.');
    }
  };

  const setField = (id: string, patch: Partial<Def>) =>
    setDefs((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  // Split active vs legacy demoted rows — legacy goes into a collapsed
  // "Archive" section so the settings page isn't cluttered by deprecated
  // per-area templates.
  const { active, legacy } = useMemo(() => {
    const active: Def[] = [];
    const legacy: Def[] = [];
    for (const d of defs) {
      if (LEGACY_KEYS.has(d.key) && !d.builtIn) legacy.push(d);
      else active.push(d);
    }
    return { active, legacy };
  }, [defs]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Settings
        </Link>
        <h1 className="text-2xl font-bold mt-2 flex items-center gap-2">
          <Lightbulb size={22} className="text-amber-500" /> Audit Categories
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Templates used to generate the per-project advice task. The
          default config ships a single <b>Priority advice</b> category
          that covers security, performance, code quality, improvement,
          documentation and test coverage in one pass and returns a
          TOP-15 ranked action list.
        </p>
      </div>

      {/* v3 info banner */}
      <div className="flex gap-2 items-start text-xs border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200 rounded-md p-3">
        <Info size={14} className="shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p>
            <b>Edits apply to FUTURE projects only.</b> To push a prompt
            change to projects that already have the task, use{' '}
            <b>Overwrite everywhere</b> (destructive — wipes local
            customisations).
          </p>
          <p>
            Advice tasks are <b>manual-trigger</b> (no scheduler in v2+). Run
            them from the project dashboard or via{' '}
            <code className="text-[11px]">POST /api/tasks/:id/run</code>.
          </p>
        </div>
      </div>

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

      <CreateForm onCreated={load} notify={notify} />

      {loading ? (
        <p>Loading…</p>
      ) : (
        <>
          <div className="space-y-4">
            {active.map((d) => (
              <DefCard
                key={d.id}
                d={d}
                setField={setField}
                save={save}
                remove={remove}
                overwrite={overwrite}
              />
            ))}
          </div>

          {legacy.length > 0 && (
            <LegacySection
              items={legacy}
              remove={remove}
              setField={setField}
              save={save}
              overwrite={overwrite}
            />
          )}
        </>
      )}
    </div>
  );
}

const field =
  'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm';

function DefCard({
  d,
  setField,
  save,
  remove,
  overwrite,
  compact = false,
}: {
  d: Def;
  setField: (id: string, patch: Partial<Def>) => void;
  save: (d: Def) => void;
  remove: (d: Def) => void;
  overwrite: (d: Def) => void;
  compact?: boolean;
}) {
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-4 bg-white dark:bg-slate-900">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="font-semibold flex items-center gap-2 flex-wrap">
          <span className="text-lg">{d.emoji}</span>
          {d.label}
          <span className="text-[10px] font-mono text-slate-400">
            ({d.key})
          </span>
          {d.builtIn && (
            <span
              title="Built-in: cannot be deleted, only disabled"
              className="text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 rounded px-1.5 py-0.5 inline-flex items-center gap-1"
            >
              <Lock size={9} /> built-in
            </span>
          )}
          {!d.enabled && (
            <span className="text-[10px] bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-300 rounded px-1.5 py-0.5">
              disabled
            </span>
          )}
        </h3>
        <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={d.enabled}
            onChange={(e) => setField(d.id, { enabled: e.target.checked })}
          />
          Enabled (auto-provisioned for new projects)
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_80px_80px] gap-2 mb-3">
        <label className="block">
          <span className="text-[10px] text-slate-500">Label</span>
          <input
            className={field}
            value={d.label}
            onChange={(e) => setField(d.id, { label: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="text-[10px] text-slate-500">Emoji</span>
          <input
            className={field}
            value={d.emoji}
            onChange={(e) => setField(d.id, { emoji: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="text-[10px] text-slate-500">Order</span>
          <input
            type="number"
            className={field}
            value={d.sortOrder}
            onChange={(e) =>
              setField(d.id, { sortOrder: Number(e.target.value) || 0 })
            }
          />
        </label>
      </div>

      {!compact && (
        <label className="block mb-3">
          <span className="text-[10px] text-slate-500">
            Prompt (body) — the JSON contract is appended automatically
          </span>
          <textarea
            className={field + ' font-mono min-h-[160px]'}
            value={d.prompt}
            onChange={(e) => setField(d.id, { prompt: e.target.value })}
          />
        </label>
      )}

      <div className="flex gap-2 flex-wrap">
        <Button onClick={() => save(d)}>
          <Save size={14} /> Save
        </Button>
        <button
          onClick={() => overwrite(d)}
          className="px-3 py-2 rounded border border-amber-400 dark:border-amber-700 text-sm text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 inline-flex items-center gap-1"
          title="Rewrite this prompt on every existing project task (destructive, creates missing tasks too)"
        >
          <AlertTriangle size={14} /> Overwrite everywhere
        </button>
        {!d.builtIn && (
          <button
            onClick={() => remove(d)}
            className="px-3 py-2 rounded border border-red-300 dark:border-red-700 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 inline-flex items-center gap-1 ml-auto"
          >
            <Trash2 size={14} /> Delete (cascade)
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Legacy v1 builtins (security, performance, …) demoted to
 * non-builtin by the v3 migration. Collapsed by default. User can
 * delete them individually, or bulk-delete with a single click.
 */
function LegacySection({
  items,
  remove,
  setField,
  save,
  overwrite,
}: {
  items: Def[];
  remove: (d: Def) => void;
  setField: (id: string, patch: Partial<Def>) => void;
  save: (d: Def) => void;
  overwrite: (d: Def) => void;
}) {
  const [open, setOpen] = useState(false);

  const bulkDelete = async () => {
    if (
      !confirm(
        `Delete ALL ${items.length} legacy v1 categor${items.length === 1 ? 'y' : 'ies'}?\n\n` +
          `This will also remove any leftover tasks and advice rows. Irreversible.`,
      )
    )
      return;
    for (const d of items) {
      await fetch(`/api/advice/defaults/${d.id}`, { method: 'DELETE' });
    }
    location.reload();
  };

  return (
    <section className="border border-slate-200 dark:border-slate-800 rounded-lg">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between p-3 text-sm hover:bg-slate-50 dark:hover:bg-slate-900"
      >
        <span className="inline-flex items-center gap-2 font-semibold text-slate-600 dark:text-slate-400">
          <Archive size={14} />
          Legacy v1 categories
          <span className="text-[10px] font-mono bg-slate-100 dark:bg-slate-800 rounded px-1.5 py-0.5">
            {items.length}
          </span>
        </span>
        <span className="text-xs text-slate-400">
          {open ? 'collapse' : 'expand'}
        </span>
      </button>
      {open && (
        <div className="border-t border-slate-200 dark:border-slate-800 p-3 space-y-3">
          <div className="flex items-start gap-2 text-xs text-slate-500">
            <Info size={12} className="shrink-0 mt-0.5" />
            <p>
              These per-area categories (security, performance, code
              quality, improvement, documentation, code coverage) were
              replaced by the single <b>Priority advice</b> task in v3.
              Their tasks and past results have been cleaned up; only
              the template stubs remain so you can review the old
              prompts. Safe to delete.
            </p>
          </div>
          <div className="flex">
            <button
              onClick={bulkDelete}
              className="ml-auto px-3 py-1.5 rounded border border-red-300 dark:border-red-700 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 inline-flex items-center gap-1"
            >
              <Trash2 size={12} /> Delete all {items.length} legacy stub(s)
            </button>
          </div>
          {items.map((d) => (
            <DefCard
              key={d.id}
              d={d}
              setField={setField}
              save={save}
              remove={remove}
              overwrite={overwrite}
              compact
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CreateForm({
  onCreated,
  notify,
}: {
  onCreated: () => void;
  notify: (kind: 'ok' | 'err', text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    key: '',
    label: '',
    emoji: '📋',
    prompt:
      'You are a senior reviewer. Inspect the project via fs_cli MCP tools. Focus on …',
  });
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await fetch('/api/advice/defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // schedule defaults to 'manual' server-side (see route validator).
      body: JSON.stringify(form),
    });
    setBusy(false);
    if (r.ok) {
      const j = await r.json();
      notify(
        'ok',
        `Created. ${j.provisioned} task(s) provisioned on existing projects.`,
      );
      setOpen(false);
      setForm({ key: '', label: '', emoji: '📋', prompt: '' });
      onCreated();
    } else {
      const j = await r.json().catch(() => ({}));
      notify(
        'err',
        typeof j.error === 'string' ? j.error : JSON.stringify(j.error ?? {}),
      );
    }
  };

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Plus size={14} /> New category
      </Button>
    );
  }
  return (
    <form
      onSubmit={submit}
      className="border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-lg p-4 space-y-3"
    >
      <div className="flex items-center gap-2">
        <Plus size={16} className="text-amber-500" />
        <h3 className="font-semibold">New advice category</h3>
        <span className="text-[10px] text-slate-500">
          Creates a second advice task per project, run manually on demand.
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[160px_1fr_80px] gap-2">
        <label>
          <span className="text-[10px] text-slate-500">Slug (key)</span>
          <input
            className={field + ' font-mono'}
            placeholder="accessibility"
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value })}
            required
          />
        </label>
        <label>
          <span className="text-[10px] text-slate-500">Label</span>
          <input
            className={field}
            placeholder="Accessibility"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            required
          />
        </label>
        <label>
          <span className="text-[10px] text-slate-500">Emoji</span>
          <input
            className={field}
            value={form.emoji}
            onChange={(e) => setForm({ ...form, emoji: e.target.value })}
          />
        </label>
      </div>
      <label className="block">
        <span className="text-[10px] text-slate-500">
          Prompt (body) — min 20 characters. The JSON contract is
          appended automatically at run time.
        </span>
        <textarea
          className={field + ' font-mono min-h-[120px]'}
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          required
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create + provision'}
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-3 py-2 rounded border border-slate-300 dark:border-slate-700 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
