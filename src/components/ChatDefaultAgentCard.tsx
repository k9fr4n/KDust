'use client';

/**
 * Global web-chat default agent picker (Franck 2026-06-02).
 *
 * Lives on /settings/projects because it answers the question
 * "which agent do I get in /chat when I am NOT inside a project?".
 * It writes AppConfig.chatDefaultAgentSId via PATCH /api/settings.
 *
 * Resolution order applied by the chat composer
 * (src/app/chat/_ChatClient.tsx):
 *
 *   open conversation  >  manual pick  >  Project.defaultAgentSId
 *     >  THIS (global chat default)  >  list[0] (alphabetical first)
 *
 * So a project with its own default agent keeps it; this only
 * governs root / folder scope. null = legacy list[0] behaviour.
 *
 * Self-contained: fetches the live agents list (/api/agents) and the
 * current config (/api/settings). A 401 on /api/agents degrades to a
 * warning + empty list so the rest of the projects page stays usable
 * when the Dust session has expired.
 */
import { useEffect, useState } from 'react';
import { Bot, RefreshCw, Save, X } from 'lucide-react';
import { errMessage } from '@/lib/errors';

type Agent = {
  sId: string;
  name: string;
  description?: string | null;
  pictureUrl?: string | null;
};

export function ChatDefaultAgentCard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<string | null>(null);
  const [pickValue, setPickValue] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [cfgRes, agentsRes] = await Promise.all([
        fetch('/api/settings', { cache: 'no-store' }),
        fetch('/api/agents', { cache: 'no-store' }),
      ]);
      const cfg = await cfgRes.json();
      const current: string = cfg?.config?.chatDefaultAgentSId ?? '';
      setSaved(current || null);
      setPickValue(current);
      if (agentsRes.status === 401) {
        setAgents([]);
        setWarn('Not connected to Dust — reconnect in /settings to pick an agent.');
        return;
      }
      const j = await agentsRes.json();
      setAgents(j.agents ?? []);
      setWarn(null);
    } catch (e: unknown) {
      setErr(errMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void refresh(); }, []);

  const current = agents.find((a) => a.sId === saved) ?? null;

  const persist = async (sId: string | null) => {
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatDefaultAgentSId: sId }),
      });
      if (!r.ok) throw new Error(await r.text());
      setSaved(sId);
      setPickValue(sId ?? '');
    } catch (e: unknown) {
      setErr(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const input =
    'w-full text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950';

  return (
    <section className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-4 bg-slate-50/30 dark:bg-slate-900/20">
      <div className="flex items-center gap-2">
        <Bot size={14} className="text-slate-400" />
        <h2 className="text-xs uppercase tracking-wide text-slate-500">
          Default chat agent (no project)
        </h2>
      </div>
      <p className="text-xs text-slate-500">
        Used by <code className="font-mono">/chat</code> when no project is
        active and you have not picked an agent. A project with its own default
        agent still wins inside that project. Unset = first agent of the list.
      </p>

      {/* Current selection chip */}
      <div className="text-sm">
        {loading ? (
          <span className="text-slate-400">Loading…</span>
        ) : current ? (
          <span className="inline-flex items-center gap-2 px-2 py-1 rounded bg-brand-50 dark:bg-brand-950/30 border border-brand-300 dark:border-brand-800">
            {current.pictureUrl && (
              <img src={current.pictureUrl} alt="" className="w-4 h-4 rounded-full" />
            )}
            <span className="font-medium">{current.name}</span>
            <span className="text-xs text-slate-500 font-mono">{current.sId}</span>
          </span>
        ) : saved ? (
          <span className="text-amber-600 dark:text-amber-400 text-xs">
            Saved sId <span className="font-mono">{saved}</span> no longer
            matches a live agent — chat falls back to the first agent.
          </span>
        ) : (
          <span className="text-slate-400">No global default — chat uses the first agent.</span>
        )}
      </div>

      {/* Pick flow */}
      <div className="flex flex-col md:flex-row md:items-end gap-2">
        <label className="flex-1">
          <span className="text-slate-500 text-xs">Pick an existing agent</span>
          <select
            value={pickValue}
            onChange={(e) => setPickValue(e.target.value)}
            className={input}
            disabled={loading || agents.length === 0}
          >
            <option value="">— none —</option>
            {agents.map((a) => (
              <option key={a.sId} value={a.sId}>
                {a.name}{a.description ? ` — ${a.description.slice(0, 80)}` : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => void persist(pickValue || null)}
          disabled={saving || pickValue === (saved ?? '')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-brand-500 text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-950/30 hover:bg-brand-100 disabled:opacity-50 text-sm h-[34px]"
        >
          {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
          Set as default
        </button>
        {saved && (
          <button
            onClick={() => void persist(null)}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 text-sm h-[34px]"
            title="Clear global chat default"
          >
            <X size={14} /> Clear
          </button>
        )}
      </div>

      {warn && <p className="text-xs text-amber-600 dark:text-amber-400">{warn}</p>}
      {err && <p className="text-xs text-danger-strong dark:text-red-400">{err}</p>}
    </section>
  );
}
