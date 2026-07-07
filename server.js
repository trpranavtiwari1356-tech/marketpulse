// MarketPulse local data server
// Proxies Yahoo Finance (free, no API key) server-side to bypass browser CORS,
// and computes 20 & 200 SMA on the exact candle interval requested.
// Run: node server.js   ->   http://localhost:5173

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 5173;   // override with PORT=xxxx to run a second instance
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ─────────── stock master list (sym, name, sector, tier) ───────────
// tier = smallest broad index the name belongs to (50/100/200/500) → drives universe filters.
// Tickers default to sym+'.NS'; overrides handled below for special symbols.
const TICKER_OVERRIDE = { 'M&M': 'M&M.NS', 'TATAMOTORS': 'TMCV.NS' };
// `STOCKS` starts as this curated seed but is REPLACED at startup with the live, official
// NSE index constituents (see loadConstituents below). The seed is the offline fallback.
let STOCKS = [
  // ---- Nifty 50 (tier 50) ----
  ['RELIANCE','Reliance Industries','Energy',50], ['HDFCBANK','HDFC Bank','Banking',50],
  ['TCS','Tata Consultancy','IT',50], ['BHARTIARTL','Bharti Airtel','Telecom',50],
  ['ICICIBANK','ICICI Bank','Banking',50], ['INFY','Infosys','IT',50],
  ['SBIN','State Bank','Banking',50], ['HINDUNILVR','HUL','FMCG',50],
  ['ITC','ITC Ltd','FMCG',50], ['LT','Larsen & Toubro','Infra',50],
  ['KOTAKBANK','Kotak Mahindra','Banking',50], ['AXISBANK','Axis Bank','Banking',50],
  ['BAJFINANCE','Bajaj Finance','NBFC',50], ['M&M','Mahindra & Mahindra','Auto',50],
  ['MARUTI','Maruti Suzuki','Auto',50], ['SUNPHARMA','Sun Pharma','Pharma',50],
  ['NTPC','NTPC Ltd','Power',50], ['HCLTECH','HCL Tech','IT',50],
  ['TITAN','Titan Company','Jewellery',50], ['ULTRACEMCO','UltraTech','Cement',50],
  ['ASIANPAINT','Asian Paints','Paints',50], ['ADANIENT','Adani Ent','Conglomerate',50],
  ['ADANIPORTS','Adani Ports','Infrastructure',50], ['POWERGRID','Power Grid','Power',50],
  ['WIPRO','Wipro Ltd','IT',50], ['ONGC','ONGC Ltd','Energy',50],
  ['TATAMOTORS','Tata Motors','Auto',50], ['JSWSTEEL','JSW Steel','Metal',50],
  ['COALINDIA','Coal India','Mining',50], ['NESTLEIND','Nestle India','FMCG',50],
  ['BAJAJFINSV','Bajaj Finserv','NBFC',50], ['TATASTEEL','Tata Steel','Metal',50],
  ['TRENT','Trent Ltd','Retail',50], ['SBILIFE','SBI Life','Insurance',50],
  ['GRASIM','Grasim','Cement',50], ['HDFCLIFE','HDFC Life','Insurance',50],
  ['TECHM','Tech Mahindra','IT',50], ['HINDALCO','Hindalco','Metal',50],
  ['CIPLA','Cipla Ltd','Pharma',50], ['DRREDDY',"Dr Reddy's",'Pharma',50],
  ['BEL','Bharat Electronics','Defence',50], ['EICHERMOT','Eicher Motors','Auto',50],
  ['BAJAJ-AUTO','Bajaj Auto','Auto',50], ['BRITANNIA','Britannia','FMCG',50],
  ['APOLLOHOSP','Apollo Hosp','Healthcare',50], ['INDUSINDBK','IndusInd Bank','Banking',50],
  ['SHRIRAMFIN','Shriram Finance','NBFC',50], ['HEROMOTOCO','Hero Moto','Auto',50],
  ['BPCL','BPCL','Energy',50], ['TATACONSUM','Tata Consumer','FMCG',50],
  // ---- Nifty Next 50 / Nifty 100 (tier 100) ----
  ['DMART','Avenue Supermarts','Retail',100], ['LICI','LIC of India','Insurance',100],
  ['DIVISLAB',"Divi's Lab",'Pharma',100], ['PIDILITIND','Pidilite','Chemicals',100],
  ['ADANIGREEN','Adani Green Energy','Power',100], ['ADANIPOWER','Adani Power','Power',100],
  ['VEDL','Vedanta','Metal',100], ['IOC','Indian Oil','Energy',100],
  ['PFC','Power Finance Corp','NBFC',100], ['RECLTD','REC Ltd','NBFC',100],
  ['GAIL','GAIL India','Energy',100], ['DABUR','Dabur India','FMCG',100],
  ['GODREJCP','Godrej Consumer','FMCG',100], ['SIEMENS','Siemens','Capital Goods',100],
  ['HAL','Hindustan Aeronautics','Defence',100], ['AMBUJACEM','Ambuja Cements','Cement',100],
  ['DLF','DLF Ltd','Realty',100], ['ZYDUSLIFE','Zydus Lifesciences','Pharma',100],
  ['TORNTPHARM','Torrent Pharma','Pharma',100], ['BANKBARODA','Bank of Baroda','Banking',100],
  ['PNB','Punjab National Bank','Banking',100], ['CHOLAFIN','Cholamandalam','NBFC',100],
  ['ICICIPRULI','ICICI Pru Life','Insurance',100], ['ICICIGI','ICICI Lombard','Insurance',100],
  ['SBICARD','SBI Cards','NBFC',100], ['HAVELLS','Havells India','Capital Goods',100],
  ['NAUKRI','Info Edge','Internet',100], ['MOTHERSON','Samvardhana Motherson','Auto',100],
  ['TVSMOTOR','TVS Motor','Auto',100], ['JINDALSTEL','Jindal Steel','Metal',100],
  ['VBL','Varun Beverages','FMCG',100], ['BERGEPAINT','Berger Paints','Paints',100],
  ['MARICO','Marico','FMCG',100], ['COLPAL','Colgate-Palmolive','FMCG',100],
  ['UNITDSPR','United Spirits','FMCG',100], ['LUPIN','Lupin','Pharma',100],
  ['MUTHOOTFIN','Muthoot Finance','NBFC',100], ['NMDC','NMDC Ltd','Mining',100],
  ['IRCTC','Indian Railway Catering','Travel',100], ['IRFC','Indian Railway Finance','NBFC',100],
  ['INDIGO','InterGlobe Aviation','Aviation',100], ['POLYCAB','Polycab India','Capital Goods',100],
  ['CGPOWER','CG Power','Capital Goods',100], ['SHREECEM','Shree Cement','Cement',100],
  ['INDHOTEL','Indian Hotels','Hospitality',100], ['ETERNAL','Eternal (Zomato)','Internet',100],
  ['TATAPOWER','Tata Power','Power',100], ['SAIL','SAIL','Metal',100],
  // ---- Nifty 200 (tier 200) ----
  ['LTIM','LTIMindtree','IT',200], ['PERSISTENT','Persistent Systems','IT',200],
  ['COFORGE','Coforge','IT',200], ['MPHASIS','Mphasis','IT',200],
  ['OFSS','Oracle Fin Services','IT',200], ['ABB','ABB India','Capital Goods',200],
  ['BHEL','Bharat Heavy Electricals','Capital Goods',200], ['IDEA','Vodafone Idea','Telecom',200],
  ['YESBANK','Yes Bank','Banking',200], ['BANDHANBNK','Bandhan Bank','Banking',200],
  ['AUBANK','AU Small Finance','Banking',200], ['FEDERALBNK','Federal Bank','Banking',200],
  ['IDFCFIRSTB','IDFC First Bank','Banking',200], ['CANBK','Canara Bank','Banking',200],
  ['UNIONBANK','Union Bank','Banking',200], ['JUBLFOOD','Jubilant FoodWorks','FMCG',200],
  ['PAGEIND','Page Industries','Textiles',200], ['BIOCON','Biocon','Pharma',200],
  ['ALKEM','Alkem Labs','Pharma',200], ['MANKIND','Mankind Pharma','Pharma',200],
  ['ASHOKLEY','Ashok Leyland','Auto',200], ['BALKRISIND','Balkrishna Inds','Auto',200],
  ['MRF','MRF Ltd','Auto',200], ['APOLLOTYRE','Apollo Tyres','Auto',200],
  ['NHPC','NHPC Ltd','Power',200], ['TATACOMM','Tata Communications','Telecom',200],
  ['OBEROIRLTY','Oberoi Realty','Realty',200], ['GODREJPROP','Godrej Properties','Realty',200],
  ['LODHA','Lodha (Macrotech)','Realty',200], ['PRESTIGE','Prestige Estates','Realty',200],
  ['PETRONET','Petronet LNG','Energy',200], ['IGL','Indraprastha Gas','Energy',200],
  ['TATAELXSI','Tata Elxsi','IT',200], ['GLENMARK','Glenmark Pharma','Pharma',200],
  // ---- Nifty 500 extras (tier 500) ----
  ['DIXON','Dixon Technologies','Electronics',500], ['KPITTECH','KPIT Technologies','IT',500],
  ['HONAUT','Honeywell Automation','Capital Goods',500], ['KEI','KEI Industries','Capital Goods',500],
  ['ASTRAL','Astral Ltd','Building Mat',500], ['SUPREMEIND','Supreme Industries','Building Mat',500],
  ['SRF','SRF Ltd','Chemicals',500], ['DEEPAKNTR','Deepak Nitrite','Chemicals',500],
  ['PIIND','PI Industries','Chemicals',500], ['AARTIIND','Aarti Industries','Chemicals',500],
  ['BSOFT','Birlasoft','IT',500], ['CYIENT','Cyient','IT',500],
  ['SONACOMS','Sona BLW','Auto',500], ['EXIDEIND','Exide Industries','Auto',500],
  ['ESCORTS','Escorts Kubota','Auto',500], ['NYKAA','FSN E-Commerce (Nykaa)','Internet',500],
  ['PAYTM','One97 (Paytm)','Fintech',500], ['POLICYBZR','PB Fintech (Policybazaar)','Fintech',500],
  ['DELHIVERY','Delhivery','Logistics',500], ['IEX','Indian Energy Exchange','Financials',500],
  ['CDSL','Central Depository','Financials',500], ['BSE','BSE Ltd','Financials',500],
  ['ANGELONE','Angel One','Financials',500], ['HUDCO','HUDCO','NBFC',500],
  ['RVNL','Rail Vikas Nigam','Infra',500], ['MAZDOCK','Mazagon Dock','Defence',500],
  ['MGL','Mahanagar Gas','Energy',500], ['TATATECH','Tata Technologies','IT',500],
].map(([sym, name, sector, tier]) => ({ sym, yh: TICKER_OVERRIDE[sym] || (sym + '.NS'), name, sector, tier }));

// Bank Nifty / Nifty IT membership (filled from the official NSE lists; seeded from the fallback)
let BANK_SET = new Set(STOCKS.filter(s => s.sector === 'Banking').map(s => s.sym));
let IT_SET   = new Set(STOCKS.filter(s => s.sector === 'IT').map(s => s.sym));

// ─────────── tiny persistent JSON cache on disk (survives restarts) ───────────
const CACHE_DIR = path.join(__dirname, '.cache');
function cacheLoad(name) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, name + '.json'), 'utf8')); }
  catch (e) { return {}; }
}
function cacheSave(name, obj) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, name + '.json'), JSON.stringify(obj)); }
  catch (e) { /* cache is best-effort */ }
}

// ─────────── official NSE index constituents (real Nifty 50/100/200/500, Bank, IT) ───────────
const NSE_LISTS = { 50: 'ind_nifty50list', 100: 'ind_nifty100list', 200: 'ind_nifty200list',
                    500: 'ind_nifty500list', bank: 'ind_niftybanklist', it: 'ind_niftyitlist' };
