import Link from 'next/link';
import { MessageSquare, Clock, Settings, Link2 } from 'lucide-react';

export function Nav() {
  const items = [
    { href: '/', label: 'Dashboard', icon: Link2 },
    { href: '/chat', label: 'Chat', icon: MessageSquare },
    { href: '/crons', label: 'Crons', icon: Clock },
    { href: '/settings', label: 'Settings', icon: Settings },
  ];
  return (
    <aside className="w-56 shrink-0 border-r border-slate-200 dark:border-slate-800 p-4">
      <div className="text-xl font-bold mb-6">KDust</div>
      <nav className="flex flex-col gap-1">
        {items.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-slate-200/60 dark:hover:bg-slate-800"
          >
            <Icon size={16} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}
