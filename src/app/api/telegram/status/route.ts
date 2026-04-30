import { NextResponse } from 'next/server';
import { getTelegramBridgeStatus } from '@/lib/telegram';

export const runtime = 'nodejs';

/**
 * GET /api/telegram/status
 *
 * Surfaces the in-process Telegram bridge state so /settings/telegram
 * can render a diagnostic badge. Helps the operator notice when a
 * second KDust instance (or a stale webhook) is fighting on the
 * same bot token — the symptom is a 409 Conflict on getUpdates
 * which would otherwise only be visible in /logs.
 *
 * Auth: piggy-backs on the global APP_PASSWORD middleware; no
 * extra check needed. Returns no secrets (token never leaves env).
 */
export async function GET() {
  return NextResponse.json(getTelegramBridgeStatus());
}
