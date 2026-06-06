// docker/kdust-env.mjs
//
// Shell-inject launcher for the KDust Secret Manager (Franck
// 2026-06-06, ADR-0031).
//
// Resolves every Secret flagged `shellInject = true` from the KDust
// DB (model Secret, AES-256-GCM at rest) and either:
//   * (default, no command) prints `export NAME='value'` lines on
//     stdout, meant to be evaluated by an interactive shell:
//         eval "$(kdust-env)"
//     This is what the /etc/profile.d snippet does so the code-server
//     IDE terminal gets the secrets in its env (visible via `env`),
//     exactly like the container's own .env variables.
//   * (with a command) execs `<command> [args...]` with the secrets
//     overlaid on the inherited env — the safe, scoped variant
//     mirroring kdust-claude:
//         kdust-env -- mytool --flag
//
// Design mirrors docker/kdust-claude.mjs and src/lib/git-cli/
// bootstrap.ts:
//   * Plaintext is decrypted in-process, immediately before being
//     emitted/spawned; NEVER written to a log. Only secret NAMES are
//     echoed to stderr for UX.
//   * The env var name equals Secret.name. A name that is not a valid
//     POSIX identifier (e.g. contains '-') is SKIPPED with a warning
//     — the UI surfaces the same rule, so rename to use it.
//   * A Secret Manager value WINS over an inherited env var of the
//     same name (explicit operator intent).
//
// Runtime: plain Node ESM (.mjs). Zero npm deps beyond @prisma/client
// (shipped in the runner image). Resolves @prisma/client from
// /app/node_modules regardless of cwd.
//
// [SECURITY] The AES-256-GCM decrypt below MUST stay byte-compatible
// with src/lib/crypto.ts and docker/kdust-claude.mjs (same
// APP_ENCRYPTION_KEY base64 -> 32 bytes, aes-256-gcm, envelope
// `ivB64.tagB64.encB64`). Update in lockstep if crypto.ts changes.
//
// This path deliberately exposes plaintext in an INTERACTIVE human
// terminal (gated by the kdust_session JWT on the IDE proxy). It is
// NOT part of any LLM-orchestrated TaskRun. Kill switch:
// KDUST_SHELL_SECRETS=off neutralises the profile.d auto-eval.

import { createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

// POSIX env var identifier — kept in sync with ENV_NAME_RE in
// src/lib/secrets/repo.ts.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

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

// Single-quote a value for safe `export NAME='...'`. Inside single
// quotes the only special char is the single quote itself, escaped
// as the classic '\'' close/escape/reopen dance.
function shQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function resolveEnv() {
  const prisma = new PrismaClient();
  const injected = {};
  const skipped = [];
  const usedIds = [];
  try {
    const rows = await prisma.secret.findMany({
      where: { shellInject: true },
      select: { id: true, name: true, valueEnc: true },
    });
    for (const row of rows) {
      if (!ENV_NAME_RE.test(row.name)) {
        skipped.push(row.name);
        continue;
      }
      let plain;
      try {
        plain = decrypt(row.valueEnc);
      } catch {
        // Loud, but never echo the ciphertext or plaintext.
        console.error(
          `[kdust-env] failed to decrypt secret "${row.name}" ` +
            `(APP_ENCRYPTION_KEY rotated without re-encrypting?) — skipping`,
        );
        continue;
      }
      injected[row.name] = plain;
      usedIds.push(row.id);
    }
    if (usedIds.length > 0) {
      await prisma.secret
        .updateMany({ where: { id: { in: usedIds } }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  return { injected, skipped };
}

async function main() {
  const { injected, skipped } = await resolveEnv();
  const names = Object.keys(injected);

  // Names only — never values.
  console.error(
    `[kdust-env] shell-inject secrets: ` +
      `${names.length ? names.join(', ') : '(none)'}` +
      (skipped.length ? ` | skipped (invalid env name): ${skipped.join(', ')}` : ''),
  );

  // Find a `--` separator: everything after it is a command to exec.
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const cmd = sep === -1 ? argv : argv.slice(sep + 1);

  if (cmd.length === 0) {
    // Print mode: emit export lines for `eval "$(kdust-env)"`.
    for (const [k, v] of Object.entries(injected)) {
      process.stdout.write(`export ${k}=${shQuote(v)}\n`);
    }
    process.exit(0);
  }

  // Exec mode: run the command with secrets overlaid on the env.
  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, ...injected },
  });
  child.on('error', (e) => {
    console.error(`[kdust-env] failed to launch ${cmd[0]}: ${e.message}`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

main().catch((e) => {
  console.error(`[kdust-env] ${e?.message ?? e}`);
  process.exit(1);
});
