'use client';
/**
 * /settings/agents — dedicated page to browse and create Dust agents
 * from KDust (Franck 2026-04-19 19:32).
 *
 * Previously the create-agent form lived inline on the per-project
 * settings page, which made the latter too busy. Split responsibilities:
 *   - /settings/projects/[id]       pick an existing agent as project default
 *   - /settings/agents (this file)  browse + create agents globally
 *
 * Creation still calls Dust SDK createGenericAgentConfiguration via
 * POST /api/agents; visibility is enforced by the Ecritel tenant.
 * The page refreshes the list after a successful create so the new
 * agent shows up immediately.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Bot, Plus, RefreshCw, ExternalLink } from 'lucide-react';

type Agent = {
  sId: string;
  name: string;
  description?: string | null;
  pictureUrl?: string | null;
};

export default function AgentsSettingsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [c, setC] = useState({ name: '', description: '', instructions: '', emoji: '' });
  const [creating, setCreating] = useState(false);
  const [lastCreatedSId, setLastCreatedSId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/agents', { cache: 'no-store' });
      if (r.status === 401) {
        setErr('Not connected to Dust — reconnect in /settings.');
        setAgents([]);
        return;
      }
      const j = await r.json();
      setAgents(j.agents ?? []);
      setErr(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void refresh(); }, []);

  const createAgent = async () => {
    setCreating(true);
    setErr(null);
    try {
      const body: Record<string, string> = {
        name: c.name.trim(),
        description: c.description.trim(),
        instructions: c.instructions.trim(),
      };
      if (c.emoji.trim()) body.emoji = c.emoji.trim();
      const r = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) {
        const detail = typeof j.error === 'string' ? j.error : JSON.stringify(j.error);
        throw new Error(detail);
      }
      setLastCreatedSId(j.agent.sId);
      setShowCreate(false);
      setC({ name: '', description: '', instructions: '', emoji: '' });
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setCreating(false);
    }
  };

  const input = 'w-full text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950';
  const filtered = agents.filter((a) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q);
  });

  return (
    <div className="space-y-6">
      <div className="text-sm">
        <Link href="/settings" className="text-slate-500 hover:text-brand-600 inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Settings
        </Link>
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Bot size={20} /> Agents
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 text-sm"
            title="Refresh list"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 text-sm"
          >
            <Plus size={14} /> {showCreate ? 'Cancel' : 'New agent'}
          </button>
        </div>
      </div>

      {err && (
        <pre className="whitespace-pre-wrap text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded p-2">
          {err}
        </pre>
      )}

      {showCreate && (
        <section className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-3">
          <h2 className="text-sm font-medium">Create a new Dust agent</h2>
          <p className="text-[11px] text-slate-500">
            Visibility is set by the Ecritel tenant policy — the agent is
            created in your Dust workspace and scoped automatically.
          </p>
          <div className="grid md:grid-cols-[2fr_80px_3fr] gap-2">
            <label className="block">
              <span className="text-slate-500 text-xs">Name *</span>
              <input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} className={input} placeholder="kdust-code-reviewer" maxLength={64} />
            </label>
            <label className="block">
              <span className="text-slate-500 text-xs">Emoji</span>
              <input value={c.emoji} onChange={(e) => setC({ ...c, emoji: e.target.value })} className={input} placeholder="e.g. robot" maxLength={10} />
            </label>
            <label className="block">
              <span className="text-slate-500 text-xs">Description * (max 256)</span>
              <input value={c.description} onChange={(e) => setC({ ...c, description: e.target.value })} className={input} placeholder="One-line summary" maxLength={256} />
            </label>
          </div>
          <label className="block">
            <span className="text-slate-500 text-xs">Instructions * (max 8000)</span>
            <textarea
              value={c.instructions}
              onChange={(e) => setC({ ...c, instructions: e.target.value })}
              className={input + ' min-h-[140px] font-mono text-xs'}
              placeholder="You are an expert in..."
              maxLength={8000}
            />
            <div className="text-[10px] text-slate-400 text-right">{c.instructions.length}/8000</div>
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={createAgent}
              disabled={creating || !c.name.trim() || !c.description.trim() || !c.instructions.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 disabled:opacity-50 text-sm"
            >
              {creating ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
              {creating ? 'Creating...' : 'Create agent'}
            </button>
          </div>
        </section>
      )}

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by name or description..."
        className={input}
      />

      <section className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 w-10"></th>
              <th className="text-left px-3 py-2">Name</th>
              <th className="text-left px-3 py-2">Description</th>
              <th className="text-left px-3 py-2 w-40 font-mono normal-case tracking-normal">sId</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="px-3 py-4 text-slate-400 text-center">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-4 text-slate-400 text-center">No agent matches the filter.</td></tr>
            ) : filtered.map((a) => (
              <tr key={a.sId} className={'border-t border-slate-200 dark:border-slate-800 ' + (a.sId === lastCreatedSId ? 'bg-green-50/40 dark:bg-green-950/20' : '')}>
                <td className="px-3 py-2">
                  {a.pictureUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.pictureUrl} alt="" className="w-6 h-6 rounded-full" />
                  ) : (
                    <div className="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-800 flex items-center justify-center">
                      <Bot size={14} className="text-slate-500" />
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 font-medium">{a.name}</td>
                <td className="px-3 py-2 text-slate-600 dark:text-slate-400 text-xs">{a.description ?? ''}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{a.sId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="text-[11px] text-slate-500">
        Agents are managed in your Dust workspace. Edit / delete them from the
        Dust UI — KDust only creates and lists them.{' '}
        <a
          href="https://dust.tt"
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-600 hover:underline inline-flex items-center gap-1"
        >
          Open Dust <ExternalLink size={11} />
        </a>
      </p>
    </div>
  );
}
