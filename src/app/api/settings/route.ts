import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAppConfig, updateAppConfig } from '@/lib/config';
export const runtime = 'nodejs';

const Patch = z.object({
  dustBaseUrl: z.string().url().optional(),
  workosClientId: z.string().optional(),
  workosDomain: z.string().optional(),
  claimNamespace: z.string().optional(),
  defaultTeamsWebhook: z.string().url().nullable().optional(),
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
