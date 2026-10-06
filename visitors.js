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
const stats = require('./visitor-stats');   // dashboard maths (the JS twin of the SQL functions)

// Dashboard copy-paste picks up junk surprisingly often: wrapping quotes, a pasted `NAME=` prefix,
// zero-width characters from rich-text copies. Strip all of it rather than fail with "Invalid API key".
const cleanEnv = v => String(v || '')
  .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
  .trim()
  .replace(/^[A-Z_]+\s*=\s*/, '')
  .replace(/^["'`]+|["'`]+$/g, '')
  .replace(/\s+/g, '');
const SB_URL = cleanEnv(process.env.SUPABASE_URL).replace(/\/(rest\/v1)?\/*$/, '');
const SB_KEY = cleanEnv(process.env.SUPABASE_SERVICE_KEY);
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
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...(extraHeaders || {}) });
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
const trackLimited = makeLimiter(600, 60e3);    // tracker pings: a tab sends ~2/min; mobile carriers put many people behind one IP

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
// Salted, memory-hard hash: the database never holds a password, only scrypt$N$r$p$salt$hash.
// N=2^15 costs ~32 MB and ~100 ms per attempt — cheap for one sign-in, ruinous for a cracker
// working through a stolen table. The cost is stored per hash, so it can be raised later and old
// hashes upgrade themselves on the user's next sign-in (needsRehash).
const SCRYPT = { N: 32768, r: 8, p: 1 };
const scryptAsync = (pw, salt, o) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { ...o, maxmem: 128 * o.N * o.r * 2 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const k = await scryptAsync(pw, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${k.toString('hex')}`;
}
function parseHash(stored) {
  const f = String(stored || '').split('$');
  if (f[0] !== 'scrypt') return null;
  if (f.length === 3) return { N: 16384, r: 8, p: 1, salt: f[1], hash: f[2] };     // first-release format
  if (f.length === 6) return { N: +f[1], r: +f[2], p: +f[3], salt: f[4], hash: f[5] };
  return null;
}
async function checkPassword(pw, stored) {
  const h = parseHash(stored);
  if (!h || !(h.N >= 1024 && h.N <= 1048576)) return false;
  const got = await scryptAsync(pw, Buffer.from(h.salt, 'hex'), { N: h.N, r: h.r, p: h.p });
  const want = Buffer.from(h.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const needsRehash = stored => { const h = parseHash(stored); return !h || h.N < SCRYPT.N; };
const DUMMY_HASH = `scrypt$${SCRYPT.N}$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;

// Password rules: length, a letter + a digit, not one of the passwords every cracker tries first,
// and not just the email's own name part.
const COMMON_PW = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyuiop', 'abc12345', 'abcd1234', 'iloveyou1', 'welcome1', 'admin123', 'letmein1',
  'india123', 'test1234', 'passw0rd', '11111111', '00000000', '1q2w3e4r', 'asdf1234', 'zaq12wsx',
  'sunshine1', 'princess1', 'football1', 'monkey123', 'dragon123', 'master123', 'marketpulse1']);
function passwordProblem(pw, email) {
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 128) return 'Password is too long (max 128 characters).';
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'Use at least one letter and one number.';
  if (COMMON_PW.has(pw.toLowerCase())) return 'That password is too common — choose another.';
  const local = email.split('@')[0];
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return 'Password must not contain your email name.';
  return null;
}

// Account lockout, keyed by EMAIL rather than IP: an attacker rotating IPs (or spoofing the
// forwarded-for header) still gets only 5 guesses per account per 15 minutes. A global ceiling on
// failures backs it up against spraying one common password across many emails.
const LOCK_MAX = 5, LOCK_MS = 15 * 60e3;
const failsByEmail = new Map();               // email -> { n, until }
let globalFails = { n: 0, resetAt: 0 };
function lockedOut(email) {
  const e = failsByEmail.get(email), now = Date.now();
  if (now > globalFails.resetAt) globalFails = { n: 0, resetAt: now + 60e3 };
  return (e && e.n >= LOCK_MAX && now < e.until) || globalFails.n >= 200;
}
function noteFailure(email) {
  const now = Date.now();
  let e = failsByEmail.get(email);
  if (!e || now > e.until) e = { n: 0, until: now + LOCK_MS };
  e.n++; e.until = now + LOCK_MS; failsByEmail.set(email, e);
  if (failsByEmail.size > 20000) failsByEmail.clear();
  globalFails.n++;
}

// ─────────── storage: Supabase REST ───────────
async function sb(pathAndQuery, opts = {}) {
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (SB_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + SB_KEY;   // legacy JWT-style keys
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 10000);
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, { ...opts, headers, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${text.slice(0, 200)}`); e.status = r.status; e.body = text; throw e; }
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(t); }
}
// The dashboard functions / newer columns arrive with supabase-setup.sql. Until it has been
// re-run, fall back gracefully instead of failing.
const missingFn = e => e.status === 404 || /PGRST202|Could not find the function/i.test(e.body || e.message);
const missingCol = (e, col) => /PGRST204|42703/.test(e.body || '') && (e.body || '').includes(col);
let hasSourceCol = true;
const inList = ids => `(${ids.filter(id => ID_RE.test(id)).join(',')})`;
const sbStore = {
  async upsertVisits(rows) {
    for (let i = 0; i < rows.length; i += 500) {
      let chunk = rows.slice(i, i + 500);
      if (!hasSourceCol) chunk = chunk.map(({ source, ...r }) => r);
      try {
        await sb('visits?on_conflict=id', { method: 'POST', body: JSON.stringify(chunk),
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
      } catch (e) {
        if (!hasSourceCol || !missingCol(e, 'source')) throw e;
        hasSourceCol = false;                    // old schema: keep tracking, drop the campaign tag
        console.warn('[visitors] visits.source column missing — re-run supabase-setup.sql to record ?ref= tags');
        i -= 500;                                // retry this chunk without it
      }
    }
  },
  async visitSeen(vid, exceptSid) {
    const r = await sb(`visits?select=id&visitor_id=eq.${vid}&id=neq.${exceptSid}&limit=1`);
    return r.length > 0;
  },
  async overview(p) {
    return sb('rpc/mp_overview', { method: 'POST', timeoutMs: 20000, body: JSON.stringify({
      p_from: p.from, p_to: p.to, p_prev_from: p.prevFrom, p_include_me: p.includeMe, p_bucket: p.bucket }) });
  },
  async visitorList(p) {
    return sb('rpc/mp_visitor_list', { method: 'POST', timeoutMs: 20000, body: JSON.stringify({
      p_from: p.from, p_to: p.to, p_include_me: p.includeMe, p_limit: p.limit, p_offset: p.offset }) });
  },
  async visitsInRange({ from, to, owners, limit }) {
    const out = [], not = owners.length ? `&visitor_id=not.in.${inList(owners)}` : '';
    for (let off = 0; off < limit; off += 1000) {
      const page = await sb(`visits?select=*&started_at=gte.${encodeURIComponent(from)}&started_at=lt.${encodeURIComponent(to)}`
        + `${not}&order=started_at.desc&limit=${Math.min(1000, limit - off)}&offset=${off}`);
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  },
  async allVisits(maxRows) {        // fallback only (before the SQL functions exist)
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
  async updateHash(id, pass_hash) {
    await sb(`users?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ pass_hash }),
      headers: { Prefer: 'return=minimal' } });
  },
  async listUsers() {
    return sb('users?select=id,name,email,created_at,last_login&order=created_at.desc&limit=5000');
  },
  async labels() { return sb('visitor_labels?select=visitor_id,name,is_owner&limit=10000'); },
  async setLabel(row) {
    await sb('visitor_labels?on_conflict=visitor_id', { method: 'POST', body: JSON.stringify([row]),
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  },
};

// ─────────── storage: local JSON file (dev fallback) ───────────
const DATA_FILE = path.join(__dirname, '.data', 'visitors.json');
let fileDb = null, fileTimer = null;
function db() {
  if (!fileDb) {
    try { fileDb = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { fileDb = {}; }
    fileDb.visits = fileDb.visits || {}; fileDb.users = fileDb.users || []; fileDb.labels = fileDb.labels || {};
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
const fileVisits = () => Object.values(db().visits);
const fileLabels = () => new Map(Object.values(db().labels).map(l => [l.visitor_id, { name: l.name, owner: !!l.is_owner }]));
const fileOwners = () => new Set([...fileLabels()].filter(([, l]) => l.owner).map(([id]) => id));
const fileStore = {
  async upsertVisits(rows) { const d = db(); for (const r of rows) d.visits[r.id] = { ...d.visits[r.id], ...r }; saveSoon(); },
  async visitSeen(vid, exceptSid) { return fileVisits().some(v => v.visitor_id === vid && v.id !== exceptSid); },
  async overview(p) { return stats.overview(fileVisits(), fileOwners(), p); },
  async visitorList(p) { return stats.visitorList(fileVisits(), fileOwners(), fileLabels(), p); },
  async visitsInRange({ from, to, owners, limit }) {
    const F = Date.parse(from), T = Date.parse(to), own = new Set(owners);
    return fileVisits().filter(v => { const t = Date.parse(v.started_at); return t >= F && t < T && !own.has(v.visitor_id); })
      .sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).slice(0, limit);
  },
  async allVisits() { return fileVisits(); },
  async userByEmail(email) { return db().users.find(u => u.email === email) || null; },
  async createUser(u) {
    const d = db(), row = { id: (d.users.reduce((m, x) => Math.max(m, x.id), 0) + 1), created_at: new Date().toISOString(), last_login: null, ...u };
    d.users.push(row); saveSoon(); return row;
  },
  async touchLogin(id) { const u = db().users.find(x => x.id === id); if (u) { u.last_login = new Date().toISOString(); saveSoon(); } },
  async updateHash(id, pass_hash) { const u = db().users.find(x => x.id === id); if (u) { u.pass_hash = pass_hash; saveSoon(); } },
  async listUsers() {
    return db().users.map(({ pass_hash, ...rest }) => rest).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  },
  async labels() { return Object.values(db().labels); },
  async setLabel(row) { db().labels[row.visitor_id] = row; saveSoon(); },
};
const store = USE_SB ? sbStore : fileStore;

// ─────────── visitor details: IP → place (batched), user-agent → device ───────────
// ip-api.com (free, no key) allows 15 batch calls a minute of up to 100 IPs each, so lookups are
// queued and sent together — enough for ~1,500 new IPs a minute. Results are cached per IP; a
// failed lookup is retried a few minutes later (the visit row is updated when it lands).
const isPrivateIp = ip => !ip || isLoopback(ip) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|fc|fd|fe80)/i.test(ip);
const geoCache = new Map();      // ip -> { g, at, ok }
const geoWaiting = new Map();    // ip -> [resolve]
let geoTimer = null, geoLastRun = 0, geoPauseUntil = 0;
function geoLookup(ip) {
  if (isPrivateIp(ip)) return Promise.resolve({});
  const c = geoCache.get(ip);
  if (c && Date.now() - c.at < (c.ok ? 7 * 86400e3 : 3 * 60e3)) return Promise.resolve(c.g);
  return new Promise(resolve => {
    if (geoWaiting.has(ip)) geoWaiting.get(ip).push(resolve); else geoWaiting.set(ip, [resolve]);
    if (!geoTimer) geoTimer = setTimeout(runGeo, Math.max(800, geoLastRun + 4100 - Date.now(), geoPauseUntil - Date.now()));
  });
}
async function runGeo() {
  geoTimer = null; geoLastRun = Date.now();
  const ips = [...geoWaiting.keys()].slice(0, 100);
  let byIp = null;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch('http://ip-api.com/batch?fields=status,query,country,regionName,city,isp', {
      method: 'POST', body: JSON.stringify(ips), headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal });
    clearTimeout(t);
    const left = r.headers.get('x-rl'), ttl = +r.headers.get('x-ttl') || 60;
    if (r.status === 429 || left === '0') geoPauseUntil = Date.now() + ttl * 1000;
    if (r.ok) byIp = new Map((await r.json()).map(j => [j.query, j]));
  } catch { /* geo is best-effort */ }
  for (const ip of ips) {
    const j = byIp && byIp.get(ip), ok = !!(j && j.status === 'success');
    const g = ok ? { country: j.country || null, region: j.regionName || null, city: j.city || null, isp: j.isp || null } : {};
    geoCache.set(ip, { g, at: Date.now(), ok });
    (geoWaiting.get(ip) || []).forEach(f => f(g));
    geoWaiting.delete(ip);
  }
  if (geoCache.size > 20000) geoCache.clear();
  if (geoWaiting.size && !geoTimer) geoTimer = setTimeout(runGeo, Math.max(4100, geoPauseUntil - Date.now()));
}
function parseUA(ua) {
  ua = ua || '';
  const os = /Windows NT/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const device = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobi/.test(ua)) ? 'Tablet' : /Mobi|Android|iPhone/.test(ua) ? 'Mobile' : 'Desktop';
  const bot = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|quora link|pingdom|uptime/i.test(ua);
  return { os, browser, device, bot };
}

