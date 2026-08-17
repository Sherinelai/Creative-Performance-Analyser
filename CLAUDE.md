# Project: creative-performance-analyser

> **The mission:** re-architect the **Creative Performance Analyzer** — a Google Apps Script web app
> that tells a Liftoff Performance Strategist *why* each creative in a campaign is spending, not
> spending, or was auto-paused. The live app is vendored in `appscript/`:
> `https://script.google.com/home/projects/1WMWxrw45Bg6UCu9QTaGtYV4sn0e9go6cYoCv9q6vuzCmYkSeTY5HIrw7/edit`
>
> **This repo is deliberately thin.** It holds exactly four things: (1) the GAS source under version
> control, (2) a data-access layer so a query can be *verified against real Trino rows* before it is
> written into `Code.js`, (3) the MCO domain knowledge that powers the app's AI, (4) the
> learn-and-commit loop (`LEARNINGS.d/` + hooks + git). Nothing else belongs here.
>
> The inherited TikTok DNU-CPI work (poor-performing-creatives skill, `appscript-creative/`,
> `trino-migration/`) was **removed** — different project. Recoverable from commit `02f44c2`.

## Layout

- `appscript/` — **the app.** `Code.js` (backend, ~2.9k lines), `Dashboard.html` (front end, ~3.1k
  lines), `appsscript.json`, `.clasp.json` → scriptId `1WMWxrw4…`. Deploy with `clasp push -f`.
- `creative_mcp.py` — MCP server: Looker init + Trino SQL runner. The *same* `accelerate_trino`
  connection the app queries, so dashboard SQL can be run and diffed from here.
- `.mcp.json` — registers `creative-mcp` against the project venv
- `skills/mco-creative-explainer/SKILL.md` — **the** MCO domain reference; compiled into `Code.js`
- `tools/sync_skill.py` — compiles that `.md` into `Code.js`'s `MCO_SKILL` (`--check` to verify)
- `tools/check_single_source.py` — fails if duplicated knowledge reappears
- `tools/render_smoke_test.js` — runs `Dashboard.html`'s render chain in Node behind a DOM stub
- `HANDOVER.md` + `tools/docs_auth.py` / `tools/docs_write.py` — **the fifth thing**, added
  deliberately: the team-facing handover document (English + 繁中, both audiences) and the two
  scripts that publish it. `docs_auth.py` mints a Docs-scoped OAuth token once
  (`auth/docs-token.json`, gitignored); `docs_write.py <docId> <file.md>` replaces that Doc's body
  from a Markdown subset. The live copy is Doc `1ti7Imv3OUo8oeop7H8osaT_j5q2vjej3ZCEyYXQjCP4`.
  **Edit `HANDOVER.md` and re-run the writer** — do not hand-edit the Doc, or the two diverge.
- `auth/` — `looker.ini` + Google tokens/service account (all **gitignored**, never commit)
- `LEARNINGS.d/` — per-session learnings log (each session appends to its OWN `<session-id>.md`)
- `logs/mcp_queries.jsonl` — local query log (gitignored)
- `python-virtual-environment/` — project venv (Python 3.14.3, uv-managed; gitignored)

New machine: `bash install.sh`, drop your own creds in `auth/`, then
`./python-virtual-environment/bin/python3 -c "import creative_mcp as m; print(m.list_trino_connections())"`.

---

# Part 1 — How the target app works

Read this before touching `appscript/`. Line numbers are from the current vendored copy.

## Request flow

```
doGet()  →  HtmlService.createHtmlOutputFromFile('Dashboard')     (no templating, no scriptlets)
   ↓  google.script.run
previewCampaign(input)        debounced 600ms while typing — cheap MCO + optimization_state peek
fetchCreativeData(input, searchType, lookbackDays, dashFilters)   ← the one heavy call
diagnoseMcoCreative(payload)  per-creative Claude call, prefetched per status-log row
summarizeFormatTrends(data)   one Claude call for the format charts
logUsage(action, details)     appends a row to the 'Usage Log' sheet (1URHDL…)
```

`fetchCreativeData` is the whole pipeline: search campaign → **wave 1** (perf) → **wave 2**
(everything else) → merge → filter → optional daily-metrics backfill → `analyzeCreativePerformance`
→ recommendations → one big result object the front end renders. `fetchCampaignOverview` is the same
function with `overviewOnly`, which skips perf and the three chart queries so the page can paint in
~8s and fill in the numbers on a second call.

