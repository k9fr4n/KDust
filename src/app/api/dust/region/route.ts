import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadTokens } from '@/lib/dust/tokens';

export const runtime = 'nodejs';

export async function GET() {
  const s = await loadTokens();
  return NextResponse.json({ region: s?.region ?? null, workspaceId: s?.workspaceId ?? null });
}

export async function POST(req: Request) {
  const { region } = (await req.json()) as { region: string };
  if (!['us-central1', 'europe-west1'].includes(region)) {
    return NextResponse.json({ error: 'invalid region' }, { status: 400 });
  }
  await db.dustSession.update({ where: { id: 1 }, data: { region } });
  return NextResponse.json({ ok: true, region });
}
