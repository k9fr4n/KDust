import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { notFound } from '@/lib/api/responses';
import { getContextUsage } from '@/lib/dust/internal-api';

export const runtime = 'nodejs';

/**
 * GET /api/conversation/:id/context-usage
 *
 * Returns the Dust token-budget snapshot for this conversation, or
 * `{ok:false}` if the upstream call failed (network / non-2xx /
 * schema drift). Fail-soft so the UI can hide the pill silently
 * when Dust is unreachable.
 *
 * The :id segment accepts EITHER the local Conversation.id OR the
 * upstream Dust sId — same lookup convention as /chat/[id]/page.tsx
 * (Franck 2026-05-28).
 */
export async function GET(
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
  if (!usage) {
    return NextResponse.json({ ok: false }, { status: 200 });
  }
  return NextResponse.json({ ok: true, ...usage });
}
