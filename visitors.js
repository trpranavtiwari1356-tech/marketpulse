// MarketPulse visitor analytics, user accounts and the private /admin dashboard.
// Zero-dependency like server.js: Node's crypto/fs/fetch only.
//
// Storage has two backends behind one interface:
//   • Supabase (Postgres via its REST API) when SUPABASE_URL + SUPABASE_SERVICE_KEY are set.
//     This is what the live site needs — Render's free tier wipes its disk on every restart,
//     so anything kept in a local file would vanish within hours.
//   • A local JSON file (.data/visitors.json) otherwise, so a dev run works with no setup.
//     The admin page shows a warning banner whenever this backend is active.
//
// Tables are created once by pasting supabase-setup.sql into Supabase's SQL editor.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SB_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const USE_SB = /^https:\/\/\S+$/.test(SB_URL) && SB_KEY.length > 20;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Cookie-signing secret. SESSION_SECRET wins; otherwise derive a stable one from the admin
// password so logins survive a restart without a second env var. Only with neither set does it
// fall back to a per-boot random value (everyone is simply logged out on restart).
const SECRET = process.env.SESSION_SECRET
  || (ADMIN_PASSWORD ? crypto.createHash('sha256').update('mp-session:' + ADMIN_PASSWORD).digest('hex')
                     : crypto.randomBytes(32).toString('hex'));

const IST_MS = 5.5 * 3600e3;                 // day boundaries follow Indian time — the audience is here
const LIVE_WINDOW_MS = 2 * 60e3;             // "online now" = pinged within the last 2 minutes
const FLUSH_MS = 15e3;

// ─────────── small HTTP helpers (kept local so this module doesn't reach into server.js) ───────────
function sendJson(res, code, obj, extraHeaders) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(JSON.stringify(obj));
}
function readBody(req, maxBytes = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0, over = false; const chunks = [];
    req.on('data', c => {
      if (over) return;
      n += c.length;
      if (n > maxBytes) { over = true; const e = new Error('Body too large'); e.status = 413; reject(e); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { const e = new Error('Invalid JSON'); e.status = 400; reject(e); }
    });
    req.on('error', reject);
  });
}
function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();   // Render sits behind a proxy
  return (fwd || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}
const isLoopback = ip => ip === '127.0.0.1' || ip === '::1';
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookieHeader(req, name, value, maxAgeSec) {
  const secure = (req.headers['x-forwarded-proto'] || '').startsWith('https') ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

// Per-IP fixed-window limiter, one bucket set per purpose.
function makeLimiter(limit, windowMs) {
  const m = new Map();
  return ip => {
    const now = Date.now();
    let e = m.get(ip);
    if (!e || now > e.resetAt) { e = { n: 0, resetAt: now + windowMs }; m.set(ip, e); }
    if (m.size > 5000) m.clear();
    return ++e.n > limit;
  };
}
const authLimited = makeLimiter(10, 60e3);      // sign-in / sign-up / admin login attempts
const trackLimited = makeLimiter(120, 60e3);    // tracker pings (one tab sends ~2/min)

// ─────────── signed tokens (HMAC) for the user + admin cookies ───────────
const b64u = s => Buffer.from(s).toString('base64url');
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function verify(token, kind) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.k === kind && p.x > Date.now() ? p : null;   // `k` stops a user cookie passing as admin
  } catch { return null; }
}
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// ─────────── passwords (scrypt, built into Node) ───────────
const scryptAsync = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await scryptAsync(pw, salt)).toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const got = await scryptAsync(pw, Buffer.from(saltHex, 'hex'));
  const want = Buffer.from(hashHex, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);

