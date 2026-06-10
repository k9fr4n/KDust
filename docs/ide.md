# In-stack code-server IDE (`/ide`)

_KDust ADR-0028 (sidecar) → **ADR-0029 (in-container)**, Franck 2026-06-03._

Browser VS Code ([code-server](https://github.com/coder/code-server))
embedded in KDust at **`/ide`**, scoped to the project/folder you are
currently in. Since **ADR-0029** code-server runs **inside the `kdust`
container itself** (not the old `kdust-ide` sidecar), reached **only**
through an authenticated proxy in the KDust Node process — no new auth
system. The terminal therefore inherits the **full agent toolchain**:
`docker` (DooD), `gh`, `glab`, `kdust-claude`, `rg`, `jq`, `yq`, `ruff`.

> **Why the change?** The ADR-0028 sidecar deliberately had **no
> `docker.sock`** (blast radius `/projects`). In practice a web IDE
> that cannot run `docker`/`gh`/`glab`/`kdust-claude` was useless for
> real dev — _« sinon ça n'a pas trop d'intérêt »_. The `kdust`
> container already mounts `docker.sock` and accepts the
> host-root-via-DooD surface (agents already execute code there), so
> moving code-server in-container adds **no new risk class**.

## Architecture

```
browser ──TLS──▶ kdust :4001 (auth-proxy, in the KDust Node process)
                    │  verify kdust_session JWT (jose, SESSION_SECRET)
                    │  HTTP + WebSocket
                    ▼
                 127.0.0.1:8080  (code-server, --auth none)
                    └─ same container as KDust  →  /projects
                       + docker.sock, gh, glab, kdust-claude, rg …
```

- **Single auth.** The proxy (`src/lib/ide/proxy.ts`) re-verifies the
  same `kdust_session` cookie as `src/middleware.ts`. code-server runs
  with `--auth none` because it binds to **loopback only**
  (`127.0.0.1:8080`) and is unreachable except through the proxy.
- **No new ingress library.** The proxy is `node:http` + `node:net`
  (manual WS upgrade), reusing the already-present `jose`. No
  `http-proxy` dependency, no custom Next server — the standalone
  `server.js` is untouched.
- **Blast radius = the `kdust` container (incl. `docker.sock` = host
  root via DooD).** This is the intended trade-off: the IDE terminal
  has the **same** surface as the scheduler/agent runtime. It is **not**
  the old `/projects`-only sidecar. Keep `:4001` behind TLS + the
  `kdust_session` JWT, and trust only operators you would trust with
  the agent runtime itself.
- **Launched by `docker/entrypoint.sh`** as the `node` user (uid 1000)
  before the final `exec`, backgrounded so it reparents to `tini`
  (PID 1). Persistence (settings/extensions) lives on the existing
  `./data` bind at `/data/ide` — no extra named volume.
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

2. **Start the stack** (code-server ships inside the `kdust` image since
   ADR-0029 — no separate sidecar to pull):

   ```bash
   docker compose up -d
   ```

3. Use the **“Open in IDE ↗”** item in the scope (⋮) menu. Since
   Franck 2026-06-03 it opens the `:4001` proxy **directly in a new
   tab** (no in-app iframe), scoped to your current location:
   - project/folder page → `/projects/<fsPath>`
   - root → `/projects` (whole tree)

   The in-app `/ide` page (embedded `<IdeFrame>`) still exists and is
   reachable by URL; it also offers an **“Open in new tab ↗”** link for
   a full-window editor.

## Claude Code via a shared `dust-exporter`

_Franck 2026-06-03, updated 2026-06-10 (ADR-0033: exporter externalised)._

**Claude Code** speaks the Anthropic Messages API; to drive your Dust
agents from the IDE terminal it talks to a **`dust-exporter`** — an
Anthropic/OpenAI-compatible HTTP proxy in front of Dust
([k9fr4n/dust-exporter](https://github.com/k9fr4n/dust-exporter)).

Since **ADR-0033** the exporter is **no longer an in-stack sidecar**: it
runs as a **shared (mutualised)** instance on the LAN, reachable by
default at `http://192.168.0.3:8787`. One exporter can serve several
KDust hosts.

```
kdust  ──ANTHROPIC_BASE_URL──▶  dust-exporter :8787  ──OAuth──▶  Dust API
(claude / kdust-claude)      (shared, http://192.168.0.3:8787)
```

- **Shared / external.** The proxy is not defined in this
  `docker-compose.yml` any more. Point at it with
  `ANTHROPIC_BASE_URL` (default `http://192.168.0.3:8787`; override in
  `.env`). Run/operate it wherever it is hosted — see the
  `dust-exporter` repo for its own compose/login.
- **`--client-tools`.** When the shared exporter is started with
  `--client-tools`, Claude Code's own Read/Edit/Bash execute **on the
  client** — the **`kdust` container** (where the IDE terminal lives).
  That client **has `docker.sock`**, so the Bash tool can run
  `docker`/`gh`/`glab`. Intended trade-off, not a `/projects`-only
  sandbox.
- The `kdust` container is wired via
  `ANTHROPIC_BASE_URL=http://192.168.0.3:8787` and a placeholder
  `ANTHROPIC_API_KEY=dummy` (the proxy requires no key by default), so a
  plain `claude` in the terminal works. `kdust-claude` (ADR-0027) still
  overrides these from the Secret Manager when present (Secret wins over
  inherited env).

### One-time authentication (device flow)

The shared `dust-exporter` reuses a `dust-cli` OAuth session, persisted
on **its own** host (not in this stack). Authenticate **once** on the
host that runs the exporter — the device-flow URL opens on *your*
machine, no browser needed inside the container:

```bash
# on the host running the shared dust-exporter
docker compose run --rm dust-exporter login
docker compose run --rm dust-exporter status   # authenticated: true
docker compose up -d                            # (re)start the proxy
```

### Use it from the IDE terminal

Pick the agent at runtime with its sId (list them with
`GET /v1/models`, or the Dust UI):

```bash
# inside the /ide terminal
ANTHROPIC_MODEL=<agent-sId> \
ANTHROPIC_SMALL_FAST_MODEL=<agent-sId> \
claude
```

`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` are already injected into the
`kdust` container, so you only set the model(s). (Or just run
`kdust-claude`, which also resolves `ANTHROPIC_*` from the Secret
Manager — ADR-0027.)

> **Note.** Since ADR-0033 the `dust-exporter` is **not** part of this
> stack, so this `docker-compose.yml`'s Watchtower no longer pulls it.
> The shared exporter is operated (and updated) on its own host. Its
> repo and GHCR image are private and multi-arch (amd64 + arm64), so it
> can run on the Pi or any LAN host.

## Configuration reference

| Var | Default | Meaning |
|-----|---------|---------|
| `IDE_ENABLED` | `true` | Master switch. On by default; `false` → proxy is a no-op, `/ide` shows a disabled notice. |
| `IDE_UPSTREAM` | `http://127.0.0.1:8080` | code-server address. In-container since ADR-0029 (loopback); leave unset. |
| `IDE_PROXY_PORT` | `8443` | Port the proxy listens on inside the container (published as `4001`). |
| `IDE_PUBLIC_URL` | _(empty)_ | Browser-facing base URL. Empty → client derives `<host>:4001`. Set to `https://<host>:4001` when TLS is on. |
| `IDE_TLS_CERT` | _(empty)_ | PEM cert path (under `/data`). With `IDE_TLS_KEY`, the proxy serves **HTTPS**. Empty → HTTP. |
| `IDE_TLS_KEY` | _(empty)_ | PEM private-key path. Required alongside `IDE_TLS_CERT`. |

## TLS / secure context (required for webviews)

_Franck 2026-06-03._

code-server renders several panes as **webviews**: the **Claude Code
chat panel**, extension READMEs (the `FEATURES`/`DETAILS` body), the
settings UI, etc. Webviews are backed by a **service worker**, and
browsers only register service workers in a **secure context** —
**HTTPS** or **`localhost`/`127.0.0.1`**. Reaching the proxy over plain
HTTP on a LAN IP (e.g. `http://192.168.0.3:4001`) leaves those webviews
**blank** while the editor, terminal and extension list still work.

Two ways to get a secure context:

- **SSH tunnel** (quick, no config): `ssh -L 4001:127.0.0.1:4001 you@host`,
  then open `http://localhost:4001` — `localhost` is a secure context.
- **TLS on the proxy** (recommended for multi-machine LAN use): the
  proxy terminates TLS itself when `IDE_TLS_CERT` + `IDE_TLS_KEY` are
  set (no extra reverse-proxy needed).

  ```bash
  # one-time, on the host (writes ./data/ide-tls/{cert,key}.pem):
  ./scripts/gen-ide-cert.sh 192.168.0.3
  ```

  Then in `.env`:

  ```dotenv
  IDE_TLS_CERT=/data/ide-tls/cert.pem
  IDE_TLS_KEY=/data/ide-tls/key.pem
  IDE_PUBLIC_URL=https://192.168.0.3:4001
  ```

  ```bash
  docker compose restart kdust
  ```

  The cert is **self-signed**: accept the one-time browser warning;
  after that the origin is secure and the webviews render. For a
  CA-trusted cert, drop your own `cert.pem`/`key.pem` into
  `./data/ide-tls/` and skip the helper. The cert dir lives on the
  existing `./data` bind mount — no new volume. The upstream stays
  plaintext loopback; TLS is purely the front edge, the proxy's
  `kdust_session` JWT check is unchanged.

### App TLS via Caddy (ADR-0030)

_Franck 2026-06-03._ The IDE (`:4001`) terminates TLS in-process
(`IDE_TLS_*`). The **Next.js app (`:4000`)** can't do TLS natively, so a
**Caddy** reverse-proxy fronts it with the **same** cert. Both then live
under `https://kdust.ecritel.net` (`:4000` app, `:4001` IDE; the
`kdust_session` cookie is host-scoped so it spans both ports).

Deploy on the host (in the deployment dir, e.g. `/home/kfr/docker/KDust`):

```bash
# 1) cert already in ./data/tls/ecritel/{fullchain.pem,privkey.pem}
# 2) sync the repo's caddy/Caddyfile + docker-compose.yml here
# 3) recreate the stack (adds the `caddy` service, app -> expose)
docker compose up -d
# 4) verify
docker compose ps caddy
docker logs kdust-caddy --tail 20    # no cert/listen errors
```

`kdust.ecritel.net` must resolve to the host on every client (internal
DNS or `/etc/hosts`). The app is **no longer served in clear on `:4000`**
— only via Caddy/TLS. Cert renewal: drop fresh PEMs in
`./data/tls/ecritel` and `docker compose restart caddy` (and `kdust` for
the IDE side).

## Security notes

- **TLS** can now be terminated **by the proxy itself** (`IDE_TLS_*`,
  see above) — required for webviews on a non-localhost origin. You may
  still front `:4001` with your own TLS reverse-proxy instead; in that
  case leave `IDE_TLS_*` empty and point `IDE_PUBLIC_URL` at it.
- The session cookie is `secure: false` today (`src/lib/session.ts`);
  flip it to `true` once TLS is in front (tracked separately — not in
  this change).
- `IDE_PUBLIC_URL` **must stay on the same site as KDust** so the
  `kdust_session` cookie is sent (cookies are port-agnostic but
  domain-scoped). A different subdomain would require widening the
  cookie domain — out of scope here; prefer `<kdust-host>:4001`.
- code-server runs as `node` (uid 1000) inside the `kdust` container,
  matching host `./projects` ownership. **It shares the container's
  `docker.sock` (= host root via DooD).** This is the deliberate
  ADR-0029 trade-off — the IDE terminal has the same surface as the
  agent runtime. Treat `/ide` access as equivalent to handing out the
  KDust runtime: gate it with the `kdust_session` JWT + TLS, and only
  expose it to operators you already trust with the stack.
- Kill switch: `IDE_ENABLED=false` + restart KDust (code-server is not
  launched and the proxy is a no-op).

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
| **Webviews blank** (Claude Code chat panel, extension README, settings UI) while editor/terminal/extension-list work | reaching the proxy over plain **HTTP on a non-localhost origin** → browser refuses to register the webview **service worker** (no secure context) | terminate TLS on the proxy (`./scripts/gen-ide-cert.sh <host>` + `IDE_TLS_CERT`/`IDE_TLS_KEY` + `IDE_PUBLIC_URL=https://<host>:4001`, restart), or tunnel via `localhost`. See _TLS / secure context_ above. |
| `502 IDE upstream unavailable` | code-server not running in the `kdust` container | check `docker logs kdust` for the `[entrypoint] starting in-container code-server` line; ensure `IDE_ENABLED!=false`; `docker compose restart kdust` |
| `502 IDE upstream unavailable`, code-server logs stop right after `Using user-data-dir` with `listen EADDRINUSE … 127.0.0.1:3000` | code-server inherits the container's `PORT=3000` (Next.js), which **takes precedence over `--bind-addr`**, so it tries to bind `:3000` and dies | fixed in `docker/entrypoint.sh` by launching code-server under `env -u PORT -u HOST` (Franck 2026-06-03). On an old image, rebuild: `docker compose up -d --build` |
| WebSocket fails (editor won’t load) | code-server host/origin check behind proxy | confirm code-server is on `127.0.0.1:8080`; if needed pass a code-server proxy flag |
| Permission denied editing files | host `./projects` not owned by uid 1000 | `chown -R 1000:1000 ./projects` on the host |
