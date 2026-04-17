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
  const base =
    'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors';

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
} from 'lucide-react';

// Use `any` for the map value: lucide's ForwardRefExoticComponent doesn't
// directly satisfy ComponentType<{size?:number}>, and we don't need the
// finer typing here — we only ever pass `size`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ICONS: Record<string, any> = {
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
