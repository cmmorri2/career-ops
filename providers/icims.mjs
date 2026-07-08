// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// iCIMS classic search-page provider. Many large-company iCIMS boards expose
// public HTML search results without a stable no-auth JSON feed. This provider
// parses the rendered job-card list and keeps pagination bounded.

const DEFAULT_MAX_PAGES = 10;
const HARD_MAX_PAGES = 100;
const INTER_PAGE_DELAY_MS = 150;

function resolveSearchUrl(entry) {
  const raw = entry.api || entry.careers_url || '';
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'icims.com' && !host.endsWith('.icims.com')) return null;
  url.searchParams.set('in_iframe', '1');
  if (!url.searchParams.has('searchRelation')) {
    url.searchParams.set('searchRelation', 'keyword_all');
  }
  return url;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z0-9]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

function clean(value) {
  return decodeEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseLocation(cardHtml) {
  const fields = [...String(cardHtml).matchAll(/<dd\b[^>]*class="[^"]*iCIMS_JobHeaderData[^"]*"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((m) => clean(m[1]))
    .filter(Boolean);

  return fields
    .filter((v) => !/^\d{5,}$/.test(v))
    .filter((v) => !/^(research and development|sales|consulting|marketing|finance|legal|human resources|administration)$/i.test(v))
    .join(', ');
}

function parseJobCards(html, baseUrl, entry) {
  const jobs = [];
  const seen = new Set();
  const cardRe = /<li\b[^>]*class="[^"]*iCIMS_JobCardItem[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  for (const card of String(html).matchAll(cardRe)) {
    const body = card[1];
    const link =
      body.match(/<a\b[^>]*href="([^"]+)"[^>]*class="[^"]*iCIMS_Anchor[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      body.match(/<a\b[^>]*class="[^"]*iCIMS_Anchor[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;

    const url = new URL(decodeEntities(link[1]), baseUrl).href;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = clean(link[2]).replace(/^Requisition Title\s+/i, '');
    if (!title) continue;
    jobs.push({
      title,
      url,
      company: entry.name,
      location: parseLocation(body),
    });
  }
  return jobs;
}

function nextPageUrl(html, currentUrl) {
  const match = String(html).match(/<a\b[^>]*(?:aria-label="Next"|title="Next"|class="[^"]*next[^"]*")[^>]*href="([^"]+)"/i);
  if (!match) return null;
  try {
    return new URL(decodeEntities(match[1]), currentUrl).href;
  } catch {
    return null;
  }
}

function resolveMaxPages(entry) {
  const v = Number(entry?.max_pages);
  if (Number.isInteger(v) && v > 0) return Math.min(v, HARD_MAX_PAGES);
  return DEFAULT_MAX_PAGES;
}

/** @type {Provider} */
export default {
  id: 'icims',

  detect(entry) {
    const url = resolveSearchUrl(entry);
    return url ? { url: url.href } : null;
  },

  async fetch(entry, ctx) {
    let url = resolveSearchUrl(entry);
    if (!url) throw new Error(`icims: cannot derive search URL for ${entry.name}`);
    const maxPages = Math.min(resolveMaxPages(entry), Number.isInteger(ctx?.maxPages) ? ctx.maxPages : HARD_MAX_PAGES);
    const sleep = typeof ctx?.sleep === 'function' ? ctx.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const jobs = [];
    const seen = new Set();
    for (let page = 0; page < maxPages && url; page += 1) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS);
      const html = await ctx.fetchText(url.href, { headers: { accept: 'text/html' } });
      for (const job of parseJobCards(html, url.href, entry)) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      const next = nextPageUrl(html, url.href);
      url = next ? new URL(next) : null;
    }
    return jobs;
  },
};

export { parseJobCards };
