import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { CURRENT_PROJECT_COOKIE } from '@/lib/current-project';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET() {
  const store = await cookies();
  return NextResponse.json({ current: store.get(CURRENT_PROJECT_COOKIE)?.value ?? null });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { name: string | null };
  const store = await cookies();

  if (!body.name) {
    store.delete(CURRENT_PROJECT_COOKIE);
    return NextResponse.json({ current: null });
  }

  // Phase 1 folder hierarchy (2026-04-27): the cookie now stores the
  // project's full fsPath ("L1/L2/leaf"). Callers may legitimately
  // post either fsPath (new clients) or leaf name (legacy clients).
  // Resolve in that order; once we found a match, persist the
  // canonical fsPath so subsequent reads agree with all the
  // projectPath / projectName joins server-side.
  let exists = await db.project.findUnique({ where: { fsPath: body.name } });
  if (!exists) exists = await db.project.findFirst({ where: { name: body.name } });
  if (!exists) return NextResponse.json({ error: 'unknown project' }, { status: 404 });

  const value = exists.fsPath ?? exists.name;
  store.set(CURRENT_PROJECT_COOKIE, value, {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return NextResponse.json({ current: value });
}
