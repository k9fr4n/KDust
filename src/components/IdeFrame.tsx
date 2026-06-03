'use client';

// IdeFrame — embeds the code-server IDE (ADR-0028, Franck 2026-06-03).
//
// The IDE is served by the `kdust-ide` sidecar behind the
// authenticated proxy (src/lib/ide/proxy.ts). The browser reaches the
// proxy at `baseUrl` (runtime IDE_PUBLIC_URL passed from the server)
// or, when unset, at the current host on port 4001 (the default
// compose mapping). `folder` deep-links code-server to the current
// project/scope via its `?folder=` query param.

import { useEffect, useState } from 'react';
import { buildIdeUrl } from '@/lib/ide/url';

interface IdeFrameProps {
  /** Absolute path inside the IDE sidecar, e.g. /projects/foo/bar. */
  folder: string;
  /** Public base URL of the IDE proxy (runtime IDE_PUBLIC_URL), or null. */
  baseUrl: string | null;
  /** Whether the IDE is enabled (server: IDE_ENABLED !== 'false'). */
  enabled: boolean;
}

export function IdeFrame({ folder, baseUrl, enabled }: IdeFrameProps) {
  // Resolve the deep link on the client: buildIdeUrl falls back to
  // <host>:4001 via window.location, only available after mount.
  const [ideUrl, setIdeUrl] = useState<string | null>(() => buildIdeUrl(folder, baseUrl));

  useEffect(() => {
    setIdeUrl(buildIdeUrl(folder, baseUrl));
  }, [folder, baseUrl]);

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
