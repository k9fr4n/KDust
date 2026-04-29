/**
 * GitHub adapter (Phase 2, Franck 2026-04-19).
 *
 * Uses the raw REST API via fetch to avoid adding @octokit/rest as a
 * dependency — we only need 3 endpoints. If Phase 3+ needs more
 * surface (checks, comments, branch protection introspection) we
 * should revisit and pull in Octokit.
 *
 * Endpoints consumed:
 *   POST   /repos/{owner}/{repo}/pulls               (create PR)
 *   POST   /repos/{owner}/{repo}/issues/{n}/labels   (add labels)
 *   POST   /repos/{owner}/{repo}/pulls/{n}/requested_reviewers
 *   GET    /repos/{owner}/{repo}/pulls/{n}           (state poll)
 *
 * Auth: a classic or fine-grained PAT. Required scopes:
 *   repo (classic)  OR  contents:write + pull_requests:write (fine).
 */

import { errMessage } from '../errors';
import type {
  GitPlatformAdapter,
  OpenPROptions,
  OpenPRResult,
  GetPRStatusResult,
} from './types';

type GithubCtx = {
  apiUrl: string;          // e.g. https://api.github.com
  owner: string;
  repo: string;
  token: string;
};

async function gh<T>(
  ctx: GithubCtx,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T; status: number } | { ok: false; error: string; status: number }> {
  let res: Response;
  try {
    res = await fetch(`${ctx.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'KDust',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e: unknown) {
    return { ok: false, error: `network: ${errMessage(e)}`, status: 0 };
  }
  const text = await res.text();
  if (!res.ok) {
    // GitHub error payload typically: { message, errors?[] }.
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      if (j?.message) msg = `${msg}: ${j.message}`;
      if (Array.isArray(j?.errors) && j.errors.length) {
        msg += ` (${j.errors
          .map((e: unknown) => {
            if (e && typeof e === 'object' && 'message' in e) {
              const m = (e as { message?: unknown }).message;
              if (typeof m === 'string') return m;
            }
            try { return JSON.stringify(e); } catch { return String(e); }
          })
          .join('; ')})`;
      }
    } catch { /* body wasn't JSON, keep raw */ }
    return { ok: false, error: msg, status: res.status };
  }
  try {
    return { ok: true, data: text ? (JSON.parse(text) as T) : (undefined as T), status: res.status };
  } catch (e: unknown) {
    return { ok: false, error: `invalid JSON: ${errMessage(e)}`, status: res.status };
  }
}

export function makeGithubAdapter(ctx: GithubCtx): GitPlatformAdapter {
  const repoPath = `/repos/${ctx.owner}/${ctx.repo}`;

  return {
    name: 'github',

    async openPullRequest(opts: OpenPROptions): Promise<OpenPRResult> {
      // 1. Create the PR.
      const created = await gh<{ number: number; html_url: string; draft: boolean; state: string }>(
        ctx,
        'POST',
        `${repoPath}/pulls`,
        {
          title: opts.title,
          body: opts.body,
          head: opts.head,
          base: opts.base,
          draft: opts.draft ?? true,
        },
      );
      if (!created.ok) return { ok: false, error: created.error, status: created.status };

      const number = created.data.number;
      const url = created.data.html_url;

      // 2. Best-effort: add labels. Failure here does NOT fail the PR
      //    creation — the PR is live, labels are cosmetic.
      if (opts.labels && opts.labels.length > 0) {
        const r = await gh(ctx, 'POST', `${repoPath}/issues/${number}/labels`, {
          labels: opts.labels,
        });
        if (!r.ok) console.warn(`[github] labels failed on PR#${number}: ${r.error}`);
      }

      // 3. Best-effort: request reviewers. Same reasoning.
      if (opts.reviewers && opts.reviewers.length > 0) {
        const r = await gh(ctx, 'POST', `${repoPath}/pulls/${number}/requested_reviewers`, {
          reviewers: opts.reviewers,
        });
        if (!r.ok) console.warn(`[github] reviewers failed on PR#${number}: ${r.error}`);
      }

      return {
        ok: true,
        url,
        number,
        state: created.data.draft ? 'draft' : 'open',
      };
    },

    async getPullRequestStatus(prNumber: number): Promise<GetPRStatusResult> {
      const r = await gh<{ state: string; draft: boolean; merged_at: string | null }>(
        ctx,
        'GET',
        `${repoPath}/pulls/${prNumber}`,
      );
      if (!r.ok) return { ok: false, error: r.error, status: r.status };
      const d = r.data;
      let state: 'draft' | 'open' | 'merged' | 'closed';
      if (d.merged_at) state = 'merged';
      else if (d.state === 'closed') state = 'closed';
      else if (d.draft) state = 'draft';
      else state = 'open';
      return { ok: true, state };
    },
  };
}

export type { GithubCtx };
