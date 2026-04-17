import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ADVICE_CATEGORIES, type AdviceCategory } from '@/lib/advice/categories';

export const runtime = 'nodejs';

/**
 * GET /api/projects/:id/advice
 *
 * Returns the latest advice row per category for a project, plus the
 * associated cron job metadata (schedule, lastRunAt, lastStatus) so
 * the dashboard can show "next run in X days" / "generation failed".
 *
 * Missing categories return null so the UI can render a placeholder
 * ("Pas encore d'analyse") instead of an empty slot.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const [advices, crons] = await Promise.all([
    db.projectAdvice.findMany({ where: { projectName: project.name } }),
    db.cronJob.findMany({
      where: { projectPath: project.name, kind: 'advice' },
      select: {
        id: true,
        category: true,
        schedule: true,
        enabled: true,
        lastRunAt: true,
        lastStatus: true,
        mandatory: true,
      },
    }),
  ]);

  const byCategory: Record<string, unknown> = {};
  for (const cat of ADVICE_CATEGORIES) {
    const adv = advices.find((a) => a.category === cat);
    const cron = crons.find((c) => c.category === cat);
    let points: unknown = null;
    if (adv) {
      try {
        points = JSON.parse(adv.points);
      } catch {
        points = null;
      }
    }
    byCategory[cat] = {
      category: cat as AdviceCategory,
      points,
      generatedAt: adv?.generatedAt ?? null,
      cron: cron
        ? {
            id: cron.id,
            schedule: cron.schedule,
            enabled: cron.enabled,
            lastRunAt: cron.lastRunAt,
            lastStatus: cron.lastStatus,
            mandatory: cron.mandatory,
          }
        : null,
    };
  }

  return NextResponse.json({ projectName: project.name, advice: byCategory });
}
