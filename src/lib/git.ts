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

/** Runs git with the given args and returns the combined stdout + stderr. */
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
    p.stdout?.on('data', (d) => (out += d.toString()));
    p.stderr?.on('data', (d) => (out += d.toString()));
    const to = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    // Defense-in-depth (Franck 2026-04-27): without an 'error' handler
    // a failed spawn (ENOENT on cwd or on the binary itself, EACCES,
    // EMFILE…) becomes an uncaughtException that kills the whole Node
    // process — taking down every cron AND the Next.js server with it.
    // Witnessed live when a stale project path was passed as cwd:
    // Node reports `path: 'git'` in the error, which is misleading
    // (the binary IS in PATH; it's the cwd that doesn't exist).
    // We map any spawn error to a synthetic non-zero exit so callers
    // (cloneOrPull, resetToBase, etc.) treat it like any other git
    // failure and surface a clean error in the run's output.
    p.on('error', (err) => {
      clearTimeout(to);
      resolve({ code: -1, out: `${out}\nspawn error: ${(err as Error).message} (cwd=${cwd ?? '<inherited>'})` });
    });
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

/**
 * #4 (2026-04-29): build a GitSyncResult from a runGit() return,
 * with a per-call-site failure label. Factors the
 *   { ok: r.code === 0, output: r.out, error: r.code === 0 ? undefined : ... }
 * triple repeated across checkoutWorkingBranch / pushBranch /
 * checkoutExistingBranch / mergeFastForward (4 sites pre-refactor).
 *
 * `failureLabel` is either a string (used verbatim as the error)
 * or a function called with the exit code (handy when we want
 * `git push exited ${code}` style messages without sprintf).
 */
function toGitResult(
  r: { code: number; out: string },
  failureLabel: string | ((code: number) => string),
): GitSyncResult {
  if (r.code === 0) return { ok: true, output: r.out };
  const error =
    typeof failureLabel === "function" ? failureLabel(r.code) : failureLabel;
  return { ok: false, output: r.out, error };
}

