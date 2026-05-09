// src/lib/ssh/identity.ts
//
// CRUD over the SshIdentity Prisma model (Franck 2026-05-09, ADR-0011).
//
// Mirrors src/lib/secrets/repo.ts in spirit:
//   * encrypt() / decrypt() round-trip via src/lib/crypto.ts (same
//     APP_ENCRYPTION_KEY envelope used by Secret.valueEnc).
//   * No plaintext escapes this module except via
//     loadEnabledForMaterialization(), used by bootstrap.ts at boot
//     and after each rotation.
//   * The PUBLIC key + fingerprint are derived server-side from the
//     submitted private key via `ssh-keygen` -- the user never injects
//     them directly.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../db';
import { encrypt, decrypt } from '../crypto';
import { errMessage } from '../errors';

// --- validation ---------------------------------------------------

const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const HOST_PATTERN_RE = /^[A-Za-z0-9._*?\-,]{1,128}$/;

export function validateIdentityName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid identity name "${name}". Use 2-64 chars, start with a letter, only [a-z0-9_-].`);
  }
}

export function validateHostPattern(p: string): void {
  if (!HOST_PATTERN_RE.test(p)) {
    throw new Error(`Invalid host pattern "${p}". Allowed chars: [A-Za-z0-9._*?-,], 1-128 chars.`);
  }
}

// --- DTOs ---------------------------------------------------------

export interface SshIdentityDto {
  id: number;
  name: string;
  hostPattern: string;
  publicKey: string | null;
  fingerprint: string | null;
  description: string | null;
  enabled: boolean;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

interface IdentityRow {
  id: number; name: string; hostPattern: string; publicKey: string | null;
  fingerprint: string | null; description: string | null; enabled: boolean;
  priority: number; createdAt: Date; updatedAt: Date; lastUsedAt: Date | null;
}

function toDto(r: IdentityRow): SshIdentityDto {
  return {
    id: r.id, name: r.name, hostPattern: r.hostPattern,
    publicKey: r.publicKey, fingerprint: r.fingerprint,
    description: r.description, enabled: r.enabled, priority: r.priority,
    createdAt: r.createdAt, updatedAt: r.updatedAt, lastUsedAt: r.lastUsedAt,
  };
}

// --- ssh-keygen helpers -------------------------------------------

interface DerivedFromPrivate {
  publicKey: string;
  fingerprint: string;
}

/**
 * Spawn ssh-keygen against a temporary copy of the private key
 * (ssh-keygen requires a real file with mode 0600, no stdin path).
 * The temp dir lives under os.tmpdir() and is removed in finally{}.
 *
 * Throws on any failure: invalid PEM, encrypted/passphrase key, or
 * unsupported format.
 */
export async function deriveFromPrivateKey(privateKey: string): Promise<DerivedFromPrivate> {
  if (/Proc-Type:.*ENCRYPTED|ENCRYPTED PRIVATE KEY/i.test(privateKey)) {
    throw new Error('Encrypted/passphrase-protected SSH keys are not supported. Generate one without passphrase: ssh-keygen -t ed25519 -N "".');
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    throw new Error('Input does not look like a PEM-encoded SSH private key.');
  }

  const dir = await mkdtemp(join(tmpdir(), 'kdust-ssh-'));
  const file = join(dir, 'id');
  try {
    const body = privateKey.endsWith('\n') ? privateKey : privateKey + '\n';
    await writeFile(file, body, { mode: 0o600 });

    const pub = await runCmd('ssh-keygen', ['-y', '-f', file]);
    if (pub.code !== 0) throw new Error(`ssh-keygen -y failed: ${redactPath(pub.out, dir)}`);
    const fp = await runCmd('ssh-keygen', ['-lf', file]);
    if (fp.code !== 0) throw new Error(`ssh-keygen -lf failed: ${redactPath(fp.out, dir)}`);
    return { publicKey: pub.out.trim(), fingerprint: fp.out.trim() };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runCmd(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    const to = setTimeout(() => p.kill('SIGKILL'), 10_000);
    p.on('error', (e) => { clearTimeout(to); resolve({ code: -1, out: out + `\nspawn error: ${e.message}` }); });
    p.on('close', (code) => { clearTimeout(to); resolve({ code: code ?? -1, out }); });
  });
}

function redactPath(s: string, dir: string): string {
  return s.split(dir).join('<tmp>');
}

// --- CRUD ---------------------------------------------------------

export async function listIdentities(): Promise<SshIdentityDto[]> {
  const rows = await db.sshIdentity.findMany({
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
  });
  return rows.map(toDto);
}

export interface CreateIdentityInput {
  name: string;
  hostPattern: string;
  privateKey: string;
  description?: string | null;
  priority?: number;
  enabled?: boolean;
}

export async function createIdentity(input: CreateIdentityInput): Promise<SshIdentityDto> {
  validateIdentityName(input.name);
  validateHostPattern(input.hostPattern);
  if (!input.privateKey) throw new Error('Private key is required');

  let derived: DerivedFromPrivate;
  try { derived = await deriveFromPrivateKey(input.privateKey); }
  catch (e: unknown) { throw new Error(`Failed to validate private key: ${errMessage(e)}`); }

  const row = await db.sshIdentity.create({
    data: {
      name: input.name,
      hostPattern: input.hostPattern,
      privateKeyEnc: encrypt(input.privateKey),
      publicKey: derived.publicKey,
      fingerprint: derived.fingerprint,
      description: input.description ?? null,
      priority: input.priority ?? 100,
      enabled: input.enabled ?? true,
    },
  });
  return toDto(row);
}

export interface UpdateIdentityInput {
  hostPattern?: string;
  privateKey?: string;
  description?: string | null;
  priority?: number;
  enabled?: boolean;
}

export async function updateIdentity(name: string, input: UpdateIdentityInput): Promise<SshIdentityDto> {
  validateIdentityName(name);
  const data: Record<string, unknown> = {};
  if (input.hostPattern !== undefined) {
    validateHostPattern(input.hostPattern);
    data.hostPattern = input.hostPattern;
  }
  if (input.privateKey !== undefined) {
    if (!input.privateKey) throw new Error('Private key cannot be empty on rotation');
    let derived: DerivedFromPrivate;
    try { derived = await deriveFromPrivateKey(input.privateKey); }
    catch (e: unknown) { throw new Error(`Failed to validate private key: ${errMessage(e)}`); }
    data.privateKeyEnc = encrypt(input.privateKey);
    data.publicKey = derived.publicKey;
    data.fingerprint = derived.fingerprint;
  }
  if (input.description !== undefined) data.description = input.description;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.enabled !== undefined) data.enabled = input.enabled;

  const row = await db.sshIdentity.update({ where: { name }, data });
  return toDto(row);
}

export async function deleteIdentity(name: string): Promise<void> {
  validateIdentityName(name);
  await db.sshIdentity.delete({ where: { name } });
}

// --- bootstrap helper --------------------------------------------

export interface MaterializedIdentity {
  name: string;
  hostPattern: string;
  privateKey: string;
  priority: number;
}

/** NEVER expose this through any HTTP route. */
export async function loadEnabledForMaterialization(): Promise<MaterializedIdentity[]> {
  const rows = await db.sshIdentity.findMany({
    where: { enabled: true },
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
  });
  return rows.map((r) => ({
    name: r.name,
    hostPattern: r.hostPattern,
    privateKey: decrypt(r.privateKeyEnc),
    priority: r.priority,
  }));
}

export async function bumpLastUsed(names: string[]): Promise<void> {
  if (names.length === 0) return;
  await db.sshIdentity
    .updateMany({ where: { name: { in: names } }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
}
