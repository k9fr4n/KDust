# Ecritel CMDB endpoint inventory (read-only)

All URLs are relative to `{si_api_url}/api/{org_id}/cmdb/`.
This skill only exposes the GET endpoints; write operations are
intentionally not implemented.

## Generic items

| Path | Purpose |
|---|---|
| `{item_type}/` | List items of a given type |
| `{item_type}/{id}/` | Get one item of a given type |
| `items/{name}/` | Get item by name |
| `items/{id}/` | Get item by id |
| `items/{item_id}/changelogs/` | Audit trail for an item |
| `items/{id}/monitoring/` | Monitoring config for an item |
| `items/notmonitored/` | All items missing monitoring |

## Servers

| Path | Purpose |
|---|---|
| `servers/` | List all servers (paginated) |
| `servers/{name}/` | Get server by FQDN/name |
| `servers/{id}/` | Get server by id |
| `servers/e2c/sync/{name}/` | E2C sync status for a server |

## Switches

| Path | Purpose |
|---|---|
| `switchs/` | List all switches (paginated) |
| `switchs/{id}/` | Get switch by id |

## NICs

| Path | Purpose |
|---|---|
| `nics/` | List NICs (paginated, supports `?item=<id>` etc.) |
| `nics/{id}/` | Get NIC by id |

## MAJAX

| Path | Purpose |
|---|---|
| `majax/` | List MAJAX records |
| `majax/{id}/` | Get MAJAX record by id |

## Puppet

| Path | Purpose |
|---|---|
| `puppet/{certname}/` | Resolve a Puppet certname to its CMDB entry |

## Notes

- DRF expects a trailing `/` on collection endpoints. The
  wrapper does not add it for you — pass the path with the
  trailing slash as listed above.
- For querystring filters (`?key=value`), use one or more
  `--query key=value` flags. They are appended in order.
- For detail endpoints, the response is a single JSON object
  (no `results`/`next` envelope) and the wrapper streams it
  to stdout unchanged.
