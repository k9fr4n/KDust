import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { cloneOrPull } from '@/lib/git';
import { computeProjectFsPath } from '@/lib/folder-path';
import { badRequest, conflict } from "@/lib/api/responses";
import { errCode } from '@/lib/errors';

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
  // Folder hierarchy (Franck 2026-04-27, Phase 1). Optional during
  // Phase 1 — when omitted the project is auto-placed under
  // legacy/uncategorized so the dashboard never has unrouted rows.
  // Phase 2 ships the folder picker UI and tightens this to required.
  folderId: z.string().optional().nullable(),
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
  if (!parsed.success) return badRequest(parsed.error.format());

  // Normalize: empty gitUrl strings become null so the runtime
  // (sync / push pipeline / buildGitLinks) can use a single
  // "no remote" predicate instead of two (null OR "").
  const input = parsed.data as {
    name: string;
    gitUrl?: string | null;
    branch: string;
    description?: string | null;
    folderId?: string | null;
  };

  // ---- Folder resolution (Phase 1, Franck 2026-04-27) ----
  // If the caller provided a folderId, validate it is a depth-2 leaf.
  // Otherwise default to legacy/uncategorized (creating both folders
  // on first call). Computed here so we can reject early on bad input
  // BEFORE creating the Project row + cloning the repo.
  let folderId: string;
  if (input.folderId) {
    const f = await db.folder.findUnique({
      where: { id: input.folderId },
      include: { parent: true },
    });
    if (!f) {
      return badRequest('unknown folderId');
    }
    // Only L2 (parent != null, parent.parentId == null) folders may
    // host projects. Reject L1 / deeper.
    if (!f.parent || f.parent.parentId !== null) {
      return NextResponse.json(
        { error: 'projects must be placed in a depth-2 (leaf) folder' },
        { status: 400 },
      );
    }
    folderId = f.id;
  } else {
    let l1 = await db.folder.findFirst({ where: { name: 'legacy', parentId: null } });
    if (!l1) l1 = await db.folder.create({ data: { name: 'legacy', parentId: null } });
    let l2 = await db.folder.findFirst({ where: { name: 'uncategorized', parentId: l1.id } });
    if (!l2) l2 = await db.folder.create({ data: { name: 'uncategorized', parentId: l1.id } });
    folderId = l2.id;
  }

  const fsPath = await computeProjectFsPath(folderId, input.name);
  const data = {
    name: input.name,
    folderId,
    fsPath,
    gitUrl: input.gitUrl && input.gitUrl.trim() ? input.gitUrl.trim() : null,
    branch: input.branch,
    description: input.description ? input.description.trim() || null : null,
  };

  let project;
  try {
    project = await db.project.create({ data });
  } catch (err: unknown) {
    if (errCode(err) === 'P2002') {
      return conflict('name already used in this folder');
    }
    throw err;
  }

  // Sandbox project (no git remote) — ensure the local dir exists
  // so MCP fs tools can still read/write, but skip the clone.
  if (!project.gitUrl) {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { PROJECTS_ROOT } = await import('@/lib/projects');
    await mkdir(join(PROJECTS_ROOT, project.fsPath ?? project.name), { recursive: true });
    return NextResponse.json({ project, sandbox: true });
  }

  // Clone synchronously. cloneOrPull resolves the target dir as
  // PROJECTS_ROOT/<arg>; we pass the full fsPath so the FS layout
  // matches the folder hierarchy (e.g. /projects/legacy/uncategorized/
  // <name>). If it fails, persist the failure and signal the client
  // with 502 + details — the row is left in place so the user can
  // resync after fixing the git URL / credentials.
  const res = await cloneOrPull(project.fsPath ?? project.name, project.gitUrl, project.branch);
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
