'use client';
/**
 * /settings/agents — browse + create Dust agents (card layout).
 *
 * Rewritten 2026-04-19 20:23 (Franck):
 *   - card grid aligned with /settings and /settings/projects
 *   - split into two sections:
 *       · My agents     → scope in {private, workspace, published}
 *                        (created in this tenant: by me or by a
 *                        colleague)
 *       · Default agents→ scope = "global" (Dust-provided, shared
 *                        across all tenants)
 *     Unknown/missing scope falls into "My agents" as a safe
 *     default so nothing disappears silently if the API shape
 *     changes.
 *   - search field filters both sections at once
 *   - create form unchanged behaviour; cosmetic tweaks only
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Bot, Plus, RefreshCw, Search, X,
  Sparkles, Star, ExternalLink,
} from 'lucide-react';

type Agent = {
  sId: string;
  name: string;
  description?: string | null;
  pictureUrl?: string | null;
  scope?: string;
  userFavorite?: boolean;
};

/**
 * Agent avatar with silent 404 fallback (Franck 2026-04-19 20:35).
 *
 * The Dust SDK exposes `pictureUrl` for every agent. Many of those
 * URLs point to the workspace CDN with an auth-gated path \u2014 an
 * anonymous <img> load from our domain gets a 404. Instead of
 * leaving a broken image, we swap to a tinted Bot tile whenever
 * the fetch fails. Key on sId so switching agents resets the
 * error state.
 */
function AgentAvatar({ agent, isDefault }: { agent: Agent; isDefault: boolean }) {
  const [broken, setBroken] = useState(false);
  const fallbackTile = (
    <div
      className={
        'w-10 h-10 rounded-md flex items-center justify-center ' +
        (isDefault
          ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400'
          : 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400')
      }
    >
      <Bot size={18} />
    </div>
  );
  if (!agent.pictureUrl || broken) {
    return <div className="shrink-0">{fallbackTile}</div>;
  }
  return (
    <div className="shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={agent.sId}
        src={agent.pictureUrl}
        alt=""
        className="w-10 h-10 rounded-md object-cover bg-slate-100 dark:bg-slate-800"
        onError={() => setBroken(true)}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

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

  // Split + sort + filter, memoized. Sort alphabetically within
  // each bucket. Filter applies to name + description.
  const { mine, defaults } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (a: Agent) =>
      !q ||
      a.name.toLowerCase().includes(q) ||
      (a.description ?? '').toLowerCase().includes(q);
    const sorted = [...agents]
      .filter(match)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return {
      mine: sorted.filter((a) => a.scope !== 'global'),
      defaults: sorted.filter((a) => a.scope === 'global'),
    };
  }, [agents, filter]);

  const renderCard = (a: Agent) => {
    const isDefault = a.scope === 'global';
    const isJustCreated = a.sId === lastCreatedSId;
    return (
      <div
        key={a.sId}
        className={
          'relative flex gap-3 rounded-lg border bg-white dark:bg-slate-900 p-4 transition ' +
          (isJustCreated
            ? 'border-green-400 dark:border-green-600'
            : 'border-slate-200 dark:border-slate-800 hover:border-brand-400 hover:shadow-sm')
        }
      >
        {/* Avatar \u2014 uses AgentAvatar, which falls back to a Bot
            icon if the Dust picture URL 404s (common for custom
            workspace uploads that require an authenticated session). */}
        <AgentAvatar agent={a} isDefault={isDefault} />

        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium truncate">{a.name}</h3>
            {a.userFavorite && (
              <Star size={11} className="text-amber-500 fill-amber-500 shrink-0" aria-label="Favorite" />
            )}
            {isDefault && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 shrink-0 inline-flex items-center gap-1"
                title="Provided by Dust — available in every workspace"
              >
                <Sparkles size={9} /> default
              </span>
            )}
          </div>
          <p
            className={
              'text-xs mt-0.5 line-clamp-2 ' +
              (a.description
                ? 'text-slate-600 dark:text-slate-400'
                : 'text-slate-400 italic')
            }
            title={a.description ?? ''}
          >
            {a.description || 'No description'}
          </p>
          <code className="mt-1.5 block font-mono text-[10px] text-slate-400 truncate" title={a.sId}>
            {a.sId}
          </code>
        </div>
      </div>
    );
  };

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
            {showCreate ? <><X size={14} /> Cancel</> : <><Plus size={14} /> New agent</>}
          </button>
        </div>
      </div>

      {err && (
        <pre className="whitespace-pre-wrap text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded p-2">
          {err}
        </pre>
      )}

      {showCreate && (
        <section className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/30 dark:bg-slate-900/20">
          <h2 className="text-sm font-medium">Create a new Dust agent</h2>
          <p className="text-[11px] text-slate-500">
            Visibility is set by the Ecritel tenant policy — the agent
            is created in your Dust workspace and scoped automatically.
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

      {!loading && agents.length > 0 && (
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Search in ${agents.length} agent${agents.length > 1 ? 's' : ''}...`}
            className="w-full pl-8 pr-8 py-1.5 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              title="Clear filter"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-slate-400 text-sm">Loading...</p>
      ) : agents.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center">
          <Bot size={24} className="text-slate-400 mx-auto mb-2" />
          <p className="text-slate-500 text-sm">
            No agent yet. Click <strong>New agent</strong> to create your first one.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {/* My agents section */}
          <section>
            <div className="flex items-baseline justify-between mb-2">
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                My agents
                <span className="ml-2 text-xs font-normal text-slate-400">({mine.length})</span>
              </h2>
              <span className="text-[11px] text-slate-400">
                Created in your workspace
              </span>
            </div>
            {mine.length === 0 ? (
              <p className="text-[13px] text-slate-400 italic">
                {filter ? `No workspace agent matches "${filter}".` : 'No agent created in your workspace yet.'}
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {mine.map(renderCard)}
              </div>
            )}
          </section>

          {/* Default agents section */}
          <section>
            <div className="flex items-baseline justify-between mb-2">
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
                <Sparkles size={14} className="text-amber-500" />
                Default agents
                <span className="ml-1 text-xs font-normal text-slate-400">({defaults.length})</span>
              </h2>
              <span className="text-[11px] text-slate-400">
                Provided by Dust
              </span>
            </div>
            {defaults.length === 0 ? (
              <p className="text-[13px] text-slate-400 italic">
                {filter ? `No default agent matches "${filter}".` : 'No Dust-provided agent visible on this tenant.'}
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {defaults.map(renderCard)}
              </div>
            )}
          </section>
        </div>
      )}

      <p className="text-[11px] text-slate-500">
        Agents are managed in your Dust workspace. Edit / delete them from
        the Dust UI — KDust only creates and lists them.{' '}
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
