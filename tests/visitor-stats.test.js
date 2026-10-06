// Visitor-dashboard maths. Two layers:
//  1. Hand-built cases that pin down the definitions (new vs returning, engaged, your own
//     devices, Indian-time day boundaries, sources).
//  2. SQL parity: when an in-process Postgres is available (PGLITE_PATH points at a folder with
//     @electric-sql/pglite installed), the functions in supabase-setup.sql must return exactly
//     what visitor-stats.js returns on the same random data. Skipped otherwise.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../visitor-stats');

const iso = s => new Date(s).toISOString();
const visit = (id, vid, start, o = {}) => ({ id, visitor_id: vid, started_at: iso(start), last_seen: iso(o.last || start),
  duration_sec: o.secs ?? 0, pages: o.pages || ['home'], referrer: o.ref ?? '', source: o.src ?? null,
  country: o.country ?? 'India', region: o.region ?? 'Haryana', city: o.city ?? 'Gurugram', device: o.device || 'Mobile', os: o.os || 'Android',
  browser: 'Chrome', ip: o.ip || '1.1.1.1', isp: 'ISP', screen: '360x800', user_id: o.uid ?? null, user_name: o.uname ?? null, user_email: null });

// "Today" = 6 Oct 2026 in India. IST midnight = 18:30 UTC the day before.
const FROM = '2026-10-05T18:30:00Z', TO = '2026-10-06T18:30:00Z', PREV = '2026-10-04T18:30:00Z', PREV_TO = FROM;
const rows = [
  visit('a1', 'alice', '2026-09-26T10:00:00Z', { secs: 30 }),                  // Alice first came 10 days ago
  visit('a2', 'alice', '2026-10-06T05:00:00Z', { secs: 5 }),                   // …and is back today (not engaged: 5 s, 1 page)
  visit('b1', 'bob', '2026-10-06T06:00:00Z', { secs: 12, ref: 'https://www.google.com/search?q=x' }),   // new today, engaged by time
  visit('b2', 'bob', '2026-10-06T07:00:00Z', { secs: 3, pages: ['home', 'flows'] }),                     // engaged by 2 sections
  visit('o1', 'owner', '2026-10-06T08:00:00Z', { secs: 100, device: 'Desktop', os: 'Windows' }),         // you
  visit('c1', 'carol', '2026-10-05T18:29:00Z', { secs: 1 }),                   // 23:59 IST on 5 Oct → yesterday
  visit('d1', 'dave', '2026-10-05T18:31:00Z', { secs: 0, src: 'whatsapp' }),   // 00:01 IST on 6 Oct → today
];
const owners = new Set(['owner']);

describe('overview definitions', () => {
  const o = S.overview(rows, owners, { from: FROM, to: TO, prevFrom: PREV, prevTo: PREV_TO, bucket: 'hour' });

  test('counts people, visits, new visitors and engaged visits for the period', () => {
    assert.deepEqual(o.cur, { visitors: 3, new_visitors: 2, visits: 4, secs: 20, engaged: 2 });   // alice, bob, dave
  });
  test('previous period uses the same rules', () => {
    assert.deepEqual(o.prev, { visitors: 1, new_visitors: 1, visits: 1, secs: 1, engaged: 0 });   // carol
  });
  test('previous period can be a shifted window (today so far vs yesterday to the same time)', () => {
    // today up to 11:00 IST vs yesterday up to 11:00 IST: carol (23:59 IST yesterday) is outside it
    const p = S.overview(rows, owners, { from: FROM, to: '2026-10-06T05:30:00Z', prevFrom: PREV, prevTo: '2026-10-05T05:30:00Z' });
    assert.equal(p.prev.visits, 0);
    assert.deepEqual(p.cur, { visitors: 2, new_visitors: 1, visits: 2, secs: 5, engaged: 0 });   // dave 00:01, alice 10:30
  });
  test('your own devices are left out unless asked for', () => {
    const withMe = S.overview(rows, owners, { from: FROM, to: TO, prevFrom: PREV, includeMe: true });
    assert.equal(withMe.cur.visitors, 4);
    assert.equal(o.alltime.visitors, 4);           // alice, bob, carol, dave
    assert.equal(withMe.alltime.visitors, 5);
  });
  test('hour buckets follow Indian time, and "new" means first visit in that bucket', () => {
    const bob = o.series.find(s => s.t === '2026-10-06T11:00');   // 06:00 UTC = 11:30 IST
    assert.deepEqual(bob, { t: '2026-10-06T11:00', visitors: 1, new_visitors: 1, visits: 1 });
    const alice = o.series.find(s => s.t === '2026-10-06T10:00');
    assert.equal(alice.new_visitors, 0);
    assert.equal(o.series[0].t, '2026-10-06T00:00');              // dave, 00:01 IST
  });
  test('day buckets split at IST midnight', () => {
    const d = S.overview(rows, owners, { from: PREV, to: TO, bucket: 'day' });
    assert.deepEqual(d.series.map(s => [s.t, s.visitors]), [['2026-10-05T00:00', 1], ['2026-10-06T00:00', 3]]);
  });
  test('week buckets start on Monday (IST)', () => {
    assert.equal(S.bucketKey('2026-10-06T05:00:00Z', 'week'), '2026-10-05T00:00');   // Tue 6 Oct → Mon 5 Oct
    assert.equal(S.bucketKey('2026-10-04T19:00:00Z', 'week'), '2026-10-05T00:00');   // 00:30 IST Mon
    assert.equal(S.bucketKey('2026-10-04T18:00:00Z', 'week'), '2026-09-28T00:00');   // 23:30 IST Sun
  });
  test('sections count visits that opened them', () => {
    assert.deepEqual(o.sections, [{ section: 'home', visits: 4 }, { section: 'flows', visits: 1 }]);
  });
});

