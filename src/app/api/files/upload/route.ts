import { NextResponse } from 'next/server';
import { isSupportedFileContentType } from '@dust-tt/client';
import { getDustClient } from '@/lib/dust/client';
import { badRequest, unauthorized } from "@/lib/api/responses";

export const runtime = 'nodejs';

/**
 * Extension → Dust-supported MIME map.
 *
 * Browsers send platform-specific MIME types that Dust does not
 * recognise (e.g. .ps1 → "application/x-powershell" on Chrome/Windows
 * because of the registered file association). The SDK's
 * SupportedFileContentType union lists only canonical MIMEs and Dust
 * rejects anything else with a 400 file_type_not_supported.
 *
 * For text-equivalent payloads (scripts, config files, logs) we map
 * the extension to "text/plain" before forwarding so they are
 * accepted as readable context. Binary extensions are not in this
 * map — they fall back to application/octet-stream and Dust decides.
 *
 * Edit this map (not the upload code) to extend coverage.
 */
const TEXT_LIKE_EXTENSIONS: Record<string, string> = {
  // PowerShell — Franck 2026-05-01
  ps1: 'text/plain',
  psm1: 'text/plain',
  psd1: 'text/plain',
  // Windows / shell scripts
  bat: 'text/plain',
  cmd: 'text/plain',
  // Config / IaC
  toml: 'text/plain',
  ini: 'text/plain',
  env: 'text/plain',
  conf: 'text/plain',
  cfg: 'text/plain',
  tf: 'text/plain',
  tfvars: 'text/plain',
  dockerfile: 'text/plain',
  // Logs
  log: 'text/plain',
};

/**
 * Normalise a (filename, browser-MIME) pair to a Dust-accepted MIME.
 *
 * Strategy:
 *   1. If the browser MIME is already supported, keep it.
 *   2. Otherwise, look up the file extension in TEXT_LIKE_EXTENSIONS.
 *   3. Otherwise, fall back to application/octet-stream (Dust may
 *      still reject — surfaced upstream).
 */
function normaliseContentType(name: string, browserType: string): string {
  const ct = (browserType || '').toLowerCase();
  if (ct && isSupportedFileContentType(ct)) return ct;

  const dot = name.lastIndexOf('.');
  if (dot >= 0) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (TEXT_LIKE_EXTENSIONS[ext]) return TEXT_LIKE_EXTENSIONS[ext];
  }
  // Filename without extension but matching a known stem (e.g. "Dockerfile")
  const base = name.split('/').pop()?.toLowerCase() ?? '';
  if (TEXT_LIKE_EXTENSIONS[base]) return TEXT_LIKE_EXTENSIONS[base];

  return 'application/octet-stream';
}
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
    const ct = normaliseContentType(f.name, f.type);
    // The SDK's contentType field is a strict union of supported
    // MIME types. normaliseContentType() above guarantees we only
    // pass values that survive the SDK's runtime check (or
    // application/octet-stream as a last-ditch fallback).
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
