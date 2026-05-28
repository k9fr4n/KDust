/**
 * Wrapper around Dust internal `/api/w/{wId}/...` endpoints.
 *
 * These routes are NOT part of @dust-tt/client and NOT documented
 * publicly. They are documented in the dust-cli-perso project by
 * Antoine Santo (2026). Same bearer token as the public SDK; same
 * workspaceId; same region routing. Subject to break without notice.
 *
 * Contract: every helper is fail-soft. On 401/404/5xx we log a
 * single warn line and return null (or an empty-shape result) so
 * the UI degrades gracefully — the API surface is not versioned
 * and may change silently.
 *
 * Secrets: the bearer token is read via getValidAccessToken() on
 * every call (callable, no caching). We NEVER log the Authorization
 * header. Logging routes through the regular console.* path which
 * is redacted by src/lib/logs/buffer.ts before it reaches the UI
 * log panel.
 *
 * Author:        Franck SALLET (KDust dev agent)
 * Last-modified: 2026-05-28
 */
import { z } from 'zod';
import { getValidAccessToken } from './client';
import { loadTokens } from './tokens';
import { resolveDustUrl } from './region';

// Match the same UA the SDK client uses so the call lands in the
// same usage bucket (see src/lib/dust/client.ts).
const CLI_UA = 'Dust CLI';
const CLI_VERSION = '0.4.5';

type FetchResult = {
  status: number;
  json: unknown | null;
  text: string | null;
};

async function dustInternalFetch(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<FetchResult | null> {
  const stored = await loadTokens();
  if (!stored || !stored.workspaceId) return null;
  const token = await getValidAccessToken();
  if (!token) return null;
  const base = await resolveDustUrl(stored.region);
  const url = `${base}/api/w/${stored.workspaceId}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': CLI_UA,
        'X-Dust-CLI-Version': CLI_VERSION,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    return { status: res.status, json, text };
  } catch (err) {
    console.warn(
      `[dust/internal] ${method} ${path} fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

// ---------- /context-usage ----------

const ContextUsageSchema = z.object({
  model: z
    .object({
      providerId: z.string().nullable().optional(),
      modelId: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  contextUsage: z.number().nullable().optional(),
  contextSize: z.number().nullable().optional(),
});

export type ContextUsage = {
  usage: number | null;
  size: number | null;
  /** usage/size, clamped to [0,1]. null when either bound is missing. */
  percent: number | null;
  modelProvider: string | null;
  modelId: string | null;
};

/**
 * GET /assistant/conversations/{cId}/context-usage
 *
 * Returns the conversation's token-budget snapshot. Empty conversations
 * (no message yet, or sId not flushed by Dust) come back as 404 — we
 * map that to an empty-shape result rather than null so the UI can
 * still mount the panel.
 */
export async function getContextUsage(
  dustConversationSId: string,
): Promise<ContextUsage | null> {
  const res = await dustInternalFetch(
    'GET',
    `/assistant/conversations/${dustConversationSId}/context-usage`,
  );
  if (!res) return null;
  if (res.status === 404) {
    return {
      usage: null,
      size: null,
      percent: null,
      modelProvider: null,
      modelId: null,
    };
  }
  if (res.status < 200 || res.status >= 300) {
    console.warn(
      `[dust/internal] context-usage non-2xx status=${res.status} conv=${dustConversationSId}`,
    );
    return null;
  }
  const parsed = ContextUsageSchema.safeParse(res.json);
  if (!parsed.success) {
    console.warn(
      `[dust/internal] context-usage schema mismatch conv=${dustConversationSId}: ${parsed.error.message}`,
    );
    return null;
  }
  const data = parsed.data;
  const usage = data.contextUsage ?? null;
  const size = data.contextSize ?? null;
  const percent =
    usage !== null && size !== null && size > 0
      ? Math.max(0, Math.min(1, usage / size))
      : null;
  return {
    usage,
    size,
    percent,
    modelProvider: data.model?.providerId ?? null,
    modelId: data.model?.modelId ?? null,
  };
}

// ---------- /compactions ----------

export type CompactResult = {
  ok: boolean;
  status: number;
  /** Human-friendly error string when ok=false. */
  error?: string;
};

/**
 * POST /assistant/conversations/{cId}/compactions
 *
 * Requests a manual compaction of older messages to free up context
 * budget. The endpoint resolves the model from the conversation's
 * current agent when called with an empty body; we forward the
 * model snapshot we read from /context-usage when available, for
 * symmetry with what the dust-cli-perso reference implementation
 * does (avoids surprises if Dust ever requires it).
 *
 * Returns ok=true on 2xx. 409 typically means a generation is in
 * flight — caller should surface the error verbatim to the user.
 */
export async function postCompaction(
  dustConversationSId: string,
  model?: { providerId: string; modelId: string } | null,
): Promise<CompactResult> {
  const body: Record<string, unknown> = {};
  if (model) body.model = model;
  const res = await dustInternalFetch(
    'POST',
    `/assistant/conversations/${dustConversationSId}/compactions`,
    body,
  );
  if (!res) {
    return { ok: false, status: 0, error: 'dust unreachable' };
  }
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, status: res.status };
  }
  let errMsg: string | null = null;
  if (res.json && typeof res.json === 'object' && 'error' in res.json) {
    const e = (res.json as { error?: unknown }).error;
    errMsg = typeof e === 'string' ? e : JSON.stringify(e);
  }
  errMsg = errMsg ?? res.text ?? `http ${res.status}`;
  console.warn(
    `[dust/internal] compaction failed conv=${dustConversationSId} status=${res.status} error=${errMsg.slice(0, 200)}`,
  );
  return { ok: false, status: res.status, error: errMsg };
}
