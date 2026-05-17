import { NextResponse } from 'next/server';
import { getDustClient } from '@/lib/dust/client';
import { apiError, badRequest, unauthorized } from "@/lib/api/responses";

export const runtime = 'nodejs';

/**
 * GET /api/files/:sId
 *
 * Authenticated reverse-proxy for Dust-hosted files (Franck
 * 2026-04-23 16:10). Agents sometimes embed images in their
 * replies via markdown `![alt](fil_xxx)`, where `fil_xxx` is a
 * BARE Dust file id — not a full URL. The browser resolves it
 * relative to the current origin, so the <img> ends up pointing
 * at http://localhost:3000/fil_xxx (a 404).
 *
 * The markdown renderer in <MessageMarkdown /> rewrites such srcs
 * to /api/files/fil_xxx. This handler:
 *   1. Grabs the caller's Dust session.
 *   2. Calls the Dust files endpoint via the SDK's generic
 *      request() (method=GET, stream=true) so we can forward
 *      the upstream Content-Type header intact.
 *   3. Streams the body back with the same Content-Type.
 *
 * Why not use `client.getFileContent`:
 *   - It materialises the payload into a Blob, which buffers the
 *     whole file in memory. Our proxy can stream.
 *   - It swallows the upstream Content-Type, forcing us to guess
 *     the mime type from bytes.
 *
 * Security notes:
 *   - The session-scoped Dust client ensures only files the user
 *     already has access to are served. We don't widen access.
 *   - No Cache-Control: browsers revalidate on every view. Could
 *     add a short s-maxage later; avoiding it for now until we
 *     understand Dust's own caching semantics for these files.
 *   - We only accept sIds that match the Dust file prefix `fil_`
 *     as a cheap SSRF guard against user-crafted values.
 */

