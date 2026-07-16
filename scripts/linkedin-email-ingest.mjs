#!/usr/bin/env node
/**
 * linkedin-email-ingest.mjs — local-only LinkedIn job-alert ingestion.
 *
 * Pulls a dedicated mailbox over IMAP read-only, extracts LinkedIn job leads,
 * writes them to a local JSONL cache, and promotes resolvable job URLs into
 * the existing career-ops scan-history/pipeline path.
 */

import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import tls from 'tls';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_LEADS = resolve(ROOT, 'data/linkedin-leads.jsonl');
const DEFAULT_PROCESSED = resolve(ROOT, 'data/linkedin-email-processed.jsonl');
const DEFAULT_RAW_DIR = resolve(ROOT, 'data/cache/linkedin-email-raw');
const DEFAULT_PIPELINE = resolve(ROOT, 'data/pipeline.md');
const DEFAULT_SCAN_HISTORY = resolve(ROOT, 'data/scan-history.tsv');
const DEFAULT_APPLICATIONS = resolve(ROOT, 'data/applications.md');
const DEFAULT_QA_REPORT = resolve(ROOT, 'data/linkedin-qa.md');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function imapDate(daysBack = 7) {
  const d = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function cleanCell(value) {
  return String(value || '').replace(/\|/g, ';').replace(/\r?\n/g, ' ').trim();
}

function cleanTsv(value) {
  return String(value || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function decodeQuotedPrintable(input) {
  return String(input || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeMimeWords(input) {
  return String(input || '').replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_, charset, enc, data) => {
    try {
      const buffer = enc.toLowerCase() === 'b'
        ? Buffer.from(data, 'base64')
        : Buffer.from(decodeQuotedPrintable(data.replace(/_/g, ' ')), 'binary');
      return buffer.toString(/^utf-?8$/i.test(charset) ? 'utf8' : 'latin1');
    } catch {
      return data;
    }
  });
}

function parseHeaders(raw) {
  const [head = '', ...rest] = String(raw || '').split(/\r?\n\r?\n/);
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
  return { headers, body: rest.join('\n\n') };
}

function headerParam(value, name) {
  const re = new RegExp(`${name}="?([^";]+)"?`, 'i');
  return re.exec(value || '')?.[1] || '';
}

function decodeBody(body, encoding = '') {
  const enc = encoding.toLowerCase();
  if (enc.includes('quoted-printable')) return decodeQuotedPrintable(body);
  if (enc.includes('base64')) {
    try {
      return Buffer.from(String(body).replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }
  return body;
}

function extractMimeText(raw) {
  const { headers, body } = parseHeaders(raw);
  const contentType = headers['content-type'] || '';
  const encoding = headers['content-transfer-encoding'] || '';
  const boundary = headerParam(contentType, 'boundary');

  if (boundary) {
    const parts = body.split(`--${boundary}`).filter(p => p.trim() && !p.trim().startsWith('--'));
    const extracted = parts.map(part => extractMimeText(part.trim())).filter(Boolean);
    return extracted.join('\n\n');
  }

  const decoded = decodeBody(body, encoding);
  if (/text\/html/i.test(contentType) || /<html|<body|<a\s/i.test(decoded)) {
    return decodeHtmlEntities(decoded
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' '));
  }
  return decodeHtmlEntities(decoded);
}

function extractLinks(raw) {
  const text = decodeHtmlEntities(decodeQuotedPrintable(raw));
  const hrefs = [...text.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]);
  const bare = [...text.matchAll(/https?:\/\/[^\s<>"')]+/gi)].map(m => m[0]);
  return [...new Set([...hrefs, ...bare].map(normalizeUrl).filter(Boolean))];
}

function extractVisibleLines(raw) {
  const decoded = decodeHtmlEntities(decodeQuotedPrintable(String(raw || ''))).replace(/\u00a0/g, ' ');
  const text = decoded
    .replace(/<(br|\/tr|\/td|\/div|\/h[1-6]|\/p)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');
  return text.split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function normalizeUrl(url) {
  if (!url) return '';
  let out = decodeHtmlEntities(String(url)).trim();
  try {
    const parsed = new URL(out);
    const redirect = parsed.searchParams.get('url') || parsed.searchParams.get('u');
    if (redirect && /^https?:/i.test(redirect)) out = redirect;
  } catch {
    return '';
  }
  return out.replace(/[>,.]+$/g, '');
}

function normalizeLinkedInJobUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    const id = /\/(?:comm\/)?jobs\/view\/(\d+)/.exec(parsed.pathname)?.[1];
    if (parsed.hostname.endsWith('linkedin.com') && id) {
      return `https://www.linkedin.com/jobs/view/${id}`;
    }
  } catch {}
  return normalized;
}

function uniqueJobLinks(links) {
  const seen = new Set();
  const out = [];
  for (const url of links.map(normalizeLinkedInJobUrl)) {
    const id = /linkedin\.com\/jobs\/view\/(\d+)/i.exec(url)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(`https://www.linkedin.com/jobs/view/${id}`);
  }
  return out;
}

function looksLikeForwardedNoise(line) {
  const text = String(line || '').trim();
  return !text
    || text.length > 140
    || /(?:^|\s)(To:|From:|Subject:|Content-|Message-ID:|MIME-Version:)/i.test(text)
    || /Your job alert|match your preferences|looking for an|This email was intended|Get the new LinkedIn|See all jobs|Search for more/i.test(text)
    || /[<>]|Í|͏|â|Â/.test(text);
}

function likelyJobUrl(url) {
  return /linkedin\.com\/(?:comm\/)?jobs\/view|jobs\.ashbyhq\.com|greenhouse\.io|jobs\.lever\.co|workdayjobs\.com|smartrecruiters\.com|apply\.workable\.com|careers\./i.test(url);
}

function stableLeadKey(lead) {
  const urlKey = lead.jobUrl || '';
  if (urlKey) return `url:${urlKey}`;
  return `lead:${lead.company.toLowerCase()}::${lead.title.toLowerCase()}::${lead.location.toLowerCase()}`;
}

function parseLinkedInLeads(raw, meta = {}) {
  const { headers } = parseHeaders(raw);
  const subject = decodeMimeWords(headers.subject || meta.subject || '');
  const receivedAt = meta.receivedAt || headers.date || '';
  const messageId = meta.messageId || headers['message-id'] || meta.uid || '';
  const text = extractMimeText(raw).replace(/\u00a0/g, ' ');
  const decodedRawText = decodeHtmlEntities(decodeQuotedPrintable(String(raw || ''))).replace(/\u00a0/g, ' ');
  const links = extractLinks(raw).filter(likelyJobUrl).map(normalizeLinkedInJobUrl);
  const jobLinks = uniqueJobLinks(links);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const leads = [];
  const isForwardedMessage = /-{5,}\s*Forwarded message\s*-{5,}/i.test(decodedRawText);

  const similarMatch = /(?:Subject:\s*)?New jobs similar to\s+(.+?)\s+at\s+(.+?)(?:\r?\n|$)/i.exec(decodedRawText);
  if (similarMatch && jobLinks[0]) {
    const title = decodeMimeWords(similarMatch[1]).replace(/\s+/g, ' ').trim();
    const company = decodeMimeWords(similarMatch[2]).replace(/\s+/g, ' ').trim();
    if (title && company && !looksLikeNonJobLine(title) && !looksLikeNonJobLine(company)) {
      const lead = {
        id: '',
        source: 'linkedin-email',
        sourceMessageId: String(messageId || ''),
        sourceUid: meta.uid || '',
        receivedAt,
        alertName: subject,
        company,
        title,
        location: '',
        workModel: '',
        jobUrl: jobLinks[0],
        allJobUrls: links,
        status: 'ready_to_import',
        snippet: `${title} | ${company}`,
        parsedAt: new Date().toISOString(),
      };
      lead.id = stableLeadKey(lead);
      leads.push(lead);
    }
  }

  const decodedLines = decodedRawText.split(/\r?\n/).map(line => line.trim());
  for (let i = 0; i < decodedLines.length; i += 1) {
    const viewMatch = /^View job:\s*(https?:\/\/www\.linkedin\.com\/(?:comm\/)?jobs\/view\/\d+\/?[^\s]*)/i.exec(decodedLines[i]);
    if (!viewMatch) continue;
    const prior = [];
    for (let j = i - 1; j >= 0 && prior.length < 3; j -= 1) {
      const line = decodedLines[j];
      if (!line || isDigestSignalLine(line)) continue;
      prior.unshift(line);
    }
    if (prior.length < 3) continue;
    const [title, company, locationRaw] = prior;
    const jobUrl = normalizeLinkedInJobUrl(viewMatch[1]);
    if (looksLikeNonJobLine(title) || looksLikeNonJobLine(company) || looksLikeNonJobLine(locationRaw)) continue;
    const locationMatch = /^(.+?)(?:\s+\(([^)]+)\))?$/.exec(locationRaw);
    const location = locationMatch?.[1]?.trim() || locationRaw;
    const workModel = locationMatch?.[2]?.trim() || '';
    const lead = {
      id: '',
      source: 'linkedin-email',
      sourceMessageId: String(messageId || ''),
      sourceUid: meta.uid || '',
      receivedAt,
      alertName: subject,
      company,
      title,
      location,
      workModel,
      jobUrl,
      allJobUrls: links,
      status: jobUrl ? 'ready_to_import' : 'needs_url',
      snippet: `${title} | ${company} | ${location}${workModel ? ` (${workModel})` : ''}`,
      parsedAt: new Date().toISOString(),
    };
    lead.id = stableLeadKey(lead);
    leads.push(lead);
  }

  if (!isForwardedMessage) {
    for (let i = 0; i < lines.length; i += 1) {
      const title = lines[i];
      const next = lines[i + 1] || '';
      const match = /^(.+?)\s+(?:·|Â·)\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(next);
      if (!match) continue;
      if (!/[A-Za-z]/.test(title) || title.length < 4 || title.length > 180) continue;
      if (looksLikeForwardedNoise(title)) continue;
      const company = match[1].trim();
      const location = match[2].trim();
      const workModel = match[3]?.trim() || '';
      if (!company || !location) continue;
      if (looksLikeForwardedNoise(company) || looksLikeForwardedNoise(location)) continue;
      const jobUrl = links.find(url => url.toLowerCase().includes(company.toLowerCase().split(/\s+/)[0])) || links[leads.length] || '';
      const lead = {
        id: '',
        source: 'linkedin-email',
        sourceMessageId: String(messageId || ''),
        sourceUid: meta.uid || '',
        receivedAt,
        alertName: subject,
        company,
        title,
        location,
        workModel,
        jobUrl,
        allJobUrls: links,
        status: jobUrl ? 'ready_to_import' : 'needs_url',
        snippet: `${title} | ${company} | ${location}${workModel ? ` (${workModel})` : ''}`,
        parsedAt: new Date().toISOString(),
      };
      lead.id = stableLeadKey(lead);
      leads.push(lead);
    }
  }

  const visibleLines = extractVisibleLines(raw);
  const fallbackCards = [];
  for (let i = 0; i < visibleLines.length; i += 1) {
    const title = visibleLines[i];
    const next = visibleLines[i + 1] || '';
    const match = /^(.+?)\s+(?:·|Â·)\s+(.+?)(?:\s+\(([^)]+)\))?$/.exec(next);
    if (!match) continue;
    if (!/[A-Za-z]/.test(title) || title.length < 4 || title.length > 180) continue;
    if (looksLikeNonJobLine(title) || isDigestSignalLine(title)) continue;
    if (looksLikeForwardedNoise(title)) continue;
    const company = match[1].trim();
    const location = match[2].trim();
    const workModel = match[3]?.trim() || '';
    if (looksLikeNonJobLine(company) || looksLikeNonJobLine(location) || isDigestSignalLine(company) || isDigestSignalLine(location)) continue;
    if (looksLikeForwardedNoise(company) || looksLikeForwardedNoise(location)) continue;
    fallbackCards.push({ title, company, location, workModel });
  }
  const fallbackSeen = new Set();
  const fallbackStart = similarMatch ? 1 : 0;
  for (let i = 0; i < fallbackCards.length; i += 1) {
    const { title, company, location, workModel } = fallbackCards[i];
    const jobUrl = jobLinks[fallbackStart + i] || '';
    if (!jobUrl) continue;
    const cardKey = leadKey(company, title, location);
    if (fallbackSeen.has(cardKey)) continue;
    fallbackSeen.add(cardKey);
    const lead = {
      id: '',
      source: 'linkedin-email',
      sourceMessageId: String(messageId || ''),
      sourceUid: meta.uid || '',
      receivedAt,
      alertName: subject,
      company,
      title,
      location,
      workModel,
      jobUrl,
      allJobUrls: links,
      status: jobUrl ? 'ready_to_import' : 'needs_url',
      snippet: `${title} | ${company} | ${location}${workModel ? ` (${workModel})` : ''}`,
      parsedAt: new Date().toISOString(),
    };
    lead.id = stableLeadKey(lead);
    leads.push(lead);
  }

  return dedupeLeads(leads);
}

function looksLikeNonJobLine(line) {
  return /^(content-|mime-version|message-id|date:|from:|to:|subject:|view job:|your job alert|new jobs match|[-=]{5,}|unsubscribe|linkedin)$/i.test(String(line || '').trim());
}

function isDigestSignalLine(line) {
  return /^(\d+\s+(?:school|company)?\s*alumni|\d+\s+(?:school|company)\s+alum|\d+\s+connections?|1 connection|Apply with resume & profile|This company is actively hiring|-{5,}|Your job alert|New jobs match|Content-|MIME-Version|To:|From:|Subject:)/i.test(String(line || '').trim());
}

function dedupeLeads(leads) {
  const seen = new Set();
  return leads.filter(lead => {
    const key = stableLeadKey(lead);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function appendJsonl(path, rows) {
  if (!rows.length) return;
  ensureParent(path);
  appendFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function appendMarkdownInbox(path, leads) {
  if (!leads.length) return;
  if (!existsSync(path)) {
    ensureParent(path);
    writeFileSync(path, [
      '# LinkedIn Job Email Inbox',
      '',
      '| Date | Source Email / Alert | Company | Role | Location | Work Model | Signal | Status | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
    ].join('\n') + '\n', 'utf8');
  }
  const date = today();
  const rows = leads.map(lead => `| ${date} | ${cleanCell(lead.alertName)} | ${cleanCell(lead.company)} | ${cleanCell(lead.title)} | ${cleanCell(lead.location)} | ${cleanCell(lead.workModel)} | LinkedIn email alert | ${lead.status === 'ready_to_import' ? 'Ready' : 'Needs URL/JD'} | ${lead.jobUrl ? cleanCell(lead.jobUrl) : 'No canonical URL found in email parse.'} |`);
  appendFileSync(path, rows.join('\n') + '\n', 'utf8');
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
    this.socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); });
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
      if (lines.some(line => line.startsWith(`${tag} OK`) || line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`))) {
        if (!text.includes(`${tag} OK`)) throw new Error(`IMAP command failed: ${commandText}\n${text}`);
        return Buffer.from(this.buffer);
      }
      await sleep(25);
    }
    throw new Error(`Timed out running IMAP command: ${commandText}`);
  }

  async search({ daysBack = 7, from = '' } = {}) {
    const criteria = ['SINCE', imapDate(daysBack)];
    if (from) criteria.push('FROM', `"${escapeImap(from)}"`);
    const out = (await this.command(`SEARCH ${criteria.join(' ')}`)).toString('utf8');
    const line = out.split(/\r?\n/).find(l => l.startsWith('* SEARCH')) || '';
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

function escapeImap(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function configFromEnv() {
  return {
    host: env('LINKEDIN_EMAIL_IMAP_HOST', env('IMAP_HOST', 'imap.gmail.com')),
    port: Number(env('LINKEDIN_EMAIL_IMAP_PORT', env('IMAP_PORT', '993'))),
    user: env('LINKEDIN_EMAIL_IMAP_USER', env('IMAP_USER')),
    password: env('LINKEDIN_EMAIL_IMAP_PASSWORD', env('IMAP_PASSWORD')),
    mailbox: env('LINKEDIN_EMAIL_IMAP_MAILBOX', env('IMAP_MAILBOX', 'INBOX')),
    from: env('LINKEDIN_EMAIL_FROM', ''),
    daysBack: Number(env('LINKEDIN_EMAIL_DAYS_BACK', '7')),
    maxMessages: Number(env('LINKEDIN_EMAIL_MAX_MESSAGES', '20')),
    leadsPath: env('LINKEDIN_EMAIL_LEADS_PATH', DEFAULT_LEADS),
    processedPath: env('LINKEDIN_EMAIL_PROCESSED_PATH', DEFAULT_PROCESSED),
    markdownInboxPath: env('LINKEDIN_EMAIL_MARKDOWN_INBOX', resolve(ROOT, 'data/linkedin-inbox.md')),
    rawDir: env('LINKEDIN_EMAIL_RAW_DIR', DEFAULT_RAW_DIR),
    saveRaw: env('LINKEDIN_EMAIL_SAVE_RAW', '') === '1',
    pipelinePath: env('LINKEDIN_EMAIL_PIPELINE_PATH', DEFAULT_PIPELINE),
    scanHistoryPath: env('LINKEDIN_EMAIL_SCAN_HISTORY_PATH', DEFAULT_SCAN_HISTORY),
    applicationsPath: env('LINKEDIN_EMAIL_APPLICATIONS_PATH', DEFAULT_APPLICATIONS),
    qaReportPath: env('LINKEDIN_EMAIL_QA_REPORT_PATH', DEFAULT_QA_REPORT),
  };
}

function requireMailboxConfig(config) {
  const missing = [];
  for (const key of ['host', 'user', 'password']) {
    if (!config[key]) missing.push(key);
  }
  if (missing.length) throw new Error(`Missing IMAP config: ${missing.join(', ')}. Set LINKEDIN_EMAIL_IMAP_HOST, LINKEDIN_EMAIL_IMAP_USER, LINKEDIN_EMAIL_IMAP_PASSWORD in .env`);
}

export async function fetchLinkedInEmailLeads(options = {}) {
  const config = { ...configFromEnv(), ...options };
  requireMailboxConfig(config);
  const processed = new Set(readJsonl(config.processedPath).map(row => String(row.uid || row.sourceUid || '')));
  const existingLeadIds = new Set(readJsonl(config.leadsPath).map(row => row.id));
  const client = new ImapClient(config);
  const imported = [];
  const processedRows = [];
  await client.connect();
  try {
    const ids = (await client.search({ daysBack: config.daysBack, from: config.from })).slice(-config.maxMessages);
    for (const seq of ids) {
      const { uid, raw } = await client.fetchRaw(seq);
      if (processed.has(String(uid))) continue;
      if (config.saveRaw) {
        ensureParent(resolve(config.rawDir, 'placeholder'));
        writeFileSync(resolve(config.rawDir, `${uid}.eml`), raw, { mode: 0o600 });
      }
      const leads = parseLinkedInLeads(raw, { uid });
      const fresh = leads.filter(lead => !existingLeadIds.has(lead.id));
      for (const lead of fresh) existingLeadIds.add(lead.id);
      imported.push(...fresh);
      processedRows.push({ uid, processedAt: new Date().toISOString(), leadCount: leads.length });
    }
  } finally {
    await client.close();
  }
  appendJsonl(config.leadsPath, imported);
  appendJsonl(config.processedPath, processedRows);
  appendMarkdownInbox(config.markdownInboxPath, imported);
  return { fetched: processedRows.length, newLeads: imported.length, leads: imported };
}

function readSeenPipelineUrls(path) {
  if (!existsSync(path)) return new Set();
  const text = readFileSync(path, 'utf8');
  return new Set([...text.matchAll(/- \[[ xX]\]\s+(\S+)/g)].map(m => m[1]));
}

function readSeenScanUrls(path) {
  if (!existsSync(path)) return new Set();
  return new Set(readFileSync(path, 'utf8').split(/\r?\n/).slice(1).map(line => line.split('\t')[0]).filter(Boolean));
}

function readPipelineRows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).map(line => {
    const match = /^- \[[ xX]\]\s+(.+)$/.exec(line.trim());
    if (!match) return null;
    const parts = match[1].split('|').map(p => p.trim());
    return {
      url: parts[0] || '',
      company: parts[1] || '',
      title: parts[2] || '',
      location: parts[3] || '',
      raw: line.trim(),
      layer: 'pipeline',
    };
  }).filter(Boolean);
}

function readScanRows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).slice(1).map(line => {
    if (!line.trim()) return null;
    const parts = line.split('\t');
    return {
      url: parts[0] || '',
      company: parts[4] || '',
      title: parts[3] || '',
      location: parts[6] || '',
      raw: line,
      layer: 'scan-history',
    };
  }).filter(Boolean);
}

function readApplicationLeadRows(path) {
  return readApplicationsRows(path).map(parts => ({
    url: '',
    company: parts[3] || '',
    title: parts[4] || '',
    location: '',
    raw: parts.join(' | '),
    layer: 'applications',
  }));
}

function leadKey(company, title, location = '') {
  const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${norm(company)}::${norm(title)}::${norm(location)}`;
}

function normName(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function companyTitleKey(company, title) {
  return `${normName(company)}::${normName(title)}`;
}

function readApplicationsRows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/)
    .filter(line => line.trim().startsWith('|') && !/^\|\s*-/.test(line) && !/\|\s*Company\s*\|/i.test(line))
    .map(line => line.split('|').map(part => part.trim()))
    .filter(parts => parts[3] && parts[4]);
}

function readKnownCompanies({ applicationsPath, pipelinePath, scanHistoryPath }) {
  const companies = new Set();
  for (const parts of readApplicationsRows(applicationsPath)) companies.add(normName(parts[3]));
  if (existsSync(pipelinePath)) {
    for (const line of readFileSync(pipelinePath, 'utf8').split(/\r?\n/)) {
      const match = /^- \[[ xX]\]\s+(.+)$/.exec(line.trim());
      if (!match) continue;
      const parts = match[1].split('|').map(p => p.trim());
      if (parts[1]) companies.add(normName(parts[1]));
    }
  }
  if (existsSync(scanHistoryPath)) {
    for (const line of readFileSync(scanHistoryPath, 'utf8').split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts[4]) companies.add(normName(parts[4]));
    }
  }
  companies.delete('');
  return companies;
}

function readSeenCompanyTitleKeys({ applicationsPath, pipelinePath, scanHistoryPath }) {
  const keys = new Set();
  for (const parts of readApplicationsRows(applicationsPath)) keys.add(companyTitleKey(parts[3], parts[4]));
  if (existsSync(pipelinePath)) {
    for (const line of readFileSync(pipelinePath, 'utf8').split(/\r?\n/)) {
      const match = /^- \[[ xX]\]\s+(.+)$/.exec(line.trim());
      if (!match) continue;
      const parts = match[1].split('|').map(p => p.trim());
      if (parts[1] && parts[2]) keys.add(companyTitleKey(parts[1], parts[2]));
    }
  }
  if (existsSync(scanHistoryPath)) {
    for (const line of readFileSync(scanHistoryPath, 'utf8').split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts[4] && parts[3]) keys.add(companyTitleKey(parts[4], parts[3]));
    }
  }
  keys.delete('::');
  return keys;
}

function buildKnownJobIndex(config) {
  const rows = [
    ...readApplicationLeadRows(config.applicationsPath),
    ...readPipelineRows(config.pipelinePath),
    ...readScanRows(config.scanHistoryPath),
  ];
  const byUrl = new Map();
  const byLeadKey = new Map();
  const byCompanyTitle = new Map();
  for (const row of rows) {
    if (row.url) byUrl.set(row.url, row);
    byLeadKey.set(leadKey(row.company, row.title, row.location), row);
    byCompanyTitle.set(companyTitleKey(row.company, row.title), row);
  }
  return { rows, byUrl, byLeadKey, byCompanyTitle };
}

function classifyLeadForQa(lead, config, index = buildKnownJobIndex(config)) {
  if (lead.status !== 'ready_to_import' || !lead.jobUrl) {
    return {
      ...lead,
      qaStatus: 'needs_url',
      qaReason: 'LinkedIn email parse did not expose a usable job URL.',
      matchedLayer: '',
      matchedLocation: '',
    };
  }
  const exactUrl = index.byUrl.get(lead.jobUrl);
  if (exactUrl) {
    return {
      ...lead,
      qaStatus: 'represented_by_url',
      qaReason: `Exact URL already exists in ${exactUrl.layer}.`,
      matchedLayer: exactUrl.layer,
      matchedLocation: exactUrl.location || '',
    };
  }
  const exactLead = index.byLeadKey.get(leadKey(lead.company, lead.title, lead.location));
  if (exactLead) {
    return {
      ...lead,
      qaStatus: 'represented_by_company_title_location',
      qaReason: `Same company, title, and location already exist in ${exactLead.layer}.`,
      matchedLayer: exactLead.layer,
      matchedLocation: exactLead.location || '',
    };
  }
  const companyTitle = index.byCompanyTitle.get(companyTitleKey(lead.company, lead.title));
  if (companyTitle) {
    return {
      ...lead,
      qaStatus: 'represented_by_company_title',
      qaReason: `Same company and title already exist in ${companyTitle.layer}; LinkedIn location may be broader.`,
      matchedLayer: companyTitle.layer,
      matchedLocation: companyTitle.location || '',
    };
  }
  const knownCompanies = readKnownCompanies(config);
  return {
    ...lead,
    qaStatus: 'not_represented',
    qaReason: knownCompanies.has(normName(lead.company))
      ? 'Known company surfaced a role not found in current job layer.'
      : 'New company and role not found in current job layer.',
    matchedLayer: '',
    matchedLocation: '',
    importSignal: knownCompanies.has(normName(lead.company)) ? 'known-company' : 'new-company-discovery',
  };
}

function summarizeQa(rows) {
  const summary = {};
  for (const row of rows) summary[row.qaStatus] = (summary[row.qaStatus] || 0) + 1;
  return summary;
}

function writeQaReport(path, rows, summary) {
  ensureParent(path);
  const order = ['not_represented', 'represented_by_company_title', 'represented_by_url', 'represented_by_company_title_location', 'needs_url'];
  const lines = [
    '# LinkedIn Job Email QA',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    ...order.filter(key => summary[key]).map(key => `- ${key}: ${summary[key]}`),
    '',
    '## Leads',
    '',
    '| QA Status | Company | Role | Location | Match | Reason | URL |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(row => [
      cleanCell(row.qaStatus),
      cleanCell(row.company),
      cleanCell(row.title),
      cleanCell(row.location),
      cleanCell([row.matchedLayer, row.matchedLocation].filter(Boolean).join(': ')),
      cleanCell(row.qaReason),
      cleanCell(row.jobUrl || ''),
    ].join(' | ')).map(row => `| ${row} |`),
  ];
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

function readSeenLeadKeys(pipelinePath, scanHistoryPath) {
  const keys = new Set();
  if (existsSync(pipelinePath)) {
    for (const line of readFileSync(pipelinePath, 'utf8').split(/\r?\n/)) {
      const match = /^- \[[ xX]\]\s+(.+)$/.exec(line.trim());
      if (!match) continue;
      const parts = match[1].split('|').map(p => p.trim());
      if (parts.length >= 3) keys.add(leadKey(parts[1], parts[2], parts[3] || ''));
    }
  }
  if (existsSync(scanHistoryPath)) {
    for (const line of readFileSync(scanHistoryPath, 'utf8').split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length >= 7) keys.add(leadKey(parts[4], parts[3], parts[6]));
      else if (parts.length >= 5) keys.add(leadKey(parts[4], parts[3], ''));
    }
  }
  return keys;
}

function ensurePipeline(path) {
  if (existsSync(path)) return;
  ensureParent(path);
  writeFileSync(path, '# Pipeline — Pending URLs\n\n## Pending\n\n## Processed\n', 'utf8');
}

function appendPipeline(path, leads) {
  if (!leads.length) return;
  ensurePipeline(path);
  const text = readFileSync(path, 'utf8');
  const marker = '## Pending';
  const idx = text.indexOf(marker);
  const lines = leads.map(lead => {
    const suffix = [
      cleanCell(lead.location),
      `note: LinkedIn email lead; ${lead.importSignal || 'new-company-discovery'}${lead.workModel ? `; ${lead.workModel}` : ''}`,
    ].filter(Boolean).join(' | ');
    return `- [ ] ${lead.jobUrl} | ${cleanCell(lead.company)} | ${cleanCell(lead.title)}${suffix ? ` | ${suffix}` : ''}`;
  }).join('\n') + '\n';
  if (idx === -1) {
    appendFileSync(path, `\n## Pending\n\n${lines}`, 'utf8');
    return;
  }
  const after = idx + marker.length;
  const next = text.indexOf('\n## ', after);
  const insertAt = next === -1 ? text.length : next;
  writeFileSync(path, text.slice(0, insertAt) + '\n' + lines + text.slice(insertAt), 'utf8');
}

function appendScanHistory(path, leads) {
  if (!leads.length) return;
  if (!existsSync(path)) {
    ensureParent(path);
    writeFileSync(path, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf8');
  }
  const date = today();
  const rows = leads.map(lead => [
    lead.jobUrl,
    date,
    'linkedin-email',
    lead.title,
    lead.company,
    'added',
    lead.location,
  ].map(cleanTsv).join('\t'));
  appendFileSync(path, rows.join('\n') + '\n', 'utf8');
}

export function importLinkedInLeads(options = {}) {
  const config = { ...configFromEnv(), ...options };
  const leads = readJsonl(config.leadsPath);
  const seenUrls = new Set([...readSeenPipelineUrls(config.pipelinePath), ...readSeenScanUrls(config.scanHistoryPath)]);
  const seenLeadKeys = readSeenLeadKeys(config.pipelinePath, config.scanHistoryPath);
  const seenCompanyTitleKeys = readSeenCompanyTitleKeys(config);
  const knownCompanies = readKnownCompanies(config);
  const ready = leads
    .filter(lead => lead.status === 'ready_to_import' && lead.jobUrl)
    .filter(lead => !seenUrls.has(lead.jobUrl))
    .filter(lead => !seenLeadKeys.has(leadKey(lead.company, lead.title, lead.location)))
    .filter(lead => !seenCompanyTitleKeys.has(companyTitleKey(lead.company, lead.title)))
    .map(lead => ({
      ...lead,
      importSignal: knownCompanies.has(normName(lead.company)) ? 'known-company' : 'new-company-discovery',
    }));
  appendPipeline(config.pipelinePath, ready);
  appendScanHistory(config.scanHistoryPath, ready);
  return { imported: ready.length, skipped: leads.length - ready.length, leads: ready };
}

export function qaLinkedInLeads(options = {}) {
  const config = { ...configFromEnv(), ...options };
  const leads = readJsonl(config.leadsPath);
  const index = buildKnownJobIndex(config);
  const rows = leads.map(lead => classifyLeadForQa(lead, config, index));
  const summary = summarizeQa(rows);
  writeQaReport(config.qaReportPath, rows, summary);
  return { leadCount: rows.length, summary, reportPath: config.qaReportPath, leads: rows };
}

export function parseFixture(raw, options = {}) {
  return parseLinkedInLeads(raw, options);
}

async function main() {
  const command = process.argv[2] || 'help';
  if (command === 'fetch') {
    console.log(JSON.stringify(await fetchLinkedInEmailLeads(), null, 2));
    return;
  }
  if (command === 'import') {
    console.log(JSON.stringify(importLinkedInLeads(), null, 2));
    return;
  }
  if (command === 'qa') {
    console.log(JSON.stringify(qaLinkedInLeads(), null, 2));
    return;
  }
  if (command === 'parse-fixture') {
    const path = process.argv[3];
    if (!path) throw new Error('Usage: node scripts/linkedin-email-ingest.mjs parse-fixture path/to/email.eml');
    console.log(JSON.stringify(parseFixture(readFileSync(path, 'utf8')), null, 2));
    return;
  }
  console.log(`Usage:
  node scripts/linkedin-email-ingest.mjs fetch
  node scripts/linkedin-email-ingest.mjs import
  node scripts/linkedin-email-ingest.mjs qa
  node scripts/linkedin-email-ingest.mjs parse-fixture path/to/email.eml`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
