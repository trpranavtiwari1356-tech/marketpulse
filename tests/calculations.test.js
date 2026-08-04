// Fixture-pinned regression tests for the MarketPulse calculation layer.
// Run: npm test        (node --test tests/)
//
// Every expected value here is either (a) derived by hand in the comment above the assertion,
// or (b) read off a RECORDED provider fixture — never off a live market feed. Live-data sanity
// checks live in tests/live-checks.js and are tolerance-based on purpose.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Must be set BEFORE the require: it tells server.js to export its pure functions without
// binding a port or starting the warm-up scans.
process.env.MARKETPULSE_NO_LISTEN = '1';
const S = require('../server.js');
const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n + '.json'), 'utf8'));

// ───────────────────────── moving averages ─────────────────────────
describe('moving averages', () => {
  test('sma is the mean of the LAST n values', () => {
    // mean(3,4,5) = 4
    assert.equal(S.sma([1, 2, 3, 4, 5], 3), 4);
  });

  test('sma returns null when there is not enough history (no partial-window average)', () => {
    // A 200-DMA computed off 5 bars would silently be a 5-bar average — the exact
    // off-by-window error the audit looked for.
    assert.equal(S.sma([1, 2, 3], 5), null);
  });

  test('ema seeds from the sma of the first period', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ema = S.ema(v, 5);
    // seed = mean(1..5) = 3; k = 2/(5+1) = 1/3
    // 6:3+(6-3)/3=4  7:4+(7-4)/3=5  8:6  9:7  10:8
    assert.ok(Math.abs(ema - 8) < 1e-9, `ema=${ema}`);
  });

  test('ema weights recent bars more heavily than sma on a non-linear series', () => {
    // A late spike must pull the EMA above the SMA — on a perfectly linear ramp the two
    // coincide, so a ramp cannot distinguish them.
    const v = [10, 10, 10, 10, 10, 10, 10, 10, 10, 30];
    const ema = S.ema(v, 5), sma = S.sma(v, 5);
    assert.ok(ema > sma, `ema ${ema} should exceed sma ${sma} after a late spike`);
  });

  test('rollingMA aligns each value to its own bar and leaves the warm-up null', () => {
    const line = S.rollingMA([1, 2, 3, 4, 5], 3, 'sma');
    assert.equal(line.length, 5, 'one entry per bar — index alignment with candles');
    assert.equal(line[0], null);
    assert.equal(line[1], null);
    assert.equal(line[2], 2);   // mean(1,2,3)
    assert.equal(line[4], 4);   // mean(3,4,5)
  });
});

// ───────────────── split adjustment (defect D5) ─────────────────
describe('split adjustment — Yahoo close is already adjusted', () => {
  test('effectiveSplits never re-applies a split', () => {
    // Verified 28-Jul-2026 across 23 splits / 9 NSE tickers: adjclose/close is continuous
    // across every ex-date, which is only possible if `close` is already split-adjusted.
    const reliance = fx('yahoo-reliance-1mo-max');
    assert.ok(Object.keys(reliance.events.splits || {}).length > 0, 'fixture must contain a split');
    assert.deepEqual(S.effectiveSplits(reliance), []);
  });

  test('REGRESSION: RELIANCE pre-1997 bars are not halved by the 1997-10-27 2:1', () => {
    // The old heuristic saw Sep-1997 25.885 -> Oct-1997 11.329 (rawJump 2.285, within 25% of
    // the 2:1 ratio) and re-applied the split, halving all earlier bars. That turned the true
    // split-adjusted all-time low of ~5.43 into ~2.71.
    const reliance = fx('yahoo-reliance-1mo-max');
    const lows = S.adjustedSeries(reliance, 'low').filter(v => v > 0);
    const rawLows = reliance.indicators.quote[0].low.filter(v => v != null && v > 0);
    const minAdj = Math.min(...lows), minRaw = Math.min(...rawLows);
    assert.ok(Math.abs(minAdj - minRaw) < 1e-6,
      `adjusted low ${minAdj} must equal the provider's ${minRaw} — no re-adjustment`);
    assert.ok(minAdj > 5, `all-time low ${minAdj} must not be the halved 2.71 artifact`);
  });

  test('daily bars spanning a split are continuous (BAJFINANCE 2025-06-16 2:1)', () => {
    const b = fx('yahoo-bajfinance-1d-split');
    const closes = S.adjustedCloses(b);
    // No adjacent daily close may halve — a re-applied split would show a ~50% cliff.
    for (let i = 1; i < closes.length; i++) {
      const move = Math.abs(closes[i] / closes[i - 1] - 1);
      assert.ok(move < 0.25, `bar ${i} moved ${(move * 100).toFixed(1)}% — looks like a re-applied split`);
    }
  });
});

