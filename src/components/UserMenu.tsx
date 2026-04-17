'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  CircleUser,
  Settings as SettingsIcon,
  Terminal,
  Info,
  LogOut,
  Link2,
  Link2Off,
  FolderGit2,
  ScrollText,
} from 'lucide-react';

type Status = {
  region: string | null;
  workspaceId: string | null;
  email: string | null;
  name: string | null;
};

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>({
    region: null,
    workspaceId: null,
    email: null,
    name: null,
  });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch('/api/dust/region')
      .then((r) =>
        r.ok
          ? r.json()
          : { region: null, workspaceId: null, email: null, name: null },
      )
      .then(setStatus)
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [open]);

  const connected = !!status.workspaceId;
  const displayName =
    status.name ?? status.email ?? (connected ? 'Signed in' : 'Not signed in');
  const item =
    'flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-slate-100 dark:hover:bg-slate-800';

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-full border border-transparent hover:border-slate-200 dark:hover:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 max-w-[220px]"
        title={displayName}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <CircleUser
          size={22}
          className={connected ? 'text-green-600 shrink-0' : 'text-slate-400 shrink-0'}
        />
        <span className="hidden sm:inline text-sm font-medium truncate">
          {displayName}
        </span>
      </button>

      {open && (
        <div
          className="absolute right-0 mt-2 w-72 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-lg p-2 z-20"
          role="menu"
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
                <div className="text-xs text-slate-500 font-mono truncate">{status.workspaceId}</div>
                <div className="text-xs text-slate-500">Region: {status.region ?? '—'}</div>
              </div>
            ) : (
              <Link
                href="/dust/connect"
                onClick={() => setOpen(false)}
                className="flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400 hover:underline"
              >
                <Link2Off size={14} /> Not connected — Sign in to Dust
              </Link>
            )}
          </div>

          <Link href="/projects" onClick={() => setOpen(false)} className={item} role="menuitem">
            <FolderGit2 size={16} /> Projects
          </Link>
          <Link href="/settings" onClick={() => setOpen(false)} className={item} role="menuitem">
            <SettingsIcon size={16} /> Settings
          </Link>
          <Link href="/logs" onClick={() => setOpen(false)} className={item} role="menuitem">
            <ScrollText size={16} /> Container logs
          </Link>
          <Link href="/debug/ssh" onClick={() => setOpen(false)} className={item} role="menuitem">
            <Terminal size={16} /> SSH debug
          </Link>
          <Link href="/about" onClick={() => setOpen(false)} className={item} role="menuitem">
            <Info size={16} /> About
          </Link>

          <div className="border-t border-slate-200 dark:border-slate-800 my-1" />

          <button
            onClick={logout}
            className={`${item} w-full text-left text-red-600 dark:text-red-400`}
            role="menuitem"
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
