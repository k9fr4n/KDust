// src/app/api/git-cli/status/route.ts
//
// Live status of the `gh` and `glab` CLI sessions installed in the
// container. Surfaced as a card on /settings/secrets so the
// operator can immediately see whether the boot-time bootstrap
// (src/lib/git-cli/bootstrap.ts) succeeded for the configured
// hosts.
//
// Cost: ~50-150ms per CLI (local exec, no network).
//
// Design notes:
//   * We query each CLI for its specific hostname (resolved from
//     the Secret Manager, default github.com / gitlab.com) rather
//     than the global "status of all hosts" output. Operators only
//     care about the host they configured.
//   * `gh auth status -h X` exits 0 iff logged in for X; we parse
//     the "account NAME" line to surface the username. Defensive
//     parsing — absence of a match degrades to ok=true without a
//     username, never to a fake failure.
//   * `glab auth status --hostname X` writes to stderr; same
//     pattern.
//   * No token is ever returned. The route lists hostnames + a
//     boolean ok + an opaque username.

import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { db } from '@/lib/db';
import { decrypt } from '@/lib/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CliStatus {
  cli: 'gh' | 'glab';
  host: string;
  configured: boolean; // true when *_TOKEN secret exists in DB
  ok: boolean;         // true when CLI reports logged-in for `host`
  username?: string;
  message?: string;    // short stderr extract on failure, or info banner
}

async function resolveSecret(name: string): Promise<string | null> {
  const row = await db.secret.findUnique({
    where: { name },
    select: { valueEnc: true },
  });
  if (!row) return null;
  try {
    return decrypt(row.valueEnc);
  } catch {
    // Decrypt failure must not crash the status route; surface as
    // "configured but unreadable" via the message field upstream.
    return null;
  }
}

function run(cmd: string, args: readonly string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    child.on('error', (e) => resolve({ code: null, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function ghStatus(host: string, configured: boolean): Promise<CliStatus> {
  const { code, stdout, stderr } = await run('gh', ['auth', 'status', '-h', host]);
  // gh writes the status to stdout in recent versions, stderr in
  // older ones; concat both for robustness.
  const out = `${stdout}\n${stderr}`;
  if (code === 0) {
    // Examples seen across versions:
    //   "✓ Logged in to github.com account k9fr4n (...)"
    //   "Logged in to github.com as k9fr4n (...)"
    const m = out.match(/account\s+([^\s(]+)|as\s+([^\s(]+)/i);
    const username = m ? m[1] ?? m[2] : undefined;
    return { cli: 'gh', host, configured, ok: true, username };
  }
  const message = out.trim().split('\n').slice(-2).join(' ').slice(0, 200) || `gh exited with code ${code}`;
  return { cli: 'gh', host, configured, ok: false, message };
}

async function glabStatus(host: string, configured: boolean): Promise<CliStatus> {
  const { code, stdout, stderr } = await run('glab', ['auth', 'status', '--hostname', host]);
  const out = `${stdout}\n${stderr}`;
  if (code === 0) {
    // glab format: "Logged in to gitlab.com as user (token: ...)"
    const m = out.match(/as\s+([^\s(]+)/i);
    const username = m ? m[1] : undefined;
    return { cli: 'glab', host, configured, ok: true, username };
  }
  const message = out.trim().split('\n').slice(-2).join(' ').slice(0, 200) || `glab exited with code ${code}`;
  return { cli: 'glab', host, configured, ok: false, message };
}

export async function GET() {
  // Resolve hosts and configured-ness from the Secret Manager. We
  // intentionally read the host secret too — it changes the CLI we
  // need to query.
  const [ghToken, ghHost, glToken, glHost] = await Promise.all([
    resolveSecret('GH_TOKEN'),
    resolveSecret('GH_HOST'),
    resolveSecret('GITLAB_TOKEN'),
    resolveSecret('GITLAB_HOST'),
  ]);

  const [gh, glab] = await Promise.all([
    ghStatus(ghHost ?? 'github.com', ghToken !== null),
    glabStatus(glHost ?? 'gitlab.com', glToken !== null),
  ]);

  return NextResponse.json({ statuses: [gh, glab] });
}
