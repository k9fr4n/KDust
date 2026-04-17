import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { cloneOrPull } from '@/lib/git';
import { provisionAdviceCrons } from '@/lib/advice/provision';

export const runtime = 'nodejs';
// A fresh clone can easily take 30-90s on large repos; Next.js default
// serverless budget is too tight. We cap at 150s.
export const maxDuration = 150;

const Input = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9._-]+$/, 'nom doit matcher [a-zA-Z0-9._-]+'),
  gitUrl: z.string().min(5),
  branch: z.string().default('main'),
});

export async function GET() {
  const projects = await db.project.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json({ projects });
}

/**
 * Create a project and immediately `git clone` it onto disk so that:
 *   - the MCP fs server can mount a real directory on first /chat use;
 *   - bad git URLs / credentials / branch names surface at creation
 *     time instead of 30 minutes later during a scheduled cron;
 *   - the Mounted projects section on the dashboard stays in sync with
 *     what the DB holds.
 *
 * On clone failure, the DB row is KEPT with lastSyncStatus='failed' so
 * the user can fix the URL and retry via the Sync button. The response
 * carries a 502 + the git error so the creation form can display it.
 */
export async function POST(req: Request) {
  const parsed = Input.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.format() }, { status: 400 });

  let project;
  try {
    project = await db.project.create({ data: parsed.data });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return NextResponse.json({ error: 'name already used' }, { status: 409 });
    }
    throw err;
  }

  // Clone synchronously. If it fails, persist the failure and signal
  // the client with 502 + details — the row is left in place so the
  // user can resync after fixing the git URL / credentials.
  const res = await cloneOrPull(project.name, project.gitUrl, project.branch);
  const updated = await db.project.update({
    where: { id: project.id },
    data: {
      lastSyncAt: new Date(),
      lastSyncStatus: res.ok ? 'success' : 'failed',
      lastSyncError: res.ok ? null : (res.error ?? 'unknown git error'),
    },
  });

  if (!res.ok) {
    return NextResponse.json(
      {
        project: updated,
        error: res.error ?? 'git clone failed',
        output: res.output,
      },
      { status: 502 },
    );
  }

  // Provision the 5 mandatory weekly advisory crons (security, performance,
  // code_quality, improvement, documentation). Idempotent and non-blocking
  // from the user's POV — a provisioning failure (eg. Dust disconnected)
  // logs a warning but doesn't void the clone.
  try {
    await provisionAdviceCrons(project.name);
  } catch (err) {
    console.warn(
      `[projects/POST] advice cron provisioning failed for "${project.name}":`,
      err instanceof Error ? err.message : err,
    );
  }

  return NextResponse.json({ project: updated, output: res.output }, { status: 201 });
}
