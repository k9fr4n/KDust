import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { reloadScheduler } from '@/lib/cron/scheduler';
import { isValidCronExpression } from '@/lib/cron/validator';
import { isSideEffects, validateRoutingMetadata } from '@/lib/task-routing';
import { notFound } from "@/lib/api/responses";

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = await db.task.findUnique({
    where: { id },
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 20 } },
  });
  if (!task) return notFound('not_found');
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
  // Routing metadata normalisation (Franck 2026-04-29, ADR-0002).
  // Same shape contract as POST /api/task: tags accepts string[] or
  // pre-serialised JSON; inputsSchema accepts object or string;
  // empty/blank inputs collapse to null. Done here because PATCH
  // has no zod parse — we apply the same coercion before the DB
  // write so PUT/PATCH are not asymmetric.
  if ('description' in data) {
    if (typeof data.description === 'string') {
      data.description = data.description.trim() || null;
    }
  }
  if ('tags' in data) {
    if (Array.isArray(data.tags)) {
      const cleaned = (data.tags as unknown[])
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter(Boolean);
      data.tags = cleaned.length ? JSON.stringify(cleaned) : null;
    } else if (typeof data.tags === 'string') {
      const t = data.tags.trim();
      data.tags = t ? t : null;
    } else if (data.tags == null) {
      data.tags = null;
    }
  }
  if ('inputsSchema' in data) {
    if (data.inputsSchema && typeof data.inputsSchema === 'object') {
      data.inputsSchema = JSON.stringify(data.inputsSchema);
    } else if (typeof data.inputsSchema === 'string') {
      const t = data.inputsSchema.trim();
      data.inputsSchema = t ? t : null;
    } else if (data.inputsSchema == null) {
      data.inputsSchema = null;
    }
  }
  if ('sideEffects' in data && data.sideEffects != null && !isSideEffects(data.sideEffects)) {
    return NextResponse.json(
      { error: `invalid sideEffects: "${data.sideEffects}" (allowed: readonly|writes|pushes)` },
      { status: 400 },
    );
  }
  const routingIssues = validateRoutingMetadata({
    tags: typeof data.tags === 'string' ? data.tags : undefined,
    inputsSchema:
      typeof data.inputsSchema === 'string' ? data.inputsSchema : undefined,
  });
  if (routingIssues.length > 0) {
    return NextResponse.json(
      { error: `routing metadata invalid: ${routingIssues.map((i) => `${i.path}: ${i.message}`).join('; ')}` },
      { status: 400 },
    );
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
    select: { projectPath: true, schedule: true, pushEnabled: true },
  });
  if (!current) return notFound('not_found');
  const effective = {
    projectPath: 'projectPath' in data ? data.projectPath : current.projectPath,
    schedule: 'schedule' in data ? data.schedule : current.schedule,
    pushEnabled: 'pushEnabled' in data ? data.pushEnabled : current.pushEnabled,
  };
  if (effective.projectPath === null) {
    const issues: string[] = [];
    if (effective.schedule !== 'manual')
      issues.push('schedule must be "manual" for a generic task');
    if (effective.pushEnabled)
      issues.push('pushEnabled must be false for a generic task');
    if (issues.length > 0) {
      return NextResponse.json(
        { error: `generic task invariants violated: ${issues.join('; ')}` },
        { status: 400 },
      );
    }
  }
  // ADR-0008: strip the legacy `taskRunnerEnabled` field (column
  // dropped). The validator still accepts the key for backward
  // compat with old clients, but it must never reach the DB.
  const dataAny = data as { taskRunnerEnabled?: unknown };
  delete dataAny.taskRunnerEnabled;
  const task = await db.task.update({ where: { id }, data });
  await reloadScheduler();
  return NextResponse.json({ task });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // The `mandatory` flag used to protect auto-provisioned audit tasks
  // (subsystem removed 2026-04-22). The column stays as a generic
  // "please-do-not-delete" marker available for future use. Nothing
  // currently sets it, so this branch is effectively unreachable.
  const task = await db.task.findUnique({ where: { id }, select: { mandatory: true } });
  if (!task) return notFound('not_found');
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
