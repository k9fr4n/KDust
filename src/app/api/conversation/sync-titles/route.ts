import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getDustClient } from '@/lib/dust/client';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/conversation/sync-titles (Franck 2026-04-23 22:22)
 *
 * Backfill endpoint: iterates every local Conversation with a
 * dustConversationSId set and refreshes its title from Dust's
 * authoritative value. Useful after deploying the stream-end /
 * open-time sync to heal conversations created under the old code
 * path where the local title stayed the user's first prompt.
 *
 * Why a separate endpoint (rather than a cron or automatic):
 *   - Mono-user app: triggering explicitly from the UI keeps the
 *     side effects visible (audit trail in the response body).
 *   - O(N) Dust API calls — don't want to run it silently on
 *     every deploy.
 *
 * Concurrency: processes sequentially to avoid rate-limiting.
 * Typical workspace has < 100 conversations; budget is < 30s
 * wall-clock at 300ms/call.
 *
 * Response shape:
 *   {
 *     total:    number,        // conversations inspected
 *     updated:  Array<{id, from, to}>,
 *     skipped:  number,        // no dustConversationSId yet, or
 *                              // Dust returned same title
 *     errors:   Array<{id, reason}>
 *   }
 */
export async function POST() {
  const cli = await getDustClient();
  if (!cli) return NextResponse.json({ error: 'not_connected' }, { status: 401 });

  const convs = await db.conversation.findMany({
    where: { dustConversationSId: { not: null } },
    select: { id: true, title: true, dustConversationSId: true },
  });

  const updated: Array<{ id: string; from: string; to: string }> = [];
  const errors: Array<{ id: string; reason: string }> = [];
  let skipped = 0;

  for (const c of convs) {
    if (!c.dustConversationSId) {
      skipped++;
      continue;
    }
    try {
      const res = await cli.client.getConversation({
        conversationId: c.dustConversationSId,
      });
      if (!res.isOk()) {
        errors.push({ id: c.id, reason: res.error?.message ?? 'unknown' });
        continue;
      }
      const dustTitle = res.value?.title?.trim();
      if (!dustTitle || dustTitle === c.title) {
        skipped++;
        continue;
      }
      await db.conversation.update({
        where: { id: c.id },
        data: { title: dustTitle },
      });
      updated.push({ id: c.id, from: c.title, to: dustTitle });
    } catch (e) {
      errors.push({ id: c.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    total: convs.length,
    updated,
    skipped,
    errors,
  });
}
