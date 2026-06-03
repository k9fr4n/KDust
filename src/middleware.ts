import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/health'];

// Mirrors src/lib/folder-path.ts RESERVED_URL_NAMES. Duplicated
// here (not imported) because middleware runs at the Edge and
// the helper module pulls in Prisma. Keep these two lists in
// sync if either changes (ADR-0020, Franck 2026-05-26).
const RESERVED_SEGMENTS = new Set([
  'chat',
  'task',
  'run',
  'conversation',
  'logs',
  'about',
  'ide',
  'settings',
  'login',
  'api',
  'dust',
  '_next',
  'favicon.ico',
]);

const CURRENT_PROJECT_COOKIE = 'kdust_project';

// Sub-pages that accept a scope prefix and have a singleton
// implementation under `src/app/<name>/...`. Middleware rewrites
// `/<scope-segs>/<one-of-these>[...rest]` → `/<one>[...rest]`.
// Other reserved names (settings, logs, about, login, api, dust,
// _next, favicon.ico) are NOT scope-rewritable: a URL like
// `/foo/bar/settings` is not a valid scoped route under ADR-0020
// either, and is left to 404 naturally. (ADR-0023, Franck 2026-05-27.)
const SCOPED_SUBPAGES = new Set(['chat', 'task', 'run', 'conversation', 'ide']);

/**
 * Split a pathname against the reserved-segment vocabulary.
 *
 * Returns { head, tail } where:
 *   - head = leading non-reserved segments (the scope chain,
 *            possibly an empty array).
 *   - tail = remainder starting at the first reserved segment
 *            (possibly empty).
 *
 * Pure string op — no DB access (this runs at the Edge).
 */
function splitScope(pathname: string): { head: string[]; tail: string[] } {
  const parts = pathname.split('/').filter(Boolean);
  const head: string[] = [];
  let i = 0;
  for (; i < parts.length; i++) {
    if (RESERVED_SEGMENTS.has(parts[i])) break;
    head.push(parts[i]);
  }
  return { head, tail: parts.slice(i) };
}

/**
 * Classify a pathname against the project cookie. Since ADR-0022
 * the folder hierarchy is unbounded depth, so we can no longer
 * use "3 segments = project leaf" as the heuristic — middleware
 * has no DB access. Heuristic generalised to:
 *
 *  - 'set'   when the URL carries a scope head (≥1 non-reserved
 *            leading segment). Cookie value = `head.join('/')`.
 *            Server-side `getCurrentScope()` validates against
 *            `Project.findUnique({fsPath})` and silently falls
 *            back to root if the value is a folder (not a
 *            project) — harmless stale cookies.
 *  - 'clear' for the explicit root URL `/`.
 *  - 'keep'  for reserved-only URLs (`/chat`, `/task`, `/api`, …)
 *            — cookie remains the source of truth there.
 */
type CookieAction =
  | { action: 'set'; fsPath: string }
  | { action: 'clear' }
  | { action: 'keep' };

function classifyForCookie(pathname: string): CookieAction {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { action: 'clear' };
  const { head } = splitScope(pathname);
  if (head.length === 0) return { action: 'keep' };
  return { action: 'set', fsPath: head.join('/') };
}

/**
 * Propagates the request pathname into `x-pathname` on every
 * server-handled request so that server components (e.g.
 * DustAuthBanner) can conditionally render based on the current
 * route \u2014 Next 15 has no built-in API for that in RSC land.
 * Added 2026-04-21 (Franck).
 */
function withPathname(req: NextRequest, res: NextResponse): NextResponse {
  res.headers.set('x-pathname', req.nextUrl.pathname);
  // ADR-0020 + Franck 2026-05-27 fix: keep the kdust_project cookie
  // in sync with the URL.
  //  - Project-leaf URL  -> set cookie (legacy chat/MCP/Telegram
  //    keep working without touching them).
  //  - Root / folder URL -> CLEAR cookie so a later visit to a
  //    reserved-only route (/chat, /task, ...) cannot snap back
  //    to the previous project via the cookie fallback.
  //  - Reserved-only URL -> keep cookie (intentional fallback).
  const decision = classifyForCookie(req.nextUrl.pathname);
  const existing = req.cookies.get(CURRENT_PROJECT_COOKIE)?.value;
  if (decision.action === 'set') {
    if (existing !== decision.fsPath) {
      res.cookies.set(CURRENT_PROJECT_COOKIE, decision.fsPath, {
        httpOnly: false,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
      });
    }
  } else if (decision.action === 'clear') {
    if (existing) {
      // Explicit root / folder navigation: the previous project is
      // no longer the active scope. Cookie must not leak into the
      // next legacy reserved-only route.
      res.cookies.delete(CURRENT_PROJECT_COOKIE);
    }
  }
  return res;
}

