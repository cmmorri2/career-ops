import { NextResponse } from "next/server";
import { execFileSync } from "node:child_process";
import { careerOpsRoot, hasPostingDb, postingDbPath } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["pending", "shortlisted", "discarded", "expired", "processed"]);

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqliteJson(sql: string): Array<Record<string, unknown>> {
  const out = execFileSync("sqlite3", ["-json", postingDbPath(), sql], {
    cwd: careerOpsRoot(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [];
}

function ensurePostingEventsSql(): string {
  return `
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
  `;
}

export async function POST(req: Request) {
  let body: { url?: string; id?: number; state?: string; restore?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const state = String(body.state ?? "").trim().toLowerCase();
  const url = String(body.url ?? "").trim();
  const id = Number(body.id);
  if (!ALLOWED.has(state)) {
    return NextResponse.json({ error: `unsupported state: ${state}` }, { status: 400 });
  }
  if (!url && !Number.isFinite(id)) {
    return NextResponse.json({ error: "url or id required" }, { status: 400 });
  }
  if (!hasPostingDb()) {
    return NextResponse.json({ error: "posting sqlite not found" }, { status: 404 });
  }

  try {
    const where = url ? `url = ${sqlString(url)}` : `id = ${Math.trunc(id)}`;
    const current = sqliteJson(`
      SELECT id, pipeline_state, status
      FROM job_postings
      WHERE ${where}
      LIMIT 1
    `)[0];
    if (!current) {
      return NextResponse.json({ error: "posting not found" }, { status: 404 });
    }
    const currentId = Number(current.id);
    const fromState = String(current.pipeline_state ?? "");
    const fromStatus = String(current.status ?? "");
    const isExpired = fromStatus === "expired" || fromState === "expired";
    const isRestore = body.restore === true;
    if (isExpired && (state === "pending" || state === "shortlisted") && !isRestore) {
      return NextResponse.json({ error: "posting is expired; restore it before changing triage state" }, { status: 409 });
    }
    if (isRestore && state !== "pending") {
      return NextResponse.json({ error: "restore can only move an expired posting to pending" }, { status: 400 });
    }
    const nextStatusSql = state === "expired"
      ? ", status = 'expired'"
      : isRestore
        ? ", status = CASE WHEN status = 'expired' THEN 'active' ELSE status END"
        : "";
    const toStatus = state === "expired" ? "expired" : isRestore && fromStatus === "expired" ? "active" : fromStatus;
    const eventType = isRestore ? "user_restored" : state === "discarded" ? "user_discarded" : state === "expired" ? "user_marked_expired" : "user_state_changed";

    const sql = `
      ${ensurePostingEventsSql()}
      UPDATE job_postings
      SET pipeline_state = ${sqlString(state)}${nextStatusSql}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${Math.trunc(currentId)};
      SELECT changes() AS changes;
    `;
    const parsed = sqliteJson(sql);
    const changes = Number(parsed[0]?.changes ?? 0);
    if (changes === 0) {
      return NextResponse.json({ error: "posting not found" }, { status: 404 });
    }
    execFileSync("sqlite3", [postingDbPath(), `
      INSERT INTO posting_events(
        posting_id, event_type, from_pipeline_state, to_pipeline_state,
        from_status, to_status, source
      )
      VALUES (
        ${Math.trunc(currentId)},
        ${sqlString(eventType)},
        ${sqlString(fromState)},
        ${sqlString(state)},
        ${sqlString(fromStatus)},
        ${sqlString(toStatus)},
        'web'
      );
    `], {
      cwd: careerOpsRoot(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return NextResponse.json({ ok: true, state });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
  }
}
