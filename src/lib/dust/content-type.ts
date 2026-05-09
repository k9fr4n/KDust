// src/lib/dust/content-type.ts
//
// Extension → Dust-supported MIME map + normaliser. Extracted from
// src/app/api/files/upload/route.ts (Franck 2026-05-09) so the cron
// runner can re-upload Task attachments using the SAME normalisation
// as the chat composer — keeps a single source of truth for which
// browser MIMEs we silently rewrite to text/plain before forwarding
// to Dust's strict MIME union.
//
// Edit TEXT_LIKE_EXTENSIONS (not the upload code) to extend coverage.

import { isSupportedFileContentType } from '@dust-tt/client';

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
export function normaliseContentType(name: string, browserType: string): string {
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
