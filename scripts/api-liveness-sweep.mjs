#!/usr/bin/env node
/**
 * API-only DB liveness sweep for ATS postings.
 *
 * Uses the zero-browser ATS API rung for Greenhouse, Lever, and Ashby. This is
 * intended for broad maintenance sweeps where browser-backed checks are too
 * slow or unavailable.
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { classifyAshbyBoard, resolveAtsApi } from '../liveness-api.mjs';

const DEFAULT_DB = 'data/career-ops.sqlite';
const DEFAULT_STATES = ['pending', 'shortlisted'];
const DEFAULT_SOURCES = ['greenhouse-api', 'lever-api', 'ashby-api'];
const ALLOWED_STATES = new Set(['pending', 'shortlisted', 'processed', 'discarded', 'expired']);

function parseArgs(argv) {
  const opts = {
    db: process.env.CAREER_OPS_DB || DEFAULT_DB,
    states: DEFAULT_STATES,
    sources: DEFAULT_SOURCES,
    limit: null,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--db') opts.db = argv[++i];
    else if (arg.startsWith('--db=')) opts.db = arg.slice('--db='.length);
    else if (arg === '--states') opts.states = parseStates(argv[++i]);
    else if (arg.startsWith('--states=')) opts.states = parseStates(arg.slice('--states='.length));
    else if (arg === '--sources') opts.sources = parseList(argv[++i]);
    else if (arg.startsWith('--sources=')) opts.sources = parseList(arg.slice('--sources='.length));
    else if (arg === '--limit') opts.limit = parseLimit(argv[++i]);
    else if (arg.startsWith('--limit=')) opts.limit = parseLimit(arg.slice('--limit='.length));
    else if (arg === '--help' || arg === '-h') usage(0);
    else {
      console.error(`Unknown option: ${arg}`);
      usage(1);
    }
  }
  return opts;
}

function usage(exitCode) {
  console.log(`Usage: node scripts/api-liveness-sweep.mjs [options]

Options:
  --db PATH          SQLite DB path (default: data/career-ops.sqlite)
  --states LIST      Comma-separated states (default: pending,shortlisted)
  --sources LIST     Comma-separated sources (default: greenhouse-api,lever-api,ashby-api)
  --limit N          Check at most N postings
  --dry-run          Do not write DB changes
  --json             Print JSON only
`);
  process.exit(exitCode);
}

function parseList(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

function parseStates(raw) {
  const states = parseList(raw).map(s => s.toLowerCase());
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

function loadRows(db, opts) {
  const states = opts.states.map(quote).join(', ');
  const sources = opts.sources.map(quote).join(', ');
  const limitSql = opts.limit ? `LIMIT ${opts.limit}` : '';
  return db.prepare(`
    SELECT id, url, company_name, title, source, pipeline_state, status, notes
    FROM job_postings
    WHERE pipeline_state IN (${states})
      AND source IN (${sources})
      AND url IS NOT NULL
      AND trim(url) <> ''
    ORDER BY
      CASE pipeline_state WHEN 'shortlisted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      COALESCE(last_seen, first_seen, created_at) ASC,
      id ASC
    ${limitSql}
  `).all();
}

async function fetchApiResult(resolved, cache) {
  if (cache.has(resolved.apiUrl)) return cache.get(resolved.apiUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolved.timeoutMs || 8000);
  try {
    let result = null;
    const res = await fetch(resolved.apiUrl, {
      method: 'GET',
      headers: { 'user-agent': 'career-ops-liveness/1.0', accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    }).catch(() => null);
    if (!res) result = null;
    else if (res.status === 404 || res.status === 410) result = { result: 'expired', code: `${resolved.ats}_api_gone`, reason: `ATS API ${res.status} - posting removed` };
    else if (res.status === 200 && resolved.ats === 'ashby') {
      const json = await res.json().catch(() => null);
      cache.set(resolved.apiUrl, { ashbyBoard: json });
      return { ashbyBoard: json };
    } else if (res.status === 200) result = { result: 'active', code: `${resolved.ats}_api_ok`, reason: 'ATS API returns the posting (live)' };
    cache.set(resolved.apiUrl, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function noteFor(today, verdict) {
  return `Active check ${today}: ${verdict.result} (${verdict.reason})`;
}

function ensurePostingEvents(db) {
  db.exec(`
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
  `);
}

function recordPostingEvent(db, id, event) {
  db.prepare(`
    INSERT INTO posting_events(
      posting_id, event_type, from_pipeline_state, to_pipeline_state,
      from_status, to_status, reason, notes, source, raw_text
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    event.eventType,
    event.fromPipelineState || null,
    event.toPipelineState || null,
    event.fromStatus || null,
    event.toStatus || null,
    event.reason || null,
    event.notes || null,
    event.source || null,
    event.rawText || null,
  );
}

function expiredPipelineState(previousState) {
  return ['pending', 'expired'].includes(String(previousState || '').toLowerCase()) ? 'expired' : previousState;
}

function markExpired(db, row, note, verdict) {
  const nextState = expiredPipelineState(row.pipeline_state);
  db.prepare(`
    UPDATE job_postings
    SET pipeline_state = ?,
        status = 'expired',
        notes = CASE WHEN COALESCE(notes, '') = '' THEN ? ELSE notes || '; ' || ? END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextState, note, note, row.id);
  recordPostingEvent(db, row.id, {
    eventType: 'liveness_expired',
    fromPipelineState: row.pipeline_state,
    toPipelineState: nextState,
    fromStatus: row.status,
    toStatus: 'expired',
    reason: verdict?.reason || null,
    notes: note,
    source: 'api-liveness-sweep',
    rawText: verdict ? JSON.stringify(verdict) : null,
  });
}

function markActive(db, id) {
  db.prepare(`
    UPDATE job_postings
    SET status = 'active',
        last_seen = date('now'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND COALESCE(status, '') <> 'active'
  `).run(id);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = resolve(opts.db);
  if (!existsSync(dbPath)) throw new Error(`SQLite DB not found: ${opts.db}`);
  const DatabaseSync = await loadSqlite();
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  ensurePostingEvents(db);

  const rows = loadRows(db, opts);
  const today = new Date().toISOString().slice(0, 10);
  const cache = new Map();
  const summary = { checked: 0, active: 0, expired: 0, uncertain: 0, unsupported: 0, updated: 0, dryRun: opts.dryRun, results: [] };

  for (const row of rows) {
    const resolved = resolveAtsApi(row.url);
    if (!resolved) {
      summary.unsupported += 1;
      continue;
    }
    let verdict = await fetchApiResult(resolved, cache);
    if (verdict?.ashbyBoard) verdict = classifyAshbyBoard(verdict.ashbyBoard, resolved.parts.jobId);
    summary.checked += 1;
    if (!verdict) {
      summary.uncertain += 1;
      summary.results.push({ ...row, result: 'uncertain', reason: 'ATS API inconclusive' });
      continue;
    }
    summary[verdict.result] += 1;
    const result = { ...row, ...verdict };
    summary.results.push(result);
    if (!opts.dryRun && verdict.result === 'expired') {
      markExpired(db, row, noteFor(today, verdict), verdict);
      summary.updated += 1;
    } else if (!opts.dryRun && verdict.result === 'active') {
      markActive(db, row.id);
    }
  }

  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`Checked ${summary.checked}; active ${summary.active}; expired ${summary.expired}; uncertain ${summary.uncertain}; unsupported ${summary.unsupported}; updated ${summary.updated}`);
    for (const row of summary.results.filter(r => r.result === 'expired')) {
      console.log(`expired\t${row.id}\t${row.company_name}\t${row.title}\t${row.reason}`);
    }
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
