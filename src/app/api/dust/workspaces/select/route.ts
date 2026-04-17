import { NextResponse } from 'next/server';
import { saveWorkspaceId } from '@/lib/dust/tokens';
export const runtime = 'nodejs';
export async function POST(req: Request) {
  const { workspaceId } = (await req.json()) as { workspaceId: string };
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId required' }, { status: 400 });
  await saveWorkspaceId(workspaceId);
  return NextResponse.json({ ok: true });
}
