#!/usr/bin/env node

/**
 * db-check-active.mjs -- DB-backed liveness sweep for job_postings.
 *
 * Reads postings from data/career-ops.sqlite, checks whether each URL is still
 * active using the existing zero-token liveness ladder, and moves confirmed
 * closed postings to pipeline_state='expired'. Uncertain checks are noted but
 * never expired.
 */

import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import {
  checkUrlLivenessWithFallback,
  createHeadedPageProvider,
  jitteredDelayMs,
  newLivenessPage,
  sleep,
} from './liveness-browser.mjs';
import { checkLivenessViaApi } from './liveness-api.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = 'data/career-ops.sqlite';
const ALLOWED_STATES = new Set(['pending', 'shortlisted', 'processed', 'discarded', 'expired']);
const DEFAULT_STATES = ['pending', 'shortlisted'];

function usage(exitCode = 0) {
  console.log(`Usage: node db-check-active.mjs [options]

Options:
  --db PATH              SQLite DB path (default: data/career-ops.sqlite)
  --id N                 Check one posting by job_postings.id
  --states LIST          Comma-separated pipeline states (default: pending,shortlisted)
  --limit N              Check at most N postings
  --dry-run              Print results without writing DB changes
  --no-fallback          Do not retry anti-bot challenges in a headed browser
  --throttle[=ms]        Wait base..2x base ms between browser checks
  --json                 Print JSON summary
  --help                 Show this help

Examples:
  node db-check-active.mjs --dry-run --limit 20
  node db-check-active.mjs --states pending,shortlisted,processed --throttle=5000
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    db: process.env.CAREER_OPS_DB || DEFAULT_DB,
    id: null,
    states: DEFAULT_STATES,
    limit: null,
    dryRun: false,
    noFallback: false,
    throttleBaseMs: 0,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--no-fallback') {
      opts.noFallback = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--db') {
      opts.db = argv[++i];
    } else if (arg.startsWith('--db=')) {
      opts.db = arg.slice('--db='.length);
    } else if (arg === '--id') {
      opts.id = parseLimit(argv[++i]);
    } else if (arg.startsWith('--id=')) {
      opts.id = parseLimit(arg.slice('--id='.length));
    } else if (arg === '--states') {
      opts.states = parseStates(argv[++i]);
    } else if (arg.startsWith('--states=')) {
      opts.states = parseStates(arg.slice('--states='.length));
    } else if (arg === '--limit') {
      opts.limit = parseLimit(argv[++i]);
    } else if (arg.startsWith('--limit=')) {
      opts.limit = parseLimit(arg.slice('--limit='.length));
    } else if (arg === '--throttle') {
      opts.throttleBaseMs = 5000;
    } else if (arg.startsWith('--throttle=')) {
      opts.throttleBaseMs = parseThrottle(arg.slice('--throttle='.length));
    } else {
      console.error(`Unknown option: ${arg}`);
      usage(1);
    }
  }

  if (!opts.db) {
    console.error('Error: --db path cannot be empty.');
    process.exit(1);
  }
  return opts;
}

function parseStates(raw) {
  const states = String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (states.length === 0) {
    console.error('Error: --states must name at least one state.');
    process.exit(1);
  }
  for (const state of states) {
    if (!ALLOWED_STATES.has(state)) {
      console.error(`Error: unsupported pipeline state "${state}".`);
      process.exit(1);
    }
  }
  return [...new Set(states)];
}

function parseLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error('Error: --limit must be a positive integer.');
    process.exit(1);
  }
  return n;
}

function parseThrottle(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error('Error: --throttle must be a non-negative integer.');
    process.exit(1);
  }
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
  } catch {
    console.error(`Error: node:sqlite is not available. Need Node >= 22.5 (current: ${process.version}).`);
    process.exit(1);
  } finally {
    process.emitWarning = origEmit;
  }
}

function openDb(DatabaseSync, dbPath) {
  const fullPath = resolve(ROOT, dbPath);
  if (!existsSync(fullPath)) {
    console.error(`Error: SQLite DB not found: ${dbPath}`);
    process.exit(1);
  }
  const db = new DatabaseSync(fullPath);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function quoteState(state) {
  return `'${state.replaceAll("'", "''")}'`;
}

function loadPostings(db, { id, states, limit }) {
  if (id != null) {
    return db.prepare(`
      SELECT id, url, company_name, title, pipeline_state, status, notes
      FROM job_postings
      WHERE id = ?
        AND url IS NOT NULL
        AND trim(url) <> ''
    `).all(id);
  }
  const whereStates = states.map(quoteState).join(', ');
  const limitSql = limit ? `LIMIT ${limit}` : '';
  return db.prepare(`
    SELECT id, url, company_name, title, pipeline_state, status, notes
    FROM job_postings
    WHERE pipeline_state IN (${whereStates})
      AND url IS NOT NULL
      AND trim(url) <> ''
    ORDER BY
      CASE pipeline_state WHEN 'shortlisted' THEN 0 WHEN 'pending' THEN 1 WHEN 'processed' THEN 2 ELSE 3 END,
      COALESCE(last_seen, first_seen, created_at) DESC,
      id ASC
    ${limitSql}
  `).all();
}

function appendNote(db, id, note) {
  const existing = db.prepare('SELECT notes FROM job_postings WHERE id = ?').get(id)?.notes || '';
  if (existing.includes(note)) return;
  db.prepare(`
    UPDATE job_postings
    SET notes = CASE WHEN COALESCE(notes, '') = '' THEN ? ELSE notes || '; ' || ? END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(note, note, id);
}

function markExpired(db, id, note) {
  db.prepare(`
    UPDATE job_postings
    SET pipeline_state = 'expired',
        status = 'expired',
        notes = CASE WHEN COALESCE(notes, '') = '' THEN ? ELSE notes || '; ' || ? END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(note, note, id);
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
  const DatabaseSync = await loadSqlite();
  const db = openDb(DatabaseSync, opts.db);
  const postings = loadPostings(db, opts);
  const today = new Date().toISOString().slice(0, 10);

  if (!opts.json) {
    const mode = opts.dryRun ? 'DRY RUN ' : '';
    console.log(`${mode}Checking ${postings.length} DB posting(s) in states: ${opts.states.join(', ')}\n`);
  }

  let browser = null;
  let page = null;
  let headed = null;
  async function ensureBrowser() {
    if (browser) return;
    browser = await chromium.launch({ headless: true });
    page = await newLivenessPage(browser);
    headed = opts.noFallback ? null : createHeadedPageProvider(chromium);
  }

  const summary = { checked: 0, active: 0, expired: 0, uncertain: 0, viaApi: 0, updated: 0, dryRun: opts.dryRun, results: [] };

  for (let i = 0; i < postings.length; i++) {
    const posting = postings[i];
    let verdict;
    let usedBrowser = false;
    const api = await checkLivenessViaApi(posting.url);
    if (api) {
      verdict = api;
      summary.viaApi++;
    } else {
      await ensureBrowser();
      const getHeadedPage = headed ? () => headed.get() : undefined;
      verdict = await checkUrlLivenessWithFallback(page, posting.url, { getHeadedPage });
      usedBrowser = true;
    }

    summary.checked++;
    summary[verdict.result]++;
    const note = `Active check ${today}: ${verdict.result}${verdict.result === 'active' ? '' : ` (${verdict.reason})`}`;

    if (!opts.dryRun) {
      if (verdict.result === 'expired') {
        markExpired(db, posting.id, note);
        summary.updated++;
      } else if (verdict.result === 'active') {
        markActive(db, posting.id);
      } else {
        appendNote(db, posting.id, note);
        summary.updated++;
      }
    }

    const resultRow = {
      id: posting.id,
      company: posting.company_name,
      title: posting.title,
      previous_state: posting.pipeline_state,
      result: verdict.result,
      reason: verdict.reason,
      via: api ? 'api' : 'browser',
      updated: !opts.dryRun && verdict.result !== 'active',
    };
    summary.results.push(resultRow);

    if (!opts.json) {
      const icon = { active: '✅', expired: '❌', uncertain: '⚠️' }[verdict.result];
      console.log(`${icon} ${verdict.result.padEnd(9)} #${posting.id} ${posting.company_name} | ${posting.title}`);
      if (verdict.result !== 'active') console.log(`   ${verdict.reason}`);
    }

    const wait = usedBrowser && i < postings.length - 1 ? jitteredDelayMs(opts.throttleBaseMs) : 0;
    if (wait) await sleep(wait);
  }

  if (headed) await headed.close();
  if (browser) await browser.close();
  db.close();

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\nResults: ${summary.active} active  ${summary.expired} expired  ${summary.uncertain} uncertain  (${summary.viaApi} via API)`);
    if (opts.dryRun) console.log('Dry run: no DB rows updated.');
    else console.log(`DB updates: ${summary.updated}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
