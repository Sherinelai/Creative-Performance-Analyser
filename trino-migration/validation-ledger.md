# Validation ledger — the migration's insurance policy

> **Why this exists:** the migration ships with no human QA after Valerie leaves. A wrong-but-plausible
> RPA is the failure mode. This ledger is the machine backstop: **no SQL cut is accepted until it
> rate-matches a frozen known-good anchor to tolerance.** Vincy re-runs any row here via the
> Accelerate Trino connector to confirm a cut still holds.

> **Outcome (receipts):** the 8 Looker performance tools in `tt_re_mcp.py` became 9 plain Trino SQL
> cuts in `sql/` and were deleted from the server (1,687 → 569 lines; entity-map + campaign-ids kept on
> Looker, goals on gspread, `create_bl_csv` pure Python). Every cut is rate-matched to a frozen anchor
> below and was independently blind-verified (§ "P4"). Commits: P1 `d8bc84d`, P2 `4ed4f35`, P3 `24a9bc4`.

## Doctrine

- **Match on RATE (RPA / DRU-CPI / CTR / CVR), never raw sums.** Warehouse lags ~2 days; Gumshoe's
  "last-N-days" is timezone-relative. Raw daily/weekly sums will never tie out; rates will.
- **Tolerance: ±5%** on the anchor rate. A miss beyond that = a real semantic error (wrong column,
  wrong basis, wrong scope), not window drift — do not accept.
