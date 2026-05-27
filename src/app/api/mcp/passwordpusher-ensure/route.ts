import { NextResponse } from 'next/server';
import { errMessage } from '@/lib/errors';
import {
  getPasswordPusherServerId,
  releasePasswordPusherServer,
} from '@/lib/mcp/registry';
import { serverError } from '@/lib/api/responses';

export const runtime = 'nodejs';

/**
 * POST /api/mcp/passwordpusher-ensure
 *
 * Ensures the singleton passwordpusher MCP server is started and
 * returns its serverId so the /chat client can include it in
 * mcpServerIds when posting to /api/conversation and friends.
 *
 * Body: { force?: boolean } — when true, evicts the cached handle
 * so the next call starts a fresh transport. Used by the chat
 * "Dust rejected MCP serverId" recovery path.
 *
 * Unlike fs-cli / task-runner / skills / gateway, this server is
 * project-agnostic (no projectName/projectFsPath body field).
 */
export async function POST(req: Request) {
  let force = false;
  try {
    const body = (await req.json().catch(() => ({}))) as { force?: unknown };
    force = body?.force === true;
  } catch {
    // Body is optional; fall through with force=false.
  }

  try {
    if (force) {
      console.log('[api/mcp/passwordpusher-ensure] force=true, evicting handle');
      await releasePasswordPusherServer();
    }
    const serverId = await getPasswordPusherServerId();
    console.log(`[api/mcp/passwordpusher-ensure] serverId=${serverId}`);
    return NextResponse.json({ serverId });
  } catch (e: unknown) {
    console.error('[api/mcp/passwordpusher-ensure] failed:', e);
    return serverError(errMessage(e));
  }
}