/**
 * Compute the rewrite target for a scoped URL, or null when the
 * request should pass through unchanged.
 *
 * ADR-0023 routing: drop the duplicated `[l1]/...` + `[l1]/[l2]/...`
 * route trees and forward any `/<scope-segs>/<sub>[...]` URL to the
 * existing root-level `/<sub>[...]` route. `getCurrentScope()` reads
 * the ORIGINAL pathname from the `x-pathname` header (set by
 * `withPathname`) so the rewrite is invisible to page components.
 *
 * Rules:
 *  - Empty pathname / `/` : no rewrite.
 *  - First segment is reserved (`chat`, `task`, `api`, ...) : no
 *    rewrite — existing root route handles it.
 *  - `head` (leading non-reserved segs) non-empty :
 *      - `tail` empty → rewrite to `/` (scope-only dashboard URL).
 *      - `tail[0] ∈ SCOPED_SUBPAGES` → rewrite to `/${tail.join('/')}`.
 *      - `tail[0]` other reserved → no rewrite (not a valid scoped
 *        URL under ADR-0020; 404s naturally).
 */
function rewriteTargetForScope(pathname: string): string | null {
  if (pathname === '/' || pathname === '') return null;
  const { head, tail } = splitScope(pathname);
  if (head.length === 0) return null; // first segment reserved or empty
  if (tail.length === 0) return '/';
  if (SCOPED_SUBPAGES.has(tail[0])) {
    return '/' + tail.join('/');
  }
  return null;
}

function applyScopedRewrite(req: NextRequest, res: NextResponse): NextResponse {
  const { pathname, search } = req.nextUrl;
  const target = rewriteTargetForScope(pathname);
  if (!target) return res;
  const url = req.nextUrl.clone();
  url.pathname = target;
  url.search = search;
  // Encode the ORIGINAL pathname in a search param on the rewrite
  // target so every distinct scope (`/foo`, `/foo/bar`, `/baz`)
  // gets a UNIQUE internal URL. Without this, multiple scope URLs
  // would all rewrite to `/` (or `/chat`, …) and Next's App Router
  // client cache would collide between them: the first navigation
  // appears as a no-op, the second forces a refresh. Internal-only
  // (browsers never see this param — they see the original URL),
  // and getCurrentScope keeps reading x-pathname for scope, not
  // the search param. (Fix for "two clicks to navigate", 2026-05-27.)
  url.searchParams.set('__scope', pathname);
  // NextResponse.rewrite preserves cookies set on the incoming
  // response, but we need to carry our headers (x-pathname) onto
  // the rewrite. Build a new response from rewrite() and copy.
  const rewritten = NextResponse.rewrite(url, { request: { headers: req.headers } });
  // Copy headers (x-pathname) and cookies (kdust_project sync) from
  // the response we were going to return onto the rewrite.
  res.headers.forEach((value, key) => rewritten.headers.set(key, value));
  res.cookies.getAll().forEach((c) => rewritten.cookies.set(c));
  return rewritten;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return applyScopedRewrite(req, withPathname(req, NextResponse.next()));
  }
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }

  // No password configured = let everything through (dev mode).
  if (!process.env.APP_PASSWORD) {
    return applyScopedRewrite(req, withPathname(req, NextResponse.next()));
  }

  const token = req.cookies.get('kdust_session')?.value;
  if (!token) return redirectLogin(req);

  try {
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET ?? '');
    await jwtVerify(token, secret);
    return applyScopedRewrite(req, withPathname(req, NextResponse.next()));
  } catch {
    return redirectLogin(req);
  }
}

function redirectLogin(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('from', req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
