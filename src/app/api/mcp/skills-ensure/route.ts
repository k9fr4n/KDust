import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errMessage } from '@/lib/errors';
import {
  getChatSkillsServerId,
  releaseChatSkillsServer,
} from '@/lib/mcp/registry';
import { badRequest, serverError } from '@/lib/api/responses';

export const runtime = 'nodejs';

/**
 * POST /api/mcp/skills-ensure
 *
 * Ensures the chat-mode skills MCP server is started for the
 * given project and returns its serverId so the /chat client
 * can include it in mcpServerIds when posting to
 * /api/conversation and /api/conversation/[id]/messages.
 *
 * Mirrors /api/mcp/task-runner-ensure (ADR-0016 step 6).
 * Chat-mode skills are unfiltered: every on-disk skill is
 * visible, mirroring task-runner's chat mode contract. TaskRun
 * pipelines wire their filtered handle through setup-mcp
 * instead.
 *
 * `force: true` evicts the cached handle so the next ensure
 * starts a fresh transport. Used by the chat client's same
 * 'Dust rejected MCP serverId' recovery path as fs-cli /
 * task-runner.
 */
const Body = z.object({
  projectName: z.string().min(1),
  force: z.boolean().optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return badRequest(parsed.error.format());

  try {
    if (parsed.data.force) {
      console.log(
        `[api/mcp/skills-ensure] force=true, evicting chat handle for project=\"${parsed.data.projectName}\"`,
      );
      await releaseChatSkillsServer(parsed.data.projectName);
    }
    const serverId = await getChatSkillsServerId(parsed.data.projectName);
    console.log(
      `[api/mcp/skills-ensure] serverId=${serverId} project=\"${parsed.data.projectName}\"`,
    );
    return NextResponse.json({
      serverId,
      projectName: parsed.data.projectName,
    });
  } catch (e: unknown) {
    console.error(
      `[api/mcp/skills-ensure] failed project=\"${parsed.data.projectName}\":`,
      e,
    );
    return serverError(errMessage(e));
  }
}
