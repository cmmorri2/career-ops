import { execFileSync } from "node:child_process";
import { runDiscovery } from "@/lib/core/scan";
import { postingDbPath } from "@/lib/career-ops";
import { ATS_SOURCES, type AtsSource, type DiscoveredOffer, type ExploreFilters } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STOP = new Set([
  "senior",
  "sr",
  "staff",
  "principal",
  "lead",
  "director",
  "manager",
  "associate",
  "jobs",
  "remote",
  "united",
  "states",
]);

function keywordsFrom(text: string): string[] {
  const lower = text.toLowerCase();
  const phrases = [
    "agentic ai",
    "ai agents",
    "conversational ai",
    "forward deployed",
    "solutions architect",
    "solution architect",
    "solutions consultant",
    "product manager",
    "technical product",
  ].filter((phrase) => lower.includes(phrase));
  const tokens = lower
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP.has(token));
  const selected = tokens.filter((token) =>
    ["ai", "agentic", "agents", "genai", "product", "platform", "solutions", "solution", "architect", "consultant", "consulting", "technical", "deployed", "workflow"].includes(token),
  );
  return Array.from(new Set([...phrases, ...selected])).slice(0, 8);
}

function listStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function atsSources(value: unknown): AtsSource[] {
  const incoming = listStrings(value).map((item) => item.toLowerCase());
  const out = incoming.filter((item): item is AtsSource => (ATS_SOURCES as readonly string[]).includes(item));
  return out.length ? Array.from(new Set(out)) : ["greenhouse", "ashby"];
}

function loadSearch(searchId: number): { id: number; clusterId: number; query: string; targetCount: number; displayRole: string } | null {
  const script = `
import json, os, sqlite3
con = sqlite3.connect(os.environ["DB"])
con.row_factory = sqlite3.Row
try:
    row = con.execute(
        """
        SELECT s.id, s.cluster_id, s.query, s.target_count, c.display_role
        FROM role_discovery_searches s
        JOIN role_discovery_clusters c ON c.id = s.cluster_id
        WHERE s.id = ?
        LIMIT 1
        """,
        (int(os.environ["SEARCH_ID"]),),
    ).fetchone()
    print(json.dumps(dict(row) if row else None))
finally:
    con.close()
`;
  const out = execFileSync("python3", ["-c", script], {
    env: { ...process.env, DB: postingDbPath(), SEARCH_ID: String(searchId) },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim();
  const row = JSON.parse(out || "null");
  if (!row) return null;
  return {
    id: Number(row.id),
    clusterId: Number(row.cluster_id),
    query: String(row.query ?? ""),
    targetCount: Number(row.target_count ?? 10),
    displayRole: String(row.display_role ?? ""),
  };
}

function storeResults(searchId: number, clusterId: number, offers: DiscoveredOffer[]) {
  const script = `
import json, os, sqlite3
offers = json.loads(os.environ["OFFERS"])
con = sqlite3.connect(os.environ["DB"])
try:
    con.execute("UPDATE role_discovery_searches SET status = 'searched', result_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (len(offers), int(os.environ["SEARCH_ID"])))
    for offer in offers:
        con.execute(
            """
            INSERT INTO role_discovery_search_results(
              search_id, cluster_id, url, company, title, location, posted_at,
              ats, source, matched_keyword, note
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'role-discovery-search', ?, ?)
            ON CONFLICT(search_id, url) DO UPDATE SET
              company=excluded.company,
              title=excluded.title,
              location=excluded.location,
              posted_at=excluded.posted_at,
              ats=excluded.ats,
              matched_keyword=excluded.matched_keyword,
              note=excluded.note,
              updated_at=CURRENT_TIMESTAMP
            """,
            (
              int(os.environ["SEARCH_ID"]),
              int(os.environ["CLUSTER_ID"]),
              offer.get("url", ""),
              offer.get("company", ""),
              offer.get("title", ""),
              offer.get("location", ""),
              offer.get("postedAt", ""),
              offer.get("ats", ""),
              offer.get("matchedKeyword", ""),
              offer.get("note", ""),
            ),
        )
    con.commit()
finally:
    con.close()
`;
  execFileSync("python3", ["-c", script], {
    env: {
      ...process.env,
      DB: postingDbPath(),
      SEARCH_ID: String(searchId),
      CLUSTER_ID: String(clusterId),
      OFFERS: JSON.stringify(offers),
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const searchId = Number(body.searchId);
  if (!Number.isFinite(searchId) || searchId <= 0) {
    return Response.json({ error: "Invalid search id." }, { status: 400 });
  }
  const search = loadSearch(Math.trunc(searchId));
  if (!search) return Response.json({ error: "Search batch not found." }, { status: 404 });

  const requestedFilters = body.filters && typeof body.filters === "object" ? body.filters as Record<string, unknown> : {};
  const positive = listStrings(requestedFilters.positive).length
    ? listStrings(requestedFilters.positive).slice(0, 12)
    : keywordsFrom(`${search.displayRole} ${search.query}`);
  if (!positive.length) {
    return Response.json({ error: "No usable search keywords for this role cluster." }, { status: 400 });
  }

  const filters: ExploreFilters = {
    positive,
    negative: listStrings(requestedFilters.negative).slice(0, 12),
    allow: [],
    block: [],
    alwaysAllow: [],
    sinceDays: clampNumber(requestedFilters.sinceDays, 1, 60, 14),
    ats: atsSources(requestedFilters.ats),
    limitPerAts: clampNumber(requestedFilters.limitPerAts, 10, 150, 25),
  };
  const offers = await runDiscovery(filters, () => {});
  const wanted = Math.max(1, Math.min(25, search.targetCount || 10));
  const bounded = offers.slice(0, wanted).map((offer) => ({
    ...offer,
    source: "role-discovery-search",
    note: `Role discovery search: ${search.displayRole}`,
  }));
  storeResults(search.id, search.clusterId, bounded);
  return Response.json({ ok: true, searchId: search.id, filters, count: bounded.length, offers: bounded });
}
