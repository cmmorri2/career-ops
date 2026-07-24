import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWrite } from "@/lib/core/safe-write";

/**
 * Resolve the career-ops "home" — the directory holding the user's sibling
 * files (cv.md, data/, reports/). In production the web/ app lives inside the
 * career-ops checkout, so the home is its parent (..). Dev overrides via
 * CAREER_OPS_ROOT to read the user's real (gitignored) data from a separate
 * checkout — see web/.env.local.
 */
export function careerOpsRoot(): string {
  const env = process.env.CAREER_OPS_ROOT?.trim();
  if (env) return env;
  return path.resolve(process.cwd(), "..");
}

/**
 * Absolute path to a core root script (e.g. doctor, verify-portals). The `.mjs`
 * is assembled here from the bare name so the literal never appears as a direct
 * `execFile`/`spawn` argument — Next's bundler statically traces such literals
 * as module imports and fails the production build otherwise.
 */
export function rootScript(nameNoExt: string): string {
  return path.join(careerOpsRoot(), `${nameNoExt}.mjs`);
}

// Feature-detect the core's `tracker.mjs delete --num` row-delete (#1200) by probing
// the local script source — older checkouts lack it, so the delete UI hides itself.
export function trackerCanDelete(): boolean {
  try {
    const src = fs.readFileSync(rootScript("tracker"), "utf8");
    return src.includes("delete") && src.includes("--num");
  } catch {
    return false;
  }
}

function read(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), rel), "utf8");
  } catch {
    return null;
  }
}

export type InboxJob = {
  id?: number;
  url: string;
  company: string;
  role: string;
  location?: string;
  compensation?: string;
  done: boolean;
  postedAt?: string;
  pipelineState?: "pending" | "shortlisted" | "processed" | "discarded" | "expired" | string;
  status?: string;
  score?: string;
  notes?: string;
  source?: string;
  reportPath?: string;
  pdfPath?: string;
};

export function postingDbPath(): string {
  return path.join(careerOpsRoot(), "data", "career-ops.sqlite");
}

export function hasPostingDb(): boolean {
  try {
    return fs.existsSync(postingDbPath());
  } catch {
    return false;
  }
}

function sqliteJson(sql: string): Array<Record<string, unknown>> {
  const out = execFileSync("sqlite3", ["-json", postingDbPath(), sql], {
    cwd: careerOpsRoot(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [];
}

function readSqliteInbox(): InboxJob[] | null {
  if (!hasPostingDb()) return null;
  try {
    const rows = sqliteJson(`
      SELECT id, url, company_name, title, location, compensation, first_seen,
             pipeline_state, status, score, notes, source, report_path, pdf_path
      FROM job_postings
      WHERE pipeline_state IN ('pending', 'shortlisted', 'expired')
      ORDER BY
        CASE pipeline_state WHEN 'shortlisted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
        COALESCE(first_seen, created_at) DESC,
        company_name COLLATE NOCASE,
        title COLLATE NOCASE
    `);
    return rows.map((r) => ({
      id: Number(r.id),
      done: false,
      url: String(r.url ?? ""),
      company: String(r.company_name ?? ""),
      role: String(r.title ?? ""),
      location: typeof r.location === "string" && r.location ? r.location : undefined,
      compensation: typeof r.compensation === "string" && r.compensation ? r.compensation : undefined,
      postedAt: typeof r.first_seen === "string" && r.first_seen ? r.first_seen : undefined,
      pipelineState: typeof r.pipeline_state === "string" ? r.pipeline_state : undefined,
      status: typeof r.status === "string" ? r.status : undefined,
      score: typeof r.score === "string" ? r.score : undefined,
      notes: typeof r.notes === "string" ? r.notes : undefined,
      source: typeof r.source === "string" ? r.source : undefined,
      reportPath: typeof r.report_path === "string" ? r.report_path : undefined,
      pdfPath: typeof r.pdf_path === "string" ? r.pdf_path : undefined,
    })).filter((j) => j.url && j.company && j.role);
  } catch {
    return null;
  }
}

/** Parse data/pipeline.md — `- [ ] URL | Company | Role [| Location [| Compensation]]`.
 *  Positional split (NOT a greedy trailing group): the optional 4th `location`
 *  (#1015) and 5th `compensation` (#1017) columns must NOT bleed into `role`;
 *  any further trailing columns are ignored gracefully. */
export function readInbox(): InboxJob[] {
  const sqliteInbox = readSqliteInbox();
  if (sqliteInbox) return sqliteInbox;
  const md = read("data/pipeline.md");
  if (!md) return [];
  const jobs: InboxJob[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (!m) continue;
    const parts = m[2].split("|").map((s) => s.trim());
    if (parts.length < 3 || !parts[0]) continue; // need at least url | company | role
    jobs.push({
      done: m[1].toLowerCase() === "x",
      url: parts[0],
      company: parts[1],
      role: parts[2],
      location: parts[3] || undefined, // optional 4th column (#1015)
      compensation: parts[4] || undefined, // optional 5th column (#1017); 6th+ ignored
    });
  }
  return jobs;
}

/**
 * Read data/scan-history.tsv → Map<url, first_seen(YYYY-MM-DD)>. The scanner
 * already stamps every discovered posting with the date it was first seen
 * (col 2), so we derive the inbox's freshness signal here WITHOUT touching the
 * core (see the inbox-triage build: freshness = option A, no scanner change).
 * Tolerant by construction: no file → empty map (freshness facet just hides);
 * a malformed row is skipped, never thrown (missing ≠ corrupt).
 */
export function readScanDates(): Map<string, string> {
  const tsv = read("data/scan-history.tsv");
  const dates = new Map<string, string>();
  if (!tsv) return dates;
  const lines = tsv.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (i === 0 && line.startsWith("url\t"))) continue; // skip header
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const url = line.slice(0, tab);
    const firstSeen = line.slice(tab + 1).split("\t")[0]?.trim();
    // keep the EARLIEST first_seen if a url recurs (it's "first" seen, after all)
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstSeen) && !dates.has(url)) dates.set(url, firstSeen);
  }
  return dates;
}

