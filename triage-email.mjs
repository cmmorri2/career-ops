#!/usr/bin/env node
/**
 * Email-shaped mobile triage for DB-backed job postings.
 *
 * compose: writes a plain-text batch you can email to yourself.
 * import: parses a reply body and applies explicit disposition commands.
 * fetch-replies: pulls matching replies from an IMAP mailbox and imports them.
 */

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import tls from 'node:tls';

const ROOT = new URL('.', import.meta.url).pathname;
const DEFAULT_DB = 'data/career-ops.sqlite';
const DEFAULT_OUT_DIR = 'data/triage-email';
const DEFAULT_PROCESSED = 'data/triage-email/processed-replies.jsonl';
const DEFAULT_TTL_DAYS = 2;
const DEFAULT_LIMIT = 12;
const DEFAULT_MAX_SENDS = 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATE_ACTIONS = new Map([
  ['save', 'shortlisted'],
  ['saved', 'shortlisted'],
  ['shortlist', 'shortlisted'],
  ['pass', 'discarded'],
  ['skip', 'discarded'],
  ['discard', 'discarded'],
  ['discarded', 'discarded'],
  ['expired', 'expired'],
  ['restore', 'pending'],
  ['pending', 'pending'],
]);

function usage(exitCode = 0) {
  console.log(`Usage:
  node triage-email.mjs compose [--limit N] [--ttl-days N] [--max-sends N] [--min-score N] [--location TEXT] [--focus TEXT] [--state pending|shortlisted] [--exclude-batch KEY] [--out DIR] [--db PATH]
  node triage-email.mjs import --file PATH [--batch KEY] [--message-id ID] [--db PATH] [--no-export]
  node triage-email.mjs import --stdin [--batch KEY] [--message-id ID] [--db PATH] [--no-export]
  node triage-email.mjs fetch-replies [--days-back N] [--max-messages N] [--from EMAIL] [--db PATH] [--no-export]

Reply command examples:
  3 save
  4 pass note: too implementation-heavy
  7 later
  9 expired
  11 note: only if remote is real
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') usage(0);
  const opts = {
    command,
    db: process.env.CAREER_OPS_DB || DEFAULT_DB,
    out: DEFAULT_OUT_DIR,
    ttlDays: DEFAULT_TTL_DAYS,
    limit: DEFAULT_LIMIT,
    maxSends: DEFAULT_MAX_SENDS,
    minScore: null,
    location: '',
    focus: '',
    state: 'pending',
    excludeBatches: [],
    file: null,
    stdin: false,
    batch: null,
    messageId: '',
    exportPipeline: true,
    daysBack: 7,
    maxMessages: 20,
    from: env('TRIAGE_EMAIL_FROM', ''),
    processed: DEFAULT_PROCESSED,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--db') opts.db = argv[++i];
    else if (arg.startsWith('--db=')) opts.db = arg.slice(5);
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg.startsWith('--out=')) opts.out = arg.slice(6);
    else if (arg === '--ttl-days') opts.ttlDays = positiveNumber(argv[++i], '--ttl-days');
    else if (arg.startsWith('--ttl-days=')) opts.ttlDays = positiveNumber(arg.slice(11), '--ttl-days');
    else if (arg === '--limit') opts.limit = positiveInt(argv[++i], '--limit');
    else if (arg.startsWith('--limit=')) opts.limit = positiveInt(arg.slice(8), '--limit');
    else if (arg === '--max-sends') opts.maxSends = positiveInt(argv[++i], '--max-sends');
    else if (arg.startsWith('--max-sends=')) opts.maxSends = positiveInt(arg.slice(12), '--max-sends');
    else if (arg === '--min-score') opts.minScore = positiveNumber(argv[++i], '--min-score');
    else if (arg.startsWith('--min-score=')) opts.minScore = positiveNumber(arg.slice(12), '--min-score');
    else if (arg === '--location') opts.location = argv[++i];
    else if (arg.startsWith('--location=')) opts.location = arg.slice(11);
    else if (arg === '--focus') opts.focus = argv[++i];
    else if (arg.startsWith('--focus=')) opts.focus = arg.slice(8);
    else if (arg === '--state') opts.state = parseComposeState(argv[++i]);
    else if (arg.startsWith('--state=')) opts.state = parseComposeState(arg.slice(8));
    else if (arg === '--exclude-batch') opts.excludeBatches.push(argv[++i]);
    else if (arg.startsWith('--exclude-batch=')) opts.excludeBatches.push(arg.slice(16));
    else if (arg === '--file') opts.file = argv[++i];
    else if (arg.startsWith('--file=')) opts.file = arg.slice(7);
    else if (arg === '--stdin') opts.stdin = true;
    else if (arg === '--batch') opts.batch = argv[++i];
    else if (arg.startsWith('--batch=')) opts.batch = arg.slice(8);
    else if (arg === '--message-id') opts.messageId = argv[++i];
    else if (arg.startsWith('--message-id=')) opts.messageId = arg.slice(13);
    else if (arg === '--days-back') opts.daysBack = positiveNumber(argv[++i], '--days-back');
    else if (arg.startsWith('--days-back=')) opts.daysBack = positiveNumber(arg.slice(12), '--days-back');
    else if (arg === '--max-messages') opts.maxMessages = positiveInt(argv[++i], '--max-messages');
    else if (arg.startsWith('--max-messages=')) opts.maxMessages = positiveInt(arg.slice(15), '--max-messages');
    else if (arg === '--from') opts.from = argv[++i];
    else if (arg.startsWith('--from=')) opts.from = arg.slice(7);
    else if (arg === '--processed') opts.processed = argv[++i];
    else if (arg.startsWith('--processed=')) opts.processed = arg.slice(12);
    else if (arg === '--no-export') opts.exportPipeline = false;
    else usage(1);
  }
  return opts;
}

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function ensureParent(file) {
  mkdirSync(dirname(file), { recursive: true });
}

function appendJsonl(path, rows) {
  if (!rows.length) return;
  ensureParent(path);
  appendFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function imapDate(daysBack = 7) {
  const d = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function positiveInt(raw, name) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function positiveNumber(raw, name) {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

function parseComposeState(raw) {
  const state = String(raw || '').trim().toLowerCase();
  if (!['pending', 'shortlisted'].includes(state)) {
    throw new Error('--state must be pending or shortlisted');
  }
  return state;
}

function dbPath(opts) {
  return resolve(ROOT, opts.db);
}

function ensureDb(opts) {
  execFileSync('python3', ['db/career_ops_db.py', 'init', '--db', dbPath(opts)], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sqlString(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function sqlJson(opts, sql) {
  const out = execFileSync('sqlite3', ['-json', dbPath(opts), sql], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [];
}

function sqlExec(opts, sql) {
  execFileSync('sqlite3', [dbPath(opts), sql], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function ensurePostingEvents(opts) {
  sqlExec(opts, `
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

function ensureTriageEmailTables(opts) {
  sqlExec(opts, `
    CREATE TABLE IF NOT EXISTS triage_email_batches (
      id INTEGER PRIMARY KEY,
      batch_key TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL,
      body_path TEXT,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'partial', 'complete', 'expired')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS triage_email_items (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES triage_email_batches(id) ON DELETE CASCADE,
      item_num INTEGER NOT NULL,
      posting_id INTEGER NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      state_at_send TEXT NOT NULL,
      item_status TEXT NOT NULL DEFAULT 'unanswered'
        CHECK(item_status IN ('unanswered', 'responded', 'deferred', 'needs_review', 'superseded')),
      sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      responded_at TEXT,
      UNIQUE(batch_id, item_num),
      UNIQUE(batch_id, posting_id)
    );

    CREATE INDEX IF NOT EXISTS idx_triage_email_items_posting ON triage_email_items(posting_id);
    CREATE INDEX IF NOT EXISTS idx_triage_email_items_status ON triage_email_items(item_status);

    CREATE TABLE IF NOT EXISTS triage_email_events (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES triage_email_batches(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES triage_email_items(id) ON DELETE SET NULL,
      posting_id INTEGER REFERENCES job_postings(id) ON DELETE SET NULL,
      message_id TEXT,
      action TEXT NOT NULL,
      note TEXT,
      raw_line TEXT NOT NULL,
      result TEXT NOT NULL,
      conflict TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function expiredPipelineState(previousState) {
  return ['pending', 'expired'].includes(String(previousState || '').toLowerCase()) ? 'expired' : previousState;
}

function scoreNumber(score) {
  const m = String(score || '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  return m ? Number.parseFloat(m[1]) : 0;
}

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function makeBatchKey() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `triage-${stamp.toLowerCase()}`;
}

function loadEligible(opts) {
  const excludeBatchKeys = opts.excludeBatches
    .map((key) => String(key || '').trim())
    .filter(Boolean);
  const excludeReviewed = excludeBatchKeys.length
    ? `AND NOT EXISTS (
        SELECT 1
        FROM triage_email_items exclude_tei
        JOIN triage_email_batches exclude_teb ON exclude_teb.id = exclude_tei.batch_id
        WHERE exclude_tei.posting_id = jp.id
          AND exclude_teb.batch_key IN (${excludeBatchKeys.map(sqlString).join(', ')})
      )`
    : '';
  const rows = sqlJson(opts, `
    SELECT jp.id, jp.url, jp.company_name, jp.title, jp.location, jp.compensation,
           jp.first_seen, jp.last_seen, jp.status, jp.pipeline_state, jp.score,
           jp.notes, jp.source, jp.deep_fit_score, jp.application_priority,
           (
             SELECT COUNT(*)
             FROM triage_email_items tei
             WHERE tei.posting_id = jp.id
           ) AS sent_count
    FROM job_postings jp
    WHERE jp.pipeline_state = ${sqlString(opts.state)}
      AND COALESCE(jp.status, 'active') <> 'expired'
      ${excludeReviewed}
      AND NOT EXISTS (
        SELECT 1
        FROM triage_email_items tei
        JOIN triage_email_batches teb ON teb.id = tei.batch_id
        WHERE tei.posting_id = jp.id
          AND tei.item_status IN ('unanswered', 'deferred')
          AND teb.expires_at > CURRENT_TIMESTAMP
      )
    ORDER BY COALESCE(jp.last_seen, jp.first_seen, jp.created_at) DESC, jp.id ASC
  `);
  return rows
    .filter((r) => Number(r.sent_count || 0) < opts.maxSends)
    .filter((r) => opts.minScore == null || scoreNumber(r.score) >= opts.minScore)
    .filter((r) => matchesLocation(r.location, opts.location))
    .filter((r) => matchesFocus(r, opts.focus))
    .sort((a, b) => {
      const scoreDelta = scoreNumber(b.score) - scoreNumber(a.score);
      if (scoreDelta) return scoreDelta;
      return String(b.last_seen || b.first_seen || '').localeCompare(String(a.last_seen || a.first_seen || ''));
    })
    .slice(0, opts.limit);
}

function matchesFocus(row, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${row.title || ''} ${row.notes || ''} ${row.company_name || ''}`.toLowerCase();
  if (needle === 'product') {
    return /\bproduct\b/.test(haystack) || haystack.includes('product-shaping');
  }
  return haystack.includes(needle);
}

function matchesLocation(location, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  const text = String(location || '');
  const lower = text.toLowerCase();
  if (needle === 'oregon' || needle === 'or') {
    return /\b(oregon|portland|beaverton|hillsboro|lake oswego)\b/i.test(text)
      || /,\s*OR\b/.test(text);
  }
  return lower.includes(needle);
}

function compactLine(parts) {
  return parts.filter((p) => p != null && String(p).trim() !== '').join(' | ');
}

function cleanScore(row) {
  const score = row.score || (row.deep_fit_score ? `${Number(row.deep_fit_score).toFixed(1)}/5` : '');
  return String(score || 'unscored').replace(/^Triage\s+/i, '').trim();
}

function compactLocation(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/^note:/i.test(text)) return '';
  const withoutNotes = text
    .split(/\s*\|\s*/)
    .map((part) => part.trim())
    .filter((part) => part && !/^note:/i.test(part))
    .join(' | ');
  const parts = withoutNotes.split(/\s*[·;]\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 4) return `${parts.slice(0, 4).join(' / ')} +${parts.length - 4} more`;
  if (withoutNotes.length > 96) return `${withoutNotes.slice(0, 93).trim()}...`;
  return withoutNotes;
}

function compactNotes(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text
    .replace(/^Triage\s*-\s*/i, '')
    .replace(/\bstrong fit worth deeper review;\s*/i, '')
    .slice(0, 180)
    .trim();
}

function compactCompensation(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || /^note:/i.test(text)) return '';
  return text.length > 80 ? `${text.slice(0, 77).trim()}...` : text;
}

function bodyForBatch(batchKey, rows, opts) {
  const expires = new Date(Date.now() + opts.ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const itemNumbers = rows.map((_, index) => index + 1).join(', ');
  const lines = [
    `Subject: career-ops triage batch ${batchKey}`,
    '',
    `Batch: ${batchKey}`,
    `Expires: ${expires} (${opts.ttlDays} days)`,
    '',
    `Item numbers in this batch: ${itemNumbers}`,
    'Reply format: one command per line as <item number> <action>.',
    'Supported actions: save, pass, later, expired, restore, note: <text>.',
    'Examples: 1 pass | 2 save | 3 later | 4 note: only if remote is real | 5 pass note: too implementation-heavy',
    '',
  ];
  rows.forEach((r, index) => {
    const n = index + 1;
    lines.push(`[${n}] ${r.company_name} - ${r.title}`);
    lines.push(compactLine([
      `Score: ${cleanScore(r)}`,
      r.application_priority ? `Priority ${r.application_priority}` : '',
      `State: ${r.pipeline_state}`,
      compactLocation(r.location),
      compactCompensation(r.compensation),
      r.first_seen ? `Seen: ${r.first_seen}` : '',
      r.source ? `Source: ${r.source}` : '',
    ]));
    const note = compactNotes(r.notes);
    if (note) lines.push(`Fit: ${note}`);
    lines.push(`URL: ${r.url}`);
    lines.push(`Ref: id=${r.id} hash=${shortHash(r.url)} sent=${Number(r.sent_count || 0) + 1}/${opts.maxSends}`);
    lines.push('');
  });
  return { subject: `career-ops triage batch ${batchKey}`, expires, body: lines.join('\n') };
}

function compose(opts) {
  ensureDb(opts);
  ensureTriageEmailTables(opts);
  const rows = loadEligible(opts);
  if (!rows.length) {
    console.log(JSON.stringify({ status: 'empty', message: `No eligible ${opts.state} postings outside the open batch window.` }, null, 2));
    return;
  }
  const batchKey = makeBatchKey();
  const { subject, expires, body } = bodyForBatch(batchKey, rows, opts);
  const outDir = resolve(ROOT, opts.out);
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `${batchKey}.txt`);
  writeFileSync(outPath, body, 'utf8');

  const batchRow = sqlJson(opts, `
    INSERT INTO triage_email_batches(batch_key, subject, body_path, expires_at)
    VALUES (${sqlString(batchKey)}, ${sqlString(subject)}, ${sqlString(outPath)}, ${sqlString(expires)});
    SELECT last_insert_rowid() AS id;
  `)[0];
  const batchId = Number(batchRow.id);
  const values = rows.map((r, index) => `(${batchId}, ${index + 1}, ${Number(r.id)}, ${sqlString(r.url)}, ${sqlString(shortHash(r.url))}, ${sqlString(r.pipeline_state || 'pending')})`);
  sqlExec(opts, `
    INSERT INTO triage_email_items(batch_id, item_num, posting_id, url, url_hash, state_at_send)
    VALUES ${values.join(',\n')};
  `);
  console.log(JSON.stringify({ status: 'created', batch: batchKey, items: rows.length, expires_at: expires, path: outPath }, null, 2));
}

function readReply(opts) {
  if (opts.file) return readFileSync(resolve(ROOT, opts.file), 'utf8');
  if (opts.stdin) return readFileSync(0, 'utf8');
  throw new Error('import requires --file PATH or --stdin');
}

function stripQuoted(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^On .+ wrote:\s*$/i.test(line)) break;
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

function commandRegion(text) {
  const lines = stripQuoted(text).split(/\r?\n/);
  const out = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    out.push(rawLine);
  }
  return out.join('\n');
}

