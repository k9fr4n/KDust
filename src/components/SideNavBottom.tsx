'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CircleUser,
  Settings as SettingsIcon,
  Info,
  LogOut,
  Link2,
  Link2Off,
  ScrollText,
  BarChart3,
  ChevronRight,
  FolderGit2,
  Bot,
  KeyRound,
  MessageCircle,
  Terminal,
  Plug,
  type LucideIcon,
} from 'lucide-react';
import { apiGet, apiSend } from '@/lib/api/client';

/**
 * Sidebar bottom row — user identity + settings (Franck 2026-05-21).
 *
 * Two popovers anchored to the bottom-left of the viewport:
 *   - UserPopover   : Dust session status + Sign out
 *   - SettingsPopover : index of /settings/* sections + Container log + About
 *
 * Replaces the legacy single <UserMenu> dropdown that used to sit
 * top-right. Layout adapts to the sidebar's collapsed/expanded state:
 *   collapsed : two stacked icon buttons (avatar / cog)
 *   expanded  : avatar + name (popover trigger) | cog
 */

type Status = {
  region: string | null;
  workspaceId: string | null;
  email: string | null;
  name: string | null;
};

export function SideNavBottom({ expanded }: { expanded: boolean }) {
  const [status, setStatus] = useState<Status>({
    region: null,
    workspaceId: null,
    email: null,
    name: null,
  });
  const [userOpen, setUserOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Refresh the Dust session status whenever a popover opens so the
  // user sees fresh region / workspace info after a reconnect.
  useEffect(() => {
    if (!userOpen && !settingsOpen) return;
    apiGet<Status>('/api/dust/region').then(setStatus).catch(() => {});
  }, [userOpen, settingsOpen]);

  // Click-outside dismiss.
  useEffect(() => {
    if (!userOpen && !settingsOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (userOpen && userRef.current && !userRef.current.contains(t)) {
        setUserOpen(false);
      }
      if (settingsOpen && settingsRef.current && !settingsRef.current.contains(t)) {
        setSettingsOpen(false);
      }
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [userOpen, settingsOpen]);

  const connected = !!status.workspaceId;
  const displayName =
    status.name ?? status.email ?? (connected ? 'Signed in' : 'Not signed in');

  return (
    <div className="flex items-center gap-1">
      <div ref={userRef} className="relative flex-1 min-w-0">
        <button
          type="button"
          onClick={(e) => {
            // Stop propagation so the global click-outside handler
            // attached on `window` (which runs in the capture-bubble
            // phase after this onClick) doesn't immediately close the
            // popover we just opened. The handler ignores clicks
            // inside `userRef`, but the toggle itself is inside, so
            // we are only guarding against the case where another
            // popover's outside-handler closes us. Cheaper than
            // tracking a one-tick "just opened" flag.
            e.stopPropagation();
            setSettingsOpen(false);
            setUserOpen((v) => !v);
          }}
          aria-haspopup="menu"
          aria-expanded={userOpen}
          title={displayName}
          className={
            'flex items-center gap-2 h-10 rounded-md transition-colors w-full ' +
            (expanded ? 'px-2 text-sm text-slate-700 dark:text-slate-300' : 'justify-center') +
            ' hover:bg-slate-100 dark:hover:bg-slate-800'
          }
        >
          <CircleUser
            size={18}
            className={connected ? 'text-green-600 shrink-0' : 'text-slate-400 shrink-0'}
          />
          {expanded && <span className="truncate flex-1 text-left">{displayName}</span>}
        </button>
        {userOpen && (
          <UserPopoverPanel
            status={status}
            connected={connected}
            onClose={() => setUserOpen(false)}
          />
        )}
      </div>

      <div ref={settingsRef} className="relative">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setUserOpen(false);
            setSettingsOpen((v) => !v);
          }}
          aria-haspopup="menu"
          aria-expanded={settingsOpen}
          aria-label="Settings menu"
          title="Settings"
          className="flex items-center justify-center h-10 w-10 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <SettingsIcon size={18} />
        </button>
        {settingsOpen && <SettingsPopoverPanel onClose={() => setSettingsOpen(false)} />}
      </div>
    </div>
  );
}

/* ---------------- UserPopover ---------------- */

function UserPopoverPanel({
  status,
  connected,
  onClose,
}: {
  status: Status;
  connected: boolean;
  onClose: () => void;
}) {
  const logout = async () => {
    await apiSend('POST', '/api/auth/logout').catch(() => {});
    window.location.href = '/login';
  };

  return (
    <div
      role="menu"
      className="absolute left-full bottom-0 ml-2 w-72 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-2xl p-2 z-50"
      style={{ animation: 'kd-pop-in 140ms ease-out' }}
    >
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 mb-1">
        <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Dust</div>
        {connected ? (
          <div className="space-y-0.5">
            {(status.name || status.email) && (
              <div className="text-sm font-medium truncate" title={status.email ?? ''}>
                {status.name ?? status.email}
              </div>
            )}
            {status.email && status.name && (
              <div className="text-xs text-slate-500 truncate">{status.email}</div>
            )}
            <div className="text-sm flex items-center gap-1.5 text-green-600 dark:text-green-400">
              <Link2 size={14} /> Connected
            </div>
            <div className="text-xs text-slate-500 font-mono truncate">
              {status.workspaceId}
            </div>
            <div className="text-xs text-slate-500">Region: {status.region ?? '\u2014'}</div>
          </div>
        ) : (
          <Link
            href="/dust/connect"
            onClick={onClose}
            className="flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400 hover:underline"
          >
            <Link2Off size={14} /> Not connected — Sign in to Dust
          </Link>
        )}
      </div>

      <button
        onClick={() => void logout()}
        role="menuitem"
        className="flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 w-full text-left text-red-600 dark:text-red-400"
      >
        <LogOut size={16} /> Sign out
      </button>
    </div>
  );
}

/* ---------------- SettingsPopover ---------------- */

type SettingsTile = {
  href: string;
  title: string;
  icon: LucideIcon;
  accent: string;
};

// Mirrors /settings/page.tsx tile list. Kept in sync manually — if
// the settings hub gains a new section, add it here too.
const SETTINGS_TILES: SettingsTile[] = [
  { href: '/settings/global', title: 'App Settings', icon: SettingsIcon, accent: 'text-slate-600 dark:text-slate-300' },
  { href: '/settings/agents', title: 'Agents', icon: Bot, accent: 'text-indigo-600 dark:text-indigo-400' },
  { href: '/settings/mcp', title: 'MCP Gateway', icon: Plug, accent: 'text-violet-600 dark:text-violet-400' },
  { href: '/settings/projects', title: 'Projects', icon: FolderGit2, accent: 'text-teal-600 dark:text-teal-400' },
  { href: '/settings/secrets', title: 'Secrets', icon: KeyRound, accent: 'text-rose-600 dark:text-rose-400' },
  { href: '/settings/ssh', title: 'SSH', icon: Terminal, accent: 'text-emerald-600 dark:text-emerald-400' },
  { href: '/settings/telegram', title: 'Telegram chat', icon: MessageCircle, accent: 'text-sky-600 dark:text-sky-400' },
  { href: '/settings/usage', title: 'Usage dashboard', icon: BarChart3, accent: 'text-brand-600 dark:text-brand-400' },
];

// Alphabetical sort to match the /settings hub ordering.
SETTINGS_TILES.sort((a, b) => a.title.localeCompare(b.title));

function SettingsPopoverPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="menu"
      className="absolute left-full bottom-0 ml-2 w-72 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-2xl p-2 z-50"
      style={{ animation: 'kd-pop-in 140ms ease-out' }}
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500">
        Settings
      </div>
      <div className="flex flex-col">
        {SETTINGS_TILES.map((t) => {
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              onClick={onClose}
              role="menuitem"
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 group"
            >
              <Icon size={16} className={t.accent + ' shrink-0'} />
              <span className="flex-1 truncate">{t.title}</span>
              <ChevronRight
                size={14}
                className="text-slate-300 dark:text-slate-600 opacity-0 group-hover:opacity-100"
              />
            </Link>
          );
        })}
      </div>

      <div className="border-t border-slate-200 dark:border-slate-800 my-1" />
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500">
        System
      </div>
      <Link
        href="/logs"
        onClick={onClose}
        role="menuitem"
        className="flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <ScrollText size={16} className="shrink-0 text-slate-500" />
        <span className="flex-1 truncate">Container log</span>
      </Link>
      <Link
        href="/about"
        onClick={onClose}
        role="menuitem"
        className="flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <Info size={16} className="shrink-0 text-slate-500" />
        <span className="flex-1 truncate">About</span>
      </Link>
    </div>
  );
}
