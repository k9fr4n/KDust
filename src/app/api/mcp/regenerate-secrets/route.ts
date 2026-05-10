import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeGatewaySecretsFile } from '@/lib/mcp/gateway-secrets';
import { invalidateGatewayClient } from '@/lib/mcp/gateway-client';
import { serverError } from '@/lib/api/responses';
import { errMessage } from '@/lib/errors';

export const runtime = 'nodejs';

const execFileP = promisify(execFile);

const GATEWAY_CONTAINER =
  process.env.MCP_GATEWAY_CONTAINER_NAME?.trim() || 'kdust-mcp-gateway';

/**
 * POST /api/mcp/regenerate-secrets
 *
 * One-stop "apply config" button for the /settings/mcp UI.
 * Rebuilds the gateway secrets file from the current
 * McpGatewayServer + McpServerSecret rows and bounces the gateway
 * container so it re-reads --secrets=...
 *
 * The KDust-side gateway client is also invalidated so the next
 * gateway-ensure call re-opens the streamable-HTTP connection and
 * re-runs tools/list (the gateway may have new tools after the
 * operator changed --servers=... in compose).
 *
 * Best-effort by design: a docker restart failure (e.g. socket
 * permission, container missing) is logged and reported but does
 * NOT roll back the file write — a stale gateway is recoverable,
 * an out-of-sync DB+file pair is not.
 */
export async function POST() {
  try {
    const r = await writeGatewaySecretsFile();
    let restartOk = false;
    let restartErr: string | null = null;
    try {
      // DooD: docker CLI in the container talks to the host daemon
      // via /var/run/docker.sock. The container name is fixed by
      // docker-compose.yml (`container_name: kdust-mcp-gateway`).
      const { stdout } = await execFileP(
        'docker',
        ['restart', GATEWAY_CONTAINER],
        { timeout: 30_000 },
      );
      restartOk = stdout.trim() === GATEWAY_CONTAINER;
      console.log(
        `[api/mcp/regenerate-secrets] docker restart ${GATEWAY_CONTAINER} -> ${stdout.trim()}`,
      );
    } catch (e) {
      restartErr = errMessage(e);
      console.warn(
        `[api/mcp/regenerate-secrets] docker restart failed: ${restartErr}`,
      );
    }
    // Drop the cached client either way; on next request it will
    // re-open against whatever gateway is reachable.
    await invalidateGatewayClient();
    return NextResponse.json({
      filePath: r.filePath,
      count: r.count,
      warnings: r.warnings,
      restart: { ok: restartOk, error: restartErr, container: GATEWAY_CONTAINER },
    });
  } catch (e) {
    return serverError(errMessage(e));
  }
}
