# MarketPulse Data Audit Prompt

Copy everything below the line into a new conversation to run the audit.

---

Continue work on MarketPulse (C:\Users\hp\Desktop\Market Pulse). This picks up mid-task — read this whole prompt before touching anything.

## Where things stand

**Already committed and pushed to origin/main (commit 9321391):** the macro-section-down and SWOT-blocked fixes are LIVE. Do not redo these:
- Macro Maps now serves from cache/background-refreshes instead of blocking the request on DBnomics (was causing 502s on the deployed host).
- World Bank WDI blended with IMF WEO so the 8 core macro tabs (inflation, GDP, unemployment, debt, current account, lending rate, currency, renewables) run to 2026, not 2023, with "est" labelling on projected years.
- SWOT has an in-house fallback engine (`buildLocalSwot` in server.js) for when Trendlyne 403s the deployed host's IP.
- A bank ROA scoring bug is fixed (banks were judged against a 5% non-bank benchmark; now sector-aware).
- CSS was added for `.mm-obs.est`, `.mm-est-note`, `.macro-updated.stale` (gold color for estimate/stale markers).

**In progress, NOT committed, currently reverted to clean state:** extending the "curated" macro tabs (Energy + Metals group: oil/gas/coal production, nuclear grid %, gold reserves, oil import dependency) from frozen hand-typed 2023 snapshots in `macroCurated.json` to live self-updating feeds. This is what the user's item "1) macro info only till 2023, make it self-updating" is still asking for.

## What was researched and validated (don't re-research — reuse these)

- **US EIA International Energy Data**, reachable via DBnomics (`api.db.nomics.world`, same host the WDI/WEO pulls already use — no new reachability risk). Provides crude oil production, natural gas production, coal production, electricity generation by source (for nuclear %), and petroleum consumption (for import-dependency), all with full annual history through 2025.
  - Series code format: `{product}-{activity}-{ISO3}-{unit}.A`, e.g. `57-1-USA-TBPD.A` = crude oil incl. lease condensate, USA, thousand barrels/day, annual.
  - Codes found and validated (USA 2023 crude = 12.9 Mb/d matches the old curated snapshot exactly):
    - Crude oil production: prefix `57-1`, unit `TBPD` (thousand barrels/day → divide by 1000 for Mb/d)
    - Natural gas production: prefix `26-1`, unit `BCM` (billion cubic metres, no scaling needed)
    - Coal production: prefix `7-1`, unit `MT` (1000 metric tons → divide by 1000 for Mt)
    - Nuclear electricity net generation: prefix `27-12`, unit `BKWH`
    - Total electricity net generation (denominator for nuclear %): prefix `2-12`, unit `BKWH`
    - Petroleum consumption (denominator for import dependency): prefix `5-2`, unit `TBPD`
  - **CRITICAL BUG FOUND, must be avoided**: DBnomics' `q=` relevance-search endpoint on this dataset silently omits major countries — searching "Crude oil including lease condensate production" returns 1728 matches but the United States, Russia, and Saudi Arabia are NOT in the result set even after paging through everything. **Do not use the `q=` search + regex-filter approach.** Instead construct series ids explicitly for every ISO3 in the existing `MACRO_ISO` allowlist and fetch by exact id via `https://api.db.nomics.world/v22/series?series_ids=EIA/INTL/{code1},EIA/INTL/{code2},...&observations=1` (batch ~40 ids per request to keep URLs reasonable; DBnomics silently drops ids that don't exist, so no per-country existence check is needed). This was verified working: a batch request for USA/IND/RUS/SAU + one bogus id correctly returned exactly the 4 real ones.

