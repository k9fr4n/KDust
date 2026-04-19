import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { reloadScheduler } from '@/lib/cron/scheduler';
import { isValidCronExpression } from '@/lib/cron/validator';

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
  // Lightweight validation: reject a PATCH that would set an
  // invalid cron expression. The scheduler would silently skip the
  // task otherwise, leading to "it's enabled but never fires" user
  // confusion. 'manual' is accepted as a pseudo-value meaning
  // "never auto-fire".
  if (typeof data.schedule === 'string' && data.schedule !== 'manual') {
    if (!isValidCronExpression(data.schedule)) {
      return NextResponse.json(
        { error: `invalid cron expression: "${data.schedule}"` },
        { status: 400 },
      );
    }
  }
  // Phase 1 (2026-04-19): branch override fields treat empty string
  // as "clear the override" so the task falls back to project policy.
  for (const k of ['baseBranch', 'branchPrefix', 'protectedBranches'] as const) {
    if (k in data && typeof data[k] === 'string' && data[k].trim() === '') {
      data[k] = null;
    }
  }
  const task = await db.task.update({ where: { id }, data });
  await reloadScheduler();
  return NextResponse.json({ task });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Mandatory tasks (auto-provisioned audit tasks on project creation)
  // cannot be deleted. User can disable them or tweak their schedule /
  // prompt instead. See src/lib/audit/provision.ts.
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