async function fetchNseList(name) {
  for (const host of ['archives.nseindia.com', 'www1.nseindia.com']) {
    try {
      const r = await fetch(`https://${host}/content/indices/${name}.csv`,
        { headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*', 'Referer': 'https://www.nseindia.com/' } });
      if (!r.ok) continue;
      const txt = await r.text();
      // header: Company Name,Industry,Symbol,Series,ISIN Code — parse from the END so commas in names are safe
      const rows = txt.trim().split(/\r?\n/).slice(1).map(line => {
        const p = line.split(',');
        p.pop();                                   // ISIN
        p.pop();                                   // Series
        const symbol = (p.pop() || '').trim();
        const industry = (p.pop() || '').trim();
        const nm = p.join(',').trim().replace(/^"|"$/g, '');
        return { symbol, name: nm, sector: industry };
      }).filter(x => x.symbol && /^[A-Z0-9&.-]+$/.test(x.symbol));
      if (rows.length) return rows;
    } catch (e) { /* try next host */ }
  }
  return null;
}
async function loadConstituents() {
  const [l50, l100, l200, l500, lbank, lit] = await Promise.all(
    [NSE_LISTS[50], NSE_LISTS[100], NSE_LISTS[200], NSE_LISTS[500], NSE_LISTS.bank, NSE_LISTS.it].map(fetchNseList));
  if (!l500 || l500.length < 100) return false;     // need the 500 list to proceed
  const setOf = arr => new Set((arr || []).map(x => x.symbol));
  const s50 = setOf(l50), s100 = setOf(l100), s200 = setOf(l200);
  const built = l500.map(x => ({
    sym: x.symbol, yh: TICKER_OVERRIDE[x.symbol] || (x.symbol + '.NS'), name: x.name, sector: x.sector,
    tier: s50.has(x.symbol) ? 50 : s100.has(x.symbol) ? 100 : s200.has(x.symbol) ? 200 : 500,
  }));
  STOCKS = built;
  if (lbank && lbank.length) BANK_SET = setOf(lbank);
  if (lit && lit.length)     IT_SET   = setOf(lit);
  cacheSave('constituents', { at: Date.now(), stocks: built, bank: [...BANK_SET], it: [...IT_SET] });
  console.log(`NSE constituents loaded: ${built.length} names (Nifty 500), ${BANK_SET.size} Bank, ${IT_SET.size} IT`);
  return true;
}

// ─────────── timeframe → Yahoo interval + lookback range ───────────
// Range chosen so each interval has >= 200 candles for a true 200-period MA.
const TF_MAP = {
  '2 Min':  {interval:'2m',  range:'5d'},
  '5 Min':  {interval:'5m',  range:'1mo'},
  '15 Min': {interval:'15m', range:'1mo'},
  '1 Hour': {interval:'60m', range:'3mo'},
  '1 Day':  {interval:'1d',  range:'2y'},
  '1 Week': {interval:'1wk', range:'10y'},
};

// ─────────── Yahoo chart fetch (no key, no crumb needed) ───────────
async function yahooChart(ticker, interval, range) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false&events=split`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      if (res && res.indicators) return res;
    } catch (e) { /* try next host */ }
  }
  return null;
}

function sma(arr, period) {
  if (!arr || arr.length < period) return null;
  let s = 0;
  for (let i = arr.length - period; i < arr.length; i++) s += arr[i];
  return s / period;
}
function ema(arr, period) {
  if (!arr || arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += arr[i];   // seed with SMA of first `period`
  e /= period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}
function movingAvg(arr, period, type) { return type === 'ema' ? ema(arr, period) : sma(arr, period); }
// parse the requested MA config: type (sma|ema) + up to 3 lengths
function parseMaConfig(matype, mas) {
  const type = matype === 'ema' ? 'ema' : 'sma';
  let lens = String(mas || '20,200').split(',').map(x => parseInt(x, 10)).filter(n => n >= 2 && n <= 400);
  if (!lens.length) lens = [20, 200];
  return { type, lens: lens.slice(0, 3) };
}
// compute the MA set for a closes series at the latest price
function computeMas(closes, price, cfg) {
  return cfg.lens.map(len => {
    const v = movingAvg(closes, len, cfg.type);
    return { len, type: cfg.type, value: v == null ? null : +v.toFixed(2), above: v == null ? null : price >= v };
  });
}

// Yahoo's split feed sometimes lists a split that is ALREADY baked into the raw `close`
// series — e.g. HDFCBANK's 2025 1:1 bonus appears as a 2:1 event, yet the raw prices are
// continuous across the ex-date. Applying it again double-adjusts (halves the pre-split
// history → fake low + phantom move). So keep only the splits the raw close actually
// reflects as a ~split-ratio discontinuity across the ex-date. TRENT (genuinely unadjusted
// raw) still gets adjusted; HDFCBANK's phantom split is skipped. No-split stocks: unchanged.
function effectiveSplits(res) {
  const splits = (res.events && res.events.splits) ? Object.values(res.events.splits) : [];
  if (!splits.length) return [];
  const ts = res.timestamp || [];
  const close = (res.indicators && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  return splits.filter(sp => {
    if (!sp.numerator || !sp.denominator) return false;
    const ratio = sp.numerator / sp.denominator;             // 2:1 → 2, 3:2 → 1.5
    if (ratio <= 1.001) return true;                          // reverse/odd split → trust the feed
    let bi = -1;                                              // last bar strictly before the ex-date
    for (let i = 0; i < ts.length; i++) { if (ts[i] < sp.date) bi = i; else break; }
    const before = close[bi], after = close[bi + 1];
    if (bi < 0 || before == null || after == null || !after) return true;   // can't verify → trust feed
    const rawJump = before / after;                           // unadjusted ≈ ratio; already-adjusted ≈ 1
    return Math.abs(rawJump - ratio) / ratio < 0.25;          // raw shows the drop → we must adjust
  });
}
// Split-adjusted price series for any OHLC field (so values survive stock splits and
// match charting platforms, which are split-adjusted). Each historical bar is scaled by
// the product of (denominator/numerator) for every split that happened AFTER that bar.
function adjustedSeries(res, field) {
  const q = (res.indicators && res.indicators.quote[0]) || {};
  const raw = q[field] || [];
  const ts = res.timestamp || [];
  const splits = effectiveSplits(res);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (v == null || isNaN(v)) continue;
    let f = 1;
    if (splits.length) {
      for (const sp of splits) {
        if (sp.date > ts[i] && sp.numerator && sp.denominator) f *= sp.denominator / sp.numerator;
      }
    }
    out.push(v * f);
  }
  return out;
}
function adjustedCloses(res) { return adjustedSeries(res, 'close'); }

// Split-adjusted DAILY closes with the CURRENT session excluded by DATE. Yahoo's EOD daily
// bar can lag after the close (today's close = null while meta.regularMarketPrice is live);
// adjustedCloses silently drops the null bar, so index-based lookbacks like closes[len-2]
// shift one day too far back and a 1-day return becomes a 2-day return (caught live 04-Jul-26:
// HCLTECH showed +10.13% vs the official +5.65%). refCloses[len - lookback] is always the
// close exactly `lookback` sessions before the live price, whether or not today's bar exists.
function refCloses(res) {
  const ts = res.timestamp || [];
  const raw = ((res.indicators && res.indicators.quote[0]) || {}).close || [];
  const meta = res.meta || {};
  const liveDay = meta.regularMarketTime ? Math.floor(meta.regularMarketTime / 86400) : null;
  const splits = effectiveSplits(res);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (v == null || isNaN(v)) continue;
    if (liveDay != null && Math.floor(ts[i] / 86400) >= liveDay) continue;   // skip the live session's bar
    let f = 1;
    for (const sp of splits) if (sp.date > ts[i] && sp.numerator && sp.denominator) f *= sp.denominator / sp.numerator;
    out.push(v * f);
  }
  return out;
}

// Period return is measured over a trading-day lookback on the DAILY series
// (avoids Yahoo's forming weekly-bar quirk where week==day at week open).
// null => use the interval's own last-bar change (intraday frames).
const TF_RETURN_LOOKBACK = {
  '2 Min': null, '5 Min': null, '15 Min': null, '1 Hour': null,
  '1 Day': 1, '1 Week': 5,
};

// ─────────── compute one stock's trend snapshot ───────────
async function snapshot(stock, tf, cfg) {
  const { interval, range } = TF_MAP[tf] || TF_MAP['1 Day'];
  const res = await yahooChart(stock.yh, interval, range);
  if (!res) return { ...stock, error: true };
  const closes = adjustedCloses(res);   // split-adjusted
  if (closes.length < 2) return { ...stock, error: true };

  const meta = res.meta || {};
  const price = (meta.regularMarketPrice != null) ? meta.regularMarketPrice : closes[closes.length - 1];

  // configurable MA set (SMA/EMA, up to 3 lengths) on the selected interval's candles
  const mas = computeMas(closes, price, cfg);

  // period return
  let ret;
  const lb = TF_RETURN_LOOKBACK[tf];
  if (lb == null) {                                   // intraday: last interval bar's change
    const prev = closes[closes.length - 2];
    ret = prev ? ((price - prev) / prev) * 100 : 0;
  } else {                                            // day/week: rolling trading-day lookback
    // date-anchored: refCloses excludes the live session, so [len - lb] is exactly lb sessions back
    let refArr = null;
    if (interval === '1d') refArr = refCloses(res);
    else {                                            // weekly frame → fetch a short daily series
      const dres = await yahooChart(stock.yh, '1d', '3mo');
      if (dres) refArr = refCloses(dres);
    }
    const ref = (refArr && refArr.length >= lb) ? refArr[refArr.length - lb] : null;
    ret = ref ? ((price - ref) / ref) * 100 : 0;
  }

  return {
    sym: stock.sym, name: stock.name, sector: stock.sector,
    price: +price.toFixed(2), ret: +ret.toFixed(2),
    maType: cfg.type, mas,
    bars: closes.length,
  };
}

// concurrency-limited map so we don't hammer Yahoo
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

function universe(uni) {
  if (uni === 'Nifty IT')   return IT_SET.size   ? STOCKS.filter(s => IT_SET.has(s.sym))   : STOCKS.filter(s => /info(rmation)? tech|^IT$/i.test(s.sector));
  if (uni === 'Bank Nifty') return BANK_SET.size ? STOCKS.filter(s => BANK_SET.has(s.sym)) : STOCKS.filter(s => s.sector === 'Banking');
  if (uni === 'Nifty 50')   return STOCKS.filter(s => s.tier <= 50);
  if (uni === 'Nifty 100')  return STOCKS.filter(s => s.tier <= 100);
  if (uni === 'Nifty 200')  return STOCKS.filter(s => s.tier <= 200);
  if (uni === 'Nifty 500')  return STOCKS;   // the full, official Nifty 500
  if (uni === 'All Market') return STOCKS;   // entire universe we track
  return STOCKS.filter(s => s.tier <= 50);
}

// Resolve a user QUERY (NSE symbol OR free-text company name) to a known stock, RANKED so the
// most likely match wins. A plain .includes() returned the FIRST array hit, which silently
// picked the wrong company for a trading tool — "Infosys" resolved to MAPMYINDIA ("C.E. Info
// Systems"), "SBI" to SBICARD, "HDFC" to HDFCAMC. We score every candidate and keep the best.
// (Distinct from resolveStock(), which is a symbol-only lookup used on already-valid symbols.)
function resolveQuery(raw) {
  const up = (raw || '').toUpperCase().trim();
  if (!up) return null;
  // exact symbol / Yahoo-ticker match wins outright
  const exact = STOCKS.find(s => s.sym === up || s.yh === up || s.yh === up + '.NS');
  if (exact) return exact;
  const norm = up.replace(/[^A-Z0-9]/g, '');
  if (norm.length < 2) return null;
  let best = null, bestEff = 0;
  for (const s of STOCKS) {
    const nm = s.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const words = s.name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    let score = 0;
    if (nm === norm) score = 1000;                         // whole normalized name equals query
    else if (words.includes(norm)) score = 800;            // a whole word equals query ("Infosys")
    else if (s.sym.startsWith(norm)) score = 700;          // "SBI"→SBIN, "HDFC"→HDFCBANK
    else if (nm.startsWith(norm)) score = 600;
    else if (words.some(w => w.startsWith(norm))) score = 500;
    else if (nm.includes(norm)) score = 100;               // last-resort substring
    if (!score) continue;
    // tie-break: prefer the larger / more prominent name (lower tier), then the shorter name
    const eff = score * 1000 - (s.tier || 999) - nm.length / 1000;
    if (eff > bestEff) { bestEff = eff; best = s; }
  }
  return best;
}

// ─────────── top gainers / losers (by period return) ───────────
const MOVER_LOOKBACK = { daily: 1, weekly: 5, monthly: 21 };   // trading-day lookback
async function moverSnap(stock, lookback) {
  const res = await yahooChart(stock.yh, '1d', '6mo');   // one daily fetch covers day/week/month
  if (!res) return { ...stock, error: true };
  const closes = adjustedCloses(res);                    // split-adjusted
  if (closes.length < lookback + 1) return { ...stock, error: true };
  const meta = res.meta || {};
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : closes[closes.length - 1];
  // date-anchored lookback (refCloses excludes the live session — see its comment)
  const refArr = refCloses(res);
  const ref = refArr.length >= lookback ? refArr[refArr.length - lookback] : null;
  const ret = ref ? ((price - ref) / ref) * 100 : 0;
  return { sym: stock.sym, name: stock.name, sector: stock.sector, price: +price.toFixed(2), ret: +ret.toFixed(2) };
}
// Persistent, stale-while-revalidate cache: a cached result is served INSTANTLY (even if a
// little stale) while a fresh scan runs in the background — so users only ever wait on a
// truly cold (never-seen) universe, and even that survives restarts via disk.
const MOVERS_TTL = 5 * 60e3;
const _movers = cacheLoad('movers').map || {};       // 'uni|period' -> { at, data }
const _moversInflight = {};
async function refreshMovers(uni, period) {
  const key = uni + '|' + period;
  if (_moversInflight[key]) return _moversInflight[key];
  const job = (async () => {
    const lb = MOVER_LOOKBACK[period] || 1;
    const snaps = (await pool(universe(uni), 12, s => moverSnap(s, lb))).filter(s => !s.error && isFinite(s.ret));
    if (!snaps.length) throw new Error('no data');
    // sign-partitioned so a name can never appear in BOTH columns (small universes like
    // Nifty IT / Bank Nifty have <20 names, where slice(0,10)/slice(-10) overlapped).
    const gainers = snaps.filter(s => s.ret > 0).sort((a, b) => b.ret - a.ret).slice(0, 10);
    const losers  = snaps.filter(s => s.ret < 0).sort((a, b) => a.ret - b.ret).slice(0, 10);
    const data = { uni, period, count: snaps.length, gainers, losers, asOf: new Date().toISOString() };
    _movers[key] = { at: Date.now(), data };
    cacheSave('movers', { map: _movers });
    return data;
  })().finally(() => { delete _moversInflight[key]; });
  _moversInflight[key] = job;
  return job;
}
async function topMovers(uni, period) {
  const entry = _movers[uni + '|' + period];
  if (entry) {
    if (Date.now() - entry.at > MOVERS_TTL) refreshMovers(uni, period).catch(() => {});   // revalidate in bg
    return entry.data;                                                                     // serve instantly
  }
  return refreshMovers(uni, period);                                                        // cold → wait once
}

// ─────────── all-time highs / lows (full split-adjusted history) ───────────
async function extremeSnap(stock) {
  const res = await yahooChart(stock.yh, '1wk', 'max');   // weekly bars over the whole history
  if (!res) return { ...stock, error: true };
  // True all-time high/low = highest intraday HIGH / lowest intraday LOW ever traded
  // (what TradingView shows) — NOT the highest/lowest weekly close, which understates the
  // ATH and overstates the ATL by ~1-3%. A weekly bar's high/low already captures the
  // intra-week extreme, so weekly granularity is fine.
  const highs  = adjustedSeries(res, 'high').filter(v => v > 0 && isFinite(v));
  const lows   = adjustedSeries(res, 'low').filter(v => v > 0 && isFinite(v));
  const closes = adjustedCloses(res).filter(v => v != null && isFinite(v));
  if (highs.length < 12 || lows.length < 12) return { ...stock, error: true };
  const meta = res.meta || {};
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : closes[closes.length - 1];
  // fold in today's live price + intraday range so a brand-new extreme made today counts
  const dayHigh = (meta.regularMarketDayHigh > 0) ? meta.regularMarketDayHigh : 0;
  const dayLow  = (meta.regularMarketDayLow  > 0) ? meta.regularMarketDayLow  : Infinity;
  const ath = Math.max(price, dayHigh, ...highs);
  const atl = Math.min(price, dayLow,  ...lows);
  return { sym: stock.sym, name: stock.name, sector: stock.sector, price: +price.toFixed(2),
    ath: +ath.toFixed(2), atl: +atl.toFixed(2),
    fromHigh: +(((price - ath) / ath) * 100).toFixed(2),
    fromLow: +(((price - atl) / atl) * 100).toFixed(2),
    years: +(closes.length / 52).toFixed(1) };
}
const EXTREMES_TTL = 60 * 60e3;   // ATH/ATL move slowly
const _extremes = cacheLoad('extremes').map || {};   // uni -> { at, data }
const _extremesInflight = {};
async function refreshExtremes(uni) {
  if (_extremesInflight[uni]) return _extremesInflight[uni];
  const job = (async () => {
    const snaps = (await pool(universe(uni), 12, s => extremeSnap(s))).filter(s => !s.error);
    if (!snaps.length) throw new Error('no data');
    const data = { uni, count: snaps.length,
      ath: snaps.slice().sort((a, b) => b.fromHigh - a.fromHigh).slice(0, 10),   // nearest all-time high
      atl: snaps.slice().sort((a, b) => a.fromLow - b.fromLow).slice(0, 10),     // nearest all-time low
      asOf: new Date().toISOString() };
    _extremes[uni] = { at: Date.now(), data };
    cacheSave('extremes', { map: _extremes });
    return data;
  })().finally(() => { delete _extremesInflight[uni]; });
  _extremesInflight[uni] = job;
  return job;
}
async function topExtremes(uni) {
  const entry = _extremes[uni];
  if (entry) {
    if (Date.now() - entry.at > EXTREMES_TTL) refreshExtremes(uni).catch(() => {});   // revalidate in bg
    return entry.data;                                                                 // serve instantly
  }
  return refreshExtremes(uni);                                                          // cold → wait once
}

// ─────────── gap scanner (session open vs previous close) ───────────
// Aligned split-adjusted OHLC: one object per bar so open[i] / close[i-1] / high[i] / low[i]
// all reference the SAME session. (adjustedSeries filters each field independently and can
// desync if any single field has a stray null — for gap math we need strict per-bar alignment.)
function adjustedOHLC(res) {
  const q = (res.indicators && res.indicators.quote[0]) || {};
  const ts = res.timestamp || [];
  const o = q.open || [], h = q.high || [], l = q.low || [], c = q.close || [];
  const splits = effectiveSplits(res);
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (c[i] == null || isNaN(c[i])) continue;
    let f = 1;
    for (const sp of splits) if (sp.date > ts[i] && sp.numerator && sp.denominator) f *= sp.denominator / sp.numerator;
    out.push({ open: o[i] != null ? o[i] * f : null, high: h[i] != null ? h[i] * f : null,
               low: l[i] != null ? l[i] * f : null, close: c[i] * f });
  }
  return out;
}
async function gapSnap(stock) {
  const res = await yahooChart(stock.yh, '1d', '3mo');
  if (!res) return { ...stock, error: true };
  const bars = adjustedOHLC(res);
  if (bars.length < 2) return { ...stock, error: true };
  const last = bars[bars.length - 1], prev = bars[bars.length - 2];
  if (last.open == null || !prev.close) return { ...stock, error: true };
  const meta = res.meta || {};
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : last.close;
  const gap = ((last.open - prev.close) / prev.close) * 100;
  // gap fill = did the session trade back through the prior close?
  let filled = false;
  if (gap > 0 && last.low != null) filled = last.low <= prev.close;
  else if (gap < 0 && last.high != null) filled = last.high >= prev.close;
  return { sym: stock.sym, name: stock.name, sector: stock.sector,
    prevClose: +prev.close.toFixed(2), open: +last.open.toFixed(2), price: +price.toFixed(2),
    gap: +gap.toFixed(2), dayChg: +(((price - prev.close) / prev.close) * 100).toFixed(2), filled };
}
const GAPS_TTL = 5 * 60e3;
const _gaps = cacheLoad('gaps').map || {};        // uni -> { at, data }
const _gapsInflight = {};
async function refreshGaps(uni) {
  if (_gapsInflight[uni]) return _gapsInflight[uni];
  const job = (async () => {
    const snaps = (await pool(universe(uni), 12, s => gapSnap(s))).filter(s => !s.error && isFinite(s.gap));
    if (!snaps.length) throw new Error('no data');
    const ups   = snaps.filter(s => s.gap > 0).sort((a, b) => b.gap - a.gap).slice(0, 12);
    const downs = snaps.filter(s => s.gap < 0).sort((a, b) => a.gap - b.gap).slice(0, 12);
    const data = { uni, count: snaps.length, ups, downs, asOf: new Date().toISOString() };
    _gaps[uni] = { at: Date.now(), data };
    cacheSave('gaps', { map: _gaps });
    return data;
  })().finally(() => { delete _gapsInflight[uni]; });
  _gapsInflight[uni] = job;
  return job;
}
async function topGaps(uni) {
  const entry = _gaps[uni];
  if (entry) {
    if (Date.now() - entry.at > GAPS_TTL) refreshGaps(uni).catch(() => {});
    return entry.data;
  }
  return refreshGaps(uni);
}

// ─────────── relative strength vs NIFTY (period return minus index return) ───────────
const RS_LOOKBACK = { '1W': 5, '1M': 21, '3M': 63 };   // trading-day lookback
function periodReturn(res, lookback) {
  const closes = adjustedCloses(res);
  if (closes.length < lookback + 1) return null;
  const meta = res.meta || {};
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : closes[closes.length - 1];
  const refArr = refCloses(res);                        // date-anchored: excludes the live session
  const ref = refArr.length >= lookback ? refArr[refArr.length - lookback] : null;
  if (!ref) return null;
  return { price, ret: ((price - ref) / ref) * 100 };
}
async function rsSnap(stock, lookback) {
  const res = await yahooChart(stock.yh, '1d', '6mo');
  if (!res) return { ...stock, error: true };
  const r = periodReturn(res, lookback);
  if (!r) return { ...stock, error: true };
  return { sym: stock.sym, name: stock.name, sector: stock.sector, price: +r.price.toFixed(2), ret: +r.ret.toFixed(2) };
}
const RS_TTL = 5 * 60e3;
const _rs = cacheLoad('rs').map || {};             // 'uni|period' -> { at, data }
const _rsInflight = {};
async function refreshRS(uni, period) {
  const key = uni + '|' + period;
  if (_rsInflight[key]) return _rsInflight[key];
  const job = (async () => {
    const lb = RS_LOOKBACK[period] || 21;
    const idxRes = await yahooChart('^NSEI', '1d', '6mo');   // benchmark return over the same window
    const idxR = idxRes ? periodReturn(idxRes, lb) : null;
    const idxRet = idxR ? idxR.ret : 0;
    const snaps = (await pool(universe(uni), 12, s => rsSnap(s, lb))).filter(s => !s.error && isFinite(s.ret));
    if (!snaps.length) throw new Error('no data');
    snaps.forEach(s => { s.rel = +(s.ret - idxRet).toFixed(2); });   // outperformance vs NIFTY (pct points)
    // IBD-style RS rating: percentile 1-99 of relative return across the scanned universe
    const asc = snaps.slice().sort((a, b) => a.rel - b.rel);
    const n = asc.length;
    asc.forEach((s, i) => { s.rs = n > 1 ? Math.round(1 + 98 * i / (n - 1)) : 50; });
    // sign-partitioned to match the column labels ("outperforming" / "underperforming") and
    // to stop the same name landing in both lists on small universes (<24 names).
    const leaders  = snaps.filter(s => s.rel > 0).sort((a, b) => b.rel - a.rel).slice(0, 12);
    const laggards = snaps.filter(s => s.rel < 0).sort((a, b) => a.rel - b.rel).slice(0, 12);
    const data = { uni, period, count: snaps.length, indexRet: +idxRet.toFixed(2),
      leaders, laggards, asOf: new Date().toISOString() };
    _rs[key] = { at: Date.now(), data };
    cacheSave('rs', { map: _rs });
    return data;
  })().finally(() => { delete _rsInflight[key]; });
  _rsInflight[key] = job;
  return job;
}
async function topRS(uni, period) {
  const entry = _rs[uni + '|' + period];
  if (entry) {
    if (Date.now() - entry.at > RS_TTL) refreshRS(uni, period).catch(() => {});
    return entry.data;
  }
  return refreshRS(uni, period);
}

// ─────────── heatmap trend (same SWR + disk cache, so big universes open instantly) ───────────
const TREND_TTL = 5 * 60e3;
const _trend = cacheLoad('trend').map || {};         // 'uni|tf|type|mas' -> { at, data }
const _trendInflight = {};
function trendKey(tf, uni, cfg) { return `${uni}|${tf}|${cfg.type}|${cfg.lens.join(',')}`; }
async function refreshTrend(tf, uni, cfg) {
  const key = trendKey(tf, uni, cfg);
  if (_trendInflight[key]) return _trendInflight[key];
  const job = (async () => {
    const { interval } = TF_MAP[tf] || TF_MAP['1 Day'];
    const stocks = await pool(universe(uni), 10, s => snapshot(s, tf, cfg));
    const ok = stocks.filter(s => !s.error);
    if (!ok.length) throw new Error('no data');
    const data = { tf, uni, interval, maType: cfg.type, maLens: cfg.lens, asOf: new Date().toISOString(),
      stocks: ok, failed: stocks.filter(s => s.error).map(s => s.sym) };
    _trend[key] = { at: Date.now(), data };
    cacheSave('trend', { map: _trend });
    return data;
  })().finally(() => { delete _trendInflight[key]; });
  _trendInflight[key] = job;
  return job;
}
async function topTrend(tf, uni, cfg, force) {
  if (force) return refreshTrend(tf, uni, cfg);          // Refresh button → always fresh
  const entry = _trend[trendKey(tf, uni, cfg)];
  if (entry) {
    if (Date.now() - entry.at > TREND_TTL) refreshTrend(tf, uni, cfg).catch(() => {});   // revalidate in bg
    return entry.data;                                                                    // serve instantly
  }
  return refreshTrend(tf, uni, cfg);                                                       // cold → wait once
}

// ─────────── live indices ───────────
const INDICES = [
  ['NIFTY 50', '^NSEI'],
  ['SENSEX', '^BSESN'],
  ['BANK NIFTY', '^NSEBANK'],
  ['NIFTY IT', '^CNXIT'],
  ['NIFTY 100', '^CNX100'],
  ['NIFTY 200', '^CNX200'],
  ['NIFTY 500', '^CRSLDX'],
  ['NIFTY AUTO', '^CNXAUTO'],
];
async function indexSnap(name, ticker) {
  const res = await yahooChart(ticker, '1d', '5d');
  if (!res) return { name, error: true };
  const meta = res.meta || {};
  const closes = ((res.indicators.quote[0] || {}).close || []).filter(v => v != null && !isNaN(v));
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : closes[closes.length - 1];
  // previous *session* close, date-anchored (index-based [len-2] shifts a day when Yahoo lags)
  const refArr = refCloses(res);
  const prevClose = refArr[refArr.length - 1] || closes[closes.length - 2];
  const chg = (price != null && prevClose) ? price - prevClose : 0;
  const pct = prevClose ? (chg / prevClose) * 100 : 0;
  return { name, value: price, change: +chg.toFixed(2), pct: +pct.toFixed(2) };
}

// ─────────── GOLD = MCX-style ₹/10g, built from COMEX (GC=F) × live USD/INR ───────────
// Free Yahoo data has no MCX futures feed, so we replicate the landed-cost math instead:
// COMEX troy-oz price → grams → ×10 → ×USDINR → ×duty/GST/futures-basis premium.
// Premium calibrated once against a live MCX quote (₹146,565/10g vs ₹126,273 raw on
// GC=F 4145.8 + USDINR 94.735) → 1.1607. Approximate; will drift if duty/GST rates change.
const GOLD_MCX_PREMIUM = 1.1607;
const TROY_OZ_TO_GRAM = 31.1034768;
async function mcxGoldSnap() {
  const [goldRes, fxRes] = await Promise.all([
    yahooChart('GC=F', '1d', '5d'),
    yahooChart('INR=X', '1d', '5d'),
  ]);
  if (!goldRes || !fxRes) return { name: 'GOLD', error: true };
  const goldCloses = ((goldRes.indicators.quote[0] || {}).close || []).filter(v => v != null && !isNaN(v));
  const fxCloses = ((fxRes.indicators.quote[0] || {}).close || []).filter(v => v != null && !isNaN(v));
  const goldMeta = goldRes.meta || {}, fxMeta = fxRes.meta || {};
  const goldNow = goldMeta.regularMarketPrice != null ? goldMeta.regularMarketPrice : goldCloses[goldCloses.length - 1];
  const goldPrev = goldCloses[goldCloses.length - 2];
  const fxNow = fxMeta.regularMarketPrice != null ? fxMeta.regularMarketPrice : fxCloses[fxCloses.length - 1];
  const fxPrev = fxCloses[fxCloses.length - 2];
  const per10g = (usdPerOz, inrPerUsd) => (usdPerOz / TROY_OZ_TO_GRAM) * 10 * inrPerUsd * GOLD_MCX_PREMIUM;
  const valueNow = per10g(goldNow, fxNow);
  const valuePrev = (goldPrev && fxPrev) ? per10g(goldPrev, fxPrev) : null;
  const chg = valuePrev ? valueNow - valuePrev : 0;
  const pct = valuePrev ? (chg / valuePrev) * 100 : 0;
  return { name: 'GOLD', value: +valueNow.toFixed(2), change: +chg.toFixed(2), pct: +pct.toFixed(2) };
}
// Synthetic ₹/10g gold candles for the chart — the same landed-cost math as mcxGoldSnap,
// applied bar-by-bar to COMEX GC=F using the day-aligned USD/INR (INR=X) series.
async function goldCandles(interval, range) {
  const [g, fx] = await Promise.all([yahooChart('GC=F', interval, range), yahooChart('INR=X', interval, range)]);
  if (!g) return null;
  const gc = adjustedCandles(g);
  const fxByDay = {};
  if (fx) for (const c of adjustedCandles(fx)) fxByDay[Math.floor(c.time / 86400)] = c.close;
  let lastFx = null;
  const out = [];
  for (const c of gc) {
    const rate = fxByDay[Math.floor(c.time / 86400)] ?? lastFx;   // carry forward last FX if a bar has none
    if (rate == null) continue;
    lastFx = rate;
    const f = v => +((v / TROY_OZ_TO_GRAM) * 10 * rate * GOLD_MCX_PREMIUM).toFixed(2);
    out.push({ time: c.time, open: f(c.open), high: f(c.high), low: f(c.low), close: f(c.close) });
  }
  return out;
}

// ─────────── live quote for Stock Info (price + day stats) ───────────
async function quote(ticker) {
  const res = await yahooChart(ticker, '1d', '1y');
  if (!res) return null;
  const meta = res.meta || {};
  const closes = adjustedCloses(res);   // split-adjusted (for SMA correctness)
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : closes[closes.length - 1];
  // previous *session* close, date-anchored (not closes[len-2], which shifts a day when
  // Yahoo's EOD bar lags; not chartPreviousClose, which is range-start)
  const refArr = refCloses(res);
  const prevClose = refArr[refArr.length - 1] || closes[closes.length - 2];
  const chg = (price != null && prevClose) ? price - prevClose : 0;
  const pct = prevClose ? (chg / prevClose) * 100 : 0;
  return {
    symbol: meta.symbol, currency: meta.currency,
    price: price != null ? +price.toFixed(2) : null,
    change: +chg.toFixed(2), pct: +pct.toFixed(2),
    dayHigh: meta.regularMarketDayHigh, dayLow: meta.regularMarketDayLow,
    week52High: meta.fiftyTwoWeekHigh, week52Low: meta.fiftyTwoWeekLow,
    volume: meta.regularMarketVolume,
    sma50: closes.length >= 50 ? +sma(closes,50).toFixed(2) : null,
    sma200: closes.length >= 200 ? +sma(closes,200).toFixed(2) : null,
  };
}

// ─────────── ATR(14) via the TradingView scanner (position-sizing volatility stops) ───────────
// Deliberately TV-sourced, not Yahoo-computed: Yahoo's NSE daily bars clip highs/lows and
// contain degenerate H==L placeholder bars, so a Wilder ATR on Yahoo data runs ~5-10% low
// (RELIANCE: Yahoo 21.6 vs TV 23.5). Same reason the portfolio ranker is TV-sourced.
const _atrCache = new Map();   // sym -> { at, data }
async function tvAtr(sym) {
  const hit = _atrCache.get(sym);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.data;
  const body = JSON.stringify({ symbols: { tickers: ['NSE:' + sym] }, columns: ['ATR', 'close', 'Volatility.D'] });
  const r = await fetch('https://scanner.tradingview.com/india/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body,
  });
  if (!r.ok) throw new Error('TradingView scanner HTTP ' + r.status);
  const j = await r.json();
  const d = j && j.data && j.data[0] && j.data[0].d;
  if (!d || !(d[0] > 0)) throw new Error('no ATR for ' + sym);
  const data = { sym, atr: +d[0].toFixed(2), close: d[1] != null ? +d[1] : null,
    volD: d[2] != null ? +d[2].toFixed(2) : null, source: 'tradingview' };
  _atrCache.set(sym, { at: Date.now(), data });
  return data;
}

// ─────────── live news via free Google News RSS (no API key) ───────────
function rssDecode(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
function rssTag(block, name) {
  const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? m[1] : '';
}
// Unified sentiment tag for the News tab — delegates to the same lexicon scorer the
// Sentiment tab uses (scoreSentence, defined below), so the two views can't disagree.
function sentimentTag(title) {
  const c = scoreSentence(title).compound;
  return c >= 0.15 ? 'bull' : c <= -0.15 ? 'bear' : 'neutral';
}
function newsUrl(q) {
  const query = (q && q.trim())
    ? q.trim() + ' stock share price NSE India'
    : 'Nifty OR Sensex OR NSE Indian stock market';
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
}
async function fetchNews(q) {
  const r = await fetch(newsUrl(q), { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const xml = await r.text();
  const items = [];
  for (const part of xml.split(/<item>/i).slice(1)) {
    const block = part.split(/<\/item>/i)[0];
    let title = rssDecode(rssTag(block, 'title'));
    const link = rssDecode(rssTag(block, 'link'));
    const pub = rssTag(block, 'pubDate').trim();
    let source = rssDecode(rssTag(block, 'source'));
    // Google News titles end with " - Source"; strip it for a clean headline
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    else if (!source) { const d = title.lastIndexOf(' - '); if (d > 0) { source = title.slice(d + 3); title = title.slice(0, d); } }
    if (!title) continue;
    items.push({ title, link, source: source || 'News', pubMs: pub ? Date.parse(pub) : Date.now(), tag: sentimentTag(title) });
  }
  // newest first, cap at 24
  return items.sort((a, b) => b.pubMs - a.pubMs).slice(0, 24);
}

// ─────────── index drill-down (constituents + weights) ───────────
// Approximate current index weights (%) for the major indices — for "what's moving the index" context.
const INDEX_DEFS = {
  'Nifty 50': { yh: '^NSEI', weighted: [
    ['HDFCBANK',13.1],['ICICIBANK',8.6],['RELIANCE',8.0],['INFY',5.0],['BHARTIARTL',4.3],['ITC',3.9],['TCS',3.8],['LT',3.7],
    ['AXISBANK',3.1],['SBIN',3.0],['KOTAKBANK',2.7],['M&M',2.4],['HINDUNILVR',2.3],['BAJFINANCE',2.3],['MARUTI',1.9],['SUNPHARMA',1.8],
    ['NTPC',1.7],['HCLTECH',1.6],['TITAN',1.5],['TRENT',1.4],['ULTRACEMCO',1.4],['TATAMOTORS',1.3],['POWERGRID',1.3],['BEL',1.2],
    ['ADANIPORTS',1.1],['ADANIENT',1.0],['ASIANPAINT',1.0],['JSWSTEEL',1.0],['NESTLEIND',1.0],['WIPRO',0.9]] },
  'Bank Nifty': { yh: '^NSEBANK', weighted: [
    ['HDFCBANK',28.5],['ICICIBANK',24.0],['SBIN',9.2],['AXISBANK',8.8],['KOTAKBANK',7.9],['CANBK',2.6],['PNB',2.4],['BANKBARODA',2.3],
    ['AUBANK',2.0],['INDUSINDBK',1.9],['IDFCFIRSTB',1.8],['FEDERALBNK',1.8]] },
  'Nifty IT': { yh: '^CNXIT', weighted: [
    ['INFY',26.0],['TCS',24.0],['HCLTECH',11.5],['TECHM',9.0],['WIPRO',8.0],['LTIM',6.0],['PERSISTENT',5.0],['COFORGE',4.0],['MPHASIS',3.0],['OFSS',3.0]] },
  'Sensex': { yh: '^BSESN', weighted: [
    ['HDFCBANK',14.2],['ICICIBANK',9.6],['RELIANCE',9.0],['INFY',5.6],['BHARTIARTL',4.8],['ITC',4.3],['TCS',4.2],['LT',4.1],['AXISBANK',3.4],
    ['SBIN',3.3],['KOTAKBANK',3.0],['M&M',2.7],['HINDUNILVR',2.6],['BAJFINANCE',2.5],['MARUTI',2.1],['SUNPHARMA',2.0],['NTPC',1.9],['HCLTECH',1.8],
    ['TITAN',1.7],['ULTRACEMCO',1.6],['POWERGRID',1.5],['TATAMOTORS',1.4],['ASIANPAINT',1.2],['NESTLEIND',1.1],['TECHM',1.0]] },
  'Nifty Auto': { yh: '^CNXAUTO', weighted: [
    ['M&M',19.5],['MARUTI',17.5],['BAJAJ-AUTO',9.0],['TVSMOTOR',6.5],['EICHERMOT',6.5],['TMPV',6.0],
    ['MOTHERSON',4.5],['HEROMOTOCO',4.5],['BOSCHLTD',3.5],['ASHOKLEY',3.0],['BHARATFORG',2.5],['BALKRISIND',2.5],
    ['MRF',2.3],['EXIDEIND',1.8],['SONACOMS',1.5]] },
  'Nifty 100': { yh: '^CNX100' },
  'Nifty 200': { yh: '^CNX200' },
  'Nifty 500': { yh: '^CRSLDX' },
};
function resolveStock(sym) {
  return STOCKS.find(s => s.sym === sym) || { sym, yh: TICKER_OVERRIDE[sym] || (sym + '.NS'), name: sym, sector: '' };
}
async function memberSnap(sym, weight) {
  const st = resolveStock(sym);
  const res = await yahooChart(st.yh, '1d', '5d');
  if (!res) return { sym, name: st.name, weight, error: true };
  const meta = res.meta || {};
  const closes = ((res.indicators.quote[0] || {}).close || []).filter(v => v != null && !isNaN(v));
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : closes[closes.length - 1];
  const refArr = refCloses(res);   // date-anchored previous session close
  const prev = refArr[refArr.length - 1] || closes[closes.length - 2];
  const pct = prev ? ((price - prev) / prev) * 100 : 0;
  return {
    sym, name: st.name, sector: st.sector,
    price: price != null ? +price.toFixed(2) : null, pct: +pct.toFixed(2),
    volume: meta.regularMarketVolume || null,
    weight: weight != null ? weight : null,
    contribution: weight != null ? +(weight * pct / 100).toFixed(3) : null, // approx index %-points contribution
  };
}

// ─────────── candlestick OHLC + rolling MA overlays ───────────
function adjustedCandles(res) {
  const q = res.indicators.quote[0] || {};
  const ts = res.timestamp || [];
  const splits = effectiveSplits(res);   // skip phantom/already-applied splits (see adjustedSeries)
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if ([o, h, l, c].some(v => v == null || isNaN(v))) continue;
    let f = 1;
    if (splits.length) for (const s of splits) { if (s.date > ts[i] && s.numerator && s.denominator) f *= s.denominator / s.numerator; }
    out.push({ time: ts[i], open: +(o * f).toFixed(2), high: +(h * f).toFixed(2), low: +(l * f).toFixed(2), close: +(c * f).toFixed(2) });
  }
  return out;
}
function rollingMA(values, len, type) {
  const out = new Array(values.length).fill(null);
  if (values.length < len) return out;
  if (type === 'ema') {
    const k = 2 / (len + 1); let e = 0;
    for (let i = 0; i < len; i++) e += values[i];
    e /= len; out[len - 1] = e;
    for (let i = len; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
  } else {
    let sum = 0;
    for (let i = 0; i < values.length; i++) { sum += values[i]; if (i >= len) sum -= values[i - len]; if (i >= len - 1) out[i] = sum / len; }
  }
  return out;
}

// ─────────── VADER-style sentiment (lexicon, no API key) ───────────
const SENTI_LEX = {
  // market up
  surge:2.6,surges:2.6,surged:2.6,jump:2.0,jumps:2.0,jumped:2.0,soar:2.8,soars:2.8,soared:2.8,rally:2.2,rallies:2.2,rallied:2.2,
  gain:1.6,gains:1.6,gained:1.6,rise:1.3,rises:1.3,rose:1.3,rising:1.3,climb:1.6,climbs:1.6,climbed:1.6,advance:1.3,advances:1.3,
  beat:2.0,beats:2.0,upgrade:2.4,upgrades:2.4,upgraded:2.4,outperform:2.2,outperforms:2.2,bullish:2.6,boom:2.4,booms:2.4,
  record:1.8,high:1.0,highs:1.0,profit:1.6,profits:1.6,strong:1.8,robust:1.8,growth:1.6,grow:1.4,grows:1.4,rebound:1.8,recovers:1.6,recovery:1.4,
  buy:1.4,'top-pick':2.2,multibagger:2.6,zoom:2.4,zooms:2.4,spike:1.6,spikes:1.6,optimistic:2.0,upbeat:2.0,positive:1.6,wins:1.6,win:1.6,won:1.4,
  approval:1.4,approved:1.4,expansion:1.2,dividend:1.0,bonus:1.2,boost:1.6,boosts:1.6,boosted:1.6,jumping:2.0,gaining:1.6,
  // market down
  fall:-1.6,falls:-1.6,fell:-1.6,falling:-1.6,drop:-1.6,drops:-1.6,dropped:-1.6,plunge:-2.8,plunges:-2.8,plunged:-2.8,slump:-2.4,slumps:-2.4,slumped:-2.4,
  crash:-3.0,crashes:-3.0,crashed:-3.0,tumble:-2.4,tumbles:-2.4,tumbled:-2.4,sink:-2.0,sinks:-2.0,sank:-2.0,slide:-1.8,slides:-1.8,slid:-1.8,
  decline:-1.6,declines:-1.6,declined:-1.6,loss:-1.8,losses:-1.8,lose:-1.6,loses:-1.6,lost:-1.6,weak:-1.8,weakness:-1.8,downgrade:-2.4,downgrades:-2.4,downgraded:-2.4,
  miss:-1.8,misses:-1.8,missed:-1.8,bearish:-2.6,sell:-1.4,selloff:-2.4,'sell-off':-2.4,cut:-1.2,cuts:-1.2,slash:-2.0,slashes:-2.0,slashed:-2.0,
  fraud:-3.2,scam:-3.2,probe:-1.6,raid:-2.0,penalty:-1.8,fine:-1.4,fined:-1.4,ban:-2.0,banned:-2.0,default:-2.4,downturn:-2.0,recession:-2.2,
  concern:-1.2,concerns:-1.2,worry:-1.4,worries:-1.4,fear:-1.6,fears:-1.6,risk:-1.0,risks:-1.0,warning:-1.4,warns:-1.4,low:-1.0,lows:-1.0,
  pressure:-1.2,drag:-1.4,drags:-1.4,negative:-1.6,disappoint:-1.8,disappoints:-1.8,disappointing:-1.8,layoff:-2.0,layoffs:-2.0,debt:-1.0,
  weakens:-1.6,hit:-1.0,hits:-0.6,struggles:-1.8,struggle:-1.8,halt:-1.4,halts:-1.4,delay:-1.2,delays:-1.2,
  // ── Tier-1 additions: high-signal finance unigrams the original lexicon missed ──
  buyback:1.8,buybacks:1.8,surpass:1.8,surpasses:1.8,surpassed:1.8,surges:2.6,acquire:1.0,acquires:1.0,acquired:1.0,acquisition:1.0,
  merger:0.6,partnership:1.2,partnerships:1.2,partners:1.0,contract:1.0,contracts:1.0,launch:0.8,launches:0.8,launched:0.8,
  expand:1.2,expands:1.2,expanding:1.2,inflows:1.2,outflows:-1.2,turnaround:1.8,raises:1.2,lifts:1.2,
  insolvency:-2.4,bankruptcy:-2.6,bankrupt:-2.4,lawsuit:-1.6,litigation:-1.4,pledge:-1.4,pledged:-1.6,defaults:-2.4,defaulted:-2.4,
  downbeat:-1.8,glut:-1.6,writeoff:-1.8,'write-off':-1.8,impairment:-1.6,headwinds:-1.4,headwind:-1.4,
};
const SENTI_BOOST = { very:0.3,extremely:0.4,highly:0.3,sharply:0.3,significantly:0.3,massively:0.4,hugely:0.4,strongly:0.3,
  slightly:-0.3,barely:-0.3,marginally:-0.3,somewhat:-0.2,'a bit':-0.2 };
const SENTI_NEG = new Set(['not','no','never','none','nobody','nothing','neither','nor','without','cannot',"can't","won't","don't","doesn't","didn't","isn't","aren't","wasn't",'fails','failed','fail']);
// Multi-word phrases scored BEFORE unigrams — they disambiguate words whose sign flips with context
// (e.g. "rate cut" is bullish for equities, "dividend cut" is bearish; "record high" vs "high debt").
const SENTI_PHRASE = {
  'rate cut':1.4,'rate cuts':1.4,'rate hike':-0.8,'rate hikes':-0.8,'tax cut':1.2,'tax cuts':1.2,
  'price cut':-1.0,'price cuts':-1.2,'price hike':1.0,'price hikes':1.0,'job cut':-1.6,'job cuts':-1.6,
  'dividend cut':-2.0,'cuts dividend':-2.0,'dividend cuts':-2.0,'slashes dividend':-2.2,'dividend slashed':-2.2,'omits dividend':-2.2,'cut dividend':-2.0,
  'record high':2.2,'fresh high':1.8,'lifetime high':2.2,'all-time high':2.4,'52-week high':2.0,'52 week high':2.0,'multi-year high':1.8,
  'record low':-2.0,'all-time low':-2.0,'52-week low':-2.0,'52 week low':-2.0,'multi-year low':-1.8,
  'high debt':-1.8,'higher debt':-1.6,'debt-laden':-2.0,'low debt':1.2,'debt-free':1.8,'debt free':1.8,'debt reduction':1.4,
  'high inflation':-1.6,'rising inflation':-1.6,'cooling inflation':1.2,'easing inflation':1.2,
  'order win':2.0,'order wins':2.0,'new order':1.6,'large order':1.8,'order book':1.2,'record order':2.0,
  'guidance raised':2.4,'raises guidance':2.4,'lifts guidance':2.2,'raised guidance':2.4,
  'guidance cut':-2.4,'cuts guidance':-2.4,'lowers guidance':-2.2,'lowered guidance':-2.2,'guidance below':-2.0,
  'profit booking':-1.2,'profit-booking':-1.2,'profit taking':-1.2,
  'pledged shares':-1.8,'share pledge':-1.6,'pledged stake':-1.8,'stake sale':-0.8,'block deal':-0.6,
  'gst notice':-1.8,'tax notice':-1.6,'show cause':-1.4,'show-cause':-1.4,'sebi probe':-2.0,'sebi bar':-2.4,'sebi ban':-2.4,
  'open offer':0.8,'bonus issue':1.2,'stock split':0.6,'rights issue':-0.4,'share buyback':2.0,'special dividend':1.6,
};
// Longest phrases first, so a multi-word match consumes its tokens before a shorter overlap can.
const SENTI_PHRASE_KEYS = Object.keys(SENTI_PHRASE).sort((a, b) => b.split(' ').length - a.split(' ').length);
function scoreSentence(text) {
  const raw = text.toLowerCase();
  const tokens = raw.replace(/[^a-z0-9'\- ]/g, ' ').split(/\s+/).filter(Boolean);
  const consumed = new Array(tokens.length).fill(false);
  let sum = 0, hits = 0;
  const negatedBefore = i => { for (let j = Math.max(0, i - 3); j < i; j++) if (SENTI_NEG.has(tokens[j])) return true; return false; };
  // 1) multi-word phrases first — they override their unigram parts ("rate cut" beats "cut")
  for (const phrase of SENTI_PHRASE_KEYS) {
    const pw = phrase.split(' ');
    for (let i = 0; i + pw.length <= tokens.length; i++) {
      let ok = true;
      for (let k = 0; k < pw.length; k++) if (tokens[i + k] !== pw[k] || consumed[i + k]) { ok = false; break; }
      if (!ok) continue;
      let v = SENTI_PHRASE[phrase];
      if (negatedBefore(i)) v *= -0.74;
      sum += v; hits++;
      for (let k = 0; k < pw.length; k++) consumed[i + k] = true;
    }
  }
  // 2) directional % moves with magnitude — "up 4%", "down 3.2%", "higher by 2 per cent"
  const mv = raw.match(/\b(up|down|higher|lower)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*(?:per\s?cent|%)/);
  if (mv) { const dir = (mv[1] === 'up' || mv[1] === 'higher') ? 1 : -1; sum += dir * Math.min(2.5, 0.8 + parseFloat(mv[2]) / 5); hits++; }
  // 3) remaining single-word lexicon hits
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    let v = SENTI_LEX[tokens[i]];
    if (v == null) continue;
    hits++;
    const b = SENTI_BOOST[tokens[i - 1]];   // booster from previous word
    if (b) v += v > 0 ? b : -b;
    if (negatedBefore(i)) v *= -0.74;        // negation in the previous 3 tokens flips & dampens
    sum += v;
  }
  if (/!/.test(text)) sum += sum > 0 ? 0.3 : (sum < 0 ? -0.3 : 0);
  const compound = sum === 0 ? 0 : sum / Math.sqrt(sum * sum + 15); // VADER normalisation
  return { compound: +compound.toFixed(3), hits };
}
function sentimentLabel(score10) {
  if (score10 >= 7.5) return 'Strongly Positive';
  if (score10 >= 6.0) return 'Positive';
  if (score10 >= 5.4) return 'Slightly Positive';
  if (score10 > 4.6)  return 'Neutral';
  if (score10 > 3.5)  return 'Slightly Negative';
  if (score10 > 2.0)  return 'Negative';
  return 'Strongly Negative';
}
// Relevance aliases so we only score headlines actually about the queried company, not
// tangential market noise (e.g. "TCS plunges" leaking into an Infosys query).
function relevanceAliases(q) {
  const ql = q.toLowerCase().trim();
  const aliases = new Set();
  if (ql.length >= 3) aliases.add(ql);
  const st = STOCKS.find(s => s.sym.toLowerCase() === ql)
          || STOCKS.find(s => s.name.toLowerCase() === ql)
          || STOCKS.find(s => ql.length >= 3 && s.name.toLowerCase().includes(ql))
          || STOCKS.find(s => ql.length >= 3 && s.sym.toLowerCase().includes(ql));
  if (st) {
    aliases.add(st.sym.toLowerCase());
    aliases.add(st.name.toLowerCase());
    // single distinctive name word (e.g. "infosys", "wipro") — skip generic/brand-shared tokens
    const GEN = new Set(['ltd','limited','industries','industry','corporation','corp','company','co','enterprises','enterprise','services','service','technologies','technology','finance','financial','motors','steel','power','india','the','&','and','of']);
    const core = st.name.toLowerCase().replace(/[.,]/g, '').split(/\s+/).filter(w => w && !GEN.has(w));
    if (core.length === 1 && core[0].length >= 5) aliases.add(core[0]);
  }
  return [...aliases].filter(a => a && a.length >= 3);
}
const isRelevant = (title, aliases) => { const t = title.toLowerCase(); return aliases.some(a => t.includes(a)); };

async function analyzeSentiment(q) {
  const items = await fetchNews(q);                 // reuse the live Google News feed
  const aliases = relevanceAliases(q);
  const scored = items.map(it => {
    const s = scoreSentence(it.title);
    const label = s.compound >= 0.15 ? 'positive' : s.compound <= -0.15 ? 'negative' : 'neutral';
    return { ...it, compound: s.compound, hits: s.hits, relevant: isRelevant(it.title, aliases), label };
  });
  // Score basis: on-topic headlines that actually carry lexicon signal. If too thin to trust,
  // widen to all signal-bearing headlines and flag it as low-confidence.
  let signal = scored.filter(s => s.relevant && s.hits > 0);
  let basis = 'relevant';
  if (signal.length < 3) { signal = scored.filter(s => s.hits > 0); basis = 'all'; }
  // Display the on-topic headlines when we have a confident basis, else show everything.
  const display = basis === 'relevant' ? scored.filter(s => s.relevant) : scored;
  const counts = { pos: 0, neg: 0, neu: 0 };
  for (const s of display) counts[s.label === 'positive' ? 'pos' : s.label === 'negative' ? 'neg' : 'neu']++;
  const rawMean = signal.length ? signal.reduce((a, s) => a + s.compound, 0) / signal.length : 0;
  // Sample-size shrinkage: pull toward neutral when few headlines carry signal — a 2-headline
  // read shouldn't look as authoritative as a 20-headline one. weight = n/(n+k), k=4.
  const k = 4;
  const shrunk = rawMean * (signal.length / (signal.length + k));
  const score10 = Math.min(10, Math.max(1, +(5 + shrunk * 5).toFixed(1)));  // 1..10, 5 = neutral
  return {
    q, count: display.length, scored: signal.length, basis,
    meanCompound: +rawMean.toFixed(3), score10, label: sentimentLabel(score10),
    counts, headlines: display, asOf: new Date().toISOString(),
  };
}

// ─────────── SWOT via Trendlyne's free SWOT web-widget (real, no API key) ───────────
// Trendlyne computes a live SWOT (financials + management + technicals + valuation) for every
// NSE stock and exposes it as an embeddable widget. We proxy the widget HTML server-side
// (bypasses CORS) and parse out the per-category bullet lists, then render natively in our
// own dark theme with a "Powered by Trendlyne" credit + deep link back to the source.
const _swotCache = new Map();                 // sym -> { at, data }
const SWOT_TTL = 30 * 60e3;                    // SWOT shifts intraday but is stable enough for 30 min
const SWOT_CATS = [['Strengths', 'strengths'], ['Weakness', 'weaknesses'], ['Opportunity', 'opportunities'], ['Threats', 'threats']];
function parseSwotWidget(html, sym) {
  const items = { strengths: [], weaknesses: [], opportunities: [], threats: [] };
  for (const [tlKey, ourKey] of SWOT_CATS) {
    const m = html.match(new RegExp('<ul class="text_bullets[^"]*" data-value="' + tlKey + '">([\\s\\S]*?)</ul>', 'i'));
    if (!m) continue;
    items[ourKey] = [...m[1].matchAll(/<li>([\s\S]*?)<\/li>/gi)].map(x => rssDecode(x[1])).filter(Boolean);
  }
  const nameM = html.match(/head_text[\s\S]*?<span>([\s\S]*?)<\/span>/i);
  const urlM = html.match(/class="powered_by_container"\s+href="([^"]+)"/i);
  const counts = { strengths: items.strengths.length, weaknesses: items.weaknesses.length, opportunities: items.opportunities.length, threats: items.threats.length };
  const total = counts.strengths + counts.weaknesses + counts.opportunities + counts.threats;
  return { sym, name: nameM ? rssDecode(nameM[1]) : sym, counts, items, total,
    sourceUrl: urlM ? urlM[1] : `https://trendlyne.com/equity/?q=${encodeURIComponent(sym)}`, asOf: new Date().toISOString() };
}
async function fetchSwot(sym) {
  const hit = _swotCache.get(sym);
  if (hit && Date.now() - hit.at < SWOT_TTL) return hit.data;
  const url = `https://trendlyne.com/web-widget/swot-widget/Poppins/${encodeURIComponent(sym)}/?posCol=00A25B&primaryCol=006AFF&negCol=EB3B00&neuCol=F7941E`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' } });
  if (!r.ok) throw new Error('Trendlyne HTTP ' + r.status);
  const data = parseSwotWidget(await r.text(), sym);
  if (data.total > 0) _swotCache.set(sym, { at: Date.now(), data });   // never cache an empty/miss
  return data;
}

// ─────────── portfolio ranking & analyzer ───────────
// Signals come straight from TradingView's public scanner, so every number the ranker uses
// (price, 50/200-DMA, 52-week range, momentum, volatility) is IDENTICAL to the user's
// TradingView reference — this also sidesteps Yahoo's split-adjustment inconsistencies on
// recently-split names (e.g. TRENT, whose Yahoo 200-DMA is wrong). One batched call/portfolio.
const TV_COLS = ['close', 'change', 'SMA50', 'SMA200', 'price_52_week_high', 'price_52_week_low', 'Perf.1M', 'Perf.3M', 'Perf.Y', 'Volatility.D', 'beta_1_year', 'sector', 'description'];
const _tvCache = new Map();                                   // key = sorted symbol set -> { at, map }
async function tvScan(symbols) {
  const key = [...symbols].sort().join(',');
  const hit = _tvCache.get(key);
  if (hit && Date.now() - hit.at < 60e3) return hit.map;       // 60s cache for repeat hits
  const body = JSON.stringify({ symbols: { tickers: symbols.map(s => 'NSE:' + s) }, columns: TV_COLS });
  const r = await fetch('https://scanner.tradingview.com/india/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body,
  });
  if (!r.ok) throw new Error('TradingView scanner HTTP ' + r.status);
  const j = await r.json();
  const map = {};
  for (const row of (j.data || [])) {
    const o = {}; TV_COLS.forEach((c, i) => o[c] = (row.d || [])[i]);
    map[(row.s || '').replace('NSE:', '')] = o;
  }
  _tvCache.set(key, { at: Date.now(), map });
  return map;
}
// Fundamental-quality pillar: distils the live forensic scores (Piotroski F, Altman Z″,
// accruals — all computed from reported filings by computeRatios) into a 0–100 quality score.
// Banks/financials return null (statement forensics don't apply to lenders) and the
// composite re-normalises around the missing pillar.
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// Per-holding news sentiment — reuses the Sentiment tab's analyzeSentiment (relevance-filtered
// VADER-style lexicon over live Google News). Advisory only: shown as a column + red-flag,
// deliberately NOT part of the composite score (fuzziest signal, no ground truth).
const _pfSentiCache = new Map();               // sym -> { at, data }
async function holdingSentiment(sym) {
  const hit = _pfSentiCache.get(sym);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.data;
  const st = resolveStock(sym);
  const j = await analyzeSentiment(st.name && st.name !== sym ? st.name : sym);
  const data = { score10: j.score10, label: j.label, scored: j.scored, basis: j.basis };
  _pfSentiCache.set(sym, { at: Date.now(), data });
  return data;
}
// Trendlyne SWOT counts per holding (fetchSwot has its own 30-min cache) — advisory flag input
async function holdingSwot(sym) {
  const j = await fetchSwot(sym);
  return j && j.total > 0 ? { ...j.counts } : null;
}
// Sector-peer 3-month performance: one batched TV scan of every Nifty-500 constituent in the
// holdings' sectors, so each holding can be ranked against its own sector (percentile).
async function peerPerfBySector(sectorList) {
  const secSet = new Set(sectorList.filter(Boolean));
  if (!secSet.size) return {};
  const syms = STOCKS.filter(s => secSet.has(s.sector)).map(s => s.sym).slice(0, 600);
  if (syms.length < 5) return {};
  const tvp = await tvScan(syms);
  const by = {};
  for (const s of STOCKS) {
    if (!secSet.has(s.sector)) continue;
    const row = tvp[s.sym];
    if (row && row['Perf.3M'] != null) (by[s.sector] = by[s.sector] || []).push(row['Perf.3M']);
  }
  return by;
}

