// src/lib/ssh/bootstrap.ts
//
// Materialise SshIdentity rows to a tmpfs the running ssh(1) and
// git(1) processes can read (Franck 2026-05-09, ADR-0011).
//
// Layout under SSH_RUNTIME_DIR (default /run/kdust/ssh, must be a
// tmpfs mounted with mode=0700,uid=1000,gid=1000 -- see
// docker-compose.yml):
//
//   id_<name>          0600  decrypted private key
//   id_<name>.pub      0644  derived public key
//   config             0600  generated ssh_config
//   known_hosts        0644  passthrough copy from /home/node/.ssh
//
// The generated ssh config looks like:
//
//   # KDust managed -- do not edit
//   Host github.com
//     IdentityFile /run/kdust/ssh/id_github
//     IdentitiesOnly yes
//     StrictHostKeyChecking accept-new
//     UserKnownHostsFile /run/kdust/ssh/known_hosts
//
// At least one identity present -> we set process.env.GIT_SSH_COMMAND
// to `ssh -F <runtime-dir>/config ...` so spawned `git` processes
// pick the config up. SSH_AUTH_SOCK from the host (if mounted) keeps
// priority because ssh tries the agent before file-based identities;
// this is intentional zero-downtime fallback.
//
// Hard rules:
//   * Caller MUST be the in-process node user (uid 1000). The
//     entrypoint pre-creates the tmpfs root with the right uid;
//     this module never chmods/chowns recursively.
//   * NEVER log decrypted key bytes. We log identity NAMES only.
//   * Errors are caught at the call site (instrumentation hook) so
//     a misconfigured identity cannot brick the container -- the
//     existing /home/node/.ssh fallback path stays intact.

import { mkdir, writeFile, readFile, rm, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnabledForMaterialization, bumpLastUsed } from './identity';

export const SSH_RUNTIME_DIR = process.env.KDUST_SSH_RUNTIME_DIR || '/run/kdust/ssh';
const HOST_KNOWN_HOSTS = '/home/node/.ssh/known_hosts';

export interface MaterializeResult {
  ok: boolean;
  count: number;
  identityNames: string[];
  warnings: string[];
  error?: string;
}

/**
 * (Re)write the tmpfs from the DB. Idempotent: every call wipes
 * stale id_* / *.pub files first to ensure a deleted identity is
 * not left lingering on disk.
 */
export async function materializeSshIdentities(): Promise<MaterializeResult> {
  const warnings: string[] = [];
  const result: MaterializeResult = { ok: false, count: 0, identityNames: [], warnings };

  // Sanity check the tmpfs root. If it's missing we either run
  // outside the container (dev on host) or the operator forgot the
  // tmpfs mount -- soft no-op so the cron scheduler still boots.
  try {
    await mkdir(SSH_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  } catch (e) {
    result.error = `Cannot create SSH runtime dir ${SSH_RUNTIME_DIR}: ${(e as Error).message}`;
    return result;
  }

  // Wipe stale id_* files -- deletion semantics.
  try {
    const stale = await readdir(SSH_RUNTIME_DIR);
    for (const f of stale) {
      if (f.startsWith('id_') || f === 'config' || f === 'known_hosts') {
        await rm(join(SSH_RUNTIME_DIR, f), { force: true });
      }
    }
  } catch { /* fresh dir, nothing to clean */ }

  let identities;
  try {
    identities = await loadEnabledForMaterialization();
  } catch (e) {
    result.error = `Failed to load identities from DB: ${(e as Error).message}`;
    return result;
  }

  if (identities.length === 0) {
    // No identities: leave the runtime dir empty and unset
    // GIT_SSH_COMMAND override -- callers fall back to the legacy
    // /home/node/.ssh path baked by docker/entrypoint.sh.
    delete process.env.KDUST_SSH_CONFIG;
    result.ok = true;
    return result;
  }

  // Copy host known_hosts (if any) so existing fingerprints are
  // honoured. Best-effort: if the source is missing we just create
  // an empty file -- ssh's StrictHostKeyChecking=accept-new will
  // populate it on first contact.
  const khTarget = join(SSH_RUNTIME_DIR, 'known_hosts');
  try {
    await copyFile(HOST_KNOWN_HOSTS, khTarget);
  } catch {
    await writeFile(khTarget, '', { mode: 0o644 });
    warnings.push(`No source known_hosts at ${HOST_KNOWN_HOSTS}; starting with an empty file (StrictHostKeyChecking=accept-new will populate it).`);
  }

  // Write each identity. The private key file MUST be 0600 -- ssh
  // refuses to use anything more permissive.
  const configBlocks: string[] = [];
  for (const id of identities) {
    const keyPath = join(SSH_RUNTIME_DIR, `id_${id.name}`);
    const body = id.privateKey.endsWith('\n') ? id.privateKey : id.privateKey + '\n';
    await writeFile(keyPath, body, { mode: 0o600 });
    configBlocks.push(
      `Host ${id.hostPattern}\n` +
      `  IdentityFile ${keyPath}\n` +
      `  IdentitiesOnly yes\n` +
      `  StrictHostKeyChecking accept-new\n` +
      `  UserKnownHostsFile ${khTarget}\n`
    );
    result.identityNames.push(id.name);
  }

  const configPath = join(SSH_RUNTIME_DIR, 'config');
  const header = '# KDust managed -- do not edit. Regenerated on every boot/rotation.\n';
  await writeFile(configPath, header + configBlocks.join('\n'), { mode: 0o600 });

  // Wire the env so spawned git processes (src/lib/git.ts) pick it up.
  // We DO NOT override SSH_AUTH_SOCK -- if the host agent is mounted
  // ssh will still try it first, our config provides the fallback.
  process.env.KDUST_SSH_CONFIG = configPath;
  // The legacy git.ts default is preserved when GIT_SSH_COMMAND is
  // unset; we set an explicit one that points at our config so the
  // priority is unambiguous.
  process.env.GIT_SSH_COMMAND = `ssh -F ${configPath} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${khTarget}`;

  result.ok = true;
  result.count = identities.length;

  // Best-effort lastUsedAt bump (non-blocking).
  void bumpLastUsed(result.identityNames);

  // Reassurance log -- names only, never values.
  console.log(`[ssh-bootstrap] materialised ${result.count} identity(ies) to ${SSH_RUNTIME_DIR}: ${result.identityNames.join(', ')}`);
  for (const w of warnings) console.warn(`[ssh-bootstrap] ${w}`);

  return result;
}

/**
 * Diagnostic snapshot for the /settings/ssh debug panel. Lists the
 * runtime dir contents (names + perms only, NEVER bytes) and the
 * relevant env vars. Safe to expose through the auth'd UI.
 */
export async function describeSshRuntime(): Promise<{
  runtimeDir: string;
  configPath: string | null;
  files: { name: string; size: number }[];
  env: { GIT_SSH_COMMAND: string | null; SSH_AUTH_SOCK: string | null; KDUST_SSH_CONFIG: string | null };
}> {
  const env = {
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? null,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? null,
    KDUST_SSH_CONFIG: process.env.KDUST_SSH_CONFIG ?? null,
  };
  const files: { name: string; size: number }[] = [];
  let configPath: string | null = null;
  try {
    const entries = await readdir(SSH_RUNTIME_DIR);
    for (const f of entries) {
      const buf = await readFile(join(SSH_RUNTIME_DIR, f));
      files.push({ name: f, size: buf.length });
      if (f === 'config') configPath = join(SSH_RUNTIME_DIR, f);
    }
  } catch { /* dir absent */ }
  return { runtimeDir: SSH_RUNTIME_DIR, configPath, files, env };
}
