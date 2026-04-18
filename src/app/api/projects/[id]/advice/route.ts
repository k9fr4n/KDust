import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { listEnabledAdviceDefaults } from '@/lib/advice/defaults';

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

  const [defaults, advices, tasks] = await Promise.all([
    listEnabledAdviceDefaults(),
    db.projectAdvice.findMany({ where: { projectName: project.name } }),
    db.task.findMany({
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

  // Return one slot per enabled template, ordered by template.sortOrder
  // so the dashboard is consistent across projects. Each slot carries
  // the template's label/emoji so the UI doesn't need to join client-side.
  const slots = defaults.map((def) => {
    const adv = advices.find((a) => a.category === def.key);
    const cron = tasks.find((c) => c.category === def.key);
    let points: unknown = null;
    if (adv) {
      try {
        points = JSON.parse(adv.points);
      } catch {
        points = null;
      }
    }
    return {
      category: def.key,
      label: def.label,
      emoji: def.emoji,
      points,
      score: adv?.score ?? null,
      generatedAt: adv?.generatedAt ?? null,
      task: cron
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
  });

  return NextResponse.json({ projectName: project.name, slots });
}
