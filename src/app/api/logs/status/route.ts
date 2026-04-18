import { NextResponse } from 'next/server';
import { getLogs } from '@/lib/logs/buffer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lightweight health endpoint polled by the header badge to decide
 * whether to paint the /logs icon red. Returns a summary only (no
 * log payloads) so it stays cheap at 10s poll rate.
 */
export async function GET() {
  const entries = getLogs();
  let errors = 0;
  let warnings = 0;
  let lastErrorTs: number | null = null;
  for (const e of entries) {
    if (e.level === 'error') {
      errors++;
      if (!lastErrorTs || e.ts > lastErrorTs) lastErrorTs = e.ts;
    } else if (e.level === 'warn') {
      warnings++;
    }
  }
  return NextResponse.json({
    total: entries.length,
    errors,
    warnings,
    lastErrorTs,
  });
}
