import Link from 'next/link';
import {
  Settings as SettingsIcon,
  BarChart3,
  ChevronRight,
  FolderGit2,
  Bot,
  KeyRound,
  MessageCircle,
  Terminal,
  Plug,
} from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';

export const dynamic = 'force-dynamic';

/**
 * Settings hub. Each concern has its own dedicated route; this
 * page is just a navigation index. Previously the global app
 * settings form lived inline here — moved to /settings/global so
 * each tile has a symmetric UX and this page stays scannable.
 */
export default function SettingsIndex() {
  const tiles: {
    href: string;
    title: string;
    description: string;
    icon: React.ReactNode;
    accent: string;
  }[] = [
    {
      href: '/settings/global',
      title: 'App Settings',
      description:
        'Application-wide configuration: Dust endpoint, WorkOS OAuth, default notifications.',
      icon: <SettingsIcon size={18} />,
      accent: 'text-slate-600 dark:text-slate-300',
    },
    // Agents placed BEFORE Projects (Franck 2026-04-19 19:56):
    // the "set up an agent" step is more often the starting point
    // for a new Ecritel user than adding a git project.
    {
      href: '/settings/agents',
      title: 'Agents',
      description:
        'Browse the Dust agents visible on your tenant and create new ones from KDust (name, description, instructions, emoji).',
      icon: <Bot size={18} />,
      accent: 'text-indigo-600 dark:text-indigo-400',
    },
    {
      href: '/settings/projects',
      title: 'Projects',
      description:
        'Register / unregister projects tracked by KDust: git URL, default branch, manual sync trigger.',
      icon: <FolderGit2 size={18} />,
      accent: 'text-teal-600 dark:text-teal-400',
    },
    {
      // Secrets manager (Franck 2026-04-21 21:45): global store of
      // credentials a task can inject as env vars into its command-
      // runner child processes. Never exposed to the LLM. See
      // /settings/secrets for the editor.
      href: '/settings/secrets',
      title: 'Secrets',
      description:
        'Encrypted credentials injected as environment variables into command-runner tasks (GitHub tokens, cloud creds, ...). Values never reach the LLM.',
      icon: <KeyRound size={18} />,
      accent: 'text-rose-600 dark:text-rose-400',
    },
    {
      // SSH identities (Franck 2026-05-09, ADR-0011). Self-hosted
      // SSH keys for the git push pipeline + a stripped-down debug
      // panel (replaces the legacy /api/ssh-debug standalone page).
      href: '/settings/ssh',
      title: 'SSH',
      description:
        'Self-hosted SSH identities for the git push pipeline. Encrypted at rest, materialised to tmpfs at boot. Includes a reachability probe.',
      icon: <Terminal size={18} />,
      accent: 'text-emerald-600 dark:text-emerald-400',
    },
    {
      // Docker MCP gateway (Franck 2026-05-10, ADR-0012). Lets
      // operators declare which catalog servers and tools are
      // exposed to each project's agent. Default-deny, per-project
      // allow-list. Replaces the seed-mcp-gateway.mjs script of
      // the V1 release.
      href: '/settings/mcp',
      title: 'MCP Gateway',
      description:
        'Docker MCP catalog servers exposed to your Dust agents (GitHub, etc.). Per-project allow-list of tools, secret bindings, default-deny.',
      icon: <Plug size={18} />,
      accent: 'text-violet-600 dark:text-violet-400',
    },
    {
      // Telegram chat bridge (Franck 2026-04-25 22:00). Long-poll
      // loop on api.telegram.org; outbound-only, no exposure of
      // KDust required.
      href: '/settings/telegram',
      title: 'Telegram chat',
      description:
        'Talk to your Dust agents through a Telegram bot (long-polling, fully outbound \u2014 no inbound port).',
      icon: <MessageCircle size={18} />,
      accent: 'text-sky-600 dark:text-sky-400',
    },
    {
      href: '/settings/usage',
      title: 'Usage dashboard',
      description:
        'Full stats on your Dust activity through KDust: tokens, messages, conversations, runs, top agents / projects, 30-day timelines.',
      icon: <BarChart3 size={18} />,
      accent: 'text-brand-600 dark:text-brand-400',
    },
  ];

  // Sort sections alphabetically by title (Franck 2026-05-09).
  // The original order encoded an opinionated UX flow ("agents
  // before projects" etc.); now that we have 8+ tiles, alphabetical
  // is more discoverable. Use a locale-aware comparator so future
  // accented titles still sort sensibly.
  tiles.sort((a, b) => a.title.localeCompare(b.title));

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader icon={<SettingsIcon size={20} />} title="Settings" />
      <p className="text-sm text-slate-500">
        Administrative sections. Pick a category to configure or
        inspect KDust.
      </p>

      <div className="grid grid-cols-1 gap-2">
        {tiles.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="group flex items-start gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 hover:border-brand-400 hover:shadow-sm transition"
          >
            <span
              className={`shrink-0 mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-md bg-slate-50 dark:bg-slate-800 ${t.accent}`}
            >
              {t.icon}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-base font-semibold text-slate-900 dark:text-slate-100 group-hover:text-brand-600 dark:group-hover:text-brand-400">
                {t.title}
              </span>
              <span className="block text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                {t.description}
              </span>
            </span>
            <ChevronRight
              size={18}
              className="shrink-0 mt-2 text-slate-300 dark:text-slate-600 group-hover:text-brand-500 transition"
            />
          </Link>
        ))}
      </div>
    </div>
  );
}
