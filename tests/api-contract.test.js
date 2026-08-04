// API contract tests — boots a real server on a scratch port and checks the REQUEST/RESPONSE
// contract, not market values. Anything that depends on today's prices is asserted as a shape,
// a sign, or an internal-consistency invariant, so the suite stays green on any trading day.
//
// Skipped automatically when the machine has no upstream access (MARKETPULSE_OFFLINE=1),
// because these do reach Yahoo/NSE through the server under test.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 5400 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const OFFLINE = process.env.MARKETPULSE_OFFLINE === '1';

let child;

async function waitForHealth(ms = 45000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('server did not become healthy in time');
}

const get = (p, init) => fetch(BASE + p, init);
const json = async (p, init) => {
  const r = await get(p, init);
  return { status: r.status, body: await r.json() };
};

before(async () => {
  if (OFFLINE) return;
  const env = { ...process.env, PORT: String(PORT), LIGHT_START: '1' };
  delete env.MARKETPULSE_NO_LISTEN;   // this child MUST listen
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  await waitForHealth();
});

after(() => { if (child) child.kill(); });

describe('health endpoints', { skip: OFFLINE && 'no upstream access' }, () => {
  test('/health answers without touching any provider', async () => {
    const { status, body } = await json('/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.ok(typeof body.uptimeSec === 'number');
  });

  test('/health/dependencies reports provider + cache state', async () => {
    const { status, body } = await json('/health/dependencies');
    assert.equal(status, 200);
    assert.ok(body.providers.macro, 'macro provider block missing');
    assert.ok(body.providers.fiiDii, 'fiiDii provider block missing');
    assert.ok(['ok', 'degraded'].includes(body.status));
  });
});

describe('parameter validation', { skip: OFFLINE && 'no upstream access' }, () => {
  test('an unknown universe is rejected with the allowed list, not silently defaulted', async () => {
    // Silent fallback is how "NIFTY 50" vs "Nifty 50" drift went unnoticed: the chart rendered
    // a different universe than the one the filter claimed.
    const { status, body } = await json('/api/trend?uni=NIFTY50');
    assert.equal(status, 400);
    assert.equal(body.errorDetail.code, 'INVALID_PARAM');
    assert.ok(Array.isArray(body.errorDetail.detail.allowed));
    assert.ok(body.errorDetail.detail.allowed.includes('Nifty 50'));
  });

  test('an unknown macro indicator lists what is available', async () => {
    const { status, body } = await json('/api/macro?ind=nonsense');
    assert.equal(status, 400);
    assert.equal(body.errorDetail.code, 'UNKNOWN_INDICATOR');
    assert.ok(body.errorDetail.detail.available.includes('inflation'));
  });

  test('a malformed symbol is rejected before any upstream call', async () => {
    const { status, body } = await json('/api/quote?sym=' + encodeURIComponent('../../etc/passwd'));
    assert.equal(status, 400);
    assert.equal(body.errorDetail.code, 'INVALID_PARAM');
  });

  test('an empty portfolio is a 400, not a crash or an empty success', async () => {
    const { status, body } = await json('/api/portfolio?h=');
    assert.equal(status, 400);
    assert.equal(body.errorDetail.code, 'INVALID_PARAM');
  });

  test('a backtest with one holding explains the two-holding minimum', async () => {
    const { status, body } = await json('/api/pfbacktest?h=RELIANCE:10:1200');
    assert.equal(status, 400);
    assert.equal(body.errorDetail.detail.minHoldings, 2);
  });

  test('an oversized POST body is refused with 413', async () => {
    const holdings = Array.from({ length: 20000 }, (_, i) => ({ sym: 'SYM' + i, qty: 1, buy: 10 }));
    const { status, body } = await json('/api/portfolio', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holdings }),
    });
    assert.equal(status, 413);
    assert.equal(body.errorDetail.code, 'BODY_TOO_LARGE');
  });

  test('a non-JSON POST body is refused with a readable message', async () => {
    const { status, body } = await json('/api/portfolio', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json',
    });
    assert.equal(status, 400);
    assert.equal(body.errorDetail.code, 'INVALID_BODY');
  });
});

describe('error contract', { skip: OFFLINE && 'no upstream access' }, () => {
  test('no response leaks a raw upstream status or vendor name to the customer', async () => {
    // "Trendlyne HTTP 403" and "DBnomics timed out after 30s" both reached real users.
    for (const p of ['/api/quote?sym=ZZZNOTREAL', '/api/trend?uni=NIFTY50', '/api/macro?ind=nonsense']) {
      const r = await get(p);
      const body = await r.text();
      const msg = (JSON.parse(body).error) || '';
      assert.ok(!/HTTP \d{3}/i.test(msg), `${p} leaked a status code: ${msg}`);
      assert.ok(!/Trendlyne|DBnomics|Yahoo|TradingView/i.test(msg), `${p} leaked a vendor name: ${msg}`);
    }
  });

  test('every error carries a requestId so a user report can be traced to a log line', async () => {
    const { body } = await json('/api/trend?uni=NIFTY50');
    assert.match(body.errorDetail.requestId, /^[a-z0-9]{6,10}$/);
  });

  test('/api/swot answers 200 with a labelled unavailable state, never a 502', async () => {
    // The panel must render a truthful fallback card rather than an error blob.
    const r = await get('/api/swot?sym=RELIANCE');
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.ok(b.status === undefined || ['ok', 'unavailable'].includes(b.status));
  });
});

