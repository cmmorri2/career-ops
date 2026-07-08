#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));
const source = args.source || '';
const url = args.url || '';

if (!source || !url) {
  throw new Error('Usage: strategic-careers.mjs --source <apple|google|microsoft> --url <search-url>');
}

const handlers = {
  apple: parseApple,
  google: parseGoogle,
  microsoft: parseMicrosoft,
};

if (!handlers[source]) {
  throw new Error(`Unknown strategic career source: ${source}`);
}

const jobs = await handlers[source](url);
process.stdout.write(JSON.stringify(jobs, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    parsed[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return parsed;
}

async function fetchText(urlToFetch) {
  const res = await fetch(urlToFetch, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 (compatible; career-ops/1.17)',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${urlToFetch}`);
  return await res.text();
}

async function fetchJson(urlToFetch) {
  const res = await fetchWithRetries(urlToFetch, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (compatible; career-ops/1.17)',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${urlToFetch}`);
  return await res.json();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanText(value) {
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueJobs(jobs) {
  const seen = new Set();
  return jobs.filter((job) => {
    if (!job.title || !job.url) return false;
    if (seen.has(job.url)) return false;
    seen.add(job.url);
    return true;
  });
}

async function parseApple(searchUrl) {
  const html = await fetchText(searchUrl);
  const jobs = [];
  const re = /<a\b[^>]*href="([^"]*\/en-us\/details\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const title = cleanText(match[2]);
    if (!title || /^see full role description$/i.test(title)) continue;
    jobs.push({
      title,
      url: new URL(decodeHtml(match[1]), searchUrl).href,
      location: '',
    });
  }
  return uniqueJobs(jobs);
}

async function parseGoogle(searchUrl) {
  const html = await fetchText(searchUrl);
  const jobs = [];
  const re = /jobs\/results\/(\d+)-([^"'<>\\?]+)(?:\?[^"'<>\\]*)?/gi;
  const baseUrl = 'https://www.google.com/about/careers/applications/';
  for (const match of html.matchAll(re)) {
    jobs.push({
      title: titleFromSlug(match[2]),
      url: new URL(decodeHtml(match[0]), baseUrl).href,
      location: '',
    });
  }
  return uniqueJobs(jobs);
}

async function parseMicrosoft(searchUrl) {
  const query = new URL(searchUrl).searchParams.get('q') || 'AI Product Manager';
  const apiUrl = new URL('https://apply.careers.microsoft.com/api/pcsx/search');
  apiUrl.searchParams.set('domain', 'microsoft.com');
  apiUrl.searchParams.set('query', query);
  apiUrl.searchParams.set('location', '');
  apiUrl.searchParams.set('start', '0');

  const json = await fetchJson(apiUrl.href);
  const positions = Array.isArray(json?.data?.positions) ? json.data.positions : [];
  return uniqueJobs(positions.map((position) => ({
    title: String(position.name || '').trim(),
    url: new URL(position.positionUrl || `/careers/job/${position.id}`, 'https://apply.careers.microsoft.com').href,
    location: Array.isArray(position.locations) ? position.locations.join(', ') : '',
  })));
}

function titleFromSlug(slug) {
  return decodeURIComponent(slug)
    .split('-')
    .filter(Boolean)
    .map((word) => {
      if (/^(ai|ii|iii|ml|ux|api|pm)$/i.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

async function fetchWithRetries(urlToFetch, options, attempts = 3) {
  let lastRes;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = await fetch(urlToFetch, options);
    if (res.status !== 429 || attempt === attempts) return res;
    lastRes = res;
    await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
  }
  return lastRes;
}
