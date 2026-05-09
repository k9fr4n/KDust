// src/app/api/settings/ssh/debug/route.ts
//
// Diagnostic endpoint for the /settings/ssh page (Franck 2026-05-09).
//
// Replaces (long-term) the legacy /api/ssh-debug -- this version is:
//   * scoped under /settings/ssh so the debug UI lives in the same
//     navigation block as identity management;
//   * snaps the runtime tmpfs (names + sizes only, NO bytes);
//   * supports an optional ?host=... probe that shells out to
//     `ssh -vT git@<host>` with BatchMode=yes to test reachability
//     without ever falling back to interactive prompts.
//
// Auth: relies on the global APP_PASSWORD JWT middleware. No
// additional checks here.

import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { describeSshRuntime } from '@/lib/ssh/bootstrap';

export const runtime = 'nodejs';

const HOST_RE = /^[A-Za-z0-9.\-]{1,253}$/;

function probe(host: string, sshConfig: string | null): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const args: string[] = [];
    if (sshConfig) args.push('-F', sshConfig);
    args.push('-vT', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `git@${host}`);
    const p = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    const to = setTimeout(() => p.kill('SIGKILL'), 15_000);
    p.on('error', (e) => { clearTimeout(to); resolve({ code: -1, out: out + `\nspawn error: ${e.message}` }); });
    p.on('close', (code) => { clearTimeout(to); resolve({ code: code ?? -1, out }); });
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const host = url.searchParams.get('host');
  const snapshot = await describeSshRuntime();

  let probeResult: { host: string; code: number; out: string } | null = null;
  if (host) {
    if (!HOST_RE.test(host)) {
      return NextResponse.json({ error: 'Invalid host parameter' }, { status: 400 });
    }
    const r = await probe(host, snapshot.configPath);
    probeResult = { host, code: r.code, out: r.out };
  }

  return NextResponse.json({ snapshot, probe: probeResult });
}