export type Application = {
  n: string;
  date: string;
  company: string;
  role: string;
  score: string;
  status: string;
  pdf: string;
  report: string;
  notes: string;
  location?: string;
  locationRegion?: string;
  workMode?: "Remote" | "RemoteFlex" | "Hybrid" | "Full" | string;
  payRange?: string;
  payMax?: number;
  paySource?: "POSTED" | "est" | string;
  lastContact?: string;
};

export type PipelinePosting = {
  id: number;
  url: string;
  company: string;
  role: string;
  location?: string;
  locationRegion?: string;
  compensation?: string;
  date: string;
  lastSeen?: string;
  status: string;
  pipelineState: "pending" | "shortlisted" | "processed" | "discarded" | "expired" | string;
  score: string;
  notes: string;
  source?: string;
  reportPath?: string;
  pdfPath?: string;
  deepFitScore?: number;
  deepStretchScore?: number;
  deepInterestScore?: number;
  applicationPriority?: string;
  deepReviewPath?: string;
  deepReviewedAt?: string;
  workMode?: "Remote" | "RemoteFlex" | "Hybrid" | "Full" | string;
  payRange?: string;
  payMax?: number;
  paySource?: "POSTED" | "est" | string;
  lastContact?: string;
};

export type PostingSnapshot = {
  id: number;
  postingId: number;
  capturedAt: string;
  title?: string;
  location?: string;
  description?: string;
  rawSource?: string;
};

export type PostingArtifact = {
  id: number;
  applicationId?: number;
  postingId?: number;
  artifactType: string;
  path: string;
  createdAt: string;
};

export type RoleDiscoveryLead = {
  id: number;
  clusterId: number;
  source: string;
  sourceDetail?: string;
  seedCompany?: string;
  seedTitle?: string;
  company: string;
  title: string;
  location?: string;
  workModel?: string;
  url?: string;
  triageScore?: number;
  triageLabel?: string;
  reviewStatus: string;
  sourceReceivedAt?: string;
};

export type RoleDiscoverySearch = {
  id: number;
  clusterId: number;
  query: string;
  source: string;
  targetCount: number;
  status: string;
  resultCount: number;
  notes?: string;
  results: RoleDiscoverySearchResult[];
};

export type RoleDiscoverySearchResult = {
  id: number;
  searchId: number;
  clusterId: number;
  url: string;
  company: string;
  title: string;
  location?: string;
  postedAt?: string;
  ats?: string;
  source: string;
  matchedKeyword?: string;
  note?: string;
  reviewStatus: string;
};

export type RoleDiscoveryCluster = {
  id: number;
  normalizedRole: string;
  displayRole: string;
  reviewStatus: string;
  coverageStatus: string;
  evidenceCount: number;
  linkedinCount: number;
  pipelineMatchCount: number;
  pipelineActiveCount: number;
  pipelineShortlistedCount: number;
  pipelineDiscardedCount: number;
  pipelineExpiredCount: number;
  applicationMatchCount: number;
  bestScore?: number;
  searchQuery?: string;
  notes?: string;
  leads: RoleDiscoveryLead[];
  searches: RoleDiscoverySearch[];
  pipelineMatches: RoleDiscoveryPipelineMatch[];
};

export type RoleDiscoveryPipelineMatch = {
  id: number;
  url: string;
  company: string;
  title: string;
  location?: string;
  pipelineState: string;
  status: string;
  score?: string;
  notes?: string;
};

export type TitleTrendCluster = {
  clusterKey: string;
  clusterLabel: string;
  count: number;
  activeCount: number;
  companies: string[];
  examples: { company: string; title: string }[];
};

export type TitleTrendDay = {
  date: string;
  total: number;
  clusters: TitleTrendCluster[];
};

const moneySpanRe = /~?(?:[$€£]|CHF ?|EUR ?|USD ?|GBP ?)\d[\d,]*(?:\.\d+)?[KkMm]?(?:\s*[-–]\s*(?:[$€£])?\d[\d,]*(?:\.\d+)?[KkMm]?)?/g;
const moneyPartRe = /(\d[\d,]*(?:\.\d+)?)\s*([KkMm]?)/g;
const isoDateRe = /\b20\d{2}-\d{2}-\d{2}\b/g;
const cityStateRe = /\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}),? (A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/;
const cityIntlRe = /\b(Porto|Lisbon|London|Berlin|Munich|Hamburg|Frankfurt|Cologne|D(?:ü|u)sseldorf|Stuttgart|Z(?:ü|u)rich|Geneva|Lausanne|Basel|Dublin|Cork|Amsterdam|Rotterdam|Eindhoven|Utrecht|Paris|Lyon|Madrid|Barcelona|Valencia|Stockholm|Gothenburg|Malm(?:ö|o)|Copenhagen|Oslo|Helsinki|Milan|Rome|Turin|Vienna|Brussels|Ghent|Antwerp|Luxembourg|Warsaw|Krak(?:ó|o)w|Wroc(?:ł|l)aw|Tallinn|Riga|Vilnius|Prague|Brno|Budapest|Bucharest|Sofia|Athens|Bengaluru|Bangalore|Singapore|Sydney|Toronto|Vancouver|Tel Aviv|S(?:ã|a)o Paulo)\b/i;
const estHintRe = /\(est[),;. ]|\best\)|\bmarket\b/i;

const stateNameToCode: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

