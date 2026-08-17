# Creative Performance Analyzer — Handover

**What it is.** A Google Apps Script web app that answers one question for a Liftoff Performance Strategist: **why is each creative in this campaign spending, not spending, or auto-paused?** You give it a campaign ID; it pulls that campaign's creatives and their performance out of Trino, groups them the way MCO actually competes them, and explains each one.

**Where it lives.**

- Apps Script project `1WMWxrw45Bg6UCu9QTaGtYV4sn0e9go6cYoCv9q6vuzCmYkSeTY5HIrw7`
- Two source files: `Code.js` (backend, ~3.1k lines) and `Dashboard.html` (the entire front end, ~3.2k lines)
- Deployed as a web app: access `DOMAIN`, executeAs `USER_DEPLOYING` — every user runs it as themselves, with their own Looker permissions
- Every run is logged to the `Usage Log` sheet `1URHDLIXlUqMLS41TpgepSAsX8L2BHtMDJrUcBnfleKA`

**The one design idea to preserve.** Every threshold, format mapping, metric definition and rule has exactly **one** definition in `Code.js`, and the front end reads them at runtime through `getConfig()`. Nearly every bug this app has had was two copies of the same rule disagreeing with each other. When you add something rule-bearing, add it once.

This document has two parts: Part I is for whoever uses the dashboard, Part II for whoever maintains the code. A Traditional Chinese version of both follows in Part III.

# PART I — Using the dashboard

## 1. Running an analysis

- Enter a campaign ID. While you type, a 600ms-debounced preview shows the campaign name, state, MCO status and optimization state before you commit to the slow query.
- Campaign search covers **every** campaign state — enabled, paused, hidden, deleted — ranked live-first, so a paused or hidden campaign is still analysable and its state is shown.
- Choose a lookback: 7 / 14 / 30 (default) / 60 / 90 days, or a custom range (capped at 365 days).
- Optional pre-run filters: creative state, format type, optimization state, creative ID, and a multi-select over MCO Inventory Groups.
- The page loads in **two passes**. The overview pass (~8s) paints the campaign header, recent creative changes and the creative list. The heavy performance pass then fills in every number. While the second pass runs, the money tiles read "querying…" rather than an em dash — an em dash would claim "this campaign has no spend", which is a different and wrong statement.

## 2. The campaign header

Campaign ID, name and state, then a metadata row: Type, Model (optimization state), Selection (MCO vs Free-floating — coloured, because it changes how everything below should be read), Devices, Target Event, Goal 2, VT cap, Viewclick tolerance. Ad group IDs and names sit underneath. Two deep links, AC2 and Gumshoe, arrive pre-filtered to this campaign over the same lookback.

## 3. The five KPI tiles

Gross revenue, the campaign's primary metric, Active creatives, Paused creatives, Format groups.

- **Gross revenue is the headline figure, not spend.** `revenue_micros_d7` is what the advertiser pays; spend is media cost. Every other metric on the row is already computed against gross revenue — on campaign 78841, spend was $55,927.50 against gross revenue $92,972.86, and RPA x events = RPI x installs = the gross figure exactly. Spend stays visible in the sub-line, because SOW and format spend share are computed from it.
- The primary-metric tile is **gross-revenue-weighted (ratio of sums)**, not an average of per-creative ratios.
- **Active + Paused does not have to equal Total.** `pinpoint.public.creatives.state` has three values — enabled, paused, deleted — and a deleted creative can still carry spend inside the window, so it belongs in the total. The remainder is named by its actual state rather than lumped into "other".

## 4. Which metric the campaign is judged on

One resolution, **goals first**: if the optimization state or either campaign goal mentions rpa/cpa the campaign is judged on **RPA**; roas/cpr gives **7D ROAS**; rpi/cpi gives **RPI**; only then does it fall back to campaign type (`ua_cpr` and `re` to ROAS, `ua_cpa` to RPA, `ua_cpi` to RPI).

Campaign 78934 is why the order matters: its `campaign_type` is 'brand' and its name carries no cpa/roas token, so type-guessing said ROAS, while `goal_2` = 'rpa' and `optimization_state` = 'cpa' said the campaign is actually judged on RPA.

Direction matters and is encoded in one place: **RPA and RPI are better when LOWER**; ROAS, ITI and IPM are better when HIGHER. Column sorting and every "better than average" test respect that.

## 5. Recent creative changes

Two kinds of change appear here: **paused** (a state change) and **detached** (the creative was unassigned from the campaign). A detached creative is usually still 'enabled', so this list is the only place it surfaces at all.

Entries are sorted by **share of campaign gross revenue**, so the change that cost the most money is first. Each one shows the format, its revenue share, who did it — `MAB` is the platform's Auto-Pauser, `Manual` is a human — and the date. Clicking a format chip filters the list.

Select a creative and the right-hand pane explains it. This is where the AI diagnosis appears, and it appears **only for MCO's own pause decisions** — never for a human detaching a creative, which needs no explanation from a model.

## 6. The charts

- **Format spend** and **Revenue over time**, per MCO Inventory Group.
- **Video vs Non-video.** A creative counts as Video if and only if its MCO Inventory Group name is a **VAST** format. This is deliberately not the `is_video_creative` flag on the fact table. Measured over one fully-baked day: about 3,900 creatives carrying $200K+ of spend sat on VAST formats while the flag said 'false'; a few hundred non-VAST creatives said 'true'; and campaign 82323 has 40 of its 80 creatives on VAST formats with the flag marking **zero** of them video. The chart title states the rule on screen.
- **Interactive vs Not Interactive**, from `is_interactive`. 'N/A' is a real bucket, not an error.
- Each chart toggles between bar and donut and carries a short written read-out underneath. The read-out is generated from the **same aggregate** as the chart, so a caption can never name a different winner than the bars above it.

## 7. Creative Performance by Format — the main table