## Data layer — Looker SQL Runner over Trino

`getAccessToken()` (`Code.js:134`) POSTs `/api/4.0/login`, caches the token 25 min in `CacheService`.
`runSQL()` (`Code.js:177`) creates a `sql_queries` slug then POSTs `/run/json` — **one statement**.

`runSQLParallel(sqlMap)` (`Code.js:192`) is the app's central performance trick and the thing most
worth preserving in any rewrite: slugs are created **sequentially** (each needs auth), then every
`/run/json` fires at once through `UrlFetchApp.fetchAll()`. A failed key degrades to `[]`, never
throws. The waves:

**Wave 1 is `perf` ALONE; wave 2 is every other query in parallel.** Once they all went in one batch
— the barrier between the old Batch 1 and Batch 2 waited for nothing and cost ~28s of a ~68s load on
campaign 77022 (perf **40s**, dailyFmt **28s**, dailyCr **26s**, everything else 4–8s). Perf then got
its own wave for a different reason: it is the slowest and least predictable query (40s, 94s, once
>120s on the same campaign in one day) and running it alongside the other twelve made it compete for
the connection and lose. Wave 2 is `inventory`, `config`, `meta`, `targetEvt`, `pauseLog`,
`unassigned`, `deviceTgt`, `impInst`, `queuing`, `exploring`, `optimizing`, plus `dailyFmt`,
`dailyCr`, `typeBreak` on the full pass. **Do not put a barrier between them, and do not add a third
wave, unless a query's SQL genuinely needs another query's rows.**

Perf is also **chunked** for lookbacks ≥15 days (`perfChunkWindows_`: ~10-day windows, max 6) and the
chunks go **one at a time** — `fetchAll` lost chunks 1 and 2 twice on campaign 73853 while the same
three answer in 14–19s each from outside GAS. One retry, then a missing chunk becomes an **error**:
sums covering fewer days than the window claims are worse than no answer.

Two other measured facts about load time: every query has a **~4–5s floor** regardless of size (Looker
SQL Runner round trip + Trino planning — a 2-row query takes 4.2s), and slug creation is still
**sequential**, so one round trip per query precedes any execution. Unscoped CTEs are *not* a problem: the
`creative_state_events` aggregation over 1.58M rows costs 6.3s versus 5.0s scoped to one campaign.

`queuing`/`exploring`/`optimizing` fall back to `'SELECT 1 AS _skip'` when their builder returns null.
Campaign-level basic/cohort queries were deliberately **removed** — recomputed from `merged[]` so the
campaign totals can never disagree with the creative rows.

Tables (`SQL_CONN = 'accelerate_trino'`):

- `pinpoint.public.*` — `campaigns`, `creatives`, `campaigns_creatives`, `creative_events`,
  `creative_state_events`, `creative_selection_configurations`, `apps`, `goals`, `campaign_types`
- `hive.bi.cstudio_analytics_daily_v1` — MCO status, `optimization_state`, creative daily metrics
- `analytics.daily`, `analytics.trimmed_daily`, `analytics.daily_attr_event_d7`
- `looker.*cstudio__creative_format*` and `looker.*queue_creative_statistics*` — **dated PDTs**.
  Never hardcode a name: `getPDT()` / `getQueuePDT()` go through `resolvePDT_()`, which lists the
  `SHOW TABLES LIKE` candidates, **verifies the columns the app reads** via `SHOW COLUMNS`, walks
  backwards until one passes, caches for 1 h, and otherwise throws with the full candidate list.
  Taking "the last match" alone would silently query the wrong generation.

Campaign search covers **every** campaign state (`enabled` / `paused` / `hidden` / `deleted` —
2026-07-27 counts 2,986 / 71,722 / 2,189 / 2,114), ranked live-first by `CAMPAIGN_STATE_RANK`, so a
paused or hidden campaign is analysable and the state is shown in the preview and overview. The rank
must be a **selected column** (`state_rank`), not an `ORDER BY` expression — these are
`SELECT DISTINCT` queries and Trino rejects ORDER BY expressions that aren't in the select list.
Correspondingly, the creative-state queries deliberately omit the reference query's
`campaigns.state = 'enabled'` filter, which would blank the pipeline states for exactly those
campaigns.

