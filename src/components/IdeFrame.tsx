'use client';

// IdeFrame — embeds the code-server IDE (ADR-0028, Franck 2026-06-03).
//
// The IDE is served by the `kdust-ide` sidecar behind the
// authenticated proxy (src/lib/ide/proxy.ts). The browser reaches the
// proxy at `baseUrl` (runtime IDE_PUBLIC_URL passed from the server)
// or, when unset, at the current host on port 4001 (the default
// compose mapping). `folder` deep-links code-server to the current
// project/scope via its `?folder=` query param.

import { useEffect, useMemo, useState } from 'react';

interface IdeFrameProps {
  /** Absolute path inside the IDE sidecar, e.g. /projects/foo/bar. */
  folder: string;
  /** Public base URL of the IDE proxy (runtime IDE_PUBLIC_URL), or null. */
  baseUrl: string | null;
  /** Whether the IDE is enabled (server: IDE_ENABLED !== 'false'). */
  enabled: boolean;
}

const DEFAULT_PROXY_PORT = '4001';

export function IdeFrame({ folder, baseUrl, enabled }: IdeFrameProps) {
  // Resolve the base URL on the client when the server did not provide
  // one (window is only available after mount).
  const [resolvedBase, setResolvedBase] = useState<string | null>(baseUrl);

  useEffect(() => {
    if (baseUrl) {
      setResolvedBase(baseUrl);
      return;
    }
    if (typeof window !== 'undefined') {
      const { protocol, hostname } = window.location;
      setResolvedBase(`${protocol}//${hostname}:${DEFAULT_PROXY_PORT}`);
    }
  }, [baseUrl]);

  const ideUrl = useMemo(() => {
    if (!resolvedBase) return null;
    const base = resolvedBase.replace(/\/+$/, '');
    return `${base}/?folder=${encodeURIComponent(folder)}`;
  }, [resolvedBase, folder]);

  if (!enabled) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-zinc-500">
        <p className="font-medium text-zinc-700">IDE disabled</p>
        <p>
          Set <code className="rounded bg-zinc-100 px-1 py-0.5">IDE_ENABLED=true</code>{' '}
          and start the <code className="rounded bg-zinc-100 px-1 py-0.5">kdust-ide</code>{' '}
          service to enable the in-stack code-server.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-1.5 text-xs text-zinc-500">
        <span className="truncate">
          Workspace: <code className="text-zinc-700">{folder}</code>
        </span>
        {ideUrl && (
          <a
            href={ideUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded px-2 py-0.5 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
          >
            Open in new tab ↗
          </a>
        )}
      </div>
      {ideUrl ? (
        <iframe
          title="code-server"
          src={ideUrl}
          className="h-full w-full flex-1 border-0"
          // code-server needs broad capabilities to run as an IDE.
          allow="clipboard-read; clipboard-write; cross-origin-isolated"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
          Resolving IDE URL…
        </div>
      )}
    </div>
  );
}
