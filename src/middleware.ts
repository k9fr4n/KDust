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
function candidateProjectFsPath(pathname: string): string | null {
  // Strip leading slash, drop trailing empty segment.
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  const [a, b, c] = parts;
  if (
    RESERVED_SEGMENTS.has(a) ||
    RESERVED_SEGMENTS.has(b) ||
    RESERVED_SEGMENTS.has(c)
  ) {
    return null;
  }
  return `${a}/${b}/${c}`;
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
  // ADR-0020: sync the kdust_project cookie with project-leaf URLs.
  // Only touched when the path looks like /<l1>/<l2>/<project>/...
  // (non-reserved segments). Folder URLs are skipped. Invalid
  // candidates (e.g. typo'd project name) are still written — the
  // downstream resolver returns null when the fsPath does not
  // resolve to a real project, so legacy /chat etc. simply render
  // in "no project" mode after the typo. No DB hit in middleware.
  const candidate = candidateProjectFsPath(req.nextUrl.pathname);
  if (candidate) {
    const existing = req.cookies.get(CURRENT_PROJECT_COOKIE)?.value;
    if (existing !== candidate) {
      res.cookies.set(CURRENT_PROJECT_COOKIE, candidate, {
        httpOnly: false,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
      });
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
