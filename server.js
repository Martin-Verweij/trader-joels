/**
 * Trader Joël's — server.js
 * Earnings: Google News RSS → Yahoo Finance API → stockanalysis.com
 * Filings:  SEC EDGAR (free, no key)
 * Run: node server.js  →  http://localhost:3456
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3456;

const UPCOMING_PHRASES = [
  'to host', 'to report', 'to release', 'to announce', 'will host',
  'will report', 'will release', 'will announce', 'scheduled', 'upcoming',
  'conference call', 'webcast', 'announces date', 'sets date',
];

const SKIP_PHRASES = [
  'transcript', 'highlights', 'recap', 'miss', 'beat', 'drops', 'rises',
  'reports earnings', 'reported', 'posted', 'stock price',
];

// ── HTTPS GET with redirect following ─────────────────────────────────────
function httpGet(targetUrl, extraHeaders = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('Too many redirects')); return; }
    const u   = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xml,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders,
      },
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${u.protocol}//${u.hostname}${res.headers.location}`;
        res.resume();
        resolve(httpGet(next, extraHeaders, redirects + 1));
        return;
      }
      let raw = '';
      res.on('data', c => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
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

// ── Date patterns ──────────────────────────────────────────────────────────
// With year:    "March 27, 2026" / "Mar 27 2026" / "3/27/2026"
const DATE_WITH_YEAR = /(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s*\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/gi;
// Without year: "April 6" / "April 6th"
const DATE_NO_YEAR  = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi;

function extractFutureDate(text) {
  const now = new Date(); now.setHours(0,0,0,0);
  const yr  = now.getFullYear();
  // Cap at 6 months — anything further is speculative analyst content, not an announcement
  const cap = new Date(now); cap.setMonth(cap.getMonth() + 6);
  let earliest = null;

  const tryDate = (raw, d) => {
    if (isNaN(d)) return;
    if (d >= now && d <= cap && (!earliest || d < earliest.date)) earliest = { date: d, raw };
  };

  for (const m of text.matchAll(DATE_WITH_YEAR)) tryDate(m[0], new Date(m[0]));

  for (const m of text.matchAll(DATE_NO_YEAR)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 10);
    if (/,?\s*\d{4}/.test(after)) continue; // already captured by DATE_WITH_YEAR
    let d = new Date(`${m[0]} ${yr}`);
    if (isNaN(d) || d < now) d = new Date(`${m[0]} ${yr + 1}`);
    tryDate(`${m[0]} ${d.getFullYear()}`, d);
  }

  return earliest;
}

// ── Run all sources in parallel, return earliest future date ──────────────
async function findNextEarnings(name, ticker) {
  const now = new Date(); now.setHours(0,0,0,0);
  const candidates = [];

  await Promise.all([

    // ── Google News RSS ──────────────────────────────────────────────────
    (async () => {
      const queries = [`"${name}" earnings call`, `${ticker} earnings call`];
      for (const q of queries) {
        try {
          const { status, raw } = await httpGet(
            `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
          );
          if (status !== 200) continue;
          const items = parseRSS(raw);

          // Pass 1: explicit upcoming announcement
          for (const item of items) {
            const title = item.title.toLowerCase();
            if (SKIP_PHRASES.some(p => title.includes(p))) continue;
            if (!UPCOMING_PHRASES.some(p => title.includes(p))) continue;
            const found = extractFutureDate(item.title);
            if (found) {
              console.log(`  RSS confirmed: ${found.raw} — "${item.title}"`);
              candidates.push({ date: found.raw, dt: found.date, confirmed: true, source: item.title, url: item.link });
            }
          }
          // Pass 2: any earnings title with a future date
          for (const item of items) {
            const title = item.title.toLowerCase();
            if (SKIP_PHRASES.some(p => title.includes(p))) continue;
            if (!title.includes('earning')) continue;
            const found = extractFutureDate(item.title);
            if (found) {
              console.log(`  RSS date: ${found.raw} — "${item.title}"`);
              candidates.push({ date: found.raw, dt: found.date, confirmed: false, source: item.title, url: item.link });
            }
          }
        } catch(e) { console.warn(`  RSS error: ${e.message}`); }
      }
    })(),

    // ── Yahoo Finance JSON API ───────────────────────────────────────────
    (async () => {
      try {
        const { status, raw } = await httpGet(
          `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=calendarEvents`,
          { 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' }
        );
        if (status !== 200) throw new Error(`HTTP ${status}`);
        const json  = JSON.parse(raw);
        const dates = json?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate || [];
        for (const d of dates) {
          const dt = new Date(d.raw * 1000);
          if (dt >= now) {
            const str = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            candidates.push({ date: str, dt, confirmed: false, source: 'Yahoo Finance', url: `https://finance.yahoo.com/quote/${ticker}/` });
            console.log(`  Yahoo API: ${str}`);
          }
        }
      } catch(e) {
        // Fallback: scrape Yahoo HTML for embedded earningsDate JSON
        try {
          const { status, raw } = await httpGet(
            `https://finance.yahoo.com/quote/${ticker}/`,
            { 'Accept-Language': 'en-US,en;q=0.9' }
          );
          if (status === 200) {
            for (const m of raw.matchAll(/"earningsDate":\["(\d{4}-\d{2}-\d{2})"/g)) {
              const dt = new Date(m[1]);
              if (dt >= now) {
                const str = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
                candidates.push({ date: str, dt, confirmed: false, source: 'Yahoo Finance', url: `https://finance.yahoo.com/quote/${ticker}/` });
                console.log(`  Yahoo HTML: ${str}`);
              }
            }
          }
        } catch(_) {}
      }
    })(),

    // ── stockanalysis.com ────────────────────────────────────────────────
    (async () => {
      try {
        const saUrl = `https://stockanalysis.com/stocks/${ticker.toLowerCase()}/statistics/`;
        const { status, raw } = await httpGet(saUrl);
        if (status !== 200) return;
        const text  = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const lower = text.toLowerCase();
        for (const phrase of ['next estimated earnings date', 'next earnings date', 'next earnings']) {
          const idx = lower.indexOf(phrase);
          if (idx === -1) continue;
          const found = extractFutureDate(text.slice(idx, idx + 150));
          if (found) {
            const dt = new Date(found.raw);
            if (!isNaN(dt) && dt >= now) {
              candidates.push({ date: found.raw, dt, confirmed: false, source: 'stockanalysis.com', url: saUrl });
              console.log(`  stockanalysis: ${found.raw}`);
            }
            break;
          }
        }
      } catch(e) { console.warn(`  stockanalysis error: ${e.message}`); }
    })(),

  ]);

  if (!candidates.length) return null;

  // Always pick the earliest future date across all sources
  candidates.sort((a, b) => a.dt - b.dt);
  const pick = candidates[0];
  console.log(`  → picked: ${pick.date} from ${pick.source} (${candidates.length} candidate(s): ${candidates.map(c=>c.date).join(', ')})`);
  return { date: pick.date, confirmed: pick.confirmed, source: pick.source, url: pick.url };
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

  // POST /api/scan
  if (pathname === '/api/scan' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const { companies } = JSON.parse(body);
      const results = [];
      for (const co of companies) {
        console.log(`\nChecking: ${co.name} (${co.ticker})`);
        try {
          let result = await findNextEarnings(co.name, co.ticker);
          results.push({
            company:   co.name,   ticker:    co.ticker,
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

  // POST /api/filings
  if (pathname === '/api/filings' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const { companies, types = ['8-K','10-K','10-Q'] } = JSON.parse(body);
      const results = [];

      if (!global.cikMap) {
        console.log('Loading SEC CIK map...');
        try {
          const { raw } = await httpGet('https://www.sec.gov/files/company_tickers.json', {
            'User-Agent': 'TraderJoels/1.0 contact@example.com',
            'Accept': 'application/json',
          });
          const data = JSON.parse(raw);
          global.cikMap = {};
          for (const e of Object.values(data)) {
            global.cikMap[e.ticker.toUpperCase()] = String(e.cik_str).padStart(10, '0');
          }
          console.log(`Loaded ${Object.keys(global.cikMap).length} tickers`);
        } catch(e) {
          send(502, { error: `Could not load SEC CIK map: ${e.message}` }); return;
        }
      }

      for (const co of companies) {
        const cik = global.cikMap[co.ticker.toUpperCase()];
        if (!cik) {
          results.push({ company: co.name, ticker: co.ticker, filings: [], error: 'Ticker not found in SEC database' });
          continue;
        }
        try {
          const { raw } = await httpGet(`https://data.sec.gov/submissions/CIK${cik}.json`, {
            'User-Agent': 'TraderJoels/1.0 contact@example.com',
            'Accept': 'application/json',
          });
          const data   = JSON.parse(raw);
          const recent = data.filings?.recent;
          if (!recent) { results.push({ company: co.name, ticker: co.ticker, filings: [] }); continue; }

          const filings  = [];
          const forms    = recent.form                  || [];
          const dates    = recent.filingDate            || [];
          const accNums  = recent.accessionNumber       || [];
          const docs     = recent.primaryDocument       || [];
          const descs    = recent.primaryDocDescription || [];

          for (let i = 0; i < forms.length && filings.length < 20; i++) {
            if (!types.includes(forms[i])) continue;
            const acc  = accNums[i].replace(/-/g, '');
            const cikN = parseInt(cik, 10);
            const link = docs[i]
              ? `https://www.sec.gov/Archives/edgar/data/${cikN}/${acc}/${docs[i]}`
              : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${forms[i]}&count=10`;
            filings.push({
              type: forms[i], date: dates[i],
              desc: descs[i] || (forms[i]==='10-K'?'Annual report':forms[i]==='10-Q'?'Quarterly report':'Current report'),
              link,
            });
          }
          results.push({ company: co.name, ticker: co.ticker, filings });
        } catch(e) {
          results.push({ company: co.name, ticker: co.ticker, filings: [], error: e.message });
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
        console.log(`  ntfy → topic: "${topic}", title: "${title}"`);
        // Use topic as-is (no encodeURIComponent — ntfy expects raw path)
        const ntfyPath = '/' + topic;
        const payload  = Buffer.from(title || message || 'Earnings alert');
        const ntfyRes  = await new Promise((resolve, reject) => {
          const r = https.request({
            hostname: 'ntfy.sh',
            path:     ntfyPath,
            method:   'POST',
            headers: {
              'Content-Type':   'text/plain',
              'Content-Length': payload.length,
              ...(clickUrl ? { 'Click': clickUrl } : {}),
            },
          }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => { console.log(`  ntfy response: ${res.statusCode} ${raw.slice(0,100)}`); resolve(res.statusCode); });
          });
          r.on('error', e => { console.error('  ntfy error:', e.message); reject(e); });
          r.write(payload); r.end();
        });
        send(200, { ok: true, ntfyStatus: ntfyRes });
      } catch(e) {
        console.error('  notify handler error:', e.message);
        send(502, { error: e.message });
      }
    });
    return;
  }

  // GET /api/debug/TICKER
  if (pathname.startsWith('/api/debug/') && req.method === 'GET') {
    const ticker = pathname.split('/').pop().toUpperCase();
    const out = { ticker, rss: null, yahoo: null, stockanalysis: null };
    try {
      const { raw } = await httpGet(`https://news.google.com/rss/search?q=${encodeURIComponent(ticker+' earnings call')}&hl=en-US&gl=US&ceid=US:en`);
      out.rss = parseRSS(raw).slice(0,5).map(i => ({ title: i.title, pubDate: i.pubDate }));
    } catch(e) { out.rss = { error: e.message }; }
    try {
      const { status, raw } = await httpGet(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=calendarEvents`,
        { 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' }
      );
      const json  = JSON.parse(raw);
      const dates = json?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate || [];
      out.yahoo = { status, dates: dates.map(d => new Date(d.raw*1000).toISOString()), raw_snippet: raw.slice(0,200) };
    } catch(e) { out.yahoo = { error: e.message }; }
    try {
      const { status, raw } = await httpGet(`https://stockanalysis.com/stocks/${ticker.toLowerCase()}/statistics/`);
      const text = raw.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
      const idx  = text.toLowerCase().indexOf('next earnings');
      out.stockanalysis = { status, snippet: idx !== -1 ? text.slice(idx, idx+100) : 'NOT FOUND' };
    } catch(e) { out.stockanalysis = { error: e.message }; }
    send(200, out);
    return;
  }

  send(404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  Trader Joël's  →  http://localhost:${PORT}\n`);
});
