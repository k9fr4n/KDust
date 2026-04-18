import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { reloadScheduler } from '@/lib/cron/scheduler';
import { isValidCronExpression } from '@/lib/cron/validator';

export const runtime = 'nodejs';

/**
 * Shared cron-expression refinement: 'manual' is a pseudo-value
 * meaning "never auto-fire" (the task can only be launched from
 * the UI / API). Anything else must be a valid 5-field cron per
 * cron-parser. Invalid strings are rejected at create/patch time,
 * preventing silent misconfiguration where a typo disables the
 * schedule without any error feedback.
 */
const cronSchedule = z
  .string()
  .default('manual')
  .refine((s) => s === 'manual' || isValidCronExpression(s), {
    message: 'must be "manual" or a valid cron expression (e.g. "0 3 * * 1")',
  });

/**
 * Zod input for Task create. `schedule`/`timezone` are now real
 * inputs again since the scheduler was reinstated on 2026-04-19:
 *   - schedule: 'manual' or a valid cron expression (cronSchedule)
 *   - timezone: IANA zone name (not validated strictly; croner is
 *     permissive and invalid zones fall back to UTC at runtime)
 *
 * `pushEnabled` is the master switch for the whole post-agent git
 * pipeline (branch/commit/push + prompt footer enrichment). See
 * src/lib/cron/runner.ts buildAutomationPrompt() for the exact
 * semantics.
 */
const TaskInput = z.object({
  name: z.string().min(1),
  schedule: cronSchedule,
  timezone: z.string().default('Europe/Paris'),
  agentSId: z.string().min(1),
  agentName: z.string().optional().nullable(),
  prompt: z.string().min(1),
  projectPath: z.string().min(1),
  teamsWebhook: z.string().url().optional().nullable(),
  enabled: z.boolean().default(true),
  // automation-push settings
  pushEnabled: z.boolean().default(true),
  baseBranch: z.string().min(1).default('main'),
  branchMode: z.enum(['timestamped', 'stable']).default('timestamped'),
  branchPrefix: z.string().min(1).default('kdust'),
  dryRun: z.boolean().default(false),
  maxDiffLines: z.number().int().positive().default(2000),
  protectedBranches: z.string().default('main,master,develop,production,prod'),
});

export async function GET() {
  const tasks = await db.task.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json({ tasks });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = TaskInput.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  const task = await db.task.create({ data: parsed.data });
  // Arm the scheduler so a newly-created cron-scheduled task starts
  // firing immediately without requiring a server restart.
  await reloadScheduler();
  return NextResponse.json({ task });
}
