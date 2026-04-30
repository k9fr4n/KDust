# Testing in KDust

KDust uses [Vitest](https://vitest.dev) (v2). The stack was bootstrapped
on 2026-04-30 — prior to that, every refactor was guarded only by manual
QA, which is the original motivation for cleanup item #1 level B (split
`runner.ts` into testable phases) being gated on a real test framework.

## Running tests

| Command | Purpose |
|---|---|
| `npm test` | One-shot run, exits with non-zero on failure. CI-ready. |
| `npm run test:watch` | Watch mode with the Vitest TUI. |

First run takes ~1s (esbuild warm-up). Subsequent runs are sub-second
thanks to Vite's transform cache.

## File layout

Tests live **next to** the code they exercise, in a sibling `__tests__/`
folder, with the `.spec.ts` suffix:

```
src/lib/git.ts
src/lib/__tests__/git.spec.ts

src/lib/cron/phases.ts
src/lib/cron/__tests__/phases.spec.ts
```

**Why colocated:** moves with the module it covers when you refactor;
avoids the central `tests/` tree drifting away from `src/` over time;
makes blast-radius of a change immediately obvious in code review.

## What to test (today)

**In scope** — land tests for any new or refactored module of these
categories:

| Category | Example |
|---|---|
| Pure helpers (string transforms, slug, format, validators) | `slugifyRef`, `composeBranchName`, `isRunPhase` |
| Security boundaries (redactor, encryption helpers) | `buildRedactor`, `tokenCipher` |
| API contract narrowing at Prisma boundary | `isRunPhase`, future `isTrigger` |
| Domain-specific calculators (cron parser, branch policy) | `parseCron` |

**Out of scope (for now)** — the runner / push pipeline / MCP servers
require 4+ external boundaries to be mocked (Dust SDK, git, MCP
transport, Teams). Adding them now would be brittle; they're parked
until ADR-0006 (`RunContext` split) lands and makes each phase
unit-testable in isolation.

## Conventions

- **Globals off**: import `describe / it / expect` explicitly. Plays
  better with the strict TS baseline; keeps test files
  self-documenting.
- **No mocking framework yet**: prefer dependency injection (pass a
  `Date` arg, accept a function that returns the value, etc.) over
  `vi.mock()`. The first `vi.mock()` introduces complexity that
  needs justifying.
- **Comment intent in JSDoc** at the top of each spec file: which
  invariant of the production code does this suite protect? See
  `src/lib/secrets/__tests__/redact.spec.ts` for the canonical
  pattern.
- **Path alias**: `@/` is honoured via `vite-tsconfig-paths`. Test
  imports look identical to runtime imports.

## Adding a test

1. Create `src/<area>/__tests__/<module>.spec.ts`.
2. Header JSDoc — one paragraph stating *why* the suite exists
   (which production invariant it protects).
3. `import { describe, it, expect } from 'vitest';`
4. Run `npm run test:watch` while writing; commit when green.
5. `npx tsc --noEmit && npm run lint` before pushing — specs are
   first-class TS files and must pass the same checks as `src/`.

## Limitations

- **No coverage reporting yet.** `@vitest/coverage-v8` has a peer
  conflict with our ESLint v9 setup; deferred. Run `vitest --reporter=verbose`
  for a per-test view.
- **No DOM tests.** `environment: 'node'` by default. If a future
  component test needs jsdom, switch on a per-file basis with
  `// @vitest-environment jsdom`.
- **No Prisma integration.** Until ADR-0006 lands, integration tests
  against a temporary sqlite are deliberately not part of the stack.

## CI hint

A minimal CI pipeline blocking on regressions would look like:

```yaml
- run: npm ci
- run: npx tsc --noEmit
- run: npm run lint
- run: npm test
- run: npm run build
```

All four steps are deterministic and independent; they can run in
parallel under most runners.
