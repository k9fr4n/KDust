import { NextResponse } from 'next/server';
import { z } from 'zod';
import { addSecretBinding } from '@/lib/mcp/gateway-repo';
import { badRequest, serverError } from '@/lib/api/responses';
import { errMessage } from '@/lib/errors';

export const runtime = 'nodejs';

const Body = z.object({
  secretKey: z.string().min(1).max(96),
  secretName: z.string().min(1).max(64),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await params;
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) return badRequest('invalid id');
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return badRequest(parsed.error.format());
  try {
    const row = await addSecretBinding({ mcpServerId: id, ...parsed.data });
    return NextResponse.json({ id: row.id }, { status: 201 });
  } catch (e) {
    const msg = errMessage(e);
    if (msg.includes('Unique')) return badRequest(`secretKey "${parsed.data.secretKey}" already bound on this server`);
    if (msg.includes('Foreign'))
      return badRequest(`Secret "${parsed.data.secretName}" does not exist (create it in /settings/secrets first)`);
    return serverError(msg);
  }
}
