---
name: poor-performing-creatives
description: >-
  Find TikTok UA poor-performing CREATIVES (by creative_id / ad_name) over a date window — the
  recurring "creative optimization" / "which creatives to kill" task, Android + iOS. Computes creative
  DNU CPI = gross revenue ÷ client DNU and grades GOOD/WATCH/POOR vs region KPIs (matches the
  appscript-creative dashboard). Android = pure BigQuery (spend == Looker GR, validated penny-exact);
  iOS = Looker GR ÷ BQ DNU (iOS rebate_cost is NOT a GR proxy). Writes All/Poor/Watch/Good tabs to
  Google Sheets. Invoke when asked to find good/poor performing creatives, do creative optimization,
  or rank creatives by DNU CPI for TikTok UA. Reusable code lives in find_poor_creatives.py
  (PLATFORM = android/ios/both); the standalone Android cut is creative_dnu_cpi.sql.
---

# TikTok UA — Poor-Performing Creative Finder (Android + iOS)

**Audience:** TikTok UA analysts. Sibling of `skills/ua-poor-performing-sites` (site grain) — this is
**creative grain**, and matches the `appscript-creative` production dashboard's judgment. **Runs in:**
Google Colab or locally in this repo. DNU from **BigQuery**; iOS revenue from **Looker/Trino**; KPIs from a
**Google Sheet**; writes results back to a **Google Sheet**. Set `PLATFORM = "android" | "ios" | "both"`.

## Two numerator paths — the platforms differ (both validated 2026-07-24)

**Android → PURE BigQuery.** At **(creative_id × campaign_name × p_date)** grain, `android_creative.spend`
is **identical to Looker/Trino gross revenue** — penny-exact: corr 1.0000, rev-weighted GR/spend 1.0000
($1,030,860 spend vs $1,030,863 Looker GR across a week). `spend` here *is* the Liftoff advertiser cost =
Looker GR, relabeled. So Android GR = `SUM(spend)` — one table, one query, 100% coverage, **no Looker**.

**iOS → Looker GR ÷ BQ DNU.** `ios_creative` has **no `spend`**; its cost column `rebate_cost的日均` is **NOT**
a GR proxy — it tracks client-truth-attributed cost and **collapses to ~$0 on `ios_dc_new_*`/`new_user` SKAN
campaigns** while Looker books full GR (same-day divergence up to ~46,000×). **Decision (Sherine): on iOS trust
Looker GR, not `rebate_cost的日均`.** So iOS pulls GR from **Looker/Trino** (`hive.analytics.daily`, `revenue_micros/1e6`,
joined on creative_id × campaign × date, ~99% match) and divides by BQ `bs_ios_dc_new_user的日均` (client-truth DNU).
iOS has no LTall/ROI2 columns (left blank). The `spend`==GR identity is **Android-specific** — never use it on iOS.

(This is the creative-grain refinement of `GUIDES/ua-context.md` → trust matrix / memory `bigquery-table-trust-matrix`.)

## Why NOT the old sheet-join approach (what this replaces)
The original Colab compared a **Looker "Creative Performance" export sheet** (GR) against BQ (DNU). That was
**wrong** for two reasons, both fixed here:
1. **Brand contamination.** The Looker export summed **all campaign_types** (brand + UA + RE) for a creative,
   but BQ DNU is only the TikTok-tracked (UA) campaigns. Dividing all-type GR by UA-only DNU inflated the CPI
   of any creative that also ran in brand — exactly the top spenders. (e.g. creative 848893: brand $8,957 vs
   UA $1,098; the sheet used the sum.) BQ `spend` is already scoped to the campaigns BQ tracks, so it can't
   contaminate.
2. **Timeframe mismatch.** The export sheet was a **2-day rolling snapshot**; TT was 80 days. Joining them on
   `date` collapsed the match rate to ~1%.

