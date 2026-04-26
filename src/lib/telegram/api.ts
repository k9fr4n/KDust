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
    | {
        ok: boolean;
        result?: T;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number; migrate_to_chat_id?: number };
      }
    | null;
  if (!res.ok || !json?.ok) {
    const desc = json?.description ?? `HTTP ${res.status}`;
    const code = json?.error_code ?? res.status;
    const err = new Error(`Telegram ${method} failed: ${code} ${desc}`);
    (err as { code?: number }).code = code;
    // Telegram surfaces rate-limit hints via parameters.retry_after
    // (seconds). We expose it on the error so callers can sleep
    // the suggested duration before retrying instead of guessing.
    if (typeof json?.parameters?.retry_after === 'number') {
      (err as { retryAfter?: number }).retryAfter =
        json.parameters.retry_after;
    }
    throw err;
  }
  return json.result as T;
}

// ----- global flood-ban cooldown -----
// When Telegram returns 429 with a retry_after of more than a
// few seconds, the bot has been temporarily flood-banned. Any
// further sendMessage during the cooldown counts towards the
// ban duration AND fails wastefully. We track the cooldown end
// here and short-circuit ALL outbound calls until it expires.
//
// Process-local: a restart resets it, which is fine because
// Telegram still enforces the ban on its side regardless of
// what we remember locally \u2014 we just won't get the early-skip
// benefit until the next 429 confirms it.
let cooldownUntilMs = 0;

export function isInCooldown(): boolean {
  return Date.now() < cooldownUntilMs;
}

export function cooldownRemainingMs(): number {
  return Math.max(0, cooldownUntilMs - Date.now());
}

/**
 * Outbound call with bounded 429 retry + global cooldown gate.
 *
 * Strategy:
 *  - If we're already in cooldown, fail fast (don't even try).
 *  - On 429 with retry_after \u2264 5s: sleep + retry once.
 *  - On 429 with retry_after > 5s: open the global cooldown
 *    until that time and surface a SkipDueToCooldown error so
 *    the handler can drop the message gracefully.
 *
 * Capping the inline retry at 5s keeps the long-poll loop
 * snappy: any longer wait means the bot has been flood-banned
 * and continuing to call the API only extends the ban.
 */
async function callGated<T>(
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  if (isInCooldown()) {
    const err = new Error(
      `Telegram ${method} skipped: in cooldown for ${Math.ceil(
        cooldownRemainingMs() / 1000,
      )}s`,
    );
    (err as { code?: number }).code = 429;
    (err as { skipped?: boolean }).skipped = true;
    throw err;
  }
  try {
    return await call<T>(method, body, signal);
  } catch (e) {
    const code = (e as { code?: number }).code;
    const retryAfter = (e as { retryAfter?: number }).retryAfter;
    if (code !== 429 || !retryAfter) throw e;
    if (retryAfter > 5) {
      cooldownUntilMs = Date.now() + (retryAfter + 1) * 1000;
      console.error(
        `[telegram] flood-ban: cooldown for ${retryAfter}s on ${method}; ` +
          `outbound calls will be skipped until ${new Date(
            cooldownUntilMs,
          ).toISOString()}`,
      );
      (e as { skipped?: boolean }).skipped = true;
      throw e;
    }
    const waitMs = retryAfter * 1000 + 250;
    console.warn(
      `[telegram] ${method} hit 429, sleeping ${waitMs}ms before single retry`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
    return call<T>(method, body, signal);
  }
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
/**
 * One button on an inline keyboard. We only use the
 * `callback_data` variant: pressing the button triggers a
 * callback_query update that KDust dispatches as if it were a
 * regular slash command. The string is opaque to Telegram and
 * limited to 64 bytes.
 */
export interface TgInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage; // the message bearing the inline keyboard
  data?: string; // the callback_data of the pressed button
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  // Other variants (channel_post, my_chat_member, ...) are
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
    {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'callback_query'],
    },
    signal,
  );
}

export async function sendMessage(
  chatId: string | number,
  text: string,
  opts?: {
    reply_to_message_id?: number;
    parse_mode?: 'HTML' | 'MarkdownV2';
    /**
     * Inline keyboard rows. Each row is an array of buttons.
     * Telegram caps the total payload at ~10kB so keep button
     * labels short. callback_data is limited to 64 bytes.
     */
    inline_keyboard?: TgInlineKeyboardButton[][];
  },
): Promise<TgMessage> {
  return callGated<TgMessage>('sendMessage', {
    chat_id: chatId,
    text: text.length > 4096 ? text.slice(0, 4090) + '\u2026' : text,
    parse_mode: opts?.parse_mode,
    reply_to_message_id: opts?.reply_to_message_id,
    disable_web_page_preview: true,
    reply_markup: opts?.inline_keyboard
      ? { inline_keyboard: opts.inline_keyboard }
      : undefined,
  });
}

/**
 * Send a photo to a chat. The `photo` argument is a URL that
 * Telegram fetches server-side, so it must be publicly
 * reachable from Telegram's network (no auth, no private CDN).
 *
 * If the URL is private or otherwise unreachable, Telegram
 * returns a 400 with a descriptive error \u2014 we propagate so
 * the caller can fall back to inlining the URL as plain text.
 */
export async function sendPhoto(
  chatId: string | number,
  photoUrl: string,
  opts?: { caption?: string; reply_to_message_id?: number },
): Promise<TgMessage> {
  return callGated<TgMessage>('sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    // Telegram caps caption at 1024 chars (vs 4096 for text).
    caption:
      opts?.caption && opts.caption.length > 1024
        ? opts.caption.slice(0, 1020) + '\u2026'
        : opts?.caption,
    reply_to_message_id: opts?.reply_to_message_id,
  });
}

/**
 * Acknowledge a callback_query so the Telegram client stops the
 * loading spinner on the tapped button. Optionally surfaces a
 * short toast to the user. Always best-effort: we don't want a
 * failed ack to mask the real handler outcome.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  opts?: { text?: string; show_alert?: boolean },
): Promise<void> {
  if (isInCooldown()) return;
  try {
    await call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: opts?.text,
      show_alert: opts?.show_alert ?? false,
    });
  } catch (e) {
    // Telegram returns 400 if the query is older than 1 minute;
    // not fatal, just log.
    console.warn(
      `[telegram] answerCallbackQuery failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export async function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  opts?: { parse_mode?: 'HTML' | 'MarkdownV2' },
): Promise<void> {
  // editMessageText also goes through callGated so it respects
  // the global cooldown. We don't sleep-and-retry here \u2014 the
  // streaming path in bridge.ts already extends its throttle
  // window on 429, and a long sleep would freeze the stream.
  if (isInCooldown()) return;
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
  // chat actions are best-effort UI sugar; never trip the API
  // during cooldown.
  if (isInCooldown()) return;
  await call('sendChatAction', { chat_id: chatId, action });
}

export async function getMe(): Promise<TgUser> {
  return call<TgUser>('getMe', {});
}

export function isTelegramConfigured(): boolean {
  return getToken() !== null;
}
