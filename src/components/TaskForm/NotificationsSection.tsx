'use client';
import type { SectionProps } from './state';
import { field, sectionCls, legendCls } from './styles';

/**
 * Per-task Teams + Telegram overrides + per-transport enable
 * toggles. Empty values inherit the global config from
 * AppConfig (App Settings).
 */
export function NotificationsSection({ form, setForm }: SectionProps) {
  return (
      <fieldset className={sectionCls}>
        <legend className={legendCls}>Notifications</legend>
        {/*
          Per-transport enable toggles (Franck 2026-04-25 18:50).
          Independent of the chat_id / webhook resolution: a user
          can keep the per-task override stored while temporarily
          silencing notifications for that transport.
        */}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.teamsNotifyEnabled}
            onChange={(e) =>
              setForm({ ...form, teamsNotifyEnabled: e.target.checked })
            }
          />
          <span>Send Teams notifications for this task</span>
        </label>
        <label className="block">
          <span className="text-sm">Teams webhook (override, otherwise global)</span>
          <input
            className={field}
            type="url"
            value={form.teamsWebhook}
            onChange={(e) => setForm({ ...form, teamsWebhook: e.target.value })}
            placeholder="https://..."
            disabled={!form.teamsNotifyEnabled}
          />
          <span className="text-xs text-slate-500">
            Empty → inherit the global webhook configured in{' '}
            <a href="/settings/global" className="underline">
              App Settings
            </a>
            . Set here to redirect notifications of this specific task
            to a different channel.
          </span>
        </label>
        {/*
          Telegram chat_id override (Franck 2026-04-25 18:14).
          Mirrors the Teams field: empty -> inherit global default,
          set -> per-task override. Bot token is held in
          env.KDUST_TELEGRAM_BOT_TOKEN (deployment-level secret),
          NOT exposed in the UI.
        */}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.telegramNotifyEnabled}
            onChange={(e) =>
              setForm({ ...form, telegramNotifyEnabled: e.target.checked })
            }
          />
          <span>Send Telegram notifications for this task</span>
        </label>
        <label className="block">
          <span className="text-sm">Telegram chat_id (override, otherwise global)</span>
          <input
            className={field}
            type="text"
            inputMode="text"
            value={form.telegramChatId}
            onChange={(e) => setForm({ ...form, telegramChatId: e.target.value })}
            placeholder="123456789  /  -1001234567890 (group)"
            disabled={!form.telegramNotifyEnabled}
          />
          <span className="text-xs text-slate-500">
            Empty → inherit the global chat_id configured in{' '}
            <a href="/settings/global" className="underline">App Settings</a>.
            Bot token is set via the <code>KDUST_TELEGRAM_BOT_TOKEN</code>{' '}
            env var. Notifications are no-ops if either the token or
            the chat_id is missing.
          </span>
        </label>
      </fieldset>
  );
}