// ─────────── your own devices + names (table visitor_labels) ───────────
// Marking is stored on the server so every admin browser — and the new-visitor alert — agrees.
const LABELS = new Map();        // visitor_id -> { name, owner }
let labelsP = null, labelsLoaded = false, labelsError = null, labelsTried = 0;
function loadLabels() {
  if (labelsP) return labelsP;
  if (labelsLoaded || (labelsError && Date.now() - labelsTried < 60e3)) return Promise.resolve();
  labelsTried = Date.now();
  labelsP = store.labels().then(rows => {
    LABELS.clear();
    for (const r of rows || []) LABELS.set(r.visitor_id, { name: r.name || null, owner: !!r.is_owner });
    labelsError = null; labelsLoaded = true;
  }).catch(e => {
    labelsError = /visitor_labels|PGRST205|404/.test(e.message)
      ? 'The visitor_labels table is missing in Supabase. Re-run supabase-setup.sql (SQL Editor → paste → Run).'
      : e.message;
  }).finally(() => { labelsP = null; });
  return labelsP;
}
const isOwner = vid => !!(LABELS.get(vid) || {}).owner;
const ownerIds = () => [...LABELS].filter(([, l]) => l.owner).map(([id]) => id);
async function setLabel(vid, patch) {
  await loadLabels();
  const cur = LABELS.get(vid) || { name: null, owner: false };
  const next = { ...cur, ...patch };
  await store.setLabel({ visitor_id: vid, name: next.name, is_owner: next.owner, updated_at: new Date().toISOString() });
  LABELS.set(vid, next);
  statsCache.clear();
}