describe('traffic channels', () => {
  test('tags beat referrers, own site and blanks are direct, known hosts get names', () => {
    const ch = S.channels([
      { source: null, host: null, visits: 3 }, { source: null, host: 'marketpulse.example', visits: 2 },
      { source: null, host: 'www.google.co.in', visits: 4 }, { source: 'whatsapp', host: null, visits: 5 },
      { source: null, host: 't.co', visits: 1 }, { source: null, host: 'blog.example.org', visits: 1 },
    ], 'marketpulse.example');
    assert.deepEqual(ch.map(c => [c.label, c.visits]),
      [['Direct / app', 5], ['whatsapp', 5], ['Google search', 4], ['X (Twitter)', 1], ['blog.example.org', 1]]);
  });
  test('Android app referrers (android-app://package) map to the app', () => {
    const host = r => S.channelOf(null, S.refHost(r), 'x').label;
    assert.equal(host('android-app://com.whatsapp/'), 'WhatsApp');
    assert.equal(host('android-app://com.google.android.gm/'), 'Gmail');
    assert.equal(host('android-app://com.google.android.googlequicksearchbox/'), 'Google search');
    assert.equal(host('android-app://org.telegram.messenger/'), 'Telegram');
    assert.equal(host('android-app://com.linkedin.android/'), 'LinkedIn');
  });
});

describe('visitor list', () => {
  const labels = new Map([['bob', { name: 'Bob', owner: false }]]);
  const list = S.visitorList(rows, owners, labels, { from: FROM, to: TO });
  test('lists people active in the period, most recent first, without your devices', () => {
    assert.deepEqual(list.map(v => v.visitor_id), ['bob', 'alice', 'dave']);
  });
  test('carries all-time totals and the first referrer', () => {
    const alice = list.find(v => v.visitor_id === 'alice');
    assert.equal(alice.visits, 2); assert.equal(alice.total_sec, 35);
    assert.equal(alice.first_seen, iso('2026-09-26T10:00:00Z'));
    const bob = list.find(v => v.visitor_id === 'bob');
    assert.equal(bob.label, 'Bob'); assert.deepEqual(bob.pages, ['flows', 'home']);
    assert.match(bob.referrer, /google/);
  });
  test('paging', () => {
    assert.deepEqual(S.visitorList(rows, owners, labels, { from: FROM, to: TO, limit: 1, offset: 1 }).map(v => v.visitor_id), ['alice']);
  });
});

// ─────────── SQL parity ───────────
let PGlite = null;
try { ({ PGlite } = require(path.join(process.env.PGLITE_PATH || '/nonexistent', 'node_modules', '@electric-sql', 'pglite'))); } catch {}

