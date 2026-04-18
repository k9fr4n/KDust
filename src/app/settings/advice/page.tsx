'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Plus,
  Save,
  Trash2,
  Radio,
  Lock,
  Share2,
  Lightbulb,
  AlertTriangle,
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

/**
 * Admin page to manage advice category templates. Any edit here only
 * affects FUTURE project provisioning — existing per-project tasks
 * keep their values so user customisations aren't stomped. Use the
 * "Propager" button on a row to force-provision the template onto
 * projects that don't yet have it.
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
        schedule: d.schedule,
        enabled: d.enabled,
        sortOrder: d.sortOrder,
      }),
    });
    if (r.ok) {
      notify('ok', `"${d.label}" saved. (Only affects future projects.)`);
      await load();
    } else {
      const j = await r.json().catch(() => ({}));
      notify('err', typeof j.error === 'string' ? j.error : 'Save error');
    }
  };

  const remove = async (d: Def) => {
    if (d.builtIn) return;
    if (!confirm(`Delete category "${d.label}"?\n\nThis will also delete all associated tasks and advice on ALL projects.`)) return;
    const r = await fetch(`/api/advice/defaults/${d.id}`, { method: 'DELETE' });
    if (r.ok) {
      const j = await r.json();
      notify('ok', `Deleted: ${j.cascade.tasks} cron(s) + ${j.cascade.advices} advice(s).`);
      await load();
    } else {
      const j = await r.json().catch(() => ({}));
      notify('err', typeof j.error === 'string' ? j.error : 'Delete error');
    }
  };

  const propagate = async (d: Def) => {
    const r = await fetch(`/api/advice/defaults/${d.id}/propagate`, { method: 'POST' });
    if (r.ok) {
      const j = await r.json();
      notify('ok', `${j.created} new cron(s) created on existing projects.`);
    } else {
      notify('err', 'Propagation error.');
    }
  };

  const overwrite = async (d: Def) => {
    if (
      !confirm(
        `GLOBAL OVERWRITE for "${d.label}"?\n\n` +
          `This will rewrite the prompt, schedule and name of ALL tasks ` +
          `in this category on ALL projects, losing any local ` +
          `customisations. Missing tasks will also be created.\n\n` +
          `Useful to standardise or rebuild old prompts.`,
      )
    )
      return;
    const r = await fetch(`/api/advice/defaults/${d.id}/overwrite`, { method: 'POST' });
    if (r.ok) {
      const j = await r.json();
      notify(
        'ok',
        `${j.updated} cron(s) overwritten, ${j.created} cron(s) created.`,
      );
    } else {
      notify('err', 'Overwrite error.');
    }
  };

  const setField = (id: string, patch: Partial<Def>) =>
    setDefs((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Back-office
        </Link>
        <h1 className="text-2xl font-bold mt-2 flex items-center gap-2">
          <Lightbulb size={22} className="text-amber-500" /> Advice categories
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Templates for the weekly analysis tasks. Changes only affect{' '}
          <b>new</b> projects. Use <b>Propagate</b> to deploy a template to
          existing projects that don&apos;t have it yet.
        </p>
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
        <div className="space-y-4">
          {defs.map((d) => (
            <DefCard
              key={d.id}
              d={d}
              setField={setField}
              save={save}
              remove={remove}
              propagate={propagate}
              overwrite={overwrite}
            />
          ))}
        </div>
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
  propagate,
  overwrite,
}: {
  d: Def;
  setField: (id: string, patch: Partial<Def>) => void;
  save: (d: Def) => void;
  remove: (d: Def) => void;
  propagate: (d: Def) => void;
  overwrite: (d: Def) => void;
}) {
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-4 bg-white dark:bg-slate-900">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold flex items-center gap-2">
          <span className="text-lg">{d.emoji}</span>
          {d.label}
          <span className="text-[10px] font-mono text-slate-400">({d.key})</span>
          {d.builtIn && (
            <span
              title="Built-in category: cannot be deleted, only disabled"
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
          Enabled (provisioned for new projects)
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_80px_180px_80px] gap-2 mb-3">
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
          <span className="text-[10px] text-slate-500">Schedule (cron)</span>
          <input
            className={field + ' font-mono'}
            value={d.schedule}
            onChange={(e) => setField(d.id, { schedule: e.target.value })}
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

      <label className="block mb-3">
        <span className="text-[10px] text-slate-500">
          Prompt (body) — the JSON contract is appended automatically
        </span>
        <textarea
          className={field + ' font-mono min-h-[140px]'}
          value={d.prompt}
          onChange={(e) => setField(d.id, { prompt: e.target.value })}
        />
      </label>

      <div className="flex gap-2 flex-wrap">
        <Button onClick={() => save(d)}>
          <Save size={14} /> Save
        </Button>
        <button
          onClick={() => propagate(d)}
          className="px-3 py-2 rounded border border-slate-300 dark:border-slate-700 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1"
          title="Provisions this template onto existing projects that don't have it yet (non-destructive)"
        >
          <Share2 size={14} /> Propagate
        </button>
        <button
          onClick={() => overwrite(d)}
          className="px-3 py-2 rounded border border-amber-400 dark:border-amber-700 text-sm text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 inline-flex items-center gap-1"
          title="Overwrites the prompt/schedule of ALL project tasks in this category (destructive)"
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
    schedule: '0 4 * * 1',
    prompt:
      'You are a senior reviewer. Inspect the project via fs_cli MCP tools. Focus on the TOP-3 most impactful ...',
  });
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await fetch('/api/advice/defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    setBusy(false);
    if (r.ok) {
      const j = await r.json();
      notify('ok', `Created. ${j.provisioned} cron(s) provisioned on existing projects.`);
      setOpen(false);
      setForm({
        key: '',
        label: '',
        emoji: '📋',
        schedule: '0 4 * * 1',
        prompt: '',
      });
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
        <Radio size={16} className="text-amber-500" />
        <h3 className="font-semibold">New advice category</h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[120px_1fr_80px_160px] gap-2">
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
        <label>
          <span className="text-[10px] text-slate-500">Schedule (cron)</span>
          <input
            className={field + ' font-mono'}
            value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            required
          />
        </label>
      </div>
      <label className="block">
        <span className="text-[10px] text-slate-500">
          Prompt (body) — min 20 characters
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
          {busy ? 'Creating…' : 'Create + propagate'}
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
