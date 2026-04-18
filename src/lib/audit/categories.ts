/**
 * Built-in AUDIT categories — v5 (2026-04-18).
 *
 * History:
 *   - v1 : 6 per-area "Conseils" builtins (security, performance, ...)
 *          → 6 Dust messages per project per week, too expensive.
 *   - v3 : single consolidated "priority" task returning TOP-15 across
 *          6 axes → dropped visibility on per-axis scoring.
 *   - v5 : back to 6 built-ins, one task per axis — "Audits". Each
 *          emits a focused prompt, a single category `score` and up
 *          to 5 actionable points. Legacy v3 "priority" + v1 per-area
 *          rows are wiped at seed time (see defaults.ts).
 *
 * Source of truth: BUILTIN_AUDIT_CATEGORIES below. POINT_CATEGORIES
 * is a derived view used by UI code that only cares about label /
 * emoji / color.
 */

export type AuditCategoryKey = string;

export type AuditCategoryBuiltin = {
  key: string;
  label: string;
  emoji: string;
  schedule: string;
  sortOrder: number;
  /** Color family (tailwind). UI only — never persisted. */
  color: string;
  /** Prompt body. JSON contract appended by buildAuditPrompt(). */
  prompt: string;
};

/**
 * Legacy keys cleaned up at seed time by ensureBuiltinsSeeded().
 * Includes both v1 per-area builtins AND the v3 "priority" task.
 * Any AuditCategoryDefault / Task / ProjectAudit row still carrying
 * one of these keys is migrated away (deleted) on next boot.
 */
export const LEGACY_BUILTIN_KEYS = [
  'priority',        // v3 consolidated (now split back into 6)
  'code_coverage',   // v1: renamed to test_coverage in v5 wording
] as const;

/**
 * Shared grading rubric appended inside every category prompt so the
 * agent uses the SAME scale across all 6 axes. Kept here (not in
 * prompts.ts) so the settings UI preview shows the full prompt.
 */
const GRADING_RUBRIC = `Grade the \`score\` (0-100) using:
  - 90-100 : best-in-class, very few improvements warranted
  - 70-89  : solid, a handful of medium-priority items
  - 50-69  : noticeable gaps, several high-priority items
  - 30-49  : significant issues across the codebase
  - 0-29   : critical gaps that block safe operation

Return AT MOST 5 concrete actionable points for this area, ranked by
impact (rank 1 = most urgent). Prefer file-and-line-precise findings
over generic advice. If the project is excellent in this area, return
fewer points (even zero) rather than padding with weak items.`;

function buildCategoryPrompt(area: string, bullets: string): string {
  return `You are a senior staff engineer auditing this project for ${area}.
Inspect the codebase via the fs_cli MCP tools (read_file, search_content,
search_files, run_command) and focus EXCLUSIVELY on ${area.toLowerCase()}.
Other concerns (security vs. performance, test coverage, etc.) are
audited separately — do not spend budget on them here.

Scope of this audit:
${bullets}

${GRADING_RUBRIC}`;
}

