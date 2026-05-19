/**
 * Dust conversation-file fetch helper (Franck 2026-05-19).
 *
 * Extracted from `src/app/api/files/[sId]/route.ts` so that
 * server-side code outside the HTTP route handler (notably the
 * `fs-cli` MCP `export_fil_to_workdir` tool) can resolve a
 * Dust `fil_*` reference to its raw bytes without going through
 * the HTTP proxy.
 *
 * The route handler will be refactored to consume this in a
 * follow-up to keep the change footprint of this commit minimal.
 *
 * Two-step strategy:
 *   1. Try `action=view&version=original` — streams the body
 *      directly, fastest path.
 *   2. On `400 invalid_request_error` whose message is "The file
 *      use case is not supported by the API." (returned for
 *      `tool_output`, `project_context`, etc.), fall back to
 *      `action=download` which 302s to a signed GCS URL the SDK
 *      follows transparently.
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

export type FilBody = {
  body: ReadableStream<Uint8Array> | string;
  contentType: string;
  headers: Headers | Record<string, string> | undefined;
};

export type FilFetchError = {
  kind: 'sdk' | 'http';
  status?: number;
  message: string;
  errorType: string | null;
};

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
type UpstreamSdkError = { kind: 'sdk_error'; message: string };
type UpstreamResult = UpstreamOk | UpstreamHttpError | UpstreamSdkError;

async function fetchOnce(
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
    return { kind: 'ok', body: upstream.body, headers: upstream.headers };
  }
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
    /* keep status-only */
  }
  return { kind: 'http_error', status: upstream.status, message, errorType };
}

function shouldFallback(err: UpstreamHttpError): boolean {
  return err.status === 400 && /use[_ ]case is not supported/i.test(err.message);
}

/**
 * Resolve a Dust `fil_*` id to its raw body + content-type.
 *
 * Throws a `FilFetchError`-shaped plain object on failure. We
 * deliberately do not use a tagged-union return because the call
 * sites we have today all surface failure as an MCP `isError:
 * true` text result or an HTTP 4xx/5xx — a thrown shape keeps
 * the happy path linear.
 */
export async function fetchFilBody(client: unknown, sId: string): Promise<FilBody> {
  if (!/^fil_[A-Za-z0-9_-]+$/.test(sId)) {
    throw {
      kind: 'http',
      status: 400,
      message: `invalid file id: ${sId}`,
      errorType: 'invalid_request_error',
    } satisfies FilFetchError;
  }
  let upstream = await fetchOnce(client, sId, 'view');
  if (upstream.kind === 'http_error' && shouldFallback(upstream)) {
    upstream = await fetchOnce(client, sId, 'download');
  }
  if (upstream.kind === 'sdk_error') {
    throw {
      kind: 'sdk',
      message: upstream.message,
      errorType: null,
    } satisfies FilFetchError;
  }
  if (upstream.kind === 'http_error') {
    throw {
      kind: 'http',
      status: upstream.status,
      message: upstream.message,
      errorType: upstream.errorType,
    } satisfies FilFetchError;
  }
  const hdrs = upstream.headers;
  const contentType =
    (hdrs instanceof Headers
      ? hdrs.get('content-type')
      : (hdrs as Record<string, string> | undefined)?.['content-type']) ??
    'application/octet-stream';
  return { body: upstream.body, contentType, headers: hdrs };
}
