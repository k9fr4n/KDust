import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { reloadScheduler } from '@/lib/cron/scheduler';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cron = await db.cronJob.findUnique({
    where: { id },
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 20 } },
  });
  if (!cron) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ cron });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const data = await req.json();
  const cron = await db.cronJob.update({ where: { id }, data });
  await reloadScheduler();
  return NextResponse.json({ cron });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await db.cronJob.delete({ where: { id } });
  await reloadScheduler();
  return NextResponse.json({ ok: true });
}