describe('cache-key isolation', { skip: OFFLINE && 'no upstream access' }, () => {
  test('different universes do not serve each other\'s rows', async () => {
    const a = await json('/api/trend?uni=Nifty%2050&tf=1%20Day');
    const b = await json('/api/trend?uni=Nifty%20IT&tf=1%20Day');
    assert.equal(a.body.uni, 'Nifty 50');
    assert.equal(b.body.uni, 'Nifty IT');
    assert.notEqual(a.body.stocks.length, 0);
    assert.notEqual(b.body.stocks.length, 0);
    // Nifty IT is a strict subset — identical row counts would mean a shared cache entry.
    assert.ok(b.body.stocks.length < a.body.stocks.length,
      `Nifty IT (${b.body.stocks.length}) must be smaller than Nifty 50 (${a.body.stocks.length})`);
  });

  test('mover periods are cached independently', async () => {
    const d = await json('/api/movers?uni=Nifty%2050&period=daily');
    const m = await json('/api/movers?uni=Nifty%2050&period=monthly');
    assert.equal(d.body.period, 'daily');
    assert.equal(m.body.period, 'monthly');
  });
});

describe('freshness + source metadata', { skip: OFFLINE && 'no upstream access' }, () => {
  test('/api/indices states a previous close and how it was derived', async () => {
    const { body } = await json('/api/indices');
    for (const idx of body.indices) {
      if (idx.error) continue;
      assert.ok(['series', 'chartPreviousClose', 'unavailable'].includes(idx.prevCloseBasis),
        `${idx.name} has no prevCloseBasis`);
      // REGRESSION: a missing reference close must surface as null, never a fabricated 0.00%.
      if (idx.prevCloseBasis === 'unavailable') {
        assert.equal(idx.pct, null, `${idx.name} reported a change with no reference close`);
      } else {
        assert.ok(idx.prevClose > 0, `${idx.name} claims basis ${idx.prevCloseBasis} but has no prevClose`);
      }
    }
  });

  test('gold is labelled as derived, never as a live MCX tick', async () => {
    const { body } = await json('/api/indices');
    if (body.gold && !body.gold.error) {
      assert.equal(body.gold.derived, true);
      assert.match(body.gold.basis, /COMEX/);
    }
  });

  test('data-bearing routes carry a meta block with a truthful cache/market state', async () => {
    const routes = ['/api/indices', '/api/movers?uni=Nifty%2050&period=daily', '/api/fii-dii',
      '/api/breadth?uni=Nifty%2050', '/api/trend?uni=Nifty%2050&tf=1%20Day'];
    for (const p of routes) {
      const { body } = await json(p);
      assert.ok(body.meta, `${p} has no meta block`);
      assert.ok(body.meta.source, `${p} meta has no source`);
      assert.ok(['fresh', 'cached', 'stale', 'curated', 'unavailable'].includes(body.meta.cacheState),
        `${p} cacheState=${body.meta.cacheState}`);
      assert.ok(['open', 'closed'].includes(body.meta.marketStatus), `${p} marketStatus=${body.meta.marketStatus}`);
      assert.ok(Date.parse(body.meta.fetchedAt) > 0, `${p} fetchedAt is not a date`);
      assert.ok(body.meta.coverage, `${p} does not state its coverage`);
    }
  });

  test('meta never claims an open market outside NSE hours', async () => {
    // Cheap guard against a timezone-offset regression in marketStatusIST: derive IST
    // independently here and require the server to agree.
    const { body } = await json('/api/indices');
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const mins = ist.getHours() * 60 + ist.getMinutes(), day = ist.getDay();
    const expectOpen = day >= 1 && day <= 5 && mins >= 555 && mins <= 930;
    assert.equal(body.meta.marketStatus, expectOpen ? 'open' : 'closed',
      `server says ${body.meta.marketStatus} at ${ist.toISOString()} IST-shifted`);
  });

  test('macro responses declare source, vintage and what is estimate vs actual', async () => {
    const { status, body } = await json('/api/macro?ind=inflation');
    assert.equal(status, 200);
    assert.match(body.source, /World Bank|IMF/);
    assert.ok(body.actualsThrough <= body.latestYear);
    assert.ok(body.estimateFrom > body.actualsThrough,
      'estimates must start after the last actual year');
  });

  test('curated macro is not presented as a live feed', async () => {
    const { body } = await json('/api/georisk');
    assert.match(JSON.stringify(body).slice(0, 400), /HAND-MAINTAINED|curated/i);
  });
});

