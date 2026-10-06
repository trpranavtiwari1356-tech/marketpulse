# MarketPulse — Live NSE Trading Filter

A stock-market dashboard with a **live heatmap** (20 & 200 SMA filter), live indices, and
live stock prices. Data comes from **Yahoo Finance's free endpoint** — no API key, no paid credits.

## Why a server?
Browsers block direct requests to Yahoo/NSE (CORS). A tiny local Node server (`server.js`)
fetches the data server-side, computes the moving averages, and serves the page.

## Run it
You need Node.js (v18+; v20+ recommended).

```bash
node server.js
```

Then open **http://localhost:5173** in your browser.

That's it — no `npm install`, no dependencies (uses Node's built-in `fetch` and `http`).

## What's live
| Feature | Source | Notes |
|---|---|---|
| Trend heatmap | Yahoo `/v8/finance/chart` | 20 & 200 SMA computed on the **selected candle interval** (2m / 5m / 15m / 1h / 1d / 1wk) |
| Return % per box | Yahoo daily series | Intraday frames = last-bar change; **1 Day** = 1-day change; **1 Week** = rolling 5-trading-day change |
| Index cards + nav pill | Yahoo (`^NSEI`, `^BSESN`, `^NSEBANK`, `^CNXIT`) | 1-day change |
| **Chart tools** | lightweight-charts | Every candlestick chart has a drawing toolbar (trend line / horizontal line / freehand, undo/clear, anchored to price+time), a full-screen button, and a moving-average menu (off / presets / custom lengths). The last-price line stretching across the chart is turned off |
| Stock Info price/levels | Yahoo | Live price, day range, 52-week range, 50/200-day SMA for any NSE symbol |
| **News** | Google News RSS (free, no key) | Real headlines, searchable per stock, **auto-refreshes every 90s** while the News tab is open |
| **Delivery % + volume conviction** | NSE daily bhavcopy (`sec_bhavdata_full`) | Per-stock delivery trend + accumulation/distribution read; market-wide **Delivery-Conviction Scanner** on the Flows tab |
| **FII/DII flows** | NSE `fiidiiTradeReact` | Latest session live; history archives locally and the chart grows day by day |
| **Bulk & block deals** | NSE archives `bulk.csv`/`block.csv` | Rolling 30-day local archive, Nifty-500 names highlighted |
| **Results calendar** | NSE board-meeting feed | Official upcoming results dates, Nifty-500 filter |
| **Earnings reaction tracker** | Yahoo (calendarEvents + visualization API) | Next results date + historical 1-day/5-day post-results moves and EPS surprises |
| **Peer comparison** | TradingView scanner + Yahoo filings | Valuation/quality/growth vs same-sector Nifty-500 peers, best-in-class starred |
| **Leadership & Management** | Yahoo `assetProfile.companyOfficers` | Key executives (name, title, age) for any NSE stock, C-suite first, each with a LinkedIn people-search deep-link + Google fallback. Note: no free feed carries verified LinkedIn profile URLs, so these are accurate name+company *search* links, not guessed `/in/` profiles |
| **Analyst Brief** | All engines, rule-based | Deterministic bull/bear/watch thesis citing real numbers — no LLM, no key |
| **Portfolio backtest + correlation** | Yahoo split-adjusted closes | 1-year equity curve vs NIFTY, CAGR/vol/Sharpe/max-drawdown, pairwise correlation matrix |
| **Macro Maps** | World Bank WDI via DBnomics + curated JSON | TradingView-style world choropleth in 4 categories — **Macro** (inflation, lending rate, GDP growth, unemployment, debt/GDP), **Energy** (renewables, crude-oil & gas output, nuclear share, coal), **Metals** (gold production & CB reserves, copper, lithium), **Trade** (oil-import reliance, India-flagged). G20/G7/BRICS+/ASEAN filters, ranked country panel, year slider |
| **Geopolitical Risk overlay** | `geopoliticalRisk.json` (hand-maintained) | Toggleable layers over the map: chokepoint pins (Hormuz/Malacca/Suez/Bab-el-Mandeb/Panama with status), conflict-zone shading, sanctions hatch. Risk ticker strip + click-through detail cards with curated India market-impact notes. Plus a country search (filter + fly-to), CSV export of the current ranking, and a world-median + India-rank summary |
| **Position Sizing → Single Trade** | Client-side + Yahoo quote | Risk-based share-quantity calculator: `qty = (capital × risk%) ÷ \|entry − stop\|`. Long/short, live entry price via `/api/quote`, reward-to-risk from an optional target, leverage/invalid-stop warnings. Capital & risk % persist in localStorage |
| **Position Sizing → Portfolio Allocator** | `/api/possize` (reuses backtest pipeline) | Risk-parity split across 2–8 stocks: inverse-volatility base + correlation penalty (>0.7 trimmed) + optional 0.25× fractional-Kelly conviction tilt + max-position cap. Outputs weight %, ₹ allocation and share qty; Chart.js donut; exports the sized basket into the Portfolio scoring module |