// ─────────── storage: Supabase REST ───────────
async function sb(pathAndQuery, opts = {}) {
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (SB_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SB_KEY;   // legacy JWT-style keys
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, { ...opts, headers, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(t); }
}
const sbStore = {
  async upsertVisits(rows) {
    await sb('visits?on_conflict=id', { method: 'POST', body: JSON.stringify(rows),
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  },
  async allVisits(maxRows = 100000) {
    const out = [];
    for (let off = 0; off < maxRows; off += 1000) {
      const page = await sb(`visits?select=*&order=started_at.desc&limit=1000&offset=${off}`);
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  },
  async userByEmail(email) {
    const r = await sb(`users?select=*&email=eq.${encodeURIComponent(email)}&limit=1`);
    return r[0] || null;
  },
  async createUser(u) {
    const r = await sb('users', { method: 'POST', body: JSON.stringify(u), headers: { Prefer: 'return=representation' } });
    return r[0];
  },
  async touchLogin(id) {
    await sb(`users?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH',
      body: JSON.stringify({ last_login: new Date().toISOString() }), headers: { Prefer: 'return=minimal' } });
  },
  async listUsers() {
    return sb('users?select=id,name,email,created_at,last_login&order=created_at.desc&limit=5000');
  },
};

// ─────────── storage: local JSON file (dev fallback) ───────────
const DATA_FILE = path.join(__dirname, '.data', 'visitors.json');
let fileDb = null, fileTimer = null;
function db() {
  if (!fileDb) {
    try { fileDb = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { fileDb = {}; }
    fileDb.visits = fileDb.visits || {}; fileDb.users = fileDb.users || [];
  }
  return fileDb;
}
function saveSoon() {
  if (fileTimer) return;
  fileTimer = setTimeout(() => {
    fileTimer = null;
    try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(fileDb)); }
    catch (e) { console.error('[visitors] local save failed:', e.message); }
  }, 1000);
}
const fileStore = {
  async upsertVisits(rows) { const d = db(); for (const r of rows) d.visits[r.id] = { ...d.visits[r.id], ...r }; saveSoon(); },
  async allVisits() { return Object.values(db().visits).sort((a, b) => (a.started_at < b.started_at ? 1 : -1)); },
  async userByEmail(email) { return db().users.find(u => u.email === email) || null; },
  async createUser(u) {
    const d = db(), row = { id: (d.users.reduce((m, x) => Math.max(m, x.id), 0) + 1), created_at: new Date().toISOString(), last_login: null, ...u };
    d.users.push(row); saveSoon(); return row;
  },
  async touchLogin(id) { const u = db().users.find(x => x.id === id); if (u) { u.last_login = new Date().toISOString(); saveSoon(); } },
  async listUsers() {
    return db().users.map(({ pass_hash, ...rest }) => rest).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  },
};
const store = USE_SB ? sbStore : fileStore;

// ─────────── visitor details: IP → place, user-agent → device ───────────
const geoCache = new Map();
async function geoLookup(ip) {
  if (!ip || isLoopback(ip) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd|fe80)/i.test(ip)) return {};
  if (geoCache.has(ip)) return geoCache.get(ip);
  let g = {};
  try {
    // ip-api.com: free, no key, 45 lookups/min — we call it once per new visit, not per ping.
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,isp`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j.status === 'success') g = { country: j.country, region: j.regionName, city: j.city, isp: j.isp };
  } catch { /* geo is best-effort */ }
  if (geoCache.size > 2000) geoCache.clear();
  geoCache.set(ip, g);
  return g;
}
function parseUA(ua) {
  ua = ua || '';
  const os = /Windows NT/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const device = /iPad|Tablet/.test(ua) ? 'Tablet' : /Mobi|Android|iPhone/.test(ua) ? 'Mobile' : 'Desktop';
  const bot = /bot|crawl|spider|slurp|headless|lighthouse/i.test(ua);
  return { os, browser, device, bot };
}

// ─────────── live sessions: kept in memory, flushed to storage in batches ───────────
// The browser sends its own running totals (start time, active seconds, pages seen), so a server
// restart loses nothing — the next ping simply rebuilds the in-memory record.
const live = new Map();          // sid -> visit row
const dirty = new Set();
const ID_RE = /^[a-z0-9]{8,40}$/i;
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);

async function handleTrack(req, res, user) {
  const ip = clientIp(req);
  if (trackLimited(ip)) return sendJson(res, 429, { ok: false });
  let b;
  try { b = await readBody(req); } catch (e) { return sendJson(res, e.status || 400, { ok: false }); }
  if (!ID_RE.test(b.sid || '') || !ID_RE.test(b.vid || '')) return sendJson(res, 400, { ok: false });
  const ua = parseUA(req.headers['user-agent']);
  if (ua.bot) return sendJson(res, 204, {});

  const now = Date.now();
  let row = live.get(b.sid);
  const isNew = !row;
  if (isNew) {
    const t0 = Number.isFinite(+b.t0) ? Math.min(now, Math.max(now - 24 * 3600e3, +b.t0)) : now;
    row = {
      id: b.sid, visitor_id: b.vid, started_at: new Date(t0).toISOString(),
      ip, country: null, region: null, city: null, isp: null,
      device: ua.device, browser: ua.browser, os: ua.os,
      screen: clip(b.screen, 20), lang: clip(b.lang, 20), tz: clip(b.tz, 50), referrer: clip(b.ref, 300),
    };
    live.set(b.sid, row);
  }
  row.last_seen = new Date(now).toISOString();
  row.duration_sec = Math.max(row.duration_sec || 0, Math.min(86400, Math.max(0, Math.round(+b.active || 0))));
  const pages = Array.isArray(b.pages) ? b.pages.filter(p => /^[a-z]{1,20}$/.test(p)).slice(0, 20) : [];
  row.pages = [...new Set([...(row.pages || []), ...pages])].slice(0, 20);
  row.user_id = user ? user.u : (row.user_id || null);
  row.user_name = user ? user.n : (row.user_name || null);
  row.user_email = user ? user.e : (row.user_email || null);

  if (isNew) {
    // Hold the first write until the place lookup lands so the stored row never has blank geo
    // overwriting good geo (a restart re-creates the row from scratch).
    geoLookup(ip).then(g => { Object.assign(row, { country: g.country || null, region: g.region || null, city: g.city || null, isp: g.isp || null }); dirty.add(b.sid); });
  } else dirty.add(b.sid);
  return sendJson(res, 200, { ok: true });
}

let flushing = null;
async function flush() {
  if (flushing) return flushing;
  if (!dirty.size) return;
  const ids = [...dirty]; dirty.clear();
  const rows = ids.map(id => live.get(id)).filter(Boolean).map(r => ({ ...r }));
  flushing = store.upsertVisits(rows)
    .catch(e => { console.error('[visitors] flush failed:', e.message); ids.forEach(id => dirty.add(id)); })
    .finally(() => { flushing = null; });
  await flushing;
  // forget sessions that have gone quiet (their final state is already stored)
  const cutoff = Date.now() - 30 * 60e3;
  for (const [id, r] of live) if (!dirty.has(id) && Date.parse(r.last_seen) < cutoff) live.delete(id);
}
setInterval(() => { flush(); }, FLUSH_MS).unref();
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => { flush().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 4000).unref(); });
}

