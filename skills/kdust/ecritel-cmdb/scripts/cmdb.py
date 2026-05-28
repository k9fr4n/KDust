#!/usr/bin/env python3
"""
Ecritel SI/CMDB read-only client.

Stdlib-only. DRF token auth + auto-pagination + self-signed TLS.

Env:
  si_token    (required)  API token — sent as `Authorization: Token <...>`.
  si_api_url  (optional)  Base URL, default https://si.ecritel.net

Usage:
  python3 cmdb.py <path> [--org N] [--query k=v]... [--raw] [--ndjson]
                          [--max-pages N] [--throttle-ms N] [--timeout N]

The path is appended to `{si_api_url}/api/{org_id}/cmdb/`.
The wrapper exclusively performs HTTP GET.

The token is read from the environment and passed via the
Authorization header. It is never written to argv, stdout,
stderr, or any exception traceback (redaction is enforced).
"""
from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE_URL = "https://si.ecritel.net"
DEFAULT_ORG = 8


def _redact(text: str, token: str) -> str:
    if not token:
        return text
    return text.replace(token, "<REDACTED>")


def _build_url(base_url: str, org_id: int, path: str, extra_query: list[str]) -> str:
    # Strip leading slash to keep the join behavior predictable.
    path = path.lstrip("/")
    url = f"{base_url.rstrip('/')}/api/{org_id}/cmdb/{path}"
    if extra_query:
        sep = "&" if ("?" in url) else "?"
        url = url + sep + "&".join(extra_query)
    return url


def _fetch(url: str, token: str, timeout: int, ctx: ssl.SSLContext) -> dict | list:
    req = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Authorization": f"Token {token}",
            "Accept": "application/json",
            "User-Agent": "kdust-ecritel-cmdb/1.0 (+stdlib)",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read()
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        prog="cmdb.py",
        description="Ecritel SI/CMDB read-only client (DRF, paginated).",
    )
    ap.add_argument("path", help="Path under /api/{org_id}/cmdb/, e.g. 'servers/'.")
    ap.add_argument("--org", type=int, default=DEFAULT_ORG, help=f"Org id (default {DEFAULT_ORG}).")
    ap.add_argument("--query", action="append", default=[], metavar="k=v", help="Repeatable.")
    ap.add_argument("--max-pages", type=int, default=200)
    ap.add_argument("--throttle-ms", type=int, default=500)
    ap.add_argument("--timeout", type=int, default=30)
    ap.add_argument("--raw", action="store_true", help="Return DRF page-1 envelope as-is.")
    ap.add_argument("--ndjson", action="store_true", help="NDJSON output (paginated only).")
    args = ap.parse_args(argv)

    token = os.environ.get("si_token") or os.environ.get("SI_TOKEN")
    if not token:
        print("ERROR: si_token env var is not set", file=sys.stderr)
        return 2
    base_url = os.environ.get("si_api_url") or os.environ.get("SI_API_URL") or DEFAULT_BASE_URL

    # Self-signed CA — PowerShell uses -SkipCertificateCheck, we do the same.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    first_url = _build_url(base_url, args.org, args.path, args.query)
    next_url: str | None = first_url
    page = 0
    all_results: list = []
    paginated_envelope_seen = False
    single_payload: dict | list | None = None

    try:
        while next_url:
            page += 1
            if page > args.max_pages:
                print(f"WARN: hit --max-pages={args.max_pages}, stopping walk", file=sys.stderr)
                break
            print(f"page {page}: GET {next_url}", file=sys.stderr)
            payload = _fetch(next_url, token, args.timeout, ctx)

            if isinstance(payload, dict) and "results" in payload and isinstance(payload["results"], list):
                paginated_envelope_seen = True
                if args.raw:
                    single_payload = payload
                    break
                all_results.extend(payload["results"])
                nxt = payload.get("next")
                next_url = nxt if isinstance(nxt, str) and nxt else None
            else:
                # Detail endpoint or non-DRF shape — emit raw and stop.
                single_payload = payload
                break

            if next_url and args.throttle_ms > 0:
                time.sleep(args.throttle_ms / 1000.0)
    except urllib.error.HTTPError as e:
        msg = _redact(f"HTTP {e.code} on {e.url}: {e.reason}", token)
        print(msg, file=sys.stderr)
        try:
            body = e.read().decode("utf-8", errors="replace")
            print(_redact(body, token), file=sys.stderr)
        except Exception:
            pass
        return 1
    except urllib.error.URLError as e:
        print(_redact(f"URLError: {e.reason}", token), file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001
        # Redacted traceback — token must never escape.
        tb = _redact(traceback.format_exc(), token)
        print(tb, file=sys.stderr)
        return 1

    if paginated_envelope_seen and not args.raw:
        if args.ndjson:
            for row in all_results:
                sys.stdout.write(json.dumps(row, ensure_ascii=False) + "\n")
        else:
            json.dump(all_results, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        print(f"OK: {len(all_results)} record(s) across {page} page(s)", file=sys.stderr)
    else:
        json.dump(single_payload, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        print("OK: single payload (non-paginated)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
