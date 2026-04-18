import { NextResponse } from 'next/server';
import { runTask } from '@/lib/cron/runner';
export const runtime = 'nodejs';
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // fire-and-forget pour ne pas bloquer l'API
  void runTask(id);
  return NextResponse.json({ ok: true, triggered: id });
}
