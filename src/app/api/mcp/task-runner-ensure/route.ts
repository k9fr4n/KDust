import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errMessage } from '@/lib/errors';
import {
  getChatTaskRunnerServerId,
  releaseChatTaskRunnerServer,
} from '@/lib/mcp/registry';
import { badRequest, serverError } from "@/lib/api/responses";

export const runtime = 'nodejs';

/**
 * POST /api/mcp/task-runner-ensure
 *
 * Ensures a chat-mode task-runner MCP server is started and
 * returns its serverId so the /chat client can include it in
 * mcpServerIds when posting to /api/conversation and friends.
 *
 * Distinct from /api/mcp/ensure (which manages the per-project
 * fs-cli MCP server) because the two MCPs have different
 * lifecycles and cache keys: fs-cli is keyed per project and
 * idle-swept; task-runner-chat is also keyed per project but
 * never auto-swept (it's cheap, holds no chroot state).
 *
 * `force: true` evicts the cached handle so the next ensure
 * starts a fresh transport. Used by the chat client's same
 * "Dust rejected MCP serverId" recovery path as fs-cli.
 */
const Body = z.object({
  projectName: z.string().min(1),
  force: z.boolean().optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success)
    return badRequest(parsed.error.format());

  try {
    if (parsed.data.force) {
      console.log(
        `[api/mcp/task-runner-ensure] force=true, evicting chat handle for project="${parsed.data.projectName}"`,
      );
      await releaseChatTaskRunnerServer(parsed.data.projectName);
    }
    const serverId = await getChatTaskRunnerServerId(parsed.data.projectName);
    console.log(
      `[api/mcp/task-runner-ensure] serverId=${serverId} project="${parsed.data.projectName}"`,
    );
    return NextResponse.json({ serverId, projectName: parsed.data.projectName });
  } catch (e: unknown) {
    console.error(
      `[api/mcp/task-runner-ensure] failed project="${parsed.data.projectName}":`,
      e,
    );
    return serverError(errMessage(e));
  }
}
