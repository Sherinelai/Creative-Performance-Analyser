# Project: creative-performance-analyser

> **What this is:** A TikTok creative-performance analysis workspace, bootstrapped from the
> `tiktok-dashboard` project's infrastructure. It reuses that project's **Looker/Trino access layer**
> (same `auth/looker.ini`, same `accelerate_trino` connection), its **Claude Code setup** (hooks,
> LEARNINGS capture, conventions), and its **creative-analysis assets** (the poor-performing-creatives
> skill, the `appscript-creative` GAS dashboard, the creative Trino cut).
>
> **Core capability:** rank creatives by **DNU CPI** (gross revenue ÷ client DNU) and grade
> GOOD/WATCH/POOR vs region KPIs. Android = pure BigQuery (`spend` == Looker GR, validated
> penny-exact); iOS = Looker GR ÷ BigQuery DNU. The workhorse is
> `skills/poor-performing-creatives/` — read its `SKILL.md` first for any creative task.
>
> **What's reused vs fresh:** the Looker init + Trino runner (`creative_mcp.py`) are re-implemented
> from `tt_re_mcp.py`; the skill + dashboard + `get_re_creatives.sql` are copied from tiktok-dashboard.
> The Looker gotchas below are load-bearing and were hard-won in the parent project — keep them.

## Layout

- `creative_mcp.py` — MCP server: Looker init + Trino SQL Runner + creative-SQL builder (see below)
- `.mcp.json` — registers `creative-mcp` against the project venv
- `auth/` — `looker.ini` + Google tokens/service account (all **gitignored**, never commit)
- `trino-migration/sql/` — validated Trino cuts (`get_re_creatives.sql`, `get_re_campaign_perf.sql`);
  `validation-ledger.md` documents field mappings + how to re-validate a cut
- `skills/poor-performing-creatives/` — the creative DNU-CPI finder (BQ + Looker + gspread)
- `appscript-creative/` — the GAS creative dashboard (`Code.js`, `dashboard.html`)
- `LEARNINGS.d/` — per-session learnings log (each session appends to its OWN `<session-id>.md`)
- `python-virtual-environment/` — project venv (Python 3.14.3, uv-managed; gitignored)

## MCP server — `creative-mcp`

Tools (see docstrings in `creative_mcp.py`):
- `set_session(label)` — tag query logs
- `list_trino_connections()` — confirm `accelerate_trino` is reachable
- `build_creative_sql(campaign_ids, geo, start_dt, end_dt, top_n, campaign_type)` — fill the creative
  cut's params, ready to run. `campaign_type` defaults to `'reengagement'`; set `'user_acquisition'` for UA.
- `run_trino(sql)` — run ONE Trino statement on `accelerate_trino`, return JSON rows

Restart the MCP server after editing `creative_mcp.py`.

## Authentication — Rules & Gotchas (inherited from tiktok-dashboard — keep verbatim)

### Looker SDK (`looker-sdk`)
- Instance: `liftoff.cloud.looker.com`; `auth/looker.ini` has **no scheme** — code prepends `https://`
  (see `_init_looker` in `creative_mcp.py`).
- **Do NOT use raw `requests`** — `/api/4.0/login` returns 200 but the token is rejected 401 on every
  subsequent endpoint. Only the official `looker-sdk` works.
- **Python 3.14 + cattrs incompatibility:** `run_*` raises `StructureHandlerNotFoundError`. Fixed by
  patching `converter40` before `init40()` (done in `_init_looker`):
  ```python
  import typing
  from looker_sdk.rtl import serialize as _ser
  for _t in [str | bytes, typing.Union[str, bytes]]:
      try:
          _ser.converter40.register_structure_hook(_t, lambda v, _: v)
      except Exception:
          pass
  ```
- Mint your OWN Looker API3 keys (Looker → your user → Edit → API3 Keys → New). Do not reuse anyone
  else's. `auth/looker.ini` is gitignored.

### Trino via Looker SQL Runner (`accelerate_trino`)
The Looker creds reach a Trino connection named **`accelerate_trino`** — the same data as the
claude.ai-hosted "Accelerate Trino" connector. So cuts run in code, no connector needed:
```python
import creative_mcp as m
rows = m._run_trino(SQL)          # returns parsed list[dict]
# or via the tool: m.run_trino(SQL) -> JSON string
```
- **SQL Runner runs ONE statement.** For a multi-statement file split on the `WITH`/`SELECT`
  boundary, **not on `;`** — a `;` inside an inline comment truncates the statement mid-query.
- `run_sql_query(result_format="json")` returns a **JSON string** — parse it (helper does this).
- Other trino connections exist (`vungle_trino`, …) — `accelerate_trino` is the RE/analytics one.
  `list_trino_connections()` lists them.

### BigQuery / gspread (used by the creative skill)
- BQ = client-truth DNU; gspread reads KPIs and writes result tabs. Creds live in `auth/`
  (`service_account.json`, token caches) and `google-api-credentials.json` — all gitignored.
- No `pip` in the venv — install with `uv pip install <pkg> --python ./python-virtual-environment/bin/python3`.

### Creative CPI — the two numerator paths (from the skill; validated 2026-07-24)
- **Android → pure BigQuery.** At (creative_id × campaign × date), `android_creative.spend` == Looker
  gross revenue penny-exact. Android GR = `SUM(spend)` — one query, no Looker.
- **iOS → Looker GR ÷ BQ DNU.** `ios_creative` has no `spend`; `rebate_cost的日均` is NOT a GR proxy
  (collapses to ~$0 on SKAN dc-new). Pull iOS GR from Looker/Trino, divide by BQ client-truth DNU.
- The `spend`==GR identity is **Android-specific** — never use it on iOS.

## GAS Dashboard (`appscript-creative/`)

The creative dashboard. All the GAS template-literal escape gotchas from tiktok-dashboard apply
(`\'` → `'`, `${...}` evaluated inside comments, etc.). Deploy with `clasp push -f` from
`appscript-creative/`. The `.claude/` PreToolUse hook injects an escape-check reminder before a
`clasp push` when `Code.js`/`dashboard.html` changed in the last commit.

## Claude Code Hooks

Live in git-tracked `.claude/settings.json` (depend on `jq` on PATH; no-op silently without it):
1. **GAS escape check** (PreToolUse on Bash) — on `clasp push` when the dashboard changed, injects
   `.claude/gas-escape-reminder.txt`.
2. **LEARNINGS capture** (Stop) — after the transcript grows ≥150KB and ≥30min since last fire,
   prompts appending a distilled entry to **your own** `LEARNINGS.d/<session-id>.md` (per-session
   files avoid the concurrent-write race).

## Git

- Own repo: `https://github.com/Sherinelai/Creative-Performance-Analyser.git`.
- Commit under your own GitHub identity (this repo's `git config --local user.*`), not anyone else's.
- Small single-purpose commits; `git pull --rebase` before push (linear history). End commit messages
  with the `Co-Authored-By: Claude …` trailer.

## Deployment Workflow

After changes to `appscript-creative/`: (1) summarize, (2) `git commit`, (3) `git push`,
(4) `clasp push -f` from `appscript-creative/`. In non-interactive shells `clasp push` can print
`Skipping push.` and upload nothing — always use `-f` and treat a push that doesn't list the changed
files as a failure.
