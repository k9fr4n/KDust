/**
 * Error normalisation helpers (#15, 2026-04-29). Pre-refactor every
 * `catch (e: any)` site spelled out one of:
 *   - e.message                                  (assumes Error)
 *   - e?.message ?? String(e)                    (defensive)
 *   - e instanceof Error ? e.message : String(e) (correct but verbose)
 * with subtle drift between sites (some swallowed non-Error throws,
 * some included "undefined" in the user-visible message).
 *
 * `errMessage(e)` is the single normaliser — always returns a
 * non-empty human string. Pair with `catch (e: unknown)` to drop
 * the `any` while keeping call sites compact:
 *
 *   try { ... } catch (e: unknown) {
 *     log(`failed: ${errMessage(e)}`);
 *   }
 */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || 'Error';
  if (typeof e === 'string') return e;
  if (typeof e === 'number' || typeof e === 'boolean') return String(e);
  if (e && typeof e === 'object') {
    // Some libraries throw plain objects ({code, message}) — pick
    // .message if present, else stringify.
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
    try {
      return JSON.stringify(e);
    } catch {
      return Object.prototype.toString.call(e);
    }
  }
  return String(e);
}

/**
 * Best-effort retrieval of a Node-style error code (ENOENT, EACCES,
 * EPERM, ...). Returns null when the throw isn't a NodeJS.ErrnoException
 * shape so callers can branch without an unsafe cast.
 */
export function errCode(e: unknown): string | null {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return null;
}