type Ctx = { params: Promise<{ sId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { sId } = await ctx.params;
  // Force-download mode (Franck 2026-04-23 16:46): when the query
  // string contains `download=1`, we tell the browser to save the
  // file instead of rendering it inline. Used by the image viewer's
  // "download" button. The filename is the sId (we have no nicer
  // name surfaced in Dust's response body); users can rename on
  // save.
  const url = new URL(req.url);
  const forceDownload = url.searchParams.get('download') === '1';
  /**
   * Optional caller-provided filename (Franck 2026-05-16). When the
   * /chat surface shows an agent-generated file it knows the human
   * title (e.g. "graph.png"); passing it here lets us forward the
   * SAME name to the browser's "Save As" dialog instead of the
   * opaque `fil_xxx` sId. Sanitised below — anything beyond a sane
   * filename (path traversal, control chars, quotes) is rejected so
   * the value can be safely embedded in `Content-Disposition`.
   */
  const rawName = url.searchParams.get('name');
  if (!/^fil_[A-Za-z0-9_-]+$/.test(sId)) {
    return badRequest('invalid_file_id');
  }
  // Allow letters, digits, dot, dash, underscore, space, parentheses
  // and common accents. Length cap = 200 chars (Windows MAX_PATH-ish).
  // Anything else → ignored, we fall back to sId. We deliberately do
  // NOT use encodeURIComponent here because Content-Disposition needs
  // a literal filename; the regex IS the sanitiser.
  const safeName =
    rawName &&
    rawName.length > 0 &&
    rawName.length <= 200 &&
    /^[A-Za-z0-9 _.()\-\u00C0-\u017F]+$/.test(rawName) &&
    !rawName.includes('..')
      ? rawName
      : null;

  const d = await getDustClient();
  if (!d) return unauthorized('not_connected');

  // Try `action=view` first (streams the body directly, fastest
  // path). For files whose Dust `useCase` is `tool_output`,
  // `project_context`, etc., the view action is rejected with
  //
  //   400 invalid_request_error:
  //   "The file use case is not supported by the API."
  //
  // In that case we fall back to `action=download`, which returns
  // a redirect to a signed GCS URL. The SDK's underlying fetch
  // uses the default `redirect: 'follow'`, so the response we
  // get back here is already the GCS body — we just stream it.
  // (Franck 2026-05-17, follow-up to PR #76.)
  let upstream = await fetchUpstreamFile(d.client, sId, 'view');
  if (upstream.kind === 'http_error' && shouldFallbackToDownload(upstream)) {
    console.warn(
      '[files] view rejected, retrying with action=download',
      sId,
      upstream.message,
    );
    upstream = await fetchUpstreamFile(d.client, sId, 'download');
  }

  if (upstream.kind === 'sdk_error') {
    console.error('[files] proxy failed', sId, upstream.message);
    const status = /not[_ ]found/i.test(upstream.message) ? 404 : 502;
    return apiError(upstream.message, status);
  }
  if (upstream.kind === 'http_error') {
    console.error(
      '[files] upstream returned non-2xx',
      sId,
      upstream.status,
      upstream.message,
    );
    // 404 stays 404 (lets the UI hide the chip cleanly); everything
    // else surfaces as 502 so a transient upstream blip doesn't get
    // misinterpreted as a client mistake.
    const proxyStatus = upstream.status === 404 ? 404 : 502;
    return apiError(upstream.message, proxyStatus);
  }

  const hdrs = upstream.headers;
  const contentType =
    (hdrs instanceof Headers
      ? hdrs.get('content-type')
      : (hdrs as Record<string, string> | undefined)?.['content-type']) ??
    'application/octet-stream';

  const outHeaders: Record<string, string> = { 'content-type': contentType };
  if (forceDownload) {
    const filename = safeName ?? sId;
    outHeaders['content-disposition'] = `attachment; filename="${filename}"`;
  }

  const body = upstream.body;
  if (typeof body === 'string') {
    return new NextResponse(body, { status: 200, headers: outHeaders });
  }
  return new NextResponse(body, { status: 200, headers: outHeaders });
}

// ---------------------------------------------------------------------------
// Upstream fetch helper
// ---------------------------------------------------------------------------

type UpstreamOk = {
  kind: 'ok';
  body: ReadableStream<Uint8Array> | string;
  headers: Headers | Record<string, string> | undefined;
};
type UpstreamHttpError = {
  kind: 'http_error';
  status: number;
  message: string;
  errorType: string | null;
};
type UpstreamSdkError = {
  kind: 'sdk_error';
  message: string;
};
type UpstreamResult = UpstreamOk | UpstreamHttpError | UpstreamSdkError;

/**
 * Dust API shape we tap into via the raw `request` escape hatch.
 * `getFileContent` is the high-level wrapper around the same call
 * but it materialises the body into a Blob — we want the stream so
 * we can pipe it back to the browser without buffering.
 */
type RawRequest = {
  request: (args: {
    method: 'GET';
    path: string;
    stream: true;
  }) => Promise<{
    isErr(): boolean;
    error?: { message: string };
    value?: {
      response: {
        status: number;
        ok: boolean;
        body: ReadableStream<Uint8Array> | string;
        headers?: Headers | Record<string, string>;
      };
    };
  }>;
};

/**
 * One shot at the upstream file endpoint. Wraps the SDK's two
 * failure modes (transport error vs. HTTP error envelope) into a
 * tagged union so the caller can branch cleanly.
 *
 * `action=view&version=original` streams the body directly.
 * `action=download` returns a 302 to a signed GCS URL; with the
 * SDK's default `redirect: 'follow'` fetch, the response we see
 * here is already the GCS body.
 */
async function fetchUpstreamFile(
  client: unknown,
  sId: string,
  action: 'view' | 'download',
): Promise<UpstreamResult> {
  const path =
    action === 'view'
      ? `files/${sId}?action=view&version=original`
      : `files/${sId}?action=download`;
  const res = await (client as RawRequest).request({
    method: 'GET',
    path,
    stream: true,
  });
  if (res.isErr()) {
    return { kind: 'sdk_error', message: res.error?.message ?? 'unknown error' };
  }
  const upstream = res.value!.response;
  if (upstream.ok) {
    return {
      kind: 'ok',
      body: upstream.body,
      headers: upstream.headers,
    };
  }
  // Non-2xx — buffer the envelope to surface a useful message.
  let message = `upstream ${upstream.status}`;
  let errorType: string | null = null;
  try {
    const raw =
      typeof upstream.body === 'string'
        ? upstream.body
        : await new Response(upstream.body).text();
    try {
      const parsed = JSON.parse(raw) as {
        error?: { message?: string; type?: string };
      };
      if (parsed?.error?.message) {
        errorType = parsed.error.type ?? null;
        message = errorType
          ? `${errorType}: ${parsed.error.message}`
          : parsed.error.message;
      }
    } catch {
      message = raw.slice(0, 500) || message;
    }
  } catch {
    /* keep status-only message */
  }
  return { kind: 'http_error', status: upstream.status, message, errorType };
}

/**
 * Trigger condition for the `view → download` fallback. The Dust
 * API returns a very specific envelope when the file's `useCase`
 * (e.g. `tool_output`) doesn't grant `view` access:
 *
 *   { error: { type: "invalid_request_error",
 *              message: "The file use case is not supported by the API." } }
 *
 * We match on the message substring (case-insensitive) gated by
 * 400 status to avoid retrying on unrelated 4xx (auth, rate
 * limit, etc).
 */
function shouldFallbackToDownload(err: UpstreamHttpError): boolean {
  return (
    err.status === 400 &&
    /use[_ ]case is not supported/i.test(err.message)
  );
}
