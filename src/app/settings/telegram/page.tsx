'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, MessageCircle } from 'lucide-react';
import { Button } from '@/components/Button';
import type { AppConfig } from '@prisma/client';

/**
 * Telegram chat bridge settings (Franck 2026-04-25 22:00).
 *
 * Lets the operator toggle the long-poll loop, set the chat_id
 * whitelist, and pick a default agent. The bot token itself
 * lives in env.KDUST_TELEGRAM_BOT_TOKEN — it is intentionally
 * not exposed via the API or this page (a credential should
 * never round-trip through React state).
 */
export default function TelegramSettingsPage() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [agents, setAgents] = useState<Array<{ sId: string; name: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json() as Promise<{ config: AppConfig }>)
      .then((j) => setCfg(j.config));
    void fetch('/api/agents')
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((j) => setAgents(j.agents ?? []));
  }, []);

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    setMsg(null);
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegramChatEnabled: !!cfg.telegramChatEnabled,
        telegramAllowedChatIds: cfg.telegramAllowedChatIds || null,
        telegramDefaultAgentSId: cfg.telegramDefaultAgentSId || null,
      }),
    });
    setSaving(false);
    setMsg(res.ok ? 'Saved.' : 'Save error.');
  };

  const field =
    'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2';

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Settings
        </Link>
        <h1 className="text-2xl font-bold mt-2 flex items-center gap-2">
          <MessageCircle size={22} className="text-sky-500" /> Telegram chat bridge
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Chat with your Dust agents through a Telegram bot — fully
          outbound (long-polling), no inbound port required on the
          KDust host.
        </p>
      </div>

      {!cfg ? (
        <p className="text-slate-500">Loading…</p>
      ) : (
        <>
          <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs text-amber-800 dark:text-amber-200">
            <p className="font-semibold mb-1">Pre-flight</p>
            <ol className="list-decimal pl-4 space-y-1">
              <li>
                Create a bot via{' '}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  @BotFather
                </a>{' '}
                and put its token in <code>KDUST_TELEGRAM_BOT_TOKEN</code> (env).
              </li>
              <li>
                Open the bot on Telegram, send <code>/start</code>, then run{' '}
                <code>/whoami</code> there once enabled — KDust will reply
                with your chat_id.
              </li>
              <li>
                Add that chat_id to the whitelist below and save. The
                long-poll loop starts immediately; no restart needed.
              </li>
            </ol>
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!cfg.telegramChatEnabled}
              onChange={(e) =>
                setCfg({ ...cfg, telegramChatEnabled: e.target.checked })
              }
            />
            <span className="text-sm font-medium">Enable Telegram chat bridge</span>
          </label>

          <label className="block">
            <span className="text-sm">Allowed chat IDs (comma-separated)</span>
            <input
              className={field}
              type="text"
              placeholder="123456789,-1001234567890"
              value={cfg.telegramAllowedChatIds ?? ''}
              onChange={(e) =>
                setCfg({ ...cfg, telegramAllowedChatIds: e.target.value })
              }
            />
            <span className="text-xs text-slate-500">
              Empty = nobody can talk to the bot (fail-closed). KDust
              is mono-user; this is normally a single id.
            </span>
          </label>

          <label className="block">
            <span className="text-sm">Default agent</span>
            <select
              className={field}
              value={cfg.telegramDefaultAgentSId ?? ''}
              onChange={(e) =>
                setCfg({ ...cfg, telegramDefaultAgentSId: e.target.value || null })
              }
            >
              <option value="">— none (user must run /agent first)</option>
              {agents.map((a) => (
                <option key={a.sId} value={a.sId}>
                  {a.name} ({a.sId})
                </option>
              ))}
            </select>
            <span className="text-xs text-slate-500">
              Used for new conversations from Telegram. The user can
              switch agents at any time with <code>/agent &lt;sId&gt;</code>.
            </span>
          </label>

          <div className="flex items-center gap-4 pt-2">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {msg && <span className="text-sm text-slate-500">{msg}</span>}
          </div>
        </>
      )}
    </div>
  );
}