- Rows are **MCO Inventory Groups**, not raw `inventory_format`s, because the Auto-Pauser competes creatives *inside* a group. The 30s and 60s VAST variants roll into one group.
- A format row's numbers stay accumulated over **all** its creatives. Filters change which creative sub-rows are visible; they never move a group's totals.
- Performance tags, mutually exclusive and stamped server-side: **★ Top**, **↑ Campaign avg**, **↑ Format avg**, **⚠ Poor**. All four require a narrow confidence interval, so a tag is a claim about confidence as much as about performance.
- Filters: lifecycle state (queuing / exploring / optimizing), creative state, variance, Video, Interactive, creative ID, performance class.
- Columns are individually toggleable, and the Excel button copies the table as TSV.
- **An em dash means "no data for this metric", not zero.**
- **Metric-less rows.** A queuing creative is `current_status = 'excluded'` — not being served — so it has no rows in the analytics tables the performance queries read. Verified on campaign 41535: 16 queuing creatives, only 3 with any analytics data at all. The table therefore appends a row for each such creative (revenue 0, every rate blank) so you can see **which** creatives are stuck in the queue instead of silently missing them.

## 8. The three creative states

Authoritative, read from the queue PDT, never derived from impressions and age. They are **mutually exclusive**:

- **queuing** — queue-eligible, not optimizing, `current_status = 'excluded'`. In the creative-throttle waiting room, getting no impressions, waiting for capacity.
- **exploring** — queue-eligible, not optimizing, `current_status = 'included'`. Past the throttle and actively served via Winner Candidate Substitution, still pre-calibration, protected from the Auto-Pauser.
- **optimizing** — not queue-eligible, `is_currently_optimizing`. Calibrated, competing normally on ITI inside its inventory group, and eligible for the Auto-Pauser.

queuing and exploring differ **only** by `current_status`. A creative absent from the PDT — a paused one, for instance — has **no** state, and the app reports `insufficient_data` rather than guessing one.

## 9. The rules the explanations rest on

- MCO selects on **ITI** over a 30-day window. Never ROAS, CPI or CPA.
- **Calibration** (exploring to optimizing): at least 25,000 impressions in the past 3 months **and** at least 7 days live. Failing either leaves the creative pre-calibration.
- **Auto-Pauser** (MCO campaigns only) — all must hold: the creative is optimized; **and** it took under 5% of its competing inventory group's gross revenue over the past 3 days; **and** it either spent in that window or its selection probability is under 10%.
- **WCS substitution**: 5–10% of won bids, capped at 35%.
- **Creative throttle**: a minimum of 6 exploring creatives per inventory format.
- Inventory formats are **not** clean buckets — roughly 46.5% overlap between duration variants.

## 10. Recommendations

Generated deterministically from the analysis and levelled critical / warning / success / info: missing formats, formats with every creative paused, formats down to a single active creative, detaching confirmed poor creatives (never the last active one in a group), creatives over 20% SOW, groups below the recommended creative count, a stale creative set (nothing uploaded in 60 days), throttle-queue depth, more exploring than optimizing creatives, clusters of recent auto-pauses, active creatives with zero spend, formats with over 30% spend decline or over 50% growth, and a standing reminder to share findings with CSTs.

## 11. What the numbers include — read this before quoting a figure

- **The last 7 days are excluded.** Attribution has not settled, so 7 days are subtracted from both ends of the window: "last 30 days" means days 8 through 37 back. Any new metric must respect the same bake window or it will silently read low.
- Money is **gross revenue** — what the advertiser pays — unless a label explicitly says spend.
- Rates are **ratio of sums**, weighted, not averages of per-creative ratios.
- Uncredited rows are excluded throughout.
- The queue is invisible to activity-driven queries; see metric-less rows above.
- If part of the performance window fails to come back, the app shows an **error instead of a page of understated numbers**. Sums missing a chunk would be wrong with nothing on screen saying so. An error is the honest outcome — report it or retry, don't work around it.

# PART II — Maintaining the code

## 1. The two files

`Code.js` holds the config and single-source rule sets, the SQL builders, the fetch pipeline, the analysis engine and the AI layer. `Dashboard.html` is one file: inline CSS, markup, and all client JS including the deterministic offline fallbacks. There are no modules and no build step.

## 2. Request flow

`doGet()` serves `Dashboard.html` directly — no templating, no scriptlets. From the client, through `google.script.run`:

- `previewCampaign(input)` — the cheap preview while typing
- `fetchCampaignOverview(...)` — the fast first pass (`overviewOnly`, which skips the perf query and the three chart queries)
- `fetchCreativeData(input, searchType, lookbackDays, dashFilters)` — the whole pipeline
- `diagnoseMcoCreative(payload)` — the per-creative AI explanation, prefetched per recent-change row
- `summarizeFormatTrends(data)` — one AI call for the format charts
- `getConfig()` — every server-side rule set, fetched once on load into `CFG`
- `logUsage(action, details)` — appends a row to the Usage Log sheet

`fetchCreativeData` is the pipeline: find the campaign, wave 1, wave 2, merge, apply filters, optionally backfill daily metrics, `analyzeCreativePerformance`, generate recommendations, return one result object the front end renders.

## 3. Data layer

Looker SQL Runner over the `accelerate_trino` connection.

- `getAccessToken()` POSTs `/api/4.0/login` and caches the token for 25 minutes.
- `runSQL()` creates a `sql_queries` slug, then POSTs `/run/json`. **One statement per query.**
- `runSQLParallel(sqlMap)` is the central performance trick: slugs are created **sequentially** (each needs auth), then every `/run/json` fires at once through `UrlFetchApp.fetchAll()`. A failed key degrades to `[]` and records a reason — it never throws.

**Two waves, and why they are two:**

