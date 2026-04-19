/**
 * Git platform factory (Phase 2, Franck 2026-04-19).
 *
 * Resolves a `GitPlatformAdapter` for a Project. Handles:
 *  - Auto-detection of platform + owner/repo from gitUrl when the
 *    Project columns are null (zero-config happy path).
 *  - Token lookup via process.env[platformTokenRef] — the token
 *    value itself is never stored in the DB.
 *  - Graceful null return when:
 *      * the project has no git remote (sandbox)
 *      * autoOpenPR is off
 *      * platform is explicitly 'none'
 *      * token env var is missing (UI must warn separately)
 *      * the remote is unknown / not supported yet
 *
 * The runner treats `null` as "skip PR opening silently (still push)".
 */

import type { GitPlatformAdapter } from './types';
import { makeGithubAdapter } from './github';

export type PlatformProject = {
  gitUrl: string | null;
  platform: string | null;
  platformApiUrl: string | null;
  platformTokenRef: string | null;
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

export function resolveGitPlatform(project: PlatformProject): ResolveResult {
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

  // Resolve token from env. Missing env = actionable error, not crash.
  if (!project.platformTokenRef) {
    return { ok: false, reason: 'platformTokenRef is not set on the project' };
  }
  const token = process.env[project.platformTokenRef];
  if (!token) {
    return {
      ok: false,
      reason: `env var "${project.platformTokenRef}" is empty or unset on this process`,
    };
  }

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

  // GitLab is scheduled for Phase 3.
  return { ok: false, reason: `platform "${platform}" not implemented yet (Phase 3)` };
}

export type { GitPlatformAdapter } from './types';
