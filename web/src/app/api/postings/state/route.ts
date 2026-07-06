import { NextResponse } from "next/server";
import { execFileSync } from "node:child_process";
import { careerOpsRoot, hasPostingDb, postingDbPath } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["pending", "shortlisted", "discarded", "expired", "processed"]);

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function POST(req: Request) {
  let body: { url?: string; id?: number; state?: string };
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
    const sql = url
      ? `
          UPDATE job_postings
          SET pipeline_state = ${sqlString(state)}, updated_at = CURRENT_TIMESTAMP
          WHERE url = ${sqlString(url)};
          SELECT changes() AS changes;
        `
      : `
          UPDATE job_postings
          SET pipeline_state = ${sqlString(state)}, updated_at = CURRENT_TIMESTAMP
          WHERE id = ${Math.trunc(id)};
          SELECT changes() AS changes;
        `;
    const out = execFileSync("sqlite3", ["-json", postingDbPath(), sql], {
      cwd: careerOpsRoot(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }).trim();
    const parsed = out ? JSON.parse(out) : [];
    const changes = Array.isArray(parsed) ? Number(parsed[0]?.changes ?? 0) : 0;
    if (changes === 0) {
      return NextResponse.json({ error: "posting not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, state });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
  }
}