// ─────────── first-ever visit? ───────────
// "First visit" = this browser id has no earlier visit stored. Checked once per session with an
// indexed lookup; ids seen since boot are remembered so repeat checks cost nothing.
const seenVids = new Set();
const newChecks = new Map();     // vid -> Promise<boolean seenBefore>, shared by tabs opening at once
function seenBefore(vid, sid) {
  if (seenVids.has(vid)) return Promise.resolve(true);
  if (newChecks.has(vid)) return newChecks.get(vid).then(() => true);
  const p = store.visitSeen(vid, sid).catch(() => true)      // when unsure, call it returning
    .then(seen => { if (seenVids.size > 200000) seenVids.clear(); seenVids.add(vid); return seen; })
    .finally(() => newChecks.delete(vid));
  newChecks.set(vid, p);
  return p;
}
function publicOrigin(req) {
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

// ─────────── live sessions: kept in memory, flushed to storage in batches ───────────
// The browser sends its own running totals (start time, active seconds, pages seen), so a server
// restart loses nothing — the next ping simply rebuilds the in-memory record.
const live = new Map();          // sid -> visit row (only real table columns — it is upserted as-is)
const meta = new Map();          // sid -> { first: true if this is the browser's first-ever visit }
const geoBusy = new Set();       // sids with a place lookup in flight
const dirty = new Set();
const ID_RE = /^[a-z0-9]{8,40}$/i;
const SRC_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);