- **Wave 1 is the creative-performance query on its own.** Every number on the dashboard comes from it, and it is the slowest and least predictable query — measured at 40s, 94s and once over 120s on the same campaign within one day. When it briefly ran alongside the other twelve it competed for the connection and lost.
- For lookbacks of 15 days or more it is **chunked** into roughly 10-day windows (at most 6), issued **one at a time**. Firing them together through `fetchAll` lost chunks 1 and 2 twice on campaign 73853, while the same three chunks each answer in 14–19s from outside Apps Script. One retry runs before an empty answer is trusted, and if a chunk is still missing `fetchCreativeData` returns an **error** — sums covering fewer days than the window claims are worse than no answer.
- **Wave 2 is everything else, all in parallel**, because none of it depends on wave 1's rows: `inventory`, `config`, `meta`, `targetEvt`, `pauseLog`, `unassigned`, `deviceTgt`, `impInst`, `queuing`, `exploring`, `optimizing`, plus `dailyFmt`, `dailyCr` and `typeBreak` on the full pass only. Do not introduce a barrier between waves unless a query's SQL genuinely needs another query's rows.

Three measured facts worth keeping: every query has a **~4–5s floor** regardless of size (SQL Runner round trip plus Trino planning — a 2-row query takes 4.2s); slug creation is sequential, so N queries mean N round trips before any execution begins; and unscoped CTEs are not the problem people assume — a 1.58M-row aggregation costs 6.3s against 5.0s scoped to one campaign.

## 4. Tables

- `pinpoint.public.*` — `campaigns`, `creatives`, `campaigns_creatives`, `creative_events`, `creative_state_events`, `creative_selection_configurations`, `apps`, `goals`, `campaign_types`, `campaigns_targeted_devices`
- `hive.bi.cstudio_analytics_daily_v1` — MCO status, `optimization_state`, creative daily metrics
- `analytics.daily`, `analytics.trimmed_daily`, and `analytics.daily_attr_event_d7` — the money table
- `looker.*cstudio__creative_format*` and `looker.*queue_creative_statistics*` are **dated PDTs. Never hardcode a name.** `getPDT()` and `getQueuePDT()` go through `resolvePDT_()`, which lists the `SHOW TABLES LIKE` candidates, verifies via `SHOW COLUMNS` that the columns the app actually reads exist, walks backwards until one passes, caches the answer for an hour, and otherwise throws with the full candidate list. Taking "the last match" alone would silently query the wrong generation.

One subtlety: the creative-state queries deliberately omit the reference query's `campaigns.state = 'enabled'` filter, which would blank the pipeline states for exactly the paused and hidden campaigns the search is designed to reach.

## 5. The single-source contract

Defined once in `Code.js`, shipped to the client by `getConfig()`. Never re-declare any of these in `Dashboard.html` — read them from `CFG`.

- `MCO_GROUP_MAP_GS` + `toMcoGroup()` — `inventory_format` to MCO Inventory Group; the client uses `MCO_GROUP_MAP` through `invToDN()`, and `mcoGroupToBases()` derives the reverse for SQL-side filtering
- `KEY_FORMATS` — the list of groups, which becomes the format multi-select
- `MCO_RULES` — every threshold, the three creative states, the 13 diagnosis codes
- `METRICS` — what each metric means and which direction is good; the only place cost-versus-return is encoded
- `PRIMARY_METRIC_BY_CAMPAIGN_TYPE` + `resolvePrimaryMetric_()` — which metric a campaign is judged on
- `THRESHOLDS` — SOW warning at 20%, freshness at 60 days, 5 creatives minimum per group, under/overperform at 0.8 and 1.2
- `FORMAT_DEVICE` — which device class each group serves, so a phone-only campaign is never told it is missing tablet creatives

`MCO_RULES` reaches all three of its consumers from that one object: the Claude system prompt (appended as authoritative), the client-side offline fallback, and server-side logic. Changing a threshold is a one-line edit.

Two client-side rules are single-sourced the same way, in one function each: `isVideoFmt()` decides Video vs Non-video from the group name, and `invToDN()` is the only place a raw format becomes a display name.

## 6. Analysis

`analyzeCreativePerformance()` and `_generateRecommendations()` do the non-AI work: spend-weighted primary metric, SOW concentration, freshness, everything against `THRESHOLDS`.

`classifyCreativePerformance_()` stamps `perf_class` on every creative — **one** classification feeding both the table's tags and the "detach poor creatives" recommendation. It used to be implemented twice, and the two disagreed on screen in three separate ways: only the client applied the exclusivity cascade, only the server protected sole-active creatives, and the two grouped by different things (raw format versus MCO group).

`combinePerfChunks_()` collapses the perf query's rows to one row per creative. The 17-column `GROUP BY` emits a creative more than once whenever a campaign-level column changes mid-window, and those extra rows used to be **dropped rather than summed**: campaign 16298 showed $1,000,470 in the KPI tile against $999,134 in the table.

## 7. The AI layer

Two features, both going through one helper — `callClaudeJson_()` — which does the `UrlFetch` call, prompt caching, structured-output validation and error reporting.

- `diagnoseMcoCreative` returns `{diagnosis, format, explanation, supporting_evidence[], suggested_actions[], confidence}`. The `diagnosis` enum is **generated** from `MCO_RULES.diagnosis_codes`, so the model cannot return a code the UI does not render.
- `summarizeFormatTrends` returns `{summary, format_insights[{format, trend, insight}], recommendation}`.

Request shape, all near the top of the AI section:

- Model **`claude-sonnet-5`**, `max_tokens` **4096**. Adaptive thinking is **on when `thinking` is omitted**, and `max_tokens` caps thinking **and** response together — the old 1024 would truncate the JSON on this model.
- **Structured outputs** (`output_config.format` plus a JSON Schema) guarantee schema-valid JSON, so there is no code fence to strip and `JSON.parse` cannot fail on a preamble.
- **`output_config.effort`** is the cost and latency dial: `low` for the per-creative diagnosis (high volume, tight rules), `medium` for the trend summary.
- **Prompt caching** (`cache_control: ephemeral` on the system block): the skill is around 3K tokens and identical on every call, so cache reads cost about 10% of input. Watch `cache_read_input_tokens` in the execution log — the per-creative prefetch fires several calls at once, and concurrent requests cannot read a cache entry that is still being written, so the first burst pays full price.
- `stop_reason` is checked: `refusal` and `max_tokens` raise distinct errors instead of surfacing as a generic "unavailable".

