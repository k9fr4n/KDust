import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDustClient } from '@/lib/dust/client';

export const runtime = 'nodejs';

/**
 * PATCH  /api/agents/:sId   — update an existing Dust agent.
 * DELETE /api/agents/:sId   — archive an existing Dust agent.
 *
 * Added 2026-04-23 13:49 (Franck) to flesh out the CRUD surface
 * of /settings/agents. The upstream Dust client SDK only exposes
 * create (POST assistant/generic_agents) and list (GET
 * assistant/agent_configurations); update and delete are reached
 * through the SDK's generic `client.request()` escape hatch,
 * which lets us talk to the public REST API directly.
 *
 * Only agents owned by the current tenant can be mutated. Default
 * (scope="global") agents are Dust-provided; mutating them is
 * both semantically wrong (they're shared across tenants) and
 * blocked server-side, so the UI hides the buttons — defense in
 * depth.
 *
 * Error surface:
 *   - 401 not_connected     — no Dust session
 *   - 400 validation failed — Zod rejected the body
 *   - 404 agent_configuration_not_found
 *   - 403 if Dust refuses because the agent belongs to another
 *         tenant or is a global default (bubbled up as 502 with
 *         the Dust error message since the SDK conflates these)
 *   - 502 anything else Dust returned
 */

const PatchBody = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().min(1).max(256).optional(),
  instructions: z.string().min(1).max(8000).optional(),
  emoji: z.string().min(1).max(10).optional(),
}).refine((d) => Object.keys(d).length > 0, {
  message: 'At least one field must be provided',
});

type Ctx = { params: Promise<{ sId: string }> };

/**
 * GET /api/agents/:sId
 *
 * Fetch a single agent's full configuration (including
 * `instructions`, which is omitted from the list endpoint for
 * payload-size reasons). Used by the edit modal in
 * /settings/agents to pre-fill the form with the current values.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { sId } = await ctx.params;
  const d = await getDustClient();
  if (!d) return NextResponse.json({ error: 'not_connected' }, { status: 401 });

  const res = await (d.client as unknown as {
    request: (args: { method: 'GET'; path: string }) => Promise<{
      isErr(): boolean;
      error?: { message: string };
      value?: { response: { body: string | ReadableStream<Uint8Array> } };
    }>;
  }).request({
    method: 'GET',
    path: `assistant/agent_configurations/${encodeURIComponent(sId)}`,
  });

  if (res.isErr()) {
    const msg = res.error?.message ?? 'unknown error';
    const status = /not[_ ]found/i.test(msg) ? 404 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
  // The raw Dust response wraps the agent in either
  // { agentConfiguration } or { agent } depending on the endpoint
  // revision. We walk both and pass the flat agent object back.
  type DustAgentShape = {
    sId?: string;
    name?: string;
    description?: string | null;
    instructions?: string | null;
    pictureUrl?: string | null;
    scope?: string;
    userFavorite?: boolean;
  };
  const body = res.value?.response.body;
  const text = typeof body === 'string'
    ? body
    : body
      ? await new Response(body).text()
      : '{}';
  let parsed: { agentConfiguration?: DustAgentShape; agent?: DustAgentShape } = {};
  try { parsed = JSON.parse(text); } catch { /* fallthrough */ }
  const a = parsed.agentConfiguration ?? parsed.agent ?? (parsed as DustAgentShape);
  return NextResponse.json({
    agent: {
      sId: a.sId ?? sId,
      name: a.name ?? '',
      description: a.description ?? null,
      instructions: a.instructions ?? null,
      pictureUrl: a.pictureUrl ?? null,
      scope: a.scope,
      userFavorite: a.userFavorite,
    },
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { sId } = await ctx.params;
  const d = await getDustClient();
  if (!d) return NextResponse.json({ error: 'not_connected' }, { status: 401 });

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  // The SDK's `request()` is typed loosely (Record<string, unknown>
  // body). We cast through `unknown` because `client` is the raw
  // DustAPI instance — no concrete type for this call.
  const res = await (d.client as unknown as {
    request: (args: {
      method: 'PATCH';
      path: string;
      body: Record<string, unknown>;
    }) => Promise<{ isErr(): boolean; error?: { message: string }; value?: unknown }>;
  }).request({
    method: 'PATCH',
    path: `assistant/agent_configurations/${encodeURIComponent(sId)}`,
    body: parsed.data,
  });

  if (res.isErr()) {
    const msg = res.error?.message ?? 'unknown error';
    console.error('[agents] update failed', sId, msg);
    // 404 bubbles up as a DustError with 'agent_configuration_not_found'
    const status = /not[_ ]found/i.test(msg) ? 404 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { sId } = await ctx.params;
  const d = await getDustClient();
  if (!d) return NextResponse.json({ error: 'not_connected' }, { status: 401 });

  const res = await (d.client as unknown as {
    request: (args: { method: 'DELETE'; path: string }) => Promise<{
      isErr(): boolean;
      error?: { message: string };
    }>;
  }).request({
    method: 'DELETE',
    path: `assistant/agent_configurations/${encodeURIComponent(sId)}`,
  });

  if (res.isErr()) {
    const msg = res.error?.message ?? 'unknown error';
    console.error('[agents] delete failed', sId, msg);
    const status = /not[_ ]found/i.test(msg) ? 404 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
  return NextResponse.json({ ok: true });
}
