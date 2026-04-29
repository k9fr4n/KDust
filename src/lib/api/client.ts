/**
 * Client-side API helpers (#6, 2026-04-29). Pre-refactor every
 * client component spelled out the
 *   fetch(url).then(r => r.json()).then(setX) / fetch + ok-check
 * pattern inline (~100 sites across ~29 files), with subtle drift:
 *   - some sites checked r.ok, others didn't
 *   - error messages were extracted differently
 *   - cache: 'no-store' was set inconsistently
 *
 * These helpers normalise the contract:
 *   - apiGet<T>(url)            — GET, parse JSON, throw ApiError
 *                                 on non-2xx. Defaults to no-store
 *                                 to avoid the Next.js fetch cache.
 *   - apiSend<T>(method, url,
 *               body?)           — POST/PATCH/PUT/DELETE with
 *                                 optional JSON body. Same error
 *                                 contract as apiGet.
 *
 * For raw access to the Response (status codes, streaming, file
 * downloads), keep using `fetch` directly — these helpers are
 * intentionally thin and assume JSON I/O.
 *
 * Pair with the server-side helpers in src/lib/api/responses.ts:
 * the ApiError shape mirrors the {error: ...} body those helpers
 * produce.
 */

/**
 * Thrown by apiGet/apiSend when the response is non-2xx. Carries
 * the status code plus the parsed body so callers can branch on
 * status (e.g. 401 → redirect to login) without reparsing.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

/** Best-effort error message extraction from a {error: ...} body. */
function errorMessageFrom(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as { error: unknown }).error;
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') return JSON.stringify(e);
  }
  return `HTTP ${status}`;
}

async function readJson(r: Response): Promise<unknown> {
  // Some routes return 204 / empty bodies on success. r.json() throws
  // on empty input — swallow and return null so callers can still
  // consume the helper without try/catch around the parse step.
  try {
    return await r.json();
  } catch {
    return null;
  }
}

export async function apiGet<T = unknown>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  // cache: 'no-store' default. Most KDust UIs read live state
  // (tasks, runs, projects) and the Next.js fetch cache caused
  // stale reads after mutations pre-refactor.
  const r = await fetch(url, { cache: 'no-store', ...init });
  const body = await readJson(r);
  if (!r.ok) throw new ApiError(r.status, body, errorMessageFrom(body, r.status));
  return body as T;
}

export async function apiSend<T = unknown>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const hasBody = body !== undefined;
  // We spread `init` FIRST so caller-supplied options (cache, signal,
  // credentials, ...) flow through, then override method/headers/body
  // last so the helper's contract can't be subverted by accident.
  const r = await fetch(url, {
    ...init,
    method,
    headers: hasBody
      ? { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
      : init?.headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const respBody = await readJson(r);
  if (!r.ok) {
    throw new ApiError(r.status, respBody, errorMessageFrom(respBody, r.status));
  }
  return respBody as T;
}