## The two timeframe traps (baked into the SQL — do not remove)
1. **Latest day is PARTIAL.** The feishu sync's newest `p_date` lands ~40% of a full day (e.g. 2026-07-21:
   $62K spend / 16.8K DNU vs ~$157K / ~35K on complete days). The query **auto-excludes** it — window ends at
   `MAX(p_date) - 1`.
2. **Numerator and denominator share the window.** `spend` (GR) and `DNU` come from the *same rows over the
   same complete-day window*. Never divide a short revenue window by a long DNU history.

## Verdict — 3 tiers (aligned with the `appscript-creative` production dashboard)
Compare each creative's `dnu_cpi` to **two** region thresholds (higher CPI = worse):
- **`cpi_kpi`** = GOOD cutoff, from tab **`Performance KPI`** (full, has KR).
- **`poor_kpi`** = POOR cutoff, from tab **`Poor Performance KPI`** (a *subset* — missing regions incl. **KR**).

| verdict | rule |
|---|---|
| **GOOD**  | `dnu_cpi ≤ cpi_kpi` |
| **WATCH** | `cpi_kpi < dnu_cpi ≤ poor_kpi` |
| **POOR**  | `dnu_cpi > poor_kpi` (or `> cpi_kpi` when the region has no `poor_kpi`) |
| **NO_DNU** | `dnu < 1` or `dnu_cpi = 0` (can't judge) |
| **NO_KPI** | that `(app, region)` has no `cpi_kpi` |

⚠️ **Use `Performance KPI` for `cpi_kpi`, `Poor Performance KPI` for `poor_kpi` — never gate the GOOD cutoff off the
subset tab** (it drops KR etc.). A region present in `Performance KPI` but absent from `Poor Performance KPI` simply
has no WATCH band — a creative over `cpi_kpi` there goes straight to POOR. Secondary signals **LTall** and **ROI2**
(DNU-weighted, ~40% row coverage) are surfaced per creative as quality context but are **not** part of the gate.

## Inputs (CONFIG block in `find_poor_creatives.py`)
- **`RUN_LOCALLY`** — `False` = Colab (`authenticate_user`); `True` = this repo's tokens
  (`auth/bq-user-token.json` + `auth/gspread-write-token.json`).
- **`PLATFORM`** — `"android"` (pure BQ) | `"ios"` (Looker) | `"both"`. Output tabs are combined with a `platform` column.
- **`LOOKBACK_DAYS`** (default 7) — number of **complete** trailing days (the partial latest day is already excluded).
- **`TARGET_REGIONS`** — geo scope (mirrors the original notebook's 21 geos); empty set = no filter.
- **`LOOKER_CLIENT_ID` / `LOOKER_CLIENT_SECRET`** — **iOS only** (Android needs no Looker). Local runs use
  `auth/looker.ini` via `tt_re_mcp._init_looker()` automatically; in Colab, fill these (same creds as
  `appscript-creative` Script Properties). `TRINO_CONNECTION` = `accelerate_trino`.
- **`KPI_SPREADSHEET_ID` / `KPI_SHEET_NAME` / `POOR_KPI_SHEET_NAME`** — `Performance KPI` → `cpi_kpi` (GOOD cutoff,
  full incl. KR); `Poor Performance KPI` → `poor_kpi` (POOR cutoff, subset). KPI keyed **`app name` + `region`**,
  filtered by **OS** per platform; the black-swan `黑天鹅CPI` is the target.
- **`APP_MAP_SHEET_NAME`** = `App Name ID Map` — resolves `{android,ios}_creative.app_id` (which **is the
  `tiktok_app_id`**) → `liftoff_app_name` (filtered by OS), so the KPI join on `(app_name, region)` hits.
  (1233→TikTok (Android), 1180→…- Asia, 845221→PineDrama, 1340→TikTok Lite.)
- **`OUTPUT_SPREADSHEET_ID`** — where the tabs are written.

## Data gotchas (learned building this)
- `{android,ios}_creative.app_id` = **tiktok_app_id** (not liftoff_app_id) — map via the `tiktok_app_id` column (OS-filtered).
- **iOS merge:** BQ iOS DNU per (creative_id, campaign, date, region) ⋈ Looker GR per (creative_id, campaign, date)
  on (creative_id, campaign, date) → aggregate to (region, creative_id). ~99% of BQ iOS rows get a Looker GR.
- **Arrow vs python str:** BQ `.to_dataframe()` columns are Arrow-backed; gspread values are plain `str`. Force
  join keys to plain str (`.map(str)`) and join with a **merge**, or an Arrow-vs-python key mismatch silently
  yields **0 KPI matches**. (Bit this once — looked like a KPI gap, was a dtype gap.)
- **Arrow vs python str:** BQ `.to_dataframe()` columns are Arrow-backed; gspread values are plain `str`. Force
  join keys to plain str (`.map(str)`) and join with a **merge**, or an Arrow-vs-python key mismatch silently
  yields **0 KPI matches**. (Bit this once — looked like a KPI gap, was a dtype gap.)
- **`$` stripping:** parse `黑天鹅CPI` / money with `.str.replace("$","",regex=False)` — as a regex `$` is an
  end-anchor and strips nothing.
- **creative_id** is extracted from `ad_name` via `TikTok_Pte_Ltd_<N>` (regex; ~98% of rows carry it).
- **NO_KPI rows** = `(app_name, region)` not in the KPI tab (often blank-app_id creatives or a region with no
  target). Reported, not silently dropped — a big NO_KPI count is a KPI-coverage gap, not "all healthy".

## Output (4 combined tabs in `OUTPUT_SPREADSHEET_ID`)
`Creative CPI - All` / `- Poor` / `- Watch` / `- Good`, columns:
`platform, app_name, region, creative_id, gross_revenue, dnu, dnu_cpi, cpi_kpi, poor_kpi, ltall, roi2, verdict`,
sorted by GR desc, white→red gradient on `dnu_cpi`. Android + iOS rows coexist (tell them apart by `platform`).
Verified run (window 2026-07-14~20, PLATFORM=both): **Android** 2,452 creatives → POOR 440 / WATCH 393 / GOOD 1349 /
NO_KPI 270; **iOS** 350 → POOR 23 / WATCH 83 / GOOD 197 / NO_KPI 43 (iOS GR match 99%).

## How to run
1. Set the CONFIG block (`PLATFORM`, LOOKBACK_DAYS, geos, sheet ids, RUN_LOCALLY; for iOS in Colab also the Looker creds).
2. Colab: paste `find_poor_creatives.py` into a cell and run. Local: `python3 find_poor_creatives.py` (set
   `RUN_LOCALLY = True` — iOS then uses `auth/looker.ini`). Or run `creative_dnu_cpi.sql` in the BigQuery console
   for the raw **Android** cut. The Colab notebook `notebooks/creative_dnu_cpi_colab.ipynb` is the Android quick-view.
3. Read the Poor tab (reddest `dnu_cpi` = worst) to kill; Watch tab to monitor. Cross-check a short window vs a longer one before killing.

## Related / lineage
- **Trust matrix (authoritative):** `GUIDES/ua-context.md` → "BigQuery table trust matrix"; memory
  `bigquery-table-trust-matrix` (updated 2026-07-24: Android spend==GR; iOS trust Looker GR).
- **Production dashboard (same judgment):** `appscript-creative/Code.js` — Looker GR ÷ BQ DNU, 3-tier GOOD/WATCH/POOR,
  UA+iOS+RE. This skill mirrors its verdict; Android takes the pure-BQ shortcut, iOS uses the same Looker path.
- **Site sibling:** `skills/ua-poor-performing-sites/SKILL.md`. **Validation:** Trino `hive.analytics.daily`
  (`revenue_micros`) ⋈ `{android,ios}_creative` on (creative_id, campaign_name, date).
