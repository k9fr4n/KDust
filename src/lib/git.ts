import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECTS_ROOT } from './projects';

/** Exécute git avec args et retourne stdout+stderr combinés. */
function runGit(args: string[], cwd?: string, timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      // Pas d'interactif, pas d'askpass graphique
      GIT_TERMINAL_PROMPT: '0',
      // accepte automatiquement les nouveaux host keys (ecritel, github…)
      GIT_SSH_COMMAND:
        process.env.GIT_SSH_COMMAND ||
        'ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/home/node/.ssh/known_hosts',
    };
    const p = spawn('git', args, { cwd, env });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    const to = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(to);
      resolve({ code: code ?? -1, out });
    });
  });
}

export interface GitSyncResult {
  ok: boolean;
  output: string;
  error?: string;
}

export async function cloneOrPull(
  name: string,
  gitUrl: string,
  branch: string,
): Promise<GitSyncResult> {
  const target = join(PROJECTS_ROOT, name);
  await mkdir(PROJECTS_ROOT, { recursive: true });

  let exists = false;
  try {
    await stat(join(target, '.git'));
    exists = true;
  } catch {
    /* not cloned yet */
  }

  if (!exists) {
    // clone frais (supprime un dossier existant non-git au passage)
    try {
      await rm(target, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const r = await runGit(['clone', '--branch', branch, '--single-branch', gitUrl, target]);
    return {
      ok: r.code === 0,
      output: r.out,
      error: r.code === 0 ? undefined : `git clone exited ${r.code}`,
    };
  }

  // pull : reset état local + fetch + reset sur origin/branch
  const steps = [
    ['fetch', '--prune', 'origin'],
    ['checkout', branch],
    ['reset', '--hard', `origin/${branch}`],
  ];
  let combined = '';
  for (const args of steps) {
    const r = await runGit(args, target);
    combined += `$ git ${args.join(' ')}\n${r.out}\n`;
    if (r.code !== 0) {
      return { ok: false, output: combined, error: `git ${args[0]} exited ${r.code}` };
    }
  }
  return { ok: true, output: combined };
}
