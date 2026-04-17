import { NextResponse } from 'next/server';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { PROJECTS_ROOT } from '@/lib/projects';

export const runtime = 'nodejs';

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const deleteFiles = url.searchParams.get('deleteFiles') === '1';

  const p = await db.project.findUnique({ where: { id } });
  if (!p) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  if (deleteFiles) {
    try {
      await rm(join(PROJECTS_ROOT, p.name), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  await db.project.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
