'use client';
import { useState } from 'react';
import { Button } from '@/components/Button';

// Mirrors the JSON returned by GET /api/ssh-debug. Keep loose around
// `files` because the API returns a discriminated union (file row vs
// `{error}` wrapper) and we render through JSON.stringify only.
type SshDebugResponse = {
  who: string;
  env: Record<string, string | null | undefined>;
  files: unknown;
  ssh: { code: number; out: string };
};

export default function SshDebugPage() {
  const [host, setHost] = useState('github.com');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SshDebugResponse | null>(null);

  const run = async () => {
    setLoading(true);
    setData(null);
    const r = await fetch(`/api/ssh-debug?host=${encodeURIComponent(host)}`);
    setData((await r.json()) as SshDebugResponse);
    setLoading(false);
  };

  const field =
    'rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2';

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">SSH debug</h1>
      <p className="text-sm text-slate-500">
        Test SSH connectivity (keys baked into the container + forwarded agent).
      </p>

      <div className="flex gap-2 items-center">
        <input
          className={field}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="github.com"
        />
        <Button onClick={run} disabled={loading}>
          {loading ? 'Testing…' : 'Test'}
        </Button>
        {['github.com', 'gitlab.ecritel.net', 'gitlab.com'].map((h) => (
          <button
            key={h}
            onClick={() => setHost(h)}
            className="text-xs px-2 py-1 rounded border hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            {h}
          </button>
        ))}
      </div>

      {data && (
        <div className="space-y-3">
          <section>
            <h2 className="font-semibold text-sm">Identity &amp; env</h2>
            <pre className="text-xs bg-slate-100 dark:bg-slate-900 rounded p-2 overflow-x-auto">
              {data.who}
              {JSON.stringify(data.env, null, 2)}
            </pre>
          </section>
          <section>
            <h2 className="font-semibold text-sm">~/.ssh</h2>
            <pre className="text-xs bg-slate-100 dark:bg-slate-900 rounded p-2 overflow-x-auto">
              {JSON.stringify(data.files, null, 2)}
            </pre>
          </section>
          <section>
            <h2 className="font-semibold text-sm">
              ssh -vT git@{host} (exit {data.ssh.code})
            </h2>
            <pre className="text-xs bg-slate-100 dark:bg-slate-900 rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {data.ssh.out}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}
