#!/usr/bin/env node

/**
 * record-posting-snapshot.mjs -- Persist a fetched JD/posting body for later parsing.
 *
 * This is the bridge between the agent-facing pipeline step that already has
 * the rendered JD text and the SQLite importer. It appends JSONL records to
 * data/cache/posting-snapshots.jsonl; `npm run db:import` links them to
 * job_postings and posting_snapshots.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { pathToFileURL } from 'url';

const SNAPSHOTS_PATH = process.env.CAREER_OPS_POSTING_SNAPSHOTS || 'data/cache/posting-snapshots.jsonl';

function usage() {
  console.log(`
Usage:
  node record-posting-snapshot.mjs --url URL --company "Acme" --title "Role" --file jd.txt
  node record-posting-snapshot.mjs --url URL --company "Acme" --role "Role" < jd.txt

Options:
  --url URL             Required posting URL
  --company NAME        Company name, if known
  --title TITLE         Role title, if known
  --role TITLE          Alias for --title
  --location LOCATION   Location, if known
  --source SOURCE       Snapshot source label (default: auto-pipeline)
  --file PATH           Read JD/posting text from PATH instead of stdin
  --captured-at DATE    YYYY-MM-DD or ISO timestamp (default: today)
`);
}

function parseArgs(argv) {
  const opts = { source: 'auto-pipeline' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--url') opts.url = take();
    else if (arg.startsWith('--url=')) opts.url = arg.slice(6);
    else if (arg === '--company') opts.company = take();
    else if (arg.startsWith('--company=')) opts.company = arg.slice(10);
    else if (arg === '--title' || arg === '--role') opts.title = take();
    else if (arg.startsWith('--title=')) opts.title = arg.slice(8);
    else if (arg.startsWith('--role=')) opts.title = arg.slice(7);
    else if (arg === '--location') opts.location = take();
    else if (arg.startsWith('--location=')) opts.location = arg.slice(11);
    else if (arg === '--source') opts.source = take();
    else if (arg.startsWith('--source=')) opts.source = arg.slice(9);
    else if (arg === '--file') opts.file = take();
    else if (arg.startsWith('--file=')) opts.file = arg.slice(7);
    else if (arg === '--captured-at') opts.capturedAt = take();
    else if (arg.startsWith('--captured-at=')) opts.capturedAt = arg.slice(14);
    else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function captureDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const trimmed = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid --captured-at value: ${value}`);
  return parsed.toISOString().slice(0, 10);
}

function normalizeScanScalar(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function normalizeScanUrl(value) {
  return String(value ?? '').trim().split(/\s+/)[0] || '';
}

function normalizeSnapshotText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '')
    .trim();
}

function formatPostingSnapshotRecord(offer, date) {
  const description = normalizeSnapshotText(offer.description);
  if (!description) return null;
  const url = normalizeScanUrl(offer.url);
  if (!url) return null;
  return {
    url,
    captured_at: `${date}T00:00:00Z`,
    title: normalizeSnapshotText(offer.title),
    company: normalizeSnapshotText(offer.company),
    location: normalizeSnapshotText(offer.location),
    description,
    raw_source: JSON.stringify({ source: normalizeScanScalar(offer.source) }),
  };
}

export function buildSnapshotRecord(opts, description) {
  const record = formatPostingSnapshotRecord({
    url: opts.url,
    company: opts.company || '',
    title: opts.title || '',
    location: opts.location || '',
    source: opts.source || 'auto-pipeline',
    description,
  }, captureDate(opts.capturedAt));
  if (!record) throw new Error('posting snapshot requires a non-empty --url and JD text');
  return record;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      usage();
      return 0;
    }
    if (!opts.url) throw new Error('--url is required');
    const description = opts.file ? readFileSync(opts.file, 'utf-8') : readStdin();
    const record = buildSnapshotRecord(opts, description);
    mkdirSync(dirname(SNAPSHOTS_PATH), { recursive: true });
    appendFileSync(SNAPSHOTS_PATH, JSON.stringify(record) + '\n', 'utf-8');
    console.log(JSON.stringify({ saved: true, path: SNAPSHOTS_PATH, url: record.url, captured_at: record.captured_at }));
    return 0;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    usage();
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
