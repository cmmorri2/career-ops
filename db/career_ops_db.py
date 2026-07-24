#!/usr/bin/env python3
"""SQLite import/export helpers for the career-ops sourcing funnel."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "career-ops.sqlite"
SCAN_HISTORY = ROOT / "data" / "scan-history.tsv"
PIPELINE = ROOT / "data" / "pipeline.md"
APPLICATIONS = ROOT / "data" / "applications.md"
POSTING_SNAPSHOTS = ROOT / "data" / "cache" / "posting-snapshots.jsonl"
LINKEDIN_LEADS = ROOT / "data" / "linkedin-leads.jsonl"


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
  salary_min REAL,
  salary_max REAL,
  salary_currency TEXT,
  salary_period TEXT,
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

CREATE TABLE IF NOT EXISTS posting_events (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  event_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_type TEXT NOT NULL,
  from_pipeline_state TEXT,
  to_pipeline_state TEXT,
  from_status TEXT,
  to_status TEXT,
  reason TEXT,
  notes TEXT,
  source TEXT,
  raw_text TEXT
);

CREATE INDEX IF NOT EXISTS idx_posting_events_posting ON posting_events(posting_id);
CREATE INDEX IF NOT EXISTS idx_posting_events_type ON posting_events(event_type);

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

CREATE TABLE IF NOT EXISTS triage_email_batches (
  id INTEGER PRIMARY KEY,
  batch_key TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  body_path TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open', 'partial', 'complete', 'expired')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS triage_email_items (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES triage_email_batches(id) ON DELETE CASCADE,
  item_num INTEGER NOT NULL,
  posting_id INTEGER NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  state_at_send TEXT NOT NULL,
  item_status TEXT NOT NULL DEFAULT 'unanswered'
    CHECK(item_status IN ('unanswered', 'responded', 'deferred', 'needs_review', 'superseded')),
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at TEXT,
  UNIQUE(batch_id, item_num),
  UNIQUE(batch_id, posting_id)
);

CREATE INDEX IF NOT EXISTS idx_triage_email_items_posting ON triage_email_items(posting_id);
CREATE INDEX IF NOT EXISTS idx_triage_email_items_status ON triage_email_items(item_status);

CREATE TABLE IF NOT EXISTS triage_email_events (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES triage_email_batches(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES triage_email_items(id) ON DELETE SET NULL,
  posting_id INTEGER REFERENCES job_postings(id) ON DELETE SET NULL,
  message_id TEXT,
  action TEXT NOT NULL,
  note TEXT,
  raw_line TEXT NOT NULL,
  result TEXT NOT NULL,
  conflict TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

CREATE TABLE IF NOT EXISTS role_discovery_clusters (
  id INTEGER PRIMARY KEY,
  normalized_role TEXT NOT NULL UNIQUE,
  display_role TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'new'
    CHECK(review_status IN ('new', 'review', 'ignored', 'promoted', 'watching')),
  coverage_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK(coverage_status IN ('unknown', 'covered', 'under_covered')),
  evidence_count INTEGER NOT NULL DEFAULT 0,
  linkedin_count INTEGER NOT NULL DEFAULT 0,
  pipeline_match_count INTEGER NOT NULL DEFAULT 0,
  pipeline_active_count INTEGER NOT NULL DEFAULT 0,
  pipeline_shortlisted_count INTEGER NOT NULL DEFAULT 0,
  pipeline_discarded_count INTEGER NOT NULL DEFAULT 0,
  pipeline_expired_count INTEGER NOT NULL DEFAULT 0,
  application_match_count INTEGER NOT NULL DEFAULT 0,
  best_score REAL,
  search_query TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_discovery_leads (
  id INTEGER PRIMARY KEY,
  cluster_id INTEGER NOT NULL REFERENCES role_discovery_clusters(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_detail TEXT,
  seed_company TEXT,
  seed_title TEXT,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  location TEXT,
  work_model TEXT,
  url TEXT,
  triage_score REAL,
  triage_label TEXT,
  review_status TEXT NOT NULL DEFAULT 'new'
    CHECK(review_status IN ('new', 'review', 'ignored', 'promoted', 'watching')),
  source_received_at TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_role_discovery_leads_cluster ON role_discovery_leads(cluster_id);
CREATE INDEX IF NOT EXISTS idx_role_discovery_leads_status ON role_discovery_leads(review_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_role_discovery_leads_identity
ON role_discovery_leads(source, COALESCE(url, ''), company, title, COALESCE(location, ''));

CREATE TABLE IF NOT EXISTS role_discovery_searches (
  id INTEGER PRIMARY KEY,
  cluster_id INTEGER NOT NULL REFERENCES role_discovery_clusters(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'suggested',
  target_count INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'suggested'
    CHECK(status IN ('suggested', 'queued', 'searched', 'ignored')),
  result_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(cluster_id, query)
);

CREATE TABLE IF NOT EXISTS role_discovery_search_results (
  id INTEGER PRIMARY KEY,
  search_id INTEGER NOT NULL REFERENCES role_discovery_searches(id) ON DELETE CASCADE,
  cluster_id INTEGER NOT NULL REFERENCES role_discovery_clusters(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT,
  posted_at TEXT,
  ats TEXT,
  source TEXT NOT NULL DEFAULT 'role-discovery-search',
  matched_keyword TEXT,
  note TEXT,
  review_status TEXT NOT NULL DEFAULT 'new'
    CHECK(review_status IN ('new', 'review', 'ignored', 'promoted', 'watching')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(search_id, url)
);

CREATE INDEX IF NOT EXISTS idx_role_discovery_search_results_search ON role_discovery_search_results(search_id);
CREATE INDEX IF NOT EXISTS idx_role_discovery_search_results_cluster ON role_discovery_search_results(cluster_id);
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
        ("salary_min", "REAL"),
        ("salary_max", "REAL"),
        ("salary_currency", "TEXT"),
        ("salary_period", "TEXT"),
        ("deep_fit_score", "REAL"),
        ("deep_stretch_score", "REAL"),
        ("deep_interest_score", "REAL"),
        ("application_priority", "TEXT"),
        ("deep_review_path", "TEXT"),
        ("deep_reviewed_at", "TEXT"),
    ]:
        ensure_column(con, "job_postings", column, declaration)
    for column in [
        "pipeline_active_count",
        "pipeline_shortlisted_count",
        "pipeline_discarded_count",
        "pipeline_expired_count",
    ]:
        ensure_column(con, "role_discovery_clusters", column, "INTEGER NOT NULL DEFAULT 0")
    clean_misfiled_compensation(con)
    con.commit()


def num_or_none(value) -> float | None:
    try:
        if value is None or value == "":
            return None
        n = float(value)
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def salary_fields_from_raw(raw_source: str) -> tuple[float | None, float | None, str | None, str | None]:
    if not raw_source:
        return (None, None, None, None)
    try:
        raw = json.loads(raw_source)
    except json.JSONDecodeError:
        return (None, None, None, None)
    if not isinstance(raw, dict):
        return (None, None, None, None)
    salary = raw.get("salary")
    if not isinstance(salary, dict):
        return (None, None, None, None)
    return (
        num_or_none(salary.get("min")),
        num_or_none(salary.get("max")),
        str(salary.get("currency") or "").strip() or None,
        str(salary.get("period") or salary.get("interval") or "").strip() or None,
    )


def record_posting_event(
    con: sqlite3.Connection,
    posting_id: int,
    event_type: str,
    *,
    from_pipeline_state: str | None = None,
    to_pipeline_state: str | None = None,
    from_status: str | None = None,
    to_status: str | None = None,
    reason: str | None = None,
    notes: str | None = None,
    source: str | None = None,
    raw_text: str | None = None,
) -> None:
    con.execute(
        """
        INSERT INTO posting_events(
          posting_id, event_type, from_pipeline_state, to_pipeline_state,
          from_status, to_status, reason, notes, source, raw_text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            posting_id,
            event_type,
            from_pipeline_state,
            to_pipeline_state,
            from_status,
            to_status,
            reason,
            notes,
            source,
            raw_text,
        ),
    )


def normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower())


TITLE_STOPWORDS = {
    "senior",
    "sr",
    "staff",
    "principal",
    "lead",
    "director",
    "head",
    "manager",
    "mgr",
    "associate",
    "level",
    "ii",
    "iii",
    "iv",
    "v",
    "remote",
    "usa",
    "us",
}


def title_tokens(title: str) -> set[str]:
    cleaned = re.sub(r"[^a-z0-9]+", " ", title.lower())
    return {token for token in cleaned.split() if token and token not in TITLE_STOPWORDS}


def title_has(tokens: set[str], *needles: str) -> bool:
    return any(needle in tokens for needle in needles)


def normalized_role_for_title(title: str) -> tuple[str, str]:
    tokens = title_tokens(title)
    raw = title.strip() or "Unknown Role"
    has_ai = title_has(tokens, "ai", "agentic", "agents", "genai", "ml", "machine", "conversational")
    if has_ai and title_has(tokens, "product", "pm"):
        return "ai_product_management", "AI Product Management"
    if has_ai and title_has(tokens, "solutions", "solution", "architect", "consultant", "consulting", "practitioner"):
        return "ai_solutions_architecture", "AI Solutions Architecture"
    if title_has(tokens, "forward", "deployed"):
        return "forward_deployed_ai", "Forward Deployed AI"
    if title_has(tokens, "governance", "purview", "compliance"):
        return "data_governance", "Data Governance"
    if title_has(tokens, "identity", "entra", "iam", "security"):
        return "identity_security", "Identity / Security"
    if title_has(tokens, "product", "pm"):
        return "product_management", "Product Management"
    if title_has(tokens, "solutions", "solution", "architect", "consultant", "consulting"):
        return "solutions_architecture", "Solutions Architecture"
    if title_has(tokens, "data", "analytics", "bi"):
        return "data_analytics", "Data / Analytics"
    if title_has(tokens, "platform", "infrastructure"):
        return "platform_engineering", "Platform Engineering"
    key_tokens = sorted(tokens)[:5]
    key = "_".join(key_tokens) if key_tokens else normalize_name(raw) or "unknown_role"
    display = " ".join(token.capitalize() for token in key_tokens) if key_tokens else raw
    return key, display


