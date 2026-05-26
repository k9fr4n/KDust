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
  'settings',
  'login',
  'api',
  'dust',
  '_next',
  'favicon.ico',
]);

const CURRENT_PROJECT_COOKIE = 'kdust_project';

/**
 * If `pathname` starts with three non-reserved segments, return the
 * candidate fsPath (`seg1/seg2/seg3`). Otherwise null. This is a
 * pure string check \u2014 the actual project existence is enforced
 * by the page server component below (404 on miss). Used to keep
 * the `kdust_project` cookie in sync with project-leaf URLs so
 * legacy components (chat client, /api/projects/current, MCP
 * ensures, Telegram bridge) keep working without touching them.
 * Folder URLs (1 or 2 segments) leave the cookie untouched: the
 * folder pages drive their filtering from URL params, not cookie.
 */
/**
 * Classify a pathname against the project cookie:
 *  - 'set'   when URL is a 3-segment project leaf -> sync cookie
 *  - 'clear' when URL is `/` (explicit root) or a 1-2 segment
 *            folder URL -> kill cookie so a later visit to a
 *            reserved-only legacy route (/chat, /task, ...) does
 *            NOT snap back to the previous project via the cookie
 *            fallback. Franck 2026-05-27 bug.
 *  - 'keep'  otherwise (reserved-only paths: /chat, /task, /api,
 *            ...). The cookie remains the source of truth there.
 */
type CookieAction =
  | { action: 'set'; fsPath: string }
  | { action: 'clear' }
  | { action: 'keep' };

function classifyForCookie(pathname: string): CookieAction {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { action: 'clear' };
  // Count leading non-reserved segments (stop at the first reserved
  // one - sub-page tail starts there).
  let lead = 0;
  for (const p of parts) {
    if (RESERVED_SEGMENTS.has(p)) break;
    lead++;
    if (lead === 3) break;
  }
  if (lead === 0) return { action: 'keep' };
  if (lead >= 3) {
    return { action: 'set', fsPath: `${parts[0]}/${parts[1]}/${parts[2]}` };
  }
  return { action: 'clear' };
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

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return withPathname(req, NextResponse.next());
  }
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }

  // No password configured = let everything through (dev mode).
  if (!process.env.APP_PASSWORD) return withPathname(req, NextResponse.next());

  const token = req.cookies.get('kdust_session')?.value;
  if (!token) return redirectLogin(req);

  try {
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET ?? '');
    await jwtVerify(token, secret);
    return withPathname(req, NextResponse.next());
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
