import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECTS_ROOT } from './projects';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GitHost = 'gitlab' | 'github' | 'unknown';

export interface GitRepo {
  host: GitHost;
  webHost: string;            // gitlab.ecritel.net / github.com
  pathWithNamespace: string;  // group/project or org/repo
  baseUrl: string;            // https://<host>/<path>
}

export interface DiffStat {
  files: string[];
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface GitCommandResult {
  code: number;
  out: string;
}

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

// ---------------------------------------------------------------------------
// Automation helpers (used by the cron runner)
// ---------------------------------------------------------------------------

/** Parse a git remote URL into host/path info. Supports ssh, https, and the
 *  `git@host:path.git` shorthand. Unknown hosts degrade gracefully. */
export function parseGitRepo(gitUrl: string): GitRepo {
  let m =
    gitUrl.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/) ||
    gitUrl.match(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?\/?$/) ||
    gitUrl.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) {
    return { host: 'unknown', webHost: '', pathWithNamespace: '', baseUrl: gitUrl };
  }
  const webHost = m[1];
  const pathWithNamespace = m[2];
  const host: GitHost =
    webHost === 'github.com'
      ? 'github'
      : /gitlab/i.test(webHost)
        ? 'gitlab'
        : 'unknown';
  return {
    host,
    webHost,
    pathWithNamespace,
    baseUrl: `https://${webHost}/${pathWithNamespace}`,
  };
}

/** Build web URLs (branch, commit, new-MR/PR) for a given repo + branch. */
export function buildGitLinks(
  repo: GitRepo,
  branch: string,
  baseBranch: string,
  sha?: string | null,
): { branch: string | null; commit: string | null; newMr: string | null } {
  if (repo.host === 'gitlab') {
    return {
      branch: `${repo.baseUrl}/-/tree/${encodeURIComponent(branch)}`,
      commit: sha ? `${repo.baseUrl}/-/commit/${sha}` : null,
      newMr: `${repo.baseUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(baseBranch)}`,
    };
  }
  if (repo.host === 'github') {
    return {
      branch: `${repo.baseUrl}/tree/${encodeURIComponent(branch)}`,
      commit: sha ? `${repo.baseUrl}/commit/${sha}` : null,
      newMr: `${repo.baseUrl}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}?expand=1`,
    };
  }
  return { branch: null, commit: null, newMr: null };
}

/** Sanitize a string to a git-ref-safe slug. */
export function slugifyRef(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Compose a branch name according to the cron's branchMode. */
export function composeBranchName(
  mode: 'timestamped' | 'stable',
  prefix: string,
  cronName: string,
  now: Date = new Date(),
): string {
  const pfx = slugifyRef(prefix) || 'kdust';
  const slug = slugifyRef(cronName) || 'job';
  if (mode === 'stable') return `${pfx}/${slug}`;
  const ts = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate(),
  ).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
  return `${pfx}/${slug}/${ts}`;
}

/** Reset the working copy to the tip of origin/<baseBranch>.
 *  Handles projects cloned with --single-branch by ensuring the remote is
 *  configured to fetch the requested base branch before pulling it. */
export async function resetToBase(
  projectName: string,
  baseBranch: string,
): Promise<GitSyncResult> {
  const cwd = join(PROJECTS_ROOT, projectName);
  const steps = [
    // Widen the set of tracked remote branches so single-branch clones can
    // fetch other branches (base branch may differ from the one used at clone).
    ['remote', 'set-branches', '--add', 'origin', baseBranch],
    ['fetch', '--prune', 'origin', `${baseBranch}:refs/remotes/origin/${baseBranch}`],
    ['checkout', '-B', baseBranch, `refs/remotes/origin/${baseBranch}`],
    ['reset', '--hard', `refs/remotes/origin/${baseBranch}`],
    ['clean', '-fd'],
  ];
  let combined = '';
  for (const args of steps) {
    const r = await runGit(args, cwd);
    combined += `$ git ${args.join(' ')}\n${r.out}\n`;
    if (r.code !== 0) {
      return { ok: false, output: combined, error: `git ${args[0]} exited ${r.code}` };
    }
  }
  return { ok: true, output: combined };
}

/** Create (or reuse) a working branch rooted at baseBranch. Safe for 'stable' mode:
 *  deletes any pre-existing local copy so we start from a clean slate. */
export async function checkoutWorkingBranch(
  projectName: string,
  branch: string,
): Promise<GitSyncResult> {
  const cwd = join(PROJECTS_ROOT, projectName);
  // Delete local branch if it exists so -B creates a fresh ref off current HEAD.
  await runGit(['branch', '-D', branch], cwd); // ignore code
  const r = await runGit(['checkout', '-B', branch], cwd);
  return { ok: r.code === 0, output: r.out, error: r.code === 0 ? undefined : `git checkout exited ${r.code}` };
}

/** Return summary of uncommitted changes in the working tree. */
export async function diffStatFromHead(projectName: string): Promise<DiffStat> {
  const cwd = join(PROJECTS_ROOT, projectName);
  // Stage everything so renamed/deleted/new files are counted uniformly.
  await runGit(['add', '-A'], cwd);
  const r = await runGit(['diff', '--cached', '--numstat'], cwd);
  if (r.code !== 0) return { files: [], filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
  let linesAdded = 0;
  let linesRemoved = 0;
  const files: string[] = [];
  for (const line of r.out.split('\n')) {
    const cols = line.trim().split(/\t/);
    if (cols.length < 3) continue;
    // Binary files show "-" instead of numbers
    const a = cols[0] === '-' ? 0 : Number(cols[0]) || 0;
    const d = cols[1] === '-' ? 0 : Number(cols[1]) || 0;
    linesAdded += a;
    linesRemoved += d;
    files.push(cols[2]);
  }
  return { files, filesChanged: files.length, linesAdded, linesRemoved };
}

/** Commit all staged (diffStatFromHead() already ran `git add -A`) with a
 *  conventional message. Returns the new HEAD sha, or null if nothing to commit. */
export async function commitAll(
  projectName: string,
  message: string,
  authorName = 'KDust Bot',
  authorEmail = 'kdust-bot@localhost',
): Promise<string | null> {
  const cwd = join(PROJECTS_ROOT, projectName);
  const check = await runGit(['diff', '--cached', '--quiet'], cwd);
  if (check.code === 0) return null; // nothing staged
  const env = [
    '-c', `user.name=${authorName}`,
    '-c', `user.email=${authorEmail}`,
  ];
  const r = await runGit([...env, 'commit', '-m', message], cwd);
  if (r.code !== 0) throw new Error(`git commit failed: ${r.out}`);
  const sha = await runGit(['rev-parse', 'HEAD'], cwd);
  return sha.code === 0 ? sha.out.trim() : null;
}

/** Push the current branch to origin. `force` = true for stable-mode rewrites. */
export async function pushBranch(
  projectName: string,
  branch: string,
  force = false,
): Promise<GitSyncResult> {
  const cwd = join(PROJECTS_ROOT, projectName);
  const args = ['push', '--set-upstream', 'origin', branch];
  if (force) args.splice(1, 0, '--force-with-lease');
  const r = await runGit(args, cwd);
  return {
    ok: r.code === 0,
    output: r.out,
    error: r.code === 0 ? undefined : `git push exited ${r.code}`,
  };
}
