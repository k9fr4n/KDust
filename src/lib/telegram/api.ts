/**
 * Thin typed wrappers around the Telegram Bot HTTP API
 * (Franck 2026-04-25 22:00).
 *
 * All calls are outbound to api.telegram.org over HTTPS — no
 * webhooks, no inbound port required on the KDust host. The bot
 * token is read from `KDUST_TELEGRAM_BOT_TOKEN` once on each
 * call (no caching) so a token rotation in the env is picked up
 * on the next poll without restarting the server.
 *
 * Error policy: the helpers throw on non-2xx so the poller can
 * decide whether to back-off or abort. Telegram-specific
 * descriptions (`description` field) are included in the thrown
 * error message.
 */

const API_ROOT = 'https://api.telegram.org';

function getToken(): string | null {
  const t = process.env.KDUST_TELEGRAM_BOT_TOKEN;
  return t && t.length > 0 ? t : null;
}

async function call<T>(
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const token = getToken();
  if (!token) throw new Error('KDUST_TELEGRAM_BOT_TOKEN is not set');
  const res = await fetch(`${API_ROOT}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json().catch(() => null)) as
    | { ok: boolean; result?: T; description?: string; error_code?: number }
    | null;
  if (!res.ok || !json?.ok) {
    const desc = json?.description ?? `HTTP ${res.status}`;
    const code = json?.error_code ?? res.status;
    const err = new Error(`Telegram ${method} failed: ${code} ${desc}`);
    (err as { code?: number }).code = code;
    throw err;
  }
  return json.result as T;
}

// ---- Types (only the fields KDust uses) ----
export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}
export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}
export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  // Other variants (callback_query, channel_post, ...) are
  // ignored by KDust today; we keep the type loose so future
  // additions don't fail to parse.
  [k: string]: unknown;
}

export async function getUpdates(
  offset: number,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<TgUpdate[]> {
  // allowed_updates is an explicit allowlist so we don't waste
  // bandwidth/parsing on update kinds we don't handle.
  return call<TgUpdate[]>(
    'getUpdates',
    { offset, timeout: timeoutSec, allowed_updates: ['message'] },
    signal,
  );
}

export async function sendMessage(
  chatId: string | number,
  text: string,
  opts?: { reply_to_message_id?: number; parse_mode?: 'HTML' | 'MarkdownV2' },
): Promise<TgMessage> {
  return call<TgMessage>('sendMessage', {
    chat_id: chatId,
    text: text.length > 4096 ? text.slice(0, 4090) + '\u2026' : text,
    parse_mode: opts?.parse_mode,
    reply_to_message_id: opts?.reply_to_message_id,
    disable_web_page_preview: true,
  });
}

export async function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  opts?: { parse_mode?: 'HTML' | 'MarkdownV2' },
): Promise<void> {
  await call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: text.length > 4096 ? text.slice(0, 4090) + '\u2026' : text,
    parse_mode: opts?.parse_mode,
    disable_web_page_preview: true,
  });
}

export async function sendChatAction(
  chatId: string | number,
  action: 'typing' | 'upload_document',
): Promise<void> {
  await call('sendChatAction', { chat_id: chatId, action });
}

export async function getMe(): Promise<TgUser> {
  return call<TgUser>('getMe', {});
}

export function isTelegramConfigured(): boolean {
  return getToken() !== null;
}
