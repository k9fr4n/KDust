import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';

export const runtime = 'nodejs';

function run(cmd: string, args: string[]) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(cmd, args);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    const to = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.on('close', (code) => { clearTimeout(to); resolve({ code: code ?? -1, out }); });
  });
}

// Discriminated union: a row is either a successful entry (full
// stat fields) or an error wrapper (no path was readable). Keeping
// the shapes union-typed avoids `any[]` while letting the catch
// branch keep its single-error fallback semantics.
type SshDebugFile =
  | { name: string; mode: string; size: number; uid: number; gid: number }
  | { error: string };

export async function GET(req: Request) {
  const host = new URL(req.url).searchParams.get('host') ?? 'github.com';
  let files: SshDebugFile[] = [];
  try {
    const sshDir = process.env.HOME ? `${process.env.HOME}/.ssh` : '/home/node/.ssh';
    const entries = await readdir(sshDir);
    files = await Promise.all(entries.map(async (f) => {
      const s = await stat(`${sshDir}/${f}`);
      return { name: f, mode: (s.mode & 0o777).toString(8), size: s.size, uid: s.uid, gid: s.gid };
    }));
  } catch (e) { files = [{ error: (e as Error).message }]; }
  const env = { USER: process.env.USER, HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? null, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? null };
  const khFile = `${process.env.HOME ?? '/home/node'}/.ssh/known_hosts`;
  const ssh = await run('ssh', ['-vT','-o','StrictHostKeyChecking=accept-new','-o',`UserKnownHostsFile=${khFile}`,'-o','BatchMode=yes',`git@${host}`]);
  const who = await run('id', []);
  return NextResponse.json({ env, who: who.out, files, ssh });
}
