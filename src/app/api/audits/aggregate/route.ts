import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { listAuditDefaults } from '@/lib/audit/defaults';

export const runtime = 'nodejs';

/**
 * GET /api/audits/aggregate
 *
 * Cross-project audit digest (v5). One row per (project, category).
 * Each row carries its own category-level `score` and a points[]
 * list (max 5). Ordering is left to the client so it can re-sort
 * without roundtripping.
 *
 * Missing category templates are tolerated: we fall back to the
 * category key as label so an orphan audit row (template deleted)
 * still surfaces rather than disappearing silently.
 */
export async function GET() {
  const [advices, projects, defaults] = await Promise.all([
    db.projectAudit.findMany({ orderBy: { generatedAt: 'desc' } }),
    db.project.findMany({
      select: { id: true, name: true, gitUrl: true, branch: true },
    }),
    listAuditDefaults(),
  ]);

  const projByName = new Map(projects.map((p) => [p.name, p]));
  const tplByKey = new Map(defaults.map((d) => [d.key, d]));

  const items = advices
    .map((a) => {
      const proj = projByName.get(a.projectName);
      if (!proj) return null; // orphan (project deleted): skip
      const tpl = tplByKey.get(a.category);

      // v5 stored format: `{version:5, category, notes, points[]}`.
      // Tolerant decoder for anything else that may still be in DB
      // (shouldn't happen post-migration, but we don't want to 500).
      let points: unknown[] = [];
      let notes = '';
      try {
        const raw = JSON.parse(a.points);
        if (Array.isArray(raw)) {
          points = raw;
        } else if (raw && typeof raw === 'object') {
          points = Array.isArray(raw.points) ? raw.points : [];
          notes = typeof raw.notes === 'string' ? raw.notes : '';
        }
      } catch {
        /* malformed stored payload: surface an empty row rather than 500 */
      }
      return {
        projectId: proj.id,
        projectName: proj.name,
        category: a.category,
        label: tpl?.label ?? a.category,
        emoji: tpl?.emoji ?? '\uD83D\uDCCB',
        score: a.score ?? null,
        notes,
        generatedAt: a.generatedAt,
        points,
      };
    })
    .filter(Boolean);

  return NextResponse.json({
    items,
    counts: {
      projects: projects.length,
      advices: advices.length,
      withScore: advices.filter((a) => a.score !== null).length,
    },
  });
}
