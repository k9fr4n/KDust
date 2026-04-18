/**
 * Built-in advice categories — v3 (2026-04-18).
 *
 * History:
 *   - v1 (6 categories: security, performance, code_quality,
 *     improvement, documentation, code_coverage) generated 6 Dust
 *     messages per project per week → too expensive.
 *   - v3 collapses them into a SINGLE "priority" category. The agent
 *     is asked to look at all six areas in a single pass and return
 *     the TOP-15 actionable points, globally ranked by priority.
 *
 * Legacy keys (security/performance/…) are cleaned up at seed time
 * by `ensureBuiltinsSeeded()` in defaults.ts.
 */

export type AdviceCategoryKey = string; // free-form after user adds custom categories

export type AdviceCategoryBuiltin = {
  key: string;
  label: string;
  emoji: string;
  schedule: string;
  prompt: string;
  sortOrder: number;
};

/** Canonical slug for the single v3 consolidated category. */
export const PRIORITY_CATEGORY_KEY = 'priority';

/**
 * Keys of the legacy v1 builtins. Used at migration time to wipe the
 * old per-project tasks + their ProjectAdvice rows. Never present in
 * the runtime config — only referenced by the one-shot cleanup.
 */
export const LEGACY_BUILTIN_KEYS = [
  'security',
  'performance',
  'code_quality',
  'improvement',
  'documentation',
  'code_coverage',
] as const;

/**
 * Keep prompts free of the JSON contract: that part is appended by
 * buildAdvicePrompt() in prompts.ts so that editing the category body
 * from the settings UI doesn't accidentally drop the contract.
 */
export const BUILTIN_ADVICE_CATEGORIES: AdviceCategoryBuiltin[] = [
  {
    key: PRIORITY_CATEGORY_KEY,
    label: 'Priority advice',
    emoji: '⭐',
    // schedule kept for schema back-compat only; tasks are manual-trigger.
    schedule: 'manual',
    sortOrder: 10,
    prompt: `You are a senior staff engineer auditing this project end-to-end.
Inspect the codebase via the fs_cli MCP tools (read_file, search_content,
search_files, run_command). Cover ALL the following areas in a SINGLE pass:

  1. Security      — hardcoded secrets, weak crypto, injection surfaces
                    (SQL/command/SSRF/XSS/path traversal), auth gaps,
                    missing CSRF, insecure defaults, dependency CVEs,
                    insecure IaC (open SGs, wildcard IAM, public buckets).
  2. Performance   — N+1 queries, missing indexes, sync I/O on hot paths,
                    oversized bundles, unnecessary re-renders, unbounded
                    loops, memory leaks, O(n²) over large collections,
                    missing caching, chatty network calls.
  3. Code quality  — duplication, god classes/functions, tight coupling,
                    swallowed exceptions, inconsistent style, dead code,
                    unresolved TODO/FIXME.
  4. Improvement   — refactorings that unblock future work, automation
                    gaps (CI/CD, linting, release automation), observability
                    improvements, DX wins, architecture simplifications.
  5. Documentation — README completeness, missing ADRs, outdated examples,
                    undocumented public APIs, missing runbooks.
  6. Test coverage — critical paths with zero/shallow tests, modules with
                    no test file, integration/e2e gaps, flaky/skipped
                    tests, missing coverage tooling / CI thresholds.
                    Cite concrete file-level percentages when a coverage
                    report is present.

Synthesise your findings into a GLOBAL TOP-15 ranked list of the MOST
IMPACTFUL actions the team should tackle next, regardless of area.
Rank strictly by business impact + severity — do NOT try to balance
the list across areas. If the top 15 are all security, that's fine; if
they span every area, that's fine too.

Prefer concrete, actionable items tied to specific files/lines over
generic advice.`,
  },
];