export const BUILTIN_AUDIT_CATEGORIES: AuditCategoryBuiltin[] = [
  {
    key: 'security',
    label: 'Security',
    emoji: '\u{1F6E1}\u{FE0F}',
    schedule: 'manual',
    sortOrder: 10,
    color: 'red',
    prompt: buildCategoryPrompt(
      'Security',
      `  - Hardcoded secrets, tokens, API keys (including in tests and fixtures)
  - Weak or deprecated crypto (MD5, SHA1, short keys, ECB mode, static IVs)
  - Injection surfaces: SQL, command, SSRF, XSS, path traversal, XXE
  - Authentication / session gaps: missing MFA, weak password policy,
    predictable tokens, missing CSRF, unsafe cookie flags
  - Authorization gaps: missing tenant isolation, IDOR, role bypass
  - Insecure defaults: debug mode on, verbose errors, open CORS
  - Dependency CVEs (check lockfiles, note severity + fix availability)
  - Insecure IaC: open security groups, wildcard IAM, public buckets,
    unencrypted volumes, missing TLS`,
    ),
  },
  {
    key: 'performance',
    label: 'Performance',
    emoji: '\u26A1',
    schedule: 'manual',
    sortOrder: 20,
    color: 'amber',
    prompt: buildCategoryPrompt(
      'Performance',
      `  - N+1 queries, missing indexes, un-paginated list endpoints
  - Synchronous I/O on hot paths (blocking event loops, request threads)
  - Oversized JS bundles, missing code-splitting, render-blocking assets
  - Unnecessary re-renders / recomputations in UI code
  - Unbounded loops, O(n\u00B2) or worse over large collections
  - Memory leaks (long-lived references, untracked subscriptions, caches
    without eviction)
  - Missing caching layers (HTTP, DB, CDN) or wrong cache invalidation
  - Chatty network calls: loops calling APIs, missing batch / graphql
    aggregation, waterfall fetches`,
    ),
  },
  {
    key: 'improvement',
    label: 'Improvement',
    emoji: '\u{1F680}',
    schedule: 'manual',
    sortOrder: 30,
    color: 'blue',
    prompt: buildCategoryPrompt(
      'Improvement',
      `  - Refactorings that unblock near-term roadmap work (DI seams,
    boundary layers, removing cyclic deps)
  - CI/CD & release automation gaps (manual release steps, missing
    previews, no canary / rollback)
  - Linting / formatting / type coverage gaps
  - Observability improvements: missing structured logs, metrics,
    traces, SLO dashboards
  - Developer experience wins: slow tests, painful local setup,
    missing scripts, unclear READMEs for contributors
  - Architecture simplifications: replace bespoke modules with stdlib
    / community solutions, merge overlapping services`,
    ),
  },
  {
    key: 'code_quality',
    label: 'Code quality',
    emoji: '\u2728',
    schedule: 'manual',
    sortOrder: 40,
    color: 'purple',
    prompt: buildCategoryPrompt(
      'Code quality',
      `  - Duplication (copy-pasted blocks, parallel implementations)
  - God classes / functions, excessive parameter lists, deep nesting
  - Tight coupling between modules, leaky abstractions
  - Swallowed exceptions (empty catch blocks, ignored errors)
  - Inconsistent style: mixed naming, mixed formatting, ad-hoc patterns
  - Dead code: unreachable branches, unused exports, commented-out
    code, obsolete flags
  - Unresolved TODO / FIXME / HACK markers older than a couple of
    months
  - Over-engineered abstractions (premature interfaces, unused
    extension points)`,
    ),
  },
  {
    key: 'test_coverage',
    label: 'Test coverage',
    emoji: '\u{1F9EA}',
    schedule: 'manual',
    sortOrder: 50,
    color: 'cyan',
    prompt: buildCategoryPrompt(
      'Test coverage',
      `  - Critical paths with zero or only-happy-path tests (auth, payment,
    data mutation, external integrations)
  - Modules with no test file at all
  - Integration / E2E gaps (entire flows covered only by unit tests
    on individual pieces)
  - Flaky or skipped tests left in the suite
  - Missing coverage tooling or CI thresholds (no coverage report
    published, no minimum enforced)
  - If a coverage report is present in the repo, cite concrete
    file-level / module-level percentages; else flag its absence.`,
    ),
  },
  {
    key: 'documentation',
    label: 'Documentation',
    emoji: '\u{1F4DA}',
    schedule: 'manual',
    sortOrder: 60,
    color: 'emerald',
    prompt: buildCategoryPrompt(
      'Documentation',
      `  - README completeness: purpose, quickstart, env vars, run/build/test
    instructions, deployment notes
  - Missing ADRs for non-trivial architectural decisions
  - Outdated examples in READMEs / docs that no longer compile or run
  - Undocumented public APIs (HTTP, library exports, CLI flags)
  - Missing runbooks for on-call / incident response
  - Code comments out of sync with the code they describe
  - Contributor-facing docs: CONTRIBUTING, code-of-conduct, pull
    request / review checklists`,
    ),
  },
];

/**
 * Canonical keys in display order (used by UI components iterating
 * over the category grid).
 */
export const POINT_CATEGORY_KEYS = BUILTIN_AUDIT_CATEGORIES.map((c) => c.key);

/**
 * Derived UI map: label + emoji + color + sortOrder per slug. Kept
 * as a lookup so components don't have to re-scan the array.
 */
export const POINT_CATEGORIES: Record<
  string,
  { label: string; emoji: string; sortOrder: number; color: string }
> = Object.fromEntries(
  BUILTIN_AUDIT_CATEGORIES.map((c) => [
    c.key,
    { label: c.label, emoji: c.emoji, sortOrder: c.sortOrder, color: c.color },
  ]),
);

/** Safe fallback for unknown / legacy category values. */
export function pointCategoryMeta(key: string | null | undefined) {
  if (!key)
    return { label: 'Other', emoji: '\u{1F4CB}', sortOrder: 99, color: 'slate' };
  return (
    POINT_CATEGORIES[key] ?? {
      label: key,
      emoji: '\u{1F4CB}',
      sortOrder: 99,
      color: 'slate',
    }
  );
}
