/**
 * passwordpusher MCP server (Franck 2026-05-27).
 *
 * Purpose
 * -------
 * Push a secret to the self-hosted PasswordPusher instance
 * (https://passwordpusher.ecritel.net by default) and return the
 * one-shot retrieval URL. Three tools:
 *
 *   - pwpush_create  (writes)   POST /p.json
 *   - pwpush_preview (readonly)  GET  /p/:url_token/preview.json
 *   - pwpush_expire  (writes)    DELETE /p/:url_token.json
 *
 * Design choices
 * --------------
 * 1. Singleton handle. The server is fully stateless from KDust's
 *    side (no chroot, no per-run secret resolution, no per-project
 *    whitelist). One McpServer + transport for the whole process,
 *    cached under a fixed key in registry.ts.
 *
 * 2. Token from the global Secret model (name `PASSWORDPUSHER_TOKEN`),
 *    decrypted on EVERY tool call so a UI rotation takes effect
 *    without restarting the container. URL and email default to
 *    Ecritel's self-hosted instance; override via
 *    PASSWORDPUSHER_URL / PASSWORDPUSHER_EMAIL.
 *
 * 3. Defaults align with Ecritel hygiene: expire_after_days=7,
 *    expire_after_views=1, retrieval_step=true (mandatory because
 *    a single view + URL scanners = burned link before the human
 *    clicks).
 *
 * 4. The `payload` argument is added to the call's redact list so
 *    a chatty tool log can't leak the pushed value. The response
 *    only carries the URL token (safe to surface to the model).
 *
 * 5. NOT routed through the MCP gateway: it's a Next.js-native
 *    server using DustMcpServerTransport directly, like
 *    task-runner / skills / command-runner. This keeps the token
 *    inside the Node process (never written to the gateway's
 *    /secrets/kdust-mcp.env file).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DustMcpServerTransport } from '@dust-tt/client';
import { z } from 'zod';
import { getDustClient } from '../dust/client';
import { db } from '../db';
import { decrypt } from '../crypto';
import { errMessage } from '../errors';
import { byteLen, logMcpCall } from '../logs/mcp-calls';
import { MCP_REGISTRATION_TIMEOUT_MS } from '../constants';

type ServerWithTransport = McpServer & { __transport?: DustMcpServerTransport };

export interface PasswordPusherHandle {
  serverId: string;
  server: McpServer;
  transport: DustMcpServerTransport;
}

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://passwordpusher.ecritel.net';
const DEFAULT_EMAIL = 'admin@ecritel.net';
const TOKEN_SECRET_NAME = 'PASSWORDPUSHER_TOKEN';

const DEFAULT_EXPIRE_DAYS = 7;
const DEFAULT_EXPIRE_VIEWS = 1;
const DEFAULT_RETRIEVAL_STEP = true;

const HTTP_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.KDUST_PWPUSH_TIMEOUT_MS ?? 15_000),
);

function baseUrl(): string {
  return (process.env.PASSWORDPUSHER_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}
function email(): string {
  return process.env.PASSWORDPUSHER_EMAIL?.trim() || DEFAULT_EMAIL;
}

/** Resolve the X-User-Token from the Secret model. Throws on missing/decrypt failure. */
async function resolveToken(): Promise<string> {
  const row = await db.secret.findUnique({ where: { name: TOKEN_SECRET_NAME } });
  if (!row) {
    throw new Error(
      `Secret "${TOKEN_SECRET_NAME}" not found. Create it in /settings/secrets first.`,
    );
  }
  try {
    return decrypt(row.valueEnc);
  } catch (e) {
    throw new Error(`failed to decrypt ${TOKEN_SECRET_NAME}: ${errMessage(e)}`);
  }
}

async function pwpushFetch(
  method: 'GET' | 'POST' | 'DELETE',
  pathSuffix: string,
  body?: Record<string, string>,
): Promise<{ status: number; json: unknown; text: string }> {
  const token = await resolveToken();
  const url = `${baseUrl()}${pathSuffix}`;
  const headers: Record<string, string> = {
    'X-User-Email': email(),
    'X-User-Token': token,
    Accept: 'application/json',
  };
  let bodyStr: string | undefined;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    bodyStr = new URLSearchParams(body).toString();
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: bodyStr, signal: ac.signal });
  } catch (e) {
    throw new Error(`HTTP ${method} ${pathSuffix} failed: ${errMessage(e)}`);
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body (e.g. HTML error page from an upstream proxy).
  }
  return { status: res.status, json: parsed, text };
}

