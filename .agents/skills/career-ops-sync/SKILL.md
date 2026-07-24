---
name: career-ops-sync
description: Refresh the career-ops data pipeline end to end. Use when the user asks to sync data, pull LinkedIn leads, fetch new job postings, run the scan again, update SQLite, triage unscored jobs, remove expired/stale postings, export the pipeline, or verify the job-search database after a refresh.
---

# Career Ops Sync

## Overview

Run the repo-native refresh flow for `/Users/chadmorris/PycharmProjects/career-ops`. Prefer the existing npm scripts and report concrete counts, not a conceptual status summary.

## Preflight

1. Run `node doctor.mjs --json` and stop only if onboarding is required.
2. Run `node update-system.mjs check` silently unless the user explicitly asks about updates. If an update is available, ask before applying it.
3. Run `git status --short` and preserve unrelated user changes.

## Main Flow

Run these commands from the repo root:

```bash
npm run linkedin-email:fetch
npm run linkedin-email:import
npm run scan
npm run sync-check
npm run db:import
npm run db:role-discovery
npm run triage-unscored
npm run db:check-active:api
npm run db:export-pipeline
npm run linkedin-email:qa
npm run verify
npm run db:summary
```

## Network Handling

`linkedin-email:fetch`, `scan`, and `db:check-active:api` require network access. If they fail with DNS, `fetch failed`, or all-provider uncertainty, rerun the exact command with network approval before changing code or config.

The liveness pass is conservative: confirmed expired rows are updated, uncertain rows stay active. Do not force-expire uncertain postings unless the user explicitly asks.

## Optional Fallback

If the user asks for a broader browser-backed sweep, run a bounded active check rather than an unbounded Playwright pass:

```bash
npm run db:check-active -- --states pending,shortlisted --limit 50 --no-fallback --json
```

Use this only as a targeted follow-up; the API sweep is the normal maintenance path.

## Report Back

Summarize:

- LinkedIn messages fetched, new leads, imported/skipped, and final QA representation.
- Portal scan companies, total jobs found, new offers, and notable provider warnings.
- Triage count and strongest newly scored roles if visible.
- Liveness checked/active/expired/uncertain/updated counts plus named expired postings.
- Final `db:summary` state counts and whether `verify` passed.