const cityToCountry: Record<string, string> = {
  porto: "Portugal", lisbon: "Portugal", london: "UK", berlin: "Germany", munich: "Germany", hamburg: "Germany", frankfurt: "Germany",
  cologne: "Germany", dusseldorf: "Germany", düsseldorf: "Germany", stuttgart: "Germany", zurich: "Switzerland", zürich: "Switzerland",
  geneva: "Switzerland", lausanne: "Switzerland", basel: "Switzerland", dublin: "Ireland", cork: "Ireland", amsterdam: "Netherlands",
  rotterdam: "Netherlands", eindhoven: "Netherlands", utrecht: "Netherlands", paris: "France", lyon: "France", madrid: "Spain",
  barcelona: "Spain", valencia: "Spain", stockholm: "Sweden", gothenburg: "Sweden", malmo: "Sweden", malmö: "Sweden",
  copenhagen: "Denmark", oslo: "Norway", helsinki: "Finland", milan: "Italy", rome: "Italy", turin: "Italy", vienna: "Austria",
  brussels: "Belgium", ghent: "Belgium", antwerp: "Belgium", luxembourg: "Luxembourg", warsaw: "Poland", krakow: "Poland",
  kraków: "Poland", wroclaw: "Poland", wrocław: "Poland", tallinn: "Estonia", riga: "Latvia", vilnius: "Lithuania",
  prague: "Czech Republic", brno: "Czech Republic", budapest: "Hungary", bucharest: "Romania", sofia: "Bulgaria", athens: "Greece",
  bengaluru: "India", bangalore: "India", singapore: "Singapore", sydney: "Australia", toronto: "Canada", vancouver: "Canada",
  "tel aviv": "Israel", "sao paulo": "Brazil", "são paulo": "Brazil",
};

const countryAliases: [RegExp, string][] = [
  [/\b(united states|usa|u\.s\.|u\.s\.a\.|remote\s*[- ]\s*us|remote us|us remote|us only)\b/i, "US"],
  [/\b(canada|canadian)\b/i, "Canada"],
  [/\b(australia|australian)\b/i, "Australia"],
  [/\b(united kingdom|uk|england|scotland|wales|britain)\b/i, "UK"],
  [/\b(germany|deutschland)\b/i, "Germany"],
  [/\b(france|french)\b/i, "France"],
  [/\b(spain|spanish)\b/i, "Spain"],
  [/\b(portugal|portuguese)\b/i, "Portugal"],
  [/\b(ireland|irish)\b/i, "Ireland"],
  [/\b(netherlands|holland|dutch)\b/i, "Netherlands"],
  [/\b(sweden|swedish)\b/i, "Sweden"],
  [/\b(denmark|danish)\b/i, "Denmark"],
  [/\b(norway|norwegian)\b/i, "Norway"],
  [/\b(finland|finnish)\b/i, "Finland"],
  [/\b(italy|italian)\b/i, "Italy"],
  [/\b(switzerland|swiss|chf)\b/i, "Switzerland"],
  [/\b(belgium|belgian)\b/i, "Belgium"],
  [/\b(india|indian)\b/i, "India"],
  [/\b(singapore)\b/i, "Singapore"],
  [/\b(japan|japanese)\b/i, "Japan"],
  [/\b(brazil|brasil)\b/i, "Brazil"],
  [/\b(mexico|mexican)\b/i, "Mexico"],
  [/\b(israel|israeli)\b/i, "Israel"],
  [/\b(europe|emea|eu)\b/i, "Europe"],
  [/\b(apac)\b/i, "APAC"],
  [/\b(latam)\b/i, "LATAM"],
];

function payCeiling(span: string): number {
  let top = 0;
  for (const m of span.matchAll(moneyPartRe)) {
    let value = parseFloat(m[1].replaceAll(",", ""));
    if (!Number.isFinite(value)) continue;
    const suffix = m[2].toLowerCase();
    if (suffix === "k") value *= 1_000;
    if (suffix === "m") value *= 1_000_000;
    top = Math.max(top, value);
  }
  return top;
}