// ─────────── user accounts ───────────
const EMAIL_RE = /^[^\s@,()<>;:"\[\]]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;
const USER_TTL_SEC = 30 * 24 * 3600;
const userCookie = (req, u) => cookieHeader(req, 'mp_u',
  sign({ k: 'u', u: u.id, n: u.name, e: u.email, x: Date.now() + USER_TTL_SEC * 1000 }), USER_TTL_SEC);
const currentUser = req => verify(parseCookies(req).mp_u, 'u');

async function handleAuth(req, res, action) {
  if (action === 'me') {
    const u = currentUser(req);
    return sendJson(res, 200, { user: u ? { name: u.n, email: u.e } : null });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
  if (action === 'logout') return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, 'mp_u', '', 0) });
  if (authLimited(clientIp(req))) return sendJson(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });

  let b;
  try { b = await readBody(req); } catch (e) { return sendJson(res, e.status || 400, { error: 'Bad request.' }); }
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: 'Enter a valid email address.' });

  try {
    if (action === 'signup') {
      const name = String(b.name || '').trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 60) return sendJson(res, 400, { error: 'Enter your name (2–60 characters).' });
      if (password.length < 8 || password.length > 128) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
      if (await store.userByEmail(email)) return sendJson(res, 409, { error: 'An account with this email already exists. Sign in instead.' });
      const u = await store.createUser({ name, email, pass_hash: await hashPassword(password), last_login: new Date().toISOString() });
      return sendJson(res, 200, { user: { name: u.name, email: u.email } }, { 'Set-Cookie': userCookie(req, u) });
    }
    if (action === 'login') {
      const u = await store.userByEmail(email);
      const ok = await checkPassword(password, u ? u.pass_hash : DUMMY_HASH);   // same work either way
      if (!u || !ok) return sendJson(res, 401, { error: 'Wrong email or password.' });
      store.touchLogin(u.id).catch(() => {});
      return sendJson(res, 200, { user: { name: u.name, email: u.email } }, { 'Set-Cookie': userCookie(req, u) });
    }
  } catch (e) {
    console.error('[visitors] auth error:', e.message);
    return sendJson(res, 503, { error: 'Accounts are unavailable right now. Try again shortly.' });
  }
  return sendJson(res, 404, { error: 'Not found.' });
}