export async function cloneOrPull(
  name: string,
  gitUrl: string,
  branch: string,
): Promise<GitSyncResult> {
  const target = join(PROJECTS_ROOT, name);
  // mkdir target's PARENT recursively so multi-segment fsPaths
  // (e.g. "clients/acme/<repo>") have their intermediate folders
  // ready before `git clone` runs. PROJECTS_ROOT alone was enough
  // when projects lived flat under it; not anymore since 2026-04-27.
  await mkdir(join(target, '..'), { recursive: true });

  let exists = false;
  try {
    await stat(join(target, '.git'));
    exists = true;
  } catch {
    /* not cloned yet */
  }

  if (!exists) {
    // Clone frais (supprime un dossier existant non-git au passage).
    try {
      await rm(target, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    // Happy path: the requested branch exists upstream.
    const r = await runGit(['clone', '--branch', branch, '--single-branch', gitUrl, target]);
    let combined = r.out;

    // Tolerate empty / freshly-created remotes (no branch yet) and repos
    // whose default branch differs from the one requested (e.g. master vs
    // main). We detect the specific git error and retry with a plain clone
    // (no --branch), then position HEAD onto the desired branch locally so
    // the first commit will create it.
    //
    // Error string we catch: "Remote branch <x> not found in upstream origin"
    // or "warning: You appear to have cloned an empty repository."
    const branchMissing = /Remote branch .* not found in upstream origin/i.test(r.out);
    if (r.code !== 0 && branchMissing) {
      // Ensure target is clean before retrying (the failed clone may have
      // left a partial directory behind).
      try {
        await rm(target, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      const r2 = await runGit(['clone', gitUrl, target]);
      combined += `\n$ git clone ${gitUrl} ${target}\n${r2.out}`;
      if (r2.code !== 0) {
        return {
          ok: false,
          output: combined,
          error: `git clone exited ${r2.code}`,
        };
      }

      // Two sub-cases:
      //  a) Empty repo: no HEAD at all → set the symbolic ref so that the
      //     first commit lands on <branch>. `git symbolic-ref` works even
      //     when no commits exist yet (unlike `git checkout`).
      //  b) Non-empty repo, different default branch: HEAD points to
      //     something (master, trunk…). We create/switch to <branch> off
      //     that current HEAD via `checkout -B` so the working tree stays
      //     usable immediately.
      const headCheck = await runGit(['rev-parse', '--verify', 'HEAD'], target);
      combined += `\n$ git rev-parse --verify HEAD\n${headCheck.out}`;
      if (headCheck.code !== 0) {
        // (a) empty repo
        const sym = await runGit(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], target);
        combined += `\n$ git symbolic-ref HEAD refs/heads/${branch}\n${sym.out}`;
        if (sym.code !== 0) {
          return {
            ok: false,
            output: combined,
            error: `unable to position HEAD on empty repo (${sym.code})`,
          };
        }
      } else {
        // (b) repo has commits on another branch
        const co = await runGit(['checkout', '-B', branch], target);
        combined += `\n$ git checkout -B ${branch}\n${co.out}`;
        if (co.code !== 0) {
          return {
            ok: false,
            output: combined,
            error: `unable to create branch ${branch} (${co.code})`,
          };
        }
      }
      return { ok: true, output: combined };
    }

    return {
      ok: r.code === 0,
      output: combined,
      error: r.code === 0 ? undefined : `git clone exited ${r.code}`,
    };
  }

  // pull = reset local state, then fetch, then reset to origin/branch.
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
  const m =
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

/** Compose a branch name according to the task's branchMode. */
export function composeBranchName(
  mode: 'timestamped' | 'stable',
  prefix: string,
  taskName: string,
  now: Date = new Date(),
): string {
  const pfx = slugifyRef(prefix) || 'kdust';
  const slug = slugifyRef(taskName) || 'job';
  if (mode === 'stable') return `${pfx}/${slug}`;
  const ts = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate(),
  ).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
  return `${pfx}/${slug}/${ts}`;
}

/** Reset the working copy to the tip of origin/<baseBranch>.
 *  Handles projects cloned with --single-branch by widening the remote's
 *  fetch config to include the base branch, then fetching + checking out.
 *
 *  NB: we deliberately avoid `--prune` and explicit refspecs here: combined
 *  with set-branches they can mis-fire and DELETE the very ref we need
 *  (witnessed in the wild: "[deleted] (none) -> origin/main"). Using plain
 *  `git fetch origin <base>` is both simpler and robust. */
export async function resetToBase(
  projectName: string,
  baseBranch: string,
): Promise<GitSyncResult> {
  const cwd = join(PROJECTS_ROOT, projectName);
  let combined = '';

  const exec = async (args: string[], failOnError = true): Promise<boolean> => {
    const r = await runGit(args, cwd);
    combined += `$ git ${args.join(' ')}\n${r.out}\n`;
    if (r.code !== 0 && failOnError) return false;
    return true;
  };

  // Best-effort: drop any stale lock file from a previous crash.
  // (git errors with "fatal: Unable to create '…/index.lock': File exists" otherwise)
  await exec(['gc', '--prune=now'], false);

  // Ensure the base branch is in the remote's fetch config (safe if already there).
  if (!(await exec(['remote', 'set-branches', '--add', 'origin', baseBranch]))) {
    return { ok: false, output: combined, error: 'remote set-branches failed' };
  }
  // Plain fetch: updates refs/remotes/origin/<base> with no surprises.
  if (!(await exec(['fetch', 'origin', baseBranch]))) {
    return { ok: false, output: combined, error: `git fetch origin ${baseBranch} failed (does the branch exist upstream?)` };
  }
  // Verify the remote ref actually exists locally now.
  const verify = await runGit(['rev-parse', '--verify', `refs/remotes/origin/${baseBranch}`], cwd);
  combined += `$ git rev-parse --verify refs/remotes/origin/${baseBranch}\n${verify.out}\n`;
  if (verify.code !== 0) {
    return { ok: false, output: combined, error: `origin/${baseBranch} not found after fetch — branch does not exist upstream` };
  }

  if (!(await exec(['checkout', '-B', baseBranch, `origin/${baseBranch}`]))) {
    return { ok: false, output: combined, error: 'checkout failed' };
  }
  if (!(await exec(['reset', '--hard', `origin/${baseBranch}`]))) {
    return { ok: false, output: combined, error: 'reset --hard failed' };
  }
  if (!(await exec(['clean', '-fd']))) {
    return { ok: false, output: combined, error: 'clean failed' };
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
  return toGitResult(r, (code) => `git checkout exited ${code}`);
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
  return toGitResult(r, (code) => `git push exited ${code}`);
}

/* ---------------------------------------------------------------
 * Orchestrator ↔ child primitives (B2/B3, Franck 2026-04-24 20:47)
 * -------------------------------------------------------------- */

/**
 * Returns true when the working tree has no staged, unstaged or
 * untracked changes (safe to switch branches / merge without risk
 * of silent data loss).
 *
 * Used by B2 (auto-inherit + auto-push): we refuse to auto-push
 * the parent's branch when the orchestrator has uncommitted work,
 * because otherwise the child run's resetToBase() on the shared
 * worktree would nuke that work. Clean error > silent loss.
 */
export async function isWorktreeClean(projectName: string): Promise<{
  clean: boolean;
  porcelain: string;
}> {
  const cwd = join(PROJECTS_ROOT, projectName);
  const r = await runGit(['status', '--porcelain'], cwd);
  const porcelain = r.out.trim();
  return { clean: r.code === 0 && porcelain.length === 0, porcelain };
}

/**
 * Returns the current branch name, or null on detached HEAD / error.
 * Not strictly required for B2/B3 (we already track branch names in
 * TaskRun.branch), but handy when we need to know where the worktree
 * actually sits vs. what the DB says — the two can drift if a run
 * crashed mid-checkout. Used only for diagnostic messages for now.
 */
export async function getCurrentBranch(projectName: string): Promise<string | null> {
  const cwd = join(PROJECTS_ROOT, projectName);
  const r = await runGit(['branch', '--show-current'], cwd);
  if (r.code !== 0) return null;
  const name = r.out.trim();
  return name.length > 0 ? name : null;
}

/**
 * Check out an EXISTING local branch (no `-B`, no creation). Used
 * by B3 at the end of `run_task` to return the worktree to the
 * orchestrator's branch before attempting the fast-forward merge.
 */
export async function checkoutExistingBranch(
  projectName: string,
  branch: string,
): Promise<GitSyncResult> {
  const cwd = join(PROJECTS_ROOT, projectName);
  const r = await runGit(['checkout', branch], cwd);
  return toGitResult(r, (code) => `git checkout ${branch} exited ${code}`);
}

/**
 * Fast-forward-only merge. Succeeds iff the target branch is a
 * strict ancestor of `fromBranch`. Any divergence — parallel
 * work, rebase, amended commit — triggers a refusal rather than
 * a 3-way merge. This is deliberate for B3:
 *
 *   - Parallel children would diverge; silently merging them is
 *     a foot-gun even when textually clean.
 *   - A refused FF surfaces to the orchestrator via the run_task
 *     response payload, letting the agent reason about whether
 *     to abort, retry on a clean base, or escalate.
 *
 * Assumes the caller has already checked out the target branch
 * (the "base" of the FF). `fromBranch` is looked up locally; the
 * caller must ensure it exists (usually because the child just
 * finished and created it).
 */
export async function mergeFastForward(
  projectName: string,
  fromBranch: string,
): Promise<GitSyncResult> {
  const cwd = join(PROJECTS_ROOT, projectName);
  const r = await runGit(['merge', '--ff-only', fromBranch], cwd);
  return toGitResult(
    r,
    `git merge --ff-only ${fromBranch} failed (non-linear history, divergent commits, or branch missing)`,
  );
}

/**
 * `git ls-remote origin <branch>` returns a non-empty SHA line when
 * the branch exists on origin. Used by B2's auto-push step to skip
 * re-pushing an already-synced ref (informational; push itself is
 * idempotent, but skipping the network round-trip is a small win).
 */
/**
 * Delete a branch on origin. Idempotent: returns ok=true when the
 * branch already doesn't exist remotely (git push --delete prints
 * a "remote ref does not exist" error on stderr but still exits 1,
 * which we map to a soft success).
 *
 * Used by the orchestrator-chain cleanup (Franck 2026-04-25): when
 * a transit branch's commits have been FF-merged into its parent
 * and pushed via the parent's branch, the transit branch on origin
 * becomes a redundant ref. Deleting it keeps the remote tidy \u2014 a
 * 3-level orchestration ends up with ONE branch on origin instead
 * of three.
 */
export async function deleteRemoteBranch(
  projectName: string,
  branch: string,
): Promise<GitSyncResult> {
  const cwd = join(PROJECTS_ROOT, projectName);
  const r = await runGit(['push', 'origin', '--delete', branch], cwd);
  if (r.code === 0) {
    return { ok: true, output: r.out };
  }
  // Map "remote ref does not exist" to soft success so callers
  // can call this unconditionally without pre-checking branch
  // existence (which would race anyway).
  if (/remote ref does not exist|unable to delete/i.test(r.out)) {
    return {
      ok: true,
      output: r.out,
      error: 'noop: branch was not on origin',
    };
  }
  return {
    ok: false,
    output: r.out,
    error: `git push origin --delete ${branch} exited ${r.code}`,
  };
}

export async function branchExistsOnOrigin(
  projectName: string,
  branch: string,
): Promise<boolean> {
  const cwd = join(PROJECTS_ROOT, projectName);
  const r = await runGit(['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], cwd);
  return r.code === 0;
}
