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
  // Nullable since 2026-04-22: projectPath=null marks a generic
  // (template) task. Generic tasks can only be invoked via run_task
  // with a `project` argument. Additional invariants are enforced
  // in the refinement below (no cron, no push, no orchestrator).
  projectPath: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  teamsWebhook: z.string().url().optional().nullable(),
  // See settings/route.ts for the rationale on free-text validation.
  telegramChatId: z.string().optional().nullable(),
  // Notification toggles default to true server-side (Prisma
  // schema DEFAULT) so omitting them on POST keeps the
  // notify-when-target-resolvable behaviour.
  teamsNotifyEnabled: z.boolean().optional(),
  telegramNotifyEnabled: z.boolean().optional(),
  enabled: z.boolean().default(true),
  // automation-push settings
  pushEnabled: z.boolean().default(true),
  // Orchestration opt-in (Franck 2026-04-20 22:58). When true, the
  // runner attaches the task-runner MCP server to this task's agent
  // so it can invoke other tasks via run_task. Default false: the
  // vast majority of tasks are plain workers; only a dedicated
  // "orchestrator" should set this.
  taskRunnerEnabled: z.boolean().default(false),
  // Per-task wall-clock runtime cap in ms. Null = inherit env
  // defaults (KDUST_ORCHESTRATOR_TIMEOUT_MS or KDUST_RUN_TIMEOUT_MS).
  // Clamp to [30s, 6h] applied in runner.ts — out-of-range values
  // here are accepted but silently ignored at dispatch time.
  maxRuntimeMs: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .transform((v) => (v == null ? null : v)),
  // Command-runner opt-in (Franck 2026-04-21 13:39). When true, the
  // runner attaches the command-runner MCP server, giving the agent
  // `run_command` (KDust-side, persisted in Command table, denylist
  // enforced). Orthogonal to taskRunnerEnabled \u2014 a task can have
  // either, both, or neither.
  commandRunnerEnabled: z.boolean().default(false),
  // Phase 1 (2026-04-19): branch fields are optional overrides.
  // NULL / omitted \u2192 inherit from the parent Project row. An
  // empty string on the wire is coerced to null so "clear override"
  // from the UI works without a special sentinel.
  baseBranch: z.string().nullable().optional().transform((v) => (v ? v : null)),
  branchMode: z.enum(['timestamped', 'stable']).default('timestamped'),
  branchPrefix: z.string().nullable().optional().transform((v) => (v ? v : null)),
  dryRun: z.boolean().default(false),
  maxDiffLines: z.number().int().positive().default(2000),
  protectedBranches: z.string().nullable().optional().transform((v) => (v ? v : null)),
}).superRefine((v, ctx) => {
  // Generic-task invariants (Franck 2026-04-22).
  // A task with projectPath=null is a reusable template dispatched
  // by run_task(project=...). It cannot be auto-scheduled (the cron
  // scheduler has no project context) and cannot push (no git pipeline
  // without a project). The orchestrator flag is forbidden because
  // generics are leaves in the invocation tree, not roots.
  if (v.projectPath === null) {
    if (v.schedule !== 'manual') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule'],
        message: 'generic tasks must use schedule="manual" (no project context for cron)',
      });
    }
    if (v.pushEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pushEnabled'],
        message: 'generic tasks must have pushEnabled=false (no git pipeline without a project)',
      });
    }
    // Generic orchestrators are allowed (Franck 2026-04-22 19:47).
    // A generic task invoked with a project argument carries the
    // override all the way down: nested run_task calls inherit the
    // orchestrator's resolved project (see task-runner-server.ts).
    // MAX_DEPTH still bounds the chain. The previous refusal
    // blocked legitimate reusable orchestration templates.
  }
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
