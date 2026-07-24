#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const stateDir = path.join(repoRoot, 'data', 'cache', 'daily-sync');
const logDir = path.join(repoRoot, 'logs');
const statePath = path.join(stateDir, 'state.json');
const lockPath = path.join(stateDir, 'sync.lock');
const logPath = path.join(logDir, 'daily-sync.log');

const commands = [
  ['npm', ['run', 'linkedin-email:fetch']],
  ['npm', ['run', 'linkedin-email:import']],
  ['npm', ['run', 'scan']],
  ['npm', ['run', 'sync-check']],
  ['npm', ['run', 'db:import']],
  ['npm', ['run', 'db:role-discovery']],
  ['npm', ['run', 'triage-unscored']],
  ['npm', ['run', 'db:check-active:api']],
  ['npm', ['run', 'db:export-pipeline']],
  ['npm', ['run', 'linkedin-email:qa']],
  ['npm', ['run', 'verify']],
  ['npm', ['run', 'db:summary']],
  ['npm', ['run', 'sync:daily:report']],
  ['npm', ['run', 'sync:daily:email']],
];

function parseArgs(argv) {
  const opts = {
    force: false,
    minAgeHours: Number(process.env.CAREER_OPS_SYNC_MIN_AGE_HOURS || 20),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') opts.force = true;
    else if (arg === '--min-age-hours') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('--min-age-hours must be a non-negative number');
      }
      opts.minAgeHours = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/daily-sync.mjs [--force] [--min-age-hours N]

Runs the full career-ops data sync. By default, exits successfully when the
last successful sync is newer than N hours, so wake-based schedulers can poll
without repeatedly hitting LinkedIn and ATS APIs.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function readState() {
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function acquireLock() {
  if (existsSync(lockPath)) {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    const staleMs = 6 * 60 * 60 * 1000;
    if (ageMs < staleMs) {
      throw new Error(`Sync already appears to be running: ${lockPath}`);
    }
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
}

function releaseLock() {
  if (existsSync(lockPath)) unlinkSync(lockPath);
}

function tee(logStream, chunk) {
  process.stdout.write(chunk);
  logStream.write(chunk);
}

function runCommand(command, args, logStream, env) {
  return new Promise((resolve, reject) => {
    const label = [command, ...args].join(' ');
    tee(logStream, `\n$ ${label}\n`);
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => tee(logStream, chunk));
    child.stderr.on('data', (chunk) => tee(logStream, chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}`));
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const state = readState();
  const lastSuccessAt = state.lastSuccessAt ? new Date(state.lastSuccessAt) : null;
  const ageHours = lastSuccessAt ? (Date.now() - lastSuccessAt.getTime()) / 36e5 : Infinity;

  if (!opts.force && ageHours < opts.minAgeHours) {
    const message = `career-ops daily sync skipped: last success ${ageHours.toFixed(1)}h ago; threshold ${opts.minAgeHours}h\n`;
    process.stdout.write(message);
    return;
  }

  const logStream = createWriteStream(logPath, { flags: 'a' });
  acquireLock();
  const startedAt = new Date().toISOString();
  const runEnv = {
    ...process.env,
    CAREER_OPS_SYNC_STARTED_AT: startedAt,
    CAREER_OPS_SYNC_PREVIOUS_SUCCESS_AT: state.lastSuccessAt || '',
  };
  tee(logStream, `\n=== career-ops daily sync started ${startedAt} ===\n`);

  try {
    for (const [command, args] of commands) {
      await runCommand(command, args, logStream, runEnv);
    }
    const finishedAt = new Date().toISOString();
    writeState({
      lastSuccessAt: finishedAt,
      lastStartedAt: startedAt,
      lastFailedAt: state.lastFailedAt || null,
      lastError: null,
    });
    tee(logStream, `\n=== career-ops daily sync finished ${finishedAt} ===\n`);
  } catch (err) {
    const failedAt = new Date().toISOString();
    writeState({
      ...state,
      lastStartedAt: startedAt,
      lastFailedAt: failedAt,
      lastError: err instanceof Error ? err.message : String(err),
    });
    tee(logStream, `\n=== career-ops daily sync failed ${failedAt} ===\n${err.stack || err}\n`);
    process.exitCode = 1;
  } finally {
    releaseLock();
    logStream.end();
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
