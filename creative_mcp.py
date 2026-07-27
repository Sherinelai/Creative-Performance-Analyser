"""
Creative Performance Analyser — MCP Server

Reuses the tiktok-dashboard Looker/Trino access layer, tailored to creative-grain analysis.

The Looker API creds in auth/looker.ini reach a Trino connection literally named
`accelerate_trino` — the SAME data as the claude.ai-hosted "Accelerate Trino" connector. So
creative Trino cuts can be BUILT and RUN in code here, without the claude.ai connector.

Tools:
  set_session(label)                 — tag this analysis session in query logs
  list_trino_connections()           — sanity check: which Trino connections the creds reach
  build_creative_sql(...)            — fill trino-migration/sql/get_re_creatives.sql params, ready to run
  run_trino(sql)                     — run ONE Trino statement via Looker SQL Runner, return JSON rows

Primary UA creative workflow (Android = pure BigQuery, iOS = Looker GR ÷ BQ DNU) lives in
skills/poor-performing-creatives/ — see that SKILL.md. This server serves the Trino access layer
those cuts and any ad-hoc creative investigation depend on.

Source of truth:
  Trino (hive.analytics.daily):  creative-grain gross revenue / events / rpa (Looker SQL Runner)
  BigQuery:                      client-truth DNU (see the skill)

Looker gotchas (from tiktok-dashboard/CLAUDE.md — preserved here):
  - looker.ini has NO scheme — prepend https:// in code (done in _init_looker).
  - Python 3.14 + cattrs: patch converter40 before init40() or run_* raises StructureHandlerNotFound.
  - SQL Runner runs ONE statement. For a multi-statement file, split on the WITH/SELECT boundary,
    NOT on ';' (a ';' inside an inline comment truncates the statement).

To run:
  uv pip install mcp looker-sdk gspread google-auth google-auth-oauthlib google-cloud-bigquery \
      db-dtypes pandas --python ./python-virtual-environment/bin/python3
  python creative_mcp.py
"""

import json
import logging
import os
import typing
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("creative-mcp")

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent
LOOKER_INI = ROOT / "auth" / "looker.ini"
CREATIVES_SQL = ROOT / "trino-migration" / "sql" / "get_re_creatives.sql"

# ── Constants ─────────────────────────────────────────────────────────────────
CUSTOMER_ID = "968"                    # TikTok on the Liftoff side
TRINO_CONNECTION = "accelerate_trino"  # the RE/analytics Trino connection reached by these creds

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
def build_creative_sql(
    campaign_ids: list,
    geo: Optional[str] = None,
    start_dt: Optional[str] = None,
    end_dt: Optional[str] = None,
    top_n: int = 20,
    campaign_type: str = "reengagement",
) -> str:
    """Build the creative-grain performance SQL (from trino-migration/sql/get_re_creatives.sql),
    params pre-filled, ready to run via run_trino() or the Accelerate Trino connector.

    Returns creative_id + config dims (type/size/language/interactive/video_length) + gross
    revenue (advertiser cost, NOT spend), target_events, and rpa (revenue ÷ events), top_n by GR.

    EVENT BASIS: default target_events, no custom_event_name filter (filtering zeroes revenue).
    Always state the basis when reporting. `creative_name` is not in `daily` — creative_id is the key.

    Args:
        campaign_ids: list of campaign IDs (numeric strings or ints). Required.
        geo: ISO country, e.g. "SA". Recommended — drops $0 cross-geo bid noise. None → all geos
             (the `AND country = :geo` line is dropped).
        start_dt / end_dt: full literals "YYYY-MM-DDT00:00:00Z"; end EXCLUSIVE; complete days only.
             Defaults: end = today(UTC)-2d at 00:00Z (warehouse lags ~2d), start = end - 7d.
        top_n: creatives ranked by full-window GR (default 20).
        campaign_type: 'reengagement' (RE, default) or 'user_acquisition' (UA). The seeded SQL is
             RE-validated; for UA set this — the query shape is identical.

    Returns the ready-to-run single SQL statement as text.
    """
    def _fmt(d: datetime) -> str:
        return d.strftime("%Y-%m-%dT00:00:00Z")

    if end_dt:
        end = datetime.strptime(end_dt[:10], "%Y-%m-%d")
    else:
        end = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=2)
    if start_dt:
        start = datetime.strptime(start_dt[:10], "%Y-%m-%d")
    else:
        start = end - timedelta(days=7)

    ids = ",".join(str(c).strip() for c in campaign_ids if str(c).strip())
    if not ids:
        raise ValueError("campaign_ids is required and must be non-empty")

    sql = CREATIVES_SQL.read_text(encoding="utf-8")
    if geo:
        sql = sql.replace(":geo", f"'{geo.upper()}'")
    else:
        sql = "\n".join(line for line in sql.splitlines() if "country = :geo" not in line)
    sql = (
        sql.replace("campaign_type = 'reengagement'", f"campaign_type = '{campaign_type}'")
           .replace(":campaign_ids", ids)
           .replace(":start_dt", f"'{_fmt(start)}'")
           .replace(":end_dt", f"'{_fmt(end)}'")
           .replace(":top_n", str(int(top_n)))
    )

    scope = f"geo={geo.upper()}" if geo else "geo=ALL"
    guide = (
        f"-- Creative performance | {scope} | type={campaign_type} | "
        f"{_fmt(start)} -> {_fmt(end)} (exclusive) | top_n={top_n}\n"
        f"-- BASIS: default target_events (no custom_event_name filter). GR = advertiser cost, not spend.\n"
        f"-- Run via run_trino() (accelerate_trino) or the Accelerate Trino connector.\n\n"
    )
    return guide + sql


@mcp.tool()
def run_trino(sql: str) -> str:
    """Run ONE Trino statement on `accelerate_trino` and return the rows as JSON.

    Use for creative cuts built by build_creative_sql, or any ad-hoc creative-grain query.
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
