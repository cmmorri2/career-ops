#!/usr/bin/env python3
"""Send the latest generated career-ops daily sync report over SMTP."""

from __future__ import annotations

import argparse
import json
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LATEST_PATH = ROOT / "data" / "cache" / "daily-sync" / "latest-report.json"


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def require(name: str, value: str | None) -> str:
    if not value:
        raise SystemExit(f"Missing required SMTP config: {name}")
    return value


def profile_email() -> str:
    path = ROOT / "config" / "profile.yml"
    if not path.exists():
        return ""
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("email:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
    return ""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", help="Report markdown path. Defaults to latest generated report.")
    parser.add_argument("--to", help="Recipient email. Defaults to CAREER_OPS_REPORT_EMAIL_TO, SMTP_TO, TRIAGE_EMAIL_TO, candidate email, or SMTP user.")
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")

    if args.path:
        report_path = Path(args.path)
    else:
        if not LATEST_PATH.exists():
            raise SystemExit(f"No latest report manifest found: {LATEST_PATH}")
        report_path = Path(json.loads(LATEST_PATH.read_text(encoding="utf-8"))["reportPath"])
    if not report_path.is_absolute():
        report_path = ROOT / report_path
    body = report_path.read_text(encoding="utf-8")

    host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    port = int(os.environ.get("SMTP_PORT", "465"))
    secure = env_bool("SMTP_SECURE", True)
    user = require(
        "SMTP_USER or TRIAGE_EMAIL_IMAP_USER or LINKEDIN_EMAIL_IMAP_USER",
        os.environ.get("SMTP_USER")
        or os.environ.get("TRIAGE_EMAIL_IMAP_USER")
        or os.environ.get("LINKEDIN_EMAIL_IMAP_USER"),
    )
    password = require(
        "SMTP_PASSWORD or TRIAGE_EMAIL_IMAP_PASSWORD or LINKEDIN_EMAIL_IMAP_PASSWORD",
        os.environ.get("SMTP_PASSWORD")
        or os.environ.get("TRIAGE_EMAIL_IMAP_PASSWORD")
        or os.environ.get("LINKEDIN_EMAIL_IMAP_PASSWORD"),
    )
    from_addr = os.environ.get("SMTP_FROM") or user
    to_addr = args.to or os.environ.get("CAREER_OPS_REPORT_EMAIL_TO") or os.environ.get("SMTP_TO") or os.environ.get("TRIAGE_EMAIL_TO") or profile_email() or user

    subject_date = report_path.stem
    msg = EmailMessage()
    msg["Subject"] = f"career-ops daily sync report {subject_date}"
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Date"] = formatdate(localtime=True)
    msg.set_content(body)

    context = ssl.create_default_context()
    if secure:
        smtp = smtplib.SMTP_SSL(host, port, context=context, timeout=30)
    else:
        smtp = smtplib.SMTP(host, port, timeout=30)
        smtp.ehlo()
        smtp.starttls(context=context)

    with smtp:
        smtp.login(user, password)
        smtp.send_message(msg)

    print(f"sent {report_path} to {to_addr}")


if __name__ == "__main__":
    main()
