import { NextResponse } from 'next/server';
import { getLogs, clearLogs } from '@/lib/logs/buffer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sinceRaw = searchParams.get('since');
  const since = sinceRaw ? Number(sinceRaw) : undefined;
  return NextResponse.json({ entries: getLogs(since) });
}

export async function DELETE() {
  clearLogs();
  return NextResponse.json({ ok: true });
}