function normalizeLocationRegion(location: string | undefined, text: string): string | undefined {
  const combined = `${location ?? ""} ${text}`.trim();
  if (!combined) return undefined;
  const cityState = combined.match(cityStateRe);
  if (cityState) return cityState[2];

  const lower = combined.toLowerCase();
  for (const [stateName, code] of Object.entries(stateNameToCode)) {
    if (new RegExp(`\\b${stateName.replaceAll(" ", "\\s+")}\\b`, "i").test(lower)) return code;
  }
  const stateCode = combined.match(/\b(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/);
  if (stateCode) return stateCode[1];

  for (const [pattern, country] of countryAliases) {
    if (pattern.test(combined)) return country;
  }
  const intl = combined.match(cityIntlRe)?.[0]?.toLowerCase();
  if (intl) return cityToCountry[intl.replace("ü", "u").replace("ö", "o").replace("ł", "l").replace("ó", "o")] ?? cityToCountry[intl];
  return undefined;
}

function deriveApplicationFields(app: Application): Application {
  const lower = `${app.role} ${app.notes}`.toLowerCase();
  const notesCity = app.notes.match(cityStateRe);
  const roleCity = app.role.match(cityStateRe);
  const intl = app.notes.match(cityIntlRe) ?? app.role.match(cityIntlRe);
  const location = notesCity ? `${notesCity[1]}, ${notesCity[2]}` : roleCity ? `${roleCity[1]}, ${roleCity[2]}` : intl?.[0];

  let workMode = "";
  if (lower.includes("hybrid")) workMode = "Hybrid";
  else if (lower.includes("remote") && (lower.includes("flex") || lower.includes("remote-first") || lower.includes("remote first"))) workMode = "RemoteFlex";
  else if (lower.includes("remote")) workMode = "Remote";
  else if (lower.includes("onsite") || lower.includes("on-site") || lower.includes("in-office")) workMode = "Full";
  else if (location) workMode = "Full";

  const moneyMatches = [...app.notes.matchAll(moneySpanRe)].map((m) => m[0]);
  const payRange = moneyMatches.find((m) => /[-–]/.test(m)) ?? moneyMatches[0];
  const payMax = payRange ? payCeiling(payRange) : 0;
  let paySource = "";
  if (payRange) {
    if (lower.includes("(posted")) paySource = "POSTED";
    else if (estHintRe.test(lower)) paySource = "est";
  }

  let lastContact = app.date;
  for (const m of app.notes.matchAll(isoDateRe)) {
    if (m[0] > lastContact) lastContact = m[0];
  }

  return {
    ...app,
    location: location || undefined,
    locationRegion: normalizeLocationRegion(location, `${app.role} ${app.notes}`),
    workMode: workMode || undefined,
    payRange: payRange || undefined,
    payMax: payMax || undefined,
    paySource: paySource || undefined,
    lastContact: lastContact || undefined,
  };
}

function derivePostingFields(posting: PipelinePosting): PipelinePosting {
  const text = `${posting.role} ${posting.location ?? ""} ${posting.compensation ?? ""} ${posting.notes}`.trim();
  const lower = text.toLowerCase();
  const noteCity = (posting.notes || posting.compensation || "").match(cityStateRe);
  const roleCity = posting.role.match(cityStateRe);
  const rawLocation = posting.location?.trim();
  const intl = text.match(cityIntlRe);
  const location = rawLocation || (noteCity ? `${noteCity[1]}, ${noteCity[2]}` : roleCity ? `${roleCity[1]}, ${roleCity[2]}` : intl?.[0]);

  let workMode = "";
  if (lower.includes("hybrid")) workMode = "Hybrid";
  else if (lower.includes("remote") && (lower.includes("flex") || lower.includes("remote-first") || lower.includes("remote first"))) workMode = "RemoteFlex";
  else if (lower.includes("remote")) workMode = "Remote";
  else if (lower.includes("onsite") || lower.includes("on-site") || lower.includes("in-office")) workMode = "Full";
  else if (location) workMode = "Full";

  const moneyMatches = [...text.matchAll(moneySpanRe)].map((m) => m[0]);
  const payRange = moneyMatches.find((m) => /[-–]/.test(m)) ?? moneyMatches[0];
  const payMax = payRange ? payCeiling(payRange) : 0;
  let paySource = "";
  if (payRange) {
    if (lower.includes("(posted")) paySource = "POSTED";
    else if (estHintRe.test(lower) || lower.includes("note:")) paySource = "est";
  }

  let lastContact = posting.date;
  for (const m of text.matchAll(isoDateRe)) {
    if (m[0] > lastContact) lastContact = m[0];
  }

  return {
    ...posting,
    location: location || undefined,
    locationRegion: normalizeLocationRegion(location, text),
    workMode: workMode || undefined,
    payRange: payRange || undefined,
    payMax: payMax || undefined,
    paySource: paySource || undefined,
    lastContact: lastContact || undefined,
  };
}

function optionalNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const roleStopwords = new Set(["senior", "sr", "staff", "principal", "lead", "director", "head", "manager", "mgr", "associate", "level", "ii", "iii", "iv", "v", "remote", "usa", "us"]);

function roleTokens(title: string): Set<string> {
  return new Set(title.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((token) => token && !roleStopwords.has(token)));
}

function hasAny(tokens: Set<string>, ...needles: string[]): boolean {
  return needles.some((needle) => tokens.has(needle));
}

function normalizedRoleForTitle(title: string): string {
  const tokens = roleTokens(title);
  const hasAi = hasAny(tokens, "ai", "agentic", "agents", "genai", "ml", "machine", "conversational");
  if (hasAi && hasAny(tokens, "product", "pm")) return "ai_product_management";
  if (hasAi && hasAny(tokens, "solutions", "solution", "architect", "consultant", "consulting", "practitioner")) return "ai_solutions_architecture";
  if (hasAny(tokens, "forward", "deployed")) return "forward_deployed_ai";
  if (hasAny(tokens, "governance", "purview", "compliance")) return "data_governance";
  if (hasAny(tokens, "identity", "entra", "iam", "security")) return "identity_security";
  if (hasAny(tokens, "product", "pm")) return "product_management";
  if (hasAny(tokens, "solutions", "solution", "architect", "consultant", "consulting")) return "solutions_architecture";
  if (hasAny(tokens, "data", "analytics", "bi")) return "data_analytics";
  if (hasAny(tokens, "platform", "infrastructure")) return "platform_engineering";
  const key = [...tokens].sort().slice(0, 5).join("_");
  return key || title.toLowerCase().replace(/[^a-z0-9]+/g, "") || "unknown_role";
}

function roleClusterLabel(key: string): string {
  const labels: Record<string, string> = {
    ai_product_management: "AI Product Management",
    ai_solutions_architecture: "AI Solutions Architecture",
    forward_deployed_ai: "Forward Deployed AI",
    data_governance: "Data Governance",
    identity_security: "Identity / Security",
    product_management: "Product Management",
    solutions_architecture: "Solutions Architecture",
    data_analytics: "Data / Analytics",
    platform_engineering: "Platform Engineering",
    unknown_role: "Unknown Role",
  };
  if (labels[key]) return labels[key];
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function readPostings(): PipelinePosting[] {
  if (!hasPostingDb()) return [];
  try {
    const rows = sqliteJson(`
      SELECT id, url, company_name, title, location, compensation, first_seen, last_seen,
             status, pipeline_state, score, notes, source, report_path, pdf_path,
             deep_fit_score, deep_stretch_score, deep_interest_score,
             application_priority, deep_review_path, deep_reviewed_at, created_at
      FROM job_postings
      ORDER BY
        COALESCE(first_seen, created_at) DESC,
        company_name COLLATE NOCASE,
        title COLLATE NOCASE
    `);
    return rows.map((r) => derivePostingFields({
      id: Number(r.id),
      url: String(r.url ?? ""),
      company: String(r.company_name ?? ""),
      role: String(r.title ?? ""),
      location: typeof r.location === "string" && r.location ? r.location : undefined,
      compensation: typeof r.compensation === "string" && r.compensation ? r.compensation : undefined,
      date: String(r.first_seen ?? r.created_at ?? ""),
      lastSeen: typeof r.last_seen === "string" && r.last_seen ? r.last_seen : undefined,
      status: String(r.status ?? ""),
      pipelineState: typeof r.pipeline_state === "string" ? r.pipeline_state : "pending",
      score: String(r.score ?? ""),
      notes: String(r.notes ?? ""),
      source: typeof r.source === "string" && r.source ? r.source : undefined,
      reportPath: typeof r.report_path === "string" && r.report_path ? r.report_path : undefined,
      pdfPath: typeof r.pdf_path === "string" && r.pdf_path ? r.pdf_path : undefined,
      deepFitScore: optionalNumber(r.deep_fit_score),
      deepStretchScore: optionalNumber(r.deep_stretch_score),
      deepInterestScore: optionalNumber(r.deep_interest_score),
      applicationPriority: typeof r.application_priority === "string" && r.application_priority ? r.application_priority : undefined,
      deepReviewPath: typeof r.deep_review_path === "string" && r.deep_review_path ? r.deep_review_path : undefined,
      deepReviewedAt: typeof r.deep_reviewed_at === "string" && r.deep_reviewed_at ? r.deep_reviewed_at : undefined,
    })).filter((p) => p.id && p.url && p.company && p.role);
  } catch {
    return [];
  }
}

export function readTitleTrends(limitDates = 14, clustersPerDate = 8, examplesPerCluster = 3): TitleTrendDay[] {
  const byDate = new Map<string, PipelinePosting[]>();
  for (const posting of readPostings()) {
    const date = posting.date?.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)?.push(posting);
  }

  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, limitDates)
    .map(([date, postings]) => {
      const byCluster = new Map<string, PipelinePosting[]>();
      for (const posting of postings) {
        const key = normalizedRoleForTitle(posting.role);
        if (!byCluster.has(key)) byCluster.set(key, []);
        byCluster.get(key)?.push(posting);
      }

      const clusters = [...byCluster.entries()]
        .map(([clusterKey, rows]) => {
          const companies = [...new Set(rows.map((r) => r.company).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b))
            .slice(0, 5);
          const examples = rows
            .slice()
            .sort((a, b) => {
              const scoreDelta = Number.parseFloat(b.score || "0") - Number.parseFloat(a.score || "0");
              if (scoreDelta) return scoreDelta;
              return `${a.company} ${a.role}`.localeCompare(`${b.company} ${b.role}`);
            })
            .slice(0, examplesPerCluster)
            .map((r) => ({ company: r.company, title: r.role }));
          return {
            clusterKey,
            clusterLabel: roleClusterLabel(clusterKey),
            count: rows.length,
            activeCount: rows.filter((r) => r.pipelineState === "pending" || r.pipelineState === "shortlisted").length,
            companies,
            examples,
          };
        })
        .sort((a, b) => b.count - a.count || b.activeCount - a.activeCount || a.clusterLabel.localeCompare(b.clusterLabel))
        .slice(0, clustersPerDate);

      return { date, total: postings.length, clusters };
    });
}

