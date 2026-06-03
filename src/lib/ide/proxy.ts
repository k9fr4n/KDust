// src/lib/ide/proxy.ts
//
// Authenticated reverse proxy for the in-stack code-server IDE
// (Franck 2026-06-03, ADR-0028).
//
// Runs as a plain http.Server INSIDE the KDust Node process (booted
// from instrumentation.ts behind IDE_ENABLED), on its own port
// (IDE_PROXY_PORT, default 8443, published as 4001 by compose). It:
//
//   1. verifies the KDust `kdust_session` JWT on EVERY request and on
//      the WebSocket upgrade — same cookie + SESSION_SECRET as
//      src/middleware.ts, so no second auth system is introduced;
//   2. proxies HTTP and WS verbatim to code-server (IDE_UPSTREAM,
//      default http://127.0.0.1:8080). Since ADR-0029 (Franck
//      2026-06-03) code-server runs IN THIS container (launched by
//      docker/entrypoint.sh on loopback) instead of the ADR-0028
//      `kdust-ide` sidecar, so the web terminal inherits the full
//      agent toolchain (docker/DooD, gh, glab, kdust-claude). The
//      host-root-via-DooD surface is already accepted for this
//      container; the loopback bind keeps code-server unreachable
//      except through this JWT-gated proxy.
//
// No new npm dependency: `jose` is already used by session.ts /
// middleware.ts, and the proxy is implemented with node:http +
// node:net (no http-proxy package).
//
// [SECURITY] The JWT verification below MUST stay consistent with
// src/lib/session.ts (cookie name `kdust_session`, HS256,
// SESSION_SECRET) and the open-mode rule in src/middleware.ts (no
// APP_PASSWORD => app runs open). If either changes, update this in
// lockstep.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import { jwtVerify } from 'jose';

const COOKIE_NAME = 'kdust_session';

interface Upstream {
  host: string;
  port: number;
}

function parseUpstream(raw: string): Upstream {
  // Accepts http://host:port (path/scheme ignored — plain TCP proxy).
  const u = new URL(raw);
  return { host: u.hostname, port: Number(u.port || '80') };
}

function getCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

async function isAuthed(cookieHeader: string | undefined): Promise<boolean> {
  // Mirror middleware.ts: no APP_PASSWORD configured => open (dev) mode.
  if (!process.env.APP_PASSWORD) return true;
  const raw = process.env.SESSION_SECRET;
  if (!raw) return false;
  const token = getCookie(cookieHeader, COOKIE_NAME);
  if (!token) return false;
  try {
    await jwtVerify(token, new TextEncoder().encode(raw));
    return true;
  } catch {
    return false;
  }
}

/**
 * Boot the IDE auth-proxy. Enabled by default (ADR-0028 follow-up,
 * Franck 2026-06-03): the IDE is always active unless explicitly
 * disabled with IDE_ENABLED=false (kill switch). Best-effort and
 * idempotent-ish: any listen/setup failure is logged, never thrown —
 * a broken IDE proxy must not abort the instrumentation hook or the
 * rest of the KDust runtime.
 */
export async function bootIdeProxy(): Promise<void> {
  if (process.env.IDE_ENABLED === 'false') return;

  const upstream = parseUpstream(process.env.IDE_UPSTREAM ?? 'http://127.0.0.1:8080');
  const port = Number(process.env.IDE_PROXY_PORT ?? '8443');

  // Optional TLS termination (Franck 2026-06-03). When IDE_TLS_CERT +
  // IDE_TLS_KEY point at a readable PEM keypair, the proxy serves
  // HTTPS instead of HTTP. This is REQUIRED for code-server webviews
  // (extension READMEs, the Claude Code chat panel, settings UI…):
  // those are rendered by a service worker, which browsers refuse to
  // register outside a *secure context* (HTTPS or localhost). Reaching
  // the proxy over plain HTTP on a LAN IP (e.g. http://192.168.0.3:4001)
  // therefore yields blank webviews. With TLS the origin is secure and
  // webviews load. The upstream stays plaintext loopback — TLS is a
  // pure front-edge concern, the auth logic below is untouched.
  // When the env is unset the proxy falls back to HTTP (unchanged
  // legacy behaviour), so this is fully backward compatible.
  const certPath = process.env.IDE_TLS_CERT;
  const keyPath = process.env.IDE_TLS_KEY;
  let tlsOpts: { cert: Buffer; key: Buffer } | null = null;
  if (certPath && keyPath) {
    try {
      tlsOpts = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
    } catch (e) {
      console.error(
        `[ide-proxy] IDE_TLS_CERT/IDE_TLS_KEY set but unreadable ` +
          `(${certPath}, ${keyPath}): ${(e as Error).message} — falling back to HTTP. ` +
          `code-server webviews will stay blank over a non-localhost HTTP origin.`,
      );
      tlsOpts = null;
    }
  }

  const handleRequest: http.RequestListener = (req, res) => {
    void (async () => {
      if (!(await isAuthed(req.headers.cookie))) {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
      }
      const proxyReq = http.request(
        {
          host: upstream.host,
          port: upstream.port,
          method: req.method,
          path: req.url ?? '/',
          headers: req.headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('IDE upstream unavailable');
      });
      req.pipe(proxyReq);
    })();
  };

  const server = tlsOpts
    ? https.createServer(tlsOpts, handleRequest)
    : http.createServer(handleRequest);

  // WebSocket (and any other) upgrade: code-server is WS-heavy.
  server.on('upgrade', (req, clientSocket, head) => {
    void (async () => {
      if (!(await isAuthed(req.headers.cookie))) {
        clientSocket.destroy();
        return;
      }
      const upstreamSocket = net.connect(upstream.port, upstream.host, () => {
        // Re-emit the original request line + raw headers verbatim.
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        lines.push('', '');
        upstreamSocket.write(lines.join('\r\n'));
        if (head && head.length) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });
      upstreamSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstreamSocket.destroy());
    })();
  });

  server.on('error', (e) => {
    console.error(`[ide-proxy] server error: ${(e as Error).message}`);
  });

  server.listen(port, () => {
    console.log(
      `[ide-proxy] listening on ${tlsOpts ? 'https' : 'http'}://0.0.0.0:${port} -> ` +
        `http://${upstream.host}:${upstream.port} ` +
        `(ADR-0028; tls=${tlsOpts ? 'on' : 'off'}; ` +
        `auth=${process.env.APP_PASSWORD ? 'kdust_session JWT' : 'open/dev'})`,
    );
  });
}
