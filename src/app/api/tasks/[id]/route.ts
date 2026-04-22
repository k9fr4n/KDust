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
  // Generic tasks (Franck 2026-04-22): projectPath empty string → null.
  // If becoming generic (null), enforce the same invariants as POST.
  if ('projectPath' in data) {
    if (typeof data.projectPath === 'string' && data.projectPath.trim() === '') {
      data.projectPath = null;
    }
  }
  // Load current row to merge-check invariants (PATCH may only flip
  // one of the relevant fields; we need the EFFECTIVE post-patch value).
  const current = await db.task.findUnique({
    where: { id },
    select: { projectPath: true, schedule: true, pushEnabled: true, taskRunnerEnabled: true },
  });
  if (!current) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const effective = {
    projectPath: 'projectPath' in data ? data.projectPath : current.projectPath,
    schedule: 'schedule' in data ? data.schedule : current.schedule,
    pushEnabled: 'pushEnabled' in data ? data.pushEnabled : current.pushEnabled,
    taskRunnerEnabled:
      'taskRunnerEnabled' in data ? data.taskRunnerEnabled : current.taskRunnerEnabled,
  };
  if (effective.projectPath === null) {
    const issues: string[] = [];
    if (effective.schedule !== 'manual')
      issues.push('schedule must be "manual" for a generic task');
    if (effective.pushEnabled)
      issues.push('pushEnabled must be false for a generic task');
    if (effective.taskRunnerEnabled)
      issues.push('taskRunnerEnabled must be false for a generic task');
    if (issues.length > 0) {
      return NextResponse.json(
        { error: `generic task invariants violated: ${issues.join('; ')}` },
        { status: 400 },
      );
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
