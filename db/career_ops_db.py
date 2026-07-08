#!/usr/bin/env python3
"""SQLite import/export helpers for the career-ops sourcing funnel."""

from __future__ import annotations

import argparse
import csv
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "career-ops.sqlite"
SCAN_HISTORY = ROOT / "data" / "scan-history.tsv"
PIPELINE = ROOT / "data" / "pipeline.md"
APPLICATIONS = ROOT / "data" / "applications.md"


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  normalized_name TEXT NOT NULL UNIQUE,
  source_name TEXT,
  priority TEXT CHECK(priority IN ('high', 'medium', 'lower', 'unknown')) DEFAULT 'unknown',
  source_category TEXT,
  careers_url TEXT,
  workday_url TEXT,
  workday_vetted_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_vetting (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  search_query TEXT,
  discovered_url TEXT,
  status TEXT NOT NULL DEFAULT 'needs_vetting',
  vetted_at TEXT,
  notes TEXT,
  UNIQUE(company_id, source_type, search_query)
);

CREATE TABLE IF NOT EXISTS search_runs (
  id INTEGER PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,
  search_query TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'started',
  result_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS job_postings (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  company_name TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT,
  source TEXT,
  first_seen TEXT,
  last_seen TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  pipeline_state TEXT NOT NULL DEFAULT 'pending',
  score TEXT,
  report_path TEXT,
  pdf_path TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  compensation TEXT,
  deep_fit_score REAL,
  deep_stretch_score REAL,
  deep_interest_score REAL,
  application_priority TEXT,
  deep_review_path TEXT,
  deep_reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_postings_company ON job_postings(company_id);
CREATE INDEX IF NOT EXISTS idx_job_postings_status ON job_postings(status);
CREATE INDEX IF NOT EXISTS idx_job_postings_pipeline_state ON job_postings(pipeline_state);
CREATE INDEX IF NOT EXISTS idx_job_postings_last_seen ON job_postings(last_seen);

CREATE TABLE IF NOT EXISTS posting_snapshots (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  title TEXT,
  location TEXT,
  description TEXT,
  raw_source TEXT
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER REFERENCES job_postings(id) ON DELETE SET NULL,
  tracker_num INTEGER UNIQUE,
  date TEXT,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  score TEXT,
  status TEXT NOT NULL,
  pdf TEXT,
  report TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS application_events (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  event_at TEXT NOT NULL,
  status TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  posting_id INTEGER REFERENCES job_postings(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(application_id, posting_id, artifact_type, path)
);
"""


@dataclass
class PipelineEntry:
    done: bool
    url: str
    company: str
    title: str
    location: str | None = None
    compensation: str | None = None
    score: str | None = None
    note: str | None = None


def connect(db_path: Path = DEFAULT_DB) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def ensure_column(con: sqlite3.Connection, table: str, column: str, declaration: str) -> None:
    columns = {str(row["name"]) for row in con.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")


def init_db(con: sqlite3.Connection) -> None:
    con.executescript(SCHEMA)
    for column, declaration in [
        ("compensation", "TEXT"),
        ("deep_fit_score", "REAL"),
        ("deep_stretch_score", "REAL"),
        ("deep_interest_score", "REAL"),
        ("application_priority", "TEXT"),
        ("deep_review_path", "TEXT"),
        ("deep_reviewed_at", "TEXT"),
    ]:
        ensure_column(con, "job_postings", column, declaration)
    con.commit()


def normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def upsert_company(con: sqlite3.Connection, name: str) -> int:
    display = name.strip() or "Unknown"
    normalized = normalize_name(display)
    existing = con.execute(
        "SELECT id FROM companies WHERE normalized_name = ? OR lower(name) = lower(?) ORDER BY id LIMIT 1",
        (normalized, display),
    ).fetchone()
    if existing:
        con.execute(
            """
            UPDATE companies
            SET name = ?, normalized_name = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (display, normalized, int(existing["id"])),
        )
        return int(existing["id"])
    con.execute(
        """
        INSERT INTO companies(name, normalized_name)
        VALUES (?, ?)
        ON CONFLICT(normalized_name) DO UPDATE SET
          name=excluded.name,
          updated_at=CURRENT_TIMESTAMP
        """,
        (display, normalized),
    )
    row = con.execute("SELECT id FROM companies WHERE normalized_name = ?", (normalized,)).fetchone()
    return int(row["id"])


def scan_status_to_posting_status(status: str) -> str:
    if status.startswith("skipped_expired"):
        return "expired"
    if status.startswith("skipped"):
        return "invalid"
    return "active"


def clean_cell(value: object) -> str:
    return str(value or "").replace("|", ";").replace("\n", " ").strip()


def import_scan_history(con: sqlite3.Connection) -> int:
    if not SCAN_HISTORY.exists():
        return 0
    count = 0
    with SCAN_HISTORY.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            url = (row.get("url") or "").strip()
            company = (row.get("company") or "").strip()
            title = (row.get("title") or "").strip()
            if not url or not company or not title:
                continue
            company_id = upsert_company(con, company)
            first_seen = (row.get("first_seen") or "").strip()
            status = scan_status_to_posting_status((row.get("status") or "").strip())
            con.execute(
                """
                INSERT INTO job_postings(url, company_id, company_name, title, location, compensation, source, first_seen, last_seen, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url) DO UPDATE SET
                  company_id=excluded.company_id,
                  company_name=excluded.company_name,
                  title=excluded.title,
                  location=COALESCE(NULLIF(excluded.location, ''), job_postings.location),
                  compensation=COALESCE(NULLIF(excluded.compensation, ''), job_postings.compensation),
                  source=COALESCE(NULLIF(excluded.source, ''), job_postings.source),
                  first_seen=COALESCE(job_postings.first_seen, excluded.first_seen),
                  last_seen=COALESCE(excluded.last_seen, job_postings.last_seen),
                  status=excluded.status,
                  updated_at=CURRENT_TIMESTAMP
                """,
                (
                    url,
                    company_id,
                    company,
                    title,
                    clean_cell(row.get("location")),
                    clean_cell(row.get("compensation") or row.get("salary")),
                    (row.get("portal") or "").strip(),
                    first_seen,
                    first_seen,
                    status,
                ),
            )
            count += 1
    return count


def parse_pipeline_line(line: str) -> PipelineEntry | None:
    match = re.match(r"- \[([ xX])\]\s+(.*)$", line.strip())
    if not match:
        return None
    done = match.group(1).lower() == "x"
    parts = [p.strip() for p in match.group(2).split("|")]
    if len(parts) < 3:
        return None

    url_index = 0
    if parts[0].startswith("#") and len(parts) >= 4:
        url_index = 1
    url = parts[url_index]
    company = parts[url_index + 1] if len(parts) > url_index + 1 else ""
    title = parts[url_index + 2] if len(parts) > url_index + 2 else ""
    tail = parts[url_index + 3 :]
    location = None
    compensation = None
    score = None
    note_parts: list[str] = []
    for part in tail:
        if re.match(r"^(?:Triage\s+)?\d+(?:\.\d+)?/5$", part, re.I):
            score = part
        elif part.startswith("Triage -") or part.startswith("Deep fit ") or part.startswith("review:") or part.startswith("review "):
            note_parts.append(part)
        elif part.startswith("Location:"):
            location = part.removeprefix("Location:").strip()
        elif part.startswith("Salary:"):
            compensation = part.removeprefix("Salary:").strip()
        elif not location and not part.startswith("PDF ") and not part.startswith("["):
            location = part
        elif not compensation:
            compensation = part
        else:
            note_parts.append(part)
    return PipelineEntry(done, url, company, title, location, compensation, score, " | ".join(note_parts) or None)


def import_pipeline(con: sqlite3.Connection) -> int:
    if not PIPELINE.exists():
        return 0
    section = "pending"
    count = 0
    for line in PIPELINE.read_text(encoding="utf-8").splitlines():
        heading = line.strip().lower()
        if heading.startswith("## "):
            if "discard" in heading:
                section = "discarded"
            elif "expir" in heading or "removed" in heading or "closed" in heading:
                section = "expired"
            elif "shortlist" in heading or "interest" in heading:
                section = "shortlisted"
            elif "process" in heading or "evaluated" in heading:
                section = "processed"
            else:
                section = "pending"
            continue
        entry = parse_pipeline_line(line)
        if not entry:
            continue
        pipeline_state = "processed" if entry.done else section
        if section in {"discarded", "expired"}:
            pipeline_state = section
        company_id = upsert_company(con, entry.company)
        con.execute(
            """
            INSERT INTO job_postings(url, company_id, company_name, title, location, compensation, pipeline_state, score, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
              company_id=excluded.company_id,
              company_name=excluded.company_name,
              title=excluded.title,
              location=COALESCE(NULLIF(excluded.location, ''), job_postings.location),
              compensation=COALESCE(NULLIF(excluded.compensation, ''), job_postings.compensation),
              pipeline_state=excluded.pipeline_state,
              score=COALESCE(NULLIF(excluded.score, ''), job_postings.score),
              notes=COALESCE(NULLIF(excluded.notes, ''), job_postings.notes),
              updated_at=CURRENT_TIMESTAMP
            """,
            (entry.url, company_id, entry.company, entry.title, entry.location, entry.compensation, pipeline_state, entry.score, entry.note),
        )
        count += 1
    return count


def parse_application_lines() -> list[dict[str, str | int]]:
    if not APPLICATIONS.exists():
        return []
    rows: list[dict[str, str | int]] = []
    for line in APPLICATIONS.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 10:
            continue
        try:
            num = int(parts[1])
        except ValueError:
            continue
        rows.append({
            "tracker_num": num,
            "date": parts[2],
            "company": parts[3],
            "role": parts[4],
            "score": parts[5],
            "status": parts[6],
            "pdf": parts[7],
            "report": parts[8],
            "notes": parts[9],
        })
    return rows


def import_applications(con: sqlite3.Connection) -> int:
    count = 0
    for app in parse_application_lines():
        posting = con.execute(
            """
            SELECT id FROM job_postings
            WHERE lower(company_name) = lower(?) AND lower(title) = lower(?)
            ORDER BY id LIMIT 1
            """,
            (app["company"], app["role"]),
        ).fetchone()
        posting_id = int(posting["id"]) if posting else None
        con.execute(
            """
            INSERT INTO applications(tracker_num, date, company, role, score, status, pdf, report, notes, posting_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tracker_num) DO UPDATE SET
              date=excluded.date,
              company=excluded.company,
              role=excluded.role,
              score=excluded.score,
              status=excluded.status,
              pdf=excluded.pdf,
              report=excluded.report,
              notes=excluded.notes,
              posting_id=COALESCE(excluded.posting_id, applications.posting_id),
              updated_at=CURRENT_TIMESTAMP
            """,
            (app["tracker_num"], app["date"], app["company"], app["role"], app["score"], app["status"], app["pdf"], app["report"], app["notes"], posting_id),
        )
        count += 1
    return count


def import_all(con: sqlite3.Connection) -> dict[str, int]:
    init_db(con)
    counts = {
        "scan_history": import_scan_history(con),
        "pipeline": import_pipeline(con),
        "applications": import_applications(con),
    }
    con.commit()
    return counts


def export_pipeline(con: sqlite3.Connection, path: Path = PIPELINE) -> int:
    rows = con.execute(
        """
        SELECT url, company_name, title, location, compensation, pipeline_state, score, notes,
               deep_fit_score, deep_stretch_score, deep_interest_score, application_priority, deep_review_path
        FROM job_postings
        WHERE pipeline_state IN ('pending', 'shortlisted', 'processed', 'applied', 'discarded', 'expired')
        ORDER BY
          CASE pipeline_state
            WHEN 'pending' THEN 0
            WHEN 'shortlisted' THEN 1
            WHEN 'processed' THEN 2
            WHEN 'applied' THEN 2
            WHEN 'discarded' THEN 3
            ELSE 4
          END,
          COALESCE(first_seen, created_at) DESC,
          company_name COLLATE NOCASE,
          title COLLATE NOCASE
        """
    ).fetchall()
    buckets = {"pending": [], "shortlisted": [], "processed": [], "discarded": [], "expired": []}
    for row in rows:
        suffix = ""
        if row["location"]:
            suffix += f" | {clean_cell(row['location'])}"
        if row["compensation"]:
            suffix += f" | {clean_cell(row['compensation'])}"
        if row["score"]:
            suffix += f" | {clean_cell(row['score'])}"
        if row["notes"]:
            suffix += f" | {clean_cell(row['notes'])}"
        if row["deep_fit_score"] is not None:
            suffix += f" | Deep fit {row['deep_fit_score']:.1f}/5"
            if row["deep_stretch_score"] is not None:
                suffix += f"; stretch {row['deep_stretch_score']:.1f}/5"
            if row["deep_interest_score"] is not None:
                suffix += f"; interest {row['deep_interest_score']:.1f}/5"
            if row["application_priority"]:
                suffix += f"; priority {row['application_priority']}"
            if row["deep_review_path"]:
                suffix += f"; review {row['deep_review_path']}"
        state = row["pipeline_state"]
        done = state in {"processed", "applied", "discarded", "expired"}
        line = f"- [{'x' if done else ' '}] {clean_cell(row['url'])} | {clean_cell(row['company_name'])} | {clean_cell(row['title'])}{suffix}"
        if state == "shortlisted":
            buckets["shortlisted"].append(line)
        elif state in {"processed", "applied"}:
            buckets["processed"].append(line)
        elif state == "discarded":
            buckets["discarded"].append(line)
        elif state == "expired":
            buckets["expired"].append(line)
        else:
            buckets["pending"].append(line)
    text = "## Pending\n\n"
    text += "\n".join(buckets["pending"])
    text += "\n\n## Shortlisted\n\n"
    text += "\n".join(buckets["shortlisted"])
    text += "\n\n## Processed\n\n"
    text += "\n".join(buckets["processed"])
    text += "\n\n## Discarded\n\n"
    text += "\n".join(buckets["discarded"])
    text += "\n\n## Expired\n\n"
    text += "\n".join(buckets["expired"])
    text += "\n"
    path.write_text(text, encoding="utf-8")
    return len(rows)


def export_applications(con: sqlite3.Connection, path: Path = APPLICATIONS) -> int:
    rows = con.execute(
        """
        SELECT tracker_num, date, company, role, score, status, pdf, report, notes
        FROM applications
        ORDER BY tracker_num
        """
    ).fetchall()
    lines = [
        "# Applications Tracker",
        "",
        "| # | Date | Company | Role | Score | Status | PDF | Report | Notes |",
        "|---|------|---------|------|-------|--------|-----|--------|-------|",
    ]
    for row in rows:
        lines.append(f"| {row['tracker_num']} | {row['date']} | {row['company']} | {row['role']} | {row['score']} | {row['status']} | {row['pdf']} | {row['report']} | {row['notes']} |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(rows)


def summary(con: sqlite3.Connection) -> dict[str, int]:
    tables = ["companies", "source_vetting", "search_runs", "job_postings", "applications", "application_events", "artifacts"]
    return {table: int(con.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"]) for table in tables}


def state_summary(con: sqlite3.Connection) -> list[dict[str, int | str]]:
    rows = con.execute(
        """
        SELECT pipeline_state AS state,
               COUNT(*) AS postings,
               SUM(CASE WHEN score IS NULL OR trim(score) = '' THEN 1 ELSE 0 END) AS unscored
        FROM job_postings
        GROUP BY pipeline_state
        ORDER BY pipeline_state
        """
    ).fetchall()
    return [{"state": row["state"], "postings": int(row["postings"]), "unscored": int(row["unscored"] or 0)} for row in rows]


def main() -> int:
    parser = argparse.ArgumentParser(description="Career-ops SQLite tracking utilities.")
    parser.add_argument("command", choices=["init", "import", "summary", "export-pipeline", "export-applications", "export-all"])
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite database path.")
    args = parser.parse_args()

    con = connect(Path(args.db))
    try:
        init_db(con)
        if args.command == "init":
            print(f"Initialized {args.db}")
        elif args.command == "import":
            print("Imported:", import_all(con))
            print("Summary:", summary(con))
            print("States:", state_summary(con))
        elif args.command == "summary":
            print(summary(con))
            print("States:", state_summary(con))
        elif args.command == "export-pipeline":
            print(f"Exported {export_pipeline(con)} postings to {PIPELINE}")
        elif args.command == "export-applications":
            print(f"Exported {export_applications(con)} applications to {APPLICATIONS}")
        elif args.command == "export-all":
            print(f"Exported {export_pipeline(con)} postings to {PIPELINE}")
            print(f"Exported {export_applications(con)} applications to {APPLICATIONS}")
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
