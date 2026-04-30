/**
 * Telegram long-poll loop (Franck 2026-04-25 22:00).
 *
 * Strategy:
 *  - Long-poll getUpdates with a 25s server-side wait. Telegram
 *    holds the connection until either an update arrives or the
 *    timeout elapses, so the loop is mostly idle (zero CPU).
 *  - The persisted offset (AppConfig.telegramUpdateOffset) is
 *    advanced ONLY after the message handler has returned. If
 *    the process crashes mid-handle, Telegram will redeliver the
 *    update on the next boot (at-least-once). The bridge is
 *    idempotent enough for that to be acceptable: a duplicate
 *    user turn would just generate a duplicate agent reply
 *    (visible in /conversation, easy to clean up manually).
 *  - On error: exponential backoff capped at 60s. 401/404 (bad
 *    or revoked token) stops the loop and logs once — retrying
 *    a 401 forever just spams api.telegram.org.
 *  - The whole loop is wrapped in a `started` boolean guard so
 *    instrumentation.ts can be called twice (e.g. Next.js HMR)
 *    without spawning duplicate pollers (which would cause
 *    Telegram 409 Conflict on parallel getUpdates).
 */

import { getAppConfig, getTelegramOffset, setTelegramOffset } from '@/lib/config';
import {
  getUpdates,
  getMe,
  isTelegramConfigured,
  isInCooldown,
  cooldownRemainingMs,
} from './api';
import { handleTelegramMessage, handleTelegramCallback } from './bridge';

let started = false;
let stopRequested = false;
let currentAbort: AbortController | null = null;

// ---- bridge status (Franck 2026-04-30) ----
//
// Exposed via getTelegramBridgeStatus() so /settings/telegram can
// show "running as @bot pid=… since …". Helps the operator
// diagnose Telegram 409 Conflict (two pollers fighting on the
// same token): if `pid` matches the local container PID and the
// 409 keeps coming, the second poller is elsewhere.
let bridgeStartedAt: string | null = null;
let bridgeBot: { id: number; username: string | null } | null = null;
let lastError: { at: string; message: string } | null = null;

export interface TelegramBridgeStatus {
  running: boolean;
  pid: number;
  startedAt: string | null;
  bot: { id: number; username: string | null } | null;
  lastError: { at: string; message: string } | null;
}

export function getTelegramBridgeStatus(): TelegramBridgeStatus {
  return {
    running: started,
    pid: process.pid,
    startedAt: bridgeStartedAt,
    bot: bridgeBot,
    lastError,
  };
}

const LONG_POLL_TIMEOUT_SEC = 25;
const MAX_BACKOFF_MS = 60_000;

// ---- in-memory update_id dedup (Franck 2026-04-25 23:00) ----
//
// Defence-in-depth against the bot replying multiple times to
// the same user message. The persisted offset SHOULD already
// guarantee at-most-once delivery within the process, but in
// the wild we observed duplicate replies (suspected: two KDust
// instances racing on the same bot token, or a stale webhook).
//
// We keep a sliding window of the last N processed update_ids;
// anything seen again is silently dropped. N=512 is generous
// enough that even a busy chat won't lose deduping memory
// before the same id has cycled out of Telegram's buffer (24h).
const recentUpdateIds = new Set<number>();
const RECENT_MAX = 512;
function rememberUpdateId(id: number): boolean {
  if (recentUpdateIds.has(id)) return false; // already seen
  recentUpdateIds.add(id);
  if (recentUpdateIds.size > RECENT_MAX) {
    // Drop oldest \u2014 Set iteration is insertion-order so the
    // first key is the oldest. This keeps the cap O(1) per add.
    const oldest = recentUpdateIds.values().next().value;
    if (oldest !== undefined) recentUpdateIds.delete(oldest);
  }
  return true;
}

/**
 * On first activation (offset stored = 0) Telegram would replay
 * up to 24h of buffered updates \u2014 typically the operator's test
 * messages, which then trigger a sendMessage burst that hits
 * the per-bot rate limit.
 *
 * We avoid this by doing a one-shot getUpdates(offset=-1, t=0):
 * Telegram returns just the most recent update (or an empty
 * array if the bot has zero history). We then persist
 * lastUpdate+1 as our starting offset, dropping the entire
 * backlog. Any message sent AFTER this call is delivered
 * normally.
 *
 * Run only when the cursor is still at its default of 0 \u2014 once
 * the bridge has processed any update, the persisted offset
 * tracks the truth and we never want to override it.
 */
