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
 * project\u2019s default agent without a second round-trip. Older
 * callers that only read `name` keep working unchanged.
 */
export async function GET() {
  const name = await getCurrentProjectName();
  if (!name) {
    return NextResponse.json({ name: null, project: null });
  }
  const project = await db.project.findUnique({
    where: { name },
    select: {
      id: true,
      name: true,
      defaultAgentSId: true,
      description: true,
    },
  });
  return NextResponse.json({ name, project });
}