export function findPosting(id: string | number): PipelinePosting | null {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0 || !hasPostingDb()) return null;
  try {
    const rows = sqliteJson(`
      SELECT id, url, company_name, title, location, compensation, first_seen, last_seen,
             status, pipeline_state, score, notes, source, report_path, pdf_path,
             deep_fit_score, deep_stretch_score, deep_interest_score,
             application_priority, deep_review_path, deep_reviewed_at, created_at
      FROM job_postings
      WHERE id = ${Math.trunc(n)}
      LIMIT 1
    `);
    const r = rows[0];
    if (!r) return null;
    return derivePostingFields({
      id: Number(r.id),
      url: String(r.url ?? ""),
      company: String(r.company_name ?? ""),
      role: String(r.title ?? ""),
      location: typeof r.location === "string" && r.location ? r.location : undefined,
      compensation: typeof r.compensation === "string" && r.compensation ? r.compensation : undefined,
      date: String(r.first_seen ?? r.created_at ?? ""),
      lastSeen: typeof r.last_seen === "string" && r.last_seen ? r.last_seen : undefined,
      status: String(r.status ?? ""),
      pipelineState: typeof r.pipeline_state === "string" ? r.pipeline_state : "pending",
      score: String(r.score ?? ""),
      notes: String(r.notes ?? ""),
      source: typeof r.source === "string" && r.source ? r.source : undefined,
      reportPath: typeof r.report_path === "string" && r.report_path ? r.report_path : undefined,
      pdfPath: typeof r.pdf_path === "string" && r.pdf_path ? r.pdf_path : undefined,
      deepFitScore: optionalNumber(r.deep_fit_score),
      deepStretchScore: optionalNumber(r.deep_stretch_score),
      deepInterestScore: optionalNumber(r.deep_interest_score),
      applicationPriority: typeof r.application_priority === "string" && r.application_priority ? r.application_priority : undefined,
      deepReviewPath: typeof r.deep_review_path === "string" && r.deep_review_path ? r.deep_review_path : undefined,
      deepReviewedAt: typeof r.deep_reviewed_at === "string" && r.deep_reviewed_at ? r.deep_reviewed_at : undefined,
    });
  } catch {
    return null;
  }
}

