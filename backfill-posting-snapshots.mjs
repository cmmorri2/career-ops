#!/usr/bin/env node

/**
 * backfill-posting-snapshots.mjs -- Fetch and persist missing JD snapshots from SQLite rows.
 *
 * This is intentionally separate from liveness checks: expiration sweeps should
 * stay cheap and state-focused, while backfill can run in bounded, rate-limited
 * batches to build a corpus for later parsing/scoring experiments.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { pathToFileURL } from 'url';
import { resolveAtsApi } from './liveness-api.mjs';
import { buildSnapshotRecord } from './record-posting-snapshot.mjs';

const DEFAULT_DB = 'data/career-ops.sqlite';
const DEFAULT_SNAPSHOTS = process.env.CAREER_OPS_POSTING_SNAPSHOTS || 'data/cache/posting-snapshots.jsonl';
const DEFAULT_STATES = ['shortlisted', 'applied', 'processed'];
const ALLOWED_STATES = new Set(['pending', 'shortlisted', 'applied', 'processed', 'discarded', 'expired']);
const USER_AGENT = 'career-ops-snapshot-backfill/1.0';
const MIN_DESCRIPTION_CHARS = 160;

function usage(exitCode = 0) {
  console.log(`Usage: node backfill-posting-snapshots.mjs [options]

Options:
  --db PATH                         SQLite DB path (default: data/career-ops.sqlite)
  --out PATH                        Snapshot JSONL path (default: data/cache/posting-snapshots.jsonl)
  --states LIST                     Comma-separated states (default: shortlisted,applied,processed)
  --include-discarded-with-notes    Also include discarded rows with non-empty notes
  --limit N                         Fetch at most N missing snapshots
  --dry-run                         Print what would be fetched without writing
  --json                            Print JSON summary only
  --summary-only                    Print counts without per-row details
  --help                            Show this help

Examples:
  node backfill-posting-snapshots.mjs --limit 25
  node backfill-posting-snapshots.mjs --include-discarded-with-notes --limit 100
`);
  process.exit(exitCode);
}

function parseList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseStates(raw) {
  const states = parseList(raw).map((s) => s.toLowerCase());
  if (!states.length) throw new Error('--states must name at least one state');
  for (const state of states) {
    if (!ALLOWED_STATES.has(state)) throw new Error(`unsupported state: ${state}`);
  }
  return [...new Set(states)];
}

function parseLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error('--limit must be a positive integer');
  return n;
}

export function parseArgs(argv) {
  const opts = {
    db: process.env.CAREER_OPS_DB || DEFAULT_DB,
    out: DEFAULT_SNAPSHOTS,
    states: DEFAULT_STATES,
    includeDiscardedWithNotes: false,
    limit: null,
    dryRun: false,
    json: false,
    summaryOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--summary-only') opts.summaryOnly = true;
    else if (arg === '--include-discarded-with-notes') opts.includeDiscardedWithNotes = true;
    else if (arg === '--db') opts.db = argv[++i];
    else if (arg.startsWith('--db=')) opts.db = arg.slice('--db='.length);
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length);
    else if (arg === '--states') opts.states = parseStates(argv[++i]);
    else if (arg.startsWith('--states=')) opts.states = parseStates(arg.slice('--states='.length));
    else if (arg === '--limit') opts.limit = parseLimit(argv[++i]);
    else if (arg.startsWith('--limit=')) opts.limit = parseLimit(arg.slice('--limit='.length));
    else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

async function loadSqlite() {
  const origEmit = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    const text = typeof warning === 'string' ? warning : warning?.message || '';
    if (text.includes('SQLite is an experimental feature')) return;
    return origEmit.call(process, warning, ...args);
  };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return DatabaseSync;
  } finally {
    process.emitWarning = origEmit;
  }
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function loadMissingSnapshotRows(db, opts) {
  const states = opts.states.map(quote).join(', ');
  const discardedClause = opts.includeDiscardedWithNotes
    ? "OR (jp.pipeline_state = 'discarded' AND COALESCE(jp.notes, '') <> '')"
    : '';
  const limitSql = opts.limit ? `LIMIT ${opts.limit}` : '';
  return db.prepare(`
    SELECT jp.id, jp.url, jp.company_name, jp.title, jp.location, jp.source,
           jp.pipeline_state, jp.status, jp.notes
    FROM job_postings jp
    LEFT JOIN posting_snapshots ps ON ps.posting_id = jp.id
    WHERE ps.id IS NULL
      AND jp.url IS NOT NULL
      AND trim(jp.url) <> ''
      AND COALESCE(jp.status, '') <> 'expired'
      AND (
        jp.pipeline_state IN (${states})
        ${discardedClause}
      )
    GROUP BY jp.id
    ORDER BY
      CASE jp.pipeline_state
        WHEN 'shortlisted' THEN 0
        WHEN 'applied' THEN 1
        WHEN 'processed' THEN 2
        WHEN 'discarded' THEN 3
        ELSE 4
      END,
      COALESCE(jp.last_seen, jp.first_seen, jp.created_at) DESC,
      jp.id ASC
    ${limitSql}
  `).all();
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'");
}

function stripHtml(html) {
  return normalizeText(decodeEntities(String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')));
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function joinParts(parts) {
  return normalizeText(parts.filter((p) => typeof p === 'string' && p.trim()).join('\n\n'));
}

function leverDescription(json) {
  return joinParts([
    json.descriptionPlain,
    json.additionalPlain,
    ...(Array.isArray(json.lists) ? json.lists.map((list) => joinParts([
      list?.text,
      list?.content,
      ...(Array.isArray(list?.items) ? list.items.map((item) => item?.text || item) : []),
    ])) : []),
  ]);
}

function greenhouseDescription(json) {
  return joinParts([
    stripHtml(json.content),
    stripHtml(json.description),
    ...(Array.isArray(json.questions) ? json.questions.map((q) => q?.label || q?.description) : []),
  ]);
}

function ashbyDescription(job) {
  return joinParts([
    stripHtml(job.descriptionHtml),
    job.descriptionPlain,
    job.description,
  ]);
}

function ashbyLocation(job) {
  const parts = [];
  if (typeof job.location === 'string') parts.push(job.location);
  if (Array.isArray(job.secondaryLocations)) {
    for (const loc of job.secondaryLocations) {
      if (typeof loc?.location === 'string') parts.push(loc.location);
    }
  }
  return [...new Set(parts.map((p) => p.trim()).filter(Boolean))].join(', ');
}

export function resolveWorkdayDetailApi(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.match(/^([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com$/);
  if (!host) return null;
  const path = u.pathname.match(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)(\/job\/.+)$/);
  if (!path) return null;
  const tenant = host[1];
  const site = path[1];
  const externalPath = path[2];
  return `${u.origin}/wday/cxs/${tenant}/${site}${externalPath}`;
}

export function workdayDescription(json) {
  const info = json?.jobPostingInfo && typeof json.jobPostingInfo === 'object'
    ? json.jobPostingInfo
    : {};
  return joinParts([
    stripHtml(info.jobDescription),
    stripHtml(info.jobDescriptionText),
    stripHtml(info.description),
  ]);
}

function workdayLocation(json) {
  const info = json?.jobPostingInfo && typeof json.jobPostingInfo === 'object'
    ? json.jobPostingInfo
    : {};
  return firstString(
    info.location,
    info.locationName,
    info.locationsText,
    Array.isArray(info.additionalLocations) ? info.additionalLocations.map((l) => l?.location || l?.locationName || l).filter(Boolean).join(', ') : '',
  );
}

async function fetchJson(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json,text/html;q=0.9,*/*;q=0.8' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function validatePublicHttpUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error(`unsupported URL protocol: ${url.protocol}`);
  return url.toString();
}