The system prompt is `MCO_SKILL` + `mcoRulesPromptBlock()` + `metricsPromptBlock()`. Every number and every "lower is better" the model sees is **rendered from the same objects the UI reads**, so the model can never be briefed on a stale threshold.

The front end also carries deterministic fallbacks that reimplement the same reasoning in plain JS for when the API is unavailable: `localMcoDiagnosis`, `localFormatSummary`, `localVideoSummary`, `localInteractiveSummary`. They read their thresholds from `CFG` and return `insufficient_data` if config has not arrived yet, rather than inventing an answer.

## 8. Config and secrets

Nothing credential-shaped belongs in source. Everything lives in Script Properties (Project Settings, Script Properties):

- `LOOKER_CLIENT_ID` and `LOOKER_CLIENT_SECRET` — mint your own Looker API3 keys (Looker, your user, Edit, API3 Keys, New). Never reuse someone else's.
- `CLAUDE_API_KEY`

`runHealthCheck()`, run from the editor, checks all three properties, Looker auth, the Trino connection, both dated PDTs **and the columns the app reads from them**, and the single-source invariants. It keeps going after a failure so one run tells you everything that is wrong. Run it before redeploying.

## 9. Platform ceilings and failure modes

- Apps Script gives you **6 minutes per execution** and **30 seconds per UrlFetch call**. The two-pass load and the perf chunking both exist because of those two numbers.
- A failed query degrades to `[]`, which is why the pipeline refuses to render rather than trusting silence: inventory rows with no perf rows returns an error, and a partially-returned window returns an error naming the missing chunks.
- `getConfig()` is fetched asynchronously at page load. Anything rule-bearing that could run before it returns must handle a null config.
- A thrown error mid-render leaves the rest of the DOM unwritten, so the page truncates silently after whatever rendered last. This is the failure mode to watch for after any front-end change.

## 10. Changing it safely

1. **Verify SQL against real rows first.** Take the SQL a `build*SQL()` function produces, run it on `accelerate_trino`, and read the actual column names off the result. Never infer a column name from `Code.js` — the PDTs and the cstudio tables drift.
2. `node tools/render_smoke_test.js` — drives the whole client render chain on demo data with config empty (the worst case) and catches the class of error `node --check` cannot see. v132 shipped a `TypeError` from a blind string replace that matched mid-identifier: it parsed fine and killed the page right after the campaign summary.
3. `python3 tools/check_single_source.py` — fails if a duplicated rule reappears: a mapping literal in `Dashboard.html`, a hardcoded threshold, a second Claude call site, a credential in source, a read of the untrusted video flag. Add a rule whenever you collapse a new duplicate.
4. `runHealthCheck()` from the editor.
5. From `appscript/`, `clasp push -f`. In non-interactive shells `clasp push` can print "Skipping push." and upload nothing — always use `-f`, and treat a push that does not list the changed files as a failure.
6. **Redeploy, and redeploy the same deployment.** `clasp push` only updates the HEAD version; production keeps serving old code until the deployment itself is updated. `clasp create-deployment` with no arguments mints a **new** deployment ID and URL, which leaves the shared `/exec` link on the old code — use `clasp create-deployment -i <existing deployment id>`, or Deploy then Manage deployments in the editor. Confirm with `clasp list-deployments`.
7. Verify in the browser on a real campaign.

## 11. Known open items

- `Code.js` and `Dashboard.html` are monoliths: no modules, no build step, no unit tests beyond the two scripts above.
- There is no typed contract between backend and front end. `analyzeCreativePerformance` drops fields that `fetchCreativeData` then patches back onto the result.
- `result.typeBreakdown` (the `typeBreak` query) is no longer rendered anywhere — the charts and the AI payload both compute from `creativePerf` — and it is keyed on the `is_video_creative` flag that is no longer trusted. It is a candidate for deletion, which would drop a query from wave 2.
- Version markers in the header comments are stale.
- Sequential slug creation scales with query count, and wave 2 issues 11 to 14 of them.

# PART III — 繁體中文版

## 總覽

**這是什麼。** 一個 Google Apps Script 網頁應用，替 Liftoff Performance Strategist 回答一個問題：**這個 campaign 裡每一支 creative 為什麼在花錢、為什麼沒花錢、或為什麼被自動暫停？** 輸入 campaign ID，它會從 Trino 撈出該 campaign 的 creatives 與成效，用 MCO 真正競價的方式分組，然後逐支解釋。

**位置。**

- Apps Script 專案 `1WMWxrw45Bg6UCu9QTaGtYV4sn0e9go6cYoCv9q6vuzCmYkSeTY5HIrw7`
- 兩個檔案：`Code.js`（後端，約 3.1k 行）與 `Dashboard.html`（整個前端，約 3.2k 行）
- 部署設定：access `DOMAIN`、executeAs `USER_DEPLOYING` — 每個人都以自己的身分與 Looker 權限執行
- 每次執行都會寫入 `Usage Log` 試算表 `1URHDLIXlUqMLS41TpgepSAsX8L2BHtMDJrUcBnfleKA`

**最該保留的設計原則。** 每一個 threshold、format 對照、metric 定義與規則，在 `Code.js` 裡都只有**一份**定義，前端透過 `getConfig()` 在執行時讀取。這個 app 過去幾乎所有的 bug，都是同一條規則有兩份副本而互相矛盾。要加規則，只加一次。

## 一、如何跑一次分析