- **IMF IRFCL (International Reserves and Foreign Currency Liquidity)**, also via DBnomics, series id pattern `IMF/IRFCL/{FREQ}.{ISO2}.RAFAGOLDV_OZT.S1X` — official central-bank gold holdings in millions of fine troy ounces. Convert to tonnes via `× 31.1034768`.
  - **Use FREQ=`M` (monthly), not `A` (annual)** — the annual series lags the monthly one (India annual 2024 = 876 t vs monthly latest = 880 t), and monthly is the whole point since gold reserves are the one series in this app that genuinely moves month to month (this directly answers the user's "if gold reserve changes, should auto-update" requirement).
  - Country dimension on IRFCL is **ISO-3166 alpha-2**, unlike WDI/WEO/EIA which use alpha-3 — need `ISO2_TO_ISO3` built from the existing `MACRO_ISO` map (`Object.fromEntries(Object.entries(MACRO_ISO).map(([i3,i2]) => [i2,i3]))`).
  - Validated: USA 2024 = 8134 t (curated snapshot had 8133 — matches), India = 880 t.
  - 86-88 countries covered — comparable coverage to the old curated snapshot.

- **No viable free live feed exists for conflict zones / chokepoints / sanctions** (`geopoliticalRisk.json`). Tested and all failed or require paid keys:
  - UCDP (`ucdpapi.pcr.uu.se`) — now requires auth (401), used to be free
  - GDELT DOC/GEO APIs — rate-limited (429) / endpoint changed (404) on free tier
  - ReliefWeb API — deprecated v1 (410 Gone), v2 requires app registration (403)
  - ACLED — requires a registered API key
  - **The one thing that DID work**: OFAC's public SDN sanctions list CSV (`https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV`, ~5.5MB, no key, 200 OK) — this could replace the hand-typed `sanctions` array in `geopoliticalRisk.json` with something live, but it's a large raw CSV that needs real parsing/filtering work (entity types, country mapping) to turn into the app's existing sanctions format. Not started.
  - Recommendation to relay to the user: conflict zones and chokepoints will likely have to stay hand-maintained (no free live source found) unless they're willing to pay for ACLED or a news API; gold reserves and the 6 Energy/Metals production tabs CAN go fully live; sanctions COULD go live but needs meaningfully more parsing work than the others.

## What code changes were drafted (and lost — must be rewritten from scratch)

A previous pass in this session wrote ~150 lines into `server.js` implementing the EIA/IRFCL adapters and wired them into `WB_INDICATORS`/`macroBuild`, but a PowerShell regex cleanup pass (`-replace` over the whole file to strip a leftover config field) corrupted the file's UTF-8 encoding beyond recovery (introduced literal U+FFFD replacement characters, destroying ~1300 lines' worth of em-dashes and arrows used throughout the existing comments). **That work was reverted** — `server.js` is back to the clean, committed state (matches `git show HEAD:server.js` exactly, verified 0 mojibake sequences, 218 correct em-dashes). Nothing was lost from the committed history; only the uncommitted draft was lost. **Redo this from scratch using the validated codes/approach above, but this time use the Edit tool for every change (never PowerShell `-replace` across the whole file) — Edit preserves UTF-8 correctly, PowerShell's `Set-Content`/`-replace` over this file does not.**

### Implementation plan (redo)

1. In `server.js`, near the existing `dbnomicsSeries` helper (search for `async function dbnomicsSeries`), add:
   - `eiaSeries(prefix, unit, timeoutMs)` — constructs `EIA/INTL/{prefix}-{iso3}-{unit}.A` ids for every key in `MACRO_ISO`, batches ~40 at a time into `https://api.db.nomics.world/v22/series?series_ids=...&observations=1`, uses `Promise.allSettled` per batch so one failed batch doesn't sink the whole indicator, parses out `{ [iso3]: { values: {year: value} } }`. Filter years to `MACRO_MIN_YEAR..macroMaxYear()` (both already defined). Treat non-finite/null EIA cell values ("--", "NA") as missing; keep 0 (a country that produces none of something).
   - `irfclGold(timeoutMs)` — fetch `IMF/IRFCL` with `dimensions={"INDICATOR":["RAFAGOLDV_OZT"],"FREQ":["M"]}&observations=1&limit=1000`, build `ISO2_TO_ISO3` from `MACRO_ISO`, for each doc take the REF_AREA (alpha-2) → alpha-3, group monthly periods (`"YYYY-MM"`) by year keeping only the latest month per year, multiply by `31.1034768` to get tonnes.

2. Add a `feedBuild(ind, cfg)` dispatcher that handles three modes per indicator config:
   - `direct` (default when no `derive` key) — one `eiaSeries` or `irfclGold` call, optionally rescaled via a `scale` multiplier (e.g. TBPD→Mb/d is `1/1000`).
   - `derive: 'ratio'` — two series (`num`/`den` sub-configs), emits `(num/den)*100` per country-year, only where both exist and denominator is non-trivially non-zero. Used for nuclear % of grid.
   - `derive: 'shortfall'` — `(1 - num/den)*100`, clipped to `[0,100]` (a net exporter would otherwise show a large negative and wreck the color scale). Used for oil import dependency.

3. Extend `WB_INDICATORS` (or a new sibling object if cleaner — check how `MACRO_TABS` in stock-market.html maps `src: 'curated'` keys to decide) with entries for `oil_prod`, `gas_prod`, `coal_prod`, `nuclear_grid`, `oil_import_dep`, `gold_reserves`, each carrying a `feed: 'eia'|'irfcl'` marker so `macroBuild(ind)` can branch early (before the WDI/WEO logic) into a much simpler path: call `feedBuild`, round to the config's `dp` decimal places, and return the same payload shape (`{ ind, label, unit, desc, note, freq, source, years, latestYear, estimateFrom: null, actualsThrough: latestYear, weoVintage: null, countries, asOf }`) that the WDI path produces — everything downstream (caching, the `/api/macro` route, the frontend) already handles that shape generically and needs NO changes.

