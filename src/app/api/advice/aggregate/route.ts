import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { listAdviceDefaults } from '@/lib/advice/defaults';

export const runtime = 'nodejs';

/**
 * GET /api/advice/aggregate
 *
 * Cross-project advice digest. Joins every ProjectAdvice row with its
 * Project (to expose id + display name) and its template (for label +
 * emoji). Ordering is left to the client so it can re-sort without
 * roundtripping (by worst score, then severity, then recency).
 *
 * Missing category templates are tolerated: we fall back to the
 * category key as label so an old advice row whose template was
 * deleted still surfaces (lightly) rather than disappearing.
 */
export async function GET() {
  const [advices, projects, defaults] = await Promise.all([
    db.projectAdvice.findMany({
      orderBy: { generatedAt: 'desc' },
    }),
    db.project.findMany({
      select: { id: true, name: true, gitUrl: true, branch: true },
    }),
    listAdviceDefaults(),
  ]);

  const projByName = new Map(projects.map((p) => [p.name, p]));
  const tplByKey = new Map(defaults.map((d) => [d.key, d]));

  const items = advices
    .map((a) => {
      const proj = projByName.get(a.projectName);
      if (!proj) return null; // orphan row (project deleted): skip
      const tpl = tplByKey.get(a.category);

      // Decode the stored `points` column. v4 wraps the payload in
      // `{version:4, points:[...], categoryScores:{...}}`. v3 (legacy)
      // stores the bare points array. Tolerate both shapes.
      let points: unknown[] = [];
      let categoryScores: Record<string, { score: number | null; notes: string }> = {};
      try {
        const raw = JSON.parse(a.points);
        if (Array.isArray(raw)) {
          points = raw;
        } else if (raw && typeof raw === 'object') {
          points = Array.isArray(raw.points) ? raw.points : [];
          categoryScores =
            raw.categoryScores && typeof raw.categoryScores === 'object'
              ? raw.categoryScores
              : {};
        }
      } catch {
        /* malformed stored payload: surface an empty row rather than 500 */
      }
      return {
        projectId: proj.id,
        projectName: proj.name,
        category: a.category,
        label: tpl?.label ?? a.category,
        emoji: tpl?.emoji ?? '📋',
        score: a.score ?? null,
        generatedAt: a.generatedAt,
        points,
        categoryScores,
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
