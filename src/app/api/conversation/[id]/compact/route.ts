import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { notFound, apiError } from '@/lib/api/responses';
import { getContextUsage, postCompaction } from '@/lib/dust/internal-api';

export const runtime = 'nodejs';

/**
 * POST /api/conversation/:id/compact
 *
 * Requests a manual compaction of the conversation's older messages
 * to free up context budget. Read-resolves the local conv row to
 * find its Dust sId, fetches the current model from /context-usage,
 * then POSTs /assistant/conversations/{cId}/compactions.
 *
 * Errors propagate with the upstream status code (e.g. 409 when an
 * agent message is in flight) and a structured body shape
 * `{error: '...'}` consistent with the rest of the API.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const conv = await db.conversation.findFirst({
    where: { OR: [{ id }, { dustConversationSId: id }] },
    select: { dustConversationSId: true },
  });
  if (!conv?.dustConversationSId) return notFound('conv_not_found');
  const usage = await getContextUsage(conv.dustConversationSId);
  const model =
    usage?.modelProvider && usage?.modelId
      ? { providerId: usage.modelProvider, modelId: usage.modelId }
      : null;
  const r = await postCompaction(conv.dustConversationSId, model);
  if (!r.ok) {
    // Surface upstream status when it falls in the 4xx range so
    // callers can distinguish a 409 (in-flight) from a 5xx (Dust
    // hiccup). Default to 502 for non-HTTP failures.
    const status =
      r.status >= 400 && r.status < 600 ? r.status : 502;
    return apiError(r.error ?? 'compaction_failed', status);
  }
  return NextResponse.json({ ok: true });
}
