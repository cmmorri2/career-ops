import { NextResponse } from "next/server";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, hasPostingDb, postingDbPath } from "@/lib/career-ops";
import { canonicalizeStatus } from "@/lib/core/states";
import { atomicWrite } from "@/lib/core/safe-write";

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlValue(value?: string): string {
  const v = value?.trim();
  return v ? sqlString(v) : "NULL";
}

type StatusEventDetail = {
  stage?: string;
  outcome?: string;
  reason?: string;
  source?: string;
  rawText?: string;
  notes?: string;
};

function updateSqliteStatus(n: string, status: string, detail: StatusEventDetail = {}): boolean {
  if (!hasPostingDb()) return false;
  const trackerNum = Number(n);
  if (!Number.isFinite(trackerNum)) return false;
  const eventNotes = detail.notes?.trim() || "Status changed from web UI";
  const outcome = detail.outcome?.trim() || (status === "Rejected" ? "rejected" : undefined);
  const sql = `
    UPDATE applications
    SET status = ${sqlString(status)}, updated_at = CURRENT_TIMESTAMP
    WHERE tracker_num = ${Math.trunc(trackerNum)};
    INSERT INTO application_events (application_id, event_at, status, notes, stage, outcome, reason, source, raw_text)
    SELECT id, CURRENT_TIMESTAMP, ${sqlString(status)}, ${sqlString(eventNotes)},
           ${sqlValue(detail.stage)}, ${sqlValue(outcome)}, ${sqlValue(detail.reason)},
           ${sqlValue(detail.source)}, ${sqlValue(detail.rawText)}
    FROM applications
    WHERE tracker_num = ${Math.trunc(trackerNum)}
      AND changes() > 0;
    SELECT changes() AS changes;
  `;
  try {
    const out = execFileSync("sqlite3", ["-json", postingDbPath(), sql], {
      cwd: careerOpsRoot(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }).trim();
    const parsed = out ? JSON.parse(out) : [];
    return Array.isArray(parsed) && Number(parsed[0]?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

// Writeback: UPDATE the status cell of an EXISTING tracker row only. Never adds
// rows — per the core data contract, new rows go through the TSV + merge flow.
// HARDENED: validate against the 8 canonical states (states.yml SSOT); reject any
// value with table-breaking chars (| \r \n **) that would scramble the row; detect
// the Status column from the header (8- and 9-col layouts); atomic write.
export async function POST(req: Request) {
  let body: { n?: string; status?: string } & StatusEventDetail;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { n, status } = body;
  if (!n || typeof status !== "string" || !status.trim()) {
    return NextResponse.json({ error: "n and status required" }, { status: 400 });
  }
  if (/[|\r\n*]/.test(status)) {
    return NextResponse.json({ error: "invalid status (table-breaking characters)" }, { status: 400 });
  }
  const canon = canonicalizeStatus(status);
  if (!canon) {
    return NextResponse.json({ error: `not a canonical status: ${status}` }, { status: 400 });
  }

  const sqliteChanged = updateSqliteStatus(n, canon, body);

  const file = path.join(careerOpsRoot(), "data", "applications.md");
  let md: string;
  try {
    md = fs.readFileSync(file, "utf8");
  } catch {
    if (sqliteChanged) return NextResponse.json({ ok: true, status: canon, source: "sqlite" });
    return NextResponse.json({ error: "tracker not found" }, { status: 404 });
  }

  const lines = md.split("\n");
  // Find the Status column index from the header row (robust to 8- vs 9-col).
  let statusIdx = 6;
  for (const l of lines) {
    if (!l.trim().startsWith("|")) continue;
    const cells = l.split("|").map((c) => c.trim().toLowerCase());
    const idx = cells.findIndex((c) => c === "status");
    if (idx > 0) {
      statusIdx = idx;
      break;
    }
    if (/^:?-{2,}:?$/.test(cells[1] ?? "")) break; // hit the separator → no header match, keep default
  }

  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const parts = lines[i].split("|");
    if (parts.length < 8) continue;
    if (parts[1].trim() !== String(n)) continue;
    if (statusIdx >= parts.length - 1) continue; // guard malformed row
    parts[statusIdx] = ` ${canon} `;
    lines[i] = parts.join("|");
    changed = true;
    break;
  }
  if (!changed) {
    if (sqliteChanged) return NextResponse.json({ ok: true, status: canon, source: "sqlite" });
    return NextResponse.json({ error: "row not found" }, { status: 404 });
  }

  try {
    atomicWrite(file, lines.join("\n"));
  } catch {
    if (sqliteChanged) return NextResponse.json({ ok: true, status: canon, source: "sqlite" });
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, status: canon, source: sqliteChanged ? "sqlite+markdown" : "markdown" });
}