- 輸入 campaign ID。輸入時有 600ms debounce 的預覽，會先顯示 campaign 名稱、狀態、MCO 狀態與 optimization state，讓你在跑慢查詢前先確認。
- Campaign 搜尋涵蓋**所有**狀態 — enabled、paused、hidden、deleted — 並以「上線中優先」排序，所以已暫停或隱藏的 campaign 一樣可以分析，且狀態會顯示出來。
- 選擇 lookback：7 / 14 / 30（預設）/ 60 / 90 天，或自訂區間（上限 365 天）。
- 可先套用的篩選：creative state、format type、optimization state、creative ID，以及 MCO Inventory Group 的多選。
- 頁面分**兩段載入**。第一段 overview（約 8 秒）先畫出 campaign 抬頭、近期 creative 變動與 creative 清單；第二段重查詢再把所有數字補上。第二段還在跑時，金額 tile 顯示 "querying…" 而不是破折號 — 破折號的意思是「這個 campaign 沒有花費」，那是另一件事，而且是錯的。

## 二、Campaign 抬頭

Campaign ID、名稱、狀態，接著一列 metadata：Type、Model（optimization state）、Selection（MCO 或 Free-floating，特別上色，因為它決定底下所有數字該怎麼讀）、Devices、Target Event、Goal 2、VT cap、Viewclick tolerance。下方是 ad group 的 ID 與名稱。另有兩個外連：AC2 與 Gumshoe，都已預先帶入這個 campaign 與同一個 lookback。

## 三、五個 KPI tile

Gross revenue、campaign 的 primary metric、Active creatives、Paused creatives、Format groups。

- **抬頭數字是 gross revenue，不是 spend。** `revenue_micros_d7` 是廣告主付的錢，spend 是媒體成本。這一列其他每個指標本來就是以 gross revenue 為基底計算 — campaign 78841 的 spend 是 $55,927.50，gross revenue 是 $92,972.86，而 RPA x events = RPI x installs 剛好等於 gross revenue。Spend 仍顯示在副標，因為 SOW 與各 format 的花費占比是用它算的。
- Primary metric tile 是**以 gross revenue 加權的 ratio of sums**，不是把每支 creative 的比率平均。
- **Active + Paused 不一定等於 Total。** `pinpoint.public.creatives.state` 有三種值 — enabled、paused、deleted — 而 deleted 的 creative 在區間內仍可能有花費，所以它屬於總數。剩下的部分會以它真正的 state 命名，而不是丟進含糊的「其他」。

## 四、這個 campaign 用哪個指標判斷

只解析一次，而且**先看 goals**：如果 optimization state 或任一 campaign goal 提到 rpa/cpa，就用 **RPA**；roas/cpr 用 **7D ROAS**；rpi/cpi 用 **RPI**；都沒有才退回 campaign type（`ua_cpr` 與 `re` 用 ROAS、`ua_cpa` 用 RPA、`ua_cpi` 用 RPI）。

Campaign 78934 說明了順序為何重要：它的 `campaign_type` 是 'brand'，名稱裡也沒有 cpa/roas 字樣，靠 type 猜會得到 ROAS；但 `goal_2` = 'rpa'、`optimization_state` = 'cpa'，實際上是用 RPA 判斷的。

方向性也只定義在一個地方：**RPA 與 RPI 越低越好**；ROAS、ITI、IPM 越高越好。欄位排序與所有「優於平均」的判斷都遵守這個方向。

## 五、近期 creative 變動

這裡有兩種變動：**paused**（狀態改變）與 **detached**（creative 被從 campaign 上取下）。被 detach 的 creative 通常仍是 'enabled'，所以這份清單是它唯一會出現的地方。

排序依據是**占 campaign gross revenue 的比重**，所以損失最大的變動排在最前面。每一筆會顯示 format、營收占比、由誰執行 — `MAB` 是平台的 Auto-Pauser，`Manual` 是人 — 以及日期。點 format 標籤可以篩選。

選一支 creative，右側面板會解釋它。AI 診斷就出現在這裡，而且**只針對 MCO 自己的暫停決策**，絕不用於人為 detach — 那不需要模型解釋。

## 六、圖表

- **Format spend** 與 **Revenue over time**，都以 MCO Inventory Group 為單位。
- **Video vs Non-video。** 一支 creative 被算成 Video 的條件是：它的 MCO Inventory Group 名稱屬於 **VAST** format。這裡刻意**不使用** fact table 上的 `is_video_creative` 欄位。以一個資料已完全 bake 的日子量測：約 3,900 支、帶著 $200K 以上花費的 creative 落在 VAST format，但該欄位是 'false'；另有數百支非 VAST 的 creative 是 'true'；campaign 82323 的 80 支 creative 中有 40 支在 VAST format，該欄位卻標記**零**支為 video。圖表標題直接把這條規則寫在畫面上。
- **Interactive vs Not Interactive**，來自 `is_interactive`。'N/A' 是一個真實的分類，不是錯誤。
- 每張圖可切換 bar 或 donut，下方都有一段文字解讀。解讀與圖表用**同一份彙總**產生，所以文字不可能講出跟上方長條圖不同的贏家。

## 七、Creative Performance by Format — 主表格

- 每一列是 **MCO Inventory Group**，不是原始的 `inventory_format`，因為 Auto-Pauser 是在 group **內部**讓 creative 互相競爭。30s 與 60s 的 VAST 變體會併成同一個 group。
- 一個 format 列的數字永遠是它**所有** creative 的累計。篩選只改變哪些 creative 子列可見，永遠不會動到 group 的總計。
- 成效標籤，互斥且由後端蓋章：**★ Top**、**↑ Campaign avg**、**↑ Format avg**、**⚠ Poor**。四者都要求信賴區間夠窄，所以標籤同時是關於「信心」的主張，不只是關於成效。
- 篩選條件：lifecycle state（queuing / exploring / optimizing）、creative state、variance、Video、Interactive、creative ID、成效分類。
- 欄位可個別開關，Excel 按鈕會以 TSV 複製整張表。
- **破折號代表「這個指標沒有資料」，不是 0。**
- **沒有指標的列。** Queuing 的 creative 是 `current_status = 'excluded'` — 沒有被投放 — 所以在成效查詢讀的 analytics 表裡完全沒有資料列。在 campaign 41535 上驗證過：16 支 queuing，只有 3 支有任何 analytics 資料。因此表格會為每一支這樣的 creative 補上一列（revenue 0、所有比率空白），讓你看得到**哪些** creative 卡在 queue，而不是讓它們安靜消失。

