#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const home = os.homedir();
const uid = os.userInfo().uid;
const label = 'com.chadmorris.career-ops.awake-sync';
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const logDir = path.join(repoRoot, 'logs');
const stdoutPath = path.join(logDir, 'awake-sync.launchd.out.log');
const stderrPath = path.join(logDir, 'awake-sync.launchd.err.log');

function escapePlist(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plist({ intervalSeconds, minAgeHours }) {
  const command = `cd ${shellQuote(repoRoot)} && /usr/bin/env CAREER_OPS_SYNC_MIN_AGE_HOURS=${shellQuote(String(minAgeHours))} npm run sync:daily`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${escapePlist(command)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapePlist(repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${escapePlist(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(stderrPath)}</string>
</dict>
</plist>
`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseArgs(argv) {
  const opts = {
    action: argv[0] || 'status',
    intervalSeconds: 6 * 60 * 60,
    minAgeHours: 20,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--interval-seconds') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 60) throw new Error('--interval-seconds must be an integer >= 60');
      opts.intervalSeconds = value;
      i += 1;
    } else if (arg === '--min-age-hours') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 0) throw new Error('--min-age-hours must be a non-negative number');
      opts.minAgeHours = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/awake-sync-scheduler.mjs <install|uninstall|status|print> [options]

Options:
  --interval-seconds N  launchd polling interval while the laptop is awake (default: 21600)
  --min-age-hours N     runner throttle threshold for a successful sync (default: 20)
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (allowFailure) return err.stderr?.toString() || err.message;
    throw err;
  }
}

function install(opts) {
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(plistPath, plist(opts));
  runLaunchctl(['bootout', `gui/${uid}`, plistPath], { allowFailure: true });
  runLaunchctl(['bootstrap', `gui/${uid}`, plistPath]);
  runLaunchctl(['enable', `gui/${uid}/${label}`], { allowFailure: true });
  console.log(`Installed ${label}`);
  console.log(`Plist: ${plistPath}`);
  console.log(`Poll interval: ${opts.intervalSeconds}s`);
  console.log(`Sync throttle: ${opts.minAgeHours}h since last successful run`);
}

function uninstall() {
  runLaunchctl(['bootout', `gui/${uid}`, plistPath], { allowFailure: true });
  if (existsSync(plistPath)) unlinkSync(plistPath);
  console.log(`Uninstalled ${label}`);
}

function status() {
  console.log(`Label: ${label}`);
  console.log(`Plist: ${plistPath}`);
  console.log(`Installed: ${existsSync(plistPath) ? 'yes' : 'no'}`);
  if (existsSync(plistPath)) {
    const output = runLaunchctl(['print', `gui/${uid}/${label}`], { allowFailure: true });
    console.log(output.trim());
  }
}

const opts = parseArgs(process.argv.slice(2));
if (opts.action === 'install') install(opts);
else if (opts.action === 'uninstall') uninstall();
else if (opts.action === 'status') status();
else if (opts.action === 'print') process.stdout.write(plist(opts));
else throw new Error(`Unknown action: ${opts.action}`);
