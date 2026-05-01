'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Lock } from 'lucide-react';

/**
 * Client-side nav link that highlights itself when the current URL
 * starts with its href. Rendered from the server Nav component which
 * provides the href/label/icon props already resolved.
 *
 * Matching strategy: "active if pathname === href or startsWith(href + '/')".
 * This lets nested routes (eg. /projects/[id]) still light up the
 * "Conseils" link when it points to the current project's dashboard.
 */
export function NavItem({
  href,
  label,
  iconName,
  disabled,
}: {
  href: string;
  label: string;
  iconName: string;
  disabled?: boolean;
}) {
  const pathname = usePathname() ?? '/';
  // Height aligned with ProjectSwitcher / HeaderIcons / UserMenu (all
  // h-9) so every element in the top bar sits on the same baseline.
  // `flex-1 justify-center` makes items split the available nav
  // space evenly (tab-bar feel) — see Nav.tsx where the parent <nav>
  // is `flex-1` and there is exactly one consumer of NavItem.
  const base =
    'flex flex-1 items-center justify-center gap-2 h-9 px-3 rounded-md text-sm transition-colors';

  if (disabled) {
    return (
      <span
        title="Select a project first"
        className={`${base} text-slate-400 dark:text-slate-600 cursor-not-allowed`}
      >
        <IconByName name={iconName} />
        <span>{label}</span>
        <Lock size={12} className="opacity-60" />
      </span>
    );
  }

  // Strip hash/query from href for matching; keep the link itself intact.
  const bareHref = href.split('#')[0].split('?')[0];
  const active =
    bareHref === '/'
      ? pathname === '/'
      : pathname === bareHref || pathname.startsWith(bareHref + '/');

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`${base} ${
        active
          ? 'bg-brand-600 text-white font-semibold hover:bg-brand-700'
          : 'hover:bg-slate-100 dark:hover:bg-slate-800'
      }`}
    >
      <IconByName name={iconName} />
      <span>{label}</span>
    </Link>
  );
}

// Tiny icon dispatcher so the server Nav can pass string names to this
// client component without importing lucide-react on the server side.
import {
  MessageSquare,
  Clock,
  LayoutDashboard,
  Lightbulb,
  Activity,
  type LucideIcon,
} from 'lucide-react';

// We only call these icons with `size`; reuse lucide's own LucideIcon
// type so the map is typed without the open `any` escape hatch.
const ICONS: Record<string, LucideIcon> = {
  MessageSquare,
  Clock,
  LayoutDashboard,
  Lightbulb,
  Activity,
};

function IconByName({ name }: { name: string }) {
  const Cmp = ICONS[name] ?? LayoutDashboard;
  return <Cmp size={16} />;
}
