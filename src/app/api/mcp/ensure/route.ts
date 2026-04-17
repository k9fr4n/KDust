import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getFsServerId } from '@/lib/mcp/registry';

export const runtime = 'nodejs';

const Body = z.object({ projectName: z.string().min(1) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });

  try {
    console.log(`[api/mcp/ensure] requested for project="${parsed.data.projectName}"`);
    const serverId = await getFsServerId(parsed.data.projectName);
    console.log(`[api/mcp/ensure] serverId=${serverId} project="${parsed.data.projectName}"`);
    return NextResponse.json({ serverId, projectName: parsed.data.projectName });
  } catch (e: any) {
    console.error(`[api/mcp/ensure] failed project="${parsed.data.projectName}":`, e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
