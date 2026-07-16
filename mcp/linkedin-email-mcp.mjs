#!/usr/bin/env node
/**
 * Local MCP server for dedicated LinkedIn job-alert email ingestion.
 *
 * Transport: stdio JSON-RPC. No hosted middleware.
 */

import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  fetchLinkedInEmailLeads,
  importLinkedInLeads,
  parseFixture,
  qaLinkedInLeads,
} from '../scripts/linkedin-email-ingest.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const TOOLS = [
  {
    name: 'linkedin_email_fetch_leads',
    description: 'Fetch recent LinkedIn job-alert emails from the dedicated local IMAP mailbox and append parsed leads to local career-ops lead files.',
    inputSchema: {
      type: 'object',
      properties: {
        daysBack: { type: 'number', description: 'How many days back to search the inbox.' },
        maxMessages: { type: 'number', description: 'Maximum messages to fetch in this run.' },
        from: { type: 'string', description: 'Optional IMAP FROM filter.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_email_import_ready_leads',
    description: 'Promote locally parsed LinkedIn leads with job URLs into scan-history and pipeline for normal career-ops dedupe/triage.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_email_qa_leads',
    description: 'Audit parsed LinkedIn leads against applications, pipeline, and scan history to find missing or filtered job-layer coverage.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_email_parse_fixture',
    description: 'Parse a raw .eml file or raw email text into LinkedIn job leads without contacting the mailbox.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Local .eml fixture path to parse.' },
        raw: { type: 'string', description: 'Raw email source to parse. Used when path is omitted.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_email_status',
    description: 'Show local LinkedIn email lead-cache status and whether required IMAP environment variables are present.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

function env(name) {
  return process.env[name] || '';
}

function readJsonlCount(path) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).length;
}

function localStatus() {
  const leadsPath = env('LINKEDIN_EMAIL_LEADS_PATH') || resolve(ROOT, 'data/linkedin-leads.jsonl');
  const processedPath = env('LINKEDIN_EMAIL_PROCESSED_PATH') || resolve(ROOT, 'data/linkedin-email-processed.jsonl');
  return {
    localOnly: true,
    imapConfigured: Boolean(env('LINKEDIN_EMAIL_IMAP_USER') || env('IMAP_USER')) && Boolean(env('LINKEDIN_EMAIL_IMAP_PASSWORD') || env('IMAP_PASSWORD')),
    imapHost: env('LINKEDIN_EMAIL_IMAP_HOST') || env('IMAP_HOST') || 'imap.gmail.com',
    mailbox: env('LINKEDIN_EMAIL_IMAP_MAILBOX') || env('IMAP_MAILBOX') || 'INBOX',
    leadsPath,
    processedPath,
    leadRows: readJsonlCount(leadsPath),
    processedMessages: readJsonlCount(processedPath),
  };
}

async function callTool(name, args = {}) {
  if (name === 'linkedin_email_fetch_leads') {
    const result = await fetchLinkedInEmailLeads({
      daysBack: args.daysBack,
      maxMessages: args.maxMessages,
      from: args.from,
    });
    return result;
  }
  if (name === 'linkedin_email_import_ready_leads') {
    return importLinkedInLeads();
  }
  if (name === 'linkedin_email_qa_leads') {
    return qaLinkedInLeads();
  }
  if (name === 'linkedin_email_parse_fixture') {
    const raw = args.path ? readFileSync(args.path, 'utf8') : String(args.raw || '');
    if (!raw) throw new Error('Provide either path or raw email content.');
    const leads = parseFixture(raw);
    return { leads, count: leads.length };
  }
  if (name === 'linkedin_email_status') {
    return localStatus();
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(request) {
  const { id, method, params = {} } = request;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'career-ops-linkedin-email', version: '0.1.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    try {
      const result = await callTool(params.name, params.arguments || {});
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        },
      });
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: err.message || String(err) },
      });
    }
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let idx;
  while ((idx = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, idx).trim();
    input = input.slice(idx + 1);
    if (!line) continue;
    try {
      const request = JSON.parse(line);
      handle(request);
    } catch (err) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message || 'Parse error' } });
    }
  }
});
