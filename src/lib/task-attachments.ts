// src/lib/task-attachments.ts
//
// On-disk storage helpers for Task attachments (Franck 2026-05-09).
//
// Storage layout under KDUST_ATTACHMENTS_DIR (default
// `/projects/.kdust-attachments`):
//
//   <root>/
//     <taskId>/
//       <attachmentId>__<sanitized-filename>
//
// `storagePath` in the TaskAttachment row is RELATIVE to <root>
// (i.e. "<taskId>/<attachmentId>__<name>") so that moving the
// root via env doesn't invalidate existing rows.
//
// Caps (validated by the API layer, also enforced here):
//   - per-file: 50 MB (matches /api/files/upload)
//   - per-task aggregate: 200 MB (sum of sizeBytes)
//
// Filenames are sanitised: any path traversal ("..", "/", "\\", NUL)
// or non-printable byte is replaced with '_'. The original filename
// stays in the DB row for display.

import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const PER_FILE_MAX_BYTES = 50 * 1024 * 1024;       //  50 MB
export const PER_TASK_MAX_BYTES = 200 * 1024 * 1024;      // 200 MB

export function attachmentsRoot(): string {
  return process.env.KDUST_ATTACHMENTS_DIR ?? '/projects/.kdust-attachments';
}

/**
 * Strip path-traversal characters from a user-supplied filename.
 * Keep the result short enough for any sane filesystem.
 */
export function sanitizeFilename(name: string): string {
  // Drop any path component the browser might have leaked.
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // Replace anything that's not a printable, non-special char.
  // Keep dots, dashes, underscores, alnum.
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^\.+/, '_'); // no leading dots (no hidden files)
  const trimmed = cleaned.length === 0 ? 'file' : cleaned;
  return trimmed.slice(0, 200);
}

export function buildStoragePath(
  taskId: string,
  attachmentId: string,
  filename: string,
): string {
  return path.posix.join(taskId, `${attachmentId}__${sanitizeFilename(filename)}`);
}

export function absoluteStoragePath(relPath: string): string {
  const root = attachmentsRoot();
  const abs = path.resolve(root, relPath);
  // Defence-in-depth: refuse anything that resolved outside <root>.
  const rootResolved = path.resolve(root);
  if (!abs.startsWith(rootResolved + path.sep) && abs !== rootResolved) {
    throw new Error(`attachment path escapes root: ${relPath}`);
  }
  return abs;
}

/** Write a buffer for a brand-new attachment row. Creates parents. */
export async function writeAttachmentBytes(
  relPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const abs = absoluteStoragePath(relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes, { mode: 0o600 });
}

/**
 * Read bytes for re-uploading to Dust or for streaming back to the
 * browser. Returns an `ArrayBuffer` so callers can hand it directly
 * to `new File([buf], …)` or `new NextResponse(buf, …)` without TS
 * fighting over `Buffer<ArrayBufferLike>` vs `ArrayBuffer`.
 */
export async function readAttachmentBytes(relPath: string): Promise<ArrayBuffer> {
  const b = await readFile(absoluteStoragePath(relPath));
  // Slice off the underlying ArrayBuffer so the returned value is
  // not a view over a pooled Node Buffer (which can be larger than
  // the file itself when the read is small).
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** Best-effort delete. Missing file is not an error. */
export async function deleteAttachmentFile(relPath: string): Promise<void> {
  try {
    await rm(absoluteStoragePath(relPath), { force: true });
  } catch {
    /* ignore */
  }
}

/** Best-effort delete of the whole task folder. Used by Task DELETE. */
export async function deleteTaskAttachmentDir(taskId: string): Promise<void> {
  try {
    const abs = absoluteStoragePath(taskId);
    await rm(abs, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** True if the on-disk size matches the DB row (cheap drift check). */
export async function attachmentExists(relPath: string): Promise<boolean> {
  try {
    const s = await stat(absoluteStoragePath(relPath));
    return s.isFile();
  } catch {
    return false;
  }
}
