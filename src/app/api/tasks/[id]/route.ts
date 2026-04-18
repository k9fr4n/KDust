import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { reloadScheduler } from '@/lib/cron/scheduler';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = await db.task.findUnique({
    where: { id },
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 20 } },
  });
  if (!task) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ task });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const data = await req.json();
  const task = await db.task.update({ where: { id }, data });
  await reloadScheduler();
  return NextResponse.json({ task });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Mandatory tasks (auto-provisioned advice tasks on project creation)
  // cannot be deleted. User can disable them or tweak their schedule /
  // prompt instead. See src/lib/advice/provision.ts.
  const task = await db.task.findUnique({ where: { id }, select: { mandatory: true } });
  if (!task) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (task.mandatory) {
    return NextResponse.json(
      { error: 'mandatory task: cannot be deleted (you may disable it)' },
      { status: 403 },
    );
  }
  await db.task.delete({ where: { id } });
  await reloadScheduler();
  return NextResponse.json({ ok: true });
}
