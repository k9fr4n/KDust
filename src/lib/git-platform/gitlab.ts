/**
 * GitLab adapter (Phase 3, Franck 2026-05-10).
 *
 * Mirrors src/lib/git-platform/github.ts: raw REST v4 over fetch,
 * no @gitbeaker/* dependency for a 3-endpoint surface. If a later
 * phase needs broader coverage (pipelines, approvals, discussions,
 * notes), revisit with a proper client.
 *
 * Endpoints consumed:
 *   POST   /projects/:id/merge_requests                 (create MR)
 *   PUT    /projects/:id/merge_requests/:iid            (set labels)
 *   PUT    /projects/:id/merge_requests/:iid            (set reviewer_ids, separate call)
 *   GET    /projects/:id/merge_requests/:iid            (state poll)
 *
 * `:id` is the URL-encoded project path ("group/sub/repo") so we
 * never need a numeric ID lookup. This is the supported pattern
 * since GitLab 11+.
 *
 * Auth: a personal/project/group access token in `PRIVATE-TOKEN`
 * header. Required scopes:
 *   api  (read+write)  OR  read_api + write_repository.
 */

import { errMessage } from '../errors';
import type {
  GitPlatformAdapter,
  OpenPROptions,
  OpenPRResult,
  GetPRStatusResult,
} from './types';

type GitlabCtx = {
  apiUrl: string;          // e.g. https://gitlab.com/api/v4
  projectPath: string;     // e.g. "group/sub/repo" (NOT url-encoded)
  token: string;
};

async function gl<T>(
  ctx: GitlabCtx,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T; status: number } | { ok: false; error: string; status: number }> {
  let res: Response;
  try {
    res = await fetch(`${ctx.apiUrl}${path}`, {
      method,
      headers: {
        'PRIVATE-TOKEN': ctx.token,
        Accept: 'application/json',
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
    // GitLab error payload shapes vary:
    //   { message: "..." }
    //   { error: "...", error_description: "..." }
    //   { message: { branch: ["..."] } }   (validation errors)
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      if (typeof j?.message === 'string') {
        msg = `${msg}: ${j.message}`;
      } else if (j?.message && typeof j.message === 'object') {
        msg = `${msg}: ${JSON.stringify(j.message)}`;
      } else if (typeof j?.error === 'string') {
        msg = `${msg}: ${j.error}${j.error_description ? ` (${j.error_description})` : ''}`;
      }
    } catch { /* body not JSON, keep raw status */ }
    return { ok: false, error: msg, status: res.status };
  }
  try {
    return { ok: true, data: text ? (JSON.parse(text) as T) : (undefined as T), status: res.status };
  } catch (e: unknown) {
    return { ok: false, error: `invalid JSON: ${errMessage(e)}`, status: res.status };
  }
}

export function makeGitlabAdapter(ctx: GitlabCtx): GitPlatformAdapter {
  // URL-encode once. encodeURIComponent turns "group/sub/repo" into
  // "group%2Fsub%2Frepo" which is the canonical form GitLab expects
  // for the `:id` placeholder when using a path instead of a numeric ID.
  const projectId = encodeURIComponent(ctx.projectPath);
  const projectBase = `/projects/${projectId}`;

  return {
    name: 'gitlab',

    async openPullRequest(opts: OpenPROptions): Promise<OpenPRResult> {
      // 1. Create the MR. GitLab draft MRs are signaled by a "Draft: "
      //    title prefix (no boolean field as on GitHub). Honour the
      //    `draft` option by transforming the title at the boundary;
      //    do not mutate the caller-visible title string elsewhere.
      const isDraft = opts.draft ?? true;
      const title = isDraft && !/^draft:/i.test(opts.title) ? `Draft: ${opts.title}` : opts.title;
      const created = await gl<{
        iid: number;
        web_url: string;
        draft?: boolean;
        work_in_progress?: boolean;
        state: string;
      }>(ctx, 'POST', `${projectBase}/merge_requests`, {
        source_branch: opts.head,
        target_branch: opts.base,
        title,
        description: opts.body,
        remove_source_branch: true,
        squash: true,
        labels: opts.labels && opts.labels.length > 0 ? opts.labels.join(',') : undefined,
      });
      if (!created.ok) return { ok: false, error: created.error, status: created.status };

      const iid = created.data.iid;
      const url = created.data.web_url;

      // 2. Best-effort: set reviewers by USERNAME -> id resolution.
      //    GitLab expects numeric `reviewer_ids`. We accept usernames
      //    in the contract (mirrors github.ts) and resolve them via
      //    /users?username=… - one call per reviewer, kept simple.
      //    Failure here does NOT fail the MR creation.
      if (opts.reviewers && opts.reviewers.length > 0) {
        const ids: number[] = [];
        for (const username of opts.reviewers) {
          const u = await gl<Array<{ id: number; username: string }>>(
            ctx,
            'GET',
            `/users?username=${encodeURIComponent(username)}`,
          );
          if (u.ok && u.data.length > 0) ids.push(u.data[0].id);
          else console.warn(`[gitlab] reviewer lookup failed for "${username}": ${u.ok ? 'no match' : u.error}`);
        }
        if (ids.length > 0) {
          const r = await gl(ctx, 'PUT', `${projectBase}/merge_requests/${iid}`, {
            reviewer_ids: ids,
          });
          if (!r.ok) console.warn(`[gitlab] set reviewers failed on MR!${iid}: ${r.error}`);
        }
      }

      return {
        ok: true,
        url,
        number: iid,
        state: isDraft ? 'draft' : 'open',
      };
    },

    async getPullRequestStatus(prNumber: number): Promise<GetPRStatusResult> {
      const r = await gl<{
        state: string;
        draft?: boolean;
        work_in_progress?: boolean;
        merged_at: string | null;
      }>(ctx, 'GET', `${projectBase}/merge_requests/${prNumber}`);
      if (!r.ok) return { ok: false, error: r.error, status: r.status };
      const d = r.data;
      // GitLab state vocabulary: 'opened' | 'closed' | 'merged' | 'locked'.
      // The 'draft' flag (also exposed as legacy `work_in_progress`) is
      // independent of state — an MR can be both 'opened' and a draft.
      let state: 'draft' | 'open' | 'merged' | 'closed';
      if (d.merged_at || d.state === 'merged') state = 'merged';
      else if (d.state === 'closed' || d.state === 'locked') state = 'closed';
      else if (d.draft ?? d.work_in_progress) state = 'draft';
      else state = 'open';
      return { ok: true, state };
    },
  };
}

export type { GitlabCtx };