const BANKISH_RE = /bank|nbfc|financ|insurance/i;
async function fundamentalsQuality(sym, sector) {
  if (BANKISH_RE.test(sector || '')) return { quality: null, note: 'bank' };
  try {
    const ticker = TICKER_OVERRIDE[sym] || sym + '.NS';
    const data = await computeRatios(ticker);
    const f = data && data.forensics;
    if (!f) return { quality: null, note: 'no-data' };
    const parts = [];
    if (f.piotroski) parts.push([0.55, f.piotroski.score / 9 * 100]);
    if (f.altman) parts.push([0.25, f.altman.zone === 'good' ? 100 : f.altman.zone === 'avg' ? 55 : 10]);
    if (f.earningsQuality) parts.push([0.20, f.earningsQuality.flag === 'good' ? 100 : f.earningsQuality.flag === 'avg' ? 55 : 10]);
    if (!parts.length) return { quality: null, note: 'no-data' };
    const wsum = parts.reduce((a, p) => a + p[0], 0);
    return {
      quality: Math.round(parts.reduce((a, p) => a + p[0] * p[1], 0) / wsum),
      fscore: f.piotroski ? f.piotroski.score : null,
      z: f.altman ? f.altman.z : null, zZone: f.altman ? f.altman.zone : null,
      accrualsFlag: f.earningsQuality ? f.earningsQuality.flag : null,
    };
  } catch (e) { return { quality: null, note: 'error' }; }
}
function scoreHolding(h, tv, fund, extra) {
  const st = resolveStock(h.sym);
  if (!tv || tv.close == null) return { sym: h.sym, name: st.name, sector: st.sector || '—', qty: h.qty, buy: h.buy, error: true };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const price = tv.close, sma50 = tv.SMA50, sma200 = tv.SMA200;
  const above50 = sma50 != null && price >= sma50, above200 = sma200 != null && price >= sma200;
  const hi52 = tv.price_52_week_high, lo52 = tv.price_52_week_low;
  const ret1m = tv['Perf.1M'], ret3m = tv['Perf.3M'], ret1y = tv['Perf.Y'];
  const vol = tv['Volatility.D'] != null ? tv['Volatility.D'] * Math.sqrt(252) : null;   // TV daily vol % → annualised
  const beta = tv.beta_1_year != null ? +tv.beta_1_year.toFixed(2) : null;
  const trendScore = (above200 ? 60 : 0) + (above50 ? 40 : 0);
  // risk-adjusted momentum (Sharpe-like): 3-month return over ~3-month vol, so a 10% gain on a
  // calm stock outranks the same gain on a wild one; falls back to raw return when vol is missing
  const momAbs = (ret3m != null && vol != null)
    ? clamp(50 + (ret3m / Math.max(vol / 2, 5)) * 25, 0, 100)
    : clamp(50 + (ret3m != null ? ret3m : 0) * 1.5, 0, 100);
  // blend in sector-peer percentile when available (is it strong *for its sector*?)
  const peerPct = extra && extra.peerPct != null ? extra.peerPct : null;
  const momScore = peerPct != null ? 0.65 * momAbs + 0.35 * peerPct : momAbs;
  const rangePos = (hi52 != null && lo52 != null && hi52 > lo52) ? clamp((price - lo52) / (hi52 - lo52) * 100, 0, 100) : 50;
  const volScore = vol != null ? clamp(100 - (vol - 20) * 1.8, 0, 100) : 50;   // ~20% annualised vol ≈ neutral
  const betaScore = beta != null ? clamp(50 + (1 - beta) * 50, 0, 100) : null; // β 1.0 = neutral 50, defensive scores higher
  const riskScore = betaScore != null ? 0.7 * volScore + 0.3 * betaScore : volScore;
  const q = fund && fund.quality != null ? fund.quality : null;
  // weights: trend .30 · momentum .20 · quality .20 · risk .20 · range .10
  // (re-normalised when quality is n/a — banks/financials or no filings data)
  const parts = [[0.30, trendScore], [0.20, momScore], [0.20, riskScore], [0.10, rangePos]];
  if (q != null) parts.push([0.20, q]);
  const wsum = parts.reduce((a, p) => a + p[0], 0);
  const composite = Math.round(parts.reduce((a, p) => a + p[0] * p[1], 0) / wsum);
  return {
    sym: h.sym, name: (st.name && st.name !== h.sym) ? st.name : (tv.description || h.sym), sector: st.sector || tv.sector || '—', qty: h.qty, buy: h.buy,
    price: +price.toFixed(2), dayPct: tv.change != null ? +tv.change.toFixed(2) : 0,
    sma50: sma50 != null ? +sma50.toFixed(2) : null, sma200: sma200 != null ? +sma200.toFixed(2) : null,
    above50, above200,
    fromHigh: hi52 ? +((price - hi52) / hi52 * 100).toFixed(1) : null, fromLow: lo52 ? +((price - lo52) / lo52 * 100).toFixed(1) : null,
    ret1m: ret1m != null ? +ret1m.toFixed(1) : null, ret3m: ret3m != null ? +ret3m.toFixed(1) : null, ret1y: ret1y != null ? +ret1y.toFixed(1) : null,
    vol: vol != null ? +vol.toFixed(1) : null, beta,
    quality: q, fscore: fund ? fund.fscore : null, z: fund ? fund.z : null, zZone: fund ? fund.zZone : null,
    accrualsFlag: fund ? fund.accrualsFlag : null, qualityNote: fund ? fund.note : null,
    peerPct, senti: (extra && extra.senti) || null, swot: (extra && extra.swot) || null,
    sub: { trend: trendScore, momentum: Math.round(momScore), range: Math.round(rangePos), risk: Math.round(riskScore), quality: q }, composite,
  };
}
async function analyzePortfolio(holdings) {
  const tv = await tvScan(holdings.map(h => h.sym));
  // all auxiliary signals in parallel — every engine has its own cache so repeats are instant.
  // Sentiment/SWOT are timeout-guarded and failure-safe (null → column shows '—', no flag).
  const secOf = h => { const st = resolveStock(h.sym); return (st && st.sector) || (tv[h.sym] && tv[h.sym].sector) || ''; };
  const peerJob = peerPerfBySector(holdings.map(secOf)).catch(() => ({}));
  const funds = {}, sentis = {}, swots = {};
  await Promise.all(holdings.map(async h => {
    const [f, s, w] = await Promise.allSettled([
      fundamentalsQuality(h.sym, secOf(h)),
      withTimeout(holdingSentiment(h.sym), 8000),
      withTimeout(holdingSwot(h.sym), 6000),
    ]);
    funds[h.sym] = f.status === 'fulfilled' ? f.value : { quality: null, note: 'error' };
    sentis[h.sym] = s.status === 'fulfilled' ? s.value : null;
    swots[h.sym] = w.status === 'fulfilled' ? w.value : null;
  }));
  const peersBySector = await peerJob;
  const pctOf = h => {   // percentile of the holding's 3-month return within its sector peers
    const peers = peersBySector[secOf(h)], row = tv[h.sym];
    if (!peers || peers.length < 5 || !row || row['Perf.3M'] == null) return null;
    return Math.round(peers.filter(p => p < row['Perf.3M']).length / peers.length * 100);
  };
  const rows = holdings.map(h => scoreHolding(h, tv[h.sym], funds[h.sym],
    { peerPct: pctOf(h), senti: sentis[h.sym], swot: swots[h.sym] })).filter(r => !r.error);
  const errors = holdings.length - rows.length;
  if (!rows.length) throw new Error('TradingView returned no data for these symbols — check the tickers');
  rows.forEach(r => {
    r.value = +(r.price * r.qty).toFixed(2);
    if (r.buy != null) { r.invested = +(r.buy * r.qty).toFixed(2); r.pnl = +(r.value - r.invested).toFixed(2); r.pnlPct = r.invested ? +(r.pnl / r.invested * 100).toFixed(2) : null; }
  });
  const totalValue = rows.reduce((a, r) => a + r.value, 0);
  rows.forEach(r => r.weight = totalValue ? +(r.value / totalValue * 100).toFixed(2) : 0);
  const w = r => (totalValue ? r.value / totalValue : 0);
  const withBuy = rows.filter(r => r.invested != null);
  const investedValue = withBuy.reduce((a, r) => a + r.invested, 0);
  const pnl = withBuy.reduce((a, r) => a + r.pnl, 0);
  const hasPnl = withBuy.length > 0, partialPnl = hasPnl && withBuy.length < rows.length;
  const dayPct = rows.reduce((a, r) => a + w(r) * r.dayPct, 0);
  const pctAbove200 = rows.reduce((a, r) => a + (r.above200 ? w(r) * 100 : 0), 0);
  const weightedVol = rows.reduce((a, r) => a + (r.vol != null ? w(r) * r.vol : 0), 0);
  const weightedComposite = rows.reduce((a, r) => a + w(r) * r.composite, 0);
  // ── risk metrics ──
  const betaRows = rows.filter(r => r.beta != null);
  const betaW = betaRows.reduce((a, r) => a + w(r), 0);
  const weightedBeta = betaW ? +(betaRows.reduce((a, r) => a + w(r) * r.beta, 0) / betaW).toFixed(2) : null;
  // 1-day 95% parametric VaR from weighted vol — assumes fully-correlated moves, so a conservative bound
  const var95Pct = weightedVol ? +(weightedVol / Math.sqrt(252) * 1.645).toFixed(2) : null;
  const var95 = var95Pct != null ? +(totalValue * var95Pct / 100).toFixed(0) : null;
  // per-holding contribution to portfolio volatility (weight × vol share)
  const rcTot = rows.reduce((a, r) => a + w(r) * (r.vol != null ? r.vol : weightedVol || 0), 0);
  rows.forEach(r => r.riskShare = rcTot ? +((w(r) * (r.vol != null ? r.vol : weightedVol)) / rcTot * 100).toFixed(1) : null);
  const topRisk = rows.reduce((m, r) => ((r.riskShare || 0) > (m.riskShare || 0) ? r : m), {});
  const avgFromHigh = +rows.reduce((a, r) => a + w(r) * (r.fromHigh != null ? r.fromHigh : 0), 0).toFixed(1);
  // ── fundamental quality aggregate (over covered = non-bank holdings with filings data) ──
  const qRows = rows.filter(r => r.quality != null);
  const qW = qRows.reduce((a, r) => a + w(r), 0);
  const weightedQuality = qW ? Math.round(qRows.reduce((a, r) => a + w(r) * r.quality, 0) / qW) : null;
  const secMap = {};
  rows.forEach(r => { secMap[r.sector] = (secMap[r.sector] || 0) + r.value; });
  const sectors = Object.entries(secMap).map(([sector, value]) => ({ sector, value: +value.toFixed(2), weight: totalValue ? +(value / totalValue * 100).toFixed(2) : 0 })).sort((a, b) => b.value - a.value);
  const hhi = rows.reduce((a, r) => a + w(r) * w(r), 0);
  const effectiveStocks = hhi ? +(1 / hhi).toFixed(1) : rows.length;
  const secHhi = sectors.reduce((a, s) => a + (s.weight / 100) ** 2, 0);
  const effectiveSectors = secHhi ? +(1 / secHhi).toFixed(1) : sectors.length;
  // correlated clusters: 2+ names in one sector = a single bet in a drawdown, worse if high-beta
  const clusters = Object.values(rows.reduce((m, r) => {
    const c = m[r.sector] = m[r.sector] || { sector: r.sector, weight: 0, syms: [], betas: [] };
    c.weight += r.weight; c.syms.push(r.sym); if (r.beta != null) c.betas.push(r.beta);
    return m;
  }, {})).filter(c => c.syms.length >= 2)
    .map(c => ({ sector: c.sector, weight: +c.weight.toFixed(1), syms: c.syms,
      avgBeta: c.betas.length ? +(c.betas.reduce((a, b) => a + b, 0) / c.betas.length).toFixed(2) : null }))
    .sort((a, b) => b.weight - a.weight);
  const topHolding = rows.reduce((m, r) => (r.weight > m.weight ? r : m), { weight: 0, sym: '—' });
  const topSector = sectors[0] || { sector: '—', weight: 0 };
  const penalty = Math.max(0, topHolding.weight - 35) * 0.6 + Math.max(0, topSector.weight - 50) * 0.4 + Math.max(0, 3 - effectiveStocks) * 4;
  const score = Math.round(Math.max(0, Math.min(100, weightedComposite - penalty)));
  const grade = score >= 85 ? 'A+' : score >= 78 ? 'A' : score >= 70 ? 'B+' : score >= 62 ? 'B' : score >= 54 ? 'C' : score >= 45 ? 'D' : 'F';
  const flags = [];
  if (topHolding.weight >= 35) flags.push({ tone: 'bad', text: `Concentrated: ${topHolding.sym} is ${topHolding.weight}% of the portfolio` });
  if (topSector.weight >= 50) flags.push({ tone: 'bad', text: `Sector concentration: ${topSector.weight}% in ${topSector.sector}` });
  if (effectiveStocks < 3) flags.push({ tone: 'warn', text: `Low diversification — effectively only ${effectiveStocks} stocks` });
  const down = rows.filter(r => !r.above200);
  if (down.length) flags.push({ tone: down.length >= rows.length / 2 ? 'bad' : 'warn', text: `${down.length} holding(s) below the 200-DMA (downtrend): ${down.slice(0, 5).map(r => r.sym).join(', ')}` });
  if (weightedVol >= 35) flags.push({ tone: 'warn', text: `High volatility — weighted ~${weightedVol.toFixed(0)}% annualised` });
  if (weightedBeta != null && weightedBeta >= 1.25) flags.push({ tone: 'warn', text: `High market sensitivity — weighted beta ${weightedBeta}: the portfolio amplifies index moves ~${Math.round((weightedBeta - 1) * 100)}%` });
  if (topRisk.riskShare >= 40 && rows.length > 2) flags.push({ tone: 'warn', text: `${topRisk.sym} alone drives ~${Math.round(topRisk.riskShare)}% of portfolio volatility` });
  const weakFund = rows.filter(r => r.fscore != null && r.fscore <= 3);
  if (weakFund.length) flags.push({ tone: 'bad', text: `Weak fundamentals (Piotroski F ≤ 3): ${weakFund.map(r => `${r.sym} (F${r.fscore})`).join(', ')}` });
  const distress = rows.filter(r => r.zZone === 'weak');
  if (distress.length) flags.push({ tone: 'bad', text: `Balance-sheet distress zone (Altman Z″): ${distress.map(r => `${r.sym} (Z ${r.z})`).join(', ')}` });
  const poorAccruals = rows.filter(r => r.accrualsFlag === 'weak');
  if (poorAccruals.length) flags.push({ tone: 'warn', text: `Earnings not cash-backed (high accruals): ${poorAccruals.map(r => r.sym).join(', ')}` });
  clusters.filter(c => c.weight >= 30 && (c.avgBeta == null || c.avgBeta >= 1.05)).forEach(c =>
    flags.push({ tone: 'warn', text: `Correlated cluster — ${c.syms.length} ${c.sector} names are ${c.weight}% of the portfolio${c.avgBeta != null ? ` at avg β ${c.avgBeta}` : ''}: ${c.syms.join(', ')} will tend to draw down together` }));
  const badNews = rows.filter(r => r.senti && r.senti.basis === 'relevant' && r.senti.score10 <= 3.5);
  if (badNews.length) flags.push({ tone: 'warn', text: `Negative news flow: ${badNews.map(r => `${r.sym} (${r.senti.score10}/10)`).join(', ')}` });
  const threatened = rows.filter(r => r.swot && (r.swot.threats >= 5 || (r.swot.threats >= 3 && r.swot.threats > r.swot.strengths)));
  if (threatened.length) flags.push({ tone: 'warn', text: `Elevated SWOT threats (Trendlyne): ${threatened.map(r => `${r.sym} (${r.swot.threats} threats vs ${r.swot.strengths} strengths)`).join(', ')}` });
  if (!flags.length) flags.push({ tone: 'good', text: 'No concentration, trend, risk, fundamental, news or SWOT red-flags detected' });
  // rules-based position-sizing hints from score × weight × concentration
  rows.forEach(r => {
    if (r.weight >= 35) r.action = { verb: 'TRIM', reason: `${r.weight}% in one name — concentration risk${r.composite < 55 ? ` on a ${r.composite}-score holding` : ''}` };
    else if (r.weight >= 20 && r.composite < 55) r.action = { verb: 'TRIM', reason: `${r.weight}% weight on a ${r.composite}-score holding` };
    else if (r.composite < 40) r.action = { verb: 'REVIEW', reason: `weak composite ${r.composite}` + (r.fscore != null && r.fscore <= 3 ? `, weak fundamentals (F${r.fscore})` : '') + (!r.above200 ? ', below 200-DMA' : '') };
    else if (r.composite >= 72 && r.weight < 8) r.action = { verb: 'STRONG', reason: `scores ${r.composite} but is only ${r.weight}% of the portfolio — strongest candidate if adding` };
    else r.action = null;
  });
  rows.sort((a, b) => b.composite - a.composite);
  rows.forEach((r, i) => r.rank = i + 1);
  return {
    asOf: new Date().toISOString(), count: rows.length, errors,
    totalValue: +totalValue.toFixed(2), investedValue: hasPnl ? +investedValue.toFixed(2) : null,
    pnl: hasPnl ? +pnl.toFixed(2) : null, pnlPct: hasPnl && investedValue ? +(pnl / investedValue * 100).toFixed(2) : null, hasPnl, partialPnl,
    dayPct: +dayPct.toFixed(2), score, grade, weightedComposite: +weightedComposite.toFixed(1),
    diversification: { holdings: rows.length, effectiveStocks, effectiveSectors, topHolding: topHolding.sym, topHoldingWeight: topHolding.weight, topSector: topSector.sector, topSectorWeight: topSector.weight, clusters },
    risk: { weightedVol: +weightedVol.toFixed(1), pctAbove200: +pctAbove200.toFixed(0), weightedBeta, var95, var95Pct,
      topRiskSym: topRisk.sym || null, topRiskShare: topRisk.riskShare || null, avgFromHigh },
    quality: { weightedQuality, covered: qRows.length, of: rows.length },
    sectors, flags, holdings: rows,
  };
}