## 八、三種 creative state

具權威性，從 queue PDT 讀取，絕不用 impressions 與上線天數推導。三者**互斥**：

- **queuing** — queue-eligible、非 optimizing、`current_status = 'excluded'`。在 creative throttle 的等候室裡，拿不到曝光，等待容量。
- **exploring** — queue-eligible、非 optimizing、`current_status = 'included'`。已通過 throttle，正透過 Winner Candidate Substitution 被投放，仍在 calibration 之前，受保護不會被 Auto-Pauser 暫停。
- **optimizing** — 非 queue-eligible、`is_currently_optimizing`。已完成 calibration，在自己的 inventory group 內以 ITI 正常競爭，並且會被 Auto-Pauser 納入評估。

queuing 與 exploring 的差別**只有** `current_status`。不在 PDT 裡的 creative（例如已暫停的）**沒有** state，app 會回報 `insufficient_data` 而不是猜一個。

## 九、解釋所依據的規則

- MCO 以 **ITI** 為選擇指標，視窗 30 天。不是 ROAS、CPI 或 CPA。
- **Calibration**（exploring 轉 optimizing）：過去 3 個月至少 25,000 次曝光**且**上線至少 7 天。任一條不滿足就仍在 calibration 之前。
- **Auto-Pauser**（僅 MCO campaign），以下全部成立才會暫停：已 optimized；**且**過去 3 天在其競價 inventory group 中的 gross revenue 占比低於 5%；**且**（該區間內有花費，或 selection probability 低於 10%）。
- **WCS substitution**：已得標請求的 5–10%，上限 35%。
- **Creative throttle**：每個 inventory format 至少 6 支 exploring creative。
- Inventory format 並**不是**乾淨的分桶 — 各時長變體之間約有 46.5% 重疊。

## 十、Recommendations

由分析結果以確定性規則產生，分為 critical / warning / success / info：缺少的 format、整個 format 全數暫停、只剩一支 active creative 的 format、建議 detach 確認表現差的 creative（絕不動 group 裡最後一支 active 的）、SOW 超過 20% 的 creative、creative 數低於建議值的 group、creative 素材過舊（60 天內沒有新上傳）、throttle queue 的深度、exploring 多於 optimizing、近期集中發生的自動暫停、有 active 但零花費的 creative、花費下降超過 30% 或成長超過 50% 的 format，以及固定提醒把發現同步給 CST。

## 十一、引用任何數字之前請先看這段

- **最近 7 天被排除。** 歸因還沒穩定，所以視窗前後各扣 7 天：「最近 30 天」實際上是往前第 8 到第 37 天。任何新增指標都必須遵守同一個 bake window，否則數字會安靜地偏低。
- 金額一律是 **gross revenue**（廣告主付的錢），除非標籤明確寫 spend。
- 比率都是**加權的 ratio of sums**，不是把每支 creative 的比率平均。
- 全程排除 uncredited 的資料列。
- Queue 對「以活動為驅動」的查詢是看不見的，見上面「沒有指標的列」。
- 如果成效視窗有一段沒回來，app 會顯示**錯誤，而不是一頁偏低的數字**。少了一塊的加總是錯的，而畫面上不會有任何提示。顯示錯誤才是誠實的結果 — 請回報或重試，不要繞過它。

## 十二、維護：兩個檔案與請求流程

`Code.js` 放 config 與單一來源的規則集、SQL builders、抓取流程、分析引擎與 AI 層。`Dashboard.html` 是單一檔案：inline CSS、markup，以及所有前端 JS，包含離線的確定性 fallback。沒有模組，沒有 build step。

`doGet()` 直接送出 `Dashboard.html`（沒有 templating、沒有 scriptlet）。前端透過 `google.script.run` 呼叫：

- `previewCampaign(input)` — 輸入時的輕量預覽
- `fetchCampaignOverview(...)` — 快速的第一段（`overviewOnly`，跳過 perf 與三個圖表查詢）
- `fetchCreativeData(input, searchType, lookbackDays, dashFilters)` — 完整流程
- `diagnoseMcoCreative(payload)` — 單支 creative 的 AI 解釋，依變動列預先抓取
- `summarizeFormatTrends(data)` — format 圖表的單次 AI 呼叫
- `getConfig()` — 所有後端規則集，載入時取一次存進 `CFG`
- `logUsage(action, details)` — 寫一列到 Usage Log

## 十三、資料層與兩個 wave

透過 Looker SQL Runner 走 `accelerate_trino` 連線。`getAccessToken()` 打 `/api/4.0/login` 並把 token 快取 25 分鐘；`runSQL()` 先建立 `sql_queries` slug 再 POST `/run/json`，**一次只能一個 statement**。`runSQLParallel(sqlMap)` 是核心的效能手法：slug **依序**建立（每個都要驗證），然後所有 `/run/json` 透過 `UrlFetchApp.fetchAll()` 一次發出。失敗的 key 會退化成 `[]` 並記下原因，永遠不會 throw。

**為什麼分成兩個 wave：**

