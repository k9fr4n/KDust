'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Workflow } from 'lucide-react';
import { Button } from '@/components/Button';
import type { AppConfig } from '@prisma/client';

/**
 * Task Runner MCP server settings (Franck 2026-05-02).
 *
 * Lives on its own route rather than as a section of
 * /settings/global so future task-runner knobs (heartbeat
 * interval, default budgets, dispatch logging verbosity, ...)
 * have a coherent home. Today's only knob is the nested
 * orchestrator depth cap. The PATCH endpoint clamps server-
 * side to [1, 10]; we mirror that here on the input.
 */
export default function TaskRunnerSettingsPage() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json() as Promise<{ config: AppConfig }>)
      .then((j) => setCfg(j.config));
  }, []);

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    setMsg(null);
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskRunnerMaxDepth: cfg.taskRunnerMaxDepth }),
    });
    setSaving(false);
    setMsg(res.ok ? 'Saved.' : 'Save error.');
  };

  const field =
    'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2';

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Settings
        </Link>
        <h1 className="text-2xl font-bold mt-2 flex items-center gap-2">
          <Workflow size={22} className="text-amber-500" /> Task Runner
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Tune the orchestration MCP server bound to tasks with{' '}
          <code className="font-mono">taskRunnerEnabled=true</code>.
        </p>
      </div>

      {!cfg ? (
        <p className="text-slate-500">Loading…</p>
      ) : (
        <>
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4 space-y-3">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
              Maximum nested chain depth
            </h2>
            <p className="text-xs text-slate-500">
              <code className="font-mono">runDepth</code> counts runs in
              the chain (root run = 1, its child = 2, …). The
              orchestration helper refuses any dispatch that would push{' '}
              <code className="font-mono">runDepth</code> above this
              cap, surfacing a structured error to the agent so a
              runaway recursion (A → B → A) terminates immediately.
              Range <code className="font-mono">[1, 10]</code>: 1
              effectively disables nested dispatching, 3 (the default)
              allows up to 2 nested orchestrator levels above a leaf
              worker — e.g.{' '}
              <code className="font-mono">
                provider-orchestrator (1) → pipeline-build (2) →
                provider-coder (3)
              </code>
              .
            </p>
            <label className="block max-w-xs">
              <span className="text-sm">Max depth</span>
              <input
                type="number"
                min={1}
                max={10}
                step={1}
                className={field}
                value={cfg.taskRunnerMaxDepth ?? 3}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (!Number.isFinite(n)) return;
                  setCfg({
                    ...cfg,
                    taskRunnerMaxDepth: Math.min(10, Math.max(1, n)),
                  });
                }}
              />
              <span className="block mt-1 text-[11px] text-slate-500">
                Default: 3. Tightening the cap turns accidental
                recursion into an immediate refusal; loosen it only
                when a legitimate pipeline genuinely needs deeper
                chains.
              </span>
            </label>
          </div>

          <div className="flex items-center gap-4">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {msg && <span className="text-sm text-slate-500">{msg}</span>}
          </div>
        </>
      )}
    </div>
  );
}