function fillGeo(sid, row, ip) {
  geoBusy.add(sid);
  return geoLookup(ip).then(g => {
    if (g.country || g.city) Object.assign(row, { country: g.country, region: g.region, city: g.city, isp: g.isp });
  }).finally(() => { geoBusy.delete(sid); dirty.add(sid); });
}

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
    const src = String(b.src || '').toLowerCase().slice(0, 40);
    row = {
      id: b.sid, visitor_id: b.vid, started_at: new Date(t0).toISOString(),
      ip, country: null, region: null, city: null, isp: null,
      device: ua.device, browser: ua.browser, os: ua.os,
      screen: clip(b.screen, 20), lang: clip(b.lang, 20), tz: clip(b.tz, 50), referrer: clip(b.ref, 300),
      source: SRC_RE.test(src) ? src : null,
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

  // A browser signed in to /admin is yours: remember it so it never counts as a visitor.
  if (isAdmin(req) && !isOwner(b.vid)) setLabel(b.vid, { owner: true }).catch(e => console.error('[visitors] auto-mark failed:', e.message));

  if (isNew) {
    // Decide "first-ever visit?" now, before this session is written; hold the first write until
    // the place lookup lands so a stored row never has blank geo overwriting good geo.
    meta.set(b.sid, { first: null });
    seenBefore(b.vid, b.sid).then(was => meta.set(b.sid, { first: !was }));
    fillGeo(b.sid, row, ip).catch(e => console.error('[visitors] place lookup failed:', e.message));
  } else {
    if (!row.country && !row.city && !isPrivateIp(ip) && !geoBusy.has(b.sid)) fillGeo(b.sid, row, ip);   // retry a failed lookup
    else dirty.add(b.sid);
  }
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
  for (const [id, r] of live) if (!dirty.has(id) && !geoBusy.has(id) && Date.parse(r.last_seen) < cutoff) { live.delete(id); meta.delete(id); }
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
      // strip control/zero-width characters so a name can't smuggle layout tricks into the admin view
      const name = String(b.name || '').replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
        .trim().replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 60) return sendJson(res, 400, { error: 'Enter your name (2–60 characters).' });
      const bad = passwordProblem(password, email);
      if (bad) return sendJson(res, 400, { error: bad });
      if (await store.userByEmail(email)) return sendJson(res, 409, { error: 'An account with this email already exists. Sign in instead.' });
      const u = await store.createUser({ name, email, pass_hash: await hashPassword(password), last_login: new Date().toISOString() });
      return sendJson(res, 200, { user: { name: u.name, email: u.email } }, { 'Set-Cookie': userCookie(req, u) });
    }
    if (action === 'login') {
      if (password.length > 128) return sendJson(res, 401, { error: 'Wrong email or password.' });
      if (lockedOut(email)) return sendJson(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
      const u = await store.userByEmail(email);
      const ok = await checkPassword(password, u ? u.pass_hash : DUMMY_HASH);   // same work either way
      if (!u || !ok) { noteFailure(email); return sendJson(res, 401, { error: 'Wrong email or password.' }); }
      failsByEmail.delete(email);
      store.touchLogin(u.id).catch(() => {});
      if (needsRehash(u.pass_hash))   // silently move older hashes up to the current cost
        hashPassword(password).then(h => store.updateHash(u.id, h)).catch(() => {});
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

// Periods are cut on Indian-time midnights. The comparison period is the same window shifted
// back by the period's length (today so far vs yesterday up to the same time, and so on).
const DAY = 86400e3;
const istMidnight = t => Math.floor((t + IST_MS) / DAY) * DAY - IST_MS;
const RANGES = {
  today:     { label: 'Today',        days: 1,  bucket: 'hour', from: n => istMidnight(n),               to: n => n },
  yesterday: { label: 'Yesterday',    days: 1,  bucket: 'hour', from: n => istMidnight(n) - DAY,         to: n => istMidnight(n) },
  '7d':      { label: 'Last 7 days',  days: 7,  bucket: 'day',  from: n => istMidnight(n) - 6 * DAY,     to: n => n },
  '30d':     { label: 'Last 30 days', days: 30, bucket: 'day',  from: n => istMidnight(n) - 29 * DAY,    to: n => n },
  '90d':     { label: 'Last 90 days', days: 90, bucket: 'day',  from: n => istMidnight(n) - 89 * DAY,    to: n => n },
  all:       { label: 'All time',     days: 0,  bucket: 'day',  from: () => Date.parse('2020-01-01T00:00:00Z'), to: n => n },
};
function rangeOf(key, now = Date.now()) {
  const k = RANGES[key] ? key : '7d', R = RANGES[k];
  const from = R.from(now), to = R.to(now), shift = R.days * DAY;
  const iso = t => new Date(t).toISOString();
  return { key: k, label: R.label, bucket: R.bucket, from: iso(from), to: iso(to),
    prevFrom: shift ? iso(from - shift) : null, prevTo: shift ? iso(to - shift) : null };
}

const FALLBACK_MAX = 50000;      // before the SQL functions exist, stats come from the newest N visits
// Every row the dashboard shows carries: is it you, its name, and a readable "came from".
const cameOf = (r, ownHost) => stats.channelOf(r.source, stats.refHost(r.referrer), ownHost);
const tagRow = (r, ownHost) => ({ ...r, owner: isOwner(r.visitor_id), label: (LABELS.get(r.visitor_id) || {}).name || null,
  came: cameOf(r, ownHost) });
const ownHostOf = req => { try { return new URL(publicOrigin(req)).host; } catch { return ''; } };

// Overview + first page of visitors for a period, from the database functions when available.
async function periodStats(r, includeMe) {
  const p = { from: r.from, to: r.to, prevFrom: r.prevFrom, prevTo: r.prevTo, includeMe, bucket: r.bucket };
  try {
    const [ov, list] = await Promise.all([store.overview(p), store.visitorList({ ...p, limit: 60, offset: 0 })]);
    return { ov, list, engine: USE_SB ? 'database' : 'local', partial: false };
  } catch (e) {
    if (!(USE_SB && missingFn(e))) throw e;
    const rows = await store.allVisits(FALLBACK_MAX), own = new Set(ownerIds());
    return { ov: stats.overview(rows, own, p), list: stats.visitorList(rows, own, LABELS, { ...p, limit: 60, offset: 0 }),
      engine: 'fallback', partial: rows.length >= FALLBACK_MAX, rows };
  }
}
async function moreVisitors(r, includeMe, offset, limit) {
  const p = { from: r.from, to: r.to, includeMe, limit, offset };
  try { return await store.visitorList(p); }
  catch (e) {
    if (!(USE_SB && missingFn(e))) throw e;
    return stats.visitorList(await store.allVisits(FALLBACK_MAX), new Set(ownerIds()), LABELS, p);
  }
}

// People on the site right now (pinged in the last 2 minutes), one entry per browser.
function liveNow(includeMe, ownHost) {
  const now = Date.now(), byVid = new Map();
  for (const [sid, r] of live) {
    if (now - Date.parse(r.last_seen) >= LIVE_WINDOW_MS || (!includeMe && isOwner(r.visitor_id))) continue;
    const cur = byVid.get(r.visitor_id), tabs = (cur ? cur.tabs : 0) + 1;
    if (!cur || r.started_at > cur.started_at) byVid.set(r.visitor_id, { ...tagRow(r, ownHost), first_visit: (meta.get(sid) || {}).first ?? null, tabs });
    else cur.tabs = tabs;
  }
  return [...byVid.values()].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
}

const statsCache = new Map();    // "range|includeMe" -> { at, data }; 15 s is plenty for a 30 s auto-refresh
async function adminStats(rangeKey, includeMe, fresh, req) {
  const r = rangeOf(rangeKey), key = r.key + '|' + includeMe, hit = statsCache.get(key);
  let data = hit && !fresh && Date.now() - hit.at < 15e3 ? hit.data : null;
  if (!data) {
    await flush(); await loadLabels();
    const ownHost = ownHostOf(req);
    const [{ ov, list, engine, partial }, users, recent] = await Promise.all([
      periodStats(r, includeMe), store.listUsers(),
      store.visitsInRange({ from: r.from, to: r.to, owners: includeMe ? [] : ownerIds(), limit: 100 })]);
    const perUser = new Map((ov.users || []).map(u => [u.user_id, u]));
    data = {
      storage: USE_SB ? 'supabase' : 'local-file', engine, partial, range: r,
      kpi: { cur: ov.cur, prev: ov.prev, alltime: ov.alltime },
      series: ov.series, channels: stats.channels(ov.sources || [], ownHost),
      places: ov.places, devices: ov.devices, os: ov.os, sections: ov.sections,
      visitors: list.map(v => ({ ...v, came: cameOf(v, ownHost) })), recent: recent.map(v => tagRow(v, ownHost)),
      users: users.map(u => ({ ...u, visits: (perUser.get(u.id) || {}).visits || 0, secs: (perUser.get(u.id) || {}).secs || 0 })),
      tracksSource: !USE_SB || hasSourceCol,
    };
    statsCache.set(key, { at: Date.now(), data });
    if (statsCache.size > 40) statsCache.clear();
  }
  return { ...data, generatedAt: new Date().toISOString(), live: liveNow(includeMe, ownHostOf(req)), yourIp: clientIp(req),
    owners: ownerIds().length, labelsError };
}

// ─────────── CSV downloads ───────────
// Cells that start with = + - @ are prefixed with ' so a spreadsheet never runs visitor-supplied
// text (a referrer, a name) as a formula.
function csvCell(v) {
  if (v == null) return '';
  let s = Array.isArray(v) ? v.join(' ') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const istStamp = t => (t ? new Date(Date.parse(t) + IST_MS).toISOString().replace('T', ' ').slice(0, 19) : '');
function sendCsv(res, filename, header, rows) {
  const body = '\uFEFF' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';   // BOM: Excel reads UTF-8
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
async function handleExport(req, res, query) {
  await flush(); await loadLabels();
  const r = rangeOf(query.get('range')), includeMe = query.get('include_me') === '1', table = query.get('table');
  const stamp = `${r.key}-${istStamp(new Date().toISOString()).slice(0, 10)}`;
  const yes = b => (b ? 'yes' : 'no'), ownHost = ownHostOf(req);
  if (table === 'visits') {
    const rows = await store.visitsInRange({ from: r.from, to: r.to, owners: includeMe ? [] : ownerIds(), limit: 50000 });
    return sendCsv(res, `marketpulse-visits-${stamp}.csv`,
      ['Started (IST)', 'Last seen (IST)', 'Active seconds', 'Sections opened', 'Visitor ID', 'Visitor name', 'Your device',
        'Came from', 'Link tag', 'Referrer', 'City', 'Region', 'Country', 'Internet provider', 'IP', 'Device', 'OS', 'Browser', 'Screen',
        'Language', 'Time zone', 'Account name', 'Account email'],
      rows.map(v => { const t = tagRow(v, ownHost); return [istStamp(v.started_at), istStamp(v.last_seen), v.duration_sec || 0, v.pages, v.visitor_id,
        t.label, yes(t.owner), t.came.label, v.source, v.referrer, v.city, v.region, v.country, v.isp, v.ip, v.device, v.os, v.browser, v.screen,
        v.lang, v.tz, v.user_name, v.user_email]; }));
  }
  if (table === 'visitors') {
    const out = [];
    for (let off = 0; off < 10000; off += 500) {
      const page = await moreVisitors(r, includeMe, off, 500);
      out.push(...page);
      if (page.length < 500) break;
    }
    return sendCsv(res, `marketpulse-visitors-${stamp}.csv`,
      ['Visitor ID', 'Name', 'Your device', 'Visits (all time)', 'Active time, seconds (all time)', 'First visit (IST)',
        'Last seen (IST)', 'Last active in period (IST)', 'City', 'Region', 'Country', 'Internet provider', 'IP', 'Device', 'OS',
        'Browser', 'Screen', 'First came from', 'First link tag', 'First referrer', 'Sections opened (all time)', 'Account name', 'Account email'],
      out.map(v => [v.visitor_id, v.label, yes(v.owner), v.visits, v.total_sec, istStamp(v.first_seen), istStamp(v.last_seen),
        istStamp(v.active_at), v.city, v.region, v.country, v.isp, v.ip, v.device, v.os, v.browser, v.screen, cameOf(v, ownHost).label, v.source, v.referrer,
        v.pages, v.name, v.email]));
  }
  if (table === 'accounts') {
    const s = await adminStats(r.key, includeMe, false, req);
    return sendCsv(res, `marketpulse-accounts-${istStamp(new Date().toISOString()).slice(0, 10)}.csv`,
      ['Name', 'Email', 'Signed up (IST)', 'Last sign-in (IST)', 'Visits (all time)', 'Active time, seconds (all time)'],
      s.users.map(u => [u.name, u.email, istStamp(u.created_at), istStamp(u.last_login), u.visits, u.secs]));
  }
  return sendJson(res, 400, { error: 'Unknown table.' });
}

async function handleAdmin(req, res, action, query) {
  if (action === 'login') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
    if (!ADMIN_PASSWORD) return sendJson(res, 400, { error: 'Set ADMIN_PASSWORD on the server to enable remote admin login.' });
    if (authLimited(clientIp(req))) return sendJson(res, 429, { error: 'Too many attempts. Wait a minute.' });
    let b; try { b = await readBody(req); } catch { return sendJson(res, 400, { error: 'Bad request.' }); }
    if (lockedOut('\u0000admin')) return sendJson(res, 429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
    if (!safeEqual(b.password || '', ADMIN_PASSWORD)) { noteFailure('\u0000admin'); return sendJson(res, 401, { error: 'Wrong password.' }); }
    failsByEmail.delete('\u0000admin');
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, 'mp_a', sign({ k: 'a', x: Date.now() + ADMIN_TTL_SEC * 1000 }), ADMIN_TTL_SEC) });
  }
  if (action === 'logout') return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, 'mp_a', '', 0) });
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Sign in required.', passwordSet: !!ADMIN_PASSWORD });
  const fail = (e, what) => {
    console.error(`[visitors] ${what} error:`, e.message);
    return sendJson(res, 503, { error: 'Could not read the analytics store: ' + e.message });
  };

  if (action === 'stats') {
    try { return sendJson(res, 200, await adminStats(query.get('range'), query.get('include_me') === '1', query.get('fresh') === '1', req)); }
    catch (e) { return fail(e, 'stats'); }
  }
  if (action === 'visitors') {
    const offset = Math.max(0, Math.min(100000, parseInt(query.get('offset'), 10) || 0));
    try {
      await loadLabels();
      const list = await moreVisitors(rangeOf(query.get('range')), query.get('include_me') === '1', offset, 60), ownHost = ownHostOf(req);
      return sendJson(res, 200, { visitors: list.map(x => ({ ...x, came: cameOf(x, ownHost) })) });
    }
    catch (e) { return fail(e, 'visitors'); }
  }
  if (action === 'export') {
    try { return await handleExport(req, res, query); } catch (e) { return fail(e, 'export'); }
  }
  if (action === 'label') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
    let b; try { b = await readBody(req); } catch { return sendJson(res, 400, { error: 'Bad request.' }); }
    if (!ID_RE.test(b.visitor_id || '')) return sendJson(res, 400, { error: 'Bad visitor id.' });
    const patch = {};
    if (typeof b.owner === 'boolean') patch.owner = b.owner;
    if (typeof b.name === 'string' || b.name === null) patch.name = b.name ? b.name.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').trim().slice(0, 40) || null : null;
    try { await setLabel(b.visitor_id, patch); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 503, { error: /visitor_labels|PGRST205|404/.test(e.message) ? 'The visitor_labels table is missing in Supabase. Re-run supabase-setup.sql.' : e.message }); }
  }
  return sendJson(res, 404, { error: 'Not found.' });
}