def title_similarity_key(title: str) -> str:
    tokens = sorted(title_tokens(title))
    return " ".join(tokens)


def score_role_lead(title: str, location: str = "", work_model: str = "") -> tuple[float, str]:
    text = f"{title} {location} {work_model}".lower()
    score = 2.0
    reasons: list[str] = []
    if re.search(r"\b(ai|agentic|agents|genai|machine learning|ml)\b", text):
        score += 0.7
        reasons.append("AI signal")
    if re.search(r"\b(product|pm|workflow|platform)\b", text):
        score += 0.45
        reasons.append("product/platform signal")
    if re.search(r"\b(solution|solutions|architect|consultant|consulting|forward deployed|applied)\b", text):
        score += 0.4
        reasons.append("solutions/customer signal")
    if re.search(r"\b(remote|united states|san francisco|new york|seattle|portland|nashville)\b", text):
        score += 0.25
        reasons.append("location signal")
    if re.search(r"\b(identity|entra|salesforce|timekeeping|finance transformation|purview)\b", text):
        score -= 0.45
        reasons.append("function mismatch risk")
    if re.search(r"\b(sr manager|senior manager|director|associate director)\b", text):
        score -= 0.25
        reasons.append("management-heavy risk")
    score = max(1.0, min(5.0, round(score, 1)))
    if score >= 3.8:
        label = "promote_candidate"
    elif score >= 3.2:
        label = "review"
    elif score >= 2.7:
        label = "watch"
    else:
        label = "likely_noise"
    if reasons:
        label = f"{label}: {', '.join(reasons[:3])}"
    return score, label


def search_query_for_role(display_role: str, seed_title: str = "") -> str:
    basis = seed_title.strip() or display_role
    quoted = re.sub(r"\s+", " ", basis).strip()
    return f'"{quoted}" ("AI" OR "agentic" OR "platform" OR "solutions") jobs remote OR "United States"'


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
        elif re.match(r"^(?:Salary|Compensation|Pay):", part, re.I):
            compensation = re.sub(r"^(?:Salary|Compensation|Pay):\s*", "", part, flags=re.I).strip()
        elif part.lower().startswith(("note:", "notes:", "batch:", "batch ", "active check ")):
            note_parts.append(part)
        elif not location and not part.startswith("PDF ") and not part.startswith("["):
            location = part
        elif not compensation and looks_like_compensation(part):
            compensation = part
        else:
            note_parts.append(part)
    return PipelineEntry(done, url, company, title, location, compensation, score, " | ".join(note_parts) or None)


