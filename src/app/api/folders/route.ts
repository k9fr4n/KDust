import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { classifyFolderDepth } from '@/lib/folder-path';

export const runtime = 'nodejs';

/**
 * GET /api/folders
 *
 * Returns the full folder tree (depth-2 cap) with per-leaf project
 * counts so the UI can render the sidebar in a single round-trip.
 *
 * Response shape:
 *   {
 *     tree: [
 *       { id, name, projectCount: 0, children: [
 *         { id, name, projectCount: N }
 *       ] }
 *     ]
 *   }
 */
export async function GET() {
  const folders = await db.folder.findMany({
    include: {
      _count: { select: { projects: true } },
    },
    orderBy: { name: 'asc' },
  });

  const byParent = new Map<string | null, typeof folders>();
  for (const f of folders) {
    const k = f.parentId;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(f);
  }

  const roots = byParent.get(null) ?? [];
  const tree = roots.map((l1) => ({
    id: l1.id,
    name: l1.name,
    projectCount: 0, // L1 itself never holds projects (depth invariant)
    children: (byParent.get(l1.id) ?? []).map((l2) => ({
      id: l2.id,
      name: l2.name,
      projectCount: l2._count.projects,
    })),
  }));

  return NextResponse.json({ tree });
}

/**
 * POST /api/folders
 *
 * Create a folder. Body:
 *   { name: string, parentId?: string|null }
 *
 * Rules:
 *   - parentId null  => create at depth 1 (root). Allowed.
 *   - parentId set   => parent must be a root folder (parentId IS
 *                       NULL). Creating under a leaf is rejected
 *                       (would breach depth=2 invariant).
 *   - name unique within parent (DB @@unique enforces, we surface
 *     a 409 mapped error).
 */
const CreateInput = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, 'name must match [a-zA-Z0-9._-]+'),
  parentId: z.string().nullable().optional(),
});

export async function POST(req: Request) {
  const parsed = CreateInput.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  const { name, parentId } = parsed.data;

  if (parentId) {
    // Only root folders may host children. depth==='root' covers
    // "parent.parentId IS NULL"; any other value (leaf or invalid)
    // means we'd go past depth 2.
    const depth = await classifyFolderDepth(parentId);
    if (depth === 'invalid') {
      return NextResponse.json({ error: 'unknown parentId' }, { status: 400 });
    }
    if (depth !== 'root') {
      return NextResponse.json(
        { error: 'max folder depth is 2 (cannot nest under a leaf)' },
        { status: 400 },
      );
    }
  }

  try {
    const folder = await db.folder.create({ data: { name, parentId: parentId ?? null } });
    return NextResponse.json({ folder }, { status: 201 });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return NextResponse.json({ error: 'name already used in this parent' }, { status: 409 });
    }
    throw err;
  }
}
