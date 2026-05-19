#!/usr/bin/env python3
# send_mail.py — thruk-monitoring-report
#
# Sends /tmp/thruk-report/report.html as an HTML email via the
# Ecritel SMTP relay. Reads /tmp/thruk-report/meta.json to build
# a deterministic subject line.
#
# Args:
#   --to       <addr>     (repeatable) recipient. REQUIRED.
#   --from     <addr>     default: monitoring@ecritel.net
#   --subject  <str>      override the auto-built subject
#   --smtp     <host>     default: mailing.ecritel.net
#   --port     <int>      default: 25
#   --html     <path>     default: /tmp/thruk-report/report.html
#
# stdlib only.
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import smtplib
import ssl
import sys
from email.message import EmailMessage

WORKDIR = pathlib.Path(os.environ.get("THRUK_REPORT_WORKDIR", "/tmp/thruk-report"))

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--to", action="append", required=True,
                   help="recipient (repeat for multiple)")
    p.add_argument("--from", dest="sender", default="monitoring@ecritel.net")
    p.add_argument("--subject", default=None)
    p.add_argument("--smtp",    default="mailing.ecritel.net")
    p.add_argument("--port",    default=25, type=int)
    p.add_argument("--html",    default=str(WORKDIR / "report.html"))
    args = p.parse_args()

    html_path = pathlib.Path(args.html)
    if not html_path.exists():
        sys.stderr.write(f"send_mail.py: HTML file not found: {html_path}\n")
        return 2
    html_body = html_path.read_text(encoding="utf-8")

    # Build subject from meta.json unless overridden.
    if args.subject:
        subject = args.subject
    else:
        meta_path = WORKDIR / "meta.json"
        if not meta_path.exists():
            sys.stderr.write("send_mail.py: meta.json missing — pass --subject explicitly\n")
            return 2
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        scope  = meta.get("scope_label",  "—")
        period = meta.get("period_label", "—")
        today  = dt.date.today().isoformat()
        subject = f"[Monitoring {scope}] Rapport alertes {period} — {today}"

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"]    = args.sender
    msg["To"]      = ", ".join(args.to)
    msg.set_content("Rapport disponible en version HTML.")
    msg.add_alternative(html_body, subtype="html")

    try:
        with smtplib.SMTP(args.smtp, args.port, timeout=30) as s:
            s.ehlo()
            try:
                s.starttls(context=ssl.create_default_context())
                s.ehlo()
            except smtplib.SMTPException:
                # Relay may not advertise STARTTLS — fall back to plain.
                pass
            s.send_message(msg)
    except (smtplib.SMTPException, OSError) as e:
        sys.stderr.write(f"send_mail.py: SMTP failure: {e}\n")
        return 3

    print(f"OK: mail envoyé → {', '.join(args.to)} (subject: {subject!r})")
    return 0

if __name__ == "__main__":
    sys.exit(main())
