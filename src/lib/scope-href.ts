// ---------------------------------------------------------------
// Pure, client-safe scoped-URL helper (ADR-0023 routing).
//
// The middleware rewrites `/<scope-segs>/<sub>[...]` -> `/<sub>[...]`
// internally, but the browser keeps the ORIGINAL scoped URL in the
// address bar. Any link rendered inside a scoped page that points
// at a reserved sub-route (`/task/<id>`, `/run/<id>`, ...) must
// therefore re-prepend the active scope head, otherwise the
// navigation silently drops the scope.
//
//   Franck 2026-06-01: on `/Perso/fsallet/Claw/task`, clicking a
//   task landed on `/task/<id>` instead of
//   `/Perso/fsallet/Claw/task/<id>`.
//
// This module has NO server imports (no `headers`, no Prisma) so it
// is safe to import from client components. Server callers already
// hold the resolved scope via `getCurrentScope().fsPath` and can
// pass it straight in.
// ---------------------------------------------------------------

/**
 * Prefix a root-absolute reserved-route target with the active
 * scope head.
 *
 *   scopedHref('Perso/fsallet/Claw', '/task/abc') -> '/Perso/fsallet/Claw/task/abc'
 *   scopedHref('',                   '/task/abc') -> '/task/abc'   (root scope)
 *   scopedHref(null,                 '/task/abc') -> '/task/abc'
 *
 * `target` is expected to be a root-absolute path (leading `/`); a
 * missing leading slash is tolerated. `scopeFsPath` is the resolved
 * scope's fsPath (`''` / null for the root scope).
 */
export function scopedHref(scopeFsPath: string | null | undefined, target: string): string {
  const head = (scopeFsPath ?? '').replace(/^\/+|\/+$/g, '');
  const t = target.startsWith('/') ? target : `/${target}`;
  if (!head) return t;
  return `/${head}${t}`;
}
