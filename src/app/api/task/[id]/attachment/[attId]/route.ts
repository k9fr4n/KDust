// src/app/api/task/[id]/attachment/[attId]/route.ts
//
// Single-attachment endpoints (Franck 2026-05-09):
//   GET    /api/task/:id/attachment/:attId  — download bytes
//   DELETE /api/task/:id/attachment/:attId  — remove row + on-disk blob

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  deleteAttachmentFile,
  readAttachmentBytes,
} from '@/lib/task-attachments';
import { notFound } from '@/lib/api/responses';
import { errMessage } from '@/lib/errors';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; attId: string }> },
) {
  const { id, attId } = await params;
  const row = await db.taskAttachment.findFirst({
    where: { id: attId, taskId: id },
  });
  if (!row) return notFound('attachment_not_found');
  try {
    const buf = await readAttachmentBytes(row.storagePath);
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'content-type': row.contentType,
        'content-length': String(buf.byteLength),
        // ArrayBuffer is an accepted BodyInit in the Next.js Edge/
        // Node response types.
        'content-disposition': `attachment; filename="${encodeURIComponent(row.filename)}"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'storage_read_failed', detail: errMessage(e) },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; attId: string }> },
) {
  const { id, attId } = await params;
  const row = await db.taskAttachment.findFirst({
    where: { id: attId, taskId: id },
    select: { id: true, storagePath: true },
  });
  if (!row) return notFound('attachment_not_found');
  // DB row first; the file follows. If the file delete fails (e.g.
  // already gone, permission glitch) we don't roll back — the row
  // is the source of truth from the UI perspective and a stale
  // blob is harmless.
  await db.taskAttachment.delete({ where: { id: row.id } });
  await deleteAttachmentFile(row.storagePath);
  return NextResponse.json({ ok: true });
}