export function readPostingSnapshot(postingId: string | number): PostingSnapshot | null {
  const n = Number(postingId);
  if (!Number.isFinite(n) || n <= 0 || !hasPostingDb()) return null;
  try {
    const rows = sqliteJson(`
      SELECT id, posting_id, captured_at, title, location, description, raw_source
      FROM posting_snapshots
      WHERE posting_id = ${Math.trunc(n)}
      ORDER BY captured_at DESC
      LIMIT 1
    `);
    const r = rows[0];
    if (!r) return null;
    return {
      id: Number(r.id),
      postingId: Number(r.posting_id),
      capturedAt: String(r.captured_at ?? ""),
      title: typeof r.title === "string" && r.title ? r.title : undefined,
      location: typeof r.location === "string" && r.location ? r.location : undefined,
      description: typeof r.description === "string" && r.description ? r.description : undefined,
      rawSource: typeof r.raw_source === "string" && r.raw_source ? r.raw_source : undefined,
    };
  } catch {
    return null;
  }
}

export function readPostingArtifacts(postingId: string | number): PostingArtifact[] {
  const n = Number(postingId);
  if (!Number.isFinite(n) || n <= 0 || !hasPostingDb()) return [];
  try {
    const rows = sqliteJson(`
      SELECT id, application_id, posting_id, artifact_type, path, created_at
      FROM artifacts
      WHERE posting_id = ${Math.trunc(n)}
      ORDER BY created_at DESC, id DESC
    `);
    return rows.map((r) => ({
      id: Number(r.id),
      applicationId: optionalNumber(r.application_id),
      postingId: optionalNumber(r.posting_id),
      artifactType: String(r.artifact_type ?? ""),
      path: String(r.path ?? ""),
      createdAt: String(r.created_at ?? ""),
    })).filter((a) => a.id && a.artifactType && a.path);
  } catch {
    return [];
  }
}

