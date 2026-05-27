// ---------------------------------------------------------------
// Browser-safe git URL helpers.
//
// Lives separately from `src/lib/git.ts` (which imports
// `node:child_process` and is therefore server-only) so it can
// be safely consumed from client components — e.g. the project
// create form's git-URL paste auto-fill (ADR-0022, option A:
// offline slug extraction).
// ---------------------------------------------------------------

export interface ParsedGitUrl {
  /** Hostname extracted from the URL (e.g. `github.com`). */
  host: string;
  /** Path component after the host (e.g. `owner/sub/repo`, no
   *  leading slash, trailing `.git` stripped). */
  pathWithNamespace: string;
  /** The leaf segment of the path (e.g. `repo`). */
  slug: string;
}

/**
 * Parse a git remote URL into its host + namespace + leaf slug.
 * Supports the three common forms:
 *   - SSH shorthand:  git@host:owner/repo.git
 *   - SSH explicit:   ssh://git@host/owner/repo.git
 *   - HTTPS:          https://host/owner/repo[.git][/]
 *
 * Returns null when the URL doesn't match any of these — caller
 * should leave the user's manual name input untouched.
 */
export function parseGitUrl(gitUrl: string): ParsedGitUrl | null {
  const trimmed = gitUrl.trim();
  if (!trimmed) return null;
  const m =
    trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/) ||
    trimmed.match(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?\/?$/) ||
    trimmed.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const host = m[1];
  const pathWithNamespace = m[2];
  const parts = pathWithNamespace.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const slug = parts[parts.length - 1];
  return { host, pathWithNamespace, slug };
}

/**
 * Convenience: just the leaf slug, validated against the regex
 * enforced by POST /api/projects (`[a-zA-Z0-9._-]+`). Returns
 * null when the URL is unparseable OR the slug contains rejected
 * characters — in either case the caller should keep the user's
 * manual input rather than auto-fill garbage.
 *
 * Used by the project create form to pre-fill the `name` field
 * when the operator pastes a git URL (ADR-0022 §Chantier 3,
 * option A: offline, no platform API call).
 */
export function extractRepoSlugFromGitUrl(gitUrl: string): string | null {
  const parsed = parseGitUrl(gitUrl);
  if (!parsed) return null;
  return /^[a-zA-Z0-9._-]+$/.test(parsed.slug) ? parsed.slug : null;
}