Windowing constants: `DEFAULT_LOOKBACK_DAYS = 30`, `DATA_BAKE_DAYS = 7` — the last 7 days are excluded
because attribution has not settled. Any new metric must respect the same bake window or it will
silently read low.

## The MCO grouping contract — one map, one rule set

Two things are now **single-sourced in `Code.js` and shipped to the front end by `getConfig()`**.
Never re-declare either in `Dashboard.html`; read them from `CFG` / `mcoRules()`.

| What | Defined in | Reaches the client as |
|---|---|---|
| `inventory_format` → MCO Inventory Group | `MCO_GROUP_MAP_GS` + `toMcoGroup()` | `MCO_GROUP_MAP`, used by `invToDN()` |
| Reverse (group → format bases, for filtering) | `mcoGroupToBases()` — derived from the map | — |
| The list of groups | `KEY_FORMATS` | `ALL_DN` (format multi-select) |
| Every MCO threshold, the 3 creative states, the 13 diagnosis codes | `MCO_RULES` | `CFG.mcoRules`, via `mcoRules()` |
| What each metric means + which way is good | `METRICS` | `CFG.metrics`, via `metricDef()` / `metricLabel()` / `isCostMetric()` |
| Which metric a campaign type is judged on | `PRIMARY_METRIC_BY_CAMPAIGN_TYPE` | `primaryMetricKey()` |
| Analysis thresholds (SOW, freshness, …) | `THRESHOLDS` | `CFG.thresholds`, via `TH('NAME')` |

**The guard:** `python3 tools/check_single_source.py` fails if any of those duplicates comes back —
it greps for the exact shapes they had (a mapping literal in `Dashboard.html`, a `25000`, a
`flipCols` list, a second `api.anthropic.com` call site, a credential in source) and also runs
`sync_skill.py --check`. Run it before `clasp push`; add a rule whenever you collapse a new duplicate.

`MCO_RULES` is the one place holding 25,000 impressions / 7 days / 5% spend share / 10% selection
probability / 6 throttle slots / 46.5% overlap. It flows to **all three** consumers: the Claude system
prompt (`mcoRulesPromptBlock()` appends it as authoritative), the client-side offline fallback
(`localMcoDiagnosis` reads `mcoRules()` and bails out with `insufficient_data` if config hasn't
arrived), and any server-side logic. Changing a threshold is a one-line edit.

## Video vs Non-video — a function of the format name, never of `is_video_creative`

`isVideoFmt(c)` in `Dashboard.html` is the one definition: a creative is **Video iff its MCO
Inventory Group name is a VAST format** — the same group name the "Creative Performance by Format"
table rows on, so the two sections cannot disagree. `native-video` maps to `Native VAST` and counts as
video; HTML interstitials, banners, `native-static` and `mrect` do not. All three surfaces call it —
the Video vs Non-video chart/table/prose, the creative table's **Video** quick-filter, and the
per-creative **Video** tag.

`analytics.daily_attr_event_d7.is_video_creative`, which those surfaces used to read, is **not
trusted**. Measured over one baked day (2026-08-17):

- ~3,900 creatives carrying $200K+ of spend sat on VAST formats with the flag `'false'`; a few
  hundred non-VAST creatives had `'true'`; some rows carry a third value, `'UNMATCHED'`, which the
  old ternary silently filed under Non-video.
- Per campaign the gap is decisive, not marginal: **82323** — 40 of 80 creatives on VAST formats,
  flag says **0** are video. **38469** — 10 VAST creatives, flag says 1.
- The flag is also unstable *per creative*: 38 of 91,634 creatives carried two different values
  inside a single day, and because `is_video` is one of the 17 perf `GROUP BY` dimensions, the
  surviving row keeps whichever value `combinePerfChunks_` collapsed first.

`check_single_source.py` fails on any `c.is_video` read in `Dashboard.html`, and
`render_smoke_test.js` pins the demo split (cpr 11/7, cpa 9/6) — the demo fixtures carry no
`is_video` field at all, so the old rule filed *every* demo creative under Non-video and drew a
plausible-looking chart that was entirely wrong. The field still flows from the server; nothing
renders from it.

## Creative state — three states, read from the queue PDT

**Authoritative, never derived.** `MCO_RULES.creative_states` holds the definition; the three SQL
builders implement exactly these predicates over `looker.*queue_creative_statistics` (dated PDT —
resolve via `getQueuePDT()`), joined on `creative_id`, creative and campaign both `state='enabled'`:

