import { NextResponse } from 'next/server';
import { getCurrentProjectName } from '@/lib/current-project';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * GET /api/projects/current
 *
 * Returns the current-project cookie value plus the resolved
 * Project row (or null fields when no project is selected).
 *
 * Extended 2026-04-19 (Franck) to also return `defaultAgentSId`
 * so the chat page and the new-task form can fall back to the
 * project’s default agent without a second round-trip. Older
 * callers that only read `name` keep working unchanged.
 *
 * Phase 1 folder hierarchy (Franck 2026-04-27): the cookie now
 * carries a `fsPath` ("L1/L2/leaf") rather than the leaf name.
 * Resolve fsPath first (post-migration standard); fall back to
 * a name-only findFirst() to absorb legacy cookies set before
 * the migration. Since `name` is no longer @unique we cannot
 * use findUnique({ where: { name } }) anymore.
 */
export async function GET() {
  const value = await getCurrentProjectName();
  if (!value) {
    return NextResponse.json({ name: null, project: null });
  }
  const select = {
    id: true,
    name: true,
    fsPath: true,
    defaultAgentSId: true,
    description: true,
  } as const;
  let project = await db.project.findUnique({ where: { fsPath: value }, select });
  if (!project) {
    project = await db.project.findFirst({ where: { name: value }, select });
  }
  return NextResponse.json({ name: value, project });
}