- **Complete days only:** `dt < <yesterday 00:00Z>` (exclude today's partial). Warehouse currently
  complete through **2026-07-05**.
- **`dt` is `varchar(20)`, not a date** (`YYYY-MM-DDT00:00:00Z`; confirmed `max(dt)='2026-07-05T00:00:00Z'`).
  Always compare against **full 20-char literals** — a shortened `'2026-06-06'` shifts the boundary a
  day (lexicographic), `DATE '...'` type-errors.
- Anchors are frozen scopes, not frozen numbers — re-running may drift within tolerance as the
  warehouse advances; that's expected.

## Event-basis doctrine (READ — set by Valerie 2026-07-08)

- **Default: `target_events`** (the campaign's own target-event count column), NO `custom_event_name`
  filter. This is the low-friction default, not a semantic choice against the unified-event concept.
- **The unified event (e.g. `reengagement`) is NOT legacy.** On a strategist's request for a specific
  event, populate `custom_event_name = '<event>'` and run.
- **ALWAYS tell the strategist which event the query is built on** (target-event vs a named event).
- **Grain caveat — the split is TWO-SIDED (validated 65880 SA L7D, P2):** delivery + money live ONLY on
  `custom_event_name IS NULL` rows (impressions 651,243 / clicks 69,033 / revenue $2,501.81 / **0**
  target_events); conversion counts live ONLY on the named target-event rows (**3,556** target_events /
  0 imps / 0 revenue). Summing across ALL rows is always correct (disjoint row-sets, no double-count),
  but **filtering `custom_event_name` in EITHER direction zeroes half the funnel** — `IS NULL` kills the
  event counts, `= '<event>'` kills delivery + revenue. A named-event override is therefore a separate
  counts-only aggregation (`custom_event_name='<event>'`, `sum(total_events)`) joined by date in the
  caller — never a filter on a revenue/delivery cut. The funnel cut header enforces this explicitly.

## Standard anchor scope (P1a, minted + SA-scoped 2026-07-08)

All anchors share one scope: **`campaign_id=65880`, `customer_id=968`, `campaign_type='reengagement'`,
`country='SA'`, target-event basis, L7D = `dt >= '2026-06-29T00:00:00Z' AND dt < '2026-07-06T00:00:00Z'`**
(complete days through warehouse max 2026-07-05).

- **65880 is single-geo SA.** `DISTINCT country` returns ~48 values, but **all GR + all conversions are
  SA** ($2,501.81 / 3,556); every other country is zero-revenue bid/impression noise. Scope `country='SA'`
  — rates are identical to unscoped (noise carries $0) but it's correct and clean. **Judge geo by GR
  distribution, never `DISTINCT country`.**

## Frozen anchors (all campaign 65880, standard scope above)

| # | Cut it guards | Scope detail | Trino value (2026-07-08) | Gumshoe confirm |
|---|---------------|--------------|--------------------------|-----------------|
| A1 | `get_re_source_apps` | IMO (`com.imo.android.imoim`) | **RPA $0.683** (GR $908.6 / 1,329 conv) | ✅ ≈ Gumshoe $0.669 (issue #1) |
| B | `get_re_exchange_perf` | exchange = PANGLE (id 128) blended | **RPA $0.6989** (GR $1,186.77 / 1,698) | ⬜ low-risk (shares A1 basis) |
| C | `get_re_source_apps_by_exchange` | IMO within PANGLE | **RPA $0.6877** (GR $896.71 / 1,304) | ⬜ low-risk (shares A1 basis) |
| D | `get_re_creatives` | top creative 1121972 (VAST) | **RPA $0.7392** (GR $383.64 / 519) | ⬜ low-risk (shares A1 basis) |
| E | `get_re_campaign_total_revenue` | gross GR, NO event filter | **GR $2,501.81** (7d; $357.40/day) | ⚠️ **confirm** (tests no-filter sum vs Gumshoe campaign total) |
| F | daily-limit reporting (NEW) | `campaign_daily_limit_micros/1e6` | **$500 (Jun29–Jul1) → $300 (Jul2–5)** — lowered. Jun30 & Jul1 show 2 caps/day (intraday change) → use `max()` per campaign-day. | ✅ Valerie + data agree (2026-07-08) |
| A2 | (context) 54046 · 0-conv wasteland | `campaign_id=54046`, L30D | ~6,706 sources at 0 conv / ~$350 GR | issue #1 calibration |

**Risk note:** B/C/D reuse A1's already-blessed basis (same two columns, same campaign) and only exercise
`GROUP BY` correctness → low-risk, blessed on internal consistency. **E and F test genuinely new things**
(no-filter revenue sum; a new column's units) → these are the two worth a human Gumshoe eyeball.

## P4 — independent blind verification (✅ PASSED 2026-07-08)

A fresh Fable session, **blind** (given only the business spec + scope; forbidden from opening
`trino-migration/`, git history, `skills/`), independently re-derived all cuts from its own column
choices against `hive.analytics.daily`. Result: **every anchor reproduced exactly** (A1 $0.6837, B
$0.6989, C $0.6877, D $0.7392, E $2,501.81, funnel DRU-CPI $0.7035 / CTR 10.60% / CVR 5.15%). It
independently chose `revenue_micros/1e6` (ruling out `spend`/`customer_revenue` by reasoning) and
reconstructed the two-sided grain finding — so the semantic traps are corroborated, not echoed.

## Metric definition fork — `target_events` vs `target_events_first` (successor decision)

P4 surfaced a real, unstated definitional choice for **"conversion"**:
- **`target_events`** = repeat-inclusive (all target-event occurrences). 65880 window = **3,556**. **This
  is what all cuts + anchors use**, and it's what reproduces Gumshoe's per-event rate (A1 $0.683 ≈
  Gumshoe $0.669) — so Gumshoe itself counts repeats.
- **`target_events_first`** = first-occurrence-only (unique converters). 65880 window = **2,209**.
  Switching to this raises every RPA / DRU-CPI ~61% (campaign DRU-CPI ~$1.13 vs $0.70).

**Decision (Valerie, 2026-07-08):** the client never specified; stay on `target_events` (repeat-inclusive,
the Gumshoe-consistent + better-looking number). **Flagged for the successor:** this is your call and your
burden — if a client ever defines "conversion" as unique converters, switch the cuts to
`target_events_first` and every RPA shifts. Not a bug; a documented fork.

## Per-cut status

| Cut (→ `sql/`) | Validated? | Anchor | Result | Notes |
|----------------|-----------|--------|--------|-------|
| `get_re_source_apps` | ✅ 2026-07-07 | A1 / A3 | 65880·IMO L7D-ish RPA $0.684 (in tol); trio L30D IMO ranks #1 @ $1.074 | Basis changed to `target_events`. Reference cut. |
| `get_re_source_app_timeseries` | ✅ 2026-07-08 | A1 | IMO ranks #1 @ $0.683; semi-join validated | Two-pass collapsed to one CTE. |
| `get_re_campaign_perf` | ✅ 2026-07-08 | A1 | shares A1 basis; `arbitrary()` name confirmed | GROUP BY dt × campaign. |
| `get_re_exchange_perf` | ✅ 2026-07-08 | B | PANGLE rollup $1,186.77 / 1,698 / $0.6989 | Native `exchange`; CHANNEL_NAMES gone. |
| `get_re_source_apps_by_exchange` | ✅ 2026-07-08 | C | IMO-in-PANGLE $896.71 / 1,304 / $0.6877 | Semi-join (not JOIN USING). |
| `get_re_campaign_total_revenue` | ✅ 2026-07-08 | E | $2,501.81 / 7d | Grain-safe; no event filter. |
| `get_re_funnel_perf` (Fable) | ✅ 2026-07-08 | A1 | 65880 SA L7D blended DRU-CPI $0.7035 (+3.5% vs ~$0.68, in tol); CTR 10.6% / pCTR 11.4% / CVR 5.15% | Native `target_events` — reconstruction hack + accelerate_spot path deleted. NEVER filter `custom_event_name` in this cut: grain is split (imps/clicks/revenue on NULL rows ONLY; target_events counts on named-event rows ONLY — see P2 findings). |
| `get_re_creatives` (Fable) | ✅ 2026-07-08 | D | top creative 1121972 VAST 320x480 RPA $0.7392 — exact | `creative_name` DROPPED: no creatives dim table anywhere in the connector catalog (hive.analytics + proto2parquet only). `creative_id` is the key; name via Gumshoe UI / retained Looker path. |
| revenue-`_micros` audit (Fable) | ✅ 2026-07-08 | all | Decimal `revenue`/`spend` 100% NULL (0 of 401,432 rows, 65880 SA L7D); `revenue_micros/1e6` = $2,501.81 = anchor E exactly; `spend_micros` = 0.519× revenue; `customer_revenue_micros` = 0 in scope | `_micros/1e6` = Gumshoe "revenue" (advertiser cost) confirmed. Never use decimal cols or `spend*`. |
| daily-limit reporting (Fable, NEW → `get_re_daily_limit.sql`) | ✅ 2026-07-08 | F | $500 Jun29–Jul1 → $300 Jul2–5 via `max()` — exact; `n_caps=2` on Jun30 & Jul1 | Micros confirmed (/1e6 = blessed $ values). Change days (`n_caps>1`) ambiguous: Jul1 revenue (~$300) already tracked the NEW cap while `max()` read $500 — cut exposes `min_limit` + `n_caps`. |
| `get_re_competition` (NEW, 2026-07-20) | ✅ 2026-07-20 | COMP | SA L15D: TikTok rpm 4.501 / wr 0.0226; market rpm 0.531 / wr 0.0329 — reproduces Sherine's exact formulas <0.01% | Region auction-competitiveness signal (RPM↑ + win_rate↓ = geo more competitive). **DIFFERENT TABLE:** `analytics.medium_daily_v1` (auction grain w/ `impressions` / `approx_bids` / `revenue_micros`), NOT `hive.analytics.daily`. Customer-level, ALL campaign types (no `campaign_type` filter — auction pressure is market-level). String `dt` filter confirmed row-identical to Sherine's `from_iso8601_timestamp(dt)`. Fed by the `get_re_competition_sql` MCP tool (pure-Python param filler). |
| `get_re_s2s_rt_by_campaign` (NEW, 2026-07-20) | ✅ 2026-07-20 | S2SRT | 4 s2s_rt-final campaigns L30D (cpi / s2s_ev): 79784 0.886/4163, 79798 3.534/1369, 79839 4.019/598, 79786 5.673/425 — reproduces Sherine's `rpa_total_events_filtered_by_name` to the digit | Per-campaign `tiktok_attr_install_s2s_rt` count + `dnu_cpi_s2s` (= revenue / s2s_rt_events). **Same table `analytics.medium_daily_v1`.** GRAIN two-sided (revenue+installs on `custom_event_name IS NULL` rows only; per-event `total_events` on named rows) — count the event with a CASE, NEVER a `custom_event_name` WHERE filter. Fed by the `get_re_s2s_rt_sql` MCP tool. GOAL-1 gap vs TikTok BQ DNU is an EXTERNAL join (BQ ≠ `installs`). |

## COMP anchor (frozen scope — guards `get_re_competition`, minted 2026-07-20)

Different table + scope from the 65880 anchors above. **Table `analytics.medium_daily_v1`,
`country='SA'`, `is_uncredited <> 'true'`, last-half window `dt >= '2026-07-04T00:00:00Z' AND
dt < '2026-07-19T00:00:00Z'` (the L30D cut's last 15 days).** Metrics = Sherine's `rpm_1` /
`win_rate`.

| Scope | Trino value (2026-07-20) |
|-------|--------------------------|
| TikTok (`customer_id=968`) | **rpm 4.501 / win_rate 0.02257** |
| Liftoff market (no customer filter) | **rpm 0.531 / win_rate 0.03290** |

## S2SRT anchor (frozen scope — guards `get_re_s2s_rt_by_campaign`, minted 2026-07-20)

**Table `analytics.medium_daily_v1`, `customer_id=968`, `is_uncredited <> 'true'`, L30D window
`dt >= '2026-06-19T00:00:00Z' AND dt < '2026-07-19T00:00:00Z'`**, the 6 campaigns whose
`final_event_name='tiktok_attr_install_s2s_rt'`. Metric `dnu_cpi_s2s` = `sum(revenue_micros)/1e6` /
`sum(total_events WHERE custom_event_name='tiktok_attr_install_s2s_rt')` (Sherine's exact formula).

| campaign_id | dnu_cpi_s2s | s2s_rt_events |
|-------------|-------------|---------------|
| 79784 (BR) | **0.8863** | 4163 |
| 79798 (VN) | **3.5344** | 1369 |
| 79839 (AE) | **4.0190** | 598 |
| 79786 (JP) | **5.6734** | 425 |

Grain note: revenue lives ONLY on `custom_event_name IS NULL` rows; `total_events` for s2s_rt on the
named rows; `final_events` on the final-event row. Summing across all rows is disjoint-safe.

## How to re-validate a cut (for Vincy)

Two equivalent paths — both hit the **same** Accelerate Trino data (proven 2026-07-20: the SQL
Runner path reproduces anchor A1 = $0.6837 exactly, and validated the COMP anchor):

- **A — claude.ai connector (manual):** run the filled SQL via the **Accelerate Trino** connector in Claude.
- **B — Looker SQL Runner API (programmatic, no claude.ai connector needed):** the Looker creds in
  `auth/looker.ini` already reach a Trino connection literally named **`accelerate_trino`**. Run:
  ```python
  import tt_re_mcp as m
  from looker_sdk import models40 as md
  sdk = m._init_looker()
  q = sdk.create_sql_query(body=md.SqlQueryCreate(connection_name="accelerate_trino", sql=SQL))
  rows = sdk.run_sql_query(slug=q.slug, result_format="json")   # → JSON string
  ```
  SQL Runner runs ONE statement — split multi-query files on the `WITH`/statement boundary, not on `;`
  (inline comments may contain `;`). This is how the `get_re_competition` cut was validated end-to-end.

Then: fill the cut's `:params` for an anchor scope above, run, and compare the resulting **rate** to the
anchor's known-good, ±5%. In tolerance → still good. Out → investigate (usually a column/basis/scope
regression, not the data).