export async function fetchPostingDescription(row) {
  const url = validatePublicHttpUrl(row.url);
  const resolved = resolveAtsApi(url);

  if (resolved?.ats === 'lever') {
    const json = await fetchJson(resolved.apiUrl, resolved.timeoutMs);
    return {
      source: 'backfill:lever-api',
      title: firstString(json.text, row.title),
      location: firstString(json.categories?.location, row.location),
      description: leverDescription(json),
    };
  }

  if (resolved?.ats === 'greenhouse') {
    const json = await fetchJson(resolved.apiUrl, resolved.timeoutMs);
    return {
      source: 'backfill:greenhouse-api',
      title: firstString(json.title, row.title),
      location: firstString(json.location?.name, row.location),
      description: greenhouseDescription(json),
    };
  }

  if (resolved?.ats === 'ashby') {
    const json = await fetchJson(`${resolved.apiUrl}?includeCompensation=true`, resolved.timeoutMs || 20_000);
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    const target = String(resolved.parts.jobId || '').toLowerCase();
    const job = jobs.find((j) => typeof j?.id === 'string' && j.id.toLowerCase() === target);
    if (!job) throw new Error('Ashby posting not present in board API');
    return {
      source: 'backfill:ashby-api',
      title: firstString(job.title, row.title),
      location: firstString(ashbyLocation(job), row.location),
      description: ashbyDescription(job),
    };
  }

  const workdayApi = resolveWorkdayDetailApi(url);
  if (workdayApi) {
    const json = await fetchJson(workdayApi, 12_000);
    return {
      source: 'backfill:workday-cxs',
      title: firstString(json?.jobPostingInfo?.title, row.title),
      location: firstString(workdayLocation(json), row.location),
      description: workdayDescription(json),
    };
  }

  const html = await fetchText(url);
  return {
    source: 'backfill:html',
    title: row.title || '',
    location: row.location || '',
    description: stripHtml(html),
  };
}

