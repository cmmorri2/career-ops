#!/usr/bin/env python3
"""Send a generated career-ops triage batch over SMTP."""

from __future__ import annotations

import argparse
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate
from pathlib import Path


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def require(name: str, value: str | None) -> str:
    if not value:
        raise SystemExit(f"Missing required SMTP config: {name}")
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", help="Path to the triage batch text file")
    args = parser.parse_args()

    load_dotenv(Path(".env"))

    batch_path = Path(args.path)
    body = batch_path.read_text(encoding="utf-8")
    batch_id = batch_path.stem

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
    to_addr = os.environ.get("SMTP_TO") or os.environ.get("TRIAGE_EMAIL_TO") or user

    msg = EmailMessage()
    msg["Subject"] = f"career-ops triage batch {batch_id}"
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

    print(f"sent {batch_id} to {to_addr}")


if __name__ == "__main__":
    main()
