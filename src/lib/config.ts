import { db } from './db';

export interface AppConfigData {
  dustBaseUrl: string;
  workosClientId: string;
  workosDomain: string;
  claimNamespace: string;
  defaultTeamsWebhook: string | null;
  // Default Telegram chat_id for run notifications (Franck
  // 2026-04-25 18:14). Bot token comes from env, not config.
  defaultTelegramChatId: string | null;
  // Wall-clock runtime caps (Franck 2026-04-23 09:56). Stored in
  // ms; clamped [30s, 6h] by the runner and by the settings API.
  leafRunTimeoutMs: number;
  orchestratorRunTimeoutMs: number;
  // Default IANA timezone (Franck 2026-04-24 17:07). Used by
  // the scheduler when Task.timezone is null and by the Dust
  // chat userContext so agents report local time correctly.
  timezone: string;
  // Interactive Telegram chat bridge (Franck 2026-04-25 22:00).
  telegramChatEnabled: boolean;
  telegramAllowedChatIds: string | null;
  telegramDefaultAgentSId: string | null;
  // Note: telegramUpdateOffset is NOT exposed here. It's a
  // runtime cursor read/written directly from the poller via
  // dedicated helpers (getTelegramOffset / setTelegramOffset)
  // — leaking it through the settings API would be a footgun.
}

export async function getAppConfig(): Promise<AppConfigData> {
  const existing = await db.appConfig.findUnique({ where: { id: 1 } });
  if (existing) {
    return {
      dustBaseUrl: existing.dustBaseUrl,
      workosClientId: existing.workosClientId,
      workosDomain: existing.workosDomain,
      claimNamespace: existing.claimNamespace,
      defaultTeamsWebhook: existing.defaultTeamsWebhook,
      defaultTelegramChatId: existing.defaultTelegramChatId,
      leafRunTimeoutMs: existing.leafRunTimeoutMs,
      orchestratorRunTimeoutMs: existing.orchestratorRunTimeoutMs,
      timezone: existing.timezone,
      telegramChatEnabled: existing.telegramChatEnabled,
      telegramAllowedChatIds: existing.telegramAllowedChatIds,
      telegramDefaultAgentSId: existing.telegramDefaultAgentSId,
    };
  }
  // bootstrap from env (one-shot, first boot only)
  const created = await db.appConfig.create({
    data: {
      id: 1,
      dustBaseUrl: process.env.DUST_BASE_URL ?? 'https://dust.tt',
      workosClientId: process.env.WORKOS_CLIENT_ID ?? '',
      workosDomain: process.env.WORKOS_DOMAIN ?? 'api.workos.com',
      claimNamespace: process.env.WORKOS_CLAIM_NAMESPACE ?? 'https://dust.tt/',
      defaultTeamsWebhook: null,
      // Schema @default covers the timeouts — no need to seed
      // explicitly from env.
    },
  });
  return {
    dustBaseUrl: created.dustBaseUrl,
    workosClientId: created.workosClientId,
    workosDomain: created.workosDomain,
    claimNamespace: created.claimNamespace,
    defaultTeamsWebhook: created.defaultTeamsWebhook,
    defaultTelegramChatId: created.defaultTelegramChatId,
    leafRunTimeoutMs: created.leafRunTimeoutMs,
    orchestratorRunTimeoutMs: created.orchestratorRunTimeoutMs,
    timezone: created.timezone,
    telegramChatEnabled: created.telegramChatEnabled,
    telegramAllowedChatIds: created.telegramAllowedChatIds,
    telegramDefaultAgentSId: created.telegramDefaultAgentSId,
  };
}

// ---------------------------------------------------------------
// Telegram long-poll cursor helpers (Franck 2026-04-25 22:00).
//
// The cursor is stored on the singleton AppConfig row to avoid
// adding yet another singleton table. Reads happen on every
// successful getUpdates batch (cheap, sub-ms on SQLite); writes
// are debounced by the poller to once per non-empty batch.
// Both helpers swallow Prisma errors and return safe defaults so
// a transient DB hiccup never crashes the long-poll loop.
// ---------------------------------------------------------------
export async function getTelegramOffset(): Promise<number> {
  try {
    const cfg = await db.appConfig.findUnique({
      where: { id: 1 },
      select: { telegramUpdateOffset: true },
    });
    return cfg?.telegramUpdateOffset ?? 0;
  } catch {
    return 0;
  }
}

export async function setTelegramOffset(offset: number): Promise<void> {
  // Re-throws on failure so the poller can detect a broken DB
  // schema (e.g. column missing because `prisma db push` did not
  // run at container boot) and refuse to keep looping. Silent
  // failure here used to cause an infinite getUpdates retry on
  // the same backlog (no offset advance \u2192 no progress).
  await db.appConfig.update({
    where: { id: 1 },
    data: { telegramUpdateOffset: offset },
  });
}

export async function updateAppConfig(patch: Partial<AppConfigData>) {
  const current = await getAppConfig();
  return db.appConfig.update({ where: { id: 1 }, data: { ...current, ...patch } });
}

// ---------------------------------------------------------------
// Cached timezone accessor (Franck 2026-04-24 17:07).
//
// getAppConfig() hits the DB on every call. The scheduler and
// chat.ts both need the timezone on hot paths (every cron fire,
// every chat turn), so we keep a short-lived in-memory cache
// (60s TTL). Updates via updateAppConfig() call
// invalidateAppTimezoneCache() to flush immediately; otherwise
// the cache converges in at most 60s. Fallback to Europe/Paris
// on any DB error so we never fail the hot path on a timezone
// lookup.
// ---------------------------------------------------------------
const TZ_CACHE_TTL_MS = 60_000;
let tzCache: { value: string; expiresAt: number } | null = null;

export async function getAppTimezone(): Promise<string> {
  const now = Date.now();
  if (tzCache && tzCache.expiresAt > now) return tzCache.value;
  try {
    const cfg = await getAppConfig();
    tzCache = { value: cfg.timezone, expiresAt: now + TZ_CACHE_TTL_MS };
    return cfg.timezone;
  } catch {
    // Database hiccup — keep the stale value if we have one,
    // otherwise degrade to the historical default. Never throw
    // on this path.
    if (tzCache) return tzCache.value;
    return 'Europe/Paris';
  }
}

export function invalidateAppTimezoneCache(): void {
  tzCache = null;
}

/**
 * Validates an IANA timezone identifier. Returns true if Node's
 * Intl implementation recognizes it. Used by the settings API
 * to reject typos before they break the scheduler.
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    // Throws RangeError for unknown zones.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
