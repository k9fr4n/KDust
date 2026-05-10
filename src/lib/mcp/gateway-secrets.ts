// src/lib/mcp/gateway-secrets.ts
//
// Materialises the Secret + McpServerSecret bindings into the
// .env file consumed by the Docker MCP gateway via
// `--secrets=/secrets/kdust-mcp.env` (ADR-0012, Franck 2026-05-10).
//
// Lifecycle:
//   - Called once at boot from src/instrumentation.ts so the
//     gateway has the fresh values before any chat opens.
//   - Called again from the future /settings/mcp CRUD endpoints
//     after a Secret edit, followed by a gateway restart.
//
// Hard rules:
//   * The file is written to ${MCP_GATEWAY_SECRETS_DIR} (default
//     /mcp-gateway/secrets) at mode 0600.
//   * Plaintext values are never logged. The redact list returned
//     here can be passed to logs/buffer to scrub stdout/stderr if
//     a future iteration relays gateway logs through KDust.
//   * Disabled servers (McpGatewayServer.enabled=false) are
//     skipped; their secrets are NOT written.
//   * A missing/decrypt-failing secret is logged at warn and
//     skipped (the boot must not throw — a single bad binding
//     should not brick the entire stack).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { db } from '../db';
import { decrypt } from '../crypto';

const DEFAULT_DIR = '/mcp-gateway/secrets';
const FILE_NAME = 'kdust-mcp.env';

export interface WriteResult {
  /** Absolute path of the written file. */
  filePath: string;
  /** Number of (server, secretKey) pairs successfully written. */
  count: number;
  /** Plaintext values, for log redaction. NEVER persist. */
  redactList: string[];
  /** Soft errors (missing secret, decrypt failure). */
  warnings: string[];
}

/**
 * Resolve every enabled McpGatewayServer's bindings, decrypt the
 * underlying Secret values, and write them as KEY=VALUE lines to
 * /mcp-gateway/secrets/kdust-mcp.env (mode 0600).
 *
 * Format: one entry per line, `<secretKey>=<value>` where
 * `secretKey` is the catalog key (e.g. `github.personal_access_token`).
 * No quoting; values must not contain newlines (Secret.valueEnc
 * is opaque ciphertext so we re-validate on decrypt).
 */
export async function writeGatewaySecretsFile(): Promise<WriteResult> {
  const dir = process.env.MCP_GATEWAY_SECRETS_DIR?.trim() || DEFAULT_DIR;
  const filePath = path.join(dir, FILE_NAME);
  const warnings: string[] = [];
  const lines: string[] = [];
  const redactList: string[] = [];
  let count = 0;

  let bindings: Array<{
    secretKey: string;
    secretName: string;
    server: { slug: string; enabled: boolean };
    secret: { valueEnc: string } | null;
  }> = [];
  try {
    bindings = await db.mcpServerSecret.findMany({
      include: { server: true, secret: true },
    });
  } catch (e) {
    // Schema may not yet be pushed (first boot / migration window).
    // Write an empty file so the gateway starts cleanly with no
    // secrets and we recover automatically once db is in sync.
    warnings.push(`db.mcpServerSecret.findMany failed: ${(e as Error).message}`);
  }

  for (const b of bindings) {
    if (!b.server.enabled) continue;
    if (!b.secret) {
      warnings.push(
        `binding server=${b.server.slug} key=${b.secretKey} -> missing Secret "${b.secretName}"`,
      );
      continue;
    }
    let plain: string;
    try {
      plain = decrypt(b.secret.valueEnc);
    } catch (e) {
      warnings.push(
        `decrypt failed for server=${b.server.slug} key=${b.secretKey}: ${(e as Error).message}`,
      );
      continue;
    }
    if (plain.includes('\n')) {
      warnings.push(
        `Secret "${b.secretName}" contains a newline; refusing to write (would break the .env line format)`,
      );
      continue;
    }
    lines.push(`${b.secretKey}=${plain}`);
    redactList.push(plain);
    count++;
  }

  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  // Trailing newline keeps a clean POSIX text file.
  const content = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  // Write with explicit mode 0600. Existing file is overwritten.
  await fs.writeFile(filePath, content, { mode: 0o600, encoding: 'utf-8' });
  // Best-effort chmod in case writeFile honoured umask instead of mode.
  await fs.chmod(filePath, 0o600).catch(() => {});

  console.log(
    `[mcp/gateway-secrets] wrote ${count} entr${count === 1 ? 'y' : 'ies'} to ${filePath} ` +
      `(warnings=${warnings.length})`,
  );
  for (const w of warnings) console.warn(`[mcp/gateway-secrets] ${w}`);

  return { filePath, count, redactList, warnings };
}
