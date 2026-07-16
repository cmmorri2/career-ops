# Local LinkedIn Email MCP

This repo can ingest LinkedIn job-alert emails from a dedicated mailbox without
using a hosted integration service.

## Security Model

- Runs locally over MCP stdio: `node mcp/linkedin-email-mcp.mjs`
- Fetches email via IMAP over TLS from the dedicated mailbox only
- Uses `EXAMINE` and `BODY.PEEK[]`, so it does not mark messages read
- Stores credentials only in local `.env`, which is gitignored
- Writes parsed leads to local files:
  - `data/linkedin-leads.jsonl`
  - `data/linkedin-email-processed.jsonl`
  - `data/linkedin-inbox.md`

## Configure

Copy `.env.example` to `.env` and set:

```bash
LINKEDIN_EMAIL_IMAP_HOST=imap.gmail.com
LINKEDIN_EMAIL_IMAP_PORT=993
LINKEDIN_EMAIL_IMAP_USER=your-dedicated-linkedin-email@gmail.com
LINKEDIN_EMAIL_IMAP_PASSWORD=your-app-password
LINKEDIN_EMAIL_IMAP_MAILBOX=INBOX
LINKEDIN_EMAIL_DAYS_BACK=7
LINKEDIN_EMAIL_MAX_MESSAGES=20
```

For Gmail, use an app password on the dedicated account. Do not put your main
email account here.

## Run From Shell

Fetch and parse recent LinkedIn email leads:

```bash
npm run linkedin-email:fetch
```

Audit parsed LinkedIn leads against the current job layer before import:

```bash
npm run linkedin-email:qa
```

Promote leads with job URLs into `data/scan-history.tsv` and
`data/pipeline.md`:

```bash
npm run linkedin-email:import
npm run db:import
npm run triage-unscored
npm run db:export-pipeline
npm run verify
```

## Matching Behavior

LinkedIn job alerts are treated as a broad discovery source because LinkedIn
limits monitored geographies and may send a superset of relevant jobs. During
import, the matcher checks `data/applications.md`, `data/pipeline.md`, and
`data/scan-history.tsv` to:

- skip exact URL duplicates
- skip company+title duplicates even if the LinkedIn location differs
- tag promoted leads as `known-company` or `new-company-discovery`
- write a mini-QA report to `data/linkedin-qa.md` showing whether each
  LinkedIn lead is already represented or missing from the current job layer

## MCP Server Command

Use this command in an MCP client that supports local stdio servers:

```bash
node mcp/linkedin-email-mcp.mjs
```

Tools exposed:

- `linkedin_email_status`
- `linkedin_email_fetch_leads`
- `linkedin_email_import_ready_leads`
- `linkedin_email_qa_leads`
- `linkedin_email_parse_fixture`
