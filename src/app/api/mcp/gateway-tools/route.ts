import { NextResponse } from 'next/server';
import { errMessage } from '@/lib/errors';
import { listGatewayTools } from '@/lib/mcp/gateway-client';
import { serverError } from '@/lib/api/responses';

export const runtime = 'nodejs';

/**
 * GET /api/mcp/gateway-tools?force=1
 *
 * Read-only diagnostics endpoint listing the tools currently
 * exposed by the Docker MCP gateway. Powers the future /settings/mcp
 * dashboard and is also handy for `curl` debugging from the host.
 *
 * `force=1` bypasses the in-memory cache and re-issues tools/list
 * against the gateway. Use after editing `--servers=...` in compose.
 */
export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get('force') === '1';
  try {
    const tools = await listGatewayTools(force);
    // Strip the inputSchema (often huge) for the default response;
    // the dashboard can re-fetch with ?details=1 once we wire it.
    const slim = tools.map((t) => ({
      name: t.name,
      description: t.description ?? null,
    }));
    return NextResponse.json({ count: tools.length, tools: slim });
  } catch (e: unknown) {
    return serverError(errMessage(e));
  }
}
