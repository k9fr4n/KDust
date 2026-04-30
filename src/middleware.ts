import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/health'];

/**
 * Propagates the request pathname into `x-pathname` on every
 * server-handled request so that server components (e.g.
 * DustAuthBanner) can conditionally render based on the current
 * route \u2014 Next 15 has no built-in API for that in RSC land.
 * Added 2026-04-21 (Franck).
 */
function withPathname(req: NextRequest, res: NextResponse): NextResponse {
  res.headers.set('x-pathname', req.nextUrl.pathname);
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
