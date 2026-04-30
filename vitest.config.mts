/**
 * Vitest config for KDust.
 *
 * Bootstrap (2026-04-30) of the test stack. Until now KDust had
 * no test framework: every refactor touching the scheduler / MCP /
 * push pipeline was guarded only by manual end-to-end runs. This
 * config pins down a minimal, fast, deterministic setup so unit
 * tests can land incrementally without blocking the dev loop.
 *
 * Conventions:
 *   - Test files live next to the code they exercise, in a sibling
 *     `__tests__/` folder, with the `.spec.ts` suffix. This keeps
 *     blast-radius local to a module and avoids the "central
 *     test/ tree drifts away from src/" anti-pattern.
 *   - Pure-function tests only at the start. Integration tests
 *     against the runner / push pipeline come later (gated by the
 *     ADR-0006 RunContext refactor, which makes phases unit-
 *     testable in isolation).
 *   - tsconfig path alias `@/` is honoured via vite-tsconfig-paths
 *     so test imports look identical to runtime imports.
 */
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // Node environment: nothing in the unit-test surface needs a
    // browser-like DOM. Switch to 'jsdom' on a per-file basis if a
    // future component test requires it.
    environment: 'node',
    // Match colocated specs only; never accidentally pick up a
    // dependency's compiled tests.
    include: ['src/**/__tests__/**/*.spec.ts', 'src/**/*.spec.ts'],
    // Globals off on purpose: explicit `import { describe, ... }`
    // keeps test files self-documenting and plays better with the
    // strict TS baseline.
    globals: false,
    // Reasonable wall-clock cap. Pure-function tests should run in
    // milliseconds; this prevents a hung future integration test
    // from blocking the suite indefinitely.
    testTimeout: 5_000,
  },
});
