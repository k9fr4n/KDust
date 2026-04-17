import { NextResponse } from 'next/server';
import { getDustClient } from '@/lib/dust/client';

export const runtime = 'nodejs';

export async function GET() {
  const d = await getDustClient();
  if (!d) return NextResponse.json({ error: 'not_connected' }, { status: 401 });
  const res = await d.client.getAgentConfigurations({ view: 'list' } as any);
  if (res.isErr()) return NextResponse.json({ error: res.error.message }, { status: 500 });
  const agents = res.value.map((a: any) => ({
    sId: a.sId,
    name: a.name,
    description: a.description,
    pictureUrl: a.pictureUrl,
  }));
  return NextResponse.json({ agents });
}
