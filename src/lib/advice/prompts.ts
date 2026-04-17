/**
 * The immutable JSON contract appended to every per-category prompt
 * body. Kept separate from the category prompt (stored in DB, editable
 * by the user) so accidentally removing the contract while editing the
 * body is impossible.
 */
const JSON_CONTRACT = `
Return EXACTLY one fenced JSON block and nothing else after it, using this schema:

\`\`\`json
{
  "score": 0,
  "points": [
    { "title": "<≤80 chars>", "description": "<≤400 chars, actionable>", "severity": "low|medium|high|critical", "refs": ["path/file.ext:lineno"] }
  ]
}
\`\`\`

Rules:
- "score" is an integer in [0..100] grading the OVERALL health of this
  specific category for the project:
    * 90-100 : excellent, no action needed
    * 70-89  : good, minor improvements
    * 50-69  : fair, several issues to address
    * 30-49  : poor, significant concerns
    * 0-29   : critical, urgent action required
  Base the score on what you ACTUALLY observed via the fs tools.
  Do not be artificially harsh or lenient — if the project is clean,
  give a high score; if it is a mess, give a low one.
- Exactly 3 "points", ordered by importance (most critical first).
- "severity" uses the literal strings above.
- "refs" is optional but strongly preferred; list concrete file paths
  (+ line numbers when relevant) you observed via the fs tools.
- No prose before/after the JSON block. No markdown headers, no tables.
`;

/**
 * Build the final prompt sent to the Dust agent. `body` comes from
 * AdviceCategoryDefault.prompt (user-editable); we wrap it with the
 * project context and JSON contract here.
 */
export function buildAdvicePrompt(body: string, projectName: string): string {
  return `${body.trim()}

Project under review: \`${projectName}\` (mounted at /projects/${projectName}).
Use ONLY fs_cli tools for exploration; do not invent file contents.

${JSON_CONTRACT.trim()}
`;
}
