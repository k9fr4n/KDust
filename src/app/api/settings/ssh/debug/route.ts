// src/app/api/settings/ssh/debug/route.ts
//
// Diagnostic + reachability probe for /settings/ssh
// (Franck 2026-05-09, ADR-0011).
//
// Replaces the legacy /api/ssh-debug. Two responsibilities:
//
//   1. GET (no `host` param)  -> snapshot of the runtime tmpfs +
//      relevant env vars (no key bytes ever).
//
//   2. GET ?host=<hostname>   -> spawn `ssh -vT git@<host>` with
//      BatchMode=yes against the generated config, then *classify*
//      the result so the UI can show a clear verdict instead of
//      asking the operator to read 30 lines of OpenSSH verbose log.
//
// Classification heuristic (see classifyProbe()): we look for the
// well-known auth-success greetings (GitHub / GitLab / Gitea /
// Bitbucket), then for the OpenSSH "Authenticated to ... using
// publickey" + "Server accepts key" verbose markers, and finally
// for known failure markers (Permission denied, Host key
// verification failed, Connection refused/timeout, Could not
// resolve hostname). The exit code alone is misleading: GitHub /
// GitLab close the channel after greeting, so a successful auth
// returns code=1, not 0.

import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { describeSshRuntime } from '@/lib/ssh/bootstrap';

export const runtime = 'nodejs';

const HOST_RE = /^[A-Za-z0-9.\-]{1,253}$/;

export type ProbeVerdict =
  | 'authenticated'    // key works, remote acknowledged us
  | 'auth_failed'      // reached server, server refused our keys
  | 'host_unreachable' // DNS / TCP failure, never spoke ssh
  | 'host_key'         // StrictHostKeyChecking blocked us
  | 'no_identity'      // ssh ran but had no key to offer (config gap)
  | 'unknown';

export interface ProbeResultPayload {
  host: string;
  code: number;
  verdict: ProbeVerdict;
  summary: string;
  acceptedIdentity: string | null;
  offered: string[];
  remoteGreeting: string | null;
  out: string;
}

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

function classifyProbe(host: string, code: number, raw: string): Omit<ProbeResultPayload, 'host' | 'code' | 'out'> {
  const out = raw;

  // Offered identities -- OpenSSH verbose lines look like:
  //   debug1: Offering public key: /run/kdust/ssh/id_github RSA SHA256:...
  const offered: string[] = [];
  const offerRe = /Offering public key:\s+(\S+)/g;
  for (const m of out.matchAll(offerRe)) offered.push(m[1]);

  // Accepted identity (verbose marker).
  const accepted = out.match(/Server accepts key:\s+(\S+)/);
  const authenticatedTo = out.match(/Authenticated to \S+ \([^)]+\) using "publickey"/);
  const acceptedIdentity = accepted ? accepted[1] : null;

  // Remote greetings.
  const githubGreet = out.match(/Hi (\S+)! You've successfully authenticated[^\n]*/);
  const gitlabGreet = out.match(/Welcome to GitLab,[^\n]*/);
  const giteaGreet = out.match(/Hi there, (\S+)![^\n]*/);
  const bitbucketGreet = out.match(/logged in as ([^\s.]+)/);
  const remoteGreeting =
    githubGreet?.[0] ?? gitlabGreet?.[0] ?? giteaGreet?.[0] ?? bitbucketGreet?.[0] ?? null;

  // Failure markers.
  const permDenied = /Permission denied \(publickey/.test(out);
  const hostKey = /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(out);
  const dnsFail = /Could not resolve hostname/.test(out);
  const tcpFail = /Connection (refused|timed out)|kex_exchange_identification|read: Connection reset/.test(out);
  const noIdentity = /No more authentication methods to try/.test(out) && offered.length === 0;

  if (remoteGreeting || authenticatedTo) {
    const who = remoteGreeting ? ` (${remoteGreeting.trim()})` : '';
    const id = acceptedIdentity ? ` using \`${acceptedIdentity.split('/').pop()}\`` : '';
    return {
      verdict: 'authenticated',
      summary: `✅ Authenticated to \`${host}\`${id}.${who}`,
      acceptedIdentity, offered, remoteGreeting,
    };
  }
  if (hostKey) {
    return {
      verdict: 'host_key',
      summary: `⚠️ Host key verification failed for \`${host}\`. Either the remote rotated its host key or this is a MITM. Inspect the verbose log below before trusting it.`,
      acceptedIdentity: null, offered, remoteGreeting: null,
    };
  }
  if (dnsFail) {
    return {
      verdict: 'host_unreachable',
      summary: `❌ DNS lookup failed for \`${host}\`. The container cannot resolve this hostname.`,
      acceptedIdentity: null, offered, remoteGreeting: null,
    };
  }
  if (tcpFail) {
    return {
      verdict: 'host_unreachable',
      summary: `❌ TCP connection to \`${host}:22\` failed (refused, timed out, or reset). Check network egress and firewall.`,
      acceptedIdentity: null, offered, remoteGreeting: null,
    };
  }
  if (noIdentity) {
    return {
      verdict: 'no_identity',
      summary: `❌ No SSH identity matched host \`${host}\`. Check the Host pattern of your identity, or add a new one for this remote.`,
      acceptedIdentity: null, offered, remoteGreeting: null,
    };
  }
  if (permDenied) {
    const offeredList = offered.length
      ? ' Tried: ' + offered.map((p) => '`' + (p.split('/').pop() ?? p) + '`').join(', ') + '.'
      : '';
    return {
      verdict: 'auth_failed',
      summary: `❌ \`${host}\` refused every key we offered.${offeredList} Add the matching public key to the remote\'s deploy keys, or check the Host pattern.`,
      acceptedIdentity: null, offered, remoteGreeting: null,
    };
  }

  return {
    verdict: 'unknown',
    summary: `❔ Could not classify the result (exit=${code}). Read the verbose log below.`,
    acceptedIdentity: null, offered, remoteGreeting: null,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const host = url.searchParams.get('host');
  const snapshot = await describeSshRuntime();

  let probeResult: ProbeResultPayload | null = null;
  if (host) {
    if (!HOST_RE.test(host)) {
      return NextResponse.json({ error: 'Invalid host parameter' }, { status: 400 });
    }
    const r = await probe(host, snapshot.configPath);
    probeResult = {
      host, code: r.code, out: r.out,
      ...classifyProbe(host, r.code, r.out),
    };
  }

  return NextResponse.json({ snapshot, probe: probeResult });
}
