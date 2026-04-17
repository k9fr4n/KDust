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
  const exists = await db.project.findUnique({ where: { name: body.name } });
  if (!exists) return NextResponse.json({ error: 'unknown project' }, { status: 404 });

  store.set(CURRENT_PROJECT_COOKIE, body.name, {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return NextResponse.json({ current: body.name });
}
