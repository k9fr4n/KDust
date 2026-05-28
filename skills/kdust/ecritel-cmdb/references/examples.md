# Ecritel CMDB — usage examples

All examples assume `si_token` (and optionally `si_api_url`)
are exported. The runner has the route to `si.ecritel.net`.

## Sanity check

List every server (paginated, throttled at 500 ms):

```
python3 scripts/cmdb.py 'servers/'
```

List every server but keep DRF metadata:

```
python3 scripts/cmdb.py 'servers/' --raw
```

Stream as NDJSON (one record per line — friendly for `jq`):

```
python3 scripts/cmdb.py 'servers/' --ndjson | jq -r '.name'
```

## Looking up one thing

```
python3 scripts/cmdb.py 'servers/srv-foo.ecritel.net/'
python3 scripts/cmdb.py 'servers/12345/'
python3 scripts/cmdb.py 'items/srv-foo.ecritel.net/'
python3 scripts/cmdb.py 'puppet/srv-foo.ecritel.net/'
```

## Filtering with querystrings

NICs belonging to a specific item:

```
python3 scripts/cmdb.py 'nics/' --query 'item=42'
```

Combine filters:

```
python3 scripts/cmdb.py 'nics/' \
  --query 'item=42' \
  --query 'ordering=-id'
```

## Audit / monitoring

Changelog of an item:

```
python3 scripts/cmdb.py 'items/12345/changelogs/'
```

Monitoring config of an item:

```
python3 scripts/cmdb.py 'items/12345/monitoring/'
```

Everything that is missing monitoring (paginated walk):

```
python3 scripts/cmdb.py 'items/notmonitored/'
```

## Another org

Override the default `org_id=8`:

```
python3 scripts/cmdb.py 'servers/' --org 12
```

## Caps and throttling

Larger pagination cap when you legitimately need it:

```
python3 scripts/cmdb.py 'items/notmonitored/' --max-pages 500
```

Tighter throttle (be polite with the SI):

```
python3 scripts/cmdb.py 'servers/' --throttle-ms 1000
```

## Piping into another skill

The wrapper emits plain JSON on stdout, so you can pipe it:

```
python3 scripts/cmdb.py 'servers/' \
  | jq -r '.[] | select(.os == "linux") | .name' \
  > /tmp/linux-hosts.txt
```

## Common pitfalls

- **Missing trailing slash** — DRF answers 404. Always end
  collection paths with `/`.
- **Token wrong / revoked** — HTTP 401 / 403. Rotate the
  secret in KDust's Secret Manager, do not edit env files by
  hand.
- **Walking forever** — if a request loops, bump
  `--max-pages` only if you understand why the dataset is
  that large; otherwise check that `next` is being returned
  with a sane URL.