async function skipBacklogIfFirstStart(): Promise<void> {
  const current = await getTelegramOffset();
  if (current !== 0) return;
  try {
    const updates = await getUpdates(-1, 0);
    if (updates.length === 0) {
      console.log('[telegram] first start, no backlog to skip');
      return;
    }
    const latest = updates[updates.length - 1].update_id;
    await setTelegramOffset(latest + 1);
    console.log(
      `[telegram] first start, skipped backlog up to update_id=${latest}`,
    );
  } catch (e) {
    // Non-fatal: if the skip fails, the main loop still runs.
    // Worst case the operator sees a one-time backlog burst,
    // which the 429-retry in api.ts now handles gracefully.
    console.warn(
      `[telegram] backlog skip failed (will fall back to normal poll): ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
}

/**
 * Round-trip the offset persistence path before starting the
 * poll loop. Catches the most common boot-time misconfiguration
 * (schema drift: telegramUpdateOffset column missing because
 * `prisma db push` did not run in the container) BEFORE we
 * enter the long-poll, where a failed setTelegramOffset would
 * silently spin on the same backlog at 30 Hz.
 *
 * Returns true when the path is healthy, false otherwise (loop
 * aborts so the operator notices in /logs).
 */
async function selfTestPersistence(): Promise<boolean> {
  try {
    const current = await getTelegramOffset();
    await setTelegramOffset(current);
    return true;
  } catch (e) {
    console.error(
      '[telegram] persistence self-test FAILED \u2014 offset cannot be ' +
        'written to AppConfig. Most likely the schema is out of date ' +
        '(run `prisma db push` in the container). Bridge will not start.\n' +
        `  underlying error: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

async function loop(): Promise<void> {
  let backoff = 1_000;
  let consecutiveAuthFailures = 0;
  let consecutivePersistFailures = 0;

  if (!(await selfTestPersistence())) {
    started = false;
    stopRequested = false;
    return;
  }

  await skipBacklogIfFirstStart();

  while (!stopRequested) {
    // Re-read the master switch every iteration so the operator
    // can toggle the bridge on/off from /settings/telegram
    // without restarting the server. When disabled mid-flight
    // we exit the loop cleanly (started flag flipped in stop()).
    const cfg = await getAppConfig().catch(() => null);
    if (!cfg?.telegramChatEnabled) {
      console.log('[telegram] disabled — poller exiting');
      break;
    }
    if (!isTelegramConfigured()) {
      console.warn('[telegram] KDUST_TELEGRAM_BOT_TOKEN missing \u2014 sleeping 30s');
      await sleep(30_000);
      continue;
    }
    // While in cooldown, sleep until it expires before pulling
    // any new updates. We could keep fetching and silently drop,
    // but holding off on getUpdates also keeps the offset stable
    // and avoids accumulating updates we have to throw away.
    if (isInCooldown()) {
      const remainMs = cooldownRemainingMs();
      console.warn(
        `[telegram] in cooldown \u2014 sleeping ${Math.ceil(remainMs / 1000)}s`,
      );
      await sleep(Math.min(remainMs, 60_000) + 500);
      continue;
    }

    const offset = await getTelegramOffset();
    currentAbort = new AbortController();
    try {
      const updates = await getUpdates(
        offset,
        LONG_POLL_TIMEOUT_SEC,
        currentAbort.signal,
      );
      backoff = 1_000;
      consecutiveAuthFailures = 0;

      if (updates.length === 0) continue;

      // Process sequentially: KDust is mono-user and a single
      // chat will rarely have parallel turns, so serial keeps
      // the code simple and avoids racing edits on the same
      // placeholder message.
      let maxId = offset - 1;
      for (const u of updates) {
        maxId = Math.max(maxId, u.update_id);
        // Dedup: if we've already processed this update_id in
        // this process lifetime, skip silently. Cheap insurance
        // against infinite replies if the offset advance is
        // somehow defeated by a parallel poller, a stale
        // webhook, or any other source of duplicate delivery.
        if (!rememberUpdateId(u.update_id)) {
          console.warn(
            `[telegram] dedup: dropping duplicate update_id=${u.update_id}`,
          );
          continue;
        }
        try {
          if (u.callback_query) {
            await handleTelegramCallback(u.callback_query);
          } else {
            const msg = u.message ?? u.edited_message;
            if (msg) await handleTelegramMessage(msg);
          }
        } catch (e) {
          console.error(
            `[telegram] handler threw for update_id=${u.update_id}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      // Persist offset only AFTER the full batch has been
      // processed; on crash we'll re-deliver but never lose.
      // If persistence fails repeatedly the loop aborts (better
      // than infinite re-fetch of the same backlog at 30 Hz).
      try {
        await setTelegramOffset(maxId + 1);
        consecutivePersistFailures = 0;
      } catch (e) {
        consecutivePersistFailures++;
        console.error(
          `[telegram] failed to persist offset (${consecutivePersistFailures}/3): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        if (consecutivePersistFailures >= 3) {
          console.error('[telegram] giving up: schema/DB seems broken');
          break;
        }
        await sleep(5_000);
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') break;
      const code = (err as { code?: number }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === 401 || code === 404) {
        consecutiveAuthFailures++;
        console.error(
          `[telegram] auth failure (${code}); check KDUST_TELEGRAM_BOT_TOKEN — ${msg}`,
        );
        if (consecutiveAuthFailures >= 3) {
          console.error('[telegram] giving up after 3 auth failures');
          break;
        }
      } else {
        console.warn(`[telegram] getUpdates error, backing off ${backoff}ms: ${msg}`);
      }
      lastError = { at: new Date().toISOString(), message: msg };
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    } finally {
      currentAbort = null;
    }
  }
  started = false;
  stopRequested = false;
  bridgeStartedAt = null;
  console.log('[telegram] poller stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Boot the long-poll loop if (and only if) it is currently
 * disabled. Safe to call multiple times: a guard ensures only one
 * loop is in flight per process. Returns immediately; the loop
 * runs in the background.
 */
export async function startTelegramBridge(): Promise<void> {
  if (started) return;
  const cfg = await getAppConfig().catch(() => null);
  if (!cfg?.telegramChatEnabled) {
    console.log('[telegram] bridge disabled in AppConfig — not starting');
    return;
  }
  if (!isTelegramConfigured()) {
    console.warn(
      '[telegram] bridge enabled but KDUST_TELEGRAM_BOT_TOKEN is missing',
    );
    return;
  }
  // One-shot identity check so we surface a clear error in /logs
  // before the first getUpdates would have. Non-blocking on
  // failure: getMe failing usually means the token is wrong, but
  // we still let the main loop's auth-failure path handle it so
  // the behaviour is uniform.
  try {
    const me = await getMe();
    bridgeBot = { id: me.id, username: me.username ?? me.first_name ?? null };
    console.log(
      `[telegram] bridge starting as @${me.username ?? me.first_name} (id=${me.id}) pid=${process.pid}`,
    );
  } catch (e) {
    console.warn(
      `[telegram] getMe at boot failed: ${e instanceof Error ? e.message : e}`,
    );
  }
  // Detect a stale webhook: if one is configured, getUpdates
  // returns 409 Conflict on every call. Surface it loudly at
  // boot so the operator knows to deleteWebhook \u2014 silent
  // failure here was a real footgun while debugging.
  try {
    const token = process.env.KDUST_TELEGRAM_BOT_TOKEN;
    if (token) {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getWebhookInfo`,
      );
      const j = (await res.json()) as { result?: { url?: string } };
      if (j.result?.url) {
        console.error(
          `[telegram] WEBHOOK ACTIVE on this bot (${j.result.url}) \u2014 ` +
            'getUpdates will keep returning 409. Run ' +
            '`curl -s "https://api.telegram.org/bot$TOKEN/deleteWebhook"` once.',
        );
      }
    }
  } catch {
    // best effort
  }
  started = true;
  stopRequested = false;
  bridgeStartedAt = new Date().toISOString();
  lastError = null;
  // Detached: the loop runs forever (or until stopTelegramBridge
  // is called). We DO NOT await here — instrumentation.register()
  // must return promptly to let Next.js complete startup.
  void loop().catch((e) => {
    started = false;
    console.error(
      `[telegram] poller crashed: ${e instanceof Error ? e.stack ?? e.message : e}`,
    );
  });
}

/**
 * Request the loop to stop. Aborts the current getUpdates if any
 * (so we don't have to wait the full long-poll timeout). The
 * `started` flag is reset by the loop itself when it returns.
 */
export function stopTelegramBridge(): void {
  if (!started) return;
  stopRequested = true;
  currentAbort?.abort();
}
