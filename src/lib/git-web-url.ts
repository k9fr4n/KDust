/**
 * Normalise a git remote URL (ssh or https) into a browser URL
 * for the host's web UI.
 *
 * Examples:
 *   git@github.com:owner/repo.git         -> https://github.com/owner/repo
 *   https://github.com/owner/repo.git     -> https://github.com/owner/repo
 *   git@gitlab.example.com:grp/sub/repo.git
 *                                          -> https://gitlab.example.com/grp/sub/repo
 *   ssh://git@gitlab.example.com:2222/grp/repo.git
 *                                          -> https://gitlab.example.com/grp/repo
 *
 * Returns null when the input isn't a recognisable git URL
 * (Franck 2026-05-28, used by the chat status panel + dashboard
 * cards to render an "Open repo" link without storing a
 * dedicated repoWebUrl column).
 */
export function gitUrlToWebUrl(gitUrl: string | null | undefined): string | null {
  if (!gitUrl) return null;
  const raw = gitUrl.trim();
  if (!raw) return null;

  // scp-like ssh form: user@host:path  (no scheme, single colon)
  // Example: git@github.com:owner/repo.git
  const scpMatch = raw.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scpMatch) {
    const host = scpMatch[1];
    const path = scpMatch[2].replace(/\.git$/, '').replace(/^\/+/, '');
    return `https://${host}/${path}`;
  }

  // URL form: ssh:// | git:// | http(s)://
  try {
    const u = new URL(raw);
    if (!['ssh:', 'git:', 'http:', 'https:'].includes(u.protocol)) return null;
    const host = u.hostname;
    if (!host) return null;
    const path = u.pathname.replace(/\.git$/, '').replace(/^\/+/, '');
    if (!path) return null;
    return `https://${host}/${path}`;
  } catch {
    return null;
  }
}
