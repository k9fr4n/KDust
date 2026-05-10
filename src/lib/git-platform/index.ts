/**
 * Git platform factory (Phase 2, Franck 2026-04-19).
 *
 * Resolves a `GitPlatformAdapter` for a Project. Handles:
 *  - Auto-detection of platform + owner/repo from gitUrl when the
 *    Project columns are null (zero-config happy path).
 *  - Token lookup via the Secret Manager (model Secret) — the token
 *    value itself is never stored in the Project row, only the
 *    secret NAME is. See ADR-0014 (2026-05-10) for the migration
 *    away from process.env-based `platformTokenRef`.
 *  - Graceful { ok: false } return when:
 *      * the project has no git remote (sandbox)
 *      * autoOpenPR is off
 *      * platform is explicitly 'none'
 *      * platformSecretName is unset / unknown / decrypt fails
 *      * the remote is unknown / not supported
 *
 * The runner treats `{ ok: false }` as "skip PR opening silently
 * (still push)" and records the reason in TaskRun.output.
 */

import { db } from '../db';
import { decrypt } from '../crypto';
import { errMessage } from '../errors';
import type { GitPlatformAdapter } from './types';
import { makeGithubAdapter } from './github';
import { makeGitlabAdapter } from './gitlab';

export type PlatformProject = {
  gitUrl: string | null;
  platform: string | null;
  platformApiUrl: string | null;
  platformSecretName: string | null;
  remoteProjectRef: string | null;
  autoOpenPR: boolean;
};

export type ResolveResult =
  | { ok: true; adapter: GitPlatformAdapter; platform: 'github' | 'gitlab'; ownerRepo: string }
  | { ok: false; reason: string };

/**
 * Parse a git URL into { host, owner, repo }.
 * Supports:
 *   https://github.com/acme/repo(.git)
 *   git@github.com:acme/repo.git
 *   https://gitlab.example.com/group/sub/repo.git
 */
export function parseGitUrl(url: string): { host: string; path: string } | null {
  try {
    // ssh form: git@host:owner/repo
    const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (ssh) return { host: ssh[1], path: ssh[2] };
    // https form
    const u = new URL(url);
    return {
      host: u.hostname,
      path: u.pathname.replace(/^\//, '').replace(/\.git$/, ''),
    };
  } catch {
    return null;
  }
}

function detectPlatform(host: string): 'github' | 'gitlab' | null {
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  if (host.startsWith('gitlab.') || host.includes('gitlab')) return 'gitlab';
  return null;
}

export async function resolveGitPlatform(project: PlatformProject): Promise<ResolveResult> {
  if (!project.autoOpenPR) {
    return { ok: false, reason: 'autoOpenPR disabled' };
  }
  if (project.platform === 'none') {
    return { ok: false, reason: 'platform=none' };
  }
  if (!project.gitUrl) {
    return { ok: false, reason: 'sandbox project (no gitUrl)' };
  }

  // Detect platform + owner/repo from the URL when not overridden.
  const parsed = parseGitUrl(project.gitUrl);
  if (!parsed) return { ok: false, reason: `cannot parse gitUrl: ${project.gitUrl}` };

  const platform = (project.platform ?? detectPlatform(parsed.host)) as
    | 'github'
    | 'gitlab'
    | null;
  if (!platform) {
    return {
      ok: false,
      reason: `unknown git host "${parsed.host}"; set Project.platform explicitly`,
    };
  }

  const ownerRepo = project.remoteProjectRef ?? parsed.path;
  if (!ownerRepo.includes('/')) {
    return { ok: false, reason: `invalid remoteProjectRef "${ownerRepo}" (need "owner/repo")` };
  }

  // Resolve token from the Secret Manager (ADR-0014, 2026-05-10).
  // The Project row only carries the NAME; the encrypted value lives
  // in the `Secret` table and is decrypted in-memory just before
  // being handed to the adapter.
  if (!project.platformSecretName) {
    return { ok: false, reason: 'platformSecretName is not set on the project' };
  }
  const secretRow = await db.secret.findUnique({
    where: { name: project.platformSecretName },
    select: { id: true, name: true, valueEnc: true },
  });
  if (!secretRow) {
    return {
      ok: false,
      reason: `Secret "${project.platformSecretName}" not found in Secret Manager`,
    };
  }
  let token: string;
  try {
    token = decrypt(secretRow.valueEnc);
  } catch (e: unknown) {
    return {
      ok: false,
      reason: `decrypt failed for Secret "${project.platformSecretName}": ${errMessage(e)}`,
    };
  }
  if (!token) {
    return {
      ok: false,
      reason: `Secret "${project.platformSecretName}" decrypted to an empty value`,
    };
  }
  // Best-effort lastUsedAt bump (don't block on the write; if it
  // races with another resolve we don't care which timestamp wins).
  void db.secret
    .update({ where: { id: secretRow.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  if (platform === 'github') {
    const apiUrl =
      project.platformApiUrl ?? (parsed.host === 'github.com' ? 'https://api.github.com' : `https://${parsed.host}/api/v3`);
    const [owner, repo] = ownerRepo.split('/', 2);
    return {
      ok: true,
      platform: 'github',
      ownerRepo,
      adapter: makeGithubAdapter({ apiUrl, owner, repo, token }),
    };
  }

  if (platform === 'gitlab') {
    // GitLab v4 API root. Defaults to the gitUrl host when not
    // overridden, which is the correct behaviour for both
    // gitlab.com SaaS and any self-hosted instance.
    const apiUrl = project.platformApiUrl ?? `https://${parsed.host}/api/v4`;
    return {
      ok: true,
      platform: 'gitlab',
      ownerRepo,
      adapter: makeGitlabAdapter({ apiUrl, projectPath: ownerRepo, token }),
    };
  }

  // Exhaustive: `platform` is narrowed to never here. If a new
  // variant slips through the union, the compiler will flag this.
  const _exhaustive: never = platform;
  return { ok: false, reason: `platform "${String(_exhaustive)}" not supported` };
}

export type { GitPlatformAdapter } from './types';
