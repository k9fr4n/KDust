import { NextResponse } from 'next/server';
import { runTask } from '@/lib/cron/runner';
import { db } from '@/lib/db';
import { getCurrentUserEmail } from '@/lib/dust/current-user';
export const runtime = 'nodejs';

/**
 * Manual dispatch ("Run now"). Fire-and-forget so the API returns
 * immediately without holding the request open for the whole run.
 *
 * Optional JSON body:
 *   { project?: string }   — project context override. Required for
 *                            generic tasks (projectPath=null); the
 *                            API validates it exists in the Project
 *                            table before dispatch. Rejected for
 *                            project-bound tasks (safety: never run
 *                            a task somewhere it wasn't designed for).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // Tolerate empty body (legacy callers).
  let body: { project?: string } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const projectArg = body.project?.trim() || undefined;

  const task = await db.task.findUnique({
    where: { id },
    select: { id: true, name: true, projectPath: true },
  });
  if (!task) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Generic task → project arg is REQUIRED.
  if (task.projectPath === null) {
    if (!projectArg) {
      return NextResponse.json(
        { error: `task "${task.name}" is generic and requires { project: "<name>" } in the body` },
        { status: 400 },
      );
    }
    const ok = await db.project.findFirst({ where: { name: projectArg }, select: { name: true } });
    if (!ok) {
      return NextResponse.json(
        { error: `unknown project "${projectArg}"` },
        { status: 400 },
      );
    }
  } else if (projectArg && projectArg !== task.projectPath) {
    // Project-bound task → reject mismatching project arg.
    return NextResponse.json(
      {
        error:
          `task "${task.name}" is bound to project "${task.projectPath}"; ` +
          `refusing to run it with project="${projectArg}".`,
      },
      { status: 400 },
    );
  }

  // fire-and-forget pour ne pas bloquer l'API.
  // Provenance: always 'manual' for this endpoint (the only way to
  // reach it is a human clicking "Run" in the UI or curl-ing it on
  // purpose). We try to surface an actor identity from the OIDC
  // session email when available so the /runs page can show "by
  // <email>"; fall back to 'ui' for pre-OIDC flows or CLI curl
  // calls. Best effort — never blocks the dispatch on a lookup.
  let triggeredBy: string | null = 'ui';
  try {
    const email = await getCurrentUserEmail();
    if (email) triggeredBy = email;
  } catch {
    /* ignore */
  }
  void runTask(id, {
    ...(projectArg ? { projectOverride: projectArg } : {}),
    trigger: 'manual',
    triggeredBy,
  });
  return NextResponse.json({ ok: true, triggered: id, project: projectArg ?? task.projectPath });
}