function appendRecord(outPath, record) {
  mkdirSync(dirname(outPath), { recursive: true });
  appendFileSync(outPath, JSON.stringify(record) + '\n', 'utf-8');
}

function resultFor(row, status, extra = {}) {
  return {
    id: row.id,
    url: row.url,
    company: row.company_name,
    title: row.title,
    state: row.pipeline_state,
    status,
    ...extra,
  };
}

export async function runBackfill(opts) {
  const DatabaseSync = await loadSqlite();
  const dbPath = resolve(opts.db);
  if (!existsSync(dbPath)) throw new Error(`SQLite DB not found: ${opts.db}`);
  const db = new DatabaseSync(dbPath);
  const rows = loadMissingSnapshotRows(db, opts);
  const summary = {
    considered: rows.length,
    saved: 0,
    skipped: 0,
    failed: 0,
    dryRun: opts.dryRun,
    out: opts.out,
    results: [],
  };

  for (const row of rows) {
    try {
      const fetched = await fetchPostingDescription(row);
      const description = normalizeText(fetched.description);
      if (description.length < MIN_DESCRIPTION_CHARS) {
        summary.skipped += 1;
        summary.results.push(resultFor(row, 'skipped', { reason: `description too short (${description.length} chars)`, source: fetched.source }));
        continue;
      }
      const record = buildSnapshotRecord({
        url: row.url,
        company: row.company_name,
        title: fetched.title || row.title,
        location: fetched.location || row.location,
        source: fetched.source,
      }, description);
      if (!opts.dryRun) appendRecord(opts.out, record);
      summary.saved += 1;
      summary.results.push(resultFor(row, 'saved', { source: fetched.source, chars: description.length }));
    } catch (err) {
      summary.failed += 1;
      summary.results.push(resultFor(row, 'failed', { reason: err.message }));
    }
  }
  return summary;
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const summary = await runBackfill(opts);
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Posting snapshot backfill: ${summary.saved} saved, ${summary.skipped} skipped, ${summary.failed} failed (${summary.considered} considered)`);
      if (!opts.summaryOnly) {
        for (const row of summary.results) {
          const detail = row.status === 'saved'
            ? `${row.source}, ${row.chars} chars`
            : row.reason;
          console.log(`- ${row.status}: #${row.id} ${row.company || ''} | ${row.title || ''} (${detail})`);
        }
      }
      if (summary.saved > 0 && !summary.dryRun) {
        console.log(`Next: npm run db:import`);
      }
    }
    return 0;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    usage(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(await main());
}
