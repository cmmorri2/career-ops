import { execFileSync } from "node:child_process";
import { postingDbPath } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set(["new", "review", "ignored", "promoted", "watching"]);

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  const status = String(body.status ?? "");
  const notes = typeof body.notes === "string" ? body.notes : "";
  if (!Number.isFinite(id) || id <= 0) {
    return Response.json({ error: "Invalid cluster id." }, { status: 400 });
  }
  if (!STATUSES.has(status)) {
    return Response.json({ error: "Invalid review status." }, { status: 400 });
  }
  const script = `
import os, sqlite3
db = os.environ["DB"]
cluster_id = int(os.environ["CLUSTER_ID"])
status = os.environ["REVIEW_STATUS"]
notes = os.environ.get("NOTES", "")
con = sqlite3.connect(db)
try:
    con.execute(
        "UPDATE role_discovery_clusters SET review_status = ?, notes = NULLIF(?, ''), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (status, notes, cluster_id),
    )
    con.commit()
    print("ok")
finally:
    con.close()
`;
  try {
    execFileSync("python3", ["-c", script], {
      env: {
        ...process.env,
        DB: postingDbPath(),
        CLUSTER_ID: String(Math.trunc(id)),
        REVIEW_STATUS: status,
        NOTES: notes,
      },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