// ─────────── fundamentals → ratio engine (REAL reported figures) ───────────
// Yahoo's fundamentals-timeseries returns raw annual balance-sheet / income-statement
// line items; we compute the ratios ourselves so every number traces to a filing.
// quoteSummary (needs a crumb) supplies current-snapshot valuation (P/E, payout).

let _yCrumb = null, _yCookie = null, _yCrumbAt = 0;
async function yahooCrumb() {
  if (_yCrumb && _yCookie && Date.now() - _yCrumbAt < 3600e3) return { crumb: _yCrumb, cookie: _yCookie };
  try {
    const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } });
    const sc = typeof r1.headers.getSetCookie === 'function'
      ? r1.headers.getSetCookie()
      : (r1.headers.get('set-cookie') ? [r1.headers.get('set-cookie')] : []);
    const cookie = sc.map(c => c.split(';')[0]).join('; ');
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, 'Cookie': cookie } });
    const crumb = (await r2.text()).trim();
    if (crumb && !crumb.includes('<') && crumb.length < 40) { _yCrumb = crumb; _yCookie = cookie; _yCrumbAt = Date.now(); return { crumb, cookie }; }
  } catch (e) { /* fall through → null */ }
  return null;
}

const TS_FIELDS = [
  'annualTotalRevenue', 'annualNetIncome', 'annualOperatingIncome', 'annualEBIT', 'annualPretaxIncome',
  'annualInterestExpense', 'annualStockholdersEquity', 'annualTotalAssets', 'annualCurrentAssets',
  'annualCurrentLiabilities', 'annualTotalDebt',
  // extra line items for the forensic / quality scores (Piotroski F, Altman Z″, accruals)
  'annualOperatingCashFlow', 'annualGrossProfit', 'annualRetainedEarnings',
  'annualTotalLiabilitiesNetMinorityInterest', 'annualOrdinarySharesNumber', 'annualLongTermDebt',
];
async function yahooTimeseries(ticker) {
  const type = TS_FIELDS.join(',');
  const p2 = Math.floor(Date.now() / 1000), p1 = p2 - 8 * 366 * 86400;   // ~8-year window
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}?symbol=${encodeURIComponent(ticker)}&type=${type}&period1=${p1}&period2=${p2}&merge=false`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      const arr = j && j.timeseries && j.timeseries.result;
      if (arr && arr.length) return arr;
    } catch (e) { /* next host */ }
  }
  return null;
}
async function yahooKeyStats(ticker) {
  const auth = await yahooCrumb();
  if (!auth) return null;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=defaultKeyStatistics,summaryDetail&crumb=${encodeURIComponent(auth.crumb)}`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': auth.cookie, 'Accept': 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      const res = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
      if (res) return res;
    } catch (e) { /* next host */ }
  }
  return null;
}

// fold the timeseries blocks into { fiscalYear: { LineItem: value } }
function tsByYear(result) {
  const byYear = {};
  for (const block of result) {
    const type = block.meta && block.meta.type && block.meta.type[0];
    if (!type) continue;
    const short = type.replace(/^annual/, '');
    const rows = block[type];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || !row.asOfDate || !row.reportedValue) continue;
      const yr = +row.asOfDate.slice(0, 4);
      (byYear[yr] = byYear[yr] || {})[short] = row.reportedValue.raw;
    }
  }
  return byYear;
}
function ebitOf(d) {
  if (d.EBIT != null) return d.EBIT;
  if (d.OperatingIncome != null) return d.OperatingIncome;
  if (d.PretaxIncome != null && d.InterestExpense != null) return d.PretaxIncome + Math.abs(d.InterestExpense);
  return null;
}
// ratio definitions: f() returns null when a required line item is absent
// (this is how bank-irrelevant ratios like Current Ratio auto-drop out).
const RATIO_DEFS = [
  { name: 'Return on Equity (ROE)', cat: 'Profitability', unit: '%', ideal: '> 15%', higher: true, good: 15, weak: 8,
    f: d => (d.NetIncome != null && d.StockholdersEquity) ? d.NetIncome / d.StockholdersEquity * 100 : null },
  { name: 'Return on Assets (ROA)', cat: 'Profitability', unit: '%', ideal: '> 5% (banks > 1.5%)', higher: true, good: 5, weak: 2,
    f: d => (d.NetIncome != null && d.TotalAssets) ? d.NetIncome / d.TotalAssets * 100 : null },
  { name: 'ROCE', cat: 'Profitability', unit: '%', ideal: '> 15%', higher: true, good: 15, weak: 8,
    f: d => { const e = ebitOf(d), cap = (d.TotalAssets != null && d.CurrentLiabilities != null) ? d.TotalAssets - d.CurrentLiabilities : null; return (e != null && cap) ? e / cap * 100 : null; } },
  { name: 'Net Profit Margin', cat: 'Profitability', unit: '%', ideal: '> 10%', higher: true, good: 12, weak: 5,
    f: d => (d.NetIncome != null && d.TotalRevenue) ? d.NetIncome / d.TotalRevenue * 100 : null },
  { name: 'Operating (EBIT) Margin', cat: 'Profitability', unit: '%', ideal: '> 15%', higher: true, good: 15, weak: 7,
    f: d => { const e = ebitOf(d); return (e != null && d.TotalRevenue) ? e / d.TotalRevenue * 100 : null; } },
  { name: 'Current Ratio', cat: 'Liquidity & Solvency', unit: 'x', ideal: '1.5 – 3.0', higher: true, good: 1.5, weak: 1.0,
    f: d => (d.CurrentAssets != null && d.CurrentLiabilities) ? d.CurrentAssets / d.CurrentLiabilities : null },
  { name: 'Debt-to-Equity', cat: 'Liquidity & Solvency', unit: 'x', ideal: '< 0.50', higher: false, good: 0.5, weak: 1.0,
    f: d => (d.TotalDebt != null && d.StockholdersEquity) ? d.TotalDebt / d.StockholdersEquity : null },
  { name: 'Interest Coverage', cat: 'Liquidity & Solvency', unit: 'x', ideal: '> 4x', higher: true, good: 4, weak: 1.5,
    f: d => { const e = ebitOf(d); return (e != null && d.InterestExpense) ? e / Math.abs(d.InterestExpense) : null; } },
  { name: 'Asset Turnover', cat: 'Efficiency', unit: 'x', ideal: '> 0.5', higher: true, good: 0.5, weak: 0.3,
    f: d => (d.TotalRevenue != null && d.TotalAssets) ? d.TotalRevenue / d.TotalAssets : null },
];
function verdictOf(def, v) {
  if (v == null) return 'avg';
  if (def.higher) return v >= def.good ? 'good' : (v < def.weak ? 'weak' : 'avg');
  return v <= def.good ? 'good' : (v > def.weak ? 'weak' : 'avg');
}
function round2(v, dp) { return (v == null || !isFinite(v)) ? null : +v.toFixed(dp); }

