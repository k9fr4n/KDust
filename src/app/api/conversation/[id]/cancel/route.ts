import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getDustClient } from '@/lib/dust/client';
import {
  getActiveStream,
  markStreamEnd,
} from '@/lib/chat/active-streams';

export const runtime = 'nodejs';

/**
 * POST /api/conversation/:id/cancel
 *
 * Cancel the in-flight agent reply for this conversation. Calls Dust's
 * cancelMessageGeneration() on the agent message we registered in the
 * active-streams tracker. Returns 409 if no stream is currently active.
 *
 * The SSE stream route's `streamAgentReply` loop will observe the
 * cancellation via Dust's event stream (terminal event with status
 * 'cancelled') and exit cleanly, which triggers markStreamEnd() — but
 * we also clear the tracker defensively in case the loop is stuck on
 * an external await.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const active = getActiveStream(id);
  if (!active) {
    return NextResponse.json(
      { error: 'no active stream for this conversation' },
      { status: 409 },
    );
  }
  if (!active.agentMessageSId) {
    // Stream just started, Dust hasn't assigned the agent message sId
    // yet. Best we can do is mark it ended locally; the Dust side will
    // produce the reply but the client will already have moved on.
    markStreamEnd(id);
    return NextResponse.json({
      ok: true,
      cancelled: false,
      reason: 'agent_message_sid_not_yet_known',
    });
  }

  const conv = await db.conversation.findUnique({ where: { id } });
  if (!conv?.dustConversationSId) {
    return NextResponse.json({ error: 'conv not found' }, { status: 404 });
  }

  const cli = await getDustClient();
  if (!cli) {
    return NextResponse.json({ error: 'dust not connected' }, { status: 503 });
  }

  try {
    const res = await cli.client.cancelMessageGeneration({
      conversationId: conv.dustConversationSId,
      messageIds: [active.agentMessageSId],
    });
    // cancelMessageGeneration returns Err on failure, otherwise void/success.
    if ((res as any)?.isErr?.()) {
      const msg = (res as any).error?.message ?? 'unknown';
      // Even if Dust refuses (e.g. message already finished), clear our
      // tracker so a new stream can start.
      markStreamEnd(id);
      return NextResponse.json(
        { ok: false, error: `dust: ${msg}` },
        { status: 502 },
      );
    }
  } catch (err) {
    markStreamEnd(id);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  markStreamEnd(id);
  return NextResponse.json({
    ok: true,
    cancelled: true,
    agentMessageSId: active.agentMessageSId,
  });
}
