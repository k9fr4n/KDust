// src/app/settings/ssh/page.tsx
//
// SSH identities + diagnostics (Franck 2026-05-09, ADR-0011).
// Server component: lists identities + the bootstrap snapshot, then
// hands everything to the SshEditor client component for CRUD and
// the on-demand reachability probe.

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { listIdentities } from '@/lib/ssh/identity';
import { describeSshRuntime } from '@/lib/ssh/bootstrap';
import { SshEditor } from './SshEditor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function SshPage() {
  const [identities, snapshot] = await Promise.all([
    listIdentities(),
    describeSshRuntime(),
  ]);
  return (
    <div className="max-w-4xl space-y-6">
      <header className="space-y-1">
        <Link href="/settings" className="text-sm text-slate-500 hover:underline inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Settings
        </Link>
        <h1 className="text-2xl font-bold">SSH</h1>
        <p className="text-sm text-slate-500">
          Self-hosted SSH identities for the git push pipeline. Private keys are
          stored encrypted (AES-256-GCM via <code className="mx-1 rounded bg-slate-100 dark:bg-slate-800 px-1">APP_ENCRYPTION_KEY</code>)
          and materialised at boot to a tmpfs at
          <code className="mx-1 rounded bg-slate-100 dark:bg-slate-800 px-1">{snapshot.runtimeDir}</code>.
          Falls back to the host&apos;s <code className="mx-1 rounded bg-slate-100 dark:bg-slate-800 px-1">SSH_AUTH_SOCK</code> /
          <code className="mx-1 rounded bg-slate-100 dark:bg-slate-800 px-1">~/.ssh</code> when no identity is configured.
        </p>
      </header>
      <SshEditor
        initial={identities.map((i) => ({
          ...i,
          createdAt: i.createdAt.toISOString(),
          updatedAt: i.updatedAt.toISOString(),
          lastUsedAt: i.lastUsedAt?.toISOString() ?? null,
        }))}
        snapshot={snapshot}
      />
    </div>
  );
}