// ─────────── admin ───────────
const ADMIN_TTL_SEC = 12 * 3600;
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return isLoopback(clientIp(req)) && !req.headers['x-forwarded-for'];   // dev: localhost only
  return !!verify(parseCookies(req).mp_a, 'a');
}

const istDay = ms => new Date(ms + IST_MS).toISOString().slice(0, 10);

async function adminStats() {
  await flush();
  const [visits, users] = await Promise.all([store.allVisits(), store.listUsers()]);
  const now = Date.now();
  const today = istDay(now), yesterday = istDay(now - 86400e3);

  const byDay = new Map();               // day -> { visitors:Set, visits, secs }
  const byVisitor = new Map();           // visitor_id -> summary
  for (const v of visits) {
    const t = Date.parse(v.started_at), day = istDay(t);
    let d = byDay.get(day);
    if (!d) byDay.set(day, d = { visitors: new Set(), visits: 0, secs: 0 });
    d.visitors.add(v.visitor_id); d.visits++; d.secs += v.duration_sec || 0;

    let s = byVisitor.get(v.visitor_id);
    if (!s) byVisitor.set(v.visitor_id, s = { visitor_id: v.visitor_id, visits: 0, total_sec: 0, first_seen: v.started_at,
      last_seen: v.last_seen || v.started_at, name: null, email: null, city: v.city, region: v.region, country: v.country,
      device: v.device, browser: v.browser, os: v.os, ip: v.ip, isp: v.isp });
    s.visits++; s.total_sec += v.duration_sec || 0;
    if (v.started_at < s.first_seen) s.first_seen = v.started_at;
    if ((v.last_seen || '') > s.last_seen) s.last_seen = v.last_seen;
    if (v.user_name && !s.name) { s.name = v.user_name; s.email = v.user_email; }
  }
  const dayStat = k => { const d = byDay.get(k); return { visitors: d ? d.visitors.size : 0, visits: d ? d.visits : 0 }; };
  const uniqueSince = days => {
    const set = new Set(); const from = istDay(now - (days - 1) * 86400e3);
    for (const [k, d] of byDay) if (k >= from) d.visitors.forEach(x => set.add(x));
    return set.size;
  };
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const k = istDay(now - i * 86400e3), d = byDay.get(k);
    daily.push({ day: k, visitors: d ? d.visitors.size : 0, visits: d ? d.visits : 0, avg_sec: d && d.visits ? Math.round(d.secs / d.visits) : 0 });
  }
  const recent30 = visits.filter(v => Date.parse(v.started_at) > now - 30 * 86400e3 && (v.duration_sec || 0) > 0);
  const avgSec = recent30.length ? Math.round(recent30.reduce((a, v) => a + v.duration_sec, 0) / recent30.length) : 0;

  const onlineNow = [...live.values()].filter(r => now - Date.parse(r.last_seen) < LIVE_WINDOW_MS)
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  const visitsByUser = new Map();
  for (const v of visits) if (v.user_id != null) {
    const s = visitsByUser.get(v.user_id) || { visits: 0, secs: 0 };
    s.visits++; s.secs += v.duration_sec || 0; visitsByUser.set(v.user_id, s);
  }

  return {
    storage: USE_SB ? 'supabase' : 'local-file',
    generatedAt: new Date(now).toISOString(),
    kpi: {
      onlineNow: onlineNow.length,
      today: dayStat(today), yesterday: dayStat(yesterday),
      last7: uniqueSince(7), last30: uniqueSince(30),
      allTimeVisitors: byVisitor.size, allTimeVisits: visits.length,
      avgSec30: avgSec, registeredUsers: users.length,
    },
    daily,
    online: onlineNow.slice(0, 100),
    recent: visits.slice(0, 200),
    visitors: [...byVisitor.values()].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1)).slice(0, 500),
    users: users.map(u => ({ ...u, ...(visitsByUser.get(u.id) || { visits: 0, secs: 0 }) })),
  };
}

