import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { isValidCronExpression } from '@/lib/cron/validator';
import { listAuditDefaults } from '@/lib/audit/defaults';
import { propagateCategoryToAllProjects } from '@/lib/audit/provision';

export const runtime = 'nodejs';

const CreateInput = z.object({
  key: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'slug doit matcher ^[a-z][a-z0-9_]*$'),
  label: z.string().min(1).max(60),
  emoji: z.string().min(1).max(8).default('📋'),
  prompt: z.string().min(20),
  // 'manual' accepted as a sentinel: KDust v2 removed the scheduler,
  // audit tasks are manual-trigger only. Kept in schema for legacy
  // rows still carrying a cron expression.
  schedule: z.string().min(1).default('manual'),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().optional(),
});

export async function GET() {
  const defaults = await listAuditDefaults();
  return NextResponse.json({ defaults });
}

/**
 * POST /api/audits/defaults
 *
 * Create a new (custom) audit category. Automatically provisions it
 * on every existing project in the same transaction — see SRS choice:
 * adding a template is meant to be instantly visible everywhere.
 */
export async function POST(req: Request) {
  const parsed = CreateInput.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  const d = parsed.data;
  // 'manual' short-circuits the cron validator (no scheduler anyway).
  if (d.schedule !== 'manual' && !isValidCronExpression(d.schedule)) {
    return NextResponse.json({ error: 'schedule: invalid cron expression' }, { status: 400 });
  }
  try {
    const created = await db.auditCategoryDefault.create({
      data: {
        key: d.key,
        label: d.label,
        emoji: d.emoji,
        prompt: d.prompt,
        schedule: d.schedule,
        enabled: d.enabled,
        sortOrder: d.sortOrder ?? 100,
        builtIn: false,
      },
    });
    // Fan out to existing projects immediately. Best-effort — if Dust
    // is disconnected the user can retry via the "Propager" button.
    const provisioned = await propagateCategoryToAllProjects(d.key).catch((e) => {
      console.warn(`[audit/defaults] post-create propagation failed:`, e);
      return 0;
    });
    return NextResponse.json({ default: created, provisioned }, { status: 201 });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return NextResponse.json({ error: `key "${d.key}" already in use` }, { status: 409 });
    }
    throw err;
  }
}