function parseCommands(text) {
  const commands = [];
  const seen = new Set();
  let pending = null;
  const push = (command) => {
    const key = `${command.itemNum}|${command.action}|${normalizedNote(command.note)}`;
    if (!seen.has(key)) {
      seen.add(key);
      commands.push(command);
    }
  };
  const finishPending = () => {
    if (!pending) return;
    push(pending);
    pending = null;
  };
  for (const rawLine of commandRegion(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^Batch:\s*/i.test(line)) continue;
    if (/^Subject:\s*/i.test(line) || /^Expires:/i.test(line)) continue;
    if (/^Item numbers in this batch:/i.test(line)) continue;
    if (/^Reply (with|format:)/i.test(line) || /^Supported actions:/i.test(line) || /^Examples:/i.test(line)) continue;
    if (/^(Score|Fit|URL|Ref):/i.test(line)) continue;
    const card = line.match(/^\[(\d+)\]\s+/);
    if (card) {
      if (pending) {
        pending.itemNum = Number(card[1]);
        push(pending);
        pending = null;
      }
      continue;
    }
    let m = line.match(/^(\d+)[\).\]]?\s+(save|saved|shortlist|pass|skip|discard|discarded|later|defer|expired|restore|pending)\b(?:\s+note:\s*(.+))?$/i);
    if (m) {
      finishPending();
      const word = m[2].toLowerCase();
      pending = {
        itemNum: Number(m[1]),
        action: word === 'defer' ? 'later' : word,
        state: STATE_ACTIONS.get(word) || null,
        note: (m[3] || '').trim(),
        rawLine,
      };
      continue;
    }
    m = line.match(/^(\d+)[\).\]]?\s+note:\s*(.+)$/i);
    if (m) {
      finishPending();
      pending = { itemNum: Number(m[1]), action: 'note', state: null, note: m[2].trim(), rawLine };
      continue;
    }
    if (pending && pending.note) {
      pending.note = `${pending.note} ${line}`.replace(/\s+/g, ' ').trim();
      pending.rawLine = `${pending.rawLine} ${line}`;
    } else if (pending) {
      finishPending();
    }
  }
  finishPending();
  return commands;
}

