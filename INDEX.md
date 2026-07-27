# Creative Performance Analyser — project map

Bootstrapped from `tiktok-dashboard`, reusing its Looker/Trino access layer + Claude Code setup.

## Where everything lives

| Area | Path | Notes |
|---|---|---|
| Project instructions / gotchas | `CLAUDE.md` | Looker + Trino + GAS rules (load-bearing, inherited) |
| MCP server | `creative_mcp.py` | Looker init, Trino runner, creative-SQL builder |
| MCP registration | `.mcp.json` | `creative-mcp` → project venv |
| Auth (gitignored) | `auth/` + `google-api-credentials.json` | looker.ini, service account, token caches |
| Trino cuts | `trino-migration/sql/` | `get_re_creatives.sql`, `get_re_campaign_perf.sql` |
| Trino validation | `trino-migration/validation-ledger.md` | field mappings + how to re-validate |
| Creative finder skill | `skills/poor-performing-creatives/` | the DNU-CPI workhorse (BQ + Looker + gspread) |
| GAS dashboard | `appscript-creative/` | `Code.js`, `dashboard.html` |
| Session learnings | `LEARNINGS.d/` | per-session `<id>.md` files |
| Venv (gitignored) | `python-virtual-environment/` | Python 3.14.3, uv-managed |

## Quick start (new machine)

1. `bash install.sh` — creates the venv and installs deps.
2. Put your own `auth/looker.ini` (mint your own Looker API3 keys) + Google creds in `auth/`.
3. Sanity check: `./python-virtual-environment/bin/python3 -c "import creative_mcp as m; print(m.list_trino_connections())"`
4. The `creative-mcp` MCP server auto-registers via `.mcp.json` in Claude Code.

## The main task — find poor-performing creatives

Read `skills/poor-performing-creatives/SKILL.md`. Android = pure BigQuery; iOS = Looker GR ÷ BQ DNU.