// ── Forensic / quality scores (computed from the SAME reported filings) ──
// All three are same-currency internal ratios → currency-safe even when Yahoo reports in USD.
function sdiv(a, b) { return (a != null && b) ? a / b : NaN; }   // NaN → comparisons fail safely
function computeForensics(byYear, allYears) {
  if (!allYears || !allYears.length) return null;
  const T = byYear[allYears[allYears.length - 1]];
  const P = allYears.length >= 2 ? byYear[allYears[allYears.length - 2]] : null;
  if (!T) return null;
  const out = { fy: allYears[allYears.length - 1] };

  // Piotroski F-Score (0–9): needs current + prior year
  if (P) {
    const checks = [];
    const ok = (c, label) => checks.push({ ok: c === true, label });
    const roaT = sdiv(T.NetIncome, T.TotalAssets), roaP = sdiv(P.NetIncome, P.TotalAssets);
    const ltdT = T.LongTermDebt != null ? T.LongTermDebt : T.TotalDebt;   // fallback for debt-free names
    const ltdP = P.LongTermDebt != null ? P.LongTermDebt : P.TotalDebt;
    ok(roaT > 0, 'Positive return on assets');
    ok(T.OperatingCashFlow > 0, 'Positive operating cash flow');
    ok(roaT > roaP, 'ROA improving year-on-year');
    ok(T.OperatingCashFlow != null && T.NetIncome != null && T.OperatingCashFlow > T.NetIncome, 'Cash flow exceeds profit (clean earnings)');
    ok(ltdT != null && ltdP != null && sdiv(ltdT, T.TotalAssets) < sdiv(ltdP, P.TotalAssets), 'Leverage falling');
    ok(sdiv(T.CurrentAssets, T.CurrentLiabilities) > sdiv(P.CurrentAssets, P.CurrentLiabilities), 'Current ratio improving');
    ok(T.OrdinarySharesNumber != null && P.OrdinarySharesNumber != null && T.OrdinarySharesNumber <= P.OrdinarySharesNumber * 1.002, 'No share dilution');
    ok(sdiv(T.GrossProfit, T.TotalRevenue) > sdiv(P.GrossProfit, P.TotalRevenue), 'Gross margin expanding');
    ok(sdiv(T.TotalRevenue, T.TotalAssets) > sdiv(P.TotalRevenue, P.TotalAssets), 'Asset turnover improving');
    const score = checks.filter(c => c.ok).length;
    out.piotroski = { score, max: 9, checks, verdict: score >= 7 ? 'good' : (score >= 4 ? 'avg' : 'weak') };
  }

  // Altman Z″-Score (emerging-market, book-value variant → no FX mismatch)
  {
    const TL = T.TotalLiabilitiesNetMinorityInterest != null ? T.TotalLiabilitiesNetMinorityInterest
             : (T.StockholdersEquity != null && T.TotalAssets != null ? T.TotalAssets - T.StockholdersEquity : null);
    const ebit = T.EBIT != null ? T.EBIT : (T.OperatingIncome != null ? T.OperatingIncome : T.PretaxIncome);
    if (T.TotalAssets && TL && ebit != null && T.RetainedEarnings != null &&
        T.CurrentAssets != null && T.CurrentLiabilities != null && T.StockholdersEquity != null) {
      const X1 = (T.CurrentAssets - T.CurrentLiabilities) / T.TotalAssets;
      const X2 = T.RetainedEarnings / T.TotalAssets;
      const X3 = ebit / T.TotalAssets;
      const X4 = T.StockholdersEquity / TL;
      const z = 3.25 + 6.56 * X1 + 3.26 * X2 + 6.72 * X3 + 1.05 * X4;
      out.altman = { z: +z.toFixed(2), zone: z > 2.6 ? 'good' : (z >= 1.1 ? 'avg' : 'weak'),
        model: 'Z″ emerging-market (book-value) variant' };
    }
  }

  // Earnings quality — Sloan accruals: (NetIncome − CFO) / Assets; negative = cash-backed
  if (T.NetIncome != null && T.OperatingCashFlow != null && T.TotalAssets) {
    const accr = (T.NetIncome - T.OperatingCashFlow) / T.TotalAssets * 100;
    out.earningsQuality = {
      accrualsPct: +accr.toFixed(1),
      cashConversion: T.NetIncome ? +(T.OperatingCashFlow / T.NetIncome).toFixed(2) : null,
      flag: accr <= 2 ? 'good' : (accr <= 8 ? 'avg' : 'weak'),
    };
  }

  return (out.piotroski || out.altman || out.earningsQuality) ? out : null;
}

const _ratioCache = new Map();   // ticker -> { at, data }
async function computeRatios(ticker) {
  const hit = _ratioCache.get(ticker);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.data;   // 30-min cache
  const [ts, ks] = await Promise.all([yahooTimeseries(ticker), yahooKeyStats(ticker)]);
  if (!ts) return null;
  const byYear = tsByYear(ts);
  const allYears = Object.keys(byYear).map(Number).sort((a, b) => a - b).slice(-5);   // up to 5 latest FY
  if (!allYears.length) return null;
  const ratios = [];
  for (const def of RATIO_DEFS) {
    const years = [], trend = [];
    for (const y of allYears) {
      const v = def.f(byYear[y]);
      if (v != null && isFinite(v)) { years.push(y); trend.push(round2(v, def.unit === 'x' ? 2 : 1)); }
    }
    if (!trend.length) continue;   // ratio not computable for this company → skip
    ratios.push({ name: def.name, cat: def.cat, unit: def.unit, ideal: def.ideal, higher: def.higher,
      years, trend, current: trend[trend.length - 1], verdict: verdictOf(def, trend[trend.length - 1]) });
  }
  if (ks) {
    const dks = ks.defaultKeyStatistics || {}, sd = ks.summaryDetail || {};
    const pe = (sd.trailingPE && sd.trailingPE.raw) || (dks.trailingPE && dks.trailingPE.raw);
    if (pe) ratios.push({ name: 'P/E (TTM)', cat: 'Valuation', unit: 'x', ideal: 'context only', higher: false,
      years: [], trend: [round2(pe, 1)], current: round2(pe, 1), verdict: 'avg', single: true });
    const po = (sd.payoutRatio && sd.payoutRatio.raw != null) ? sd.payoutRatio.raw : (dks.payoutRatio && dks.payoutRatio.raw);
    if (po != null && po > 0 && po < 3) ratios.push({ name: 'Dividend Payout', cat: 'Shareholder Returns', unit: '%', ideal: 'varies by sector', higher: true,
      years: [], trend: [round2(po * 100, 1)], current: round2(po * 100, 1), verdict: 'avg', single: true });
  }
  if (!ratios.length) return null;
  const data = { symbol: ticker, years: allYears, latestFY: allYears[allYears.length - 1],
    currency: (ts[0] && ts[0][ts[0].meta.type[0]] && ts[0][ts[0].meta.type[0]][0] && ts[0][ts[0].meta.type[0]][0].reportedValue && ts[0][ts[0].meta.type[0]][0].currencyCode) || null,
    ratios, forensics: computeForensics(byYear, allYears), source: 'live', asOf: new Date().toISOString() };
  _ratioCache.set(ticker, { at: Date.now(), data });
  return data;
}

// ═══════════════ PRO ENGINES (Jul 2026): delivery, flows, earnings, peers, thesis, backtest ═══════════════

// ---------- NSE cookie-authed JSON API (main-site endpoints need a browser-like cookie) ----------
// The homepage sets the required cookies even when it responds 403 (Akamai) — verified live.
let _nseCk = null, _nseCkAt = 0;
async function nseCookie(force) {
  if (!force && _nseCk && Date.now() - _nseCkAt < 10 * 60e3) return _nseCk;
  try {
    const r = await fetch('https://www.nseindia.com/', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-US,en;q=0.9' } });
    const sc = typeof r.headers.getSetCookie === 'function'
      ? r.headers.getSetCookie()
      : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : []);
    const ck = sc.map(c => c.split(';')[0]).join('; ');
    if (ck) { _nseCk = ck; _nseCkAt = Date.now(); }
  } catch (e) { /* keep old cookie */ }
  return _nseCk;
}
async function nseApi(pathname, referer) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ck = await nseCookie(attempt > 0);
    try {
      const r = await fetch('https://www.nseindia.com' + pathname, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': referer || 'https://www.nseindia.com/',
                   ...(ck ? { 'Cookie': ck } : {}) } });
      if (r.ok) return await r.json();
    } catch (e) { /* retry with fresh cookie */ }
  }
  throw new Error('NSE API unavailable: ' + pathname);
}
const MON3 = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function nseDateMs(s) {           // '03-Jul-2026' / '03-JUL-2026' → UTC ms
  const p = String(s || '').split('-');
  if (p.length !== 3) return 0;
  const m = MON3[p[1].slice(0, 3).toLowerCase()];
  return m == null ? 0 : Date.UTC(+p[2], m, +p[0]);
}