| state | predicate | meaning |
|---|---|---|
| `queuing` | `queue_eligible` AND NOT `optimizing` AND `current_status='excluded'` | in the throttle waiting room, not being served |
| `exploring` | `queue_eligible` AND NOT `optimizing` AND `current_status='included'` | being served via WCS, pre-calibration |
| `optimizing` | NOT `queue_eligible` AND `is_currently_optimizing` | calibrated, competing on ITI, Auto-Pauser-eligible |

They are **mutually exclusive** — queuing vs exploring is *only* `current_status`. `lifecycle_state`
therefore carries all three; `is_queuing` remains only as an alias. Before this was written down,
queuing was collapsed into `'exploring'` with `is_queuing` as a side flag, so a queuing creative
matched both the queuing and the exploring filter and **counted twice** in the pipeline totals.

**The queue is invisible to activity-driven queries.** A `queuing` creative is `current_status =
'excluded'` — not being served — so it has no rows in `analytics.daily_attr_event_d7`, and *both* the
perf query and the misleadingly-named "inventory" query are driven by that table over the lookback
window. Verified on campaign 41535: 16 queuing, only 3 with any analytics data. `fetchCreativeData`
therefore **appends a metric-less row** for each queued creative missing from `creativePerf`
(`is_metricless: true`, spend/revenue 0, every rate null) so the table shows *which* creatives are
stuck. Every metric cell in `Dashboard.html` is already `!= null` guarded and falls back to `—`, and
the demo fixtures include one such row so `render_smoke_test.js` keeps that path covered.

The 25K-impressions / 7-days rule is what makes the *platform* flip `is_currently_optimizing` — not
a definition to recompute. `mcoLifecycleStateProxy()` is the only place that guesses from
impressions + age; it runs solely when the PDT returned no state for an active creative, and it can
never return `queuing`. A creative missing from the PDT (e.g. paused) has **no** state.

## Where Claude's intelligence sits

Two backend features, both going through **one** helper — `callClaudeJson_()` — which does the
`UrlFetchApp` call, prompt caching, structured-output validation, and error reporting:

| Function | Purpose | Output shape (enforced by JSON Schema) |
|---|---|---|
| `diagnoseMcoCreative` | per creative: why it is in this state | `{diagnosis, format, explanation, supporting_evidence[], suggested_actions[], confidence}` — `diagnosis` enum is generated from `MCO_RULES.diagnosis_codes` |
| `summarizeFormatTrends` | format-level trend narrative | `{summary, format_insights[{format, trend, insight}], recommendation}` |

Model and request shape (`CLAUDE_MODEL` / `CLAUDE_MAX_TOKENS` at the top of the AI section):

- **`claude-sonnet-5`.** Adaptive thinking is **on when `thinking` is omitted** (Sonnet 4.x ran
  thinking-off) and `max_tokens` caps thinking **+** response together — the old `max_tokens: 1024`
  would truncate the JSON on this model. Hence 4096.
