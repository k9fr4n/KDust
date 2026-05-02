import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { reloadScheduler } from '@/lib/cron/scheduler';
import { isValidCronExpression } from '@/lib/cron/validator';
import { validateRoutingMetadata } from '@/lib/task-routing';
import { badRequest } from "@/lib/api/responses";

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
  // ADR-0008 (2026-05-02): the legacy `taskRunnerEnabled` toggle
  // was removed. The task-runner MCP server is now attached
  // unconditionally; the field is silently accepted but ignored
  // for backwards compatibility with older clients still posting
  // the boolean.
  taskRunnerEnabled: z.boolean().optional(),
  // Per-task wall-clock runtime cap in ms. Null = inherit
  // AppConfig.leafRunTimeoutMs (default 30min). Clamp to
  // [30s, 6h] applied in runner.ts \u2014 out-of-range values here
  // are accepted but silently ignored at dispatch time.
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
  // enforced).
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
  // Routing metadata (Franck 2026-04-29, ADR-0002). Optional fields
  // surfaced by the task-runner MCP server (list_tasks /
  // describe_task) so an agent picking its successor via
  // enqueue_followup can choose the right task without parsing
  // the prompt. Validation:
  //   - description : free text, trimmed; empty => null
  //   - tags        : array of strings on the wire OR JSON-encoded
  //                   string; stored as JSON-encoded string for
  //                   SQLite friendliness (same convention as
  //                   Message.toolNames). Empty list => null.
  //   - inputsSchema: JSON Schema as object/string; stored as
  //                   serialised JSON string. Must be valid JSON.
  //   - sideEffects : 'readonly' | 'writes' | 'pushes', default
  //                   'writes' (conservative).
  description: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  tags: z
    .union([z.array(z.string()), z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v == null) return null;
      if (Array.isArray(v)) {
        const cleaned = v.map((s) => s.trim()).filter(Boolean);
        return cleaned.length ? JSON.stringify(cleaned) : null;
      }
      const t = v.trim();
      return t ? t : null;
    }),
  inputsSchema: z
    .union([z.record(z.unknown()), z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v == null) return null;
      if (typeof v === 'object') return JSON.stringify(v);
      const t = v.trim();
      return t ? t : null;
    }),
  sideEffects: z.enum(['readonly', 'writes', 'pushes']).default('writes'),
}).superRefine((v, ctx) => {
  // Routing metadata sanity (ADR-0002). Runs before generic-task
  // invariants because the same payload is rejected for both
  // reasons in worst case; surfacing both helps the UI.
  const issues = validateRoutingMetadata({
    tags: v.tags,
    inputsSchema: v.inputsSchema,
  });
  for (const it of issues) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [it.path], message: it.message });
  }
}).superRefine((v, ctx) => {
  // Generic-task invariants (Franck 2026-04-22).
  // A task with projectPath=null is a reusable template enqueued
  // via enqueue_followup({ project: ... }). It cannot be auto-
  // scheduled (the cron scheduler has no project context) and
  // cannot push (no git pipeline without a project).
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
    // ADR-0008 (2026-05-02) collapsed the orchestrator role:
    // every task can enqueue a successor, generic or not.
  }
});

export async function GET() {
  const tasks = await db.task.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json({ tasks });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = TaskInput.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.format());
  // ADR-0008: strip the legacy `taskRunnerEnabled` field before
  // hitting the DB \u2014 the column was dropped, but the validator
  // still accepts the key for backward compat with old clients.
  const { taskRunnerEnabled: _legacyTaskRunner, ...createData } = parsed.data;
  void _legacyTaskRunner;
  const task = await db.task.create({ data: createData });
  // Arm the scheduler so a newly-created cron-scheduled task starts
  // firing immediately without requiring a server restart.
  await reloadScheduler();
  return NextResponse.json({ task });
}
