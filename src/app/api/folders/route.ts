import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { assertValidProjectParent, isReservedName } from '@/lib/folder-path';
import { badRequest, conflict } from "@/lib/api/responses";
import { errCode } from '@/lib/errors';

export const runtime = 'nodejs';

/**
 * GET /api/folders
 *
 * Returns the full folder tree with per-node project counts so the
 * UI can render the sidebar / picker in a single round-trip.
 *
 * Since ADR-0022 the tree is **unbounded depth**: any node may host
 * folders, projects, or both. Response shape (recursive):
 *
 *   type Node = {
 *     id: string;
 *     name: string;
 *     projectCount: number;   // projects directly under this node
 *     children: Node[];        // descendant folders, may be empty
 *   };
 *   { tree: Node[] }            // root-level folders only
 *
 * Backwards compatibility: the legacy depth-2 consumer (settings/
 * projects page, Telegram picker pre-refactor) walked `children`
 * one level deep and stopped — that path still works on a depth-2
 * dataset. Recursive consumers should walk `children` until empty.
 */
type FolderNode = {
  id: string;
  name: string;
  projectCount: number;
  children: FolderNode[];
};

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

  const build = (parentId: string | null): FolderNode[] =>
    (byParent.get(parentId) ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      projectCount: f._count.projects,
      children: build(f.id),
    }));

  return NextResponse.json({ tree: build(null) });
}

/**
 * POST /api/folders
 *
 * Create a folder. Body:
 *   { name: string, parentId?: string|null }
 *
 * Rules (ADR-0022, unbounded depth):
 *   - parentId null  => create at root. Always allowed.
 *   - parentId set   => any existing folder accepted, provided the
 *                       ancestor chain is well-formed and depth
 *                       remains < MAX_FOLDER_DEPTH (the new child
 *                       would itself sit one level below the parent).
 *   - name unique within parent (DB @@unique enforces — surfaced as
 *     a 409 mapped error).
 */
const NAME_RE = /^[a-zA-Z0-9._-]+$/;
const NAME_HINT =
  'folder name must be 1-64 chars, letters/digits/. _ - only (no spaces, slashes or accents)';

const CreateInput = z.object({
  name: z.string(),
  parentId: z.string().nullable().optional(),
});

export async function POST(req: Request) {
  const parsed = CreateInput.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return badRequest('invalid request body');
  }
  const { parentId } = parsed.data;
  const name = parsed.data.name.trim();
  // Friendly, single-string validation messages (the UI surfaces
  // j.error verbatim when it's a string — see #5 helpers).
  if (name.length === 0) return badRequest('name is required');
  if (name.length > 64) return badRequest('name is too long (max 64 chars)');
  if (!NAME_RE.test(name)) return badRequest(NAME_HINT);
  // ADR-0020: reserved URL segments cannot be used as folder
  // names — they'd collide with the `/<…>/<project>/<sub>` routing.
  if (isReservedName(name)) {
    return badRequest(`"${name}" is a reserved URL segment (ADR-0020)`);
  }

  if (parentId) {
    // ADR-0022: any valid folder may host children. The helper
    // validates existence + ancestor chain (cycle + depth ≤ MAX)
    // in a single pass; throw → 400 with the underlying message.
    try {
      await assertValidProjectParent(parentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid parentId';
      return badRequest(msg);
    }
  }

  try {
    const folder = await db.folder.create({ data: { name, parentId: parentId ?? null } });
    return NextResponse.json({ folder }, { status: 201 });
  } catch (err: unknown) {
    if (errCode(err) === 'P2002') {
      return conflict('name already used in this parent');
    }
    throw err;
  }
}
