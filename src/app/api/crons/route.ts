import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { isValidCronExpression } from '@/lib/cron/validator';
import { reloadScheduler } from '@/lib/cron/scheduler';

export const runtime = 'nodejs';

const CronInput = z.object({
  name: z.string().min(1),
  schedule: z.string().min(1),
  timezone: z.string().default('Europe/Paris'),
  agentSId: z.string().min(1),
  agentName: z.string().optional().nullable(),
  prompt: z.string().min(1),
  projectPath: z.string().min(1),
  teamsWebhook: z.string().url().optional().nullable(),
  enabled: z.boolean().default(true),
});

export async function GET() {
  const crons = await db.cronJob.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json({ crons });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = CronInput.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  if (!isValidCronExpression(parsed.data.schedule)) {
    return NextResponse.json({ error: 'invalid cron expression' }, { status: 400 });
  }
  const cron = await db.cronJob.create({ data: parsed.data });
  await reloadScheduler();
  return NextResponse.json({ cron });
}
