import { NextResponse } from 'next/server';
import { getDustClient } from '@/lib/dust/client';
import { badRequest, unauthorized } from "@/lib/api/responses";

export const runtime = 'nodejs';
// Body sizes are capped by Next's default 4MB JSON limit, but we
// accept multipart/form-data streams which route through a larger
// internal limit. Users should still avoid massive uploads in one
// shot; Dust's own limit applies downstream.
export const maxDuration = 60;

/**
 * POST /api/files/upload  (Franck 2026-04-23 16:59)
 *
 * Multi-file upload endpoint for the chat composer attachments UX.
 * Accepts multipart/form-data with one or more `files` entries and
 * forwards each to Dust's upload API via the SDK's uploadFile().
 *
 * Request:
 *   Content-Type: multipart/form-data
 *   Field:        files (repeatable, one per attachment)
 *
 * Response (200):
 *   {
 *     files: [{
 *       sId:         string,   // Dust file id (fil_xxx)
 *       name:        string,   // original filename
 *       contentType: string,   // MIME type
 *       size:        number,   // bytes
 *     }, ...]
 *   }
 *
 * Error modes:
 *   400 — no files in body
 *   401 — no Dust session
 *   413 — one of the files exceeds MAX_FILE_BYTES (below)
 *   502 — upstream Dust rejected the upload
 *
 * Design notes:
 * - Sequential uploads (not Promise.all): Dust's upload API is a
 *   two-step request (POST /files then POST to returned uploadUrl)
 *   and parallel fan-out has been observed to 429 under load. The
 *   composer attaches typically 1-3 files so sequential is fine.
 * - useCase='conversation' so Dust routes the file to the chat
 *   context (not dataset ingestion).
 */

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB — generous but bounded

export async function POST(req: Request) {
  const d = await getDustClient();
  if (!d) return unauthorized('not_connected');

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: 'invalid_multipart', detail: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return badRequest('no_files');
  }

  // Pre-flight size check so we reject cleanly before hitting Dust.
  const oversize = files.find((f) => f.size > MAX_FILE_BYTES);
  if (oversize) {
    return NextResponse.json(
      { error: 'file_too_large', name: oversize.name, limit: MAX_FILE_BYTES },
      { status: 413 },
    );
  }

  const results: Array<{
    sId: string;
    name: string;
    contentType: string;
    size: number;
  }> = [];

  for (const f of files) {
    const ct = f.type || 'application/octet-stream';
    // The SDK's contentType field is a strict union of supported
    // MIME types. We can't widen that union here without bundling
    // the guard, so cast: uploadFile() falls back to
    // 'application/octet-stream' downstream for unknown types.
    const res = await d.client.uploadFile({
      contentType: ct as Parameters<typeof d.client.uploadFile>[0]['contentType'],
      fileName: f.name,
      fileSize: f.size,
      useCase: 'conversation',
      fileObject: f,
    });
    if (res.isErr()) {
      console.error('[files/upload] dust rejected', f.name, res.error?.message);
      return NextResponse.json(
        { error: 'upstream_error', detail: res.error?.message ?? 'unknown', name: f.name },
        { status: 502 },
      );
    }
    const v = res.value;
    results.push({
      sId: v.sId,
      name: v.fileName ?? f.name,
      contentType: v.contentType ?? ct,
      size: v.fileSize ?? f.size,
    });
  }

  return NextResponse.json({ files: results });
}
