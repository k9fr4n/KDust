/**
 * Git platform adapter interface (Phase 2, Franck 2026-04-19).
 *
 * KDust calls one of these after a successful push so the agent-
 * authored branch becomes a reviewable Pull Request / Merge Request.
 * Each host (GitHub, GitLab, …) provides an implementation; the
 * factory in ./index.ts picks one based on Project.platform.
 *
 * Design rules:
 *  - Adapters NEVER throw for remote API errors. They return a
 *    { ok: false, error } result so the runner can keep going and
 *    just flag the run with prState="failed".
 *  - Adapters do not mutate the Project or TaskRun row — that
 *    happens in the runner — they only speak to the remote API.
 *  - Tokens are resolved once in the factory and passed in; adapters
 *    never read process.env themselves.
 */

export type OpenPROptions = {
  /** Branch being pushed (e.g. "kdust/audit-security/2026-04-19"). */
  head: string;
  /** Branch the PR targets (e.g. "main"). */
  base: string;
  /** PR / MR title. */
  title: string;
  /** Markdown body. */
  body: string;
  /** Open as draft? Recommended default = true. */
  draft?: boolean;
  /** CSV/array of GitHub logins or GitLab user IDs. */
  reviewers?: string[];
  /** Labels to apply. */
  labels?: string[];
};

export type OpenPRResult =
  | { ok: true; url: string; number: number; state: 'draft' | 'open' }
  | { ok: false; error: string; status?: number };

export type GetPRStatusResult =
  | { ok: true; state: 'draft' | 'open' | 'merged' | 'closed' }
  | { ok: false; error: string; status?: number };

export interface GitPlatformAdapter {
  readonly name: 'github' | 'gitlab';
  /** Open a new PR/MR. Idempotent callers should check for an
   *  existing open PR on the same head first (not done here). */
  openPullRequest(opts: OpenPROptions): Promise<OpenPRResult>;
  /** Poll current PR/MR state — used by a future background job. */
  getPullRequestStatus(prNumber: number): Promise<GetPRStatusResult>;
}
