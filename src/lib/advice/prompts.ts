import type { AdviceCategory } from './categories';

/**
 * Strict JSON schema the agent MUST return. Anything outside this block
 * is ignored by the parser but kept in rawOutput for debugging.
 * Keep the instructions short and prescriptive — free-form answers
 * waste tokens and break the dashboard renderer.
 */
const JSON_CONTRACT = `
Return EXACTLY one fenced JSON block and nothing else after it, using this schema:

\`\`\`json
{
  "points": [
    { "title": "<≤80 chars>", "description": "<≤400 chars, actionable>", "severity": "low|medium|high|critical", "refs": ["path/file.ext:lineno"] }
  ]
}
\`\`\`

Rules:
- Exactly 3 points, ordered by importance (most critical first).
- "severity" uses the literal strings above.
- "refs" is optional but strongly preferred; list concrete file paths
  (+ line numbers when relevant) you observed via the fs tools.
- No prose before/after the JSON block. No markdown headers, no tables.
`;

const PER_CATEGORY: Record<AdviceCategory, string> = {
  security: `
You are a senior application security reviewer. Inspect the project via
the fs_cli MCP tools (read_file, search_content, search_files, run_command).
Focus on the TOP-3 most impactful security concerns for this codebase:
  - hardcoded secrets, credentials, tokens, weak crypto
  - injection surfaces (SQL, command, SSRF, XSS, path traversal)
  - auth/authorization gaps, missing CSRF, insecure defaults
  - dependency CVEs (check lockfiles if present)
  - insecure IaC (open SGs, wildcard IAM, public buckets, plaintext TF state)
`,
  performance: `
You are a senior performance engineer. Inspect the project via the
fs_cli MCP tools. Focus on the TOP-3 most impactful performance issues:
  - N+1 DB queries, missing indexes, synchronous I/O on hot paths
  - unnecessary re-renders / oversized bundles (frontend)
  - unbounded loops, memory leaks, unclosed resources
  - inefficient algorithms (O(n²) over large collections)
  - missing caching, chatty network calls
`,
  code_quality: `
You are a senior code reviewer. Inspect the project via the fs_cli MCP
tools. Focus on the TOP-3 most impactful code quality issues:
  - duplication, god classes/functions, tight coupling
  - missing error handling, swallowed exceptions
  - inconsistent naming/style across the codebase
  - lack of tests on critical paths
  - dead code, TODO/FIXME left unresolved
`,
  improvement: `
You are a pragmatic tech lead. Inspect the project via the fs_cli MCP
tools. Focus on the TOP-3 most valuable IMPROVEMENTS the team could
ship (not bugs — opportunities):
  - refactorings that unblock future work
  - automation gaps (CI/CD, linting, release automation)
  - observability/telemetry improvements
  - developer-experience wins (build speed, local setup)
  - architecture simplifications
`,
  documentation: `
You are a senior technical writer. Inspect the project via the fs_cli
MCP tools. Focus on the TOP-3 most impactful documentation gaps:
  - README completeness (purpose, setup, usage, contribution)
  - missing ADRs for significant design decisions
  - outdated examples / stale references
  - missing inline documentation on public APIs
  - missing runbook / troubleshooting section
`,
};

export function buildAdvicePrompt(category: AdviceCategory, projectName: string): string {
  const body = PER_CATEGORY[category].trim();
  return `${body}

Project under review: \`${projectName}\` (mounted at /projects/${projectName}).
Use ONLY fs_cli tools for exploration; do not invent file contents.

${JSON_CONTRACT.trim()}
`;
}
