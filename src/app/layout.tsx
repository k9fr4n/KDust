import './globals.css';
// Syntax-highlighting theme for code blocks rendered by <MessageMarkdown>
// (rehype-highlight + highlight.js). github-dark stays readable on the
// dark pre background we apply in MessageMarkdown.tsx regardless of
// the app's light/dark mode.
import 'highlight.js/styles/github-dark.css';
import type { Metadata } from 'next';
import { Nav } from '@/components/Nav';

export const metadata: Metadata = {
  title: 'KDust',
  description: 'Web UI for Dust agents with cron scheduling',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <Nav />
        <main className="px-4 lg:px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
