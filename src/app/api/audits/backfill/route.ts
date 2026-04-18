import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { provisionAuditCrons } from '@/lib/audit/provision';

export const runtime = 'nodejs';

/**
 * POST /api/audits/backfill
 *
 * One-shot endpoint to retro-fit the 5 mandatory advisory tasks on
 * projects that existed BEFORE this feature shipped. Idempotent: calls
 * provisionAuditCrons() per project, which only creates the categories
 * still missing.
 *
 * Returns { created, perProject: { name: count } }.
 */
export async function POST() {
  const projects = await db.project.findMany();
  let total = 0;
  const perProject: Record<string, number> = {};
  for (const p of projects) {
    try {
      const n = await provisionAuditCrons(p.name);
      perProject[p.name] = n;
      total += n;
    } catch (err) {
      perProject[p.name] = -1;
      console.warn(
        `[audit/backfill] failed for "${p.name}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return NextResponse.json({ created: total, perProject });
}
