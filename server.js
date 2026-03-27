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

// Matches dates with year: "March 27, 2026" / "Mar 27 2026" / "3/27/2026"
const DATE_PATTERN = /(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s*\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/gi;

// Matches dates WITHOUT year: "April 6" / "April 6th"
const DATE_NO_YEAR = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi;

// ── Find earliest future date string from text ─────────────────────────────
function extractFutureDate(text) {
  const now = new Date(); now.setHours(0,0,0,0);
  const yr  = now.getFullYear();
  let earliest = null;

  const tryDate = (raw, d) => {
    if (isNaN(d)) return;
    if (d >= now && (!earliest || d < earliest.date)) {
      earliest = { date: d, raw };
    }
  };

  // Dates with year — reliable
  for (const m of text.matchAll(DATE_PATTERN)) {
    tryDate(m[0], new Date(m[0]));
  }

  // Dates without year — infer current or next year
  for (const m of text.matchAll(DATE_NO_YEAR)) {
    // Skip if this match is actually part of a longer date-with-year
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 10);
    if (/,?\s*\d{4}/.test(after)) continue;
    const withYr = `${m[0]} ${yr}`;
    let d = new Date(withYr);
    if (isNaN(d) || d < now) d = new Date(`${m[0]} ${yr + 1}`);
    tryDate(`${m[0]} ${d.getFullYear()}`, d);
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

      // Pass 1: strict — upcoming phrase + future date (confirmed announcement)
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
      // Pass 2: loose — any earnings title with a future date
      for (const item of items) {
        const title = item.title.toLowerCase();
        if (SKIP_PHRASES.some(p => title.includes(p))) continue;
        if (!title.includes('earning')) continue;
        const found = extractFutureDate(item.title);
        if (found) {
          console.log(`  ~ date in title: ${found.raw} via "${item.title}"`);
          return { date: found.raw, confirmed: false, source: item.title, url: item.link };
        }
      }
    } catch(e) {
      console.warn(`  RSS error: ${e.message}`);
    }
  }
  return null;
}

// ── 2. Fetch Yahoo + stockanalysis in parallel, return earliest date ──────
async function checkStockAnalysis(ticker) {
  const now = new Date(); now.setHours(0,0,0,0);
  const candidates = [];

  await Promise.all([

    // Yahoo Finance JSON API
    (async () => {
      try {
        const { status, raw } = await httpGet(
          `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=calendarEvents`,
          { 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' }
        );
        if (status !== 200) return;
        const json  = JSON.parse(raw);
        const dates = json?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate || [];
        for (const d of dates) {
          const dt = new Date(d.raw * 1000);
          if (dt >= now) {
            const str = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            candidates.push({ date: str, dt, source: 'Yahoo Finance', url: `https://finance.yahoo.com/quote/${ticker}/` });
            console.log(`  Yahoo: ${str}`);
          }
        }
      } catch(e) {
        console.warn(`  Yahoo API failed (${e.message}), trying HTML`);
        try {
          const { status, raw } = await httpGet(
            `https://finance.yahoo.com/quote/${ticker}/`,
            { 'Accept-Language': 'en-US,en;q=0.9' }
          );
          if (status === 200) {
            const matches = [...raw.matchAll(/"earningsDate":\["(\d{4}-\d{2}-\d{2})"/g)];
            for (const m of matches) {
              const dt = new Date(m[1]);
              if (dt >= now) {
                const str = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
                candidates.push({ date: str, dt, source: 'Yahoo Finance', url: `https://finance.yahoo.com/quote/${ticker}/` });
                console.log(`  Yahoo HTML: ${str}`);
              }
            }
          }
        } catch(e2) { console.warn(`  Yahoo HTML failed: ${e2.message}`); }
      }
    })(),

    // stockanalysis.com statistics page
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
              candidates.push({ date: found.raw, dt, source: 'stockanalysis.com', url: saUrl });
              console.log(`  stockanalysis: ${found.raw}`);
            }
            break;
          }
        }
      } catch(e) { console.warn(`  stockanalysis error: ${e.message}`); }
    })(),

  ]);

  if (!candidates.length) return null;

  // Pick the earliest (lowest) date across both sources
  candidates.sort((a, b) => a.dt - b.dt);
  const pick = candidates[0];
  console.log(`  ✓ estimate: ${pick.date} from ${pick.source} (earliest of ${candidates.length} candidate(s))`);
  return { date: pick.date, confirmed: false, source: pick.source, url: pick.url };
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

  // POST /api/filings  body: { companies: [{name, ticker}], types: ['8-K','10-K','10-Q'] }
  // Uses SEC EDGAR — free, no key needed
  if (pathname === '/api/filings' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const { companies, types = ['8-K','10-K','10-Q'] } = JSON.parse(body);
      const results = [];

      // Load SEC ticker→CIK map (cached after first call)
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

          const filings = [];
          const forms   = recent.form                  || [];
          const dates   = recent.filingDate            || [];
          const accNums = recent.accessionNumber       || [];
          const docs    = recent.primaryDocument       || [];
          const descs   = recent.primaryDocDescription || [];

          for (let i = 0; i < forms.length && filings.length < 20; i++) {
            if (!types.includes(forms[i])) continue;
            const acc  = accNums[i].replace(/-/g, '');
            const cikN = parseInt(cik, 10);
            const link = docs[i]
              ? `https://www.sec.gov/Archives/edgar/data/${cikN}/${acc}/${docs[i]}`
              : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${forms[i]}&count=10`;
            filings.push({
              type:    forms[i],
              date:    dates[i],
              desc:    descs[i] || (forms[i] === '10-K' ? 'Annual report' : forms[i] === '10-Q' ? 'Quarterly report' : 'Current report'),
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

    // Yahoo JSON API check
    try {
      const { status, raw } = await httpGet(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=calendarEvents`,
        { 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' }
      );
      const json  = JSON.parse(raw);
      const dates = json?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate || [];
      out.yahoo = { status, dates: dates.map(d => new Date(d.raw * 1000).toISOString()), raw_snippet: raw.slice(0, 200) };
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