// ---------- Delivery % + volume analytics (NSE daily bhavcopy, free CSV) ----------
// sec_bhavdata_full_DDMMYYYY.csv has per-stock DELIV_QTY / DELIV_PER — the cash-market
// conviction signal (delivered shares = taken home, not intraday churn). One file covers the
// whole market, so we cache each day once on disk and every per-stock/scan lookup is free.
const pad2 = n => String(n).padStart(2, '0');
function bhavKey(d) { return pad2(d.getDate()) + pad2(d.getMonth() + 1) + d.getFullYear(); }
const _bhav = {};                          // key -> { rows, iso } | { h:1 } (holiday/no file)
async function loadBhavDay(d) {
  const key = bhavKey(d);
  if (_bhav[key]) return _bhav[key];
  const disk = cacheLoad('bhav_' + key);
  if (disk.rows || disk.h) { _bhav[key] = disk; return disk; }
  let out = null;
  try {
    const r = await fetch(`https://archives.nseindia.com/products/content/sec_bhavdata_full_${key}.csv`,
      { headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*', 'Referer': 'https://www.nseindia.com/' } });
    if (r.ok) {
      const rows = {};
      for (const line of (await r.text()).split(/\r?\n/).slice(1)) {
        const p = line.split(',').map(x => x.trim());
        if (p.length < 15 || p[1] !== 'EQ') continue;   // EQ series only (skip BE/SM/…)
        rows[p[0]] = { c: +p[8], pc: +p[3], v: +p[10], tr: +p[12], dq: +p[13] || 0, dp: p[14] === '-' ? null : +p[14] };
      }
      if (Object.keys(rows).length > 200)
        out = { rows, iso: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` };
    }
  } catch (e) { /* treated as missing below */ }
  if (!out) {
    const miss = { h: 1 };
    _bhav[key] = miss;
    if (Date.now() - d.getTime() > 2 * 86400e3) cacheSave('bhav_' + key, miss);   // real holiday → never refetch
    else setTimeout(() => { if (_bhav[key] === miss) delete _bhav[key]; }, 45 * 60e3);   // today's file may not be out yet
    return miss;
  }
  _bhav[key] = out;
  cacheSave('bhav_' + key, out);
  return out;
}
// last `n` trading days of bhav data, oldest → newest (fetches only what's missing)
async function ensureBhavDays(n) {
  const want = n || 26;
  const cands = [];
  const d = new Date();
  for (let i = 0; i < 55 && cands.length < want + 14; i++) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
    if (day.getDay() !== 0 && day.getDay() !== 6) cands.push(day);
  }
  const loaded = await pool(cands, 4, day => loadBhavDay(day));
  return loaded.filter(x => x && x.rows).sort((a, b) => a.iso < b.iso ? -1 : 1).slice(-want);
}
// per-stock delivery & volume conviction read
async function deliveryAnalytics(sym) {
  const days = await ensureBhavDays(26);
  const pts = [];
  for (const day of days) {
    const r = day.rows[sym];
    if (r && r.c > 0) pts.push({ date: day.iso, close: r.c, chg: r.pc ? +((r.c - r.pc) / r.pc * 100).toFixed(2) : 0,
      vol: r.v, delivQty: r.dq, delivPer: r.dp, trades: r.tr });
  }
  if (pts.length < 6) return null;
  const last = pts[pts.length - 1], prior = pts.slice(0, -1);
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const avgVol = avg(prior.map(p => p.vol));
  const dpPrior = prior.map(p => p.delivPer).filter(v => v != null);
  const avgDp = dpPrior.length ? avg(dpPrior) : null;
  const volX = avgVol ? +(last.vol / avgVol).toFixed(2) : null;
  const delivX = (avgDp && last.delivPer != null) ? +(last.delivPer / avgDp).toFixed(2) : null;
  const up = last.chg >= 0.4, down = last.chg <= -0.4;
  const highVol = volX != null && volX >= 1.5, highDp = delivX != null && delivX >= 1.15, lowDp = delivX != null && delivX <= 0.8;
  let signal;
  if (up && highVol && highDp) signal = { tone: 'good', label: 'Strong accumulation',
    text: `Price up ${last.chg}% on ${volX}× normal volume with delivery at ${last.delivPer}% vs a ${avgDp.toFixed(1)}% average — buyers are taking delivery, not day-trading. High-conviction move.` };
  else if (up && highVol && lowDp) signal = { tone: 'warn', label: 'Speculative rally',
    text: `Price up ${last.chg}% on ${volX}× volume but delivery is only ${last.delivPer}% vs a ${avgDp ? avgDp.toFixed(1) : '—'}% average — mostly intraday churn. Weak-conviction rally that can reverse fast.` };
  else if (down && highVol && highDp) signal = { tone: 'bad', label: 'Distribution',
    text: `Price down ${last.chg}% on ${volX}× volume with elevated ${last.delivPer}% delivery — holders are exiting with conviction, not just intraday selling.` };
  else if (down && highVol) signal = { tone: 'warn', label: 'High-churn selloff',
    text: `Price down ${last.chg}% on ${volX}× volume with ${last.delivPer != null ? last.delivPer + '%' : 'average'} delivery — heavy trading but conviction is unclear.` };
  else if (highDp && !down) signal = { tone: 'good', label: 'Quiet accumulation',
    text: `Delivery ${last.delivPer}% vs a ${avgDp.toFixed(1)}% average on normal volume — shares are moving into stronger hands without headline volume.` };
  else signal = { tone: 'neutral', label: 'No unusual activity',
    text: `Volume ${volX != null ? volX + '× ' : ''}and delivery ${last.delivPer != null ? last.delivPer + '%' : '—'} are near their 20-session norms — nothing anomalous in the cash market today.` };
  return { sym, days: pts,
    latest: { ...last, volX, delivX, avgVol: Math.round(avgVol), avgDelivPer: avgDp != null ? +avgDp.toFixed(1) : null },
    signal, asOf: last.date };
}
// market-wide delivery-conviction scanner — reuses the cached bhav days, zero extra network
const _spikeCache = new Map();
async function deliverySpikes(uni) {
  const hit = _spikeCache.get(uni);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.data;
  const days = await ensureBhavDays(26);
  if (days.length < 8) throw new Error('delivery history still warming up — try again in a minute');
  const lastDay = days[days.length - 1];
  const rows = [];
  for (const st of universe(uni)) {
    const cur = lastDay.rows[st.sym];
    if (!cur || !(cur.v > 50000) || cur.dp == null) continue;
    const hist = days.slice(0, -1).map(d => d.rows[st.sym]).filter(Boolean);
    if (hist.length < 6) continue;
    const avgVol = hist.reduce((a, r) => a + r.v, 0) / hist.length;
    const dps = hist.map(r => r.dp).filter(v => v != null);
    if (!avgVol || dps.length < 6) continue;
    const avgDp = dps.reduce((a, b) => a + b, 0) / dps.length;
    const volX = +(cur.v / avgVol).toFixed(2);
    const delivX = avgDp ? +(cur.dp / avgDp).toFixed(2) : null;
    if (volX < 1.3 || delivX == null || delivX < 1.05) continue;   // need BOTH volume and delivery above norm
    const chg = cur.pc ? +((cur.c - cur.pc) / cur.pc * 100).toFixed(2) : 0;
    rows.push({ sym: st.sym, name: st.name, sector: st.sector, close: cur.c, chg,
      delivPer: cur.dp, avgDelivPer: +avgDp.toFixed(1), volX, delivX, score: +(volX * delivX).toFixed(2) });
  }
  rows.sort((a, b) => b.score - a.score);
  const data = { uni, date: lastDay.iso, count: rows.length,
    accumulation: rows.filter(r => r.chg >= 0).slice(0, 10), distribution: rows.filter(r => r.chg < 0).slice(0, 10),
    asOf: new Date().toISOString() };
  _spikeCache.set(uni, { at: Date.now(), data });
  return data;
}

// ---------- FII / DII flows (NSE, live; history accrues locally day by day) ----------
// NSE's free endpoint returns only the latest session, so we archive each day we see to disk —
// the history chart grows automatically the longer the server keeps being used.
let _fiidii = cacheLoad('fiidii');
if (!_fiidii.hist) _fiidii = { hist: {}, at: 0 };
async function fiidiiFlows() {
  if (Date.now() - (_fiidii.at || 0) > 30 * 60e3) {
    try {
      const j = await nseApi('/api/fiidiiTradeReact', 'https://www.nseindia.com/reports-indices-fii-dii');
      for (const row of (Array.isArray(j) ? j : [])) {
        if (!row || !row.date) continue;
        const cat = /FII|FPI/i.test(row.category || '') ? 'fii' : 'dii';
        const rec = _fiidii.hist[row.date] = _fiidii.hist[row.date] || {};
        rec[cat] = { b: +row.buyValue, s: +row.sellValue, n: +row.netValue };
      }
      _fiidii.at = Date.now();
      cacheSave('fiidii', _fiidii);
    } catch (e) { /* serve accumulated history */ }
  }
  const history = Object.entries(_fiidii.hist)
    .map(([date, v]) => ({ date, ms: nseDateMs(date), fii: v.fii || null, dii: v.dii || null }))
    .filter(x => x.ms).sort((a, b) => a.ms - b.ms).slice(-60);
  return { history, latest: history[history.length - 1] || null,
    daysTracked: history.length, asOf: new Date().toISOString() };
}

// ---------- Bulk & block deals (NSE archives CSV = today's deals; accumulated to disk) ----------
function csvSplit(line) {              // quote-aware CSV split (client names contain commas)
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
let _deals = cacheLoad('deals');
if (!_deals.rows) _deals = { rows: [], at: 0 };
async function fetchDealsCsv(type) {
  const r = await fetch(`https://archives.nseindia.com/content/equities/${type}.csv`,
    { headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*', 'Referer': 'https://www.nseindia.com/' } });
  if (!r.ok) return [];
  return (await r.text()).trim().split(/\r?\n/).slice(1).map(csvSplit)
    .filter(p => p.length >= 7 && p[0] && p[0].trim() !== 'NO RECORDS' && nseDateMs(p[0].trim()))
    .map(p => ({ date: p[0].trim(), sym: p[1].trim(), name: p[2].trim(), client: p[3].trim(),
      side: /^b/i.test(p[4].trim()) ? 'BUY' : 'SELL',
      qty: +String(p[5]).replace(/[^\d]/g, '') || 0, price: +p[6] || null, type }));
}
async function dealsData() {
  if (Date.now() - (_deals.at || 0) > 60 * 60e3) {
    try {
      const [bulk, block] = await Promise.all([fetchDealsCsv('bulk'), fetchDealsCsv('block')]);
      const fresh = [...bulk, ...block];
      if (fresh.length) {
        const keyOf = r => [r.date, r.type, r.sym, r.client, r.side, r.qty].join('|');
        const seen = new Set(_deals.rows.map(keyOf));
        for (const r of fresh) { const k = keyOf(r); if (!seen.has(k)) { _deals.rows.push(r); seen.add(k); } }
        const cutoff = Date.now() - 30 * 86400e3;                     // keep a rolling 30 days
        _deals.rows = _deals.rows.filter(r => nseDateMs(r.date) >= cutoff);
      }
      _deals.at = Date.now();
      cacheSave('deals', _deals);
    } catch (e) { /* serve accumulated deals */ }
  }
  const known = new Set(STOCKS.map(s => s.sym));
  const rows = _deals.rows.slice().sort((a, b) => nseDateMs(b.date) - nseDateMs(a.date) || b.qty * (b.price || 0) - a.qty * (a.price || 0))
    .map(r => ({ ...r, inUniverse: known.has(r.sym) }));
  const daysTracked = new Set(rows.map(r => r.date)).size;
  return { rows: rows.slice(0, 200), daysTracked, asOf: new Date().toISOString() };
}

// ---------- Earnings: next date + historical results-reaction tracker ----------
async function yahooQuoteSummary(ticker, modules) {
  const auth = await yahooCrumb();
  if (!auth) return null;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': auth.cookie, 'Accept': 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      const res = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
      if (res) return res;
    } catch (e) { /* next host */ }
  }
  return null;
}
// ---------- Company leadership (key executives) from Yahoo assetProfile ----------
// Yahoo's companyOfficers gives verified NAMES + TITLES of the top management. It does NOT
// carry LinkedIn URLs — no free feed does, and guessing profile slugs would mislink people —
// so the client turns each name into a LinkedIn people-SEARCH deep link (accurate, not fabricated).
const _mgmtMem = {};
async function companyManagement(sym) {
  const st = resolveStock(sym);
  const ticker = st.yh;
  const key = 'mgmt_' + ticker.replace(/[^A-Za-z0-9]/g, '_');
  if (_mgmtMem[ticker] && Date.now() - _mgmtMem[ticker].at < 24 * 3600e3) return _mgmtMem[ticker].data;
  const disk = cacheLoad(key);
  if (disk.at && disk.data && Date.now() - disk.at < 24 * 3600e3) { _mgmtMem[ticker] = disk; return disk.data; }
  const res = await yahooQuoteSummary(ticker, 'assetProfile');
  const ap = (res && res.assetProfile) || {};
  const seen = new Set();
  const officers = (ap.companyOfficers || [])
    .map(o => ({ name: (o.name || '').replace(/\s+/g, ' ').trim(), title: (o.title || '').replace(/\s+/g, ' ').trim(), age: o.age || null }))
    .filter(o => o.name && !seen.has(o.name) && seen.add(o.name))
    // put the C-suite / chairs first, then the rest
    .sort((a, b) => mgmtRank(a.title) - mgmtRank(b.title));
  const data = {
    sym: st.sym, company: st.name || sym, ticker,
    website: ap.website || null, industry: ap.industry || st.sector || null,
    officers, source: officers.length ? 'Yahoo Finance' : null, asOf: new Date().toISOString(),
  };
  _mgmtMem[ticker] = { at: Date.now(), data };
  cacheSave(key, _mgmtMem[ticker]);
  return data;
}
function mgmtRank(title) {
  const t = (title || '').toLowerCase();
  if (/chair|chief exec|\bceo\b|managing director|\bmd\b|founder|president/.test(t)) return 0;
  if (/chief financ|\bcfo\b|chief operat|\bcoo\b|chief tech|\bcto\b|whole.?time|executive director/.test(t)) return 1;
  if (/chief|officer|\bvp\b|vice president|head/.test(t)) return 2;
  if (/director/.test(t)) return 3;
  return 4;
}

// Yahoo's visualization API = real report DATETIMES + EPS est/actual/surprise (what yfinance
// uses for get_earnings_dates). For NSE names it can lag the most recent quarters — those are
// filled from earningsHistory (period-end only, no reaction) and labeled accordingly.
async function yahooEarningsDates(ticker) {
  const auth = await yahooCrumb();
  if (!auth) return [];
  const body = JSON.stringify({ size: 24,
    query: { operator: 'and', operands: [{ operator: 'eq', operands: ['ticker', ticker] }] },
    sortField: 'startdatetime', sortType: 'DESC', entityIdType: 'earnings',
    includeFields: ['ticker', 'startdatetime', 'startdatetimetype', 'epsestimate', 'epsactual', 'epssurprisepct'] });
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`https://${host}/v1/finance/visualization?crumb=${encodeURIComponent(auth.crumb)}`,
        { method: 'POST', headers: { 'User-Agent': UA, 'Cookie': auth.cookie, 'Content-Type': 'application/json' }, body });
      if (!r.ok) continue;
      const j = await r.json();
      const doc = j && j.finance && j.finance.result && j.finance.result[0] && j.finance.result[0].documents && j.finance.result[0].documents[0];
      if (doc && doc.rows) return doc.rows.map(row => ({ ms: Date.parse(row[1]), type: row[2],
        epsEst: row[3], epsAct: row[4], surprise: row[5] })).filter(x => x.ms);
    } catch (e) { /* next host */ }
  }
  return [];
}
const _earnCache = new Map();
async function earningsReport(sym) {
  const hit = _earnCache.get(sym);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.data;
  const st = resolveStock(sym);
  const [qs, viz, chart] = await Promise.all([
    yahooQuoteSummary(st.yh, 'calendarEvents,earningsHistory'),
    yahooEarningsDates(st.yh).catch(() => []),
    yahooChart(st.yh, '1d', '5y'),
  ]);
  let next = null;
  const ce = qs && qs.calendarEvents && qs.calendarEvents.earnings;
  if (ce && ce.earningsDate && ce.earningsDate.length) {
    next = { dates: ce.earningsDate.map(x => x.fmt).filter(Boolean), estimate: !!ce.isEarningsDateEstimate };
    const ms = (ce.earningsDate[0].raw || 0) * 1000;
    if (ms) next.daysTo = Math.round((ms - Date.now()) / 86400e3);
  }
  // split-adjusted closes aligned with timestamps (for report-date reactions)
  const ts = [], closes = [];
  if (chart) {
    const q = (chart.indicators.quote[0] || {});
    const splits = effectiveSplits(chart);
    const raw = q.close || [], tss = chart.timestamp || [];
    for (let i = 0; i < tss.length; i++) {
      let v = raw[i];
      if (v == null || isNaN(v)) continue;
      let f = 1;
      for (const sp of splits) if (sp.date > tss[i] && sp.numerator && sp.denominator) f *= sp.denominator / sp.numerator;
      ts.push(tss[i] * 1000); closes.push(v * f);
    }
  }
  // reaction for each PAST report datetime: base = last session whose CLOSE printed before the
  // announcement (NSE close 15:30 IST = daily bar open-ts + 6h15m), react over next 1 / 5 closes
  const rows = [];
  const nowMs = Date.now();
  for (const ev of viz.filter(v => v.ms <= nowMs)) {
    let base = -1;
    for (let i = 0; i < ts.length; i++) { if (ts[i] + 6.25 * 3600e3 <= ev.ms) base = i; else break; }
    const r1 = (base >= 0 && closes[base + 1] != null) ? +((closes[base + 1] / closes[base] - 1) * 100).toFixed(2) : null;
    const r5 = (base >= 0 && closes[base + 5] != null) ? +((closes[base + 5] / closes[base] - 1) * 100).toFixed(2) : null;
    rows.push({ date: new Date(ev.ms).toISOString().slice(0, 10), ms: ev.ms,
      epsEst: ev.epsEst, epsAct: ev.epsAct, surprise: ev.surprise != null ? +(+ev.surprise).toFixed(2) : null,
      react1d: r1, react5d: r5, exact: true });
  }
  // recent quarters the visualization feed hasn't caught up on → EPS surprise only, no reaction
  const eh = qs && qs.earningsHistory && qs.earningsHistory.history;
  if (eh) {
    const newest = rows.length ? Math.max(...rows.map(r => r.ms)) : 0;
    for (const h of eh) {
      const qms = (h.quarter && h.quarter.raw || 0) * 1000;
      if (!qms || qms <= newest) continue;   // already covered by an exact report date
      rows.push({ date: h.quarter.fmt, ms: qms,
        epsEst: h.epsEstimate && h.epsEstimate.raw, epsAct: h.epsActual && h.epsActual.raw,
        surprise: h.surprisePercent && h.surprisePercent.raw != null ? +(h.surprisePercent.raw * 100).toFixed(2) : null,
        react1d: null, react5d: null, exact: false, periodEnd: true });
    }
  }
  rows.sort((a, b) => b.ms - a.ms);
  const reacted = rows.filter(r => r.react1d != null);
  let stats = null;
  if (reacted.length >= 3) {
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    const beats = reacted.filter(r => r.surprise != null && r.surprise > 0);
    const misses = reacted.filter(r => r.surprise != null && r.surprise < 0);
    stats = { events: reacted.length,
      avgAbs1d: +avg(reacted.map(r => Math.abs(r.react1d))).toFixed(2),
      avgBeat1d: beats.length ? +avg(beats.map(r => r.react1d)).toFixed(2) : null, beats: beats.length,
      avgMiss1d: misses.length ? +avg(misses.map(r => r.react1d)).toFixed(2) : null, misses: misses.length,
      avgDrift5d: +avg(reacted.filter(r => r.react5d != null).map(r => r.react5d)).toFixed(2) };
  }
  const data = { sym, name: st.name, next, rows: rows.slice(0, 12), stats, asOf: new Date().toISOString() };
  _earnCache.set(sym, { at: Date.now(), data });
  return data;
}
// market-wide upcoming results calendar — NSE's official board-meeting feed (free, authoritative)
let _ecal = cacheLoad('ecal');
if (!_ecal.rows) _ecal = { rows: [], at: 0 };
async function earningsCalendar() {
  if (Date.now() - (_ecal.at || 0) > 3 * 3600e3) {
    try {
      const j = await nseApi('/api/event-calendar', 'https://www.nseindia.com/companies-listing/corporate-filings-event-calendar');
      const arr = Array.isArray(j) ? j : (j && j.data) || [];
      const rows = arr.filter(r => /result/i.test(r.purpose || ''))
        .map(r => ({ sym: r.symbol, company: r.company, date: r.date, ms: nseDateMs(r.date), desc: r.bm_desc || '' }))
        .filter(r => r.ms).sort((a, b) => a.ms - b.ms);
      if (rows.length) { _ecal = { rows, at: Date.now() }; cacheSave('ecal', _ecal); }
    } catch (e) { /* keep previous */ }
  }
  const tierOf = {};
  STOCKS.forEach(s => tierOf[s.sym] = s.tier);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = _ecal.rows.filter(r => r.ms >= today.getTime() - 86400e3)
    .map(r => ({ ...r, tier: tierOf[r.sym] || null, daysTo: Math.round((r.ms - today.getTime()) / 86400e3) }));
  return { rows, count: rows.length, asOf: new Date(_ecal.at || Date.now()).toISOString() };
}

// ---------- Peer comparison (valuation / quality / growth vs sector peers) ----------
const _peersCache = new Map();
async function peerCompare(sym) {
  const hit = _peersCache.get(sym);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.data;
  const st = resolveStock(sym);
  if (!st.sector) return { sym, sector: null, peers: [], note: 'Sector unknown for this symbol — peer set unavailable (not in the Nifty 500 constituents).' };
  const bankish = BANKISH_RE.test(st.sector);
  const peerStocks = STOCKS.filter(s => s.sector === st.sector && s.sym !== st.sym)
    .sort((a, b) => a.tier - b.tier).slice(0, 7);
  const all = [st, ...peerStocks];
  const tvp = await tvScan(all.map(s => s.sym));
  const funds = {};
  if (!bankish) {
    await Promise.all(all.map(async s => {
      try { funds[s.sym] = await withTimeout(computeRatios(s.yh), 12000); } catch (e) { funds[s.sym] = null; }
    }));
  }
  const rows = all.map(s => {
    const t = tvp[s.sym] || {};
    if (t.close == null) return null;
    const rd = funds[s.sym];
    const get = name => { const r = rd && rd.ratios && rd.ratios.find(x => x.name === name); return r ? r.current : null; };
    return { sym: s.sym, name: s.name, self: s.sym === st.sym,
      price: +t.close.toFixed(2), day: t.change != null ? +t.change.toFixed(2) : null,
      ret3m: t['Perf.3M'] != null ? +t['Perf.3M'].toFixed(1) : null, ret1y: t['Perf.Y'] != null ? +t['Perf.Y'].toFixed(1) : null,
      fromHigh: (t.price_52_week_high && t.close) ? +((t.close - t.price_52_week_high) / t.price_52_week_high * 100).toFixed(1) : null,
      vol: t['Volatility.D'] != null ? +(t['Volatility.D'] * Math.sqrt(252)).toFixed(1) : null,
      beta: t.beta_1_year != null ? +t.beta_1_year.toFixed(2) : null,
      pe: get('P/E (TTM)'), roe: get('Return on Equity (ROE)'), margin: get('Net Profit Margin'), de: get('Debt-to-Equity'),
      f: rd && rd.forensics && rd.forensics.piotroski ? rd.forensics.piotroski.score : null };
  }).filter(Boolean);
  const data = { sym: st.sym, sector: st.sector, bankish, peers: rows, count: rows.length, asOf: new Date().toISOString() };
  _peersCache.set(sym, { at: Date.now(), data });
  return data;
}

// ---------- Analyst Brief: rule-based thesis synthesized from every live engine ----------
// Deliberately NOT an LLM (no API keys is a hard project constraint): a deterministic composer
// that turns the real numbers already computed (trend, momentum, forensics, delivery, sentiment,
// SWOT, peers, earnings) into a structured, evidence-cited bull/bear brief.
const _thesisCache = new Map();
async function buildThesis(sym) {
  const hit = _thesisCache.get(sym);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.data;
  const st = resolveStock(sym);
  const [tvpR, fundR, sentiR, swotR, delivR, earnR, peerR] = await Promise.allSettled([
    tvScan([sym]),
    fundamentalsQuality(sym, st.sector),
    withTimeout(holdingSentiment(sym), 8000),
    withTimeout(holdingSwot(sym), 6000),
    withTimeout(deliveryAnalytics(sym), 9000),
    withTimeout(earningsReport(sym), 10000),
    withTimeout(peerCompare(sym), 16000),
  ]);
  const val = r => r.status === 'fulfilled' ? r.value : null;
  const tv = (val(tvpR) || {})[sym];
  if (!tv || tv.close == null) throw new Error('No TradingView data for ' + sym + ' — check the symbol');
  const fund = val(fundR), senti = val(sentiR), swot = val(swotR), deliv = val(delivR), earn = val(earnR), peers = val(peerR);
  let peerPct = null;
  if (peers && peers.peers && peers.peers.length >= 5) {
    const withPerf = peers.peers.filter(p => p.ret3m != null);
    const mine = withPerf.find(p => p.self);
    if (mine && withPerf.length >= 5) peerPct = Math.round(withPerf.filter(p => p.ret3m < mine.ret3m).length / withPerf.length * 100);
  }
  const s = scoreHolding({ sym, qty: 1, buy: null }, tv, fund, { peerPct, senti, swot });
  const c = s.composite;
  const stance = c >= 72 ? 'Bullish' : c >= 58 ? 'Constructive' : c >= 45 ? 'Neutral' : c >= 32 ? 'Cautious' : 'Bearish';
  const bull = [], bear = [], watch = [];
  // trend
  if (s.above50 && s.above200) bull.push(`Established uptrend — price ₹${s.price} holds above both the 50-DMA (₹${s.sma50}) and 200-DMA (₹${s.sma200})`);
  else if (!s.above50 && !s.above200) bear.push(`Confirmed downtrend — trades below both the 50-DMA (₹${s.sma50 ?? '—'}) and 200-DMA (₹${s.sma200 ?? '—'})`);
  else if (s.above200) bear.push(`Trend cooling — still above the 200-DMA (₹${s.sma200}) but has slipped under the 50-DMA (₹${s.sma50})`);
  else bull.push(`Early repair — back above the 50-DMA (₹${s.sma50}) though the 200-DMA (₹${s.sma200}) is still overhead`);
  // momentum & range
  if (s.ret3m != null) (s.ret3m >= 8 ? bull : s.ret3m <= -8 ? bear : (s.ret3m >= 0 ? bull : bear))
    .push(`3-month return ${s.ret3m >= 0 ? '+' : ''}${s.ret3m}%${s.ret1y != null ? `, 1-year ${s.ret1y >= 0 ? '+' : ''}${s.ret1y}%` : ''}`);
  if (peerPct != null) (peerPct >= 60 ? bull : peerPct <= 35 ? bear : watch)
    .push(`Beats ${peerPct}% of ${peers.sector} peers on 3-month performance${peerPct >= 60 ? ' — sector leadership' : peerPct <= 35 ? ' — sector laggard' : ''}`);
  if (s.fromHigh != null) {
    if (s.fromHigh >= -3) bull.push(`Within ${Math.abs(s.fromHigh)}% of its 52-week high — strength, not weakness, sets highs`);
    else if (s.fromHigh <= -30) bear.push(`Trades ${Math.abs(s.fromHigh)}% below its 52-week high — deep drawdown territory`);
  }
  // fundamental quality (forensics)
  if (fund && fund.fscore != null) (fund.fscore >= 7 ? bull : fund.fscore <= 3 ? bear : watch)
    .push(`Piotroski F-Score ${fund.fscore}/9 — ${fund.fscore >= 7 ? 'broad, filing-verified fundamental improvement' : fund.fscore <= 3 ? 'deteriorating fundamentals across the filing checks' : 'mixed fundamental momentum'}`);
  if (fund && fund.zZone === 'weak') bear.push(`Altman Z″ ${fund.z} sits in the balance-sheet distress zone`);
  else if (fund && fund.zZone === 'good' && fund.z != null) bull.push(`Altman Z″ ${fund.z} — comfortably in the safe zone, low solvency risk`);
  if (fund && fund.accrualsFlag === 'weak') bear.push(`Earnings quality flag — reported profit is running ahead of operating cash (high accruals)`);
  if (fund && fund.note === 'bank') watch.push(`Bank/financial: statement forensics (F-Score, Z″) don't apply — judge on NIM/NPA/CASA from investor presentations`);
  // delivery conviction
  if (deliv && deliv.signal && deliv.signal.tone !== 'neutral')
    (deliv.signal.tone === 'good' ? bull : deliv.signal.tone === 'bad' ? bear : watch)
      .push(`${deliv.signal.label} (NSE delivery data, ${deliv.asOf}) — ${deliv.signal.text}`);
  // news & SWOT
  if (senti && senti.basis === 'relevant' && senti.scored >= 3)
    (senti.score10 >= 6.5 ? bull : senti.score10 <= 3.5 ? bear : watch).push(`Live news flow scores ${senti.score10}/10 (${senti.label}) across ${senti.scored} on-topic headlines`);
  if (swot && (swot.strengths || swot.threats)) {
    if (swot.strengths >= 2 * (swot.threats || 1) && swot.strengths >= 8) bull.push(`Trendlyne SWOT skews positive — ${swot.strengths} strengths vs ${swot.threats} threats`);
    else if (swot.threats > swot.strengths) bear.push(`Trendlyne SWOT flags more threats (${swot.threats}) than strengths (${swot.strengths})`);
  }
  // risk & events
  if (s.vol != null && s.vol >= 40) watch.push(`High volatility ~${s.vol}% annualised — expect wide swings, size positions accordingly`);
  if (s.beta != null && s.beta >= 1.3) watch.push(`Beta ${s.beta} — amplifies index moves ~${Math.round((s.beta - 1) * 100)}%`);
  if (earn && earn.next && earn.next.daysTo != null && earn.next.daysTo >= 0 && earn.next.daysTo <= 21)
    watch.push(`Results due ${earn.next.dates[0]}${earn.next.estimate ? ' (estimated)' : ''} — ${earn.next.daysTo} day(s) away${earn.stats ? `; this stock's average post-results 1-day move is ±${earn.stats.avgAbs1d}%` : ''}`);
  const engines = { price: true, quality: !!(fund && fund.quality != null), news: !!senti, swot: !!swot, delivery: !!deliv, earnings: !!earn, peers: !!(peers && peers.peers && peers.peers.length > 1) };
  const coverage = Object.values(engines).filter(Boolean).length;
  const confidence = coverage >= 6 ? 'High' : coverage >= 4 ? 'Medium' : 'Low';
  const lc = t => t ? t[0].toLowerCase() + t.slice(1) : '';
  const oneLiner = `${st.name || sym} screens ${stance.toUpperCase()} at ${c}/100.` +
    (bull[0] ? ` ${bull[0].split(' — ')[0]}` : '') +
    (bear[0] ? `, but ${lc(bear[0].split(' — ')[0])}` : '') + '.';
  const data = { sym: st.sym, name: st.name, stance, composite: c, sub: s.sub, confidence, coverage: `${coverage}/7 engines`,
    oneLiner, bull, bear, watch, engines, asOf: new Date().toISOString() };
  _thesisCache.set(sym, { at: Date.now(), data });
  return data;
}

// ---------- Portfolio backtest + correlation matrix (1y, split-adjusted daily closes) ----------
function adjCloseMap(res) {           // dayKey -> split-adjusted close (keeps timestamp alignment)
  const q = (res.indicators && res.indicators.quote[0]) || {};
  const ts = res.timestamp || [], raw = q.close || [];
  const splits = effectiveSplits(res);
  const m = {};
  for (let i = 0; i < ts.length; i++) {
    let v = raw[i];
    if (v == null || isNaN(v)) continue;
    let f = 1;
    for (const sp of splits) if (sp.date > ts[i] && sp.numerator && sp.denominator) f *= sp.denominator / sp.numerator;
    m[Math.floor(ts[i] / 86400)] = v * f;
  }
  return m;
}
function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return (da && db) ? num / Math.sqrt(da * db) : 0;
}
async function backtestPortfolio(holdings) {
  holdings = holdings.slice(0, 40);
  const charts = await pool([...holdings.map(h => resolveStock(h.sym).yh), '^NSEI'], 8, t => yahooChart(t, '1d', '1y'));
  const bench = charts[charts.length - 1];
  if (!bench) throw new Error('Benchmark (^NSEI) data unavailable');
  const missing = [];
  const maps = holdings.map((h, i) => { const c = charts[i]; if (!c) { missing.push(h.sym); return null; } return adjCloseMap(c); });
  const kept = holdings.filter((_, i) => maps[i] && Object.keys(maps[i]).length > 40);
  const keptMaps = maps.filter(m => m && Object.keys(m).length > 40);
  if (kept.length < 2) throw new Error('Need at least 2 holdings with a year of price history to backtest');
  const benchMap = adjCloseMap(bench);
  const days = Object.keys(benchMap).map(Number).sort((a, b) => a - b);
  const start = Math.max(...keptMaps.map(m => Math.min(...Object.keys(m).map(Number))));
  const seen = new Array(kept.length).fill(null);
  const curve = [];
  for (const d of days) {
    keptMaps.forEach((m, i) => { if (m[d] != null) seen[i] = m[d]; });
    if (d < start || seen.some(v => v == null)) continue;
    let v = 0;
    kept.forEach((h, i) => v += h.qty * seen[i]);
    curve.push({ d, v, b: benchMap[d] });
  }
  if (curve.length < 40) throw new Error('Not enough overlapping trading history across these holdings');
  const v0 = curve[0].v, b0 = curve[0].b, lastP = curve[curve.length - 1];
  const series = curve.map(p => ({ time: p.d * 86400, pf: +p.v.toFixed(0), bench: +(p.b / b0 * v0).toFixed(0) }));
  const rets = [];
  for (let i = 1; i < curve.length; i++) rets.push(curve[i].v / curve[i - 1].v - 1);
  const n = rets.length;
  const totRet = lastP.v / v0 - 1;
  const years = n / 252;
  const cagr = years > 0.2 ? Math.pow(1 + totRet, 1 / years) - 1 : totRet;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const vol = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1)) * Math.sqrt(252);
  const sharpe = vol ? +((cagr - 0.065) / vol).toFixed(2) : null;    // rf ≈ 6.5% (India 10y)
  let peak = curve[0].v, curPeakD = curve[0].d, maxDD = 0, ddFrom = curve[0].d, ddTo = curve[0].d;
  let best = { r: -Infinity }, worst = { r: Infinity };
  for (let i = 1; i < curve.length; i++) {
    const p = curve[i];
    if (p.v > peak) { peak = p.v; curPeakD = p.d; }
    const dd = p.v / peak - 1;
    if (dd < maxDD) { maxDD = dd; ddFrom = curPeakD; ddTo = p.d; }
    const r = rets[i - 1];
    if (r > best.r) best = { r, d: p.d };
    if (r < worst.r) worst = { r, d: p.d };
  }
  const benchRet = lastP.b / b0 - 1;
  const iso = d => new Date(d * 86400e3).toISOString().slice(0, 10);
  const pctf = v => +(v * 100).toFixed(1);
  // correlation matrix over each pair's common trading days
  const symRets = keptMaps.map(m => {
    const out = {}; let prev = null;
    for (const d of days) { const v = m[d]; if (v != null) { if (prev != null) out[d] = v / prev - 1; prev = v; } }
    return out;
  });
  const matrix = []; const pairs = []; let sum = 0, cnt = 0;
  for (let i = 0; i < kept.length; i++) {
    matrix.push([]);
    for (let j = 0; j < kept.length; j++) {
      if (i === j) { matrix[i].push(1); continue; }
      if (j < i) { matrix[i].push(matrix[j][i]); continue; }
      const ds = Object.keys(symRets[i]).filter(d => symRets[j][d] != null);
      if (ds.length < 40) { matrix[i].push(null); continue; }
      const cr = +pearson(ds.map(d => symRets[i][d]), ds.map(d => symRets[j][d])).toFixed(2);
      matrix[i].push(cr);
      pairs.push({ a: kept[i].sym, b: kept[j].sym, corr: cr });
      sum += cr; cnt++;
    }
  }
  pairs.sort((a, b) => b.corr - a.corr);
  return {
    syms: kept.map(h => h.sym), missing,
    series,
    stats: { totRet: pctf(totRet), cagr: pctf(cagr), vol: pctf(vol), sharpe,
      maxDD: pctf(maxDD), ddFrom: iso(ddFrom), ddTo: iso(ddTo),
      benchRet: pctf(benchRet), alpha: pctf(totRet - benchRet),
      bestDay: best.d ? { date: iso(best.d), ret: pctf(best.r) } : null,
      worstDay: worst.d ? { date: iso(worst.d), ret: pctf(worst.r) } : null,
      days: curve.length, from: iso(curve[0].d), to: iso(lastP.d) },
    corr: { matrix, avg: cnt ? +(sum / cnt).toFixed(2) : null,
      top: pairs.slice(0, 3), lowest: pairs.length ? pairs[pairs.length - 1] : null },
    asOf: new Date().toISOString(),
  };
}

// ═══════════ Position Sizing — risk-parity portfolio allocator ═══════════
/*
  METHODOLOGY (for future maintainers)
  ------------------------------------
  Splits a rupee amount across N stocks so each contributes a SIMILAR share of RISK, rather
  than equal money. Reuses the backtest pipeline's returns / vol / pearson helpers verbatim.
    1. Annualised vol σ_i = stdev(daily returns) × √252            (same as backtestPortfolio).
    2. Correlation matrix  = pearson() over each pair's common trading days.
    3. Inverse-vol base     w_i ∝ 1/σ_i  →  low-vol names get more   (classic risk parity).
    4. Correlation penalty  a stock whose AVERAGE pairwise correlation to the basket exceeds
                            0.7 adds little diversification, so its weight is trimmed (up to
                            −30% at corr 1.0). Re-normalising redistributes that freed weight
                            proportionally to the LESS-correlated names.
    5. Fractional-Kelly tilt  OPTIONAL and SEPARATE from the risk-parity core. If the user gives
                            a 1–10 conviction, the weight is scaled by 1 + 0.25·(conv−5.5)/4.5
                            (conv 10 → ×1.25, conv 1 → ×0.75). This is a conviction tilt at a
                            0.25 Kelly FRACTION — a deliberately gentle nudge, NOT literal Kelly:
                            we have no forward-return estimate, so full Kelly isn't computable.
    6. Max-position cap     iteratively cap any weight > capPct and water-fill the excess into
                            the uncapped names until every weight is within the cap.
  Output: final weight %, ₹ allocation, and share qty = floor(alloc / current price).
  This sizes a basket the user has ALREADY chosen — it is not stock selection or advice.
*/
function ps_normalize(w) { const s = w.reduce((a, b) => a + b, 0) || 1; return w.map(x => x / s); }
function ps_applyCap(w, cap) {
  w = w.slice();
  for (let iter = 0; iter < 200; iter++) {
    let excess = 0; const under = [];
    w.forEach((x, i) => { if (x > cap + 1e-9) { excess += x - cap; w[i] = cap; } else under.push(i); });
    if (excess < 1e-9) break;
    const underSum = under.reduce((a, i) => a + w[i], 0);
    if (underSum <= 1e-9) break;                       // everything capped — cap infeasibly low
    under.forEach(i => w[i] += excess * (w[i] / underSum));
  }
  return w;
}
// PURE, testable: takes pre-computed asset stats + returns final fractional weights (Σ = 1).
// assets: [{ vol (annualised decimal), avgCorr (0–1), conviction (1–10 | null) }]
function sizeByRiskParity({ assets, capPct = 0.25, kellyFraction = 0.25 }) {
  // 3) inverse-volatility base weights
  const inv = assets.map(a => a.vol > 0 ? 1 / a.vol : 0);
  let w = ps_normalize(inv);
  // 4) correlation penalty for names too correlated to the rest of the basket
  w = ps_normalize(w.map((wi, i) => {
    const ac = assets[i].avgCorr;
    return (ac != null && ac > 0.7) ? wi * Math.max(0.3, 1 - (ac - 0.7)) : wi;
  }));
  // 5) optional fractional-Kelly conviction tilt (only if any conviction supplied)
  if (assets.some(a => a.conviction != null)) {
    w = ps_normalize(w.map((wi, i) => {
      const c = assets[i].conviction;
      return c == null ? wi : wi * Math.max(0.1, 1 + kellyFraction * ((c - 5.5) / 4.5));
    }));
  }
  // 6) max-position cap with iterative water-filling
  return ps_applyCap(w, capPct);
}

