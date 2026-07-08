// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Phenom search-result provider. Phenom-powered pages often hydrate the first
// result set into an `eagerLoadRefineSearch` JSON payload. That gives us a
// zero-token, no-browser path for large-company boards such as Cisco.

function resolveSearchUrl(entry) {
  const raw = entry.api || entry.careers_url || '';
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url;
}

function extractJsonObjectAfter(html, key) {
  const marker = `"${key}":`;
  const start = String(html).indexOf(marker);
  if (start === -1) return null;
  const open = String(html).indexOf('{', start + marker.length);
  if (open === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = open; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(open, i + 1);
    }
  }
  return null;
}

function normalizeLocation(job) {
  if (Array.isArray(job.multi_location) && job.multi_location.length > 0) {
    return job.multi_location.map(String).join('; ');
  }
  if (Array.isArray(job.multi_location_array) && job.multi_location_array.length > 0) {
    return job.multi_location_array.map((item) => item?.location || '').filter(Boolean).join('; ');
  }
  return String(job.location || job.cityStateCountry || job.cityState || '').trim();
}

function publicJobUrl(job, searchUrl) {
  const seqNo = String(job.jobSeqNo || '').trim();
  if (seqNo) return new URL(`job/${encodeURIComponent(seqNo)}`, searchUrl).href;
  const applyUrl = String(job.applyUrl || '').trim();
  if (applyUrl) return applyUrl;
  const jobId = String(job.jobId || job.reqId || '').trim();
  return jobId ? new URL(`job/${encodeURIComponent(jobId)}`, searchUrl).href : '';
}

function parsePhenomPayload(html, searchUrl, entry) {
  const raw = extractJsonObjectAfter(html, 'eagerLoadRefineSearch');
  if (!raw) return [];
  const payload = JSON.parse(raw);
  const rawJobs = Array.isArray(payload?.data?.jobs) ? payload.data.jobs : [];
  const seen = new Set();
  return rawJobs
    .map((job) => ({
      title: String(job.title || '').trim(),
      url: publicJobUrl(job, searchUrl),
      company: entry.name,
      location: normalizeLocation(job),
    }))
    .filter((job) => {
      if (!job.title || !job.url || seen.has(job.url)) return false;
      seen.add(job.url);
      return true;
    });
}

/** @type {Provider} */
export default {
  id: 'phenom',

  detect(entry) {
    if (entry.provider !== 'phenom') return null;
    const url = resolveSearchUrl(entry);
    return url ? { url: url.href } : null;
  },

  async fetch(entry, ctx) {
    const url = resolveSearchUrl(entry);
    if (!url) throw new Error(`phenom: cannot derive search URL for ${entry.name}`);
    const html = await ctx.fetchText(url.href, {
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    return parsePhenomPayload(html, url.href, entry);
  },
};

export { parsePhenomPayload };
