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

## Claude Code via `dust-exporter`

_Franck 2026-06-03._

The stack ships a **`dust-exporter`** sidecar — an
Anthropic/OpenAI-compatible HTTP proxy in front of your Dust agents
([k9fr4n/dust-exporter](https://github.com/k9fr4n/dust-exporter)). It
lets **Claude Code** (which speaks the Anthropic Messages API) in the
IDE terminal drive your Dust agents.

```
kdust  ──ANTHROPIC_BASE_URL──▶  dust-exporter :8787  ──OAuth──▶  Dust API
(claude / kdust-claude)            (proxy, /v1/messages)
```

- **Internal only.** `dust-exporter` is `expose`d on the compose network
  (no host `ports:`), so it is never published — same no-ingress rule as
  the rest of the stack.
- **No `docker.sock`, no `env_file`.** The image ships sane defaults
  (`0.0.0.0:8787`, file credential store on `/data`). It is started with
  `--client-tools`, so Claude Code's own Read/Edit/Bash execute **on the
  client** — which since ADR-0029 is the **`kdust` container** (where
  the IDE terminal lives). That client **has `docker.sock`**, so the
  Bash tool can run `docker`/`gh`/`glab`. Intended trade-off, not the
  old `/projects`-only sidecar.
- The `kdust` container is wired via
  `ANTHROPIC_BASE_URL=http://dust-exporter:8787` and a placeholder
  `ANTHROPIC_API_KEY=dummy` (the proxy requires no key by default), so a
  plain `claude` in the terminal works. `kdust-claude` (ADR-0027) still
  overrides these from the Secret Manager when present (Secret wins over
  inherited env).

### One-time authentication (device flow)

`dust-exporter` reuses the `dust-cli` OAuth session, persisted on the
`dust-exporter-data` volume. Log in **once** — the device-flow URL opens
on *your* machine, no browser needed inside the container:

```bash
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

> **Note.** `dust-exporter`'s repo and GHCR image are private; Watchtower
> pulls it with the host `~/.docker/config.json` credentials, like the
> `kdust` image. The image is multi-arch (amd64 + arm64), so it runs on
> the Pi.

## Configuration reference

| Var | Default | Meaning |
|-----|---------|---------|
| `IDE_ENABLED` | `true` | Master switch. On by default; `false` → proxy is a no-op, `/ide` shows a disabled notice. |
| `IDE_UPSTREAM` | `http://127.0.0.1:8080` | code-server address. In-container since ADR-0029 (loopback); leave unset. |
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
| `502 IDE upstream unavailable` | code-server not running in the `kdust` container | check `docker logs kdust` for the `[entrypoint] starting in-container code-server` line; ensure `IDE_ENABLED!=false`; `docker compose restart kdust` |
| WebSocket fails (editor won’t load) | code-server host/origin check behind proxy | confirm code-server is on `127.0.0.1:8080`; if needed pass a code-server proxy flag |
| Permission denied editing files | host `./projects` not owned by uid 1000 | `chown -R 1000:1000 ./projects` on the host |
