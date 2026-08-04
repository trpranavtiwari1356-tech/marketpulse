# MarketPulse — Data Correctness Test Results

**Run date:** 28 July 2026
**Host:** Windows 11, Node v24.15.0
**Market state:** NSE **closed** (run at ~16:30 IST, after the 15:30 close)
Companion to [`data-correctness-audit-report.md`](data-correctness-audit-report.md).

---

## 1. Summary

```
npm test    →    tests 62    pass 62    fail 0    duration 6.4 s

  tests/calculations.test.js   34 passed   (fixture-pinned, no network)
  tests/api-contract.test.js   28 passed   (boots a real server on a scratch port)
```

---

## 2. Commands

| Command | Purpose |
|---|---|
| `npm test` | Everything (`node --test "tests/*.test.js"`) |
| `npm run test:unit` | Calculation layer only — deterministic, offline, no network |
| `npm run test:api` | API contract — spawns `server.js` on port `5400 + pid%90` |
| `npm run record-fixtures` | Re-record provider fixtures. **Only** when a provider's response *shape* changes |
| `MARKETPULSE_OFFLINE=1 npm test` | Skips the API-contract suite on a machine with no upstream access |

The unit suite sets `MARKETPULSE_NO_LISTEN=1` before requiring `server.js`, so importing the module exports its
pure functions without binding a port or starting the warm-up scans. The API suite deletes that variable for its
child process, which must listen.

---

## 3. Fixtures

Recorded from Yahoo Finance `/v8/finance/chart`, trimmed to the fields `server.js` reads plus a `_recorded`
provenance stamp. **No live market value is used as an expected value anywhere in the suite** — expectations are
either hand-derived (with the arithmetic in a comment) or read off these files.

| Fixture | Bars | Pins |
|---|---|---|
| `yahoo-reliance-1mo-max.json` | 49 (to 1999-12) | The 1997-10-27 2:1 false positive that halved pre-1997 bars |
| `yahoo-titan-1mo-max.json` | 85 (to 2002-12) | `dataGranularity == '1mo'` for a `max` range; the bars/52 error |
| `yahoo-cnxauto-thin-5d.json` | 1 | Single live bar, no completed session → the fabricated 0.00% |
| `yahoo-nsei-5d.json` | 5 | Healthy series — `prevSessionClose` must prefer the series |
| `yahoo-bajfinance-1d-split.json` | 21 | Daily bars across the 2025-06-16 2:1 are already adjusted |

---

## 4. Unit results — `tests/calculations.test.js` (34)

| Suite | Tests | Result |
|---|---|---|
| moving averages | 5 | ✅ mean of last *n*; `null` below window (no partial average); EMA seeding; EMA > SMA after a late spike; `rollingMA` one entry per bar with `null` warm-up |
| split adjustment | 3 | ✅ `effectiveSplits` returns `[]`; **REGRESSION** RELIANCE ATL stays > 5 (not the halved 2.71); no >25% cliff across a daily split |
| `prevSessionClose` | 3 | ✅ prefers series; **REGRESSION** falls back to `chartPreviousClose` only when no completed session, and the derived move is real (not 0); reports `unavailable` rather than inventing a number |
| history span | 1 | ✅ **REGRESSION** monthly bars confirmed; timestamp-derived span differs from `bars/52` |
| position sizing | 3 | ✅ weights sum to 1; cap enforced + redistributed; inverse-vol favours the calmer asset |
| pearson | 2 | ✅ +1 / −1; zero-variance yields no real correlation |
| NSE dates | 3 | ✅ both cases parse; malformed rejected (not guessed); `bhavKey` → `DDMMYYYY` |
| CSV | 1 | ✅ commas inside quoted client names preserved |
| `parseHoldings` | 5 | ✅ legacy query form; JSON form + `.NS` strip; **invalid rows dropped, not coerced to zero**; missing buy price allowed; 60-holding cap |
| symbol validation | 2 | ✅ accepts `M&M`, `BAJAJ-AUTO`, `360ONE`; rejects `../../etc/passwd`, spaces, lowercase, >20 chars |
| error envelope | 2 | ✅ legacy string `error` retained alongside `errorDetail`; no vendor name or HTTP status in the customer message |
| sentiment | 3 | ✅ directional scoring; no-lexicon headline carries no signal; label thresholds consistent |
| breadth | 1 | ✅ `adv + dec == n` |

## 5. API contract results — `tests/api-contract.test.js` (28)

