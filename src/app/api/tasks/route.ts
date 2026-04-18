import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * Zod input for Task create. `schedule` and `timezone` are legacy
 * columns kept in DB for back-compat but no longer exposed in the UI
 * (tasks are manual-trigger only since v2). They default here to sane
 * placeholders so clients that omit them still succeed.
 */
const TaskInput = z.object({
  name: z.string().min(1),
  schedule: z.string().default('manual'),
  timezone: z.string().default('Europe/Paris'),
  agentSId: z.string().min(1),
  agentName: z.string().optional().nullable(),
  prompt: z.string().min(1),
  projectPath: z.string().min(1),
  teamsWebhook: z.string().url().optional().nullable(),
  enabled: z.boolean().default(true),
  // automation-push settings
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
  return NextResponse.json({ task });
}
