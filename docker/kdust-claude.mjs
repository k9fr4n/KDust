// docker/kdust-claude.mjs
//
// Interactive launcher for Claude Code inside the KDust container
// (Franck 2026-06-03, ADR-0027).
//
// Resolves a fixed set of ANTHROPIC_* configuration values from the
// KDust Secret Manager (model Secret, AES-256-GCM at rest) and execs
// the `claude` CLI with them injected into its environment ONLY.
//
// Design mirrors src/lib/git-cli/bootstrap.ts:
//   * The plaintext is decrypted in-process, immediately before the
//     spawn; it is NEVER written to argv, stdout, or any log. Only
//     secret NAMES (not values) are echoed to stderr for UX.
//   * A missing secret is a silent skip: `claude` falls back to
//     whatever is already in the process env for that variable (if
//     anything). This mirrors the gh/glab "silent skip" behaviour.
//   * A Secret Manager value WINS over an inherited env var of the
//     same name (explicit operator intent).
//
// Runtime: plain Node ESM (.mjs). Zero npm deps beyond @prisma/client,
// which is already shipped in the runner image (node_modules/.prisma
// + @prisma copied explicitly in the Dockerfile). The script resolves
// @prisma/client by walking up from /app/bin -> /app/node_modules, so
// it works regardless of the invoking cwd.
//
// [SECURITY] The AES-256-GCM decrypt below MUST stay byte-compatible
// with src/lib/crypto.ts. Both are stdlib-only and share the same
// APP_ENCRYPTION_KEY (base64 -> 32 bytes), algo aes-256-gcm, and the
// `ivB64.tagB64.encB64` envelope. If crypto.ts ever changes its
// envelope or KDF, update this copy in lockstep.

import { createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

// Convention (same as GH_TOKEN in git-cli/bootstrap.ts): the
// Secret.name equals the target env var name. Create whichever of
// these you need in /settings/secrets; absent ones are skipped.
const WANTED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
];

function getKey() {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error('APP_ENCRYPTION_KEY is required');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY must decode to 32 bytes (base64)');
  }
  return key;
}

function decrypt(payload) {
  const [ivB64, tagB64, encB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !encB64) throw new Error('Invalid ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encB64, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

async function resolveEnv() {
  const prisma = new PrismaClient();
  const injected = {};
  const usedIds = [];
  try {
    const rows = await prisma.secret.findMany({
      where: { name: { in: WANTED_ENV } },
      select: { id: true, name: true, valueEnc: true },
    });
    for (const row of rows) {
      let plain;
      try {
        plain = decrypt(row.valueEnc);
      } catch {
        // Loud, but never echo the ciphertext or plaintext.
        console.error(
          `[kdust-claude] failed to decrypt secret "${row.name}" ` +
            `(APP_ENCRYPTION_KEY rotated without re-encrypting?) — skipping`,
        );
        continue;
      }
      injected[row.name] = plain;
      usedIds.push(row.id);
    }
    if (usedIds.length > 0) {
      // Best-effort lastUsedAt bump, same pattern as resolveForRun().
      await prisma.secret
        .updateMany({ where: { id: { in: usedIds } }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  return injected;
}

async function main() {
  const injected = await resolveEnv();
  const names = Object.keys(injected);
  const missing = WANTED_ENV.filter((n) => !(n in injected));
  // Names only — never values.
  console.error(
    `[kdust-claude] injected from Secret Manager: ` +
      `${names.length ? names.join(', ') : '(none)'}` +
      (missing.length ? ` | not set: ${missing.join(', ')}` : ''),
  );

  const child = spawn('claude', process.argv.slice(2), {
    stdio: 'inherit',
    env: { ...process.env, ...injected },
  });
  child.on('error', (e) => {
    console.error(`[kdust-claude] failed to launch claude: ${e.message}`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      // Re-raise the signal so the exit status mirrors `claude`.
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

main().catch((e) => {
  console.error(`[kdust-claude] ${e?.message ?? e}`);
  process.exit(1);
});
