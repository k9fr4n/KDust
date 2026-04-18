import { POINT_CATEGORIES } from './categories';

/**
 * JSON contract appended to every per-category audit prompt (v5).
 *
 * v5 change: each task is now scoped to ONE category and emits:
 *   - a single `score` [0..100] for that category
 *   - up to 5 actionable `points`, each with rank + severity + refs
 *
 * Kept separate from the category prompt (stored in DB, editable by
 * the user) so accidentally removing the contract while editing the
 * body is impossible.
 *
 * The `category` field in the JSON must echo the task's category
 * slug. We enforce it server-side (parser) to catch prompt/task drift.
 */
function jsonContract(categoryKey: string): string {
  const knownKeys = Object.keys(POINT_CATEGORIES).join('|');
  return `
Return EXACTLY one fenced JSON block and nothing else after it, using this schema:

\`\`\`json
{
  "version": 5,
  "category": "${categoryKey}",
  "score": 0,
  "notes": "<=400 chars rationale for the score",
  "points": [
    {
      "rank": 1,
      "title": "<=80 chars",
      "description": "<=400 chars, actionable",
      "severity": "low|medium|high|critical",
      "refs": ["path/file.ext:lineno"]
    }
  ]
}
\`\`\`

Rules:
- "version" MUST be the integer 5.
- "category" MUST be exactly "${categoryKey}" (known: ${knownKeys}).
- "score" is an integer in [0..100] using the grid described above.
  Base it on what you ACTUALLY observed via the fs tools. Do not be
  artificially harsh or lenient.
- "notes" is a short rationale (<=400 chars): concrete signals that
  led to the score (bullet-like, comma-separated). No prose.
- "points" is an array of AT MOST 5 entries, sorted by ascending
  "rank" (1 = most urgent). Return fewer points (including zero) when
  the project is already excellent on this axis. Never pad.
- "severity" uses the literal strings above.
- "refs" is optional but strongly preferred; list concrete file paths
  (+ line numbers when relevant) you observed via the fs tools.
- No prose before/after the JSON block. No markdown headers, no tables.
`;
}

/**
 * Build the final prompt sent to the Dust agent for ONE category.
 *
 * @param body        AdviceCategoryDefault.prompt (user-editable).
 * @param projectName Project slug (also the fs mount path).
 * @param categoryKey Canonical slug (security, performance, ...).
 */
export function buildAuditPrompt(
  body: string,
  projectName: string,
  categoryKey: string,
): string {
  return `${body.trim()}

Project under review: \`${projectName}\` (mounted at /projects/${projectName}).
Audit axis: \`${categoryKey}\`.
Use ONLY fs_cli tools for exploration; do not invent file contents.

${jsonContract(categoryKey).trim()}
`;
}

/**
 * Legacy alias kept for callers that haven't been migrated yet.
 * Ignores the category because pre-v5 callers had a single prompt.
 * @deprecated use buildAuditPrompt(body, projectName, categoryKey).
 */
export function buildAdvicePrompt(
  body: string,
  projectName: string,
  categoryKey = 'priority',
): string {
  return buildAuditPrompt(body, projectName, categoryKey);
}
