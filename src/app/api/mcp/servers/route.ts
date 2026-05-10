import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listServers, createServer } from '@/lib/mcp/gateway-repo';
import { badRequest, serverError } from '@/lib/api/responses';
import { errMessage } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const servers = await listServers();
    return NextResponse.json({ servers });
  } catch (e) {
    return serverError(errMessage(e));
  }
}

const CreateBody = z.object({
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  description: z.string().max(512).nullable().optional(),
  imageRef: z.string().max(256).nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function POST(req: Request) {
  const parsed = CreateBody.safeParse(await req.json());
  if (!parsed.success) return badRequest(parsed.error.format());
  try {
    const row = await createServer(parsed.data);
    return NextResponse.json({ id: row.id, slug: row.slug }, { status: 201 });
  } catch (e) {
    const msg = errMessage(e);
    if (msg.includes('Unique')) return badRequest(`Slug "${parsed.data.slug}" already exists`);
    return serverError(msg);
  }
}