function asJson(payload: unknown, isError = false) {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

const URL_TOKEN_RE = /^[A-Za-z0-9_-]{4,64}$/;

// ---------------------------------------------------------------
// Server
// ---------------------------------------------------------------

export async function startPasswordPusherServer(): Promise<PasswordPusherHandle> {
  const dust = await getDustClient();
  if (!dust) throw new Error('Dust client not available (login required)');

  const server = new McpServer({ name: 'passwordpusher', version: '0.1.0' });

  // -------------------------------------------------------------
  // pwpush_create
  // -------------------------------------------------------------
  server.registerTool(
    'pwpush_create',
    {
      description:
        'Push a secret (password, token, snippet) to PasswordPusher ' +
        '(self-hosted at passwordpusher.ecritel.net) and return a one-shot ' +
        'retrieval URL. Defaults: expire_after_days=7, expire_after_views=1, ' +
        'retrieval_step=true (anti-scanner). The `payload` is forwarded ' +
        'verbatim and is NEVER logged back; only the secret URL token is ' +
        'returned. Prefer this over emailing or pasting credentials in chat.',
      inputSchema: {
        payload: z
          .string()
          .min(1)
          .describe('The secret value to push (password, token, snippet). Not logged.'),
        expire_after_days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe(`Days before the link self-destructs. Default ${DEFAULT_EXPIRE_DAYS}.`),
        expire_after_views: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(`Views before the link self-destructs. Default ${DEFAULT_EXPIRE_VIEWS}.`),
        passphrase: z
          .string()
          .optional()
          .describe('Optional passphrase the recipient must enter to view the secret.'),
        note: z
          .string()
          .optional()
          .describe('Optional note visible to the push creator only (audit context).'),
        retrieval_step: z
          .boolean()
          .optional()
          .describe(
            'Require a "click to retrieve" interstitial. Default true. ' +
              'Strongly recommended with expire_after_views=1 to defeat URL scanners.',
          ),
        deletable_by_viewer: z
          .boolean()
          .optional()
          .describe('Allow the recipient to delete the push after viewing.'),
      },
    },
    async (args) => {
      const toolStart = Date.now();
      // requestBytes is computed on a SHAPE-only copy (payload
      // length, not payload value) so the [mcp] log line never
      // even carries a length-proportional fingerprint of the
      // secret. Same approach for `passphrase`.
      const shape = {
        payload_len: args.payload.length,
        has_passphrase: typeof args.passphrase === 'string' && args.passphrase.length > 0,
        expire_after_days: args.expire_after_days,
        expire_after_views: args.expire_after_views,
        retrieval_step: args.retrieval_step,
        deletable_by_viewer: args.deletable_by_viewer,
      };
      const requestBytes = byteLen(shape);
      try {
        const form: Record<string, string> = {
          'password[payload]': args.payload,
          'password[expire_after_days]': String(args.expire_after_days ?? DEFAULT_EXPIRE_DAYS),
          'password[expire_after_views]': String(args.expire_after_views ?? DEFAULT_EXPIRE_VIEWS),
          'password[retrieval_step]': String(args.retrieval_step ?? DEFAULT_RETRIEVAL_STEP),
        };
        if (typeof args.passphrase === 'string' && args.passphrase.length > 0)
          form['password[passphrase]'] = args.passphrase;
        if (typeof args.note === 'string' && args.note.length > 0)
          form['password[note]'] = args.note;
        if (typeof args.deletable_by_viewer === 'boolean')
          form['password[deletable_by_viewer]'] = String(args.deletable_by_viewer);

        const { status, json } = await pwpushFetch('POST', '/p.json', form);
        if (status < 200 || status >= 300 || !json || typeof json !== 'object') {
          const payload = {
            status: 'error',
            error: `pwpush returned HTTP ${status}`,
            upstream: json ?? null,
          };
          logMcpCall({
            server: 'passwordpusher',
            tool: 'pwpush_create',
            requestBytes,
            responseBytes: byteLen(payload),
            durationMs: Date.now() - toolStart,
            success: false,
            errorCode: `http_${status}`,
          });
          return asJson(payload, true);
        }
        const j = json as Record<string, unknown>;
        const urlToken = typeof j.url_token === 'string' ? j.url_token : null;
        if (!urlToken) {
          const payload = {
            status: 'error',
            error: 'pwpush response missing url_token',
            upstream: j,
          };
          logMcpCall({
            server: 'passwordpusher',
            tool: 'pwpush_create',
            requestBytes,
            responseBytes: byteLen(payload),
            durationMs: Date.now() - toolStart,
            success: false,
            errorCode: 'malformed_response',
          });
          return asJson(payload, true);
        }
        const secretUrl = `${baseUrl()}/p/${urlToken}`;
        const result = {
          status: 'ok' as const,
          url_token: urlToken,
          secret_url: secretUrl,
          expire_after_days: j.expire_after_days ?? args.expire_after_days ?? DEFAULT_EXPIRE_DAYS,
          expire_after_views: j.expire_after_views ?? args.expire_after_views ?? DEFAULT_EXPIRE_VIEWS,
          days_remaining: j.days_remaining ?? null,
          views_remaining: j.views_remaining ?? null,
          retrieval_step: j.retrieval_step ?? args.retrieval_step ?? DEFAULT_RETRIEVAL_STEP,
          expired: j.expired ?? false,
        };
        logMcpCall({
          server: 'passwordpusher',
          tool: 'pwpush_create',
          requestBytes,
          responseBytes: byteLen(result),
          durationMs: Date.now() - toolStart,
          success: true,
          errorCode: null,
        });
        return asJson(result);
      } catch (e) {
        const text = errMessage(e);
        logMcpCall({
          server: 'passwordpusher',
          tool: 'pwpush_create',
          requestBytes,
          responseBytes: byteLen(text),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'exception',
        });
        return asJson({ status: 'error', error: text }, true);
      }
    },
  );

  // -------------------------------------------------------------
  // pwpush_preview
  // -------------------------------------------------------------
  server.registerTool(
    'pwpush_preview',
    {
      description:
        'Return the fully-qualified secret URL for an existing push, given ' +
        'its url_token. Read-only; does NOT consume a view.',
      inputSchema: {
        url_token: z.string().describe('The url_token returned by pwpush_create.'),
      },
    },
    async (args) => {
      const toolStart = Date.now();
      const requestBytes = byteLen(args);
      if (!URL_TOKEN_RE.test(args.url_token)) {
        const payload = { status: 'error', error: 'invalid url_token format' };
        logMcpCall({
          server: 'passwordpusher',
          tool: 'pwpush_preview',
          requestBytes,
          responseBytes: byteLen(payload),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'invalid_token',
        });
        return asJson(payload, true);
      }
      try {
        const { status, json } = await pwpushFetch(
          'GET',
          `/p/${encodeURIComponent(args.url_token)}/preview.json`,
        );
        if (status < 200 || status >= 300) {
          const payload = { status: 'error', error: `pwpush returned HTTP ${status}`, upstream: json };
          logMcpCall({
            server: 'passwordpusher',
            tool: 'pwpush_preview',
            requestBytes,
            responseBytes: byteLen(payload),
            durationMs: Date.now() - toolStart,
            success: false,
            errorCode: `http_${status}`,
          });
          return asJson(payload, true);
        }
        const result = { status: 'ok' as const, ...(json as object) };
        logMcpCall({
          server: 'passwordpusher',
          tool: 'pwpush_preview',
          requestBytes,
          responseBytes: byteLen(result),
          durationMs: Date.now() - toolStart,
          success: true,
          errorCode: null,
        });
        return asJson(result);
      } catch (e) {
        const text = errMessage(e);
        logMcpCall({
          server: 'passwordpusher',
          tool: 'pwpush_preview',
          requestBytes,
          responseBytes: byteLen(text),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'exception',
        });
        return asJson({ status: 'error', error: text }, true);
      }
    },
  );

  // -------------------------------------------------------------
  // pwpush_expire
  // -------------------------------------------------------------
  server.registerTool(
    'pwpush_expire',
    {
      description:
        'Expire a push BEFORE its natural expiration: deletes the payload ' +
        'and invalidates the secret URL. Idempotent: expiring an already-' +
        'expired push returns ok.',
      inputSchema: {
        url_token: z.string().describe('The url_token to expire.'),
      },
    },
    async (args) => {
      const toolStart = Date.now();
      const requestBytes = byteLen(args);
      if (!URL_TOKEN_RE.test(args.url_token)) {
        const payload = { status: 'error', error: 'invalid url_token format' };
        logMcpCall({
          server: 'passwordpusher',
          tool: 'pwpush_expire',
          requestBytes,
          responseBytes: byteLen(payload),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'invalid_token',
        });
        return asJson(payload, true);
      }
      try {
        const { status, json } = await pwpushFetch(
          'DELETE',
          `/p/${encodeURIComponent(args.url_token)}.json`,
        );
        if (status < 200 || status >= 300) {
          const payload = { status: 'error', error: `pwpush returned HTTP ${status}`, upstream: json };
          logMcpCall({
            server: 'passwordpusher',
            tool: 'pwpush_expire',
            requestBytes,
            responseBytes: byteLen(payload),
            durationMs: Date.now() - toolStart,
            success: false,
            errorCode: `http_${status}`,
          });
          return asJson(payload, true);
        }
        const result = { status: 'ok' as const, ...(json as object) };
        logMcpCall({
          server: 'passwordpusher',
          tool: 'pwpush_expire',
          requestBytes,
          responseBytes: byteLen(result),
          durationMs: Date.now() - toolStart,
          success: true,
          errorCode: null,
        });
        return asJson(result);
      } catch (e) {
        const text = errMessage(e);
        logMcpCall({
          server: 'passwordpusher',
          tool: 'pwpush_expire',
          requestBytes,
          responseBytes: byteLen(text),
          durationMs: Date.now() - toolStart,
          success: false,
          errorCode: 'exception',
        });
        return asJson({ status: 'error', error: text }, true);
      }
    },
  );

  // -------------------------------------------------------------
  // Transport wiring (same shape as task-runner / skills).
  // -------------------------------------------------------------
  const HEARTBEAT_MS = Math.max(
    60_000,
    Number(process.env.KDUST_MCP_HEARTBEAT_MS ?? 50 * 60 * 1000),
  );
  const VERBOSE = process.env.KDUST_MCP_VERBOSE !== '0';

  const ready = new Promise<string>((resolve, reject) => {
    const transport = new DustMcpServerTransport(
      dust.client,
      (id: string) => {
        console.log(`[mcp/passwordpusher] registered serverId=${id}`);
        resolve(id);
      },
      'passwordpusher',
      VERBOSE,
      HEARTBEAT_MS,
    );
    transport.onerror = (err: unknown) => {
      let msg = '';
      let status: number | undefined;
      let dustErrType: string | undefined;
      if (err instanceof Error) msg = err.message;
      else if (typeof err === 'string') msg = err;
      else if (err && typeof err === 'object') {
        const eo = err as {
          status?: number;
          message?: string;
          type?: string;
          dustError?: { type?: string; message?: string };
          cause?: { dustError?: { type?: string } };
        };
        status = typeof eo.status === 'number' ? eo.status : undefined;
        dustErrType = eo.dustError?.type ?? eo.cause?.dustError?.type;
        msg = eo.message ?? eo.dustError?.message ?? eo.type ?? '';
        try { msg = msg || JSON.stringify(err); } catch { /* circular */ }
      }
      const isAuthFailure =
        status === 401 ||
        dustErrType === 'expired_oauth_token_error' ||
        /401\s+Unauthorized/i.test(msg) ||
        /expired_oauth_token_error/i.test(msg) ||
        /access token (has )?expired/i.test(msg);
      if (isAuthFailure) {
        console.warn(
          `[mcp/passwordpusher] auth failure (status=${status ?? '?'} dustErrType=${dustErrType ?? '?'}): releasing handle`,
        );
        void (async () => {
          try {
            const { releasePasswordPusherServer } = await import('./registry');
            await releasePasswordPusherServer();
          } catch { /* ignore */ }
        })();
        return;
      }
      if (!msg || /No activity within \d+ milliseconds/i.test(msg) || /SSE connection error/i.test(msg)) {
        return;
      }
      console.warn(`[mcp/passwordpusher] transport error: ${msg}`);
    };
    (server as ServerWithTransport).__transport = transport;
    server.connect(transport).catch(reject);
    setTimeout(
      () => reject(new Error(`passwordpusher registration timed out after ${MCP_REGISTRATION_TIMEOUT_MS}ms`)),
      MCP_REGISTRATION_TIMEOUT_MS,
    );
  });

  const serverId = await ready;
  const transport = (server as ServerWithTransport).__transport as DustMcpServerTransport;
  return { serverId, server, transport };
}