function legacyParseCommands(text) {
  const commands = [];
  const seen = new Set();
  for (const rawLine of stripQuoted(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^Batch:\s*/i.test(line)) continue;
    let m = line.match(/^(\d+)[\).\]]?\s+(save|saved|shortlist|pass|skip|discard|discarded|later|defer|expired|restore|pending)\b(?:\s+note:\s*(.+))?$/i);
    if (m) {
      const word = m[2].toLowerCase();
      const command = {
        itemNum: Number(m[1]),
        action: word === 'defer' ? 'later' : word,
        state: STATE_ACTIONS.get(word) || null,
        note: (m[3] || '').trim(),
        rawLine,
      };
      const key = `${command.itemNum}|${command.action}|${normalizedNote(command.note)}`;
      if (!seen.has(key)) {
        seen.add(key);
        commands.push(command);
      }
      continue;
    }
    m = line.match(/^(\d+)[\).\]]?\s+note:\s*(.+)$/i);
    if (!m) continue;
    const command = { itemNum: Number(m[1]), action: 'note', state: null, note: m[2].trim(), rawLine };
    const key = `${command.itemNum}|${command.action}|${normalizedNote(command.note)}`;
    if (!seen.has(key)) {
      seen.add(key);
      commands.push(command);
    }
  }
  return commands;
}