## Keeping the deployed site fresh
Yahoo- and Google-sourced features (prices, heatmap, indices, Stock Info, peers, earnings,
News) self-update on the live site with no help — those hosts don't block cloud IPs.

**NSE-sourced features cannot.** NSE blocks the deployed host's IP outright, so the live site
can never fetch bhavcopy, FII/DII, bulk/block deals or the results calendar itself. Git is the
transport instead: run this on the **local machine** (Indian residential IP, which NSE allows):

```bash
npm run refresh-data          # warm NSE caches, prune the bhav window, stage the snapshots
npm run refresh-data:push     # ...and commit + push, so the live site picks it up on redeploy
```

It boots a throwaway server on port 5199 (your normal one on 5173 is untouched), warms only
the four NSE feeds, keeps the newest 30 bhavcopy days, and stages `.cache/` — never `git add -A`.
Run it after the close on any day you want the live site current; if you skip a week, the live
site keeps serving the last snapshot you pushed rather than showing an error.

Committed snapshots are public market data only — no credentials. Don't pre-gzip them: git
already zlib-packs each bhavcopy to ~64 KB and manual gzip would defeat delta compression.

## Traffic stats (Cloudflare Web Analytics)
Page-view counting is off unless the host sets `CF_BEACON_TOKEN` to the site token from
Cloudflare's Web Analytics dashboard. When it's set, `server.js` injects the beacon `<script>`
before `</body>` as the HTML is served; when it isn't, the page goes out byte-identical to the
file on disk. That's deliberate — local and dev runs never pollute the stats, and the token
isn't committed. Cookieless, so no consent banner is required.

Note the beacon is a client-side script: adblockers suppress it, so treat the numbers as a
floor on real traffic rather than an exact count.

## Refresh behaviour
- **News** updates automatically (every 90s, only while you're on the News tab).
- **Heatmap is manual on purpose** — it loads once when you first open the Trend tab, then only re-fetches when you click **↻ Refresh Live Data** or change a Time Frame / Universe pill. Switching tabs does not re-pull it.

## Reading the heatmap
- 🟢 **Green** — price above **both** 20 & 200 MA (bullish)
- 🔴 **Red** — price below **both** 20 & 200 MA (bearish)
- 🟡 **Yellow** — mixed (e.g. above 20 but below 200 — early reversal)

The **LIVE** badge confirms real data. If the badge says **SIMULATED**, the Node server
isn't reachable and the heatmap is showing demo data — **don't trade on it**.

## Not live (illustrative)
- **SWOT / PESTLE & fundamentals** (P/E, market cap, revenue mix) — curated for Infosys, TCS,
  Reliance, HDFC Bank, Wipro. The **price** on those pages is still live.
- If the Node server is down, News falls back to sample headlines (clearly badged **OFFLINE**).

## Macro Maps granularity (be aware before comparing to TradingView)
Cross-country data is the **World Bank WDI** dataset, fetched through **DBnomics**
(`api.db.nomics.world`) rather than `api.worldbank.org` directly — some ISPs (seen on an
Indian connection) SNI-filter the World Bank host so a direct fetch hangs; DBnomics mirrors
the identical series from a reachable host. These series are **annual** and publish with a
lag (the DBnomics snapshot currently ends ~2023) — the Macro page's time slider steps by
**year**, and every country row shows its own observation year.
TradingView's Macro Maps show *monthly* prints (e.g. "Mar 2025"), so its numbers will
differ from the annual averages here — both are correct for what they measure.
Known gaps surfaced honestly: India's central-govt debt series stops at 2018 (IMF backfill
planned), the Interest Rate tab is the commercial **lending** rate (policy rates need
FRED — planned), and Manufacturing PMI has no free cross-country source (tab marked
"planned"). The India Snapshot strip (RBI repo, CPI/WPI, INR, FII/DII — monthly/daily)
is the next phase.

