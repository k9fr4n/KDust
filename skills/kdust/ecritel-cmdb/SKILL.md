---
name: ecritel-cmdb
description: |
  Read-only client for the Ecritel internal CMDB API
  (https://si.ecritel.net/api/{org_id}/cmdb/...). Stdlib-only
  Python wrapper that handles DRF token auth, self-signed TLS,
  automatic pagination (results + next) and a 500 ms inter-page
  throttle. Use this skill whenever a task needs to look up a
  server, NIC, switch, CMDB item, monitoring config, changelog,
  Puppet certname mapping, MAJAX record, or any other GET
  endpoint on the SI/CMDB REST API. The API is only reachable
  from the Ecritel network — the KDust runner has the route.
whenToUse: |
  Use this skill when the user asks about anything stored in
  the Ecritel CMDB: server by name/id, its NICs, monitoring
  config, changelog, switches, Puppet certname mapping, items
  not monitored, MAJAX records, inventory listings, or any read
  of the CMDB. Prefer this skill over crafting curl by hand —
  pagination + auth + cert handling are taken care of and the
  token is never logged.
---

# Ecritel CMDB (read-only)

Thin Python wrapper around the SI/CMDB REST API. Stdlib only.
Read-only by design — POST/PUT/PATCH/DELETE are intentionally
NOT exposed by this skill. If a future task needs writes, that
goes through a separate skill with `side_effects: writes` and
an explicit confirmation gate.

## Base URL & auth

| Setting | Source | Default |
|---|---|---|
| Base URL | env `si_api_url` | `https://si.ecritel.net` |
| Token | env `si_token` (required) | — |
| `org_id` | `--org` flag | `8` (Ecritel France) |
| Auth header | injected by the wrapper | `Authorization: Token <si_token>` |
| TLS verify | hardcoded `False` (self-signed CA) | — |

The token is read from the environment and passed as a header
by the wrapper — never in argv, never echoed to logs, redacted
from exception tracebacks.

## Endpoint shape

All paths are relative and exclude the `/api/{org_id}/cmdb/`
prefix. Final URL = `{si_api_url}/api/{org_id}/cmdb/{path}`.

Pass the path with no leading slash. Examples:

| What you want | Path |
|---|---|
| List all servers | `servers/` |
| One server by name | `servers/srv-foo.ecritel.net/` |
| Server changelog | `items/<item_id>/changelogs/` |
| NICs (filter by item) | `nics/?item=<id>` |
| Item by name | `items/<name>/` |
| Items not monitored | `items/notmonitored/` |
| Puppet certname → host | `puppet/<certname>/` |
| Switches list | `switchs/` |
| Generic item type | `<item_type>/` |

See `references/endpoints.md` for the complete inventory.

## Pagination (DRF)

The CMDB uses Django REST Framework's paginated shape:

```json
{ "count": 1234, "next": "...?page=2", "previous": null, "results": [ ... ] }
```

The wrapper:

1. Walks every `next` link until exhaustion.
2. Concatenates `results` arrays.
3. Sleeps 500 ms between pages (matches the PowerShell reference).
4. Returns one JSON list to stdout.

When the response is **not** paginated (detail endpoints) the
wrapper emits the raw JSON as-is.

## Usage

```
run_skill_script(
  skill='kdust/ecritel-cmdb',
  command=['python3', 'scripts/cmdb.py', '<path>'],
)
```

Flags:

| Flag | Purpose | Default |
|---|---|---|
| `--org N` | Override `org_id` | `8` |
| `--query k=v` (repeatable) | Append a querystring param | — |
| `--max-pages N` | Hard cap on paginated walks | `200` |
| `--throttle-ms N` | Sleep between pages | `500` |
| `--timeout N` | Per-request timeout (seconds) | `30` |
| `--raw` | Don't unwrap `results` (return DRF page 1 envelope) | off |
| `--ndjson` | Emit one JSON object per line (paginated only) | off |

Stdout = JSON. Stderr = progress (`page 1`, `page 2`, …).
Exit code = 0 on success, non-zero on HTTP error.

## Examples

```bash
python3 scripts/cmdb.py 'servers/'
python3 scripts/cmdb.py 'servers/srv-foo.ecritel.net/'
python3 scripts/cmdb.py 'items/notmonitored/'
python3 scripts/cmdb.py 'nics/' --query 'item=42'
python3 scripts/cmdb.py 'items/12345/monitoring/'
python3 scripts/cmdb.py 'puppet/foo.ecritel.net/'
```

More in `references/examples.md`.

## Read-only contract

This skill exclusively performs HTTP `GET`. The wrapper
hard-codes the method. Any future write capability MUST land in
a separate skill (`ecritel-cmdb-write`) with `side_effects:
writes` and an explicit confirmation pattern — never patch
this one to relax the contract.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `ERROR: si_token env var is not set` | Token missing | Inject via KDust Secret Manager / TaskSecret |
| `HTTP 401 / 403` | Token revoked or wrong org | Rotate token; check `--org` |
| `HTTP 404` | Wrong path or missing trailing slash | DRF requires trailing `/` on collection endpoints |
| Walk stops at page N | `--max-pages` hit | Raise the cap if legitimate |
