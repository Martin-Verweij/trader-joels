/**
 * EarningsPulse — Next Earnings Date Finder
 * 1. Searches Google News RSS for confirmed earnings announcement
 * 2. Falls back to stockanalysis.com for analyst estimate
 *
 * Run: node server.js → open http://localhost:3456
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3456;

const DATE_PATTERN = /(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s*\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/gi;

const UPCOMING_PHRASES = [
  'to host', 'to report', 'to release', 'to announce', 'will host',
  'will report', 'will release', 'will announce', 'scheduled', 'upcoming',
  'conference call', 'webcast', 'announces date', 'sets date',
];

const SKIP_PHRASES = [
  'transcript', 'highlights', 'recap', 'miss', 'beat', 'drops', 'rises',
  'reports earnings', 'reported', 'posted', 'stock price',
];

// ── generic HTTPS GET ──────────────────────────────────────────────────────
function httpGet(targetUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    https.get({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders,
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    }).on('error', reject);
  });
}

// ── Parse RSS XML ──────────────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  for (const block of (xml.match(/<item>([\s\S]*?)<\/item>/gi) || [])) {
    const get = tag => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
             || block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    items.push({ title: get('title'), link: get('link'), pubDate: get('pubDate') });
  }
  return items;
}

// ── Find earliest future date string from text ─────────────────────────────
function extractFutureDate(text) {
  const now   = new Date();
  now.setHours(0, 0, 0, 0);
  let earliest = null;
  for (const m of text.matchAll(DATE_PATTERN)) {
    const d = new Date(m[0]);
    if (isNaN(d)) continue;
    if (d >= now && (!earliest || d < earliest.date)) {
      earliest = { date: d, raw: m[0] };
    }
  }
  return earliest;
}

// ── 1. Google News RSS ─────────────────────────────────────────────────────
async function checkGoogleNews(name, ticker) {
  const queries = [
    `"${name}" earnings call`,
    `${ticker} earnings call`,
  ];

  for (const q of queries) {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    console.log(`  RSS: ${q}`);
    try {
      const { status, raw } = await httpGet(rssUrl);
      if (status !== 200) continue;
      const items = parseRSS(raw);

      for (const item of items) {
        const title = item.title.toLowerCase();
        if (SKIP_PHRASES.some(p => title.includes(p))) continue;
        if (!UPCOMING_PHRASES.some(p => title.includes(p))) continue;

        const found = extractFutureDate(item.title);
        if (found) {
          console.log(`  ✓ confirmed: ${found.raw} via "${item.title}"`);
          return { date: found.raw, confirmed: true, source: item.title, url: item.link };
        }
      }
    } catch(e) {
      console.warn(`  RSS error: ${e.message}`);
    }
  }
  return null;
}

// ── 2. Fallback chain: Yahoo Finance → stockanalysis.com ──────────────────
async function checkStockAnalysis(ticker) {
  // Try Yahoo Finance first — embeds earnings date directly in raw HTML
  const yahooUrl = `https://finance.yahoo.com/quote/${ticker}/`;
  console.log(`  Fallback Yahoo: ${yahooUrl}`);
  try {
    const { status, raw } = await httpGet(yahooUrl, { 'Accept-Language': 'en-US,en;q=0.9' });
    if (status === 200) {
      const text  = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const lower = text.toLowerCase();
      const idx   = lower.indexOf('earnings date');
      if (idx !== -1) {
        const snippet = text.slice(idx, idx + 80);
        const found   = extractFutureDate(snippet);
        if (found) {
          console.log(`  ✓ confirmed: ${found.raw} from Yahoo Finance`);
          return { date: found.raw, confirmed: true, source: 'Yahoo Finance', url: yahooUrl };
        }
      }
    }
  } catch(e) {
    console.warn(`  Yahoo Finance error: ${e.message}`);
  }

  // Try stockanalysis.com statistics page as second fallback
  const saUrl = `https://stockanalysis.com/stocks/${ticker.toLowerCase()}/statistics/`;
  console.log(`  Fallback stockanalysis: ${saUrl}`);
  try {
    const { status, raw } = await httpGet(saUrl);
    if (status === 200) {
      const text  = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const lower = text.toLowerCase();
      for (const phrase of ['next estimated earnings date', 'next earnings date', 'next earnings']) {
        const idx = lower.indexOf(phrase);
        if (idx === -1) continue;
        const found = extractFutureDate(text.slice(idx, idx + 150));
        if (found) {
          const isEstimate = phrase.includes('estimated');
          console.log(`  ✓ ${isEstimate ? 'estimate' : 'confirmed'}: ${found.raw} from stockanalysis.com`);
          return { date: found.raw, confirmed: !isEstimate, source: 'stockanalysis.com', url: saUrl };
        }
      }
    }
  } catch(e) {
    console.warn(`  stockanalysis error: ${e.message}`);
  }

  return null;
}

// ── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // Static files
  if (!pathname.startsWith('/api/')) {
    const file = pathname === '/' ? '/index.html' : pathname;
    const fp   = path.join(__dirname, file);
    if (fs.existsSync(fp)) {
      const mime = { '.html':'text/html', '.js':'application/javascript' }[path.extname(fp)] || 'text/plain';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(fp).pipe(res);
    } else { res.writeHead(404); res.end('Not found'); }
    return;
  }

  // POST /api/scan  body: { companies: [{name, ticker}] }
  if (pathname === '/api/scan' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const { companies } = JSON.parse(body);
      const results = [];

      for (const co of companies) {
        console.log(`\nChecking: ${co.name} (${co.ticker})`);
        try {
          let result = await checkGoogleNews(co.name, co.ticker);
          if (!result)  result = await checkStockAnalysis(co.ticker);
          results.push({
            company:   co.name,
            ticker:    co.ticker,
            date:      result?.date      || null,
            confirmed: result?.confirmed ?? null,
            source:    result?.source    || null,
            url:       result?.url       || null,
          });
        } catch(e) {
          results.push({ company: co.name, ticker: co.ticker, date: null, confirmed: null, error: e.message });
        }
      }

      send(200, { results });
    });
    return;
  }

  // POST /api/notify
  if (pathname === '/api/notify' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { topic, title, message, url: clickUrl } = JSON.parse(body);
        if (!topic) { send(400, { error: 'Missing topic' }); return; }
        const payload = Buffer.from(message || title || 'Earnings alert');
        await new Promise((resolve, reject) => {
          const r = https.request({
            hostname: 'ntfy.sh', path: `/${encodeURIComponent(topic)}`, method: 'POST',
            headers: {
              'Title': title || 'EarningsPulse', 'Content-Type': 'text/plain',
              'Content-Length': payload.length,
              ...(clickUrl ? { 'Click': clickUrl } : {}),
            },
          }, res => { res.resume(); resolve(); });
          r.on('error', reject); r.write(payload); r.end();
        });
        send(200, { ok: true });
      } catch(e) { send(502, { error: e.message }); }
    });
    return;
  }

  // GET /api/debug/TICKER — shows exactly what each source returns
  if (pathname.startsWith('/api/debug/') && req.method === 'GET') {
    const ticker = pathname.split('/').pop().toUpperCase();
    const out = { ticker, rss: null, yahoo: null, stockanalysis: null };

    // RSS check
    try {
      const q = `${ticker} earnings call`;
      const { raw } = await httpGet(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`);
      const items = parseRSS(raw);
      out.rss = items.slice(0,5).map(i => ({ title: i.title, pubDate: i.pubDate }));
    } catch(e) { out.rss = { error: e.message }; }

    // Yahoo check
    try {
      const { status, raw } = await httpGet(`https://finance.yahoo.com/quote/${ticker}/`, { 'Accept-Language': 'en-US,en;q=0.9' });
      const text  = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const idx   = text.toLowerCase().indexOf('earnings date');
      out.yahoo = { status, snippet: idx !== -1 ? text.slice(idx, idx+100) : 'NOT FOUND' };
    } catch(e) { out.yahoo = { error: e.message }; }

    // stockanalysis check
    try {
      const { status, raw } = await httpGet(`https://stockanalysis.com/stocks/${ticker.toLowerCase()}/statistics/`);
      const text  = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const idx   = text.toLowerCase().indexOf('next earnings');
      out.stockanalysis = { status, snippet: idx !== -1 ? text.slice(idx, idx+100) : 'NOT FOUND' };
    } catch(e) { out.stockanalysis = { error: e.message }; }

    send(200, out);
    return;
  }

  send(404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  EarningsPulse  →  http://localhost:${PORT}\n`);
});