export function readRoleDiscovery(): RoleDiscoveryCluster[] {
  if (!hasPostingDb()) return [];
  try {
    const clusters = sqliteJson(`
      SELECT id, normalized_role, display_role, review_status, coverage_status,
             evidence_count, linkedin_count, pipeline_match_count,
             pipeline_active_count, pipeline_shortlisted_count,
             pipeline_discarded_count, pipeline_expired_count,
             application_match_count, best_score, search_query, notes
      FROM role_discovery_clusters
      ORDER BY
        CASE review_status
          WHEN 'new' THEN 0
          WHEN 'review' THEN 1
          WHEN 'watching' THEN 2
          WHEN 'promoted' THEN 3
          ELSE 4
        END,
        CASE coverage_status WHEN 'under_covered' THEN 0 ELSE 1 END,
        COALESCE(best_score, 0) DESC,
        evidence_count DESC,
        display_role COLLATE NOCASE
    `);
    const leads = sqliteJson(`
      SELECT id, cluster_id, source, source_detail, seed_company, seed_title,
             company, title, location, work_model, url, triage_score, triage_label,
             review_status, source_received_at
      FROM role_discovery_leads
      ORDER BY COALESCE(triage_score, 0) DESC, company COLLATE NOCASE, title COLLATE NOCASE
    `);
    const searches = sqliteJson(`
      SELECT id, cluster_id, query, source, target_count, status, result_count, notes
      FROM role_discovery_searches
      ORDER BY created_at DESC, id DESC
    `);
    const searchResults = sqliteJson(`
      SELECT id, search_id, cluster_id, url, company, title, location, posted_at,
             ats, source, matched_keyword, note, review_status
      FROM role_discovery_search_results
      ORDER BY created_at DESC, id DESC
    `);
    const pipelineRows = sqliteJson(`
      SELECT id, url, company_name, title, location, pipeline_state, status, score, notes
      FROM job_postings
      ORDER BY
        CASE pipeline_state
          WHEN 'shortlisted' THEN 0
          WHEN 'pending' THEN 1
          WHEN 'discarded' THEN 2
          WHEN 'expired' THEN 3
          ELSE 4
        END,
        COALESCE(score, '') DESC,
        company_name COLLATE NOCASE,
        title COLLATE NOCASE
    `);
    const leadsByCluster = new Map<number, RoleDiscoveryLead[]>();
    for (const r of leads) {
      const clusterId = Number(r.cluster_id);
      const row: RoleDiscoveryLead = {
        id: Number(r.id),
        clusterId,
        source: String(r.source ?? ""),
        sourceDetail: typeof r.source_detail === "string" && r.source_detail ? r.source_detail : undefined,
        seedCompany: typeof r.seed_company === "string" && r.seed_company ? r.seed_company : undefined,
        seedTitle: typeof r.seed_title === "string" && r.seed_title ? r.seed_title : undefined,
        company: String(r.company ?? ""),
        title: String(r.title ?? ""),
        location: typeof r.location === "string" && r.location ? r.location : undefined,
        workModel: typeof r.work_model === "string" && r.work_model ? r.work_model : undefined,
        url: typeof r.url === "string" && r.url ? r.url : undefined,
        triageScore: optionalNumber(r.triage_score),
        triageLabel: typeof r.triage_label === "string" && r.triage_label ? r.triage_label : undefined,
        reviewStatus: String(r.review_status ?? ""),
        sourceReceivedAt: typeof r.source_received_at === "string" && r.source_received_at ? r.source_received_at : undefined,
      };
      if (!leadsByCluster.has(clusterId)) leadsByCluster.set(clusterId, []);
      leadsByCluster.get(clusterId)?.push(row);
    }
    const searchesByCluster = new Map<number, RoleDiscoverySearch[]>();
    const pipelineByRole = new Map<string, RoleDiscoveryPipelineMatch[]>();
    for (const r of pipelineRows) {
      const role = normalizedRoleForTitle(String(r.title ?? ""));
      const row: RoleDiscoveryPipelineMatch = {
        id: Number(r.id),
        url: String(r.url ?? ""),
        company: String(r.company_name ?? ""),
        title: String(r.title ?? ""),
        location: typeof r.location === "string" && r.location ? r.location : undefined,
        pipelineState: String(r.pipeline_state ?? ""),
        status: String(r.status ?? ""),
        score: typeof r.score === "string" && r.score ? r.score : undefined,
        notes: typeof r.notes === "string" && r.notes ? r.notes : undefined,
      };
      if (!pipelineByRole.has(role)) pipelineByRole.set(role, []);
      pipelineByRole.get(role)?.push(row);
    }
    const resultsBySearch = new Map<number, RoleDiscoverySearchResult[]>();
    for (const r of searchResults) {
      const searchId = Number(r.search_id);
      const row: RoleDiscoverySearchResult = {
        id: Number(r.id),
        searchId,
        clusterId: Number(r.cluster_id),
        url: String(r.url ?? ""),
        company: String(r.company ?? ""),
        title: String(r.title ?? ""),
        location: typeof r.location === "string" && r.location ? r.location : undefined,
        postedAt: typeof r.posted_at === "string" && r.posted_at ? r.posted_at : undefined,
        ats: typeof r.ats === "string" && r.ats ? r.ats : undefined,
        source: String(r.source ?? ""),
        matchedKeyword: typeof r.matched_keyword === "string" && r.matched_keyword ? r.matched_keyword : undefined,
        note: typeof r.note === "string" && r.note ? r.note : undefined,
        reviewStatus: String(r.review_status ?? ""),
      };
      if (!resultsBySearch.has(searchId)) resultsBySearch.set(searchId, []);
      resultsBySearch.get(searchId)?.push(row);
    }
    for (const r of searches) {
      const clusterId = Number(r.cluster_id);
      const id = Number(r.id);
      const row: RoleDiscoverySearch = {
        id,
        clusterId,
        query: String(r.query ?? ""),
        source: String(r.source ?? ""),
        targetCount: Number(r.target_count ?? 0),
        status: String(r.status ?? ""),
        resultCount: Number(r.result_count ?? 0),
        notes: typeof r.notes === "string" && r.notes ? r.notes : undefined,
        results: resultsBySearch.get(id) ?? [],
      };
      if (!searchesByCluster.has(clusterId)) searchesByCluster.set(clusterId, []);
      searchesByCluster.get(clusterId)?.push(row);
    }
    return clusters.map((r) => {
      const id = Number(r.id);
      return {
        id,
        normalizedRole: String(r.normalized_role ?? ""),
        displayRole: String(r.display_role ?? ""),
        reviewStatus: String(r.review_status ?? ""),
        coverageStatus: String(r.coverage_status ?? ""),
        evidenceCount: Number(r.evidence_count ?? 0),
        linkedinCount: Number(r.linkedin_count ?? 0),
        pipelineMatchCount: Number(r.pipeline_match_count ?? 0),
        pipelineActiveCount: Number(r.pipeline_active_count ?? 0),
        pipelineShortlistedCount: Number(r.pipeline_shortlisted_count ?? 0),
        pipelineDiscardedCount: Number(r.pipeline_discarded_count ?? 0),
        pipelineExpiredCount: Number(r.pipeline_expired_count ?? 0),
        applicationMatchCount: Number(r.application_match_count ?? 0),
        bestScore: optionalNumber(r.best_score),
        searchQuery: typeof r.search_query === "string" && r.search_query ? r.search_query : undefined,
        notes: typeof r.notes === "string" && r.notes ? r.notes : undefined,
        leads: leadsByCluster.get(id) ?? [],
        searches: searchesByCluster.get(id) ?? [],
        pipelineMatches: (pipelineByRole.get(String(r.normalized_role ?? "")) ?? []).slice(0, 8),
      };
    }).filter((r) => r.id && r.normalizedRole && r.displayRole);
  } catch {
    return [];
  }
}

function readSqliteApplications(): Application[] | null {
  if (!hasPostingDb()) return null;
  try {
    const rows = sqliteJson(`
      SELECT tracker_num, date, company, role, score, status, pdf, report, notes
      FROM applications
      ORDER BY tracker_num
    `);
    if (rows.length === 0) return null;
    return rows.map((r) => deriveApplicationFields({
      n: String(r.tracker_num ?? ""),
      date: String(r.date ?? ""),
      company: String(r.company ?? ""),
      role: String(r.role ?? ""),
      score: String(r.score ?? ""),
      status: String(r.status ?? ""),
      pdf: String(r.pdf ?? ""),
      report: String(r.report ?? ""),
      notes: String(r.notes ?? ""),
    })).filter((r) => r.n && r.company && r.role);
  } catch {
    return null;
  }
}

/**
 * Parse data/applications.md — the tracker table (source of truth).
 * Column order: # | Date | Company | Role | Score | Status | PDF | Report | Notes
 * (note: score BEFORE status, per the core data contract).
 */
export function readApplications(): Application[] {
  const sqliteApplications = readSqliteApplications();
  if (sqliteApplications) return sqliteApplications;
  const md = read("data/applications.md");
  if (!md) return [];
  const rows: Application[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    // Tolerate both layouts: the current 9-col tracker and older variants
    // where the Notes column is absent (8 cells). Score is always before Status.
    if (cells.length < 8) continue;
    if (cells[0] === "#" || /^:?-{2,}:?$/.test(cells[0])) continue; // header / separator
    const [n, date, company, role, score, status, pdf, report, ...rest] = cells;
    rows.push(deriveApplicationFields({ n, date, company, role, score, status, pdf, report, notes: rest.join(" | ") }));
  }
  return rows;
}

