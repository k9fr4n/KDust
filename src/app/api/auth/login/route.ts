import { NextResponse } from 'next/server';
import { issueSession, setSessionCookie } from '@/lib/session';
import { serverError, unauthorized } from "@/lib/api/responses";

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return serverError('APP_PASSWORD not configured');
  }
  if (password !== expected) {
    return unauthorized('invalid credentials');
  }
  const token = await issueSession();
  await setSessionCookie(token);
  return NextResponse.json({ ok: true });
}