// async wrapper: fetch 1y daily prices, derive vol + correlation, then call the pure sizer.
async function positionSizingPortfolio(symsIn, opts = {}) {
  const syms = [...new Set((symsIn || []).map(s => String(s).toUpperCase().trim()).filter(Boolean))].slice(0, 8);
  if (syms.length < 2) throw new Error('Select at least 2 stocks to allocate across.');
  const amount = +opts.amount > 0 ? +opts.amount : 0;
  let capPct = Math.min(0.5, Math.max(0.10, +opts.capPct || 0.25));
  const convictions = opts.convictions || {};

  const charts = await pool(syms.map(s => resolveStock(s).yh), 8, t => yahooChart(t, '1d', '1y'));
  const warnings = [];
  const valid = [];
  syms.forEach((sym, i) => {
    const c = charts[i], m = c ? adjCloseMap(c) : null;
    if (!m || Object.keys(m).length < 40) { warnings.push(`No usable price history for ${sym} — dropped.`); return; }
    const days = Object.keys(m).map(Number).sort((a, b) => a - b);
    const retMap = {}; let prev = null;
    for (const d of days) { const v = m[d]; if (v != null) { if (prev != null) retMap[d] = v / prev - 1; prev = v; } }
    const rets = Object.values(retMap);
    if (rets.length < 40) { warnings.push(`Not enough history for ${sym} — dropped.`); return; }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const vol = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252);
    const price = (c.meta && c.meta.regularMarketPrice) || m[days[days.length - 1]];
    const st = resolveStock(sym);
    const cv = convictions[sym];
    const conviction = (cv != null && cv !== '') ? Math.min(10, Math.max(1, +cv)) : null;
    valid.push({ sym, name: st.name || sym, vol, price, retMap, conviction });
  });
  if (valid.length < 2) throw new Error('Need at least 2 stocks with a year of price history.');

  // correlation matrix (reuses pearson over each pair's common days)
  const matrix = []; let sum = 0, cnt = 0;
  for (let i = 0; i < valid.length; i++) {
    matrix.push([]);
    for (let j = 0; j < valid.length; j++) {
      if (i === j) { matrix[i].push(1); continue; }
      if (j < i) { matrix[i].push(matrix[j][i]); continue; }
      const a = valid[i].retMap, b = valid[j].retMap;
      const ds = Object.keys(a).filter(d => b[d] != null);
      const cr = ds.length < 40 ? null : +pearson(ds.map(d => a[d]), ds.map(d => b[d])).toFixed(2);
      matrix[i].push(cr); if (cr != null) { sum += cr; cnt++; }
    }
  }
  const avgCorrAll = cnt ? sum / cnt : 0;
  valid.forEach((a, i) => {
    const cs = matrix[i].filter((c, j) => j !== i && c != null);
    a.avgCorr = cs.length ? cs.reduce((x, y) => x + y, 0) / cs.length : 0;
  });

  // A cap at/below the equal-weight floor (1/N) can only be satisfied by making every weight
  // equal — which would erase the volatility/correlation analysis. In that case DON'T apply the
  // cap; keep the differentiated risk-parity split. (e.g. 3 stocks with a 25% cap → cap ignored.)
  const minCap = 1 / valid.length;
  let effCap = capPct;
  if (capPct <= minCap + 1e-9) {
    warnings.push(`Max-position cap ${Math.round(capPct * 100)}% is at/below the ${Math.round(minCap * 100)}% equal-weight floor for ${valid.length} stocks, so it isn't applied — you're seeing the pure risk-parity split. Raise the cap above ${Math.round(minCap * 100)}% for it to bind.`);
    effCap = 1;
  }
  if (avgCorrAll > 0.7) warnings.push(`These stocks are highly correlated (avg ${avgCorrAll.toFixed(2)}) — the diversification benefit is limited; consider names from other sectors.`);

  const weights = sizeByRiskParity({
    assets: valid.map(a => ({ vol: a.vol, avgCorr: a.avgCorr, conviction: a.conviction })),
    capPct: effCap, kellyFraction: 0.25,
  });
  const capApplied = effCap < 1;
  const rows = valid.map((a, i) => {
    const weight = weights[i];
    const alloc = amount > 0 ? weight * amount : 0;
    return { sym: a.sym, name: a.name, vol: +(a.vol * 100).toFixed(1), avgCorr: +a.avgCorr.toFixed(2),
      weight: +(weight * 100).toFixed(1), alloc: Math.round(alloc), price: +a.price.toFixed(2),
      qty: (amount > 0 && a.price > 0) ? Math.floor(alloc / a.price) : 0, conviction: a.conviction };
  }).sort((x, y) => y.weight - x.weight);

  const investedValue = rows.reduce((s, r) => s + r.qty * r.price, 0);
  return { rows, matrix, syms: valid.map(a => a.sym), avgCorr: +avgCorrAll.toFixed(2),
    capPct: Math.round(capPct * 100), capApplied, kellyApplied: valid.some(a => a.conviction != null),
    amount, investedValue: Math.round(investedValue), cashLeft: Math.round(amount - investedValue),
    warnings, asOf: new Date().toISOString() };
}

// ---------- Home page: "Today's Pulse" aggregate, watchlist quotes, index sparklines ----------
// One endpoint feeds the whole home dashboard, composed almost entirely from caches that the
// other engines already warm — so the home page stays instant.
let _pulse = null;
async function pulseData() {
  if (_pulse && Date.now() - _pulse.at < 3 * 60e3) return _pulse.data;
  const val = r => (r && r.status === 'fulfilled') ? r.value : null;
  const [niftyR, fiiR, moversR, spikesR, ecalR] = await Promise.allSettled([
    quote('^NSEI'),
    fiidiiFlows(),
    topMovers('Nifty 50', 'daily'),
    deliverySpikes('Nifty 500'),
    earningsCalendar(),
  ]);
  const nifty = val(niftyR), fii = val(fiiR), movers = val(moversR), spikes = val(spikesR), ecal = val(ecalR);
  // breadth from the already-warmed Nifty 500 heatmap cache (zero extra fetches)
  let breadth = null;
  const te = _trend['Nifty 500|1 Day|sma|20,200'];
  if (te && te.data && te.data.stocks && te.data.stocks.length) {
    const st = te.data.stocks;
    const above = len => st.filter(s => { const m = (s.mas || []).find(x => x.len === len); return m && m.above; }).length;
    const adv = st.filter(s => s.ret > 0).length;
    const p200 = Math.round(above(200) / st.length * 100), p20 = Math.round(above(20) / st.length * 100);
    breadth = { n: st.length, pct200: p200, pct20: p20, adv, dec: st.length - adv,
      regime: p200 >= 60 ? 'Bullish' : p200 >= 40 ? 'Neutral' : 'Bearish', asOf: te.data.asOf };
  } else {
    topTrend('1 Day', 'Nifty 500', parseMaConfig(null, null)).catch(() => {});   // warm for next hit
  }
  const gainer = movers && movers.gainers && movers.gainers[0] || null;
  const loser = movers && movers.losers && movers.losers[0] || null;
  let spike = null;
  if (spikes) {
    const a = spikes.accumulation[0], d = spikes.distribution[0];
    spike = (a && d) ? (a.score >= d.score ? a : d) : (a || d);
  }
  const results = (ecal && ecal.rows || []).filter(r => r.tier != null && r.tier <= 100 && r.daysTo >= 0).slice(0, 3);
  // ── the composed brief (same rule-based style as the Analyst Brief) ──
  const brief = [];
  if (nifty && nifty.price != null) {
    const up = nifty.pct >= 0;
    const vs200 = nifty.sma200 != null ? (nifty.price >= nifty.sma200 ? 'above' : 'below') : null;
    brief.push({ tone: up ? 'good' : 'bad',
      text: `NIFTY 50 at ${nifty.price.toLocaleString('en-IN')} (${up ? '+' : ''}${nifty.pct}%)${vs200 ? `, trading ${vs200} its 200-DMA` : ''}` });
  }
  if (breadth) brief.push({ tone: breadth.regime === 'Bullish' ? 'good' : breadth.regime === 'Neutral' ? 'warn' : 'bad',
    text: `Breadth ${breadth.regime.toLowerCase()} — ${breadth.pct200}% of the Nifty 500 above the 200-DMA, advances/declines ${breadth.adv}/${breadth.dec}` });
  if (fii && fii.latest && fii.latest.fii && fii.latest.dii) {
    const f = fii.latest.fii.n, d = fii.latest.dii.n;
    const cr = v => `${v < 0 ? '−' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')} Cr`;
    brief.push({ tone: f >= 0 && d >= 0 ? 'good' : f < 0 && d < 0 ? 'bad' : 'warn',
      text: `Institutions (${fii.latest.date}): FIIs ${cr(f)}, DIIs ${cr(d)} — ${f >= 0 && d >= 0 ? 'both buying' : f < 0 && d < 0 ? 'both selling' : f >= 0 ? 'foreign money leading' : 'domestic funds absorbing FII supply'}` });
  }
  if (gainer && loser) brief.push({ tone: 'neutral',
    text: `Nifty 50 today: ${gainer.sym} led (+${gainer.ret}%), ${loser.sym} lagged (${loser.ret}%)` });
  if (spike) brief.push({ tone: spike.chg >= 0 ? 'good' : 'bad',
    text: `Delivery spike: ${spike.sym} ${spike.chg >= 0 ? '+' : ''}${spike.chg}% on ${spike.volX}× volume with ${spike.delivPer}% delivered — ${spike.chg >= 0 ? 'accumulation' : 'distribution'}` });
  if (results.length) brief.push({ tone: 'neutral',
    text: `Results ahead: ${results.map(r => `${r.sym} ${r.date.slice(0, 6)}`).join(', ')}` });
  const data = { asOf: new Date().toISOString(),
    nifty: nifty ? { value: nifty.price, pct: nifty.pct, above200: nifty.sma200 != null ? nifty.price >= nifty.sma200 : null } : null,
    breadth, fii: fii && fii.latest || null, gainer, loser, spike, results, brief };
  _pulse = { at: Date.now(), data };
  return data;
}
// watchlist quotes: one batched TV scan (matches the user's charts) + in-memory delivery flags
async function watchQuotes(syms) {
  const tvp = await tvScan(syms);
  let days = [];
  try { days = await ensureBhavDays(26); } catch (e) { /* delivery flags optional */ }
  const lastDay = days.length ? days[days.length - 1] : null;
  return syms.map(sym => {
    const t = tvp[sym];
    const st = resolveStock(sym);
    if (!t || t.close == null) return { sym, name: st.name !== sym ? st.name : sym, error: true };
    let volX = null, delivX = null, delivPer = null;
    if (lastDay && lastDay.rows[sym]) {
      const cur = lastDay.rows[sym];
      const hist = days.slice(0, -1).map(d => d.rows[sym]).filter(Boolean);
      if (hist.length >= 6 && cur.dp != null) {
        const avgVol = hist.reduce((a, r) => a + r.v, 0) / hist.length;
        const dps = hist.map(r => r.dp).filter(v => v != null);
        if (avgVol && dps.length >= 6) {
          const avgDp = dps.reduce((a, b) => a + b, 0) / dps.length;
          volX = +(cur.v / avgVol).toFixed(2);
          delivX = avgDp ? +(cur.dp / avgDp).toFixed(2) : null;
          delivPer = cur.dp;
        }
      }
    }
    return { sym, name: (st.name && st.name !== sym) ? st.name : (t.description || sym), sector: st.sector || t.sector || '',
      price: +t.close.toFixed(2), day: t.change != null ? +t.change.toFixed(2) : 0,
      above200: t.SMA200 != null ? t.close >= t.SMA200 : null, above50: t.SMA50 != null ? t.close >= t.SMA50 : null,
      fromHigh: t.price_52_week_high ? +((t.close - t.price_52_week_high) / t.price_52_week_high * 100).toFixed(1) : null,
      volX, delivX, delivPer };
  });
}
// intraday sparklines for the index cards (one 5-min chart per index, 5-min cache)
let _sparks = null;
async function sparksData() {
  if (_sparks && Date.now() - _sparks.at < 5 * 60e3) return _sparks.data;
  const out = await pool(INDICES, 4, async ([name, t]) => {
    const res = await yahooChart(t, '5m', '1d');
    if (!res) return { name, pts: [] };
    const closes = (((res.indicators || {}).quote || [{}])[0].close || []).filter(v => v != null && !isNaN(v));
    const step = Math.max(1, Math.ceil(closes.length / 60));
    const pts = closes.filter((_, i) => i % step === 0).map(v => +v.toFixed(2));
    if (closes.length && pts[pts.length - 1] !== +closes[closes.length - 1].toFixed(2)) pts.push(+closes[closes.length - 1].toFixed(2));
    return { name, pts };
  });
  const data = { sparks: out, asOf: new Date().toISOString() };
  _sparks = { at: Date.now(), data };
  return data;
}

// ─────────── Macro Maps: cross-country macro data ───────────
// SOURCE — the World Bank WDI dataset, but fetched via DBnomics (api.db.nomics.world),
// NOT api.worldbank.org directly. Reason: on some ISPs (observed on the user's Indian
// connection) the World Bank host is SNI-filtered — the TCP handshake completes but the
// HTTP request is black-holed, so a direct fetch hangs indefinitely. DBnomics mirrors the
// exact same WB/WDI series (identical indicator codes and values) from a reachable host.
//
// DATA GRANULARITY — be honest about what the time slider can show:
//   • WDI series are ANNUAL and publish with a lag (DBnomics' snapshot typically ends a
//     year or two before "now"). The slider steps by YEAR; each country row shows its own
//     latest observation year explicitly.
//   • Monthly/intraday macro (RBI repo, India CPI/WPI MoM, INR/USD, FII/DII) is a separate
//     India-specific layer (phase 2) — RBI/NSE publish those monthly or daily.
const WB_INDICATORS = {
  inflation:    { code: 'FP.CPI.TOTL.ZG',    label: 'Inflation Rate',      unit: '%',
                  desc: 'Consumer price inflation, annual average % (CPI YoY).' },
  interest:     { code: 'FR.INR.LEND',       label: 'Lending Interest Rate', unit: '%',
                  desc: 'Commercial-bank lending rate (World Bank WDI). Not the policy rate — true repo/fed-funds rates need FRED/central-bank feeds (planned). Sparse for the Eurozone.' },
  gdp:          { code: 'NY.GDP.MKTP.KD.ZG', label: 'GDP Growth',          unit: '%',
                  desc: 'Real GDP growth, annual %.' },
  unemployment: { code: 'SL.UEM.TOTL.ZS',    label: 'Unemployment Rate',   unit: '%',
                  desc: 'Unemployment, % of labour force (ILO modelled estimate).' },
  debt:         { code: 'GC.DOD.TOTL.GD.ZS', label: 'Govt Debt to GDP',    unit: '%',
                  desc: 'Central-government debt, % of GDP. WDI coverage is patchy — countries without recent filings are greyed out.' },
  currency:     { code: 'PA.NUS.FCRF',       label: 'Currency vs USD',     unit: '%', transform: 'appreciationYoY',
                  desc: 'Annual-average exchange-rate change vs USD. Positive = currency appreciated. Derived from official rates (LCU per USD); USA is the 0% base.' },
  cab:          { code: 'BN.CAB.XOKA.GD.ZS', label: 'Current Account',     unit: '%',
                  desc: 'Current-account balance, % of GDP. Negative = deficit (external funding need — watch for rupee-style FX pressure).' },
  // Energy — only ONE WDI energy series is still maintained to a recent year (renewables share
  // of final energy, ~2021). WDI's electricity-mix series (nuclear %, coal %, energy imports)
  // froze at 2014-15, so those live in macroCurated.json instead with more current figures.
  renew_energy: { code: 'EG.FEC.RNEW.ZS',    label: 'Renewables (% energy)', unit: '%',
                  desc: 'Renewable energy as a share of total final energy consumption (World Bank WDI, latest ~2021).' },
};

// Bundled ISO 3166-1 alpha-3 → alpha-2 (source: ISO-3166 CSV, baked in so country metadata
// needs no runtime network call). Doubles as the "is a real country" allowlist: WDI mixes in
// aggregates (WLD, EUU, "Arab World"…) whose codes aren't here, so they're dropped for free.
// alpha-2 drives the flagcdn.com flag URLs on the client. XKX/Kosovo added (not in ISO-3166).
const MACRO_ISO = {
  ABW:'AW',AFG:'AF',AGO:'AO',AIA:'AI',ALA:'AX',ALB:'AL',AND:'AD',ARE:'AE',ARG:'AR',ARM:'AM',ASM:'AS',ATA:'AQ',ATF:'TF',ATG:'AG',
  AUS:'AU',AUT:'AT',AZE:'AZ',BDI:'BI',BEL:'BE',BEN:'BJ',BES:'BQ',BFA:'BF',BGD:'BD',BGR:'BG',BHR:'BH',BHS:'BS',BIH:'BA',BLM:'BL',
  BLR:'BY',BLZ:'BZ',BMU:'BM',BOL:'BO',BRA:'BR',BRB:'BB',BRN:'BN',BTN:'BT',BVT:'BV',BWA:'BW',CAF:'CF',CAN:'CA',CCK:'CC',CHE:'CH',
  CHL:'CL',CHN:'CN',CIV:'CI',CMR:'CM',COD:'CD',COG:'CG',COK:'CK',COL:'CO',COM:'KM',CPV:'CV',CRI:'CR',CUB:'CU',CUW:'CW',CXR:'CX',
  CYM:'KY',CYP:'CY',CZE:'CZ',DEU:'DE',DJI:'DJ',DMA:'DM',DNK:'DK',DOM:'DO',DZA:'DZ',ECU:'EC',EGY:'EG',ERI:'ER',ESH:'EH',ESP:'ES',
  EST:'EE',ETH:'ET',FIN:'FI',FJI:'FJ',FLK:'FK',FRA:'FR',FRO:'FO',FSM:'FM',GAB:'GA',GBR:'GB',GEO:'GE',GGY:'GG',GHA:'GH',GIB:'GI',
  GIN:'GN',GLP:'GP',GMB:'GM',GNB:'GW',GNQ:'GQ',GRC:'GR',GRD:'GD',GRL:'GL',GTM:'GT',GUF:'GF',GUM:'GU',GUY:'GY',HKG:'HK',HMD:'HM',
  HND:'HN',HRV:'HR',HTI:'HT',HUN:'HU',IDN:'ID',IMN:'IM',IND:'IN',IOT:'IO',IRL:'IE',IRN:'IR',IRQ:'IQ',ISL:'IS',ISR:'IL',ITA:'IT',
  JAM:'JM',JEY:'JE',JOR:'JO',JPN:'JP',KAZ:'KZ',KEN:'KE',KGZ:'KG',KHM:'KH',KIR:'KI',KNA:'KN',KOR:'KR',KWT:'KW',LAO:'LA',LBN:'LB',
  LBR:'LR',LBY:'LY',LCA:'LC',LIE:'LI',LKA:'LK',LSO:'LS',LTU:'LT',LUX:'LU',LVA:'LV',MAC:'MO',MAF:'MF',MAR:'MA',MCO:'MC',MDA:'MD',
  MDG:'MG',MDV:'MV',MEX:'MX',MHL:'MH',MKD:'MK',MLI:'ML',MLT:'MT',MMR:'MM',MNE:'ME',MNG:'MN',MNP:'MP',MOZ:'MZ',MRT:'MR',MSR:'MS',
  MTQ:'MQ',MUS:'MU',MWI:'MW',MYS:'MY',MYT:'YT',NAM:'NA',NCL:'NC',NER:'NE',NFK:'NF',NGA:'NG',NIC:'NI',NIU:'NU',NLD:'NL',NOR:'NO',
  NPL:'NP',NRU:'NR',NZL:'NZ',OMN:'OM',PAK:'PK',PAN:'PA',PCN:'PN',PER:'PE',PHL:'PH',PLW:'PW',PNG:'PG',POL:'PL',PRI:'PR',PRK:'KP',
  PRT:'PT',PRY:'PY',PSE:'PS',PYF:'PF',QAT:'QA',REU:'RE',ROU:'RO',RUS:'RU',RWA:'RW',SAU:'SA',SDN:'SD',SEN:'SN',SGP:'SG',SGS:'GS',
  SHN:'SH',SJM:'SJ',SLB:'SB',SLE:'SL',SLV:'SV',SMR:'SM',SOM:'SO',SPM:'PM',SRB:'RS',SSD:'SS',STP:'ST',SUR:'SR',SVK:'SK',SVN:'SI',
  SWE:'SE',SWZ:'SZ',SXM:'SX',SYC:'SC',SYR:'SY',TCA:'TC',TCD:'TD',TGO:'TG',THA:'TH',TJK:'TJ',TKL:'TK',TKM:'TM',TLS:'TL',TON:'TO',
  TTO:'TT',TUN:'TN',TUR:'TR',TUV:'TV',TWN:'TW',TZA:'TZ',UGA:'UG',UKR:'UA',UMI:'UM',URY:'UY',USA:'US',UZB:'UZ',VAT:'VA',VCT:'VC',
  VEN:'VE',VGB:'VG',VIR:'VI',VNM:'VN',VUT:'VU',WLF:'WF',WSM:'WS',YEM:'YE',ZAF:'ZA',ZMB:'ZM',ZWE:'ZW',XKX:'XK',
};

// fetch + JSON with a hard timeout — the whole reason the page hung before was an unbounded
// fetch against a black-holed host, so every outbound macro call now aborts after `ms`.
async function fetchJson(url, ms, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${label || 'fetch'} HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${label || 'fetch'} timed out after ${ms / 1000}s`);
    throw e;
  } finally { clearTimeout(timer); }
}

// country name is the last "– …"-delimited segment of the DBnomics series_name
// (e.g. "Annual – Inflation, consumer prices (annual %) – India" → "India").
function mmCountryName(seriesName, iso3) {
  if (!seriesName) return iso3;
  const parts = String(seriesName).split(/\s+[–-]\s+/);
  const last = parts[parts.length - 1].trim();
  return last || iso3;
}

// One indicator, all countries, reshaped to { iso3: { name, iso2, values: {year: v} } }.
// Cached in memory + on disk for 24h (annual data — nothing to gain from refetching intraday).
const _macroMem = {};
async function macroIndicator(ind, force) {
  const cfg = WB_INDICATORS[ind];
  if (!cfg) throw new Error('unknown indicator "' + ind + '"');
  // force = the Macro page's ↻ Refresh button → skip the 24h caches and re-pull from DBnomics
  if (!force && _macroMem[ind] && Date.now() - _macroMem[ind].at < 24 * 3600e3) return _macroMem[ind].data;
  const disk = cacheLoad('macro_' + ind);
  if (!force && disk.at && disk.data && Date.now() - disk.at < 24 * 3600e3) { _macroMem[ind] = disk; return disk.data; }
  try {
    // DBnomics WB/WDI: one indicator across every country in a single call. limit=1000 covers
    // the ~266 country+aggregate series; observations=1 attaches the full period/value arrays.
    const dims = encodeURIComponent(JSON.stringify({ indicator: [cfg.code] }));
    const url = `https://api.db.nomics.world/v22/series/WB/WDI?dimensions=${dims}&observations=1&limit=1000`;
    const j = await fetchJson(url, 30000, 'DBnomics');
    const docs = j && j.series && j.series.docs;
    if (!Array.isArray(docs) || !docs.length) throw new Error('DBnomics returned no series for ' + cfg.code);
    const byIso = {};
    for (const d of docs) {
      const iso3 = d.dimensions && d.dimensions.country;
      if (!iso3 || !MACRO_ISO[iso3]) continue;            // drops aggregates + non-ISO territories
      const per = d.period || [], val = d.value || [];
      const vals = {};
      for (let i = 0; i < per.length; i++) {
        const v = val[i];
        if (v == null || v === 'NA' || !isFinite(+v)) continue;
        vals[per[i]] = +v;
      }
      if (Object.keys(vals).length) byIso[iso3] = { name: mmCountryName(d.series_name, iso3), values: vals };
    }
    // currency tab: raw series is LCU-per-USD annual averages; convert to YoY % appreciation
    // so the map reads "stronger vs USD = higher" (prev/cur − 1: fewer LCU per USD = gained).
    if (cfg.transform === 'appreciationYoY') {
      for (const iso3 of Object.keys(byIso)) {
        const raw = byIso[iso3].values, out = {};
        for (const y of Object.keys(raw)) {
          const prev = raw[String(+y - 1)];
          if (prev > 0 && raw[y] > 0) out[y] = (prev / raw[y] - 1) * 100;
        }
        byIso[iso3].values = out;
      }
    }
    const outCountries = {}; const yearSet = new Set();
    for (const iso3 of Object.keys(byIso)) {
      const years = Object.keys(byIso[iso3].values);
      if (!years.length) continue;
      const vals = {};
      for (const y of years) { yearSet.add(+y); vals[y] = Math.round(byIso[iso3].values[y] * 100) / 100; }
      outCountries[iso3] = { name: byIso[iso3].name, iso2: MACRO_ISO[iso3], values: vals };
    }
    const years = [...yearSet].sort((a, b) => a - b);
    if (!years.length) throw new Error('no observations for ' + cfg.code);
    const data = { ind, label: cfg.label, unit: cfg.unit, desc: cfg.desc, freq: 'annual',
      source: 'World Bank WDI (via DBnomics)', years, latestYear: years[years.length - 1],
      countries: outCountries, asOf: new Date().toISOString() };
    _macroMem[ind] = { at: Date.now(), data };
    cacheSave('macro_' + ind, _macroMem[ind]);
    return data;
  } catch (e) {
    if (disk.data) { _macroMem[ind] = disk; return disk.data; }   // serve stale on upstream failure
    throw e;
  }
}