- **Structured outputs** (`output_config.format` + JSON Schema) guarantee schema-valid JSON, so there
  is no ```` ```json ```` fence to strip and `JSON.parse` can't fail on a preamble.
- **`output_config.effort`**: `low` for the per-creative diagnosis (high volume, tight rules),
  `medium` for the trend summary. This is the cost/latency dial.
- **Prompt caching** (`cache_control: ephemeral` on the system block): the skill is ~3K tokens and
  identical on every call, so cache reads cost ~10% of input. Watch `cache_read_input_tokens` in the
  execution log — the per-creative prefetch fires several calls at once, and concurrent requests can't
  read a cache entry that is still being written, so the first burst pays full price.
- `stop_reason` is checked: `refusal` and `max_tokens` raise distinct errors instead of surfacing as a
  generic "unavailable".

The system prompt is `getSkillContent()` = `MCO_SKILL` + `mcoRulesPromptBlock()` +
`metricsPromptBlock()` — so every number and every "lower is better" the model sees is *rendered from*
the same objects the client reads. **`MCO_SKILL` is generated** from
`skills/mco-creative-explainer/SKILL.md` by `python3 tools/sync_skill.py` (which also warns if a
`MCO_RULES` number no longer appears in the prose). Runtime Drive loading is **gone** — Script
Properties `SKILL_FILE_ID` / `KB_FILE_ID` are unused and can be deleted. Editing the skill = edit the
`.md`, run the sync script, `clasp push -f`.

The repo `SKILL.md` was verified byte-identical to the Drive original on 2026-07-27 (that Drive file
*is* the merged skill + knowledge base — there was only ever one document). It has since diverged by
one deliberate correction, recorded in the file's provenance header.

Deterministic fallbacks in the front end reimplement the same reasoning in plain JS for when the API
is unavailable: `localMcoDiagnosis`, `localFormatSummary`, `localVideoSummary`,
`localInteractiveSummary`. They read thresholds from `mcoRules()` — no rule numbers are hardcoded
there any more.

Non-AI analysis is `analyzeCreativePerformance` (`Code.js:2540`) + `_generateRecommendations`
(`Code.js:2814`): spend-weighted (ratio-of-sums) primary metric, SOW concentration, freshness,
`THRESHOLDS` at `Code.js:47`. The primary metric depends on campaign type
(`ua_cpi` / `ua_cpa` / `ua_cpr` / `re`).

## Re-architecture backlog

**Done (2026-07-27):**

1. ~~Quadruple-maintained MCO knowledge~~ — one source: `SKILL.md` → generated `MCO_SKILL`;
   thresholds in `MCO_RULES` reach the prompt and the client fallback from there. Drive read removed.
2. ~~Triple-maintained inventory-group mapping~~ (plus a fourth copy: the group list `ALL_DN`) — now
   `MCO_GROUP_MAP_GS` / `KEY_FORMATS` only, via `getConfig()`.
3. ~~Duplicated Claude call plumbing~~ — one `callClaudeJson_()`; model on `claude-sonnet-5` with
   structured outputs, prompt caching, effort, and real error messages.
4. ~~Looker `CLIENT_ID` hardcoded in source~~ — now `LOOKER_CLIENT_ID` in Script Properties, with a
   clear error when either half is missing. **Set that property before deploying.**

**Open — confirm before acting, and record the outcome in `LEARNINGS.d/`:**

5. **Monolith** — `Code.js` is merged `Config.gs` + `Analysis.gs` + fetchers + SQL builders + AI;
   `Dashboard.html` is one file of inline CSS + JS + markup. No modules, no build step, no tests.
6. **No contract between backend and front end.** `analyzeCreativePerformance` drops fields that
   `fetchCreativeData` then patches back onto `result.creativePerf` (comment: *"Fields Analysis.gs
   drops — patch them back in"*). A typed result shape would delete that whole block.
7. **GAS platform ceilings** — 6 min/execution, 30 s per `UrlFetch`. Sequential slug creation in
   `runSQLParallel` scales with the number of queries; batch 2 already issues 10.
8. **Stale version markers** — header says `v6`; other comments say `v7`.
9. **`getConfig()` is fetched async at page load.** Anything rule-bearing that could run before it
   returns must handle `mcoRules() === null` (as `localMcoDiagnosis` does). If more of the UI starts
   depending on `CFG`, consider gating the first render on it instead.
10. **`node --check` is not a test.** v132 shipped a `TypeError` (`R._metricLabel is not a function`,
    from a blind string replace that matched mid-identifier) which parsed fine and killed the page
    after the campaign summary — a thrown error mid-render leaves the rest of the DOM unwritten.
    `node tools/render_smoke_test.js` exercises the render chain on demo data with `CFG` empty
    (worst case) and catches this class. Run it before every push. Never patch a minified line with
    a blind `str.replace` — print the result and re-run the smoke test.

---

# Part 2 — Base capabilities of this repo

## 1. Talking to Claude Code — the MCP data layer

`creative-mcp` (`creative_mcp.py`) exposes three tools; restart the MCP server after editing the file.

- `set_session(label)` — tag query logs (`logs/mcp_queries.jsonl`)
- `list_trino_connections()` — confirm `accelerate_trino` is reachable
- `run_trino(sql)` — run ONE Trino statement, return JSON rows

**The verification loop — use it for every data change:** take the SQL the dashboard actually sends
(a `build*SQL()` function in `Code.js`), run it through `run_trino`, inspect real rows and column
names, iterate here, *then* edit `Code.js` and push. Never infer a column name from `Code.js` alone —
the PDT and `cstudio` tables drift.

### Looker SDK gotchas (hard-won — keep verbatim)

- Instance `liftoff.cloud.looker.com`; `auth/looker.ini` has **no scheme** — code prepends `https://`
  (`_init_looker`).