def looks_like_compensation(value: str) -> bool:
    text = (value or "").strip()
    if not text:
        return False
    if text.lower().startswith(("salary:", "compensation:", "pay:")):
        return True
    currency = r"(?:[$€£]|USD|EUR|GBP|CAD|AUD|CHF)"
    return bool(
        re.search(currency, text, re.I)
        and re.search(r"\d", text)
    ) or bool(
        re.search(r"\b\d[\d,]*(?:\.\d+)?\s*[kKmM]?\s*(?:-|–|to)\s*\d[\d,]*(?:\.\d+)?\s*[kKmM]?\b", text)
        and re.search(r"\b(?:year|yr|annual|annually|hour|hr|month|mo|week|wk)\b", text, re.I)
    )


def clean_misfiled_compensation(con: sqlite3.Connection) -> int:
    rows = con.execute(
        """
        SELECT id, compensation, notes
        FROM job_postings
        WHERE compensation IS NOT NULL AND trim(compensation) <> ''
        """
    ).fetchall()
    count = 0
    for row in rows:
        compensation = str(row["compensation"] or "").strip()
        if looks_like_compensation(compensation):
            continue
        notes = str(row["notes"] or "").strip()
        next_notes = notes
        if compensation and compensation not in notes:
            next_notes = f"{notes}; {compensation}" if notes else compensation
        con.execute(
            """
            UPDATE job_postings
            SET compensation = NULL,
                notes = NULLIF(?, ''),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (next_notes, int(row["id"])),
        )
        count += 1
    return count


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
        existing_posting = con.execute(
            "SELECT pipeline_state FROM job_postings WHERE url = ?",
            (entry.url,),
        ).fetchone()
        if section == "expired" and existing_posting:
            existing_state = str(existing_posting["pipeline_state"] or "").strip().lower()
            if existing_state not in {"", "pending", "expired"}:
                pipeline_state = existing_state
        posting_status = "expired" if section == "expired" else "active"
        company_id = upsert_company(con, entry.company)
        con.execute(
            """
            INSERT INTO job_postings(url, company_id, company_name, title, location, compensation, pipeline_state, status, score, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
              company_id=excluded.company_id,
              company_name=excluded.company_name,
              title=excluded.title,
              location=COALESCE(NULLIF(excluded.location, ''), job_postings.location),
              compensation=COALESCE(NULLIF(excluded.compensation, ''), job_postings.compensation),
              pipeline_state=excluded.pipeline_state,
              status=CASE
                WHEN excluded.status = 'expired' THEN 'expired'
                ELSE job_postings.status
              END,
              score=COALESCE(NULLIF(excluded.score, ''), job_postings.score),
              notes=COALESCE(NULLIF(excluded.notes, ''), job_postings.notes),
              updated_at=CURRENT_TIMESTAMP
            """,
            (entry.url, company_id, entry.company, entry.title, entry.location, entry.compensation, pipeline_state, posting_status, entry.score, entry.note),
        )
        count += 1
    return count


def import_posting_snapshots(con: sqlite3.Connection) -> int:
    if not POSTING_SNAPSHOTS.exists():
        return 0
    count = 0
    with POSTING_SNAPSHOTS.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            url = str(row.get("url") or "").strip()
            description = str(row.get("description") or "").strip()
            if not url or not description:
                continue
            title = str(row.get("title") or "").strip()
            company = str(row.get("company") or "").strip()
            location = str(row.get("location") or "").strip()
            raw_source = str(row.get("raw_source") or "").strip()
            captured_at = str(row.get("captured_at") or "").strip() or None
            salary_min, salary_max, salary_currency, salary_period = salary_fields_from_raw(raw_source)

            posting = con.execute("SELECT id FROM job_postings WHERE url = ?", (url,)).fetchone()
            if not posting:
                if not company or not title:
                    continue
                company_id = upsert_company(con, company)
                con.execute(
                    """
                    INSERT INTO job_postings(url, company_id, company_name, title, location, source)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(url) DO NOTHING
                    """,
                    (url, company_id, company, title, location, "snapshot"),
                )
                posting = con.execute("SELECT id FROM job_postings WHERE url = ?", (url,)).fetchone()
            if not posting:
                continue
            posting_id = int(posting["id"])
            existing = con.execute(
                """
                SELECT id FROM posting_snapshots
                WHERE posting_id = ?
                  AND description = ?
                  AND COALESCE(raw_source, '') = ?
                LIMIT 1
                """,
                (posting_id, description, raw_source),
            ).fetchone()
            if existing:
                continue
            con.execute(
                """
                INSERT INTO posting_snapshots(posting_id, captured_at, title, location, description, raw_source)
                VALUES (?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?)
                """,
                (posting_id, captured_at, title, location, description, raw_source),
            )
            if salary_min is not None or salary_max is not None or salary_currency or salary_period:
                con.execute(
                    """
                    UPDATE job_postings
                    SET salary_min=COALESCE(?, salary_min),
                        salary_max=COALESCE(?, salary_max),
                        salary_currency=COALESCE(NULLIF(?, ''), salary_currency),
                        salary_period=COALESCE(NULLIF(?, ''), salary_period),
                        updated_at=CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (salary_min, salary_max, salary_currency, salary_period, posting_id),
                )
            count += 1
    return count


def read_jsonl(path: Path) -> list[dict[str, object]]:
    if not path.exists():
        return []
    rows: list[dict[str, object]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                rows.append(row)
    return rows


def seed_from_alert(alert_name: str) -> tuple[str, str]:
    match = re.search(r"New jobs similar to\s+(.+?)\s+at\s+(.+?)(?:$|\s+-\s+Search)", alert_name, re.I)
    if not match:
        return "", ""
    return match.group(2).strip(), match.group(1).strip()


def existing_role_coverage(con: sqlite3.Connection) -> tuple[dict[str, dict[str, int]], set[str]]:
    coverage: dict[str, dict[str, int]] = {}
    variants: set[str] = set()

    def empty_counts() -> dict[str, int]:
        return {
            "pipeline": 0,
            "pipeline_active": 0,
            "pipeline_shortlisted": 0,
            "pipeline_discarded": 0,
            "pipeline_expired": 0,
            "applications": 0,
        }

    def bump(title: str, layer: str, state: str = "") -> None:
        role_key, _ = normalized_role_for_title(title)
        if role_key not in coverage:
            coverage[role_key] = empty_counts()
        coverage[role_key][layer] += 1
        if layer == "pipeline":
            if state == "shortlisted":
                coverage[role_key]["pipeline_shortlisted"] += 1
            elif state == "discarded":
                coverage[role_key]["pipeline_discarded"] += 1
            elif state == "expired":
                coverage[role_key]["pipeline_expired"] += 1
            elif state in {"pending", "active", ""}:
                coverage[role_key]["pipeline_active"] += 1
        variants.add(title_similarity_key(title))

    for row in con.execute("SELECT title, pipeline_state, status FROM job_postings").fetchall():
        state = str(row["pipeline_state"] or "").strip().lower()
        if str(row["status"] or "").strip().lower() == "expired":
            state = "expired"
        bump(str(row["title"] or ""), "pipeline", state)
    for row in con.execute("SELECT role FROM applications").fetchall():
        bump(str(row["role"] or ""), "applications")
    return coverage, variants


def import_linkedin_role_discovery(con: sqlite3.Connection, path: Path = LINKEDIN_LEADS) -> dict[str, int]:
    leads = read_jsonl(path)
    coverage, existing_variants = existing_role_coverage(con)
    imported = 0
    clusters_seen: set[str] = set()
    uncovered_clusters: set[str] = set()
    for lead in leads:
        title = str(lead.get("title") or "").strip()
        company = str(lead.get("company") or "").strip()
        if not title or not company:
            continue
        role_key, display_role = normalized_role_for_title(title)
        clusters_seen.add(role_key)
        location = str(lead.get("location") or "").strip()
        work_model = str(lead.get("workModel") or "").strip()
        alert_name = str(lead.get("alertName") or "").strip()
        seed_company, seed_title = seed_from_alert(alert_name)
        score, label = score_role_lead(title, location, work_model)
        role_coverage = coverage.get(role_key, {
            "pipeline": 0,
            "pipeline_active": 0,
            "pipeline_shortlisted": 0,
            "pipeline_discarded": 0,
            "pipeline_expired": 0,
            "applications": 0,
        })
        variant_key = title_similarity_key(title)
        if variant_key not in existing_variants:
            uncovered_clusters.add(role_key)
        coverage_status = "covered" if variant_key in existing_variants else "under_covered"
        search_query = search_query_for_role(display_role, seed_title or title)
        con.execute(
            """
            INSERT INTO role_discovery_clusters(
              normalized_role, display_role, coverage_status, pipeline_match_count,
              pipeline_active_count, pipeline_shortlisted_count, pipeline_discarded_count,
              pipeline_expired_count, application_match_count, best_score, search_query
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(normalized_role) DO UPDATE SET
              display_role=excluded.display_role,
              coverage_status=excluded.coverage_status,
              pipeline_match_count=excluded.pipeline_match_count,
              pipeline_active_count=excluded.pipeline_active_count,
              pipeline_shortlisted_count=excluded.pipeline_shortlisted_count,
              pipeline_discarded_count=excluded.pipeline_discarded_count,
              pipeline_expired_count=excluded.pipeline_expired_count,
              application_match_count=excluded.application_match_count,
              best_score=MAX(COALESCE(role_discovery_clusters.best_score, 0), excluded.best_score),
              search_query=excluded.search_query,
              updated_at=CURRENT_TIMESTAMP
            """,
            (
                role_key,
                display_role,
                coverage_status,
                int(role_coverage["pipeline"]),
                int(role_coverage["pipeline_active"]),
                int(role_coverage["pipeline_shortlisted"]),
                int(role_coverage["pipeline_discarded"]),
                int(role_coverage["pipeline_expired"]),
                int(role_coverage["applications"]),
                score,
                search_query,
            ),
        )
        cluster = con.execute("SELECT id FROM role_discovery_clusters WHERE normalized_role = ?", (role_key,)).fetchone()
        if not cluster:
            continue
        cluster_id = int(cluster["id"])
        source_detail = "linkedin_email_similar" if seed_title else "linkedin_email_alert"
        url = str(lead.get("jobUrl") or "").strip()
        existing = con.execute(
            """
            SELECT id FROM role_discovery_leads
            WHERE source = 'linkedin-email'
              AND COALESCE(url, '') = ?
              AND company = ?
              AND title = ?
              AND COALESCE(location, '') = ?
            LIMIT 1
            """,
            (url, company, title, location),
        ).fetchone()
        values = (
            cluster_id,
            source_detail,
            seed_company,
            seed_title,
            company,
                title,
                variant_key,
            location,
            work_model,
            url,
            score,
            label,
            str(lead.get("receivedAt") or "").strip(),
            json.dumps(lead, sort_keys=True),
        )
        if existing:
            con.execute(
                """
                UPDATE role_discovery_leads
                SET cluster_id = ?,
                    source_detail = ?,
                    seed_company = ?,
                    seed_title = ?,
                    company = ?,
                    title = ?,
                    normalized_title = ?,
                    location = ?,
                    work_model = ?,
                    url = ?,
                    triage_score = ?,
                    triage_label = ?,
                    source_received_at = ?,
                    raw_json = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (*values, int(existing["id"])),
            )
        else:
            con.execute(
                """
                INSERT INTO role_discovery_leads(
                  cluster_id, source, source_detail, seed_company, seed_title, company,
                  title, normalized_title, location, work_model, url, triage_score,
                  triage_label, source_received_at, raw_json
                )
                VALUES (?, 'linkedin-email', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                values,
            )
        imported += 1

    for role_key in clusters_seen:
        coverage_status = "under_covered" if role_key in uncovered_clusters else "covered"
        con.execute(
            """
            UPDATE role_discovery_clusters
            SET coverage_status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE normalized_role = ?
            """,
            (coverage_status, role_key),
        )
        row = con.execute(
            """
            SELECT id, display_role, search_query
            FROM role_discovery_clusters
            WHERE normalized_role = ?
            """,
            (role_key,),
        ).fetchone()
        if not row:
            continue
        notes = (
            "Suggested from LinkedIn role-discovery cluster; current exact title variants look covered."
            if coverage_status == "covered"
            else "Suggested from LinkedIn role-discovery cluster; title variant appears under-covered."
        )
        con.execute(
            """
            INSERT INTO role_discovery_searches(cluster_id, query, source, target_count, notes)
            VALUES (?, ?, 'suggested', 10, ?)
            ON CONFLICT(cluster_id, query) DO NOTHING
            """,
            (int(row["id"]), str(row["search_query"] or search_query_for_role(str(row["display_role"] or ""))), notes),
        )

    con.execute(
        """
        UPDATE role_discovery_clusters
        SET evidence_count = (
              SELECT COUNT(*) FROM role_discovery_leads
              WHERE role_discovery_leads.cluster_id = role_discovery_clusters.id
            ),
            linkedin_count = (
              SELECT COUNT(*) FROM role_discovery_leads
              WHERE role_discovery_leads.cluster_id = role_discovery_clusters.id
                AND role_discovery_leads.source = 'linkedin-email'
            ),
            best_score = (
              SELECT MAX(triage_score) FROM role_discovery_leads
              WHERE role_discovery_leads.cluster_id = role_discovery_clusters.id
            ),
            updated_at = CURRENT_TIMESTAMP
        """
    )
    return {"linkedin_leads": imported, "clusters": len(clusters_seen)}


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
        "posting_snapshots": import_posting_snapshots(con),
        "applications": import_applications(con),
        "role_discovery": import_linkedin_role_discovery(con)["linkedin_leads"],
    }
    con.commit()
    return counts


def export_pipeline(con: sqlite3.Connection, path: Path = PIPELINE) -> int:
    rows = con.execute(
        """
        SELECT url, company_name, title, location, compensation, status, pipeline_state, score, notes,
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
        export_state = "expired" if row["status"] == "expired" else state
        done = row["status"] == "expired" or state in {"processed", "applied", "discarded", "expired"}
        line = f"- [{'x' if done else ' '}] {clean_cell(row['url'])} | {clean_cell(row['company_name'])} | {clean_cell(row['title'])}{suffix}"
        if export_state == "shortlisted":
            buckets["shortlisted"].append(line)
        elif export_state in {"processed", "applied"}:
            buckets["processed"].append(line)
        elif export_state == "discarded":
            buckets["discarded"].append(line)
        elif export_state == "expired":
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
    tables = [
        "companies",
        "source_vetting",
        "search_runs",
        "job_postings",
        "posting_snapshots",
        "applications",
        "application_events",
        "posting_events",
        "triage_email_batches",
        "triage_email_items",
        "triage_email_events",
        "artifacts",
        "role_discovery_clusters",
        "role_discovery_leads",
        "role_discovery_searches",
        "role_discovery_search_results",
    ]
    return {table: int(con.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"]) for table in tables}


def state_summary(con: sqlite3.Connection) -> list[dict[str, int | str]]:
    rows = con.execute(
        """
        SELECT pipeline_state AS state,
               COUNT(*) AS postings,
               SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
               SUM(CASE WHEN score IS NULL OR trim(score) = '' THEN 1 ELSE 0 END) AS unscored
        FROM job_postings
        GROUP BY pipeline_state
        ORDER BY pipeline_state
        """
    ).fetchall()
    return [
        {
            "state": row["state"],
            "postings": int(row["postings"]),
            "expired": int(row["expired"] or 0),
            "unscored": int(row["unscored"] or 0),
        }
        for row in rows
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Career-ops SQLite tracking utilities.")
    parser.add_argument("command", choices=["init", "import", "summary", "role-discovery", "export-pipeline", "export-applications", "export-all"])
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
        elif args.command == "role-discovery":
            result = import_linkedin_role_discovery(con)
            con.commit()
            print("Role discovery:", result)
            print("Summary:", {
                "role_discovery_clusters": summary(con)["role_discovery_clusters"],
                "role_discovery_leads": summary(con)["role_discovery_leads"],
                "role_discovery_searches": summary(con)["role_discovery_searches"],
            })
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