/**
 * Server-side lifecycle of the user's setup — mirrors the prerequisite list that
 * doctor.mjs uses (cv.md, config/profile.yml, modes/_profile.md, portals.yml), by
 * plain file-stat (no subprocess). Drives the home branch: first-run (no CV) →
 * the CV takeover; in-between (CV but no profile) → gentle nudges; established.
 */
export type LifecyclePhase = "first-run" | "in-between" | "established";
/**
 * Server-side lifecycle, mirroring the core doctor.mjs prerequisite list with the
 * SAME existsSync semantics (the SSOT the OnboardingBanner already reads via
 * /api/doctor). The 4 user-layer prereqs: cv.md, config/profile.yml,
 * modes/_profile.md, portals.yml.
 *   - first-run  → a TRULY empty install (no cv AND no data): the CV takeover.
 *     CRITICAL back-compat (maintainer): NEVER force onboarding on a user who
 *     already has data (a full pipeline/tracker with no cv.md is valid).
 *   - in-between → has cv/data but setup incomplete: dashboard + the nudge banner.
 *   - established → all 4 prereqs present.
 * onboardingNeeded mirrors doctor.mjs: true if ANY prereq is missing → show banner.
 */
export function doctorState(): {
  phase: LifecyclePhase;
  onboardingNeeded: boolean;
  missing: string[];
  hasCv: boolean;
  hasData: boolean;
} {
  const has = (rel: string) => {
    try {
      return fs.existsSync(path.join(careerOpsRoot(), rel));
    } catch {
      return false;
    }
  };
  const prereqs: [string, string][] = [
    ["cv.md", "cv.md"],
    ["config/profile.yml", "config/profile.yml"],
    ["modes/_profile.md", "modes/_profile.md"],
    ["portals.yml", "portals.yml"],
  ];
  const missing = prereqs.filter(([rel]) => !has(rel)).map(([, label]) => label);
  const hasCv = has("cv.md");
  const hasData = readApplications().length > 0 || readInbox().some((j) => !j.done);
  const onboardingNeeded = missing.length > 0;
  const phase: LifecyclePhase = !hasCv && !hasData ? "first-run" : onboardingNeeded ? "in-between" : "established";
  return { phase, onboardingNeeded, missing, hasCv, hasData };
}

export type PipelineSummary = {
  root: string;
  rootExists: boolean;
  inbox: InboxJob[];
  applications: Application[];
  postings: PipelinePosting[];
};

export function pipelineSummary(): PipelineSummary {
  const root = careerOpsRoot();
  const scanDates = readScanDates();
  return {
    root,
    rootExists: fs.existsSync(root),
    // join the freshness date (first_seen) onto each raw posting — the inbox's
    // triage view orders/faceted-filters on it entirely client-side.
    inbox: readInbox().map((j) => ({ ...j, postedAt: scanDates.get(j.url) })),
    applications: readApplications(),
    postings: readPostings(),
  };
}

export type ReportData = { content: string; file: string };

/** Locate the evaluation report for an application number
 *  (reports/{n}-{slug}-{date}.md; the leading number may be zero-padded). */
export function findReportFile(n: string): string | null {
  const target = parseInt(n, 10);
  if (Number.isNaN(target)) return null;
  let files: string[];
  try {
    files = fs.readdirSync(path.join(careerOpsRoot(), "reports"));
  } catch {
    return null;
  }
  const match = files.find((f) => f.endsWith(".md") && parseInt(f, 10) === target);
  return match ? path.join(careerOpsRoot(), "reports", match) : null;
}

export function readReport(n: string): ReportData | null {
  const file = findReportFile(n);
  if (!file) return null;
  try {
    return { content: fs.readFileSync(file, "utf8"), file: path.basename(file) };
  } catch {
    return null;
  }
}

export function findApplication(n: string): Application | null {
  return readApplications().find((a) => a.n === n) ?? null;
}

/** The CANONICAL user-customization file the CLI/TUI reads. Durable facts the
 *  web assistant learns go HERE (single source of truth) inside a managed marker
 *  block — so the CLI sees them too. No web-only memory store (that would drift). */
export function profilePath(): string {
  return path.join(careerOpsRoot(), "modes", "_profile.md");
}

const NOTES_START = "<!-- co-web-notes:start -->";
const NOTES_END = "<!-- co-web-notes:end -->";

/** Read back ONLY the web-assistant managed notes from modes/_profile.md (small,
 *  focused — the agent reads the rest of the canonical files itself). Falls back
 *  to the legacy web-only memory file for back-compat. */
export function readMemory(): string {
  try {
    const md = fs.readFileSync(profilePath(), "utf8");
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) return md.slice(i + NOTES_START.length, j).trim();
  } catch {
    /* no _profile.md yet */
  }
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), ".career-ops-web", "memory.md"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Append a durable fact to the canonical modes/_profile.md (creating the file +
 *  managed block if needed), PRESERVING existing user content. */
export function rememberFact(fact: string): "ok" | "deduped" | "error" {
  const f = fact.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!f) return "deduped";
  const p = profilePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let md = "";
    try {
      md = fs.readFileSync(p, "utf8");
    } catch {
      md = "";
    }
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) {
      if (md.slice(i, j).includes(f)) return "deduped";
      atomicWrite(p, md.slice(0, j) + `- ${f}\n` + md.slice(j));
      return "ok";
    }
    if (md.includes(f)) return "deduped";
    const section = `\n\n## Notes from the web assistant\n${NOTES_START}\n- ${f}\n${NOTES_END}\n`;
    const base = md.trim() ? md.replace(/\n*$/, "\n") : "# Profile customization\n";
    atomicWrite(p, base + section);
    return "ok";
  } catch {
    return "error";
  }
}