- **Do NOT use raw `requests` from Python** — `/api/4.0/login` returns 200 but the token is rejected
  401 on every subsequent endpoint. Only the official `looker-sdk` works. (Apps Script's
  `UrlFetchApp` path in `Code.js` is fine — different client, works as written.)
- **Python 3.14 + cattrs:** `run_*` raises `StructureHandlerNotFoundError`. Patch `converter40`
  before `init40()` (done in `_init_looker`):
  ```python
  import typing
  from looker_sdk.rtl import serialize as _ser
  for _t in [str | bytes, typing.Union[str, bytes]]:
      try:
          _ser.converter40.register_structure_hook(_t, lambda v, _: v)
      except Exception:
          pass
  ```
- Mint your OWN Looker API3 keys (Looker → your user → Edit → API3 Keys → New). Never reuse anyone
  else's. `auth/looker.ini` is gitignored.
- **SQL Runner runs ONE statement.** Splitting a multi-statement file on `;` truncates the query when
  a `;` appears inside an inline comment — split on the `WITH`/`SELECT` boundary instead.
- `run_sql_query(result_format="json")` returns a **JSON string** — parse it (`_run_trino` does).
- Other Trino connections exist (`vungle_trino`, …); `accelerate_trino` is the analytics one.
- No `pip` in the venv — install with
  `uv pip install <pkg> --python ./python-virtual-environment/bin/python3`.

## 2. Learning — `LEARNINGS.d/`

Each session appends distilled **Finding / Shift / Watch** entries to its **own** file
`LEARNINGS.d/<session-id>.md` (per-session files avoid the concurrent-write race — never edit another
session's file). See `LEARNINGS.d/README.md` for the entry shape. Capture wisdom, not transcript: what
was learned, what changed in what we trust, what to watch next. Supersede old entries by annotating
them, not deleting. Anything discovered about the GAS app or the Trino tables that is *not* obvious
from the code belongs here.

## 3. Shipping — git and deployment

- Repo: `https://github.com/Sherinelai/Creative-Performance-Analyser.git`. Commit under this repo's
  own `git config --local user.*`.
- **Commit when there are changes.** Small single-purpose commits at every checkpoint (a working
  state, a completed sub-task, a verified file): `git add <specific files>` (never `-A`/`.`), commit,
  `git pull --rebase origin main`, push. Linear history, never force-push. Files outside the current
  checkpoint's scope: ask, don't fold them in.
- End commit messages with the `Co-Authored-By: Claude …` trailer.
- **Deploying the app:** from `appscript/`, `clasp push -f`. In non-interactive shells `clasp push`
  can print `Skipping push.` and upload nothing — always `-f`, and treat a push that does not list the
  changed files as a failure. `clasp push` only updates the HEAD version: **redeploy the `/exec`
  deployment afterwards or production keeps serving old code** (`clasp create-deployment`, or the
  editor UI). The web app is `executeAs: USER_DEPLOYING`, `access: DOMAIN`.
- Order of operations after changing `appscript/`: summarize → commit → push → `clasp push -f` →
  redeploy → verify in the browser.

## 4. Hooks

Git-tracked in `.claude/settings.json` (need `jq` on PATH; no-op silently without it):

1. **GAS pre-push checklist** (PreToolUse on Bash) — on a `clasp push` when `Code.js`/`Dashboard.html`
   changed in the last commit, injects `.claude/gas-push-checklist.txt` (deploy steps, the
   change-all-of-them consistency list, secrets rule).
2. **LEARNINGS capture** (Stop) — once the transcript has grown ≥150KB and ≥30 min since the last
   fire, prompts appending a distilled entry to your own `LEARNINGS.d/<session-id>.md`, plus a git
   commit-checkpoint nudge (`.claude/git-commit-checkpoint-prompt.txt`).

## 5. Secrets

Never commit credentials. Script Properties hold everything credential-shaped —
`LOOKER_CLIENT_ID`, `LOOKER_CLIENT_SECRET`, `CLAUDE_API_KEY` — and must stay out of `appscript/`.
(`SKILL_FILE_ID` / `KB_FILE_ID` are obsolete since the skill is compiled into `Code.js`.)
`auth/`, `google-api-credentials.json` and `logs/` are gitignored. If you find a credential in
tracked source, treat removing it as part of the task.
