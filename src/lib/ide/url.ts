// Shared client-side helpers to build the code-server IDE deep link
// (ADR-0028). Extracted so both the embedded <IdeFrame> and the
// dashboard "Open in IDE" menu item (which now opens a new tab on the
// :4001 proxy instead of an in-app iframe — Franck 2026-06-03) build
// the exact same URL.

/** Default published port of the IDE auth-proxy (compose mapping). */
export const DEFAULT_IDE_PROXY_PORT = '4001';

/**
 * Map a scope fsPath to the absolute workspace path inside the IDE
 * sidecar. Root scope (null/empty) opens the whole `/projects` tree.
 */
export function ideFolderForFsPath(fsPath: string | null | undefined): string {
  return fsPath ? `/projects/${fsPath}` : '/projects';
}

/**
 * Resolve the browser-facing base URL of the IDE proxy. Prefers the
 * server-provided IDE_PUBLIC_URL; otherwise derives `<host>:4001` from
 * the current location. Returns null when no window is available and no
 * base was provided (SSR before mount).
 */
export function resolveIdeBase(baseUrl: string | null): string | null {
  if (baseUrl) return baseUrl;
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:${DEFAULT_IDE_PROXY_PORT}`;
  }
  return null;
}

/**
 * Build the code-server deep link for a workspace folder. Returns null
 * when the base could not be resolved.
 */
export function buildIdeUrl(folder: string, baseUrl: string | null): string | null {
  const base = resolveIdeBase(baseUrl);
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/?folder=${encodeURIComponent(folder)}`;
}
