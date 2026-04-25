import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { cloneOrPull } from '@/lib/git';

export const runtime = 'nodejs';
// A fresh clone can easily take 30-90s on large repos; Next.js default
// serverless budget is too tight. We cap at 150s.
export const maxDuration = 150;

// gitUrl: optional — empty / missing means sandbox mode.
// description: optional — surfaces on dashboards. Trimmed, max 500.
const Input = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9._-]+$/, 'nom doit matcher [a-zA-Z0-9._-]+'),
  gitUrl: z.string().optional().nullable(),
  branch: z.string().default('main'),
  description: z.string().max(500).optional().nullable(),
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

  // Normalize: empty gitUrl strings become null so the runtime
  // (sync / push pipeline / buildGitLinks) can use a single
  // "no remote" predicate instead of two (null OR "").
  const input = parsed.data as {
    name: string;
    gitUrl?: string | null;
    branch: string;
    description?: string | null;
  };
  const data = {
    name: input.name,
    gitUrl: input.gitUrl && input.gitUrl.trim() ? input.gitUrl.trim() : null,
    branch: input.branch,
    description: input.description ? input.description.trim() || null : null,
  };

  let project;
  try {
    project = await db.project.create({ data });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return NextResponse.json({ error: 'name already used' }, { status: 409 });
    }
    throw err;
  }

  // Sandbox project (no git remote) — ensure the local dir exists
  // so MCP fs tools can still read/write, but skip the clone.
  if (!project.gitUrl) {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { PROJECTS_ROOT } = await import('@/lib/projects');
    await mkdir(join(PROJECTS_ROOT, project.name), { recursive: true });
    return NextResponse.json({ project, sandbox: true });
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

  // Audit task auto-provisioning was removed on 2026-04-22. Audits are
  // now handled via user-created generic tasks invoked per project by
  // an orchestrator (run_task(project=...)). New projects are shipped
  // empty — the user wires them up from /task/new.

  return NextResponse.json({ project: updated, output: res.output }, { status: 201 });
}