function batchKeyFrom(text, opts) {
  if (opts.batch) return opts.batch;
  const m = text.match(/\bBatch:\s*([A-Za-z0-9_.:-]+)/);
  if (m) return m[1];
  throw new Error('No Batch: key found; pass --batch KEY.');
}

function appendNote(existing, note) {
  const clean = String(note || '').replace(/\s+/g, ' ').trim();
  if (!clean) return existing || '';
  const stamp = new Date().toISOString().slice(0, 10);
  const addition = `[email ${stamp}] ${clean}`;
  return existing ? `${existing} | ${addition}` : addition;
}

function normalizedNote(note) {
  return String(note || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function markBatchStatus(opts, batchId) {
  const row = sqlJson(opts, `
    SELECT
      SUM(CASE WHEN item_status IN ('unanswered', 'deferred') THEN 1 ELSE 0 END) AS open_items,
      SUM(CASE WHEN item_status <> 'unanswered' THEN 1 ELSE 0 END) AS touched_items
    FROM triage_email_items
    WHERE batch_id = ${Number(batchId)}
  `)[0] || {};
  const openItems = Number(row.open_items || 0);
  const touchedItems = Number(row.touched_items || 0);
  const status = openItems === 0 ? 'complete' : touchedItems > 0 ? 'partial' : 'open';
  sqlExec(opts, `
    UPDATE triage_email_batches
    SET status = ${sqlString(status)}, closed_at = CASE WHEN ${sqlString(status)} = 'complete' THEN CURRENT_TIMESTAMP ELSE closed_at END
    WHERE id = ${Number(batchId)};
  `);
  return status;
}

function applyCommand(opts, batch, command) {
  const item = sqlJson(opts, `
    SELECT tei.id AS item_id, tei.posting_id, tei.item_num, tei.item_status,
           jp.pipeline_state, jp.status, jp.notes, jp.company_name, jp.title
    FROM triage_email_items tei
    JOIN job_postings jp ON jp.id = tei.posting_id
    WHERE tei.batch_id = ${Number(batch.id)}
      AND tei.item_num = ${Number(command.itemNum)}
    LIMIT 1
  `)[0];
  if (!item) {
    return { item: command.itemNum, action: command.action, result: 'needs_review', conflict: 'batch item not found' };
  }

  const dedupeKey = shortHash(`${batch.batch_key}|${command.itemNum}|${command.action}|${normalizedNote(command.note)}`);
  const existing = sqlJson(opts, `SELECT id FROM triage_email_events WHERE dedupe_key = ${sqlString(dedupeKey)} LIMIT 1`)[0];
  if (existing) {
    return { item: command.itemNum, action: command.action, result: 'duplicate_skipped' };
  }

  let result = 'applied';
  let conflict = '';
  let targetState = command.state;
  const current = String(item.pipeline_state || '').toLowerCase();
  const postingStatus = String(item.status || '').toLowerCase();
  if (targetState === 'shortlisted' && (current === 'expired' || postingStatus === 'expired')) {
    result = 'needs_review';
    conflict = 'posting is expired locally; refusing to shortlist from email';
    targetState = null;
  } else if (['processed', 'applied'].includes(current) && targetState && targetState !== 'expired') {
    result = 'needs_review';
    conflict = `posting is already ${current}; refusing triage downgrade`;
    targetState = null;
  }

  const nextNotes = command.note ? appendNote(item.notes, command.note) : item.notes || '';
  const previousStatus = String(item.status || '');
  const nextState = targetState === 'expired' ? expiredPipelineState(current) : targetState;
  const nextStatus = targetState === 'expired' ? 'expired' : previousStatus;
  if (targetState || command.note) {
    const sets = [];
    if (targetState) sets.push(`pipeline_state = ${sqlString(nextState)}`);
    if (targetState === 'expired') sets.push("status = 'expired'");
    if (command.note) sets.push(`notes = ${sqlString(nextNotes)}`);
    sets.push('updated_at = CURRENT_TIMESTAMP');
    ensurePostingEvents(opts);
    sqlExec(opts, `
      UPDATE job_postings
      SET ${sets.join(', ')}
      WHERE id = ${Number(item.posting_id)};
    `);
    const eventType = targetState === 'discarded'
      ? 'user_discarded'
      : targetState === 'expired'
        ? 'user_marked_expired'
        : command.note
          ? 'user_note'
          : 'user_state_changed';
    sqlExec(opts, `
      INSERT INTO posting_events(
        posting_id, event_type, from_pipeline_state, to_pipeline_state,
        from_status, to_status, notes, source, raw_text
      )
      VALUES (
        ${Number(item.posting_id)},
        ${sqlString(eventType)},
        ${sqlString(current)},
        ${targetState ? sqlString(nextState) : 'NULL'},
        ${sqlString(previousStatus)},
        ${sqlString(nextStatus)},
        ${command.note ? sqlString(command.note) : 'NULL'},
        'triage-email',
        ${sqlString(command.rawLine)}
      );
    `);
  }

  const itemStatus = result === 'needs_review' ? 'needs_review' : command.action === 'later' ? 'deferred' : 'responded';
  sqlExec(opts, `
    UPDATE triage_email_items
    SET item_status = ${sqlString(itemStatus)}, responded_at = CURRENT_TIMESTAMP
    WHERE id = ${Number(item.item_id)};

    INSERT INTO triage_email_events(batch_id, item_id, posting_id, message_id, action, note, raw_line, result, conflict, dedupe_key)
    VALUES (
      ${Number(batch.id)},
      ${Number(item.item_id)},
      ${Number(item.posting_id)},
      ${sqlString(opts.messageId || '')},
      ${sqlString(command.action)},
      ${command.note ? sqlString(command.note) : 'NULL'},
      ${sqlString(command.rawLine)},
      ${sqlString(result)},
      ${conflict ? sqlString(conflict) : 'NULL'},
      ${sqlString(dedupeKey)}
    );
  `);
  return { item: command.itemNum, action: command.action, result, state: nextState || current, conflict: conflict || undefined };
}

function importReply(opts) {
  ensureDb(opts);
  ensureTriageEmailTables(opts);
  const text = readReply(opts);
  return importReplyText(opts, text);
}

function importReplyText(opts, text) {
  const batchKey = batchKeyFrom(text, opts);
  const batch = sqlJson(opts, `SELECT id, batch_key, status FROM triage_email_batches WHERE batch_key = ${sqlString(batchKey)} LIMIT 1`)[0];
  if (!batch) throw new Error(`Unknown batch: ${batchKey}`);
  const commands = parseCommands(text);
  if (!commands.length) {
    return { status: 'empty', batch: batchKey, message: 'No valid reply commands found.' };
  }
  const results = commands.map((command) => applyCommand(opts, batch, command));
  const batchStatus = markBatchStatus(opts, Number(batch.id));
  if (opts.exportPipeline) {
    execFileSync('python3', ['db/career_ops_db.py', 'export-pipeline', '--db', dbPath(opts)], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return {
    status: 'imported',
    batch: batchKey,
    batch_status: batchStatus,
    commands: commands.length,
    applied: results.filter((r) => r.result === 'applied').length,
    duplicates: results.filter((r) => r.result === 'duplicate_skipped').length,
    needs_review: results.filter((r) => r.result === 'needs_review').length,
    results,
  };
}

function printImportReply(opts) {
  ensureDb(opts);
  ensureTriageEmailTables(opts);
  const text = readReply(opts);
  console.log(JSON.stringify(importReplyText(opts, text), null, 2));
}

function escapeImap(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

class ImapClient {
  constructor(options) {
    this.host = options.host;
    this.port = Number(options.port || 993);
    this.user = options.user;
    this.password = options.password;
    this.mailbox = options.mailbox || 'INBOX';
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.tagNum = 0;
  }

  async connect() {
    this.socket = tls.connect({ host: this.host, port: this.port, servername: this.host });
    this.socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); });
    await new Promise((resolvePromise, reject) => {
      this.socket.once('secureConnect', resolvePromise);
      this.socket.once('error', reject);
    });
    await this.readUntilLinePrefix('* OK');
    await this.command(`LOGIN "${escapeImap(this.user)}" "${escapeImap(this.password)}"`);
    await this.command(`EXAMINE "${escapeImap(this.mailbox)}"`);
  }

  async close() {
    if (!this.socket) return;
    try { await this.command('LOGOUT'); } catch {}
    this.socket.end();
  }

  async readUntilLinePrefix(prefix, timeoutMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const text = this.buffer.toString('utf8');
      const idx = text.indexOf('\r\n');
      if (idx !== -1) {
        const line = text.slice(0, idx);
        if (line.startsWith(prefix)) return line;
      }
      await sleep(25);
    }
    throw new Error(`Timed out waiting for IMAP line: ${prefix}`);
  }

  async command(commandText, timeoutMs = 60000) {
    const tag = `A${String(++this.tagNum).padStart(4, '0')}`;
    this.buffer = Buffer.alloc(0);
    this.socket.write(`${tag} ${commandText}\r\n`);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const text = this.buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      if (lines.some((line) => line.startsWith(`${tag} OK`) || line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`))) {
        if (!text.includes(`${tag} OK`)) throw new Error(`IMAP command failed: ${commandText}\n${text}`);
        return Buffer.from(this.buffer);
      }
      await sleep(25);
    }
    throw new Error(`Timed out running IMAP command: ${commandText}`);
  }

  async search({ daysBack = 7, from = '' } = {}) {
    const criteria = ['SINCE', imapDate(daysBack), 'SUBJECT', '"career-ops triage batch"'];
    if (from) criteria.push('FROM', `"${escapeImap(from)}"`);
    const out = (await this.command(`SEARCH ${criteria.join(' ')}`)).toString('utf8');
    const line = out.split(/\r?\n/).find((l) => l.startsWith('* SEARCH')) || '';
    return line.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number).filter(Boolean);
  }

  async fetchRaw(seq) {
    const out = await this.command(`FETCH ${seq} (UID BODY.PEEK[])`, 90000);
    const textPrefix = out.toString('utf8', 0, Math.min(out.length, 1000));
    const uid = /UID\s+(\d+)/i.exec(textPrefix)?.[1] || String(seq);
    const marker = /\{(\d+)\}\r\n/.exec(out.toString('latin1'));
    if (!marker) return { uid, raw: out.toString('utf8') };
    const literalLength = Number(marker[1]);
    const start = Buffer.from(out.toString('latin1').slice(0, marker.index + marker[0].length), 'latin1').length;
    const raw = out.subarray(start, start + literalLength).toString('utf8');
    return { uid, raw };
  }
}

function parseHeaders(raw) {
  const [head = ''] = String(raw || '').split(/\r?\n\r?\n/);
  const headers = {};
  let current = '';
  for (const line of head.split(/\r?\n/)) {
    if (/^\s/.test(line) && current) {
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    current = line.slice(0, idx).toLowerCase();
    headers[current] = line.slice(idx + 1).trim();
  }
  return headers;
}

function decodeQuotedPrintable(input) {
  return String(input || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function extractReplyText(raw) {
  const text = String(raw || '');
  const textPlain = text.match(/Content-Type:\s*text\/plain[^]*?\r?\n\r?\n([^]*?)(?:\r?\n--[^\r\n]+|$)/i);
  const body = textPlain ? textPlain[1] : text.split(/\r?\n\r?\n/).slice(1).join('\n\n') || text;
  return decodeQuotedPrintable(body).replace(/\r/g, '');
}

function imapConfigFromEnv() {
  return {
    host: env('TRIAGE_EMAIL_IMAP_HOST', env('LINKEDIN_EMAIL_IMAP_HOST', env('IMAP_HOST', 'imap.gmail.com'))),
    port: Number(env('TRIAGE_EMAIL_IMAP_PORT', env('LINKEDIN_EMAIL_IMAP_PORT', env('IMAP_PORT', '993')))),
    user: env('TRIAGE_EMAIL_IMAP_USER', env('LINKEDIN_EMAIL_IMAP_USER', env('IMAP_USER'))),
    password: env('TRIAGE_EMAIL_IMAP_PASSWORD', env('LINKEDIN_EMAIL_IMAP_PASSWORD', env('IMAP_PASSWORD'))),
    mailbox: env('TRIAGE_EMAIL_IMAP_MAILBOX', env('LINKEDIN_EMAIL_IMAP_MAILBOX', env('IMAP_MAILBOX', 'INBOX'))),
  };
}

function requireImapConfig(config) {
  const missing = [];
  for (const key of ['host', 'user', 'password']) {
    if (!config[key]) missing.push(key);
  }
  if (missing.length) throw new Error(`Missing IMAP config: ${missing.join(', ')}. Set TRIAGE_EMAIL_IMAP_USER and TRIAGE_EMAIL_IMAP_PASSWORD, or reuse LINKEDIN_EMAIL_IMAP_*.`);
}

async function fetchReplies(opts) {
  ensureDb(opts);
  ensureTriageEmailTables(opts);
  const config = imapConfigFromEnv();
  requireImapConfig(config);
  const processedPath = resolve(ROOT, opts.processed);
  const processed = new Set(readJsonl(processedPath).map((row) => String(row.uid || '')));
  const client = new ImapClient(config);
  const processedRows = [];
  const imports = [];
  await client.connect();
  try {
    const ids = (await client.search({ daysBack: opts.daysBack, from: opts.from })).slice(-opts.maxMessages);
    for (const seq of ids) {
      const { uid, raw } = await client.fetchRaw(seq);
      if (processed.has(String(uid))) continue;
      const headers = parseHeaders(raw);
      const text = extractReplyText(raw);
      let result = { status: 'ignored', message: 'No Batch key found.' };
      try {
        if (/\bBatch:\s*[A-Za-z0-9_.:-]+/.test(text)) {
          result = importReplyText({ ...opts, messageId: headers['message-id'] || String(uid) }, text);
        }
      } catch (e) {
        result = { status: 'error', message: e instanceof Error ? e.message : String(e) };
      }
      imports.push({ uid, subject: headers.subject || '', result });
      processedRows.push({ uid, messageId: headers['message-id'] || '', subject: headers.subject || '', processedAt: new Date().toISOString(), status: result.status });
    }
  } finally {
    await client.close();
  }
  appendJsonl(processedPath, processedRows);
  console.log(JSON.stringify({ status: 'fetched', checked: processedRows.length, imported: imports.filter((r) => r.result.status === 'imported').length, results: imports }, null, 2));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === 'compose') compose(opts);
  else if (opts.command === 'import') printImportReply(opts);
  else if (opts.command === 'fetch-replies') await fetchReplies(opts);
  else usage(1);
}

try {
  await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