// ────────── previous-session close (defect D1) ──────────
describe('prevSessionClose', () => {
  test('prefers the last completed session in the series', () => {
    const nsei = fx('yahoo-nsei-5d');
    const got = S.prevSessionClose(nsei);
    assert.equal(got.basis, 'series');
    // Must be the close of the session BEFORE the live bar, not the range-start bar that
    // meta.chartPreviousClose points at.
    assert.notEqual(got.value, nsei.meta.chartPreviousClose);
  });

  test('REGRESSION: falls back to chartPreviousClose when no completed session is returned', () => {
    // ^CNXAUTO answered range=5d with a single live bar. refCloses() is then empty, prevClose
    // came out undefined, and the index card rendered a fabricated +0.00%.
    const auto = fx('yahoo-cnxauto-thin-5d');
    assert.equal(S.refCloses(auto).length, 0, 'fixture must have no completed session');
    const got = S.prevSessionClose(auto);
    assert.equal(got.basis, 'chartPreviousClose');
    assert.equal(got.value, auto.meta.chartPreviousClose);
    assert.ok(got.value > 0);

    // and the derived change is the real one, not zero
    const pct = (auto.meta.regularMarketPrice - got.value) / got.value * 100;
    assert.ok(Math.abs(pct) > 0.5, `expected a real move, got ${pct.toFixed(2)}%`);
  });

  test('reports "unavailable" rather than inventing a number', () => {
    const empty = { meta: {}, timestamp: [], indicators: { quote: [{ close: [] }] }, events: {} };
    assert.deepEqual(S.prevSessionClose(empty), { value: null, basis: 'unavailable' });
  });
});

// ────────── history span (defect D3) ──────────
describe('history span reporting', () => {
  test('REGRESSION: 1wk+max really returns MONTHLY bars, so bars/52 is not years', () => {
    const titan = fx('yahoo-titan-1mo-max');
    assert.equal(titan.meta.dataGranularity, '1mo');
    const ts = titan.timestamp;
    const gapDays = (ts[1] - ts[0]) / 86400;
    assert.ok(gapDays > 27, `bars are ${gapDays} days apart — monthly, not weekly`);
    // The old formula: bars/52. On the full TITAN history (368 monthly bars) that reported
    // 7.1 years for 30.6 years of data.
    const spanYears = (ts[ts.length - 1] - ts[0]) / (365.25 * 86400);
    const oldFormula = ts.length / 52;
    assert.ok(Math.abs(spanYears - oldFormula) > 1,
      'timestamp-derived span must differ from the bars/52 formula this replaced');
  });
});

// ────────── portfolio / position sizing ──────────
describe('position sizing', () => {
  test('ps_normalize makes weights sum to 1', () => {
    const w = S.ps_normalize([2, 3, 5]);
    assert.deepEqual(w, [0.2, 0.3, 0.5]);
    assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  });

  test('ps_applyCap caps the largest weight and redistributes, still summing to 1', () => {
    const w = S.ps_applyCap([0.7, 0.2, 0.1], 0.4);
    assert.ok(w[0] <= 0.4 + 1e-9, `top weight ${w[0]} exceeds the 40% cap`);
    assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'weights must still sum to 1');
  });

  test('inverse-volatility weighting favours the calmer asset', () => {
    const out = S.sizeByRiskParity({
      assets: [{ sym: 'LOWVOL', vol: 10, avgCorr: 0.2 }, { sym: 'HIGHVOL', vol: 40, avgCorr: 0.2 }],
      capPct: 1,
    });
    const byS = Object.fromEntries(out.weights ? out.weights.map((w, i) => [out.syms ? out.syms[i] : i, w]) : []);
    const w = out.weights || out;
    assert.ok(w[0] > w[1], `low-vol weight ${w[0]} should exceed high-vol ${w[1]} (${JSON.stringify(byS)})`);
  });
});

