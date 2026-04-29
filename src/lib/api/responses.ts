/**
 * API response helpers (#5, 2026-04-29). Pre-refactor every route
 * spelled out NextResponse.json({error: ...}, {status: 400}) inline
 * across ~81 sites with subtle drift (sometimes status 400 with no
 * error code, sometimes a Zod error tree, sometimes plain string).
 *
 * These helpers are intentionally thin — they only own the
 * (status, shape) pair. Callers keep full control of the error
 * value so we don't lose information that some routes return as a
 * structured object (Zod .format() output, validation tree, etc.).
 *
 * Convention: every helper returns NextResponse with
 *   { error: <value> }
 * as the body. Add new helpers here when a new status code becomes
 * a recurring pattern — do NOT inline new NextResponse.json error
 * bodies in route files.
 */
import { NextResponse } from 'next/server';

export function apiError(
  error: unknown,
  status: number,
): NextResponse {
  return NextResponse.json({ error }, { status });
}

/** 400 — client sent invalid input. The most common error case. */
export function badRequest(error: unknown): NextResponse {
  return apiError(error, 400);
}

/**
 * 401 — not authenticated. Default error code 'unauthorized' is
 * the legacy convention used by the WorkOS device-flow guard;
 * pass an explicit message when a route wants to be more specific.
 */
export function unauthorized(error: unknown = 'unauthorized'): NextResponse {
  return apiError(error, 401);
}

/** 403 — authenticated but forbidden (e.g. wrong role). */
export function forbidden(error: unknown = 'forbidden'): NextResponse {
  return apiError(error, 403);
}

/**
 * 404 — resource not found. Default 'not_found' so trivial guards
 * (`if (!row) return notFound()`) stay one-liners.
 */
export function notFound(error: unknown = 'not_found'): NextResponse {
  return apiError(error, 404);
}

/** 409 — conflict (used for unique-constraint violations etc.). */
export function conflict(error: unknown): NextResponse {
  return apiError(error, 409);
}

/**
 * 500 — server-side failure. Prefer this over inline 500s so the
 * shape stays consistent and errors don't accidentally leak
 * exception objects (NextResponse.json on a raw Error serialises
 * to {} and silently hides the message).
 */
export function serverError(error: unknown): NextResponse {
  return apiError(error, 500);
}
