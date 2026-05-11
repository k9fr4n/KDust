// src/lib/git-cli/bootstrap.ts
//
// Boot-time authentication of `gh` and `glab` CLIs (Franck
// 2026-05-11). Reads tokens from the Secret Manager (`Secret`
// table) and pipes them through `gh auth login --with-token` /
// `glab auth login --stdin` so the credentials never appear on
// argv or in env, only on the child stdin which is closed after
// the write.
//
// Secret name conventions (case-sensitive, matches Secret.name
// validator in src/lib/secrets/repo.ts):
//
//   GH_TOKEN       PAT (or fine-grained token) for GitHub.
//   GH_HOST        Optional hostname. Defaults to `github.com`.
//                  Set to e.g. `github.ecritel.com` for GHES.
//   GITLAB_TOKEN   PAT for GitLab (scope `api`).
//   GITLAB_HOST    Optional hostname. Defaults to `gitlab.com`.
//                  Set to e.g. `gitlab.ecritel.net` for self-hosted.
//
// Behaviour:
//   * Each CLI is bootstrapped independently. A missing TOKEN
//     secret is a silent skip (logged at [info]) so a partial
//     setup (only GitHub, only GitLab) is fully supported.
//   * Idempotent: both `gh auth login --with-token` and
//     `glab auth login --stdin` overwrite any existing host entry
//     under ~/.config/<cli>/, so re-running the bootstrap on a
//     redeploy is safe.
//   * Best-effort: any failure logs and resolves, never throws.
//     A misconfigured token must not brick the container.
//   * Stateless v1: nothing is mounted in docker-compose. The
//     CLIs are re-authenticated on every boot. Cost is one local
//     exec per CLI, negligible compared to scheduler boot.
//
// Hard rules:
//   * NEVER log the decrypted token. We log host + CLI name only.
//   * Token bytes travel via stdin pipe; argv stays clean
//     (`ps aux` would otherwise expose the token to any process
//     in the same PID namespace).
//   * The decrypted token is also registered with the log buffer
//     redactor so any accidental echo from gh/glab stderr is
//     scrubbed before reaching docker logs.

import { spawn } from 'node:child_process';
import { db } from '../db';
import { decrypt } from '../crypto';
import { errMessage } from '../errors';
import { registerRedactSecrets } from '../logs/buffer';

export interface CliBootstrapResult {
  cli: 'gh' | 'glab';
  ok: boolean;
  /** undefined when the token secret is absent (silent skip). */
  host?: string;
  /** Present on failure or skip. Never contains the token. */
  reason?: string;
}

export interface BootstrapSummary {
  results: CliBootstrapResult[];
}

const DEFAULT_GH_HOST = 'github.com';
const DEFAULT_GITLAB_HOST = 'gitlab.com';
const REDACT_SCOPE = 'git-cli-bootstrap';

/**
 * Resolve and decrypt a Secret row by name. Returns null when the
 * row does not exist (caller treats this as "not configured");
 * throws on decrypt failure so the operator sees a loud error
 * rather than a silent skip when the key has rotated.
 */
async function resolveSecret(name: string): Promise<string | null> {
  const row = await db.secret.findUnique({
    where: { name },
    select: { id: true, valueEnc: true },
  });
  if (!row) return null;
  const plain = decrypt(row.valueEnc);
  // Best-effort lastUsedAt bump so the secret shows recent activity
  // in /settings/secrets. Same pattern as resolveForRun().
  void db.secret
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return plain;
}

/**
 * Spawn `cmd` with `args`, write `stdinPayload` to stdin then
 * close, and resolve with the exit code + captured stderr/stdout.
 */
function runWithStdin(
  cmd: string,
  args: readonly string[],
  stdinPayload: string,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (e) => {
      resolve({ code: null, stderr: e.message, stdout });
    });
    child.on('close', (code) => {
      resolve({ code, stderr, stdout });
    });
    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

/**
 * Add `token` to the boot-scope redactor. We use a single shared
 * scope id so successive calls (gh then glab) accumulate values
 * rather than overwrite each other.
 */
const boundTokens: { value: string; ref: { envName: string; secretName: string } }[] = [];
function redactToken(token: string, secretName: string): void {
  boundTokens.push({ value: token, ref: { envName: secretName, secretName } });
  registerRedactSecrets(REDACT_SCOPE, boundTokens);
}

async function bootstrapGh(): Promise<CliBootstrapResult> {
  let token: string | null;
  try {
    token = await resolveSecret('GH_TOKEN');
  } catch (e: unknown) {
    return { cli: 'gh', ok: false, reason: `decrypt GH_TOKEN: ${errMessage(e)}` };
  }
  if (!token) return { cli: 'gh', ok: false, reason: 'GH_TOKEN secret not set (skipped)' };

  let host: string;
  try {
    host = (await resolveSecret('GH_HOST')) ?? DEFAULT_GH_HOST;
  } catch (e: unknown) {
    return { cli: 'gh', ok: false, reason: `decrypt GH_HOST: ${errMessage(e)}` };
  }
  redactToken(token, 'GH_TOKEN');

  const { code, stderr } = await runWithStdin(
    'gh',
    ['auth', 'login', '--hostname', host, '--with-token'],
    token,
  );
  if (code === 0) {
    return { cli: 'gh', ok: true, host };
  }
  const reason = stderr.trim().slice(0, 500) || `gh exited with code ${code}`;
  return { cli: 'gh', ok: false, host, reason };
}

async function bootstrapGlab(): Promise<CliBootstrapResult> {
  let token: string | null;
  try {
    token = await resolveSecret('GITLAB_TOKEN');
  } catch (e: unknown) {
    return { cli: 'glab', ok: false, reason: `decrypt GITLAB_TOKEN: ${errMessage(e)}` };
  }
  if (!token) {
    return { cli: 'glab', ok: false, reason: 'GITLAB_TOKEN secret not set (skipped)' };
  }

  let host: string;
  try {
    host = (await resolveSecret('GITLAB_HOST')) ?? DEFAULT_GITLAB_HOST;
  } catch (e: unknown) {
    return { cli: 'glab', ok: false, reason: `decrypt GITLAB_HOST: ${errMessage(e)}` };
  }
  redactToken(token, 'GITLAB_TOKEN');

  // `glab auth login --stdin --hostname X` reads the token from
  // stdin. argv stays free of the secret.
  const { code, stderr } = await runWithStdin(
    'glab',
    ['auth', 'login', '--hostname', host, '--stdin'],
    token,
  );
  if (code === 0) {
    return { cli: 'glab', ok: true, host };
  }
  const reason = stderr.trim().slice(0, 500) || `glab exited with code ${code}`;
  return { cli: 'glab', ok: false, host, reason };
}

/**
 * Entry point called from src/instrumentation.ts. Authenticates
 * `gh` and `glab` in parallel against their configured hosts using
 * tokens fetched from the Secret Manager. Never throws.
 */
export async function bootstrapGitCliAuth(): Promise<BootstrapSummary> {
  const results = await Promise.all([bootstrapGh(), bootstrapGlab()]);
  for (const r of results) {
    if (r.ok) {
      console.info(`[git-cli] ${r.cli} authenticated against ${r.host}`);
    } else if (r.reason?.endsWith('(skipped)')) {
      console.info(`[git-cli] ${r.cli} ${r.reason}`);
    } else {
      console.warn(
        `[git-cli] ${r.cli} auth failed${r.host ? ` (host=${r.host})` : ''}: ${r.reason}`,
      );
    }
  }
  return { results };
}