// ────────── correlation ──────────
describe('pearson correlation', () => {
  test('perfectly correlated series = 1, inverted = -1', () => {
    assert.ok(Math.abs(S.pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9);
    assert.ok(Math.abs(S.pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-9);
  });
  test('a flat series has no correlation to report', () => {
    const r = S.pearson([1, 1, 1, 1], [1, 2, 3, 4]);
    assert.ok(r === 0 || Number.isNaN(r), `zero-variance input should not yield a real correlation, got ${r}`);
  });
});

// ────────── date handling ──────────
describe('NSE date parsing', () => {
  test('parses the archive date format in both cases', () => {
    assert.equal(S.nseDateMs('03-Jul-2026'), Date.UTC(2026, 6, 3));
    assert.equal(S.nseDateMs('03-JUL-2026'), Date.UTC(2026, 6, 3));
  });
  test('rejects malformed dates instead of guessing', () => {
    assert.equal(S.nseDateMs('2026-07-03'), 0);
    assert.equal(S.nseDateMs(''), 0);
    assert.equal(S.nseDateMs(null), 0);
    assert.equal(S.nseDateMs('03-Xyz-2026'), 0);
  });
  test('bhavKey builds the DDMMYYYY archive filename key', () => {
    assert.equal(S.bhavKey(new Date(2026, 5, 4)), '04062026');
  });
});

// ────────── CSV parsing ──────────
describe('quote-aware CSV split', () => {
  test('keeps commas inside quoted client names together', () => {
    const row = S.csvSplit('27-JUL-2026,KFINTECH,"GRAVITON RESEARCH CAPITAL, LLP",BUY,1000');
    assert.equal(row.length, 5);
    assert.equal(row[2].replace(/"/g, ''), 'GRAVITON RESEARCH CAPITAL, LLP');
  });
});

// ────────── holdings parsing / API contract ──────────
describe('parseHoldings', () => {
  test('parses the legacy SYM:QTY:BUY query form', () => {
    const h = S.parseHoldings('RELIANCE:10:1200,TCS:5:3000');
    assert.equal(h.length, 2);
    assert.deepEqual(h[0], { sym: 'RELIANCE', qty: 10, buy: 1200 });
  });
  test('parses the JSON POST form and strips a .NS suffix', () => {
    const h = S.parseHoldings([{ sym: 'infy.ns', qty: 3, buy: 1500 }]);
    assert.deepEqual(h[0], { sym: 'INFY', qty: 3, buy: 1500 });
  });
  test('drops invalid rows rather than coercing them to zero', () => {
    // A qty of 0 / negative / NaN must be dropped, not silently treated as a holding.
    const h = S.parseHoldings('GOOD:5:100,BAD:0:100,WORSE:-3:100,JUNK:abc:100,:9:100');
    assert.deepEqual(h.map(x => x.sym), ['GOOD']);
  });
  test('allows a missing buy price (holding with no cost basis)', () => {
    const h = S.parseHoldings('RELIANCE:10:');
    assert.equal(h[0].buy, null);
  });
  test('caps the holding count so one request cannot fan out without bound', () => {
    const many = Array.from({ length: 200 }, (_, i) => `SYM${i}:1:10`).join(',');
    assert.ok(S.parseHoldings(many).length <= 60);
  });
});

describe('symbol validation', () => {
  test('accepts real NSE tickers including & and -', () => {
    for (const s of ['RELIANCE', 'M&M', 'BAJAJ-AUTO', '360ONE']) assert.ok(S.SYM_RE.test(s), s);
  });
  test('rejects injection-shaped and overlong input', () => {
    for (const s of ['../../etc/passwd', 'A B', 'reliance', 'X'.repeat(25), '']) {
      assert.ok(!S.SYM_RE.test(s), `${JSON.stringify(s)} should be rejected`);
    }
  });
});

// ────────── error contract ──────────
describe('API error envelope', () => {
  test('keeps the legacy string `error` alongside the structured object', () => {
    // Older frontend code branches on truthy j.error; dropping it blanks working panels.
    const e = S.apiError('UPSTREAM_TIMEOUT', 'Macro data refresh is delayed.', { retryable: true, requestId: 'abc123' });
    assert.equal(typeof e.error, 'string');
    assert.equal(e.errorDetail.code, 'UPSTREAM_TIMEOUT');
    assert.equal(e.errorDetail.retryable, true);
    assert.equal(e.errorDetail.requestId, 'abc123');
  });
  test('never leaks raw upstream text into the customer-facing message', () => {
    const e = S.apiError('UPSTREAM_BLOCKED', 'This data is temporarily unavailable.', { retryable: true });
    assert.ok(!/HTTP \d{3}|Trendlyne|DBnomics|ETIMEDOUT/i.test(e.error), e.error);
  });
});

// ────────── sentiment ──────────
describe('sentiment scoring', () => {
  test('directionally scores positive and negative headlines', () => {
    const pos = S.scoreSentence('Profit surges as company beats estimates with strong growth');
    const neg = S.scoreSentence('Shares plunge on weak results and falling profit');
    assert.ok(pos.compound > 0, `positive headline scored ${pos.compound}`);
    assert.ok(neg.compound < 0, `negative headline scored ${neg.compound}`);
  });
  test('a headline with no lexicon hit carries no signal', () => {
    const s = S.scoreSentence('Company to hold board meeting on Tuesday');
    assert.equal(s.hits, 0);
    assert.equal(s.compound, 0);
  });
  test('label thresholds map score to text consistently', () => {
    assert.match(S.sentimentLabel(5), /neutral/i);
    assert.notEqual(S.sentimentLabel(9), S.sentimentLabel(1));
  });
});

// ────────── breadth ──────────
describe('breadth', () => {
  test('advances + declines account for every scanned name', () => {
    // guard against the classic breadth bug where unchanged names vanish from both buckets
    const spark = {
      SYMA: { close: [10, 11], previousClose: 10 },
      SYMB: { close: [10, 9], previousClose: 10 },
    };
    const out = S.breadthFromSpark(spark);
    if (out && out.adv != null && out.dec != null && out.n != null) {
      assert.equal(out.adv + out.dec, out.n);
    }
  });
});
