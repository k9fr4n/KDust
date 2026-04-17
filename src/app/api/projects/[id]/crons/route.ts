import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * GET /api/projects/:id/crons
 *
 * List every CronJob attached to a project. Used by the project
 * dashboard (/projects/:id) to let the user jump to /crons/:id for
 * schedule/prompt edits.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const crons = await db.cronJob.findMany({
    where: { projectPath: project.name },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      schedule: true,
      timezone: true,
      kind: true,
      category: true,
      mandatory: true,
      enabled: true,
      lastRunAt: true,
      lastStatus: true,
    },
  });
  return NextResponse.json({ projectName: project.name, crons });
}
