import { NextResponse } from 'next/server';
import { deleteSecretBinding } from '@/lib/mcp/gateway-repo';
import { badRequest, serverError } from '@/lib/api/responses';
import { errMessage } from '@/lib/errors';

export const runtime = 'nodejs';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; bindingId: string }> },
) {
  const { bindingId: bidStr } = await params;
  const bindingId = Number(bidStr);
  if (!Number.isInteger(bindingId) || bindingId <= 0)
    return badRequest('invalid bindingId');
  try {
    await deleteSecretBinding(bindingId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(errMessage(e));
  }
}
