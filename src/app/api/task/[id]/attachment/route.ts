// src/app/api/task/[id]/attachment/route.ts
//
// Task attachment endpoints (Franck 2026-05-09).
//   GET  /api/task/:id/attachment  — list rows for a task
//   POST /api/task/:id/attachment  — multipart upload, one or more `files`
//
// DELETE + download live in ./[attId]/route.ts.
//
// Caps: 50 MB / file, 200 MB total per task. Files are stored on
// disk under KDUST_ATTACHMENTS_DIR; only the relative storage path
// is persisted in DB. contentType is normalised with the same
// extension table the chat composer uses, so the cron runner can
// re-upload to Dust without re-applying the fallback.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { normaliseContentType } from '@/lib/dust/content-type';
import {
  PER_FILE_MAX_BYTES,
  PER_TASK_MAX_BYTES,
  buildStoragePath,
  writeAttachmentBytes,
} from '@/lib/task-attachments';
import { badRequest, notFound } from '@/lib/api/responses';
import { errMessage } from '@/lib/errors';

export const runtime = 'nodejs';
// Generous — a 50 MB upload over a slow link can take a while.
export const maxDuration = 60;

async function taskExists(id: string): Promise<boolean> {
  const row = await db.task.findUnique({ where: { id }, select: { id: true } });
  return Boolean(row);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!(await taskExists(id))) return notFound('Task not found');
  const rows = await db.taskAttachment.findMany({
    where: { taskId: id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      filename: true,
      contentType: true,
      sizeBytes: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ attachments: rows });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!(await taskExists(id))) return notFound('Task not found');

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: 'invalid_multipart', detail: errMessage(e) },
      { status: 400 },
    );
  }
  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) return badRequest('no_files');

  // Per-file cap pre-check.
  const oversize = files.find((f) => f.size > PER_FILE_MAX_BYTES);
  if (oversize) {
    return NextResponse.json(
      { error: 'file_too_large', name: oversize.name, limit: PER_FILE_MAX_BYTES },
      { status: 413 },
    );
  }

  // Aggregate cap pre-check (sum of incoming + already-stored bytes).
  const incoming = files.reduce((n, f) => n + f.size, 0);
  const existing = await db.taskAttachment.aggregate({
    where: { taskId: id },
    _sum: { sizeBytes: true },
  });
  const after = (existing._sum.sizeBytes ?? 0) + incoming;
  if (after > PER_TASK_MAX_BYTES) {
    return NextResponse.json(
      {
        error: 'task_quota_exceeded',
        limit: PER_TASK_MAX_BYTES,
        current: existing._sum.sizeBytes ?? 0,
        attempted: incoming,
      },
      { status: 413 },
    );
  }

  const created: Array<{
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    createdAt: Date;
  }> = [];

  // Sequential: keeps memory pressure bounded and makes partial-
  // failure semantics straightforward (already-written rows are
  // returned in the response so the UI can render the chips).
  for (const f of files) {
    const ct = normaliseContentType(f.name, f.type);
    const bytes = new Uint8Array(await f.arrayBuffer());

    // Reserve the row first so we get a stable id for the storage
    // filename. If writeAttachmentBytes fails afterwards, the row
    // is rolled back by deleting it.
    const row = await db.taskAttachment.create({
      data: {
        taskId: id,
        filename: f.name,
        contentType: ct,
        sizeBytes: f.size,
        // Filled in below once we know the row id.
        storagePath: '',
      },
    });
    const relPath = buildStoragePath(id, row.id, f.name);
    try {
      await writeAttachmentBytes(relPath, bytes);
      const updated = await db.taskAttachment.update({
        where: { id: row.id },
        data: { storagePath: relPath },
        select: {
          id: true,
          filename: true,
          contentType: true,
          sizeBytes: true,
          createdAt: true,
        },
      });
      created.push(updated);
    } catch (e) {
      await db.taskAttachment.delete({ where: { id: row.id } }).catch(() => {});
      return NextResponse.json(
        {
          error: 'storage_write_failed',
          name: f.name,
          detail: errMessage(e),
          // Already-stored attachments in this batch:
          partial: created,
        },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ attachments: created });
}