- **Wave 1 只跑 creative 成效查詢。** dashboard 上所有數字都來自它，而它也是最慢、最不可預測的查詢 — 同一個 campaign 在同一天內量到 40 秒、94 秒、以及一次超過 120 秒。它曾經和其他十二個查詢一起跑，結果是搶連線而搶輸。
- lookback 15 天以上時，它會被**切塊**成約 10 天一段（最多 6 段），並且**一次只發一段**。曾經用 `fetchAll` 一起發，在 campaign 73853 上兩次都掉了第 1、2 塊，而同樣三塊從 Apps Script 外面跑每塊只要 14–19 秒。空結果會先重試一次；如果仍有缺塊，`fetchCreativeData` 會回傳**錯誤** — 涵蓋天數少於宣稱視窗的加總，比沒有答案更糟。
- **Wave 2 是其餘全部平行跑**，因為它們都不依賴 wave 1 的資料列：`inventory`、`config`、`meta`、`targetEvt`、`pauseLog`、`unassigned`、`deviceTgt`、`impInst`、`queuing`、`exploring`、`optimizing`，完整流程時再加 `dailyFmt`、`dailyCr`、`typeBreak`。除非某個查詢的 SQL 真的需要另一個查詢的資料列，不要在兩個 wave 之間再加 barrier。

三個值得記住的量測結果：每個查詢不論大小都有 **4–5 秒的下限**（SQL Runner 往返加上 Trino planning，一個 2 列的查詢要 4.2 秒）；slug 是依序建立的，所以 N 個查詢在開始執行前先有 N 次往返；沒有加條件的 CTE 並不是問題 — 對 158 萬列做彙總是 6.3 秒，限縮到單一 campaign 是 5.0 秒。

## 十四、資料表與 PDT

`pinpoint.public.*`（`campaigns`、`creatives`、`campaigns_creatives`、`creative_events`、`creative_state_events`、`creative_selection_configurations`、`apps`、`goals`、`campaign_types`、`campaigns_targeted_devices`）、`hive.bi.cstudio_analytics_daily_v1`（MCO 狀態、`optimization_state`、creative 每日指標）、`analytics.daily`、`analytics.trimmed_daily`，以及金額表 `analytics.daily_attr_event_d7`。

`looker.*cstudio__creative_format*` 與 `looker.*queue_creative_statistics*` 是**帶日期的 PDT，名稱絕對不要寫死。** `getPDT()` 與 `getQueuePDT()` 都走 `resolvePDT_()`：先用 `SHOW TABLES LIKE` 列出候選，再用 `SHOW COLUMNS` **驗證 app 真正會讀的欄位存在**，往回找到第一個通過的，快取一小時，否則連同完整候選清單 throw。只取「最後一個 match」會安靜地查到錯誤的世代。

另有一個細節：creative state 的查詢刻意不加參考查詢裡的 `campaigns.state = 'enabled'` 條件 — 那個條件會讓「已暫停或隱藏」這類 campaign 的 pipeline 狀態全部變空白，而那正是搜尋刻意要涵蓋的對象。

## 十五、單一來源契約

在 `Code.js` 定義一次，由 `getConfig()` 送到前端。這些都**不要**在 `Dashboard.html` 重新宣告，請從 `CFG` 讀：

- `MCO_GROUP_MAP_GS` + `toMcoGroup()` — `inventory_format` 轉 MCO Inventory Group；前端用 `MCO_GROUP_MAP` 經 `invToDN()`，`mcoGroupToBases()` 導出反向對照供 SQL 端篩選
- `KEY_FORMATS` — group 清單，也是 format 多選的來源
- `MCO_RULES` — 所有 threshold、三個 creative state、13 個診斷代碼
- `METRICS` — 每個指標的意義與方向；唯一編碼「成本型 vs 回報型」的地方
- `PRIMARY_METRIC_BY_CAMPAIGN_TYPE` + `resolvePrimaryMetric_()` — campaign 用哪個指標判斷
- `THRESHOLDS` — SOW 警示 20%、素材新鮮度 60 天、每 group 最少 5 支、under/overperform 0.8 與 1.2
- `FORMAT_DEVICE` — 每個 group 服務哪個裝置類別，所以只投手機的 campaign 不會被說「缺平板素材」

`MCO_RULES` 從這一個物件同時到達三個消費端：Claude 的 system prompt（以權威資訊附加）、前端離線 fallback、以及後端邏輯。改一個 threshold 是改一行。

前端有兩條規則以同樣方式單一來源化，各只有一個函式：`isVideoFmt()` 依 group 名稱判定 Video / Non-video，`invToDN()` 是原始 format 轉顯示名稱的唯一入口。

## 十六、分析與 AI 層

`analyzeCreativePerformance()` 與 `_generateRecommendations()` 負責非 AI 的部分：加權後的 primary metric、SOW 集中度、素材新鮮度，全部對照 `THRESHOLDS`。

`classifyCreativePerformance_()` 在每支 creative 上蓋 `perf_class` — **一份**分類同時餵給表格標籤與「detach 表現差的 creative」建議。它曾經被實作兩次，而兩者在畫面上有三種不一致：只有前端套用互斥階層、只有後端保護 group 內唯一 active 的 creative、以及兩者分組依據不同（原始 format 對 MCO group）。

`combinePerfChunks_()` 把 perf 查詢的資料列收攏成「每支 creative 一列」。17 欄的 `GROUP BY` 在某個 campaign 層級欄位於區間中途改變時，會讓同一支 creative 出現多列，而那些多出來的列以前是**被丟掉而不是加總**：campaign 16298 的 KPI tile 是 $1,000,470，表格是 $999,134。

AI 有兩個功能，都走同一個 helper `callClaudeJson_()`（負責 `UrlFetch`、prompt caching、structured output 驗證與錯誤回報）。`diagnoseMcoCreative` 回傳 `{diagnosis, format, explanation, supporting_evidence[], suggested_actions[], confidence}`，其中 `diagnosis` 的 enum 是從 `MCO_RULES.diagnosis_codes` **生成**的，所以模型不可能回傳 UI 畫不出來的代碼；`summarizeFormatTrends` 回傳 `{summary, format_insights[{format, trend, insight}], recommendation}`。