describe('supabase-setup.sql matches visitor-stats.js', { skip: !PGlite && 'set PGLITE_PATH to run' }, () => {
  // deterministic pseudo-random data: 3,000 visits by 400 browsers over 120 days
  let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const NOW = Date.parse('2026-10-06T09:00:00Z');
  const data = [];
  for (let i = 0; i < 3000; i++) {
    const vid = 'v' + Math.floor(Math.pow(rnd(), 2) * 400);          // some browsers come back a lot
    const start = NOW - Math.floor(rnd() * 120 * 86400e3);
    data.push(visit('s' + i, vid, start, {
      last: start + Math.floor(rnd() * 600e3), secs: pick([0, 0, 3, 5, 9, 10, 11, 45, 300]),
      pages: rnd() < 0.3 ? ['home', pick(['flows', 'macro', 'trend'])] : rnd() < 0.05 ? [] : ['home'],
      ref: pick(['', '', 'https://www.google.com/', 'https://t.co/x', 'android-app://com.whatsapp/', 'https://reddit.com/r/x', 'not a url']),
      src: rnd() < 0.1 ? pick(['whatsapp', 'college']) : null,
      country: rnd() < 0.05 ? null : pick(['India', 'India', 'United States']), region: pick(['Haryana', 'Delhi', null]),
      city: pick(['Gurugram', 'New Delhi', 'Noida']), device: pick(['Mobile', 'Desktop', 'Tablet']), os: pick(['Android', 'Windows', 'iOS']),
      uid: rnd() < 0.05 ? 1 + Math.floor(rnd() * 3) : null,
    }));
  }
  const ownerIds = ['v1', 'v7'];
  const labels = new Map([['v1', { name: 'Me', owner: true }], ['v7', { name: null, owner: true }], ['v9', { name: 'Friend', owner: false }]]);

  let db;
  const norm = x => JSON.parse(JSON.stringify(x, (k, v) =>
    /(_at|_seen)$/.test(k) && typeof v === 'string' ? Date.parse(v) : v));
  const sortBy = (a, f) => a.slice().sort((x, y) => (f(x) < f(y) ? -1 : f(x) > f(y) ? 1 : 0));

  test('load schema + data', async () => {
    db = new PGlite();
    await db.exec(`create role anon; create role authenticated; create role service_role;`);
    await db.exec(fs.readFileSync(path.join(__dirname, '..', 'supabase-setup.sql'), 'utf8'));
    for (let i = 0; i < data.length; i += 500) {
      await db.query(`insert into visits select * from jsonb_populate_recordset(null::visits, $1::jsonb)`, [JSON.stringify(data.slice(i, i + 500))]);
    }
    for (const [vid, l] of labels) await db.query('insert into visitor_labels (visitor_id, name, is_owner) values ($1,$2,$3)', [vid, l.name, l.owner]);
  });

  const ranges = [
    ['today', '2026-10-05T18:30:00Z', '2026-10-06T09:00:00Z', '2026-10-04T18:30:00Z', '2026-10-05T09:00:00Z', 'hour'],
    ['30 days', '2026-09-06T18:30:00Z', '2026-10-06T09:00:00Z', '2026-08-07T18:30:00Z', '2026-09-06T09:00:00Z', 'day'],
    ['all time', '2020-01-01T00:00:00Z', '2026-10-06T09:00:00Z', null, null, 'week'],
  ];
  for (const [name, from, to, prevFrom, prevTo, bucket] of ranges) for (const includeMe of [false, true]) {
    test(`mp_overview — ${name}${includeMe ? ', incl. you' : ''}`, async () => {
      const r = await db.query('select mp_overview($1, $2, $3, $4, $5, $6) as j', [from, to, prevFrom, prevTo, includeMe, bucket]);
      const sql = r.rows[0].j, js = S.overview(data, new Set(ownerIds), { from, to, prevFrom, prevTo, includeMe, bucket });
      assert.ok(js.cur.visits > 0);
      for (const k of ['cur', 'prev', 'series', 'alltime']) assert.deepEqual(norm(sql[k]), norm(js[k]), k);
      const key = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
      for (const k of ['sources', 'places', 'devices', 'os', 'sections', 'users']) assert.deepEqual(sortBy(norm(sql[k]), key), sortBy(norm(js[k]), key), k);
    });
    test(`mp_visitor_list — ${name}${includeMe ? ', incl. you' : ''}`, async () => {
      for (const [limit, offset] of [[50, 0], [50, 50], [500, 0]]) {
        const r = await db.query('select mp_visitor_list($1, $2, $3, $4, $5) as j', [from, to, includeMe, limit, offset]);
        const js = S.visitorList(data, new Set(ownerIds), labels, { from, to, includeMe, limit, offset });
        assert.deepEqual(norm(r.rows[0].j), norm(js), `limit ${limit} offset ${offset}`);
      }
    });
  }
});