4. In `stock-market.html`, `MACRO_TABS` (search for `const MACRO_TABS`) currently marks `oil_prod`, `gas_prod`, `nuclear_grid`, `coal_prod`, `gold_reserves`, `oil_import_dep` as `src: 'curated'` (routes to `/api/macro-curated`). Change these six to `src: 'wdi'` (routes to `/api/macro`, the live path) — NOTE the frontend variable/route name says "wdi" but by this point in the code it's just "the live macro engine," used for WDI+WEO AND now EIA/IRFCL. `gold_prod`, `copper_prod`, `lithium_prod` (USGS mineral production, no live source found) STAY `src: 'curated'` — leave `macroCurated.json` as their only source, they cannot be automated with a free feed (USGS mineral surveys are annual PDFs, no API).

5. Test each new indicator via `http://localhost:PORT/api/macro?ind=oil_prod&warm=1` etc. (the `warm=1` param forces a synchronous build instead of background-refresh, useful for testing — it's already wired into `macroIndicator()`). Verify against the numbers already confirmed above (USA crude 2023 = 12.9 Mb/d, USA gold 2024 = 8134 t, India gold latest = 880 t).

6. Run `node refresh-data.js` (or manually hit each new `?warm=1` endpoint) to populate `.cache/macro_oil_prod.json` etc., then `node --check server.js`, then start the app and click through the Macro tab UI to confirm the new indicators render (year slider working, rank list, tooltip, CSV export) before committing.

## What to explicitly tell the user before/after this work

- Gold reserves, oil/gas/coal production, and oil import dependency CAN and (after this work) WILL be fully live and self-updating — same background sweep as the other macro tabs, refreshed every 6h, gold reserves specifically tracks monthly central-bank changes (e.g. RBI accumulation) since IRFCL reports monthly.
- Gold/copper/lithium PRODUCTION (USGS mineral commodity summaries) has no free live API — these three tabs stay hand-typed in `macroCurated.json`, update them manually when you have a newer USGS annual survey.
- Conflict zones, chokepoints, and sanctions (`geopoliticalRisk.json`) have NO free live source that was found working (UCDP now requires paid auth, GDELT/ReliefWeb are unreliable/blocked, ACLED needs a paid key) — these stay hand-maintained. If the user wants this automated, they'll need to either pay for one of those APIs or accept OFAC's free sanctions CSV as a partial live replacement for just the `sanctions` array (needs real parsing work, not started).

## ⚠️ Unreviewed change found in the working tree — check this FIRST

`stock-market.html` currently has an uncommitted diff (`git diff -- stock-market.html`) that changes `pfAnalyze`/`pfBacktest` from GET query-string calls (`/api/portfolio?h=...`, `/api/pfbacktest?h=...`) to POST JSON bodies (`/api/portfolio/analyze`, `/api/portfolio/backtest`), with a comment about not leaking portfolio holdings into proxy logs/browser history via the query string. **This was not written by me in this session** — it appeared in the working tree without me making the edit, and it references API routes (`/api/portfolio/analyze`, `/api/portfolio/backtest`) that need to be checked against what `server.js` actually implements (the last known-good `server.js` still has `/api/portfolio` and `/api/pfbacktest` as GET routes reading `?h=`). Before doing anything else:
1. Run `git diff -- stock-market.html` and read it.
2. Check whether `server.js` has matching POST `/api/portfolio/analyze` / `/api/portfolio/backtest` handlers — if not, this frontend change is currently broken (calls routes that don't exist server-side) and portfolio analysis is silently down until either the frontend is reverted or the backend routes are added.
3. Decide with the user whether to keep this change (it's a reasonable privacy improvement if backed by real routes), finish it, or revert it (`git checkout -- stock-market.html` — but note that also reverts the CSS estimate-labelling classes, so re-check `.mm-obs.est`/`.mm-est-note`/`.macro-updated.stale` are still present in `.cache`... actually they're already committed in 9321391, so a revert of the working-tree diff is safe and won't lose the committed CSS work).

## Git state

- Last commit: `9321391` "Fix the two live-site outages: macro section down, SWOT blocked" — pushed to origin/main.
- `.cache/*.json` modified files (`constituents.json`, `deals.json`, `equitymaster.json`, `fiidii.json`, `segfiled.json`) are just normal background-refresh churn from running the local server during testing — fine to include in any subsequent commit, or discard if you want a clean diff.
- A stash exists: `git stash list` will show "wip before server.js encoding recovery" — this is the CORRUPTED version of server.js, kept only as a fallback reference. Do not pop/apply it. It can be dropped (`git stash drop`) once the redo is confirmed working, or left alone (it doesn't block anything).
- Two new empty cache files may exist from a prior partial test: `.cache/macro_gold_reserves.json`, `.cache/macro_oil_import_dep.json` — check them, delete if stale/empty, they'll regenerate correctly once the redo endpoints are hit.
