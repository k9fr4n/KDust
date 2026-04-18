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
  "category_scores": {
    "security":      { "score": 0, "notes": "<≤400 chars>" },
    "performance":   { "score": 0, "notes": "<≤400 chars>" },
    "code_quality":  { "score": 0, "notes": "<≤400 chars>" },
    "improvement":   { "score": 0, "notes": "<≤400 chars>" },
    "documentation": { "score": 0, "notes": "<≤400 chars>" },
    "test_coverage": { "score": 0, "notes": "<≤400 chars>" }
  },
  "global_score": 0,
  "points": [
    {
      "rank": 1,
      "category": "security|performance|code_quality|improvement|documentation|test_coverage",
      "title": "<≤80 chars>",
      "description": "<≤400 chars, actionable>",
      "severity": "low|medium|high|critical",
      "refs": ["path/file.ext:lineno"]
    }
  ]
}
\`\`\`

Rules:
- Scores are integers in [0..100] using this grid:
    * 90-100 : excellent, no action needed
    * 70-89  : good, minor improvements
    * 50-69  : fair, several issues to address
    * 30-49  : poor, significant concerns
    * 0-29   : critical, urgent action required
  Base them on what you ACTUALLY observed via the fs tools. Do not be
  artificially harsh or lenient — if the project is clean, give a
  high score; if it is a mess, give a low one.
- "category_scores" MUST include all 6 categories above. "notes" is
  a short rationale (bullet-like, comma-separated) supporting the
  score. No prose inside notes, just the concrete signals.
- "global_score" is the overall project health (weighted average of
  the category scores is a good default; you may deviate if one area
  dominates the risk).
- EXACTLY 15 "points", sorted by ascending "rank" (1 = most critical).
  Each point MUST carry its "category" tag so the UI can group /
  filter them. Priority = business impact × severity, across ALL
  areas; do not balance artificially.
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