**Energy/Metals/Trade tabs** are hand-curated from authoritative public sources (USGS Mineral
Commodity Summaries, EIA, Energy Institute Statistical Review, World Gold Council/IMF, IAEA)
because those figures (production tonnes, refining capacity, reserves) have no free
cross-country JSON API. They live in `macroCurated.json` — single-year snapshots (slider
fixed), each row tagged with its source + reference year. Edit that file and refresh; no
server restart needed. The one live World Bank energy series still updated to a recent year
is "Renewables (% energy)".

**Geopolitical Risk** lives in `geopoliticalRisk.json` — a hand-maintained config (not a live
feed), so you edit chokepoint statuses, conflict zones, sanctions and India market-impact
notes yourself and refresh. Each entry has id/name/lat/lng/type/status/flowPercentage/
lastUpdated/note/marketImpact. Bump the top-level `updated` field (`YYYY-MM`) whenever you
review it: the risk ticker reads that and stamps itself "as of <month>", turning amber with a
"⚠ N months old" warning once it falls behind — so a stale "Hormuz: Elevated" can't read as
breaking news. Same for `macroCurated.json`'s `updated` field on the Macro tab.

## Tickers
The universe uses NSE symbols (`.NS`). Occasionally Yahoo drops one (shown as "no data: …");
that's surfaced explicitly rather than hidden.

## Visitor analytics, accounts & the admin dashboard
`/admin` is a private dashboard. Pick a period (today, yesterday, 7 / 30 / 90 days, all time) and
everything on the page follows it:

- **On the site now** — one card per person, marked *first visit* or *returning*.
- **Headline numbers** — visitors, new visitors, visits, average active time, engaged visits,
  each compared with the same window one period earlier (today so far vs yesterday to the same time).
- **Visitors by hour / day** — new vs returning, with a table view.
- **Latest visitors** — cards with place, active time, visits, last seen, source and sections.
- **Breakdowns** — traffic sources, locations, devices and sections viewed.
- **Tables** — visitors, visits and accounts. Every table and breakdown has a **CSV download**
  (visits, visitors and accounts download complete from the server, not just the rows on screen).
- **Tracking links** — make `/?ref=name` links so each place you share the site shows up by name.

Definitions (what a visitor, visit, active time, etc. mean) are listed at the bottom of the page.
Days and times are Indian Standard Time. Your own devices are marked **This is me** (any browser
signed in to `/admin` is marked automatically) and are left out of every number.

Visitors can optionally create an account (name + email + password, scrypt-hashed) from the
**Sign in** button in the nav; their visits then show with their name.

Set these environment variables on the host (Render → your service → Environment):

| Variable | What it is |
|---|---|
| `ADMIN_PASSWORD` | Password for `/admin`. Without it, `/admin` only opens on localhost. |
| `SUPABASE_URL` | Supabase project URL (Project Settings → API). |
| `SUPABASE_SERVICE_KEY` | Supabase **secret / service_role** key — server-only, never put it in the HTML. |
| `SESSION_SECRET` | Optional. Any long random string; otherwise derived from `ADMIN_PASSWORD`. |

Run `supabase-setup.sql` in Supabase's SQL editor once, and again after updates (it is safe to
re-run). It creates the tables and the `mp_overview` / `mp_visitor_list` functions that compute the
dashboard inside Postgres, so the numbers stay exact and fast however much traffic arrives. Until it
has been run, `/admin` says so and falls back to computing from the newest 50,000 visits. Without
Supabase the data goes to `.data/visitors.json`, which is fine locally but wiped on every Render
restart.

The SQL functions and `visitor-stats.js` (used locally and as the fallback) implement the same
definitions; `tests/visitor-stats.test.js` checks they agree. To include that check, point
`PGLITE_PATH` at a folder with `@electric-sql/pglite` installed (it runs Postgres in-process).
