import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * POST /api/run/:id/pin   { pinned: boolean }
 *
 * Toggles the TaskRun.pinned flag. Mirrors the semantics of
 * /api/conversation/:id/pin (commit bf9f615) — the UI drives the
 * desired state, the server just writes it. No ownership check:
 * KDust is single-tenant, no multi-user auth layer on top.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const pinned = !!body.pinned;
  try {
    const run = await db.taskRun.update({
      where: { id },
      data: { pinned },
      select: { id: true, pinned: true },
    });
    return NextResponse.json({ run });
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}
