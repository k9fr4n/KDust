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
} from 'lucide-react';

type Status = { region: string | null; workspaceId: string | null };

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ region: null, workspaceId: null });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch('/api/dust/region')
      .then((r) => (r.ok ? r.json() : { region: null, workspaceId: null }))
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
        className="flex items-center gap-2 px-2 py-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800"
        title="User menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <CircleUser size={22} className={connected ? 'text-green-600' : 'text-slate-400'} />
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
