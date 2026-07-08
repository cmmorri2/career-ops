#!/usr/bin/env python3
"""Add zero-token first-pass triage scores to unscored postings."""

from __future__ import annotations

import argparse
import re
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "career-ops.sqlite"

LEGAL_TECH = {"disco", "eudia", "eve", "everlaw", "harvey", "legora", "robin ai", "relativity"}
PREFERRED_LOCS = [
    "remote", "hybrid", "united states", "usa", "california", "san francisco", "los angeles",
    "florida", "georgia", "tennessee", "north carolina", "raleigh", "cary", "durham",
    "morrisville", "research triangle", "charlotte", "seattle", "portland", "hawaii",
    "canada", "vancouver", "toronto", "united kingdom", "london", "scotland", "glasgow",
    "edinburgh", "ireland", "dublin", "netherlands", "amsterdam", "germany", "berlin",
    "munich", "sweden", "stockholm", "switzerland", "singapore", "norway", "oslo",
]
APPLIED_SOLUTION_TERMS = [
    "applied ai solutions consultant", "ai solutions consultant", "solutions consultant",
    "solution consultant", "solution architect", "solutions architect", "forward deployed",
    "field cto", "customer engineer", "deployment architect",
]
MEETING_HEAVY_TERMS = [
    "engagement manager", "client engagement", "client value partner", "account lead",
    "delivery manager", "program manager", "project manager", "transformation consultant",
    "transformation partner",
]
CODING_HEAVY_ENGINEERING_TERMS = [
    "software engineer", "backend engineer", "cloud sre", "sre", "compiler",
    "performance engineer", "developer", "test automation", "qa engineer",
    "applied ai engineer", "machine learning engineer", "ml engineer",
]


def has(text: str, *terms: str) -> bool:
    for term in terms:
        if len(term) <= 3 and term.isalnum():
            if re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", text):
                return True
        elif term in text:
            return True
    return False


def add(score: float, notes: list[str], amount: float, note: str) -> float:
    if note not in notes:
        notes.append(note)
    return score + amount


def score_posting(company: str, title: str, location: str) -> tuple[str, str]:
    company_l = company.lower()
    title_l = title.lower()
    loc_l = (location or "").lower()
    score = 2.5
    notes: list[str] = []

    has_ai_signal = has(title_l, "ai", "machine learning", "ml", "llm", "agentic", "agent", "genai", "foundation model")
    has_applied_solution_signal = has(title_l, *APPLIED_SOLUTION_TERMS)

    if has(title_l, "product manager", "product lead", "product strategy", "product operations"):
        score = add(score, notes, 0.65, "product-shaping signal")
    elif has(title_l, "program manager", "project manager", "technical program manager"):
        score = add(score, notes, 0.15, "operator signal with possible timeline ownership")

    if has_ai_signal:
        score = add(score, notes, 0.45, "AI/automation signal")

    if has(title_l, "platform", "workflow", "search", "data science", "analytics", "evaluation", "governance"):
        score = add(score, notes, 0.30, "platform/evaluation/workflow signal")

    if has_applied_solution_signal:
        score = add(score, notes, 0.65, "applied solutions/experimentation lane")
        if has_ai_signal:
            score = add(score, notes, 0.65, "AI solutions-consulting sweet spot")
    elif has(title_l, "solutions", "solution", "customer", "legal engineer"):
        score = add(score, notes, 0.45, "solutions/customer bridge")
    elif has(title_l, "value engineer"):
        score = add(score, notes, 0.15, "value-engineering/customer bridge")

    if company_l in LEGAL_TECH and has(title_l, "legal", "product", "solutions", "engagement", "customer", "evaluation", "workflow", "ai"):
        score = add(score, notes, 0.35, "legal-tech transition signal")

    if loc_l and any(loc in loc_l for loc in PREFERRED_LOCS):
        score = add(score, notes, 0.20, "preferred location/remote signal")

    if has(title_l, *MEETING_HEAVY_TERMS):
        score -= 0.35
        notes.append("meeting/delivery-heavy tilt")

    if has(title_l, "director", "head of", "manager") and not has(title_l, "product manager", "program manager", "project manager"):
        score -= 0.15
        notes.append("management-heavy or less customer-proximate")

    if has(title_l, *CODING_HEAVY_ENGINEERING_TERMS) and not has(title_l, *APPLIED_SOLUTION_TERMS):
        score -= 0.45
        notes.append("coding-heavy engineering tilt")

    if has(title_l, "research scientist", "research engineer", "model training", "pre-training", "post-training", "inference engineer"):
        score -= 0.35
        notes.append("research/model-training tilt")

    if has(title_l, "account executive", "sales", "marketing", "technician", "aml officer", "supply chain", "maintenance", "area manager", "auditor", "security officer"):
        score -= 0.90
        notes.append("function mismatch/noise")

    score = round(max(1.8, min(4.6, score)), 1)
    if score >= 4.2:
        fit = "strong fit worth deeper review"
    elif score >= 3.7:
        fit = "plausible innovation/product fit"
    elif score >= 3.0:
        fit = "moderate fit under customer-innovation lens"
    else:
        fit = "lower fit under customer-innovation lens"

    note = f"Triage - {fit}"
    if notes:
        note += "; " + ", ".join(notes[:4])
    return f"Triage {score:.1f}/5", note


def main() -> int:
    parser = argparse.ArgumentParser(description="Score unscored job_postings rows.")
    parser.add_argument("--state", default="pending", choices=["pending", "shortlisted", "processed", "discarded", "expired"])
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        SELECT url, company_name, title, location
        FROM job_postings
        WHERE pipeline_state = ?
          AND (score IS NULL OR trim(score) = '')
        ORDER BY company_name, title
        """,
        (args.state,),
    ).fetchall()
    if args.limit is not None:
        rows = rows[: args.limit]

    updates = []
    for row in rows:
        score, note = score_posting(row["company_name"] or "", row["title"] or "", row["location"] or "")
        updates.append((score, note, row["url"], row["company_name"], row["title"]))

    for score, note, _url, company, title in updates:
        print(f"{score}\t{company}\t{title}\t{note}")

    if not args.dry_run and updates:
        con.executemany(
            """
            UPDATE job_postings
            SET score = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
            WHERE url = ?
            """,
            [(score, note, url) for score, note, url, _company, _title in updates],
        )
        con.commit()

    print(f"{'Would score' if args.dry_run else 'Scored'} {len(updates)} {args.state} posting(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
