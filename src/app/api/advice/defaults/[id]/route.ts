import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { isValidCronExpression } from '@/lib/cron/validator';
import { deleteCategoryEverywhere } from '@/lib/advice/provision';

export const runtime = 'nodejs';

const PatchInput = z.object({
  label: z.string().min(1).max(60).optional(),
  emoji: z.string().min(1).max(8).optional(),
  prompt: z.string().min(20).optional(),
  schedule: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = PatchInput.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  if (parsed.data.schedule && !isValidCronExpression(parsed.data.schedule)) {
    return NextResponse.json({ error: 'schedule: invalid cron expression' }, { status: 400 });
  }
  // Note: we DO NOT overwrite existing per-project Task rows here.
  // Template edits only affect future provisioning. The user can click
  // "Propager" explicitly if they want to push a new prompt/schedule
  // to every project (see POST /propagate).
  const updated = await db.adviceCategoryDefault.update({
    where: { id },
    data: parsed.data,
  });
  return NextResponse.json({ default: updated });
}

/**
 * DELETE /api/advice/defaults/:id
 *
 * Forbidden on built-in templates (user should disable instead). For
 * custom templates, cascades: all Task+ProjectAdvice rows with the
 * matching category slug are deleted too. Set ?cascade=0 to keep them.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const cascade = url.searchParams.get('cascade') !== '0';
  const def = await db.adviceCategoryDefault.findUnique({ where: { id } });
  if (!def) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (def.builtIn) {
    return NextResponse.json(
      { error: 'built-in template: cannot be deleted (disable it instead)' },
      { status: 403 },
    );
  }
  let cascadeStats = { tasks: 0, advices: 0 };
  if (cascade) {
    cascadeStats = await deleteCategoryEverywhere(def.key);
  }
  await db.adviceCategoryDefault.delete({ where: { id } });
  return NextResponse.json({ ok: true, cascade: cascadeStats });
}