describe('internal consistency of computed panels', { skip: OFFLINE && 'no upstream access' }, () => {
  test('gap % is consistent with prevClose and open', async () => {
    const { body } = await json('/api/gaps?uni=Nifty%2050');
    for (const r of [...(body.ups || []), ...(body.downs || [])].slice(0, 10)) {
      const expected = (r.open - r.prevClose) / r.prevClose * 100;
      assert.ok(Math.abs(expected - r.gap) < 0.02,
        `${r.sym}: gap ${r.gap} != recomputed ${expected.toFixed(2)}`);
      // an "up" gap must actually be positive
      if ((body.ups || []).includes(r)) assert.ok(r.gap > 0, `${r.sym} is in ups with gap ${r.gap}`);
    }
  });

  test('relative strength equals stock return minus index return', async () => {
    const { body } = await json('/api/rs?uni=Nifty%2050&period=1M');
    for (const r of (body.leaders || []).slice(0, 10)) {
      assert.ok(Math.abs((r.ret - body.indexRet) - r.rel) < 0.02,
        `${r.sym}: rel ${r.rel} != ret ${r.ret} - indexRet ${body.indexRet}`);
    }
  });

  test('breadth advances and declines cover the whole universe', async () => {
    const { body } = await json('/api/breadth?uni=Nifty%2050');
    const b = body.breadth;
    if (b && b.n) assert.equal(b.adv + b.dec, b.n, 'adv + dec must equal the scanned count');
  });

  test('position sizing weights sum to 100% and respect the cap', async () => {
    const { body } = await json('/api/possize?syms=RELIANCE,TCS,INFY&amount=500000&cap=50');
    const total = body.rows.reduce((a, r) => a + r.weight, 0);
    assert.ok(Math.abs(total - 100) < 0.5, `weights sum to ${total}, not 100`);
    for (const r of body.rows) {
      assert.ok(r.weight <= 50.5, `${r.sym} weight ${r.weight} breaches the 50% cap`);
      // quantity must be affordable at the quoted price
      assert.ok(r.qty * r.price <= r.alloc + r.price, `${r.sym}: ${r.qty} shares exceeds its allocation`);
    }
  });

  test('the correlation matrix is symmetric with a unit diagonal', async () => {
    const { body } = await json('/api/possize?syms=RELIANCE,TCS,INFY&amount=500000&cap=50');
    const m = body.matrix;
    for (let i = 0; i < m.length; i++) {
      assert.ok(Math.abs(m[i][i] - 1) < 1e-9, `diagonal ${i} is ${m[i][i]}`);
      for (let j = 0; j < m.length; j++) {
        assert.ok(Math.abs(m[i][j] - m[j][i]) < 1e-9, `matrix not symmetric at ${i},${j}`);
        assert.ok(m[i][j] >= -1.0001 && m[i][j] <= 1.0001, `correlation out of range at ${i},${j}`);
      }
    }
  });

  test('FII/DII net equals buy minus sell on every tracked day, with no duplicate dates', async () => {
    const { body } = await json('/api/fii-dii');
    const seen = new Set();
    for (const d of body.history || []) {
      assert.ok(!seen.has(d.date), `duplicate FII/DII date ${d.date}`);
      seen.add(d.date);
      for (const side of ['fii', 'dii']) {
        assert.ok(Math.abs((d[side].b - d[side].s) - d[side].n) < 0.02,
          `${d.date} ${side}: net ${d[side].n} != buy ${d[side].b} - sell ${d[side].s}`);
      }
    }
  });

  test('delivery history has strictly increasing, non-duplicated dates', async () => {
    // REGRESSION: NSE served the 25-Jun file for the 26-Jun URL, so one session appeared twice
    // and skewed every 20-session delivery baseline.
    const r = await get('/api/delivery?sym=RELIANCE');
    if (r.status === 404) return;                      // no delivery data on this host — nothing to assert
    const body = await r.json();
    const days = body.days || [];
    for (let i = 1; i < days.length; i++) {
      assert.ok(days[i].date > days[i - 1].date, `dates out of order: ${days[i - 1].date} then ${days[i].date}`);
      const a = days[i - 1], b = days[i];
      assert.ok(!(a.close === b.close && a.vol === b.vol && a.delivQty === b.delivQty && a.trades === b.trades),
        `${a.date} and ${b.date} are identical sessions — duplicated bhavcopy`);
    }
  });

  test('earnings rows say whether a date is an announcement or a fiscal period end', async () => {
    const { body } = await json('/api/earnings?sym=INFY');
    for (const r of body.rows || []) {
      assert.ok(['announced', 'periodEnd'].includes(r.dateKind), `row ${r.date} has no dateKind`);
      // a period-end row can never carry a price reaction
      if (r.dateKind === 'periodEnd') assert.equal(r.react1d, null);
    }
    if (body.stats) {
      assert.ok(body.stats.coverageFrom && body.stats.coverageTo,
        'reaction stats must state the window they cover');
    }
  });
});
