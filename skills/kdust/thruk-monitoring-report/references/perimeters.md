# Ecritel monitoring perimeters

Reference list of host perimeters used by `kdust/thruk-monitoring-report`
consumers. The skill itself is scope-agnostic — these are the
conventions our Tasks rely on.

## Windows

- Hostgroup: `HG_WINDOWS`
- Custom var: `KERNEL=windows` (case-insensitive in Thruk's filter)
- Union of the two sources, deduplicated on `name`.
- Why the union: some Windows hosts are tagged via the custom
  variable only (newer inventory) and never made it into the
  legacy hostgroup; symmetrically, a few legacy Windows hosts
  predate the `KERNEL` variable. Trust both, dedup, move on.

## Linux (proposed, not yet wired)

- Hostgroup: `HG_LINUX`
- Custom var: `KERNEL=linux`

## Network gear (proposed, not yet wired)

- Hostgroup: `HG_NETWORK` (or similar — to confirm with the
  monitoring team).
- Custom var: `KERNEL=ios` / `KERNEL=junos` — likely heterogeneous.
  Probably easier to filter by hostgroup alone for this scope.

## Gotcha: do NOT use `thruk_query` with `custom_variables=...`

Thruk's REST parser silently drops a `q` parameter that filters on
`custom_variables...` when the `expose_custom_vars` config is not
set for that variable. The query returns the FULL host list with
no warning. Two safe paths:

1. Use the native `_VARNAME=value` filter (works regardless of
   `expose_custom_vars`) — this is what `thruk_list_hosts(custom_vars={...})`
   does under the hood.
2. Or explicitly add the variable to `expose_custom_vars` in
   `thruk_local.conf`. We avoid this for KERNEL because it leaks
   inventory info into views that don't need it.
