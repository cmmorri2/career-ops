#!/usr/bin/env python3
"""Generate a compact daily career-ops sync report."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "career-ops.sqlite"
STATE_DIR = ROOT / "data" / "cache" / "daily-sync"
LATEST_PATH = STATE_DIR / "latest-report.json"
DEFAULT_OUT_DIR = ROOT / "reports" / "daily-sync"


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        try:
            dt = datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def db_ts(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def date_label(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d")


def score_num(score: str | None) -> float:
    if not score:
        return 0.0
    match = re.search(r"(\d+(?:\.\d+)?)", score)
    return float(match.group(1)) if match else 0.0


def title_cluster(title: str | None) -> str:
    text = re.sub(r"\([^)]*\)", " ", title or "")
    text = re.sub(r"\[[^]]*\]", " ", text)
    text = re.sub(
        r"\b(senior|sr\.?|principal|staff|lead|manager|director|associate|ii|iii|iv|remote)\b",
        " ",
        text,
        flags=re.I,
    )
    text = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
    return re.sub(r"\s+", " ", text)[:80] or "unknown"


def query(con: sqlite3.Connection, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    return list(con.execute(sql, params))


def fmt_role(row: sqlite3.Row) -> str:
    score = f" ({row['score']})" if row["score"] else ""
    location = f" - {row['location']}" if row["location"] else ""
    return f"{row['company_name']} | {row['title']}{score}{location}"


def add_section(lines: list[str], heading: str, items: list[str], empty: str) -> None:
    lines.append(f"## {heading}")
    if items:
        lines.extend(f"- {item}" for item in items)
    else:
        lines.append(f"- {empty}")
    lines.append("")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", help="ISO timestamp to compare from")
    parser.add_argument("--since-hours", type=float, default=24.0)
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    args = parser.parse_args()

    started_at = parse_dt(os.environ.get("CAREER_OPS_SYNC_STARTED_AT")) or datetime.now(timezone.utc)
    since = (
        parse_dt(args.since)
        or parse_dt(os.environ.get("CAREER_OPS_SYNC_PREVIOUS_SUCCESS_AT"))
        or started_at - timedelta(hours=args.since_hours)
    )
    now = datetime.now(timezone.utc)

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row

    new_postings = query(
        con,
        """
        SELECT id, company_name, title, location, source, score, pipeline_state, created_at
        FROM job_postings
        WHERE created_at >= ?
        ORDER BY created_at DESC, id DESC
        """,
        (db_ts(since),),
    )
    expired = query(
        con,
        """
        SELECT e.event_at, e.reason, p.company_name, p.title, p.location, p.score
        FROM posting_events e
        JOIN job_postings p ON p.id = e.posting_id
        WHERE e.event_at >= ? AND e.to_pipeline_state = 'expired'
        ORDER BY e.event_at DESC
        """,
        (db_ts(since),),
    )
    linkedin_leads = query(
        con,
        """
        SELECT company, title, location, triage_score, triage_label, created_at
        FROM role_discovery_leads
        WHERE created_at >= ?
        ORDER BY created_at DESC, id DESC
        """,
        (db_ts(since),),
    )
    summary = query(
        con,
        """
        SELECT pipeline_state, COUNT(*) AS postings,
               SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
               SUM(CASE WHEN score IS NULL OR score = '' THEN 1 ELSE 0 END) AS unscored
        FROM job_postings
        GROUP BY pipeline_state
        ORDER BY pipeline_state
        """,
    )

    strong_new = sorted(new_postings, key=lambda r: score_num(r["score"]), reverse=True)[:10]
    strong_new = [fmt_role(row) for row in strong_new if score_num(row["score"]) >= 3.8]

    clusters: dict[tuple[str, str], list[sqlite3.Row]] = defaultdict(list)
    for row in new_postings:
        scan_date = (row["created_at"] or "")[:10] or date_label(now)
        clusters[(scan_date, title_cluster(row["title"]))].append(row)
    cluster_lines = []
    for (scan_date, cluster), rows in sorted(clusters.items(), key=lambda kv: (-len(kv[1]), kv[0][0], kv[0][1]))[:12]:
        examples = "; ".join(f"{r['company_name']} | {r['title']}" for r in rows[:3])
        cluster_lines.append(f"{scan_date} - {cluster}: {len(rows)} new ({examples})")

    expired_lines = [
        f"{row['company_name']} | {row['title']} - {row['reason'] or 'confirmed expired'}"
        for row in expired[:20]
    ]
    lead_lines = [
        f"{row['company']} | {row['title']}" + (f" - {row['location']}" if row["location"] else "")
        for row in linkedin_leads[:20]
    ]
    state_lines = [
        f"{row['pipeline_state']}: {row['postings']} postings, {row['expired'] or 0} expired, {row['unscored'] or 0} unscored"
        for row in summary
    ]

    lines = [
        f"# career-ops Daily Sync Report - {date_label(now)}",
        "",
        f"Window: {since.isoformat()} to {now.isoformat()}",
        "",
        "## Summary",
        f"- New postings: {len(new_postings)}",
        f"- New LinkedIn leads: {len(linkedin_leads)}",
        f"- Newly expired postings: {len(expired)}",
        f"- Strong new roles >= 3.8/5: {len(strong_new)}",
        "",
    ]
    add_section(lines, "Strong New Roles", strong_new, "No newly added roles scored 3.8/5 or higher.")
    add_section(lines, "New Title Trends", cluster_lines, "No new title clusters in this window.")
    add_section(lines, "New LinkedIn Leads", lead_lines, "No new LinkedIn leads in this window.")
    add_section(lines, "Newly Expired", expired_lines, "No confirmed expirations in this window.")
    add_section(lines, "Current Pipeline State", state_lines, "No pipeline state rows found.")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / f"{date_label(now)}-{now.strftime('%H%M%S')}.md"
    body = "\n".join(lines).rstrip() + "\n"
    report_path.write_text(body, encoding="utf-8")

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "reportPath": str(report_path),
        "generatedAt": now.isoformat(),
        "since": since.isoformat(),
        "newPostings": len(new_postings),
        "newLinkedinLeads": len(linkedin_leads),
        "newlyExpired": len(expired),
        "strongNewRoles": len(strong_new),
    }
    LATEST_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
