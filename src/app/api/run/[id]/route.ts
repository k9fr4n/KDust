import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * DELETE /api/run/:id
 *
 * Permanently removes a single TaskRun from history. Does NOT
 * touch the parent Task — that one has its own /api/task/:id
 * lifecycle. Idempotent: a missing id returns { ok: true } so the
 * UI can retry safely after a network blip.
 *
 * Franck 2026-04-20 18:04: added alongside the pin/delete buttons
 * on the dashboard RunCard (option A: per-run actions).
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await db.taskRun.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
