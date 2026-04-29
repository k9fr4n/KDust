import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getAppConfig,
  updateAppConfig,
  isValidTimezone,
  invalidateAppTimezoneCache,
} from '@/lib/config';
import { badRequest } from "@/lib/api/responses";
export const runtime = 'nodejs';

// Wall-clock runtime caps: [30s, 6h] clamp (matches runner.ts).
// Out-of-range values are rejected at API level here (as opposed
// to silently ignored in runner.ts) so the settings page surfaces
// a clear error instead of saving a value that gets ignored.
const CLAMP_MIN_MS = 30 * 1000;
const CLAMP_MAX_MS = 6 * 60 * 60 * 1000;
const timeoutMs = z
  .number()
  .int()
  .min(CLAMP_MIN_MS, 'at least 30 seconds')
  .max(CLAMP_MAX_MS, 'at most 6 hours')
  .optional();

const Patch = z.object({
  dustBaseUrl: z.string().url().optional(),
  workosClientId: z.string().optional(),
  workosDomain: z.string().optional(),
  claimNamespace: z.string().optional(),
  defaultTeamsWebhook: z.string().url().nullable().optional(),
  // Telegram chat_id is free-text: positive (DM), negative (group),
  // or supergroup -100xxxxxxxxxxx. We accept any non-empty string,
  // null, or omit. No URL/numeric validation \u2014 Telegram itself
  // returns 400 with a clear error if the chat_id is bad, and the
  // runner already swallows that with a console.warn.
  defaultTelegramChatId: z.string().nullable().optional(),
  // Interactive Telegram chat bridge (Franck 2026-04-25 22:00).
  // - telegramChatEnabled toggles the long-poll loop in
  //   instrumentation.ts. We don't auto-(re)start the loop from
  //   the PATCH handler: a server restart, or a deliberate call
  //   to startTelegramBridge() from the settings UI's API
  //   endpoint, is required. Keeps the responsibility tree
  //   shallow (one boot path, in instrumentation.ts).
  // - allowed chat ids: free-form CSV; empty = no one is allowed
  //   (fail-closed).
  // - default agent sId: lightly validated (sId pattern), the
  //   bridge re-validates against Dust on /agent.
  telegramChatEnabled: z.boolean().optional(),
  telegramAllowedChatIds: z.string().nullable().optional(),
  telegramDefaultAgentSId: z.string().nullable().optional(),
  leafRunTimeoutMs: timeoutMs,
  orchestratorRunTimeoutMs: timeoutMs,
  // IANA timezone validated against Node's Intl database. Refuse
  // typos at the boundary rather than silently saving a value
  // that would later break Cron scheduling with an obscure error.
  timezone: z
    .string()
    .refine(isValidTimezone, {
      message: 'Must be a valid IANA timezone (e.g. "Europe/Paris").',
    })
    .optional(),
});

export async function GET() {
  return NextResponse.json({ config: await getAppConfig() });
}
export async function PATCH(req: Request) {
  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) return badRequest(parsed.error.format());
  const updated = await updateAppConfig(parsed.data);
  // Flush the timezone cache so the new value takes effect
  // immediately on the scheduler and chat hot paths, without
  // waiting for the 60s TTL to expire.
  if (parsed.data.timezone !== undefined) invalidateAppTimezoneCache();
  // Reflect Telegram toggle changes immediately: enabling starts
  // the long-poll loop right now, disabling aborts the in-flight
  // getUpdates and lets the loop exit on its next iteration.
  // Both helpers are idempotent / no-op when called in the wrong
  // state, so we can call them unconditionally.
  if (parsed.data.telegramChatEnabled !== undefined) {
    try {
      const { startTelegramBridge, stopTelegramBridge } = await import(
        '@/lib/telegram'
      );
      if (parsed.data.telegramChatEnabled) await startTelegramBridge();
      else stopTelegramBridge();
    } catch (e) {
      console.warn(
        `[settings] telegram bridge toggle failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return NextResponse.json({ config: updated });
}
