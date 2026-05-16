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

  // Raw request so we can keep the stream + forward headers.
  const res = await (d.client as unknown as {
    request: (args: {
      method: 'GET';
      path: string;
      stream: true;
    }) => Promise<{
      isErr(): boolean;
      error?: { message: string };
      value?: {
        response: {
          body: ReadableStream<Uint8Array> | string;
          headers?: Headers | Record<string, string>;
        };
      };
    }>;
  }).request({
    method: 'GET',
    path: `files/${sId}?action=view&version=original`,
    stream: true,
  });

  if (res.isErr()) {
    const msg = res.error?.message ?? 'unknown error';
    console.error('[files] proxy failed', sId, msg);
    const status = /not[_ ]found/i.test(msg) ? 404 : 502;
    return apiError(msg, status);
  }

  const upstream = res.value!.response;
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