// ─────────── router entry: returns true when it handled the request ───────────
async function handle(req, res, u) {
  const p = u.pathname;
  if (p === '/api/t' && req.method === 'POST') { await handleTrack(req, res, currentUser(req)); return true; }
  if (p.startsWith('/api/auth/')) { await handleAuth(req, res, p.slice('/api/auth/'.length)); return true; }
  if (p.startsWith('/api/admin/')) { await handleAdmin(req, res, p.slice('/api/admin/'.length), u.searchParams); return true; }
  if (p === '/admin' || p === '/admin/') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex',
      'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(fs.readFileSync(path.join(__dirname, 'admin.html')));
    return true;
  }
  return false;
}

// Safe diagnostic: the key's KIND and length only, never its contents.
if (USE_SB) {
  const kind = SB_KEY.startsWith('sb_secret_') ? 'sb_secret (correct)'
    : SB_KEY.startsWith('sb_publishable_') ? 'sb_publishable (WRONG — use the Secret key)'
    : SB_KEY.startsWith('eyJ') ? 'legacy JWT' : 'unrecognised format (re-copy the Secret key)';
  console.log(`[visitors] storage: Supabase ${SB_URL} · key type: ${kind} · length ${SB_KEY.length}`);
}
if (!USE_SB) console.log('[visitors] storage: local file .data/visitors.json (set SUPABASE_URL + SUPABASE_SERVICE_KEY for permanent storage)');
if (!ADMIN_PASSWORD) console.log('[visitors] ADMIN_PASSWORD not set — /admin is open to localhost only');
loadLabels();

module.exports = { handle, flush, parseUA, hashPassword, checkPassword, sign, verify };
