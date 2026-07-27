"""
Creative Performance Analyser — MCP Server

The one job of this file: give Claude Code the SAME data access the Apps Script dashboard
(appscript/) has, so a query can be verified here before it is written into Code.js.

The Looker API creds in auth/looker.ini reach a Trino connection literally named
`accelerate_trino` — the same connection `runSQL()` / `runSQLParallel()` in appscript/Code.js post to
via /api/4.0/sql_queries, and the same data as the claude.ai-hosted "Accelerate Trino" connector.
So every SQL builder in the dashboard can be run and diffed from here, with no connector.

Tools:
  set_session(label)        — tag this analysis session in logs/mcp_queries.jsonl
  list_trino_connections()  — sanity check: which Trino connections the creds reach
  run_trino(sql)            — run ONE Trino statement via Looker SQL Runner, return JSON rows

Typical loop when re-architecting a dashboard query:
  1. Pull the SQL the dashboard sends — e.g. `buildCreativeLevelPerfSQL()` in appscript/Code.js.
  2. run_trino(that_sql) here; inspect the real rows and column names.
  3. Change the SQL here until it is right, THEN edit Code.js and `clasp push -f`.
Never guess a column name from Code.js alone — the PDT and cstudio tables drift.

Tables the dashboard depends on (all reachable from run_trino):
  pinpoint.public.*                     campaigns, creatives, creative_events,
                                        creative_state_events, creative_selection_configurations, apps
  hive.bi.cstudio_analytics_daily_v1    MCO status + optimization_state + creative daily metrics
  analytics.daily / trimmed_daily       spend / revenue / installs
  analytics.daily_attr_event_d7         target-event attribution (RPA)
  looker.*cstudio__creative_format*     PDT, name is dated — auto-discover it the way getPDT() does:
                                        SHOW TABLES FROM looker LIKE '%cstudio__creative_format%'

Looker gotchas (hard-won, keep them):
  - looker.ini has NO scheme — prepend https:// in code (done in _init_looker).
  - Do NOT use raw `requests` against /api/4.0/login: it returns 200 but the token 401s everywhere
    after. Only the official looker-sdk works from Python. (Apps Script's UrlFetchApp is fine —
    that path is what getAccessToken() in Code.js uses.)
  - Python 3.14 + cattrs: patch converter40 before init40() or run_* raises StructureHandlerNotFound.
  - SQL Runner runs ONE statement. For a multi-statement file, split on the WITH/SELECT boundary,
    NOT on ';' (a ';' inside an inline comment truncates the statement).

To run:
  bash install.sh          # creates the venv + installs deps
  python creative_mcp.py   # or let .mcp.json start it inside Claude Code
"""

import json
import logging
import os
import typing
from datetime import datetime
from pathlib import Path

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("creative-mcp")

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent
LOOKER_INI = ROOT / "auth" / "looker.ini"

# ── Constants ─────────────────────────────────────────────────────────────────
# Same connection name as SQL_CONN in appscript/Code.js — keep the two in sync.
TRINO_CONNECTION = "accelerate_trino"

# ── Query logging ─────────────────────────────────────────────────────────────
LOG_DIR = ROOT / "logs"
LOG_DIR.mkdir(exist_ok=True)

_qlog = logging.getLogger("creative_mcp.queries")
_qlog.setLevel(logging.INFO)
_fh = logging.FileHandler(LOG_DIR / "mcp_queries.jsonl", encoding="utf-8")
_fh.setFormatter(logging.Formatter("%(message)s"))
_qlog.addHandler(_fh)
_qlog.propagate = False

RUN_ID = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
_session_label: str = ""


def _log_query(tool: str, meta: dict, rows_returned: int, duration_s: float) -> None:
    entry = {
        "ts": datetime.utcnow().isoformat(timespec="seconds"),
        "run_id": RUN_ID,
        "session": _session_label,
        "tool": tool,
        "rows_returned": rows_returned,
        "duration_s": round(duration_s, 1),
        **meta,
    }
    _qlog.info(json.dumps(entry))


