import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { propagateCategoryToAllProjects } from '@/lib/advice/provision';

export const runtime = 'nodejs';

/**
 * POST /api/advice/defaults/:id/propagate
 *
 * Force-provision this template on every project that doesn't yet
 * have a cron for this category. Existing per-project crons are NOT
 * modified (schedules/prompts may have been customised locally).
 *
 * Use case: admin just created / re-enabled a template and wants it
 * live on all projects without waiting for each project's next edit.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const def = await db.adviceCategoryDefault.findUnique({ where: { id } });
  if (!def) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const count = await propagateCategoryToAllProjects(def.key);
  return NextResponse.json({ ok: true, created: count });
}
