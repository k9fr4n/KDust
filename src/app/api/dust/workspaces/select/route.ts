import { NextResponse } from 'next/server';
import { saveWorkspaceId } from '@/lib/dust/tokens';
import { badRequest } from "@/lib/api/responses";
export const runtime = 'nodejs';
export async function POST(req: Request) {
  const { workspaceId } = (await req.json()) as { workspaceId: string };
  if (!workspaceId) return badRequest('workspaceId required');
  await saveWorkspaceId(workspaceId);
  return NextResponse.json({ ok: true });
}
