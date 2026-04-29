import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getFsServerId, invalidateFsServer } from '@/lib/mcp/registry';
import { badRequest, serverError } from "@/lib/api/responses";

export const runtime = 'nodejs';

// `force: true` \u2014 added 2026-04-20 (Franck) so the client can
// recover from the "unknown MCP server ID" 403 that Dust emits when
// a transport was torn down behind its back (token expiry, cold
// restart). Client passes force=true on retry to evict the cached
// handle before we re-register.
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
      console.log(`[api/mcp/ensure] force=true, evicting cached handle for project="${parsed.data.projectName}"`);
      await invalidateFsServer(parsed.data.projectName);
    }
    console.log(`[api/mcp/ensure] requested for project="${parsed.data.projectName}"`);
    const serverId = await getFsServerId(parsed.data.projectName);
    console.log(`[api/mcp/ensure] serverId=${serverId} project="${parsed.data.projectName}"`);
    return NextResponse.json({ serverId, projectName: parsed.data.projectName });
  } catch (e: any) {
    console.error(`[api/mcp/ensure] failed project="${parsed.data.projectName}":`, e);
    return serverError(e?.message ?? String(e));
  }
}