- 模型 **`claude-sonnet-5`**、`max_tokens` **4096**。省略 `thinking` 時 adaptive thinking 是**開啟**的，而 `max_tokens` 同時涵蓋 thinking **與**回應 — 舊的 1024 會在這個模型上把 JSON 截斷。
- **Structured outputs**（`output_config.format` 加 JSON Schema）保證 JSON 合乎 schema，所以沒有 code fence 要剝除，`JSON.parse` 也不會因為前言而失敗。
- **`output_config.effort`** 是成本與延遲的旋鈕：單支 creative 診斷用 `low`（量大、規則明確），趨勢摘要用 `medium`。
- **Prompt caching**（system block 上的 `cache_control: ephemeral`）：skill 約 3K tokens 且每次呼叫都相同，快取讀取約只要輸入的 10% 成本。請看 execution log 裡的 `cache_read_input_tokens` — 逐支 creative 的預抓會同時發出多個呼叫，而併發請求無法讀取「還在寫入中」的快取項目，所以第一波是全價。
- 有檢查 `stop_reason`：`refusal` 與 `max_tokens` 各自拋出明確錯誤，不會變成籠統的「服務不可用」。

System prompt 是 `MCO_SKILL` + `mcoRulesPromptBlock()` + `metricsPromptBlock()`。模型看到的每個數字、每句「越低越好」，都是**從 UI 讀的同一批物件算繪出來**的，所以模型不可能被餵到過期的 threshold。前端另有確定性 fallback（`localMcoDiagnosis`、`localFormatSummary`、`localVideoSummary`、`localInteractiveSummary`），在 API 不可用時以純 JS 重現同樣的推理；它們從 `CFG` 讀 threshold，config 還沒到就回 `insufficient_data`，不會自己編答案。

## 十七、設定與機密

任何像憑證的東西都不放在原始碼裡，全部放 Script Properties（Project Settings 的 Script Properties）：`LOOKER_CLIENT_ID`、`LOOKER_CLIENT_SECRET`（自己去 Looker 開 API3 Keys，不要沿用別人的）、`CLAUDE_API_KEY`。

從編輯器執行 `runHealthCheck()` 會檢查這三個 property、Looker 驗證、Trino 連線、兩個帶日期的 PDT **以及 app 會讀的欄位**，還有單一來源的不變量；它在失敗後會繼續跑完，所以一次執行就能看到所有問題。重新部署前先跑它。

## 十八、平台上限與失效模式

- Apps Script 給你**每次執行 6 分鐘**、**每個 UrlFetch 30 秒**。兩段式載入與 perf 切塊都是為了這兩個數字而存在。
- 查詢失敗會退化成 `[]`，所以流程刻意拒絕在沉默中繪圖：有 inventory 列但沒有 perf 列會回錯誤，視窗只回一部分也會回錯誤並指名缺哪幾塊。
- `getConfig()` 是頁面載入時非同步取得的。任何可能在它回來之前執行、又跟規則有關的程式，都必須能處理 config 為空。
- 渲染途中拋錯會讓 DOM 剩下的部分完全沒被寫入，頁面會在最後成功渲染的地方安靜截斷。任何前端改動後都要留意這個失效模式。

## 十九、安全地修改它

1. **先用真實資料驗證 SQL。** 把 `build*SQL()` 產出的 SQL 拿去 `accelerate_trino` 跑，從結果讀真正的欄位名。絕對不要只看 `Code.js` 推斷欄位名 — PDT 與 cstudio 表會漂移。
2. `node tools/render_smoke_test.js` — 在 config 為空（最壞情況）的 demo 資料上跑完整個前端渲染鏈，能抓到 `node --check` 看不見的那一類錯誤。v132 就出過一次 `TypeError`：一個盲目的字串替換在識別字中間命中，語法完全正確，卻讓頁面在 campaign 摘要之後就死掉。
3. `python3 tools/check_single_source.py` — 只要重複的規則回來就失敗：`Dashboard.html` 裡的對照表字面值、寫死的 threshold、第二個 Claude 呼叫點、原始碼裡的憑證、對那個不可信 video 欄位的讀取。每收斂掉一個重複，就加一條規則。
4. 從編輯器執行 `runHealthCheck()`。
5. 在 `appscript/` 下執行 `clasp push -f`。非互動式 shell 裡 `clasp push` 可能印出 "Skipping push." 而什麼都沒上傳 — 一律加 `-f`，而且沒有列出變更檔案的 push 要當成失敗。
6. **重新部署，而且要部署同一個 deployment。** `clasp push` 只更新 HEAD 版本；在 deployment 本身更新之前，正式環境還是在跑舊程式碼。`clasp create-deployment` 不帶參數會產生一個**新的** deployment ID 與網址，於是大家在用的 `/exec` 連結還是舊的 — 要用 `clasp create-deployment -i <現有 deployment id>`，或在編輯器 Deploy 的 Manage deployments 裡改。最後用 `clasp list-deployments` 確認。
7. 在瀏覽器用真實 campaign 驗一次。

## 二十、已知待辦

- `Code.js` 與 `Dashboard.html` 是單體檔案：沒有模組、沒有 build step，除了上面兩個腳本也沒有單元測試。
- 後端與前端之間沒有型別契約。`analyzeCreativePerformance` 丟掉的欄位，`fetchCreativeData` 又補回去。
- `result.typeBreakdown`（`typeBreak` 查詢）已經不再被任何地方渲染 — 圖表與 AI payload 都從 `creativePerf` 計算 — 而且它是以已不再信任的 `is_video_creative` 欄位為鍵。可以考慮刪除，這樣 wave 2 就少一個查詢。
- 檔頭註解裡的版本標記已經過期。
- Slug 依序建立的成本隨查詢數量增加，而 wave 2 會發出 11 到 14 個。
