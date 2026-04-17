import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * POST /api/conversations/:id/pin   { pinned: boolean }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const pinned = !!body.pinned;
  const conv = await db.conversation.update({ where: { id }, data: { pinned } });
  return NextResponse.json({ conversation: { id: conv.id, pinned: conv.pinned } });
}
