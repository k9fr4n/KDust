import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { overwriteCategoryEverywhere } from '@/lib/advice/provision';

export const runtime = 'nodejs';

/**
 * POST /api/advice/defaults/:id/overwrite
 *
 * DESTRUCTIVE. Re-applies the template's prompt + schedule + label to
 * EVERY per-project cron in this category, wiping any project-level
 * customisation of those fields. Also (re-)creates the cron on any
 * project that didn't have it yet.
 *
 * Also useful to rebuild the prompt of legacy advice tasks that were
 * created under the old prompt format, so they pick up the current
 * JSON contract.
 *
 * Not idempotent-safe in the "user customisation" sense — make sure
 * the UI shows a confirmation dialog.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const def = await db.adviceCategoryDefault.findUnique({ where: { id } });
  if (!def) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const stats = await overwriteCategoryEverywhere(def.key);
  return NextResponse.json({ ok: true, ...stats });
}
