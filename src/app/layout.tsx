import './globals.css';
// Syntax-highlighting theme for code blocks rendered by <MessageMarkdown>
// (rehype-highlight + highlight.js). github-dark stays readable on the
// dark pre background we apply in MessageMarkdown.tsx regardless of
// the app's light/dark mode.
import 'highlight.js/styles/github-dark.css';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { SideNav } from '@/components/SideNav';
import { FloatingLogsButton } from '@/components/FloatingLogsButton';
import { DustAuthBanner } from '@/components/DustAuthBanner';
import { ConversationsBusListener } from '@/components/ConversationsBusListener';
import { getCurrentProject } from '@/lib/current-project';

export const metadata: Metadata = {
  // Per-page titles (Franck 2026-05-21): pages export their own
  // `title` (or `generateMetadata`) and Next merges via the template
  // below — e.g. /task → "Tasks · KDust", /run/[id] → "{name} · KDust".
  // Client-side pages that cannot use the metadata API set
  // document.title via <DocumentTitle title="…" />.
  title: { default: 'KDust', template: '%s · KDust' },
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

  // Project scope (Franck 2026-05-21): the new SideNav is a client
  // component and cannot itself read the project cookie. We resolve
  // it server-side once per request and pass it as a plain boolean
  // prop, matching what the legacy <Nav> was doing.
  const currentProject = chromeless ? null : await getCurrentProject();
  const projectScoped = !!currentProject;

  return (
    <html lang="fr">
      <body>
        {chromeless ? (
          children
        ) : (
          <>
            {/* New chrome (Franck 2026-05-21): claude.ai-style left
                sidebar replaces the legacy top-bar <Nav>. The bar
                stays at w-14 collapsed (default), expands to w-60
                on click. Main content carries a constant `pl-14` so
                the layout never shifts; the expanded panel overlays
                on top of the content. */}
            <SideNav projectScoped={projectScoped} />
            {/* Floating logs status icon (top-right). Lifted out of
                the old <HeaderIcons> when the top-bar disappeared. */}
            <FloatingLogsButton />
            {/* Session health banner — see DustSession contract. */}
            <DustAuthBanner />
            {/* Cross-tab conversation sync — see component header. */}
            <ConversationsBusListener />
            <main className="pl-14 min-h-dvh">
              <div className="px-4 lg:px-6 py-6">{children}</div>
            </main>
          </>
        )}
      </body>
    </html>
  );
}
