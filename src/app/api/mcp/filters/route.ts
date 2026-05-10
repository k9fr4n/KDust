import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listFilters, upsertFilter, deleteFilter } from '@/lib/mcp/gateway-repo';
import { badRequest, serverError } from '@/lib/api/responses';
import { errMessage } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const projectFsPath =
    new URL(req.url).searchParams.get('projectFsPath') ?? undefined;
  try {
    const filters = await listFilters(projectFsPath);
    return NextResponse.json({ filters });
  } catch (e) {
    return serverError(errMessage(e));
  }
}

const PutBody = z.object({
  projectFsPath: z.string().min(1),
  mcpServerId: z.number().int().positive(),
  allowedTools: z.array(z.string().min(1).max(128)),
});

export async function PUT(req: Request) {
  const parsed = PutBody.safeParse(await req.json());
  if (!parsed.success) return badRequest(parsed.error.format());
  try {
    const row = await upsertFilter(parsed.data);
    return NextResponse.json({ id: row.id, count: parsed.data.allowedTools.length });
  } catch (e) {
    return serverError(errMessage(e));
  }
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) return badRequest('invalid id');
  try {
    await deleteFilter(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError(errMessage(e));
  }
}
