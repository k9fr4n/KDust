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
    const serverId = await getFsServerId(parsed.data.projectName);
    return NextResponse.json({ serverId, projectName: parsed.data.projectName });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
