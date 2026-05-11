import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errMessage } from '@/lib/errors';
import {
  getGatewayServerId,
  releaseGatewayServer,
} from '@/lib/mcp/registry';
import { invalidateGatewayClient } from '@/lib/mcp/gateway-client';
import { badRequest, serverError } from '@/lib/api/responses';

export const runtime = 'nodejs';

/**
 * POST /api/mcp/gateway-ensure
 *
 * Ensures the per-project Docker MCP gateway proxy is started
 * and returns its serverId so the /chat client can include it in
 * mcpServerIds when posting to /api/conversation and friends.
 *
 * Mirrors /api/mcp/ensure (fs-cli) and /api/mcp/task-runner-ensure
 * exactly so the chat client can fold it into the same parallel-
 * ensure flow.
 *
 * `force: true` evicts BOTH the per-project proxy handle AND the
 * singleton gateway client. The next call re-opens the streamable
 * HTTP connection and re-issues tools/list, so this is the "the
 * gateway just got `compose up -d`'d" recovery path.
 */
const Body = z.object({
  projectFsPath: z.string().min(1),
  force: z.boolean().optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return badRequest(parsed.error.format());

  const { projectFsPath, force } = parsed.data;
  try {
    if (force) {
      console.log(
        `[api/mcp/gateway-ensure] force=true, evicting handle for project="${projectFsPath}"`,
      );
      await releaseGatewayServer(projectFsPath);
      await invalidateGatewayClient();
    }
    const serverId = await getGatewayServerId(projectFsPath);
    if (serverId === null) {
      // Project has no whitelisted gateway tools — no proxy was
      // registered. Surfacing a distinct shape lets the client
      // skip adding a non-existent serverId to mcpServerIds and
      // avoid the misleading "ensure failed" warning.
      console.log(
        `[api/mcp/gateway-ensure] no-tools project="${projectFsPath}" — skipped`,
      );
      return NextResponse.json({
        serverId: null,
        projectFsPath,
        skipped: 'no-tools',
      });
    }
    console.log(
      `[api/mcp/gateway-ensure] serverId=${serverId} project="${projectFsPath}"`,
    );
    return NextResponse.json({ serverId, projectFsPath });
  } catch (e: unknown) {
    console.error(
      `[api/mcp/gateway-ensure] failed project="${projectFsPath}":`,
      e,
    );
    return serverError(errMessage(e));
  }
}
