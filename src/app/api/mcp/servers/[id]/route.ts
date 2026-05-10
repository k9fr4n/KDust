import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateServer, deleteServer } from '@/lib/mcp/gateway-repo';
import { badRequest, serverError } from '@/lib/api/responses';
import { errMessage } from '@/lib/errors';

export const runtime = 'nodejs';

function parseId(idStr: string): number | null {
  const n = Number(idStr);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const PatchBody = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(512).nullable().optional(),
  imageRef: z.string().max(256).nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await params;
  const id = parseId(idStr);
  if (!id) return badRequest('invalid id');
  const parsed = PatchBody.safeParse(await req.json());
  if (!parsed.success) return badRequest(parsed.error.format());
  try {
    await updateServer(id, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(errMessage(e));
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await params;
  const id = parseId(idStr);
  if (!id) return badRequest('invalid id');
  try {
    await deleteServer(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(errMessage(e));
  }
}
