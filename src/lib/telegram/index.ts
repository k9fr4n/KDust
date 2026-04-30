/**
 * Public surface of the Telegram subsystem (Franck 2026-04-25 22:00).
 *
 * Two independent flows share this module:
 *
 *   1. **Notification** — outbound-only `postToTelegram()` used by
 *      the task runner to ping the operator after a run. Always
 *      enabled when `KDUST_TELEGRAM_BOT_TOKEN` + a chat_id are set.
 *      No incoming traffic. Defined in `./notify.ts`.
 *
 *   2. **Interactive chat bridge** — bidirectional, opt-in via
 *      AppConfig.telegramChatEnabled. Long-polls
 *      api.telegram.org/getUpdates from inside this Node process
 *      so KDust never needs an inbound HTTPS port. Defined in
 *      `./poller.ts` + `./bridge.ts` and booted from
 *      `instrumentation.ts`.
 *
 * Re-exports the legacy `postToTelegram` symbol so existing
 * `import { postToTelegram } from '@/lib/telegram'` callers keep
 * compiling unchanged after the file→directory split.
 */
export { postToTelegram } from './notify';
export type { TelegramFact, TelegramReport } from './notify';
export {
  startTelegramBridge,
  stopTelegramBridge,
  getTelegramBridgeStatus,
} from './poller';
export type { TelegramBridgeStatus } from './poller';