| Suite | Tests | Result |
|---|---|---|
| health | 2 | ✅ `/health` touches no provider; `/health/dependencies` reports macro + FII/DII state |
| parameter validation | 6 | ✅ unknown universe → 400 **with the allowed list** (not silently defaulted); unknown macro indicator lists available; malformed symbol rejected pre-upstream; empty portfolio → 400; 1-holding backtest explains the 2-holding minimum; 20k-holding body → 413; non-JSON body → 400 |
| error contract | 3 | ✅ no `HTTP nnn` and no `Trendlyne`/`DBnomics`/`Yahoo`/`TradingView` in any customer message; every error carries a `requestId`; `/api/swot` answers **200 + labelled unavailable**, never 502 |
| cache-key isolation | 2 | ✅ Nifty IT strictly smaller than Nifty 50 (no shared cache entry); mover periods cached independently |
| freshness + source metadata | 6 | ✅ every index states `prevCloseBasis`; **an unavailable basis yields `pct: null`, never 0.00**; gold flagged `derived` with a COMEX basis string; `meta` present on 5 routes with a valid `cacheState`/`marketStatus`/`coverage`; `marketStatus` cross-checked against an independent IST derivation; macro declares source + `estimateFrom > actualsThrough`; curated geo-risk self-describes as hand-maintained |
| internal consistency | 9 | ✅ gap % == `(open−prevClose)/prevClose` and "up" gaps are positive; `rel == ret − indexRet`; `adv + dec == n`; possize weights sum to 100% within cap and quantities are affordable; correlation matrix symmetric with unit diagonal in [−1,1]; FII/DII `net == buy − sell` with **no duplicate dates**; **delivery dates strictly increasing with no identical adjacent sessions**; earnings rows all carry `dateKind` and period-end rows carry no reaction; reaction stats state their coverage window |

---

## 6. Manual verification performed outside the suite

These were one-off probes against live providers, used to establish root cause. Scripts are in the session
scratchpad; the durable assertions they produced are encoded in the fixtures and tests above.

| Check | Method | Result |
|---|---|---|
| Is Yahoo's `close` split-adjusted? | `adjclose/close` continuity across every split ex-date, 9 NSE tickers | **23/23 already-adjusted, 0 raw** — see report §3 D5 |
| Does `1wk`+`max` return weekly bars? | `meta.dataGranularity` + bar spacing | **No — `1mo`, 31-day spacing** |
| Why is NIFTY AUTO 0.00%? | Raw `^CNXAUTO` fetch at `5d` and `1mo` | 1 bar at `5d`; nulls 20–27 Jul at `1mo`; `chartPreviousClose = 27653.4` |
| Are any bhavcopy days duplicated? | SHA-1 fingerprint over all 38 cached day files | **1 duplicate group: `2026-06-25 == 2026-06-26`** |
| Is Yahoo's earnings feed current for NSE? | Direct crumb + visualization API call | Newest announcement **2025-04-17** (INFY), **2025-04-25** (RELIANCE) |
| Is a newer IMF WEO available on DBnomics? | Paged all 106 IMF datasets | Newest is **`WEO:2025-04`**; 34 vintages; no `WEO:latest` dataset |
| Do the UI badges tell the truth? | Rendered-DOM read of 4 scanner panels | All show `● AT CLOSE` with scan time (market was shut) |
| Do the extremes fixes render? | Rendered-DOM read of ATH/ATL lists | `HDFCLIFE ATL ₹307.00 · 2017-11-12` etc., `~31 yrs max history` |
| Does `node -e "require('./server.js')"` still listen? | Started on port 5333, hit `/health` | ✅ — confirms the testability refactor did not break `.claude/launch.json` |

---

## 7. Checks NOT run

| Not run | Reason |
|---|---|
| Open-market (`marketStatus: 'open'`) end-to-end | Audit ran after the 15:30 IST close. The IST derivation is cross-checked in the contract suite, but no live session was observed. |
| Yahoo-vs-NSE tick comparison | NSE blocks automated access from this environment. Prices were verified like-for-like against the **declared** provider and for internal consistency only. |
| Curated JSON re-verification against USGS / EIA / IAEA / World Gold Council | Out of scope for a code audit; these are labelled curated with a review date. |
| Exhaustive 500-symbol ticker mapping | Trend and extremes both return all 500 names (no silent drops), so mapping was spot-checked rather than enumerated. |
| Backtest vs a third-party engine | Verified for internal consistency and date alignment only. |
| Load / rate-limit behaviour under concurrency | The 30/min heavy-path limiter was read but not load-tested. |
| Scheduled live sanity checks | **Not implemented.** `/health/dependencies` exposes the inputs (cache ages, breaker state, `daysTracked`), but no cron/alerting consumes it. Recommended as follow-up. |

---

## 8. Reproducing

```bash
npm test                       # 62 tests, ~7 s
npm run test:unit              # offline, deterministic
npm run test:api               # boots a real server

# Re-record fixtures only if a provider changes its response SHAPE:
npm run record-fixtures
```

The unit suite is safe to run on any machine at any time. The API suite reaches Yahoo/NSE through the server
under test; set `MARKETPULSE_OFFLINE=1` to skip it.
