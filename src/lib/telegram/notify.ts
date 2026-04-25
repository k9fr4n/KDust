/**
 * Send a Telegram notification mirroring the Teams card semantics
 * (Franck 2026-04-25 18:14). Outbound HTTPS to api.telegram.org
 * only — KDust never needs to be exposed for this to work.
 *
 * Auth model:
 *   - Bot token  : env.KDUST_TELEGRAM_BOT_TOKEN (single bot per
 *                  KDust instance, held as a secret)
 *   - Recipient  : chat_id passed per call. Resolved upstream
 *                  from Task.telegramChatId → AppConfig.
 *                  defaultTelegramChatId.
 *
 * If either the bot token OR the chat_id is missing, the call is
 * a silent no-op — same UX as a Task with no teamsWebhook. A
 * non-OK Telegram response throws so the runner can log it; we
 * deliberately don't swallow because a misconfigured bot is the
 * most common failure mode and silent drops would hide it.
 *
 * Format: HTML (parse_mode="HTML"). Simpler than MarkdownV2 which
 * mandates escaping every `_*[]()~` etc. The fact list renders
 * as a small key:value table; details are wrapped in <pre> when
 * present (truncated to ~3500 chars to stay under the 4096-char
 * sendMessage limit headroom).
 */
export interface TelegramFact {
  name: string;
  value: string;
}

export interface TelegramReport {
  title: string;
  summary: string;
  status: 'success' | 'failed';
  details?: string;
  facts?: TelegramFact[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function postToTelegram(
  chatId: string,
  r: TelegramReport,
): Promise<void> {
  const token = process.env.KDUST_TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) {
    // Silent no-op: caller invoked us without a configured bot or
    // recipient. Symmetric with postToTeams when webhook=null.
    return;
  }

  const emoji = r.status === 'success' ? '✅' : '❌';
  const parts: string[] = [
    `${emoji} <b>${escapeHtml(r.title)}</b>`,
    escapeHtml(r.summary),
  ];
  if (r.facts?.length) {
    parts.push('');
    for (const f of r.facts) {
      parts.push(`• <b>${escapeHtml(f.name)}</b>: ${escapeHtml(f.value)}`);
    }
  }
  if (r.details) {
    // 3500-char cap leaves headroom for the title/facts under the
    // 4096-char sendMessage limit. Same threshold the Teams helper
    // uses for consistency.
    parts.push('');
    parts.push('<pre>' + escapeHtml(r.details.slice(0, 3500)) + '</pre>');
  }
  const text = parts.join('\n');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      // Disable link preview — KDust links to /run/[id] would
      // otherwise generate a noisy preview card every time.
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}