# ── Looker SDK init ───────────────────────────────────────────────────────────

def _init_looker():
    """Initialise the Looker SDK from auth/looker.ini.

    Prepends https:// to the base_url (the ini has no scheme) and applies the
    Python 3.14 + cattrs compatibility patch before init40().
    """
    import configparser
    import looker_sdk
    from looker_sdk.rtl import serialize as _ser

    cfg = configparser.ConfigParser()
    cfg.read(str(LOOKER_INI))
    section_name = next((s for s in cfg.sections() if s.lower() == "looker"), None)
    if section_name is None:
        raise KeyError(
            f"No [looker]/[Looker] section in {LOOKER_INI} (found: {cfg.sections()})"
        )
    section = cfg[section_name]

    os.environ["LOOKERSDK_BASE_URL"] = "https://" + section["base_url"].strip()
    os.environ["LOOKERSDK_CLIENT_ID"] = section["client_id"].strip()
    os.environ["LOOKERSDK_CLIENT_SECRET"] = section["client_secret"].strip()
    os.environ["LOOKERSDK_VERIFY_SSL"] = "true"

    # cattrs patch for Python 3.14 compatibility (str | bytes structure hook)
    for _t in [str | bytes, typing.Union[str, bytes]]:
        try:
            _ser.converter40.register_structure_hook(_t, lambda v, _: v)
        except Exception:
            pass

    return looker_sdk.init40()


# ── Trino via Looker SQL Runner ─────────────────────────────────────────────────

def _run_trino(sql: str) -> list[dict]:
    """Run ONE Trino statement on `accelerate_trino` via the Looker SQL Runner API.

    Returns the parsed rows list. run_sql_query returns a JSON string — parse it here.
    This is the programmatic sibling of the manual Accelerate Trino connector path.
    """
    from looker_sdk import models40 as md

    sdk = _init_looker()
    q = sdk.create_sql_query(body=md.SqlQueryCreate(connection_name=TRINO_CONNECTION, sql=sql))
    raw = sdk.run_sql_query(slug=q.slug, result_format="json")
    rows = raw if isinstance(raw, list) else json.loads(raw)
    return rows


# ── Tools ───────────────────────────────────────────────────────────────────────

@mcp.tool()
def set_session(label: str) -> str:
    """Tag this analysis session so query logs (logs/mcp_queries.jsonl) are attributable.

    Args:
        label: short human label, e.g. "SA-creative-audit-2026-07-27".
    """
    global _session_label
    _session_label = label.strip()
    return f"session label set to {_session_label!r} (run_id {RUN_ID})"


@mcp.tool()
def list_trino_connections() -> str:
    """Sanity check: list the connections these Looker creds reach.

    Confirms `accelerate_trino` is present before running a cut. Use once on a new machine
    or when a query unexpectedly errors on connection.
    """
    sdk = _init_looker()
    names = [c.name for c in sdk.all_connections()]
    trino = [n for n in names if n and "trino" in n.lower()]
    return json.dumps(
        {"accelerate_trino_present": TRINO_CONNECTION in names,
         "trino_connections": trino, "all_count": len(names)},
        indent=2,
    )


@mcp.tool()
def run_trino(sql: str) -> str:
    """Run ONE Trino statement on `accelerate_trino` and return the rows as JSON.

    Use to verify or iterate on any SQL the dashboard sends (the build*SQL() functions in
    appscript/Code.js), or for ad-hoc creative-grain investigation.
    SQL Runner runs a SINGLE statement — do not pass a multi-statement script.

    Args:
        sql: one Trino SQL statement. A leading comment block is fine.

    Returns a JSON string: {"rows": [...], "row_count": N}.
    """
    import time
    t0 = time.time()
    rows = _run_trino(sql)
    dt = time.time() - t0
    _log_query("run_trino", {"sql_head": sql.strip().splitlines()[0][:120] if sql.strip() else ""},
               len(rows), dt)
    return json.dumps({"rows": rows, "row_count": len(rows)}, default=str)


if __name__ == "__main__":
    mcp.run()
