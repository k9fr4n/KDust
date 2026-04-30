import { NextResponse } from 'next/server';
import { z } from 'zod';
import { renameFolder, deleteFolderIfEmpty } from '@/lib/folder-ops';
import { badRequest } from "@/lib/api/responses";

export const runtime = 'nodejs';
// Renaming an L1 folder cascades through every descendant project
// (mv FS dir + DB rewiring). 90s is generous for sub-trees up to a
// few dozen projects on local disk.
export const maxDuration = 90;

/**
 * PATCH /api/folders/:id
 *
 * Rename a folder (parent change is NOT supported in Phase 2 —
 * users delete + recreate or move projects individually). On L1
 * rename, every descendant project is FS-mv'd and DB-rewired by
 * folder-ops.renameFolder().
 *
 * Body: { name: string }
 *
 * Errors:
 *   400 invalid body / unknown id
 *   409 sibling name collision OR active run on a child project
 */
const NAME_RE = /^[a-zA-Z0-9._-]+$/;
const NAME_HINT =
  'folder name must be 1-64 chars, letters/digits/. _ - only (no spaces, slashes or accents)';

const RenameInput = z.object({ name: z.string() });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = RenameInput.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return badRequest('invalid request body');
  }
  const name = parsed.data.name.trim();
  if (name.length === 0) return badRequest('name is required');
  if (name.length > 64) return badRequest('name is too long (max 64 chars)');
  if (!NAME_RE.test(name)) return badRequest(NAME_HINT);
  const r = await renameFolder(id, name);
  if (!r.ok) {
    const status =
      r.reason === 'invalid_target' ? 404
        : r.reason === 'busy' || r.reason === 'name_conflict' ? 409
        : r.reason === 'fs_collision' || r.reason === 'fs_mv_failed' ? 500
        : 400;
    return NextResponse.json({ error: r.reason, detail: r.detail }, { status });
  }
  return NextResponse.json({ ok: true, rewired: r.renamed });
}

/**
 * DELETE /api/folders/:id
 *
 * Refuses (409) if the folder has any subfolder or project. The
 * operator must move/delete contents first — by design (Q9).
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await deleteFolderIfEmpty(id);
  if (!r.ok) {
    const status = r.reason === 'not_found' ? 404 : 409;
    return NextResponse.json(
      { error: r.reason, detail: r.detail },
      { status },
    );
  }
  return NextResponse.json({ ok: true });
}
