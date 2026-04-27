import { NextResponse } from 'next/server';
import { z } from 'zod';
import { moveProjectToFolder } from '@/lib/folder-ops';
import { reloadScheduler } from '@/lib/cron/scheduler';

export const runtime = 'nodejs';
// Move = mv FS dir + atomic DB tx. Multi-GB project dirs may take
// a few seconds on local disk. 60s buffer.
export const maxDuration = 60;

/**
 * POST /api/projects/:id/move
 *
 * Body: { folderId: string }   // target L2 folder id
 *
 * Atomically:
 *   - mv /projects/<oldFsPath> -> /projects/<newFsPath>
 *   - Project.fsPath / folderId updated
 *   - Task.projectPath / Conversation.projectName /
 *     TelegramBinding.projectName rewired from old fsPath
 *
 * Refused (409) when:
 *   - the target folder is not a depth-2 leaf;
 *   - the project has a TaskRun in 'running' or 'pending' state;
 *   - a folder/project with the same name already exists at the
 *     destination;
 *   - the destination FS dir already exists (FS collision).
 *
 * Triggers a scheduler reload so any cron whose Task.projectPath
 * was rewritten keeps firing on the new path.
 */
const Input = z.object({ folderId: z.string().min(1) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = Input.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const r = await moveProjectToFolder(id, parsed.data.folderId);
  if (!r.ok) {
    const status =
      r.reason === 'invalid_target' ? 400
        : r.reason === 'busy' || r.reason === 'name_conflict' || r.reason === 'fs_collision'
          ? 409
          : 500;
    return NextResponse.json({ error: r.reason, detail: r.detail }, { status });
  }

  // Scheduler keeps Task rows cached with their projectPath inline;
  // we just rewrote it, so reload to avoid stale fires.
  try {
    await reloadScheduler();
  } catch (err) {
    console.warn('[projects/move] reloadScheduler failed:', err);
  }

  return NextResponse.json({ ok: true, oldFsPath: r.oldFsPath, newFsPath: r.newFsPath });
}
