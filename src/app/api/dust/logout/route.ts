import { NextResponse } from 'next/server';
import { clearTokens } from '@/lib/dust/tokens';
export const runtime = 'nodejs';
export async function POST() {
  await clearTokens();
  return NextResponse.json({ ok: true });
}
