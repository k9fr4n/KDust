import Link from 'next/link';
import { db } from '@/lib/db';
import { loadTokens } from '@/lib/dust/tokens';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const [session, nbCrons, nbConv] = await Promise.all([
    loadTokens(),
    db.cronJob.count(),
    db.conversation.count(),
  ]);

  const connected = !!session?.workspaceId;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-4">Dashboard</h1>

      <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 mb-4">
        <h2 className="font-semibold mb-2">Dust</h2>
        {connected ? (
          <p className="text-green-600 dark:text-green-400">
            ✓ Connecté au workspace <code>{session?.workspaceId}</code>
          </p>
        ) : (
          <p>
            Non connecté.{' '}
            <Link className="underline text-brand-600" href="/dust/connect">
              Se connecter à Dust
            </Link>
          </p>
        )}
      </section>

      <section className="grid grid-cols-2 gap-4">
        <Link href="/chat" className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:bg-slate-100 dark:hover:bg-slate-900">
          <div className="text-3xl font-bold">{nbConv}</div>
          <div className="text-sm text-slate-500">conversations</div>
        </Link>
        <Link href="/crons" className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:bg-slate-100 dark:hover:bg-slate-900">
          <div className="text-3xl font-bold">{nbCrons}</div>
          <div className="text-sm text-slate-500">crons configurés</div>
        </Link>
      </section>
    </div>
  );
}
