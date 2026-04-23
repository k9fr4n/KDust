import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppConfig, updateAppConfig } from '@/lib/config';
export const runtime = 'nodejs';

// Wall-clock runtime caps: [30s, 6h] clamp (matches runner.ts).
// Out-of-range values are rejected at API level here (as opposed
// to silently ignored in runner.ts) so the settings page surfaces
// a clear error instead of saving a value that gets ignored.
const CLAMP_MIN_MS = 30 * 1000;
const CLAMP_MAX_MS = 6 * 60 * 60 * 1000;
const timeoutMs = z
  .number()
  .int()
  .min(CLAMP_MIN_MS, 'at least 30 seconds')
  .max(CLAMP_MAX_MS, 'at most 6 hours')
  .optional();

const Patch = z.object({
  dustBaseUrl: z.string().url().optional(),
  workosClientId: z.string().optional(),
  workosDomain: z.string().optional(),
  claimNamespace: z.string().optional(),
  defaultTeamsWebhook: z.string().url().nullable().optional(),
  leafRunTimeoutMs: timeoutMs,
  orchestratorRunTimeoutMs: timeoutMs,
});

export async function GET() {
  return NextResponse.json({ config: await getAppConfig() });
}
export async function PATCH(req: Request) {
  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  const updated = await updateAppConfig(parsed.data);
  return NextResponse.json({ config: updated });
}
