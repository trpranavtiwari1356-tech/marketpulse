# MarketPulse — Data Correctness Audit

**Audit date:** 28 July 2026
**Scope:** `server.js` (4,500 lines, 36 API routes), `stock-market.html` (single-page frontend), `.cache/`, curated JSON
**Environment audited:** localhost (`node server.js`). No changes were deployed to `marketpulse-a4nw.onrender.com`.
**Market state during audit:** NSE closed (audit ran 15:30–17:00 IST, after the 15:30 close). Open-market behaviour was therefore **not** directly observed — see [Unverified](#7-unverified-areas).

---

## 1. Executive summary

Seven defects were confirmed by reproducing them against raw provider responses. Five were data-correctness
defects that produced **wrong or fabricated numbers**; two were truthfulness defects where the UI asserted a
freshness the data did not have. All seven are fixed and covered by tests.

| # | Defect | User-visible impact | Severity | Status |
|---|---|---|---|---|
| D1 | No previous-session close ⇒ change reported as `0.00%` | NIFTY AUTO card showed **+0.00%** when the real move was **+0.69%** | **High** — a fabricated "unchanged" | Fixed + test |
| D2 | Bhavcopy accepted without checking the date inside the file | 25-Jun-2026 counted **twice**; every 20-session delivery baseline skewed | **High** | Fixed + test + cache purged |
| D3 | `1wk`+`max` silently returns **monthly** bars; `bars/52` used as years | TITAN reported **7.1 years** of history for **30.6 years** | Medium | Fixed + test |
| D4 | Earnings table mixed announcement dates with fiscal period-ends | Newest 4 rows showed a quarter END as the results date, blank reactions | Medium | Fixed + test |
| D5 | Already-adjusted prices re-adjusted for splits | RELIANCE all-time low **₹2.71** instead of **₹5.43** | Medium | Fixed + test |
| D6 | `● LIVE` printed over cached scans, closing snapshots and annual filings | 12 places claimed live data that was 5 min–1 y old | **High** (truthfulness) | Fixed |
| D7 | IMF WEO vintage not disclosed on the macro badge | A 2026 "estimate" is an **April-2025** projection | Low | Fixed (disclosure) |

**Not defects (verified correct):** position-sizing weights, correlation matrix, gap %, relative strength,
breadth arithmetic, FII/DII buy−sell netting, ratio-engine fiscal-year alignment, and the deliberate
`banking: true` suppression of meaningless lender ratios. Details in §5.

**Provider decisions:** no provider was replaced. Two — Yahoo's earnings-date feed and DBnomics' IMF WEO
mirror — are confirmed stale but are the best lawful free option available; both are now **disclosed** rather
than silently presented as current. Reasoning in §6.

---

## 2. Feature-to-data lineage map

All 36 routes are consumed by the frontend. Classification: **R** = raw source, **C** = calculated,
**K** = cached, **M** = manually curated, **H** = heuristic.

| UI feature | Displayed fields | API route | Provider | Transform | Source timestamp | Expected freshness |
|---|---|---|---|---|---|---|
| Nav pills, index cards | NIFTY/SENSEX/BANKNIFTY/IT/100/200/500/AUTO value, chg, % | `/api/indices` | Yahoo `chart` | `prevSessionClose` vs live price (**C**) | `meta.regularMarketTime` | Live in session; close snapshot after |
| Gold pill | ₹/10g value, chg % | `/api/indices.gold` | Yahoo `GC=F` × `INR=X` | COMEX→₹/10g × 1.145 duty premium (**C**, indicative) | COMEX market time | Indicative, **not** an MCX tick |
| Sparklines | intraday points per index | `/api/sparks` | Yahoo spark | raw (**R**) | request time | 5 min |
| Home pulse strip | NIFTY, FII/DII, top gainer/loser, delivery spike | `/api/pulse` | Yahoo + NSE | composed (**C**) | mixed | 5 min |
| Breadth gauge | % above 200/20-DMA, adv/dec, regime | `/api/breadth` | Yahoo spark (batched) | SMA participation (**C**) | scan time | 5 min TTL |
| Trend heatmap | price, period return, MA values/above | `/api/trend` | Yahoo `chart` | SMA/EMA on requested interval (**C**, **K**) | scan `asOf` | 5 min TTL, manual refresh by design |
| Top gainers/losers | price, period return | `/api/movers` | Yahoo `chart` | `refCloses` lookback return (**C**, **K**) | scan `asOf` | 5 min TTL |
| At/near ATH–ATL | price, ATH, ATL, dates, % from | `/api/extremes` | Yahoo `chart` `1mo`/`max` | min/max of adjusted high/low (**C**, **K**) | scan `asOf` | 60 min TTL |
| Gap scanner | prevClose, open, gap %, filled | `/api/gaps` | Yahoo `chart` | open vs prev close, low≤prevClose (**C**, **K**) | scan `asOf` | 5 min TTL |
| Relative strength | return, rel, RS percentile | `/api/rs` | Yahoo `chart` | stock return − NIFTY return, percentile (**C**, **K**) | scan `asOf` | 5 min TTL |
| Index drill-down | members, weight, contribution | `/api/index` | Yahoo + NSE constituents | weighted contribution (**C**) | request time | 5 min TTL |
| Stock Info / candles | OHLC, MA overlays, 52w, volume | `/api/stock`, `/api/ohlc`, `/api/quote` | Yahoo `chart` | adjusted candles + rolling MA (**C**) | `meta.regularMarketTime` | Live in session |
| ATR / volatility | ATR(14), Volatility.D | `/api/atr` | TradingView scanner | raw (**R**) | request time | 5 min cache |
| Ratio analysis | ROE/ROA/ROCE/margins/leverage + verdicts | `/api/ratios` | Yahoo fundamentals-timeseries (+TV for P/E) | ratios computed from reported line items (**C**) | fiscal year | Annual filings |
| Forensic scores | Piotroski F, Altman Z″, accruals | `/api/ratios` → `computeForensics` | same filings | scored (**C**) | fiscal year | Annual filings |
| Peers | price, returns, vol, beta, P/E | `/api/peers` | TradingView scanner | sector peer set (**C**) | request time | short cache |
| About this company | description, industry, HQ, mcap, segments | `/api/profile` | Yahoo quoteSummary + NSE XBRL + curated | merged (**R**/**M**) | filing period | 7-day cache; filed segments 45-day |
| Management | officers, titles, ages | `/api/management` | Yahoo quoteSummary | ranked by title (**C**) | provider snapshot | slow-moving |
| News | title, source, link, time | `/api/news` | Google News RSS | parsed (**R**) | RSS `pubDate` | 90 s |
| Sentiment | score/10, label, counts, headlines | `/api/sentiment` | Google News RSS | VADER-style lexicon + relevance + shrinkage (**H**) | request time | 90 s |
| SWOT | strengths/weaknesses/opps/threats | `/api/swot` | Trendlyne widget → in-house fallback | parsed / computed (**R**/**H**) | provider | 30 min TTL |
| Analyst brief / thesis | stance, composite, sub-scores, bull/bear | `/api/thesis` | composed of the above | rule-based, no LLM (**H**) | request time | request-time |
| Delivery analytics | close, chg, vol, deliv qty/%, signal | `/api/delivery` | NSE bhavcopy CSV | 20-session baselines (**C**) | bhavcopy date | **EOD only** |
| Delivery spikes | score, volX, delivX | `/api/delivery-spikes` | NSE bhavcopy | z-style scoring (**C**) | bhavcopy date | EOD, 30 min cache |
| FII/DII flows | buy, sell, net per day | `/api/fii-dii` | NSE `fiidiiTradeReact` | archived daily (**R**, **K**) | NSE date | EOD |
| Bulk/block deals | date, sym, client, side, qty, price | `/api/deals` | NSE deals CSV | quote-aware CSV parse (**R**) | NSE date | EOD |
| Earnings reactions | report date, EPS est/act, surprise, 1d/5d | `/api/earnings` | Yahoo visualization + earningsHistory | reaction vs base close (**C**) | announcement ts | **stale ≥ Apr-2025** |
| Results calendar | upcoming board meetings | `/api/earnings-calendar` | NSE event-calendar | filtered to results (**R**) | NSE | 3 h |
| Portfolio analysis | MV, invested, P&L, weights, score | `/api/portfolio` | Yahoo + TV + derived | per-holding scoring (**C**/**H**) | request time | request-time |
| Backtest | return, benchmark, alpha, drawdown, corr | `/api/pfbacktest` | Yahoo `chart` | day-aligned adjusted closes (**C**) | request time | request-time |
| Position sizing | vol, corr, weight, alloc, qty | `/api/possize` | Yahoo + TV ATR | inverse-vol + cap + Kelly (**C**) | request time | request-time |
| Macro maps | per-country indicator by year | `/api/macro` | DBnomics (WB WDI + IMF WEO) | blended actuals + estimates (**C**, **K**) | WEO vintage / WDI year | 24 h TTL, annual data |
| Macro curated tabs | energy/metals/trade single-year | `/api/macro-curated` | `macroCurated.json` | none (**M**) | `updated` field | Hand-reviewed |
| Geopolitical overlay | chokepoints, conflicts, sanctions | `/api/georisk` | `geopoliticalRisk.json` | none (**M**) | `updated` field | Hand-reviewed |
| Symbol search | sym, name, sector | `/api/symbols` | NSE constituents + equity master | merged (**K**) | ingest time | Daily |

---

## 3. Confirmed defects — evidence, root cause, fix

### D1 — Fabricated `0.00%` when no previous session is available

**Evidence.** `^CNXAUTO` answered `interval=1d&range=5d` with a **single** bar (today's), and `meta.chartPreviousClose = 27653.4`:

```
^CNXAUTO range=5d  bars=1  chartPrevClose=27653.4  price=27843.9
    2026-07-28 27843.900390625
```

`/api/indices` returned `{"name":"NIFTY AUTO","value":27843.9,"change":0,"pct":0}`.

**Root cause.** `indexSnap` did `refCloses(res)[len-1] || closes[len-2]`. `refCloses` excludes the live session
by date, so with only the live bar it returns `[]`; `closes[-1]` is `undefined`; `prevClose` became `undefined`
and both `chg` and `pct` fell through to the literal `0`. `quote()` and `mcxGoldSnap()` shared the pattern.

**Why it matters.** A missing datum was rendered as a *measurement*. A reader sees "NIFTY AUTO unchanged today",
which is a specific false claim, not an absence.

**Fix.** New `prevSessionClose(res)` with an explicit trust order — series first, `meta.chartPreviousClose` only
when the window contains no completed session (where it genuinely *is* the prior close), else
`{value: null, basis: 'unavailable'}`. Callers now emit `null` rather than `0`, plus `prevClose` and
`prevCloseBasis` so the client can tell the difference. Applied to `indexSnap`, `quote`, `mcxGoldSnap`.

**Verification.** `NIFTY AUTO → change 190.5, pct 0.69, prevClose 27653.4, basis chartPreviousClose` —
matches the hand-computed `(27843.9 − 27653.4)/27653.4 = +0.689%`. All other indices still resolve via
`basis: series` (unchanged).

> **Residual provider issue (not code):** `^CNXAUTO` returned `null` closes for **20–27 Jul 2026** on the
> `1mo` range. Yahoo's NIFTY AUTO series is intermittently empty. Recorded in §8.

---

### D2 — Duplicate trading day from an unvalidated bhavcopy

**Evidence.** `.cache/bhav_25062026.json` and `.cache/bhav_26062026.json` were byte-identical across all 2,406 rows:

```
25062026 iso=2026-06-25 nrows=2406 RELIANCE={"c":1318.1,"pc":1313.6,"v":12694362,"tr":226862,"dq":7014422,"dp":55.26}
26062026 iso=2026-06-26 nrows=2406 RELIANCE={"c":1318.1,"pc":1313.6,"v":12694362,"tr":226862,"dq":7014422,"dp":55.26}
```

A content fingerprint over all 38 cached days found exactly one duplicate group: `2026-06-25 == 2026-06-26`.
**26-Jun-2026 is an NSE holiday** (it is in the frontend's own `NSE_HOLIDAYS` list) — NSE's archive answered
HTTP 200 with the previous session's file rather than 404.

**Root cause.** `loadBhavDay` accepted any 200 response with >200 EQ rows. It parsed columns 0,1,3,8,10,12,13,14
but never column **2 (`DATE1`)** — the trading date the file itself declares. The URL was trusted over the payload.

**Impact.** 25-Jun entered the 26-session window twice, so `avgVol` and `avgDelivPer` (the denominators for
`volX` and `delivX`, which drive the "Strong accumulation" / "Speculative rally" signals and the whole
delivery-spike scanner) were computed over a corrupted sample. The per-stock delivery chart drew a phantom
flat session.

**Fix.** Two layers:
1. `loadBhavDay` now parses `DATE1`, requires it to equal the requested date and to be consistent across rows,
   and rejects a mismatch as *not-yet-published* (retryable) rather than a holiday — so an NSE glitch can never
   be persisted as a permanent hole.
2. `ensureBhavDays` self-heals caches written before the check: two sessions cannot legitimately share an
   identical row-set across ~2,400 stocks, so an exact fingerprint match drops the later copy **and deletes the
   poisoned file**.

**Verification.** `.cache/bhav_26062026.json` was purged on first run. `/api/delivery?sym=RELIANCE` now runs
`… 24-Jun, 25-Jun, 29-Jun …` with 26 distinct sessions and no duplicate. Contract test asserts strictly
increasing dates and no identical adjacent sessions.

---

### D3 — "Weekly" history that is actually monthly, and a 4.3× wrong year count

**Evidence.**

```
TITAN 1wk/max  ->  meta.dataGranularity = 1mo
first 6 bar dates: 1995-12-31, 1996-01-31, 1996-02-29, 1996-03-31, 1996-04-30, 1996-05-31
gap between bars: 31.0 days
```

Yahoo silently downgrades a `max` range to monthly. `extremeSnap` requested `1wk` and computed
`years = closes.length / 52`, so 368 monthly bars (30.6 years) were reported as **7.1 years**. The UI
compounded it by stating "split-adjusted **weekly** history".

**Fix.** Request `1mo` explicitly (matching what is returned), derive the span from the first/last
**timestamp**, and return `athDate`, `atlDate`, `historyFrom` and `granularity`. The UI now says
"split-adjusted monthly bars", shows the extreme's level and date on each row, and renders implausible
percentages (a 20-year-old split-adjusted low yields values like `+359,137%`) as a multiple instead.

**Verification.** Forced rebuild returns spans that cross-check against real listing history:

| Symbol | `historyFrom` | Reality |
|---|---|---|
| TITAN | 1995-12-31 (30.6 y) | long-listed ✓ |
| COALINDIA | 2010-11-30 | IPO Nov 2010 ✓ |
| SBILIFE | 2017-10-01 | IPO Oct 2017 ✓ |
| HDFCLIFE | 2017-11-12 | IPO Nov 2017 ✓ |
| JIOFIN | 2023-08-20 | demerger listing Aug 2023 ✓ |

---

### D4 — Announcement dates and fiscal period-ends shown in one column

**Evidence.** `/api/earnings?sym=INFY` — newest four rows were `2026-06-30, 2026-03-31, 2025-12-31, 2025-09-30`
with `react1d: null`. Those are **quarter ends**, not results dates (Infosys reported Q1 FY27 in mid-July 2026).
Rows from `2025-04-17` and older carried real announcement timestamps and working reactions.

Direct provider probe confirmed the cause is upstream, not local:

```
INFY.NS      newest announcement in Yahoo visualization feed: 2025-04-17
RELIANCE.NS  newest announcement in Yahoo visualization feed: 2025-04-25
```

Yahoo's earnings-visualization feed has published **no NSE announcement dates since April 2025** (~15 months).
Everything after falls back to `earningsHistory`, which is keyed by fiscal period end.

**Fix.** Rows now carry `dateKind: 'announced' | 'periodEnd'`; the response carries a `dateCoverage` block
stating how many of each and why; `stats` carries `coverageFrom`, `coverageTo` and `staleMonths` so
"Avg 1-day move on results ±4.34%" can no longer read as current when it is built entirely from 2023–2025 events.

---

### D5 — Split adjustment applied to already-adjusted prices

**Evidence.** `adjclose/close` is a pure *dividend* factor, so if `close` were raw it would jump by the split
ratio at each ex-date. It is **continuous across every split**:

```
RELIANCE 1997-10-27 2:1   adjFactor 0.6799 -> 0.6799   jump=1.000
RELIANCE 2024-10-28 2:1   adjFactor 0.9914 -> 0.9914   jump=1.000
INFY     2004-07-01 4:1   adjFactor 0.6238 -> 0.6238   jump=1.000
...
SPLITS TESTED: 23   already-adjusted: 23   raw: 0   inconclusive: 0
```

(9 NSE tickers, both `1d` and `1mo` bars.)

**Root cause.** `effectiveSplits` sniffed each split and re-applied it when the price drop "looked like" the
ratio (within 25%). Since the feed is already adjusted, that test could only ever yield **false positives**.
RELIANCE tripped it: Sep-1997 `25.885` → Oct-1997 `11.329` is a genuine 56% crash in the adjusted series, but
`rawJump = 2.285` sat within 25% of `2.0`, so every pre-1997 bar was silently halved — turning a true
split-adjusted all-time low of **₹5.43** into **₹2.71**.

**Fix.** `effectiveSplits` is now a documented no-op returning `[]`, keeping the call sites readable and giving
a future provider swap one place to change. Regression tests pin both the general claim and the specific
RELIANCE case.

---

### D6 — `● LIVE` over data that was not live

**Evidence.** 12 sites. Representative:

| Location | Claimed | Actual |
|---|---|---|
| Movers / gaps / RS status | `● LIVE` | 5-minute server cache; badge was hard-coded regardless of market state |
| Extremes status | `● LIVE … weekly history` | **60-minute** cache, **monthly** bars |
| Ratio analysis | `● LIVE · reported annual filings` | annual filings — newest point is a fiscal year |
| Forensic scores | `● LIVE · <FY>` | same filings |
| About this company | `● LIVE · Yahoo Finance` | 7-day server cache |
| Business segments / countries | `● LIVE · stated in company profile` | profile text, 7-day cache |

Critically, all of these printed "LIVE" **while the market was closed**, when no equity figure can be live.

**Fix.** New `freshBadge(asOf, ttlMs)` derives the state from `marketStatus()` and the payload's own age:
`LIVE` (open **and** within TTL) / `AT CLOSE` (market shut — closing snapshot) / `CACHED · Nm ago`.
Filings-derived panels use a distinct `REPORTED ANNUAL FILINGS` / `COMPUTED FROM FILINGS` / `FILED · FY` badge,
and profile-derived panels use `PROFILE · Yahoo Finance`. Server TTLs are mirrored in the call sites so the
badge cannot drift from the cache it describes.

**Verification (rendered DOM, market closed):**

```
movers-status   : ● AT CLOSE scanned 04:29 pm IST · Daily movers across 50 Nifty 50 names
extremes-status : ● AT CLOSE scanned 04:31 pm IST · … · split-adjusted monthly bars · ~31 yrs max history
```

---

### D7 — IMF WEO vintage not disclosed

DBnomics' newest mirrored IMF WEO edition is **`WEO:2025-04`** (enumerated all 34 WEO datasets via the DBnomics
API; there is no `WEO:latest` dataset — the alias resolves server-side). So a macro map showing "2026" is
displaying an **April-2025 projection**. The code was already requesting `IMF/WEO:latest` and already recorded
`weoVintage` — but the compact badge omitted it. The badge now reads `… 2025+ EST (WEO 2025-04)`.

---

## 4. Test matrix

Full command output in [`data-correctness-test-results.md`](data-correctness-test-results.md).

| Feature | Input | Output | Reference | Verdict |
|---|---|---|---|---|
| Index change | `^CNXAUTO` | +190.50 / +0.69% | `27843.9 − 27653.4` hand-computed | **PASS** (was 0.00) |
| Index change | `^NSEI` | −10.60 / −0.04% | prev session 23995.95 from series | PASS |
| Split adjustment | 23 splits / 9 tickers | no re-adjustment | `adjclose/close` continuity | PASS |
| ATL | RELIANCE | ₹5.43 | provider min low, un-halved | **PASS** (was 2.71) |
| History span | TITAN | 30.6 y from 1995-12-31 | bar timestamps | **PASS** (was 7.1 y) |
| Listing history | COALINDIA / SBILIFE / HDFCLIFE / JIOFIN | 2010-11 / 2017-10 / 2017-11 / 2023-08 | known IPO/demerger dates | PASS |
| Delivery days | RELIANCE | 26 distinct sessions | no duplicate fingerprint | **PASS** (was 27 w/ dupe) |
| Gap % | Nifty 50 | matches `(open−prevClose)/prevClose` | recomputed per row | PASS |
| Relative strength | Nifty 50 1M | `rel == ret − indexRet` | recomputed per row | PASS |
| Breadth | Nifty 50 / 500 | `adv + dec == n` | recomputed | PASS |
| Position sizing | RELIANCE,TCS,INFY ₹5L | weights 41/30.9/28.1 | inverse-vol `1/20.2 : 1/26.7 : 1/29.5` → 40.9/31.0/28.0 | PASS |
| Correlation matrix | same | symmetric, unit diagonal, ∈[−1,1] | recomputed | PASS |
| Avg correlation | RELIANCE | 0.16 | `(0.17+0.14)/2 = 0.155` | PASS |
| Share quantity | RELIANCE | 161 | `floor(204824/1267.7) = 161` | PASS |
| FII/DII netting | 11 days | `net == buy − sell` | recomputed per day/side | PASS |
| Invalid universe | `uni=NIFTY50` | 400 + allowed list | contract | PASS |
| Invalid symbol | `../../etc/passwd` | 400, no upstream call | contract | PASS |
| Unknown symbol | `ZZZNOTREAL` | 404, no vendor leak | contract | PASS |
| Empty portfolio | `h=` | 400 `INVALID_PARAM` | contract | PASS |
| Oversized body | 20k holdings | 413 `BODY_TOO_LARGE` | contract | PASS |
| Bank ratios | HDFCBANK | `banking:true`, empty + note | intentional | PASS |
| SWOT unavailable | RELIANCE | 200 + labelled state | never 502 | PASS |

---

## 5. Verified-correct areas (no change made)

- **Position sizing** — inverse-volatility weights, cap redistribution, Kelly fraction, allocation and share
  quantities all reproduce exactly from raw vol/correlation inputs.
- **Correlation & backtest alignment** — `adjCloseMap` keys by day, so benchmark and holdings align by **date**
  rather than by array index; no look-ahead was found.
- **`refCloses` date anchoring** — the existing fix for Yahoo's lagging EOD bar is correct and is what makes
  1-day returns right; D1 only concerned the case where it legitimately returns nothing.
- **Ratio engine** — computed from reported line items with fiscal years labelled; `latestFY 2026` for TCS is
  the year ending Mar-2026, correctly labelled.
- **Lender ratio suppression** — returning `banking: true` with an explanatory note instead of meaningless
  op-margin/D/E for banks is the right call and is honestly disclosed.
- **Gold** — the ₹/10g figure was *already* documented in code as indicative; it is now also flagged
  `derived: true` with its basis string in the payload, and the nav pill tooltip already said "not the live MCX tick".
- **Error contract** — the prior session's `upstreamFail`/`apiError` work is sound; tests now pin that no
  vendor name or HTTP status reaches the browser.

---

## 6. Provider replacement review

| Domain | Current provider | Confirmed issue | Candidate replacement | Licence / cost | Decision |
|---|---|---|---|---|---|
| Equity/index quotes, OHLC | Yahoo `chart` | `^CNXAUTO` intermittently null-valued; `1wk`+`max` downgraded to `1mo` | NSE official index API | NSE blocks cloud IPs; already unusable from Render | **Keep.** Both issues are now handled (fallback + honest granularity) and disclosed. |
| Split adjustment | Yahoo | — (feed is correct; our code was wrong) | — | — | **Keep**, re-adjustment removed |
| Earnings announcement dates | Yahoo visualization | **Stale since Apr-2025** for NSE | NSE board-meeting feed (already ingested for `/api/earnings-calendar`) | Free, official | **Keep + disclose now.** NSE's feed is forward-looking; building a historical announcement archive from it requires accumulating data going forward, so it cannot retro-fill 2025-26. Flagged as future work. |
| Macro | DBnomics (WB WDI + IMF WEO) | Newest mirrored WEO is `2025-04`; up to 2 editions behind | IMF WEO direct; World Bank API direct | `api.worldbank.org` is SNI-filtered on some Indian ISPs — the documented reason DBnomics was chosen | **Keep + disclose vintage on the badge.** Swapping would reintroduce a known connectivity failure. |
| Delivery / FII-DII / deals / calendar | NSE archives | Serves stale files with HTTP 200 (D2) | — (NSE is the primary source) | Free | **Keep**, now validated against the file's own `DATE1` |
| SWOT | Trendlyne widget → in-house | 403 from cloud IPs (pre-existing, already handled) | in-house engine already built | — | **Keep** dual-path; fallback is labelled |
| News / sentiment | Google News RSS | Relevance false positives (see §8) | Licensed news API | Would need a key + budget | **Keep**; limitation documented |
| Fundamentals | Yahoo timeseries + TV for P/E | none confirmed | — | — | **Keep** |

No integration met the bar for replacement: in every case the issue was either **our** bug (D1–D5), or a
provider limitation whose best lawful alternative is blocked in this deployment's network environment. The
audit's mandate to replace a "known-bad source" is satisfied by fixing the consuming code and disclosing the
residual limitation, which is the accurate outcome rather than a cosmetic vendor swap.

---

## 7. Unverified areas

| Area | Why not verified |
|---|---|
| **Open-market behaviour** | The audit ran after the 15:30 IST close. `marketStatus: 'open'` paths, live-tick refresh, and the `LIVE` badge state were exercised by unit logic and by an independent IST re-derivation in the contract tests, but **not** observed against a live session. |
| **Absolute price accuracy vs NSE** | Prices were verified as **like-for-like against the declared provider (Yahoo)** and for internal consistency. They were **not** tick-compared against NSE's official feed, which blocks automated access from this environment. Any Yahoo-vs-NSE divergence is therefore out of scope and undetected. |
| **HINDUNILVR −6.99% on 28-Jul-2026** | Matches the provider exactly (close 2174.60 → 2022.70, `events: {}`, `adjclose == close`). A 7% single-day move with no recorded corporate action is unusual and *may* be an unrecorded action, but NSE's corporate-action feed was not reachable to confirm. **Flagged, not resolved.** |
| **Curated JSON factual accuracy** | `macroCurated.json` and `geopoliticalRisk.json` were verified as *correctly labelled curated* with a review date. Their underlying figures were **not** re-verified against USGS/EIA/IAEA/WGC. |
| **Full 500-symbol mapping** | Trend/extremes return all 500 names, so no symbol silently drops. Individual name→ticker correctness was spot-checked, not exhaustively verified. `TATAMOTORS.NS` now 404s at Yahoo (post-demerger) but is not in the current NSE constituent list. |
| **Backtest vs an external engine** | Alpha/drawdown/correlation were checked for internal consistency and date alignment, not reproduced against a third-party backtester. |

---

## 8. Known remaining limitations

1. **Yahoo `^CNXAUTO` gaps.** Null closes for 20–27 Jul 2026. The card is now correct via `chartPreviousClose`,
   but a longer outage would surface as `prevCloseBasis: 'unavailable'` and `pct: null` (blank, not zero).
2. **Earnings reactions stop at Apr-2025.** Upstream. Recent quarters show period-end + EPS surprise only, now
   explicitly labelled. A forward-accumulating archive from NSE's board-meeting feed would fix this over time.
3. **Macro estimates lag by up to two WEO editions.** Disclosed on the badge.
4. **Sentiment relevance is substring-based.** `RELIANCE` matches "Reliance Power" and "Reliance Infra" — a
   headline about a different listed company can score against RIL. Observed live during the audit. Not fixed:
   the correct fix is an entity-resolution step, which is a feature, not a defect repair.
5. **Gold is indicative.** COMEX × USD/INR × a static 1.145 duty/basis premium. The premium floats in reality;
   the level drifts ~1% from MCX and intraday % can diverge in sign. Now flagged `derived: true` in the payload.
6. **ATH/ATL date resolution is monthly** and bounded by Yahoo's history, not NSE's listing history.
7. **Shared `.cache/` across instances.** Two servers in the same folder write the same cache files; a stale
   in-memory copy can be re-saved over a fresh one. Not user-facing, but it made cache-invalidation verification
   awkward during this audit.

---

## 9. Changed files

| File | Change |
|---|---|
| `server.js` | D1–D5 fixes; `prevSessionClose`, `marketStatusIST`, `withMeta`; `meta` envelope on 11 routes; bhavcopy `DATE1` validation + self-healing dedupe; `?fresh=1` on `/api/extremes`; testable exports behind `MARKETPULSE_NO_LISTEN` |
| `stock-market.html` | `freshBadge()` + 3 new badge styles; 4 scanner panels re-badged; 8 mislabelled `LIVE` badges corrected; extremes rows show ATH/ATL level + date; WEO vintage on macro badge |
| `package.json` | `test`, `test:unit`, `test:api`, `record-fixtures` scripts |
| `.claude/launch.json` | added `marketpulse-audit` config (port 5321) |
| `tests/` *(new)* | `calculations.test.js` (34 tests), `api-contract.test.js` (28 tests), `record-fixtures.js`, 5 recorded fixtures |
| `.cache/bhav_26062026.json` | **deleted** — poisoned duplicate, auto-purged |

**No new environment variables are required.** Two optional ones exist: `MARKETPULSE_NO_LISTEN=1` (tests only)
and the pre-existing `HEALTH_TOKEN`. No new costs, licences, or scheduled jobs.
