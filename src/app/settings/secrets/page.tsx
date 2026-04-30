// src/app/settings/secrets/page.tsx
//
// Secrets manager UI (Franck 2026-04-21 21:45).
// Lists every Secret in the DB plus its usage metadata (how many
// tasks bind it, last time it was injected, description). Creation
// and deletion are delegated to the SecretsEditor client component
// because they need local form state, optimistic refresh, and
// confirmation dialogs.

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { listSecrets } from '@/lib/secrets/repo';
import { SecretsEditor } from './SecretsEditor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function SecretsPage() {
  const secrets = await listSecrets();
  return (
    <div className="max-w-4xl space-y-6">
      <header className="space-y-1">
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Settings
        </Link>
        <h1 className="text-2xl font-bold">Secrets</h1>
        <p className="text-sm text-slate-500">
          Credentials stored encrypted at rest (AES-256-GCM via
          <code className="mx-1 rounded bg-slate-100 dark:bg-slate-800 px-1">APP_ENCRYPTION_KEY</code>)
          and injected server-side as environment variables into
          command-runner tasks. Values are never returned by any
          API and never reach the agent’s prompt.
        </p>
      </header>
      <SecretsEditor initial={secrets.map((s) => ({
        ...s,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
        lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
      }))} />
    </div>
  );
}