async function handleAdmin(req, res, action) {
  if (action === 'login') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
    if (!ADMIN_PASSWORD) return sendJson(res, 400, { error: 'Set ADMIN_PASSWORD on the server to enable remote admin login.' });
    if (authLimited(clientIp(req))) return sendJson(res, 429, { error: 'Too many attempts. Wait a minute.' });
    let b; try { b = await readBody(req); } catch { return sendJson(res, 400, { error: 'Bad request.' }); }
    if (!safeEqual(b.password || '', ADMIN_PASSWORD)) return sendJson(res, 401, { error: 'Wrong password.' });
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, 'mp_a', sign({ k: 'a', x: Date.now() + ADMIN_TTL_SEC * 1000 }), ADMIN_TTL_SEC) });
  }
  if (action === 'logout') return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, 'mp_a', '', 0) });
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Sign in required.', passwordSet: !!ADMIN_PASSWORD });
  if (action === 'stats') {
    try { return sendJson(res, 200, await adminStats()); }
    catch (e) { console.error('[visitors] stats error:', e.message); return sendJson(res, 503, { error: 'Could not read the analytics store: ' + e.message }); }
  }
  return sendJson(res, 404, { error: 'Not found.' });
}

// ─────────── router entry: returns true when it handled the request ───────────
async function handle(req, res, u) {
  const p = u.pathname;
  if (p === '/api/t' && req.method === 'POST') { await handleTrack(req, res, currentUser(req)); return true; }
  if (p.startsWith('/api/auth/')) { await handleAuth(req, res, p.slice('/api/auth/'.length)); return true; }
  if (p.startsWith('/api/admin/')) { await handleAdmin(req, res, p.slice('/api/admin/'.length)); return true; }
  if (p === '/admin' || p === '/admin/') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex',
      'X-Frame-Options': 'DENY' });
    res.end(fs.readFileSync(path.join(__dirname, 'admin.html')));
    return true;
  }
  return false;
}

if (!USE_SB) console.log('[visitors] storage: local file .data/visitors.json (set SUPABASE_URL + SUPABASE_SERVICE_KEY for permanent storage)');
if (!ADMIN_PASSWORD) console.log('[visitors] ADMIN_PASSWORD not set — /admin is open to localhost only');

module.exports = { handle, flush, parseUA, hashPassword, checkPassword, sign, verify };
