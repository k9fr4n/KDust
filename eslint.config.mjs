/**
 * ESLint flat config for KDust.
 *
 * Migrated 2026-04-30 (cleanup item "lint migration") from
 * `next lint` (deprecated in Next 16) to a direct ESLint CLI
 * invocation. Two reasons for the change:
 *
 *   1. `next lint` is interactive (it prompts to install ESLint and
 *      pick a config) which made it unusable in CI / scripted runs;
 *   2. Next 16 removes `next lint` entirely — we'd hit a wall on the
 *      next minor bump.
 *
 * We bridge the legacy `eslint-config-next` (which still ships an
 * .eslintrc-style preset) into the new flat config via `FlatCompat`,
 * matching the exact pattern recommended by the Next 15 migration
 * guide. When `eslint-config-next` ships a native flat export, this
 * file collapses to ~5 lines.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

export default [
  {
    // Same default ignore set as next lint, plus the Prisma client
    // (generated, intentionally not type-checked here) and the
    // standalone build artifacts.
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      'src/generated/**',
      'prisma/migrations/**',
      'public/**',
      '*.config.js',
      '*.config.mjs',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // Project-wide refinements. Keep the list narrow on purpose:
      // we just removed every `any` from src/ in cleanup #15, and we
      // want any new one to fail loudly rather than slip in.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Next.js complains when a page exports a non-async function
      // returning a JSX element. Most KDust pages are server
      // components by convention, so the warning is just noise.
      '@next/next/no-html-link-for-pages': 'off',
      // We rely on next/image judiciously; the rest of the time a
      // plain <img> is fine for static assets in /public.
      '@next/next/no-img-element': 'off',
      // We use `console.log` deliberately for the structured `[mcp]`
      // / `[scheduler]` / `[chat/stream]` log lines that feed the
      // ring buffer. The rule is more disruptive than helpful here.
      'no-console': 'off',
      // React 18 + Next 15 don't need the React import to be in scope.
      'react/react-in-jsx-scope': 'off',
      // We use unescaped quotes in a handful of UI strings.
      'react/no-unescaped-entities': 'off',
    },
  },
];
