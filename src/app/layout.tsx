import './globals.css';
// Syntax-highlighting theme for code blocks rendered by <MessageMarkdown>
// (rehype-highlight + highlight.js). github-dark stays readable on the
// dark pre background we apply in MessageMarkdown.tsx regardless of
// the app's light/dark mode.
import 'highlight.js/styles/github-dark.css';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Nav } from '@/components/Nav';
import { DustAuthBanner } from '@/components/DustAuthBanner';
import { ConversationsBusListener } from '@/components/ConversationsBusListener';

export const metadata: Metadata = {
  title: 'KDust',
  description: 'Web UI for Dust agents with cron scheduling',
};

// Routes that own their full chrome and must not show the global
// Nav / banner / padded <main>. /login is the canonical case: the
// user is unauthenticated, the nav links would 401, and the
// session-health banner would be noise. Keep this list short.
const CHROMELESS_PATHS = ['/login'];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // src/middleware.ts injects the request pathname into `x-pathname`
  // on every server-handled request. Falling back to `''` keeps the
  // default (chrome visible) safe when the header is absent.
  const pathname = (await headers()).get('x-pathname') ?? '';
  const chromeless = CHROMELESS_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );

  return (
    <html lang="fr">
      <body>
        {chromeless ? (
          children
        ) : (
          <>
            <Nav />
            {/* Session health banner (Franck 2026-04-21 18:30): if the
                DustSession row is missing or expired (e.g. after the
                workos refresh grant returned 400/401 and we wiped the
                row \u2014 see src/lib/dust/workos.ts), surface an amber
                banner with a one\u2011click Re\u2011auth CTA so users don\u0027t
                waste time wondering why agents silently fail. Server\u2011
                rendered; null when the session is healthy. */}
            <DustAuthBanner />
            {/* Cross-tab sync (Franck 2026-04-20 17:04): any tab that
                mutates a conversation (pin / delete) broadcasts an event
                over BroadcastChannel (fallback: localStorage). Every
                mounted page refreshes its server-rendered listings so
                pinning a conv on /chat reflects on an open /conversation
                tab without a manual reload, and vice-versa. */}
            <ConversationsBusListener />
            <main className="px-4 lg:px-6 py-6">{children}</main>
          </>
        )}
      </body>
    </html>
  );
}
