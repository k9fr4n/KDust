import Link from 'next/link';
import {
  Settings as SettingsIcon,
  Lightbulb,
  BarChart3,
  ChevronRight,
  FolderGit2,
} from 'lucide-react';

export const dynamic = 'force-dynamic';

/**
 * Back-office hub. Each concern has its own dedicated route; this
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
      href: '/settings/projects',
      title: 'Projects',
      description:
        'Register / unregister projects tracked by KDust: git URL, default branch, manual sync trigger.',
      icon: <FolderGit2 size={18} />,
      accent: 'text-teal-600 dark:text-teal-400',
    },
    {
      href: '/settings/global',
      title: 'Global settings',
      description:
        'Application-wide configuration: Dust endpoint, WorkOS OAuth, default notifications.',
      icon: <SettingsIcon size={18} />,
      accent: 'text-slate-600 dark:text-slate-300',
    },
    {
      href: '/settings/advice',
      title: 'Advice categories',
      description:
        'Weekly analysis cron templates: prompts, schedules, add/remove categories.',
      icon: <Lightbulb size={18} />,
      accent: 'text-amber-600 dark:text-amber-400',
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

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-bold">Back-office</h1>
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
