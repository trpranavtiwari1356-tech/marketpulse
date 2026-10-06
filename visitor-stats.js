// Dashboard maths in plain JavaScript — the twin of mp_overview / mp_visitor_list in
// supabase-setup.sql. Used for the local-file store and as a fallback before the SQL has been run.
// Definitions must match the SQL exactly (tests/visitor-stats.test.js checks the two agree):
//   visit          = one browser-tab session        visitor = one browser (anonymous id)
//   new visitor    = first-ever visit falls inside the period
//   engaged visit  = 10+ s of active time, or 2+ sections opened
//   buckets        = Indian time (Asia/Kolkata, UTC+5:30, no daylight saving)

const IST_MS = 5.5 * 3600e3;
const HOST_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/:?#]+)/;

const ms = t => Date.parse(t);
const secsOf = v => v.duration_sec || 0;
const pagesOf = v => (Array.isArray(v.pages) ? v.pages : []);
const isEngaged = v => secsOf(v) >= 10 || pagesOf(v).length >= 2;
const refHost = r => { const m = typeof r === 'string' && r.match(HOST_RE); return m ? m[1].toLowerCase() : null; };

// date_trunc(bucket, t AT TIME ZONE 'Asia/Kolkata'), formatted like to_char(…, 'YYYY-MM-DD"T"HH24:MI')
function bucketKey(t, bucket) {
  const d = new Date(ms(t) + IST_MS);
  if (bucket === 'hour') d.setUTCMinutes(0, 0, 0);
  else {
    d.setUTCHours(0, 0, 0, 0);
    if (bucket === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));   // ISO week: Monday
  }
  return d.toISOString().slice(0, 16);
}

// Postgres orders NULLs last in ascending sorts; mirror that for tie-breaks.
const cmpNullLast = (a, b) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a < b ? -1 : a > b ? 1 : 0);

function firstVisits(rows) {
  const first = new Map();
  for (const v of rows) { const t = ms(v.started_at), f = first.get(v.visitor_id); if (f === undefined || t < f) first.set(v.visitor_id, t); }
  return first;
}

function summarize(list, newFrom, first) {
  const vis = new Set(), fresh = new Set();
  let secs = 0, engaged = 0;
  for (const v of list) {
    vis.add(v.visitor_id);
    if (first.get(v.visitor_id) >= newFrom) fresh.add(v.visitor_id);
    secs += secsOf(v); if (isEngaged(v)) engaged++;
  }
  return { visitors: vis.size, new_visitors: fresh.size, visits: list.length, secs, engaged };
}

function countDistinct(list, keyOf, label) {
  const m = new Map();
  for (const v of list) {
    const k = JSON.stringify(keyOf(v));
    if (!m.has(k)) m.set(k, { key: keyOf(v), set: new Set() });
    m.get(k).set.add(v.visitor_id);
  }
  return [...m.values()].map(({ key, set }) => ({ ...key, [label]: set.size }));
}

/** rows: every stored visit (needed to know each visitor's first visit). owners: Set of your own ids. */
function overview(rows, owners, { from, to, prevFrom = null, prevTo = null, includeMe = false, bucket = 'day' }) {
  const F = ms(from), T = ms(to), P = prevFrom == null ? null : ms(prevFrom), PT = prevTo == null ? F : ms(prevTo);
  const keep = v => includeMe || !owners.has(v.visitor_id);
  const first = firstVisits(rows);
  const cur = [], prev = [];
  for (const v of rows) {
    if (!keep(v)) continue;
    const t = ms(v.started_at);
    if (t >= F && t < T) cur.push(v);
    if (P != null && t >= P && t < PT) prev.push(v);
  }

  const series = new Map();
  for (const v of cur) {
    const k = bucketKey(v.started_at, bucket);
    let s = series.get(k);
    if (!s) series.set(k, s = { t: k, vis: new Set(), nv: new Set(), visits: 0 });
    s.vis.add(v.visitor_id); s.visits++;
    if (bucketKey(new Date(first.get(v.visitor_id)).toISOString(), bucket) === k) s.nv.add(v.visitor_id);
  }

  const sources = new Map();
  for (const v of cur) {
    const src = v.source || null, host = refHost(v.referrer), k = JSON.stringify([src, host]);
    const s = sources.get(k) || { source: src, host, visits: 0 };
    s.visits++; sources.set(k, s);
  }

  const sections = new Map();
  for (const v of cur) for (const p of pagesOf(v)) sections.set(p, (sections.get(p) || 0) + 1);

  const users = new Map();
  for (const v of rows) if (v.user_id != null) {
    const u = users.get(v.user_id) || { user_id: v.user_id, visits: 0, secs: 0 };
    u.visits++; u.secs += secsOf(v); users.set(v.user_id, u);
  }

  const all = rows.filter(keep);
  return {
    cur: summarize(cur, F, first),
    prev: P == null ? null : summarize(prev, P, first),
    series: [...series.values()].sort((a, b) => (a.t < b.t ? -1 : 1))
      .map(s => ({ t: s.t, visitors: s.vis.size, new_visitors: s.nv.size, visits: s.visits })),
    sources: [...sources.values()],
    places: countDistinct(cur, v => ({ country: v.country ?? null, region: v.region ?? null, city: v.city ?? null }), 'visitors')
      .sort((a, b) => b.visitors - a.visitors || cmpNullLast(a.country, b.country) || cmpNullLast(a.region, b.region) || cmpNullLast(a.city, b.city))
      .slice(0, 50),
    devices: countDistinct(cur, v => ({ device: v.device ?? null }), 'visitors').sort((a, b) => b.visitors - a.visitors || cmpNullLast(a.device, b.device)),
    os: countDistinct(cur, v => ({ os: v.os ?? null }), 'visitors').sort((a, b) => b.visitors - a.visitors || cmpNullLast(a.os, b.os)),
    sections: [...sections].map(([section, visits]) => ({ section, visits })).sort((a, b) => b.visits - a.visits || cmpNullLast(a.section, b.section)),
    alltime: { visitors: new Set(all.map(v => v.visitor_id)).size, visits: all.length },
    users: [...users.values()],
  };
}

