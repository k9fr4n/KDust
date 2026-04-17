import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cloneOrPull } from '@/lib/git';

export const runtime = 'nodejs';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = await db.project.findUnique({ where: { id } });
  if (!p) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const res = await cloneOrPull(p.name, p.gitUrl, p.branch);
  await db.project.update({
    where: { id },
    data: {
      lastSyncAt: new Date(),
      lastSyncStatus: res.ok ? 'success' : 'failed',
      lastSyncError: res.ok ? null : res.error ?? 'unknown',
    },
  });
  return NextResponse.json(res, { status: res.ok ? 200 : 500 });
}
