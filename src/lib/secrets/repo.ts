// src/lib/secrets/repo.ts
//
// Secret manager repository (Franck 2026-04-21 21:30)
// ---------------------------------------------------
// Thin CRUD over the Secret / TaskSecret Prisma models. The one
// non-trivial piece is `resolveForRun()`: looks up the task owning a
// given TaskRun, joins its TaskSecret bindings, decrypts the values
// via src/lib/crypto.ts, and hands back a flat env map ready to
// merge into a child-process spawn.
//
// Hard rules (see prisma/schema.prisma comment for the full threat
// model):
//   * No function in this module returns a plaintext value outside
//     of resolveForRun() — the listing APIs only return metadata.
//   * validateName() enforces slug syntax; envName is checked with
//     a stricter regex to stay valid as a Unix env var identifier.
//   * resolveForRun() never throws on missing bindings: returns an
//     empty object. It DOES throw when a binding references a secret
//     that no longer exists (user-visible error: better loud than
//     silently spawning without the expected credential).

import { db } from '../db';
import { encrypt, decrypt } from '../crypto';
import { errMessage } from '../errors';

// --- validation ---------------------------------------------------

// Secret name: URL-safe slug. Lowercased for consistency, 2–64 chars.
const SECRET_NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/;
// Env var name: POSIX-ish. First char letter/underscore, rest word
// chars. Enforced to avoid weird exports.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function validateSecretName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) {
    throw new Error(
      `Invalid secret name "${name}". Use 2–64 chars, start with a letter, only [a-z0-9_-].`,
    );
  }
}

export function validateEnvName(name: string): void {
  if (!ENV_NAME_RE.test(name)) {
    throw new Error(
      `Invalid env var name "${name}". Use POSIX-style identifier: [A-Za-z_][A-Za-z0-9_]*, max 64 chars.`,
    );
  }
}

// --- DTOs ---------------------------------------------------------

export interface SecretDto {
  id: number;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  boundTaskCount: number;
}

export interface TaskSecretDto {
  id: number;
  taskId: string;
  envName: string;
  secretName: string;
}

// --- secrets CRUD -------------------------------------------------

export async function listSecrets(): Promise<SecretDto[]> {
  const rows = await db.secret.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { bindings: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastUsedAt: r.lastUsedAt,
    boundTaskCount: r._count.bindings,
  }));
}

export async function createSecret(
  name: string,
  value: string,
  description: string | null = null,
): Promise<SecretDto> {
  validateSecretName(name);
  if (!value) throw new Error('Secret value cannot be empty');
  const row = await db.secret.create({
    data: { name, valueEnc: encrypt(value), description },
  });
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    boundTaskCount: 0,
  };
}

export async function updateSecretValue(name: string, newValue: string): Promise<void> {
  validateSecretName(name);
  if (!newValue) throw new Error('New value cannot be empty');
  await db.secret.update({
    where: { name },
    data: { valueEnc: encrypt(newValue) },
  });
}

export async function updateSecretDescription(
  name: string,
  description: string | null,
): Promise<void> {
  validateSecretName(name);
  await db.secret.update({ where: { name }, data: { description } });
}

/**
 * Delete a secret. Refuses if bindings exist and `force` is false.
 * When `force=true`, drops bindings first — any tasks that referenced
 * the secret will SILENTLY LOSE the env on their next run, so callers
 * must warn the user.
 */
export async function deleteSecret(name: string, force = false): Promise<void> {
  validateSecretName(name);
  const bindings = await db.taskSecret.count({ where: { secretName: name } });
  if (bindings > 0 && !force) {
    throw new Error(
      `Secret "${name}" is still bound to ${bindings} task(s). Unbind first or pass force=true.`,
    );
  }
  if (force && bindings > 0) {
    await db.taskSecret.deleteMany({ where: { secretName: name } });
  }
  await db.secret.delete({ where: { name } });
}

// --- task bindings ------------------------------------------------

export async function listBindingsForTask(taskId: string): Promise<TaskSecretDto[]> {
  const rows = await db.taskSecret.findMany({
    where: { taskId },
    orderBy: { envName: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    envName: r.envName,
    secretName: r.secretName,
  }));
}

export async function upsertBinding(
  taskId: string,
  envName: string,
  secretName: string,
): Promise<void> {
  validateEnvName(envName);
  validateSecretName(secretName);
  // Ensure the target secret exists — DB-level FK enforces it too
  // but we want a clean error message before the FK violation.
  const exists = await db.secret.findUnique({ where: { name: secretName } });
  if (!exists) throw new Error(`Secret "${secretName}" does not exist`);
  await db.taskSecret.upsert({
    where: { taskId_envName: { taskId, envName } },
    create: { taskId, envName, secretName },
    update: { secretName },
  });
}

export async function removeBinding(taskId: string, envName: string): Promise<void> {
  await db.taskSecret
    .delete({ where: { taskId_envName: { taskId, envName } } })
    .catch(() => { /* idempotent */ });
}

// --- resolve for command-runner ----------------------------------

export interface ResolvedSecrets {
  /** env vars ready to merge into the child process env. */
  env: Record<string, string>;
  /** Plaintext values, used by the redactor to scrub stdout/stderr. */
  redactList: string[];
  /** Audit hints: which binding produced each env var (no values). */
  bindings: { envName: string; secretName: string }[];
}

/**
 * Resolve every TaskSecret binding attached to the task that owns
 * the given TaskRun. Called once per command-runner session (at
 * startServer time) so the spawn loop doesn’t hit the DB on every
 * run_command call. Decrypts values in memory; callers MUST NOT
 * log or forward the returned `env` to anywhere that could reach
 * the LLM.
 */
export async function resolveForRun(runId: string): Promise<ResolvedSecrets> {
  const run = await db.taskRun.findUnique({
    where: { id: runId },
    select: { taskId: true },
  });
  if (!run) return { env: {}, redactList: [], bindings: [] };

  const bindings = await db.taskSecret.findMany({
    where: { taskId: run.taskId },
    include: { secret: true },
  });
  if (bindings.length === 0) return { env: {}, redactList: [], bindings: [] };

  const env: Record<string, string> = {};
  const redactList: string[] = [];
  const hints: { envName: string; secretName: string }[] = [];
  const usedSecretIds = new Set<number>();

  for (const b of bindings) {
    if (!b.secret) {
      throw new Error(
        `Task binding refers to missing secret "${b.secretName}" (envName=${b.envName})`,
      );
    }
    let plain: string;
    try {
      plain = decrypt(b.secret.valueEnc);
    } catch (e: unknown) {
      throw new Error(
        `Failed to decrypt secret "${b.secretName}" (likely APP_ENCRYPTION_KEY rotated without re-encrypting): ${errMessage(e)}`,
      );
    }
    env[b.envName] = plain;
    redactList.push(plain);
    hints.push({ envName: b.envName, secretName: b.secretName });
    usedSecretIds.add(b.secret.id);
  }

  // Bump lastUsedAt in background — not awaited to keep the spawn
  // path fast; race conditions on this timestamp are harmless.
  if (usedSecretIds.size > 0) {
    void db.secret
      .updateMany({
        where: { id: { in: [...usedSecretIds] } },
        data: { lastUsedAt: new Date() },
      })
      .catch((e) => {
        console.warn(`[secrets] failed to bump lastUsedAt: ${e?.message ?? e}`);
      });
  }

  return { env, redactList, bindings: hints };
}