/** Visitors active in [from, to), most recently active first, each with all-time totals. */
function visitorList(rows, owners, labels, { from, to, includeMe = false, limit = 50, offset = 0 }) {
  const F = ms(from), T = ms(to);
  const byVid = new Map();
  for (const v of rows) { if (!byVid.has(v.visitor_id)) byVid.set(v.visitor_id, []); byVid.get(v.visitor_id).push(v); }
  const active = [];
  for (const [vid, list] of byVid) {
    if (!includeMe && owners.has(vid)) continue;
    let at = null;
    for (const v of list) {
      const t = ms(v.started_at);
      if (t >= F && t < T) { const s = ms(v.last_seen || v.started_at); if (at === null || s > at) at = s; }
    }
    if (at !== null) active.push({ vid, at });
  }
  active.sort((a, b) => b.at - a.at || (a.vid < b.vid ? -1 : 1));
  const lim = Math.min(Math.max(limit, 1), 500), off = Math.max(offset, 0);
  return active.slice(off, off + lim).map(({ vid, at }) => {
    const list = byVid.get(vid).slice().sort((a, b) => ms(a.started_at) - ms(b.started_at));
    const firstV = list[0], lastV = list[list.length - 1];
    const named = list.filter(v => v.user_name).pop();
    const lab = labels.get(vid) || {};
    return {
      visitor_id: vid, active_at: new Date(at).toISOString(),
      visits: list.length, total_sec: list.reduce((a, v) => a + secsOf(v), 0),
      first_seen: firstV.started_at,
      last_seen: new Date(Math.max(...list.map(v => ms(v.last_seen || v.started_at)))).toISOString(),
      ip: lastV.ip ?? null, isp: lastV.isp ?? null, city: lastV.city ?? null, region: lastV.region ?? null, country: lastV.country ?? null,
      device: lastV.device ?? null, os: lastV.os ?? null, browser: lastV.browser ?? null, screen: lastV.screen ?? null,
      referrer: firstV.referrer ?? null, source: firstV.source ?? null,
      pages: [...new Set(list.flatMap(pagesOf))].sort(),
      label: lab.name ?? null, owner: !!lab.owner,
      name: named ? named.user_name : null, email: named ? named.user_email : null,
    };
  });
}

// ─────────── traffic channels: (campaign tag, referring host) → a readable channel ───────────
// Android apps report themselves as android-app://<package>, so the package names sit beside the websites.
const CHANNELS = [
  [/^com\.google\.android\.gm$/, 'Gmail'],
  [/(^|\.)google\.|^com\.google\.android\.googlequicksearchbox$/, 'Google search'],
  [/(^|\.)bing\.com$/, 'Bing'], [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'],
  [/(^|\.)(whatsapp\.com|wa\.me)$|^com\.whatsapp(\.w4b)?$/, 'WhatsApp'],
  [/(^|\.)(t\.me|telegram\.org|telegram\.me)$|^org\.telegram\./, 'Telegram'],
  [/(^|\.)reddit\.com$|^com\.reddit\./, 'Reddit'], [/(^|\.)(x\.com|twitter\.com|t\.co)$|^com\.twitter\./, 'X (Twitter)'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$|^com\.linkedin\./, 'LinkedIn'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$|^com\.facebook\.(katana|lite|orca)$/, 'Facebook'],
  [/(^|\.)instagram\.com$|^com\.instagram\./, 'Instagram'], [/(^|\.)(youtube\.com|youtu\.be)$|^com\.google\.android\.youtube$/, 'YouTube'],
  [/(^|\.)github\.com$/, 'GitHub'], [/(^|\.)news\.ycombinator\.com$/, 'Hacker News'],
];
function channelOf(source, host, ownHost) {
  if (source) return { label: source, kind: 'link' };                       // your own ?ref= tag wins
  const h = host ? host.replace(/^www\./, '') : null;
  if (!h || (ownHost && h === ownHost.replace(/^www\./, ''))) return { label: 'Direct / app', kind: 'direct' };
  for (const [re, label] of CHANNELS) if (re.test(h)) return { label, kind: 'site' };
  return { label: h, kind: 'site' };
}
function channels(sourceRows, ownHost) {
  const m = new Map();
  for (const r of sourceRows) {
    const c = channelOf(r.source, r.host, ownHost), k = c.kind + '|' + c.label;
    const e = m.get(k) || { ...c, visits: 0 };
    e.visits += r.visits; m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.visits - a.visits || (a.label < b.label ? -1 : 1));
}

module.exports = { overview, visitorList, channels, channelOf, bucketKey, refHost, IST_MS };
