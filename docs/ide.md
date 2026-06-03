# In-stack code-server IDE (`/ide`)

_KDust ADR-0028, Franck 2026-06-03._

Browser VS Code ([code-server](https://github.com/coder/code-server))
embedded in KDust at **`/ide`**, scoped to the project/folder you are
currently in. Runs as a dedicated **sidecar** (`kdust-ide`) reached
**only** through an authenticated proxy inside the KDust container — no
new auth system, no host Docker access from the editor.

## Architecture

```
browser ──TLS──▶ kdust :4001 (auth-proxy, in the KDust Node process)
                    │  verify kdust_session JWT (jose, SESSION_SECRET)
                    │  HTTP + WebSocket
                    ▼
                 kdust-ide :8080  (code-server, --auth none)
                    └─ workspace = /projects   (NO docker.sock)
```

- **Single auth.** The proxy (`src/lib/ide/proxy.ts`) re-verifies the
  same `kdust_session` cookie as `src/middleware.ts`. code-server runs
  with `--auth none` because it is unreachable except through the
  proxy on the internal compose network.
- **No new ingress library.** The proxy is `node:http` + `node:net`
  (manual WS upgrade), reusing the already-present `jose`. No
  `http-proxy` dependency, no custom Next server — the standalone
  `server.js` is untouched.
- **Blast radius = `/projects`.** The sidecar has **no `docker.sock`
  mount**, so the web terminal can edit the workspace but cannot reach
  the host Docker daemon. (Contrast: running code-server in the main
  KDust container would expose host root via DooD — rejected.)
- **`/ide` is a reserved route segment** (added to
  `RESERVED_URL_NAMES` + middleware `RESERVED_SEGMENTS`) so it is not
  mistaken for a project scope and rewritten away.

## Enable it

The IDE is **on by default** — you only need the stack running. To
disable it, set `IDE_ENABLED=false` and restart KDust.

1. **`.env`** (optional)

   ```dotenv
   # IDE_ENABLED defaults to true; uncomment to turn the IDE off.
   # IDE_ENABLED=false
   #
   # Optional: only when behind a TLS reverse-proxy on a fixed host.
   # Leave empty to auto-derive <current-host>:4001 in the browser.
   IDE_PUBLIC_URL=https://kdust.example.com:4001
   ```

2. **Start the stack** (pulls the pinned code-server sidecar):

   ```bash
   docker compose up -d
   ```

3. Open **`/ide`** in KDust. It opens the workspace for your current
   scope:
   - project/folder page → `/projects/<fsPath>`
   - root → `/projects` (whole tree)

   Use **“Open in new tab ↗”** for a full-window editor.

## Configuration reference

| Var | Default | Meaning |
|-----|---------|---------|
| `IDE_ENABLED` | `true` | Master switch. On by default; `false` → proxy is a no-op, `/ide` shows a disabled notice. |
| `IDE_UPSTREAM` | `http://kdust-ide:8080` | code-server address on the compose network. |
| `IDE_PROXY_PORT` | `8443` | Port the proxy listens on inside the container (published as `4001`). |
| `IDE_PUBLIC_URL` | _(empty)_ | Browser-facing base URL. Empty → client derives `<host>:4001`. |

## Security notes

- **Keep `:4001` behind your host TLS reverse-proxy**, like `:4000`.
  The proxy enforces the `kdust_session` JWT, but TLS is still on you.
- The session cookie is `secure: false` today (`src/lib/session.ts`);
  flip it to `true` once TLS is in front (tracked separately — not in
  this change).
- `IDE_PUBLIC_URL` **must stay on the same site as KDust** so the
  `kdust_session` cookie is sent (cookies are port-agnostic but
  domain-scoped). A different subdomain would require widening the
  cookie domain — out of scope here; prefer `<kdust-host>:4001`.
- The sidecar runs as `coder` (uid 1000), matching host `./projects`
  ownership. **Do not add `docker.sock`** to `kdust-ide` — it is the
  whole point of the sidecar split.
- Kill switch: `IDE_ENABLED=false` + restart KDust, or
  `docker compose stop kdust-ide`.

## How auth flows (proxy internals)

`src/lib/ide/proxy.ts`:

1. Booted from `src/instrumentation.ts` unless `IDE_ENABLED=false`.
2. On every HTTP request **and** WS upgrade: reads `kdust_session`
   from the `Cookie` header and `jwtVerify`s it with `SESSION_SECRET`.
   - no `APP_PASSWORD` configured → open/dev mode (mirrors middleware);
   - invalid/missing → HTTP `302 /login` or the upgrade socket is
     destroyed.
3. Proxies verbatim to `IDE_UPSTREAM` (HTTP via `http.request`, WS via
   a raw `net` socket pipe).

> **[SECURITY]** The JWT check is a deliberate small copy of the
> `session.ts` / `middleware.ts` logic (cookie name, HS256,
> `SESSION_SECRET`, open-mode rule). Keep it in lockstep if the
> session scheme changes.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/ide` shows “IDE disabled” | `IDE_ENABLED=false` set | remove it (default is on), restart KDust |
| Blank iframe / 302 loop | not logged into KDust, or cookie not sent to `:4001` | log into KDust first; ensure `IDE_PUBLIC_URL` is same-host |
| `502 IDE upstream unavailable` | `kdust-ide` not running | `docker compose up -d kdust-ide` |
| WebSocket fails (editor won’t load) | code-server host/origin check behind proxy | confirm `IDE_UPSTREAM` is correct; if needed pass a code-server proxy flag |
| Permission denied editing files | host `./projects` not owned by uid 1000 | `chown -R 1000:1000 ./projects` on the host |
