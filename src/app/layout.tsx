import './globals.css';
// Syntax-highlighting theme for code blocks rendered by <MessageMarkdown>
// (rehype-highlight + highlight.js). github-dark stays readable on the
// dark pre background we apply in MessageMarkdown.tsx regardless of
// the app's light/dark mode.
import 'highlight.js/styles/github-dark.css';
import type { Metadata } from 'next';
import { Nav } from '@/components/Nav';
import { ConversationsBusListener } from '@/components/ConversationsBusListener';

export const metadata: Metadata = {
  title: 'KDust',
  description: 'Web UI for Dust agents with cron scheduling',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <Nav />
        {/* Cross-tab sync (Franck 2026-04-20 17:04): any tab that
            mutates a conversation (pin / delete) broadcasts an event
            over BroadcastChannel (fallback: localStorage). Every
            mounted page refreshes its server-rendered listings so
            pinning a conv on /chat reflects on an open /conversations
            tab without a manual reload, and vice-versa. */}
        <ConversationsBusListener />
        <main className="px-4 lg:px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
