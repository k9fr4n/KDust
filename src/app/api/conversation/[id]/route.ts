import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isStreaming, getActiveStream } from '@/lib/chat/active-streams';
import { getDustClient } from '@/lib/dust/client';
import { syncMessagesFromDust } from '@/lib/chat/sync-messages';

export const runtime = 'nodejs';

/**
 * Best-effort title sync from Dust (Franck 2026-04-23 22:22).
 *
 * Dust auto-generates a human-readable title after the first agent
 * turn; conversations created before the stream-end sync was in
 * place (or where the sync failed) still carry the original
 * user-prompt as their title. We self-heal on every conversation
 * GET: fetch the authoritative title from Dust, overwrite the
 * local row if it differs. Non-blocking \u2014 errors are swallowed
 * so a transient Dust outage never masks the 200 OK we owe the
 * client.
 *
 * Cost budget:
 *   - 1 Dust API call per conversation open.
 *   - Skipped when the local row has no dustConversationSId yet
 *     (pre-first-message) \u2014 no title exists upstream to fetch.
 *   - No coalescing: intentionally simple. Users don't open the
 *     same conversation hundreds of times per minute, and Dust's
 *     getConversation is a lightweight GET.
 *
 * Returns the (possibly updated) title string for the caller to
 * use in the response payload without a second DB round-trip.
 */
/**
 * Best-effort sync of title AND messages from Dust (Franck
 * 2026-04-23 / 2026-04-29).
 *
 * Dust is the source of truth for chat content. KDust persists a
 * local mirror used as cache for fast reloads and offline-ish UX.
 * Two divergence sources need a sync on conversation open:
 *
 *   1. Title — Dust auto-generates a human-readable one after the
 *      first agent turn.
 *   2. Messages — the user may continue the same conversation on
 *      app.dust.tt (web UI) and come back to KDust expecting to
 *      see the new turns.
 *
 * We piggyback on a single getConversation() call to do both.
 *
 * Cost budget:
 *   - 1 Dust API call per conversation open.
 *   - Skipped when the local row has no dustConversationSId yet
 *     (pre-first-message).
 *   - No coalescing: opens are not high-frequency and getConversation
 *     is a lightweight GET.
 *
 * Returns the (possibly updated) title string for the caller to
 * use in the response payload without a second DB round-trip.
 * Errors are swallowed so a transient Dust outage never masks
 * the 200 OK we owe the client.
 */
async function syncFromDust(
  conv: { id: string; dustConversationSId: string | null; title: string },
): Promise<string> {
  if (!conv.dustConversationSId) return conv.title;
  try {
    const cli = await getDustClient();
    if (!cli) return conv.title;
    const res = await cli.client.getConversation({
      conversationId: conv.dustConversationSId,
    });
    if (!res.isOk()) return conv.title;
    const dustConv = res.value;

    // Messages sync first — it produces no user-facing string but
    // mutates the DB before we re-read messages in the GET handler.
    // Pass active-stream info so the sync skips creating a row for
    // an agent_message currently being produced by /stream (Franck
    // 2026-04-29: was triggering "empty bubble" + P2002 on stream
    // end — see sync-messages.ts header).
    const activeNow = getActiveStream(conv.id);
    try {
      const stats = await syncMessagesFromDust(conv.id, dustConv, {
        activeStream: activeNow
          ? { active: true, agentMessageSId: activeNow.agentMessageSId }
          : undefined,
      });
      if (stats.created > 0 || stats.linked > 0) {
        console.log(
          `[conv/:id] messages synced conv=${conv.id} created=${stats.created} linked=${stats.linked}`,
        );
      }
    } catch (e) {
      console.warn(
        '[conv/:id] message sync failed',
        conv.id,
        e instanceof Error ? e.message : e,
      );
    }

    // Title sync.
    const dustTitle = dustConv?.title?.trim();
    if (!dustTitle || dustTitle === conv.title) return conv.title;
    await db.conversation.update({
      where: { id: conv.id },
      data: { title: dustTitle },
    });
    console.log(`[conv/:id] title synced ${conv.id} \u2192 "${dustTitle}"`);
    return dustTitle;
  } catch (e) {
    console.warn('[conv/:id] sync failed', conv.id, e instanceof Error ? e.message : e);
    return conv.title;
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // First lookup is metadata-only — we use it to gate the sync
  // call (need dustConversationSId) before re-reading messages
  // post-sync so the response carries any rows pulled from Dust.
  const meta = await db.conversation.findUnique({
    where: { id },
    select: { id: true, dustConversationSId: true, title: true },
  });
  if (!meta) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  // Opportunistic sync (title + messages from Dust web). In-line
  // so the response carries the freshest state.
  const syncedTitle = await syncFromDust(meta);
  // Re-read with messages AFTER the sync so newly inserted rows
  // (from Dust web) make it into the payload.
  const conv = await db.conversation.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!conv) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (syncedTitle !== conv.title) conv.title = syncedTitle;
  // Expose server-side streaming state so clients that open the conv
  // while an answer is still being produced can show a banner.
  // Plus expose the replay buffers (Franck 2026-04-25 19:36) so a
  // passive client \u2014 e.g. the same user reopening the chat in a new
  // tab, or the remounted ChatClient after router.push \u2014 can render
  // the partial agent reply instead of the unhelpful "Agent is still
  // replying in the background" banner.
  const streaming = isStreaming(id);
  const active = getActiveStream(id);
  return NextResponse.json({
    conversation: conv,
    streaming,
    streamingSince: active?.startedAt ?? null,
    streamContent: active?.contentBuffer ?? '',
    streamCot: active?.cotBuffer ?? '',
    // Raw JSON payloads ('{tool, params}') in invocation order;
    // the client formats them identically to the live SSE path
    // so the displayed pills don't shift when reattaching.
    streamToolCalls: active?.toolCalls ?? [],
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await db.conversation.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