// World geometry (~110m GeoJSON keyed by ISO3) — fetched once, then served from disk.
// Natural-Earth-derived files tag a few territories ISO "-99"; patch the ones the
// data actually tracks so France/Norway/Kosovo join up with the data.
let _macroGeo = null;
async function macroGeo() {
  if (_macroGeo) return _macroGeo;
  const disk = cacheLoad('macro_geo');
  if (disk.at && disk.geo && Date.now() - disk.at < 90 * 24 * 3600e3) { _macroGeo = disk.geo; return disk.geo; }
  const urls = [
    'https://cdn.jsdelivr.net/gh/johan/world.geo.json@master/countries.geo.json',
    'https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json',
  ];
  for (const url of urls) {
    try {
      const geo = await fetchJson(url, 20000, 'geometry');
      if (!geo || !Array.isArray(geo.features) || geo.features.length < 100) continue;
      const NAME_PATCH = { 'France': 'FRA', 'Norway': 'NOR', 'Kosovo': 'XKX' };
      for (const f of geo.features) {
        const nm = f.properties && f.properties.name;
        if ((!f.id || f.id === '-99') && NAME_PATCH[nm]) f.id = NAME_PATCH[nm];
      }
      _macroGeo = geo;
      cacheSave('macro_geo', { at: Date.now(), geo });
      return geo;
    } catch (e) { /* try next mirror */ }
  }
  if (disk.geo) { _macroGeo = disk.geo; return disk.geo; }
  throw new Error('world geometry unavailable (both mirrors failed)');
}

// ─────────── curated macro/commodity data (hand-maintained JSON on disk) ───────────
// Read fresh from disk each call (files are tiny) so the user's edits show up on a page
// refresh with no server restart — same as how stock-market.html is served live.
function readLocalJson(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
}

// Reshape one curated indicator into the SAME payload shape as macroIndicator() so the client
// treats WDI and curated tabs identically. Curated tabs are single-year snapshots.
function macroCurated(ind) {
  const doc = readLocalJson('macroCurated.json');
  const cfg = doc.indicators && doc.indicators[ind];
  if (!cfg) throw new Error('unknown curated indicator "' + ind + '"');
  const year = cfg.year || new Date().getFullYear();
  const countries = {};
  for (const iso3 of Object.keys(cfg.values || {})) {
    if (!MACRO_ISO[iso3]) continue;                    // ignore any stray non-country codes
    const v = cfg.values[iso3];
    if (v == null || !isFinite(+v)) continue;
    countries[iso3] = { iso2: MACRO_ISO[iso3], values: { [year]: +v } };
  }
  return { ind, label: cfg.label, unit: cfg.unit || '', desc: cfg.desc || '', note: cfg.note || '',
    highlight: cfg.highlight || null, freq: 'annual', curated: true,
    source: (cfg.source || 'curated') + (cfg.year ? ' ' + cfg.year : ''),
    years: [year], latestYear: year, countries, asOf: new Date().toISOString() };
}

// ─────────── HTTP routing ───────────
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (u.pathname === '/api/trend') {
      const tf = u.searchParams.get('tf') || '1 Day';
      const uni = u.searchParams.get('uni') || 'Nifty 50';
      const cfg = parseMaConfig(u.searchParams.get('matype'), u.searchParams.get('mas'));
      const force = u.searchParams.get('fresh') === '1';     // Refresh button bypasses the cache
      return send(res, 200, JSON.stringify(await topTrend(tf, uni, cfg, force)));
    }

    if (u.pathname === '/api/news') {
      const q = u.searchParams.get('q') || '';
      try {
        const items = await fetchNews(q);
        return send(res, 200, JSON.stringify({ q, asOf: new Date().toISOString(), items }));
      } catch (e) {
        return send(res, 502, JSON.stringify({ error: String(e && e.message || e), items: [] }));
      }
    }

    if (u.pathname === '/api/movers') {
      const uni = u.searchParams.get('uni') || 'Nifty 50';
      const period = (u.searchParams.get('period') || 'daily').toLowerCase();
      return send(res, 200, JSON.stringify(await topMovers(uni, MOVER_LOOKBACK[period] ? period : 'daily')));
    }

    if (u.pathname === '/api/extremes') {
      const uni = u.searchParams.get('uni') || 'Nifty 500';
      return send(res, 200, JSON.stringify(await topExtremes(uni)));
    }

    if (u.pathname === '/api/gaps') {
      const uni = u.searchParams.get('uni') || 'Nifty 50';
      return send(res, 200, JSON.stringify(await topGaps(uni)));
    }

    if (u.pathname === '/api/rs') {
      const uni = u.searchParams.get('uni') || 'Nifty 50';
      const period = u.searchParams.get('period') || '1M';
      return send(res, 200, JSON.stringify(await topRS(uni, RS_LOOKBACK[period] ? period : '1M')));
    }

    if (u.pathname === '/api/symbols') {
      const all = STOCKS.map(s => ({ sym: s.sym, name: s.name, sector: s.sector }));
      return send(res, 200, JSON.stringify({ symbols: all }));
    }

    if (u.pathname === '/api/indices') {
      // GOLD = MCX-style ₹-per-10g (see mcxGoldSnap) — domestic landed price, not raw COMEX USD.
      const [data, gold] = await Promise.all([
        pool(INDICES, 4, ([n, t]) => indexSnap(n, t)),
        mcxGoldSnap(),
      ]);
      return send(res, 200, JSON.stringify({ indices: data, gold, asOf: new Date().toISOString() }));
    }

    if (u.pathname === '/api/stock') {
      const raw = (u.searchParams.get('sym') || '').toUpperCase().trim();
      const tf = u.searchParams.get('tf') || '1 Day';
      if (!raw) return send(res, 400, JSON.stringify({ error: 'sym required' }));
      // resolve to a known stock by symbol or name (ranked), else treat the input as an NSE ticker
      let stock = resolveQuery(raw);
      if (!stock) stock = { sym: raw.replace('.NS',''), yh: raw.includes('.') ? raw : raw + '.NS', name: raw.replace('.NS',''), sector: '' };
      const cfg = parseMaConfig(u.searchParams.get('matype'), u.searchParams.get('mas'));
      const snap = await snapshot(stock, tf, cfg);
      if (snap.error) return send(res, 404, JSON.stringify({ error: 'No data for "' + raw + '"' }));
      const { interval } = TF_MAP[tf] || TF_MAP['1 Day'];
      return send(res, 200, JSON.stringify({ ...snap, tf, interval, asOf: new Date().toISOString() }));
    }

    if (u.pathname === '/api/quote') {
      const sym = (u.searchParams.get('sym') || '').toUpperCase().trim();
      if (!sym) return send(res, 400, JSON.stringify({ error: 'sym required' }));
      const ticker = sym.includes('.') ? sym : sym + '.NS';
      const data = await quote(ticker);
      if (!data) return send(res, 404, JSON.stringify({ error: 'not found' }));
      return send(res, 200, JSON.stringify(data));
    }

    if (u.pathname === '/api/atr') {
      const sym = (u.searchParams.get('sym') || '').toUpperCase().trim().replace('.NS', '');
      if (!sym) return send(res, 400, JSON.stringify({ error: 'sym required' }));
      try { return send(res, 200, JSON.stringify(await tvAtr(sym))); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/ratios') {
      const sym = (u.searchParams.get('sym') || '').toUpperCase().trim();
      if (!sym) return send(res, 400, JSON.stringify({ error: 'sym required' }));
      const ticker = TICKER_OVERRIDE[sym] || (sym.includes('.') || sym.startsWith('^') ? sym : sym + '.NS');
      // banks/NBFCs/insurers: generic statement ratios (op-margin, D/E, interest cover) are
      // meaningless, and their real ratios (NIM, NPA, CASA, CRAR) aren't in Yahoo fundamentals.
      const st = STOCKS.find(s => s.sym === sym);
      if (st && /bank|nbfc|financ|insurance/i.test(st.sector)) {
        return send(res, 200, JSON.stringify({ symbol: ticker, banking: true, source: 'unavailable', ratios: [],
          note: 'Bank/financial regulatory ratios (NIM, NPA, CASA, CRAR) are not available from the free data source, and generic statement ratios are not meaningful for lenders.' }));
      }
      const data = await computeRatios(ticker);
      if (!data) return send(res, 404, JSON.stringify({ error: 'no fundamentals available' }));
      return send(res, 200, JSON.stringify(data));
    }

    if (u.pathname === '/api/ohlc') {
      const raw = (u.searchParams.get('sym') || '').toUpperCase().trim();
      const tf = u.searchParams.get('tf') || '1 Day';
      const cfg = parseMaConfig(u.searchParams.get('matype'), u.searchParams.get('mas'));
      if (!raw) return send(res, 400, JSON.stringify({ error: 'sym required' }));
      const { interval, range } = TF_MAP[tf] || TF_MAP['1 Day'];
      let candles, ometa = {};
      if (raw === 'GOLD') {
        candles = await goldCandles(interval, range);
        if (!candles || !candles.length) return send(res, 404, JSON.stringify({ error: 'No gold chart data' }));
      } else {
        const yh = raw.startsWith('^') ? raw : (STOCKS.find(s => s.sym === raw) || {}).yh || (raw.includes('.') ? raw : raw + '.NS');
        const res2 = await yahooChart(yh, interval, range);
        if (!res2) return send(res, 404, JSON.stringify({ error: 'No chart data for "' + raw + '"' }));
        candles = adjustedCandles(res2);
        ometa = res2.meta || {};
      }
      const closes = candles.map(c => c.close);
      const masOut = cfg.lens.map(len => {
        const arr = rollingMA(closes, len, cfg.type);
        const line = [];
        for (let i = 0; i < arr.length; i++) if (arr[i] != null) line.push({ time: candles[i].time, value: +arr[i].toFixed(2) });
        return { len, type: cfg.type, line };
      });
      const N = 400;                                // cap payload to the most recent N bars
      const cc = candles.slice(-N);
      const cutoff = cc.length ? cc[0].time : 0;
      const mm = masOut.map(m => ({ ...m, line: m.line.filter(p => p.time >= cutoff) }));
      return send(res, 200, JSON.stringify({
        sym: raw, tf, interval, maType: cfg.type, candles: cc, mas: mm,
        meta: { currency: raw === 'GOLD' ? 'INR' : ometa.currency, price: raw === 'GOLD' ? (cc.length ? cc[cc.length - 1].close : null) : ometa.regularMarketPrice }, asOf: new Date().toISOString(),
      }));
    }

    if (u.pathname === '/api/index') {
      const name = u.searchParams.get('name') || 'Nifty 50';
      const def = INDEX_DEFS[name];
      if (!def) return send(res, 404, JSON.stringify({ error: 'unknown index' }));
      const idxRes = await yahooChart(def.yh, '1d', '5d');
      let index = null;
      if (idxRes) {
        const m = idxRes.meta || {};
        const c = ((idxRes.indicators.quote[0] || {}).close || []).filter(v => v != null && !isNaN(v));
        const price = m.regularMarketPrice != null ? m.regularMarketPrice : c[c.length - 1];
        const prev = c[c.length - 2];
        index = {
          value: price, change: prev ? +(price - prev).toFixed(2) : 0, pct: prev ? +(((price - prev) / prev) * 100).toFixed(2) : 0,
          dayHigh: m.regularMarketDayHigh, dayLow: m.regularMarketDayLow, week52High: m.fiftyTwoWeekHigh, week52Low: m.fiftyTwoWeekLow,
          volume: m.regularMarketVolume,
        };
      }
      let memberList = def.weighted || universe(name).map(s => [s.sym, null]);
      // the weighted lists only carry the TOP names by weight (approx weights) — for indices
      // whose official constituents we track, append the remaining members with weight=null
      // so the drill-down shows ALL 50/14/10 names, not just the top-30.
      if (def.weighted && ['Nifty 50', 'Bank Nifty', 'Nifty IT'].includes(name)) {
        const have = new Set(memberList.map(([s]) => s));
        for (const s of universe(name)) if (!have.has(s.sym)) memberList = memberList.concat([[s.sym, null]]);
      }
      const members = (await pool(memberList, 10, ([sym, w]) => memberSnap(sym, w))).filter(m => !m.error);
      if (def.weighted) members.sort((a, b) => (Math.abs(b.contribution) || 0) - (Math.abs(a.contribution) || 0) || b.pct - a.pct);
      else members.sort((a, b) => b.pct - a.pct);
      return send(res, 200, JSON.stringify({ name, yahoo: def.yh, weighted: !!def.weighted, index, members, asOf: new Date().toISOString() }));
    }

    if (u.pathname === '/api/sentiment') {
      const q = (u.searchParams.get('sym') || u.searchParams.get('q') || '').trim();
      if (!q) return send(res, 400, JSON.stringify({ error: 'sym required' }));
      try {
        return send(res, 200, JSON.stringify(await analyzeSentiment(q)));
      } catch (e) {
        return send(res, 502, JSON.stringify({ error: String(e && e.message || e) }));
      }
    }

    if (u.pathname === '/api/management') {
      const sym = (u.searchParams.get('sym') || '').toUpperCase().trim();
      if (!sym) return send(res, 400, JSON.stringify({ error: 'sym required' }));
      try { return send(res, 200, JSON.stringify(await companyManagement(sym))); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e), officers: [] })); }
    }

    if (u.pathname === '/api/swot') {
      const sym = (u.searchParams.get('sym') || '').trim().toUpperCase().replace(/\.NS$/, '');
      if (!sym) return send(res, 400, JSON.stringify({ error: 'sym required' }));
      try {
        return send(res, 200, JSON.stringify(await fetchSwot(sym)));
      } catch (e) {
        return send(res, 502, JSON.stringify({ error: String(e && e.message || e) }));
      }
    }

    if (u.pathname === '/api/portfolio') {
      // h = comma-separated SYM:QTY:BUY  (BUY optional). e.g. RELIANCE:10:1200,INFY:25:1450,ITC:100:
      const raw = (u.searchParams.get('h') || '').trim();
      if (!raw) return send(res, 400, JSON.stringify({ error: 'h required (SYM:QTY:BUY,...)' }));
      const holdings = raw.split(',').map(s => {
        const [sym, qty, buy] = s.split(':');
        return { sym: (sym || '').trim().toUpperCase().replace(/\.NS$/, ''), qty: +qty || 0, buy: (buy != null && buy !== '' && !isNaN(+buy)) ? +buy : null };
      }).filter(x => x.sym && x.qty > 0).slice(0, 60);
      if (!holdings.length) return send(res, 400, JSON.stringify({ error: 'no valid holdings' }));
      try {
        return send(res, 200, JSON.stringify(await analyzePortfolio(holdings)));
      } catch (e) {
        return send(res, 502, JSON.stringify({ error: String(e && e.message || e) }));
      }
    }

    if (u.pathname === '/api/pulse') {
      try { return send(res, 200, JSON.stringify(await pulseData())); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/watch') {
      const syms = (u.searchParams.get('syms') || '').split(',').map(s => s.trim().toUpperCase().replace(/\.NS$/, '')).filter(Boolean).slice(0, 30);
      if (!syms.length) return send(res, 400, JSON.stringify({ error: 'syms required' }));
      try { return send(res, 200, JSON.stringify({ rows: await watchQuotes(syms), asOf: new Date().toISOString() })); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/sparks') {
      try { return send(res, 200, JSON.stringify(await sparksData())); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/delivery') {
      const sym = (u.searchParams.get('sym') || '').toUpperCase().trim().replace(/\.NS$/, '');
      if (!sym) return send(res, 400, JSON.stringify({ error: 'sym required' }));
      try {
        const data = await deliveryAnalytics(sym);
        if (!data) return send(res, 404, JSON.stringify({ error: 'No NSE delivery data for "' + sym + '" (EQ series only)' }));
        return send(res, 200, JSON.stringify(data));
      } catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/delivery-spikes') {
      const uni = u.searchParams.get('uni') || 'Nifty 500';
      try { return send(res, 200, JSON.stringify(await deliverySpikes(uni))); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/fii-dii') {
      try { return send(res, 200, JSON.stringify(await fiidiiFlows())); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/deals') {
      try { return send(res, 200, JSON.stringify(await dealsData())); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/earnings') {
      const sym = (u.searchParams.get('sym') || '').toUpperCase().trim().replace(/\.NS$/, '');
      if (!sym) return send(res, 400, JSON.stringify({ error: 'sym required' }));
      try { return send(res, 200, JSON.stringify(await earningsReport(sym))); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/earnings-calendar') {
      try { return send(res, 200, JSON.stringify(await earningsCalendar())); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/peers') {
      const sym = (u.searchParams.get('sym') || '').toUpperCase().trim().replace(/\.NS$/, '');
      if (!sym) return send(res, 400, JSON.stringify({ error: 'sym required' }));
      try { return send(res, 200, JSON.stringify(await peerCompare(sym))); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/thesis') {
      const sym = (u.searchParams.get('sym') || '').toUpperCase().trim().replace(/\.NS$/, '');
      if (!sym) return send(res, 400, JSON.stringify({ error: 'sym required' }));
      try { return send(res, 200, JSON.stringify(await buildThesis(sym))); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/pfbacktest') {
      const raw = (u.searchParams.get('h') || '').trim();
      if (!raw) return send(res, 400, JSON.stringify({ error: 'h required (SYM:QTY,...)' }));
      const holdings = raw.split(',').map(s => {
        const [sym, qty] = s.split(':');
        return { sym: (sym || '').trim().toUpperCase().replace(/\.NS$/, ''), qty: +qty || 0 };
      }).filter(x => x.sym && x.qty > 0).slice(0, 60);
      if (!holdings.length) return send(res, 400, JSON.stringify({ error: 'no valid holdings' }));
      try { return send(res, 200, JSON.stringify(await backtestPortfolio(holdings))); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/possize') {
      const syms = (u.searchParams.get('syms') || '').split(',').map(s => s.trim()).filter(Boolean);
      const amount = +u.searchParams.get('amount') || 0;
      const capPct = (+u.searchParams.get('cap') || 25) / 100;
      const convictions = {};
      const cv = u.searchParams.get('conv');   // "SYM:score,SYM:score"
      if (cv) cv.split(',').forEach(p => { const [s, v] = p.split(':'); if (s) convictions[s.trim().toUpperCase()] = v; });
      try { return send(res, 200, JSON.stringify(await positionSizingPortfolio(syms, { amount, capPct, convictions }))); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/macro') {
      const ind = u.searchParams.get('ind') || 'inflation';
      const force = u.searchParams.get('fresh') === '1';   // ↻ Refresh button bypasses the 24h cache
      if (!WB_INDICATORS[ind]) return send(res, 400, JSON.stringify({ error: 'unknown indicator', available: Object.keys(WB_INDICATORS) }));
      try { return send(res, 200, JSON.stringify(await macroIndicator(ind, force))); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/macro-curated') {
      const ind = u.searchParams.get('ind');
      try {
        if (ind) return send(res, 200, JSON.stringify(macroCurated(ind)));
        // no ind → return the list of available curated indicators (for tab building)
        const doc = readLocalJson('macroCurated.json');
        const list = Object.keys(doc.indicators || {}).map(k => ({ key: k, label: doc.indicators[k].label }));
        return send(res, 200, JSON.stringify({ updated: doc.updated, indicators: list }));
      } catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/georisk') {
      try { return send(res, 200, JSON.stringify(readLocalJson('geopoliticalRisk.json'))); }
      catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    if (u.pathname === '/api/macro-geo') {
      try {
        const geo = await macroGeo();
        // geometry never changes — let the browser cache it, unlike the no-store API responses
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
        return res.end(JSON.stringify(geo));
      } catch (e) { return send(res, 502, JSON.stringify({ error: String(e && e.message || e) })); }
    }

    // static file — the app is a single HTML page; every other asset loads from a CDN or /api.
    // Serve ONLY an explicit allowlist so a public deployment can't hand out server.js, the
    // .cache/ or .claude/ folders, or any other source file that lives in this directory.
    const PUBLIC_FILES = { '/': 'stock-market.html', '/stock-market.html': 'stock-market.html' };
    const rel = PUBLIC_FILES[u.pathname];
    if (!rel) return send(res, 404, 'Not found', 'text/plain');
    const fp = path.join(__dirname, rel);
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(fp).toLowerCase();
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    return send(res, 200, fs.readFileSync(fp), types[ext] || 'application/octet-stream');
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: String(e && e.message || e) }));
  }
});

// ─────────── startup: hydrate universes + warm the heavy scans ───────────
(async function init() {
  // 1) instant: hydrate from disk cache so the very first request is never empty
  const disk = cacheLoad('constituents');
  if (disk.stocks && disk.stocks.length) {
    STOCKS = disk.stocks;
    if (disk.bank && disk.bank.length) BANK_SET = new Set(disk.bank);
    if (disk.it && disk.it.length)     IT_SET   = new Set(disk.it);
  }
  // 2) refresh the official NSE constituents now, then daily
  await loadConstituents().catch(() => {});
  setInterval(() => loadConstituents().catch(() => {}), 24 * 3600e3);
  // 3) warm the common scans in the background (only actually scans if the disk cache is cold/stale)
  const defCfg = parseMaConfig(null, null);   // default SMA 20/200 on 1 Day
  topTrend('1 Day', 'Nifty 50', defCfg).catch(() => {});
  topTrend('1 Day', 'Nifty 500', defCfg).catch(() => {});
  topMovers('Nifty 50', 'daily').catch(() => {});
  topExtremes('Nifty 50').catch(() => {});
  topExtremes('Nifty 500').catch(() => {});
  topGaps('Nifty 50').catch(() => {});
  topRS('Nifty 50', '1M').catch(() => {});
  // 4) warm the pro engines: bhav delivery history (disk-cached per day), FII/DII archive,
  //    bulk/block deals archive, NSE results calendar — all background, all failure-safe
  ensureBhavDays(26).then(d => console.log(`Bhavcopy delivery history: ${d.length} trading days ready`)).catch(() => {});
  fiidiiFlows().catch(() => {});
  dealsData().catch(() => {});
  earningsCalendar().catch(() => {});
  // 5) warm the Macro Maps page (geometry + default tab) — both disk-cached, so this is
  //    a no-op after the first ever run
  macroGeo().catch(() => {});
  macroIndicator('inflation').catch(() => {});
})();

server.listen(PORT, () => console.log(`MarketPulse running → http://localhost:${PORT}`));
