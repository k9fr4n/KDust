import { NextResponse } from 'next/server';
import { issueSession, setSessionCookie } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return NextResponse.json({ error: 'APP_PASSWORD not configured' }, { status: 500 });
  }
  if (password !== expected) {
    return NextResponse.json({ error: 'invalid credentials' }, { status: 401 });
  }
  const token = await issueSession();
  await setSessionCookie(token);
  return NextResponse.json({ ok: true });
}
