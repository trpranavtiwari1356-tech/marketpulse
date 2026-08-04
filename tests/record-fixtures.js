// Record trimmed provider responses so the regression tests are deterministic.
// Live market data moves every day; pinning expected values to it would make the suite
// meaningless. Re-run this ONLY when a provider's response SHAPE changes:
//     node tests/record-fixtures.js
// Each fixture keeps the fields server.js actually reads, plus a `_recorded` provenance stamp.
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DIR = path.join(__dirname, 'fixtures');

async function chart(ticker, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?interval=${interval}&range=${range}&events=div%2Csplit&includePrePost=false`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${ticker} ${interval}/${range} HTTP ${r.status}`);
  const j = await r.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error(`${ticker}: no result`);
  return res;
}

// Keep only the slice of bars the test needs, and only the fields server.js reads.
function trim(res, { from, to } = {}) {
  const ts = res.timestamp || [];
  const q = res.indicators.quote[0] || {};
  const adj = (res.indicators.adjclose && res.indicators.adjclose[0] || {}).adjclose;
  let lo = 0, hi = ts.length;
  if (from) lo = Math.max(0, ts.findIndex(t => new Date(t * 1000).toISOString().slice(0, 10) >= from));
  if (to) { const i = ts.findIndex(t => new Date(t * 1000).toISOString().slice(0, 10) > to); if (i > 0) hi = i; }
  const slice = a => (Array.isArray(a) ? a.slice(lo, hi) : a);
  const out = {
    meta: {
      symbol: res.meta.symbol, currency: res.meta.currency, dataGranularity: res.meta.dataGranularity,
      regularMarketPrice: res.meta.regularMarketPrice, regularMarketTime: res.meta.regularMarketTime,
      regularMarketDayHigh: res.meta.regularMarketDayHigh, regularMarketDayLow: res.meta.regularMarketDayLow,
      chartPreviousClose: res.meta.chartPreviousClose, previousClose: res.meta.previousClose,
      fiftyTwoWeekHigh: res.meta.fiftyTwoWeekHigh, fiftyTwoWeekLow: res.meta.fiftyTwoWeekLow,
      regularMarketVolume: res.meta.regularMarketVolume, exchangeTimezoneName: res.meta.exchangeTimezoneName,
    },
    timestamp: slice(ts),
    indicators: {
      quote: [{ open: slice(q.open), high: slice(q.high), low: slice(q.low), close: slice(q.close), volume: slice(q.volume) }],
      adjclose: [{ adjclose: slice(adj) }],
    },
    events: res.events || {},
  };
  return out;
}

const JOBS = [
  // RELIANCE monthly/max — 4 splits, and the 1997-10-27 false positive that halved pre-1997 bars.
  { name: 'yahoo-reliance-1mo-max', get: () => chart('RELIANCE.NS', '1mo', 'max'), trim: { to: '1999-12-31' } },
  // ^CNXAUTO — the thin series (single live bar, no completed session) that produced +0.00%.
  { name: 'yahoo-cnxauto-thin-5d', get: () => chart('^CNXAUTO', '1d', '5d') },
  // ^NSEI — a healthy multi-session series; prevSessionClose must prefer the series, not chartPreviousClose.
  { name: 'yahoo-nsei-5d', get: () => chart('^NSEI', '1d', '5d') },
  // BAJFINANCE daily across its 2025-06-16 2:1 — proves daily bars are split-adjusted too.
  { name: 'yahoo-bajfinance-1d-split', get: () => chart('BAJFINANCE.NS', '1d', '2y'), trim: { from: '2025-06-02', to: '2025-06-30' } },
  // TITAN monthly/max — 30+ years of history that the old code reported as 7.1 years.
  { name: 'yahoo-titan-1mo-max', get: () => chart('TITAN.NS', '1mo', 'max'), trim: { to: '2002-12-31' } },
];

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  for (const job of JOBS) {
    try {
      const raw = await job.get();
      const doc = trim(raw, job.trim || {});
      doc._recorded = { at: new Date().toISOString(), source: 'Yahoo Finance /v8/finance/chart', note: job.note || null };
      fs.writeFileSync(path.join(DIR, job.name + '.json'), JSON.stringify(doc, null, 1));
      console.log(`recorded ${job.name}  (${doc.timestamp.length} bars, granularity ${doc.meta.dataGranularity})`);
    } catch (e) {
      console.error(`FAILED ${job.name}: ${e.message}`);
      process.exitCode = 1;
    }
  }
})();
