import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDustClient } from '@/lib/dust/client';
import { apiError, badRequest, serverError, unauthorized } from "@/lib/api/responses";

export const runtime = 'nodejs';

/**
 * GET /api/agents
 *
 * Returns the list of Dust agents visible to the current tenant
 * session. Used by the chat agent picker and the per-project
 * default-agent dropdown on /settings/projects/[id].
 */
export async function GET() {
  const d = await getDustClient();
  if (!d) return unauthorized('not_connected');
  const res = await d.client.getAgentConfigurations({ view: 'list' } as any);
  if (res.isErr()) return serverError(res.error.message);
  // Scope surfaced 2026-04-19 20:23 so the UI can split \"global\"
  // (Dust-provided defaults) from \"workspace/published/visible/private\"
  // (agents created in this tenant). userFavorite too for a
  // future \"Starred\" tab.
  const agents = res.value.map((a: any) => ({
    sId: a.sId,
    name: a.name,
    description: a.description,
    pictureUrl: a.pictureUrl,
    scope: a.scope as string | undefined,
    userFavorite: a.userFavorite as boolean | undefined,
  }));
  return NextResponse.json({ agents });
}

/**
 * POST /api/agents
 *
 * Create a new Dust agent from KDust (Franck 2026-04-19 19:04
 * — option B of the Agents ADR).
 *
 * Body (zod-validated):
 *   - name         : string, 1–64 chars
 *   - description  : string, 1–256 chars (shown in agent pickers)
 *   - instructions : string, 1–8000 chars (the system prompt)
 *   - emoji        : optional string, 1–10 chars (single emoji)
 *
 * Visibility is intentionally NOT exposed: the Ecritel tenant
 * enforces a default privacy scope server-side, so newly-created
 * agents are automatically restricted to the creator’s group
 * regardless of what we send.
 *
 * Returns { agent: { sId, name, description, pictureUrl } } on 201
 * so the caller (eg /settings/projects/[id]) can immediately bind
 * the new agent to a project without a second round-trip.
 */
const CreateBody = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(256),
  instructions: z.string().min(1).max(8000),
  emoji: z.string().min(1).max(10).optional(),
});

export async function POST(req: Request) {
  const d = await getDustClient();
  if (!d) return unauthorized('not_connected');

  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return badRequest(parsed.error.format());
  }

  // SDK: createGenericAgentConfiguration is the public-API equivalent
  // of the internal agent_configurations POST. \"Generic\" here means
  // \"no data-sources / no tools wired yet\"; KDust users can enrich
  // the agent afterwards in the Dust UI if they want to attach KBs,
  // search tools, etc. Sub-agent fields left empty by design.
  const res = await d.client.createGenericAgentConfiguration(parsed.data);
  if (res.isErr()) {
    console.error('[agents] create failed', res.error);
    return apiError(res.error.message, 502);
  }

  const a: any = res.value.agentConfiguration;
  return NextResponse.json(
    {
      agent: {
        sId: a.sId,
        name: a.name,
        description: a.description,
        pictureUrl: a.pictureUrl,
      },
    },
    { status: 201 },
  );
}
