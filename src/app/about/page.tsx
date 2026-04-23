import { Info } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';

export default function AboutPage() {
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader icon={<Info size={20} />} title="About KDust" />
      <p className="text-sm text-slate-600 dark:text-slate-400">
        KDust is a self-hosted web UI to chat with{' '}
        <a href="https://dust.tt" className="underline" target="_blank" rel="noreferrer">
          Dust
        </a>{' '}
        agents and schedule them as cron jobs against local git projects.
      </p>

      <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-2">
        <h2 className="font-semibold">Features</h2>
        <ul className="list-disc pl-5 text-sm space-y-1">
          <li>Sign in to a Dust workspace via WorkOS device flow</li>
          <li>Browse and trigger Dust agents</li>
          <li>Schedule agent runs with cron expressions per project</li>
          <li>Clone &amp; sync remote git repositories over SSH</li>
          <li>Post run reports to Microsoft Teams via webhook</li>
        </ul>
      </section>

      <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-1 text-sm">
        <h2 className="font-semibold mb-1">Tech stack</h2>
        <div>Next.js 15 · React 19 · Tailwind</div>
        <div>Prisma · SQLite</div>
        <div>@dust-tt/client SDK · WorkOS OIDC</div>
        <div>node-cron scheduler</div>
      </section>

      <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 text-sm space-y-1">
        <h2 className="font-semibold mb-1">Build</h2>
        <div>Version: 0.1.0</div>
        <div>License: MIT</div>
      </section>
    </div>
  );
}
