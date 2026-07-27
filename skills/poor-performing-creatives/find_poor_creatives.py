"""
find_poor_creatives.py — TikTok UA poor-performing-CREATIVE finder (Android + iOS).

WHAT IT DOES
------------
For every (region, creative) over a trailing COMPLETE-day window, computes the real creative
DNU CPI and grades it GOOD / WATCH / POOR against the region's two CPI KPIs. Writes combined
tabs (All / Poor / Watch / Good, with a `platform` column) to a Google Sheet. Matches the
`appscript-creative` production dashboard's judgment.

    creative DNU CPI = gross revenue  ÷  client DNU        (per region × creative, over the window)

TWO NUMERATOR PATHS — the platforms differ (validated 2026-07-24):
- **Android** → PURE BigQuery. `android_creative.spend` == Looker Gross Revenue (penny-exact, all
  creatives), so GR = `SUM(spend)`. No Looker, no sheet.
- **iOS** → Looker GR ÷ BQ DNU. `ios_creative` has no `spend`; its `rebate_cost的日均` is NOT a GR
  proxy (collapses to ~$0 on SKAN dc_new campaigns, diverges from Looker GR up to ~46,000×). So iOS
  pulls gross revenue from **Looker/Trino** (`hive.analytics.daily`, revenue_micros) and divides by
  BQ `bs_ios_dc_new_user的日均` (client-truth DNU). See GUIDES/ua-context.md → trust matrix.

VERDICT (3-tier, per region KPI; higher CPI = worse):
  cpi_kpi  = 'Performance KPI'      (GOOD cutoff; full, has KR)
  poor_kpi = 'Poor Performance KPI' (POOR cutoff; subset — KR absent → that region has no WATCH band)
  GOOD: cpi<=cpi_kpi | WATCH: cpi_kpi<cpi<=poor_kpi | POOR: cpi>poor_kpi (or >cpi_kpi if no poor_kpi)
  NO_DNU: dnu<1 / cpi=0    NO_KPI: no cpi_kpi for that (app, region)

TIMEFRAME GUARDS: the feishu sync's newest p_date is a PARTIAL day (~40%) — auto-excluded (window
ends at MAX(p_date)-1); numerator (GR) and denominator (DNU) share the same complete-day window.

WHERE IT RUNS
-------------
Colab (google.colab.auth) as-is, or locally with RUN_LOCALLY=True (uses auth/ tokens + looker.ini).
iOS needs Looker: local via tt_re_mcp._init_looker(); Colab via LOOKER_CLIENT_ID/SECRET below.
"""

import re
import time
import pandas as pd
import numpy as np

# ============================================================
# ✨✨✨ CONFIG — 每次要改的參數 ✨✨✨
# ============================================================
RUN_LOCALLY = False   # False = Colab (authenticate_user);  True = 本 repo 的 token 檔
PLATFORM = "both"     # "android"（純 BQ）| "ios"（走 Looker）| "both"

LOOKBACK_DAYS = 7                 # 完整日天數（最新的部分日自動排除）
BQ_BILLING_PROJECT = "tiktok-automation-493206"   # 資料在 feishu-sync-493408；權限錯就改這個

OUTPUT_SPREADSHEET_ID = "1JF4-r-1j7LhdzEb7thraWQpF8OzxYENladTgQZeIrgw"  # 原 notebook 的輸出 book
KPI_SPREADSHEET_ID = "1DiFK3vwK3qi2DJyqU9GJK4WVUZM_8U6X_yebBMCbbkg"
KPI_SHEET_NAME = "Performance KPI"            # cpi_kpi (GOOD 門檻)；完整、有 KR
POOR_KPI_SHEET_NAME = "Poor Performance KPI"  # poor_kpi (POOR 門檻)；子集、缺 KR → 該 region 無 WATCH
APP_MAP_SHEET_NAME = "App Name ID Map"        # android/ios creative.app_id == tiktok_app_id

# iOS 才需要的 Looker 憑證（Android 純 BQ 不需要）。本地會改用 auth/looker.ini（tt_re_mcp）。
# Colab 跑 iOS 時填這兩個（來源同 appscript-creative 的 Script Properties）：
LOOKER_CLIENT_ID = ""
LOOKER_CLIENT_SECRET = ""
LOOKER_BASE_URL = "https://liftoff.cloud.looker.com"
TRINO_CONNECTION = "accelerate_trino"

TARGET_REGIONS = {"US","CA","AU","VN","TH","PH","MY","KR","JP","ID","AE","BR","CL","MX",
                  "SA","TR","ZA","GB","FR","IT","DE"}   # 空集合 = 不限制

_CREATIVE_ID_RE = r'(?i)TikTok[ _.,]+Pte[ _.,]*\.?[ _.,]*Ltd[ _.,]+([0-9]+)'
OUT_COLS = ["platform", "app_name", "region", "creative_id", "gross_revenue", "dnu",
            "dnu_cpi", "cpi_kpi", "poor_kpi", "ltall", "roi2", "verdict"]
# ============================================================


# ==========================================
# 授權 + clients
# ==========================================
from google.cloud import bigquery
import gspread

if RUN_LOCALLY:
    import sys
    from pathlib import Path
    from google.oauth2.credentials import Credentials
    ROOT = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(ROOT))
    bq = bigquery.Client(project=BQ_BILLING_PROJECT,
        credentials=Credentials.from_authorized_user_file(
            str(ROOT / "auth" / "bq-user-token.json"), scopes=["https://www.googleapis.com/auth/bigquery"]))
    gc = gspread.authorize(Credentials.from_authorized_user_file(str(ROOT / "auth" / "gspread-write-token.json")))
else:
    # !pip install -q gspread google-cloud-bigquery db-dtypes looker-sdk
    from google.colab import auth
    from google.auth import default
    auth.authenticate_user()
    creds, _ = default()
    gc = gspread.authorize(creds)
    bq = bigquery.Client(project=BQ_BILLING_PROJECT, credentials=creds)

print("✅ 授權成功")

_SDK = None
def get_looker_sdk():
    """Lazy Looker SDK (iOS only). Local → tt_re_mcp._init_looker(); Colab → env creds."""
    global _SDK
    if _SDK is not None:
        return _SDK
    # py3.14 cattrs shim (harmless elsewhere)
    import typing
    from looker_sdk.rtl import serialize as _ser
    for _t in [str | bytes, typing.Union[str, bytes]]:
        try: _ser.converter40.register_structure_hook(_t, lambda v, _: v)
        except Exception: pass
    if RUN_LOCALLY:
        import tt_re_mcp
        _SDK = tt_re_mcp._init_looker()
    else:
        import os, looker_sdk
        if not LOOKER_CLIENT_ID or not LOOKER_CLIENT_SECRET:
            raise RuntimeError("iOS 需要 Looker 憑證：請在 CONFIG 填 LOOKER_CLIENT_ID / LOOKER_CLIENT_SECRET")
        os.environ["LOOKERSDK_BASE_URL"] = LOOKER_BASE_URL
        os.environ["LOOKERSDK_CLIENT_ID"] = LOOKER_CLIENT_ID
        os.environ["LOOKERSDK_CLIENT_SECRET"] = LOOKER_CLIENT_SECRET
        os.environ["LOOKERSDK_VERIFY_SSL"] = "true"
        _SDK = looker_sdk.init40()
    return _SDK


# ==========================================
# Helpers
# ==========================================
def safe_api(func, *args, **kwargs):
    for attempt in range(5):
        try:
            return func(*args, **kwargs)
        except gspread.exceptions.APIError as e:
            code = getattr(getattr(e, "response", None), "status_code", None)
            if code == 429 or "RESOURCE_EXHAUSTED" in str(e):
                time.sleep(20 + attempt * 15)
            elif code == 500 and attempt < 4:
                time.sleep(10 + attempt * 5)
            else:
                raise
    return func(*args, **kwargs)

def to_num(series):
    return pd.to_numeric(
        series.astype(str).str.replace(",", "", regex=False).str.replace("$", "", regex=False),
        errors="coerce")

def get_or_create_ws(sh, title, rows, cols=len(OUT_COLS) + 2):
    try:
        ws = sh.worksheet(title); safe_api(ws.clear); return ws
    except gspread.exceptions.WorksheetNotFound:
        return safe_api(sh.add_worksheet, title=title, rows=str(rows), cols=str(cols))


# ==========================================
# 1) Per-platform GR + DNU per (region, app_id, creative_id)
# ==========================================
def cpi_android():
    """PURE BQ: spend == Looker GR → SUM(spend)/SUM(DNU). Includes DNU-weighted LTall/ROI2."""
    sql = r"""
    DECLARE lookback_days INT64 DEFAULT @lookback_days;
    WITH bounds AS (
      SELECT DATE_SUB(DATE(MAX(p_date)), INTERVAL 1 DAY) AS end_day
      FROM `feishu-sync-493408.tiktok_data.android_creative` WHERE p_date != 'nan' AND p_date IS NOT NULL
    ),
    win AS (SELECT CAST(DATE_SUB(end_day, INTERVAL lookback_days - 1 DAY) AS STRING) AS start_day,
                   CAST(end_day AS STRING) AS end_day FROM bounds),
    cd AS (
      SELECT UPPER(c.region) AS region, c.app_id,
        REGEXP_EXTRACT(c.ad_name, r'""" + _CREATIVE_ID_RE + r"""') AS creative_id,
        SAFE_CAST(c.spend AS FLOAT64) AS rev_row, SAFE_CAST(c.DNU AS FLOAT64) AS dnu_row,
        SAFE_CAST(c.LTall AS FLOAT64) AS ltall_row, SAFE_CAST(c.ROI2 AS FLOAT64) AS roi2_row
      FROM `feishu-sync-493408.tiktok_data.android_creative` c, win
      WHERE c.p_date >= win.start_day AND c.p_date <= win.end_day AND c.ad_name IS NOT NULL AND c.ad_name != ''
    )
    SELECT region, app_id, creative_id,
      ROUND(SUM(rev_row),2) AS gross_revenue, SUM(dnu_row) AS dnu,
      ROUND(SAFE_DIVIDE(SUM(rev_row), SUM(dnu_row)),4) AS dnu_cpi,
      ROUND(SAFE_DIVIDE(SUM(ltall_row*dnu_row), SUM(IF(ltall_row IS NOT NULL, dnu_row, 0))),2) AS ltall,
      ROUND(SAFE_DIVIDE(SUM(roi2_row*dnu_row),  SUM(IF(roi2_row  IS NOT NULL, dnu_row, 0))),4) AS roi2,
      (SELECT start_day FROM win) AS window_start, (SELECT end_day FROM win) AS window_end
    FROM cd WHERE creative_id IS NOT NULL GROUP BY region, app_id, creative_id
    HAVING SUM(dnu_row) > 0 ORDER BY gross_revenue DESC
    """
    df = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("lookback_days", "INT64", LOOKBACK_DAYS)])).result().to_dataframe()
    win = (df["window_start"].iloc[0], df["window_end"].iloc[0]) if len(df) else ("?", "?")
    return df.drop(columns=["window_start", "window_end"]), win

def cpi_ios():
    """iOS: Looker GR (Trino revenue_micros) ÷ BQ DNU (bs_ios_dc_new_user的日均). No LTall/ROI2 cols."""
    w = list(bq.query("""SELECT
        CAST(DATE_SUB(DATE_SUB(DATE(MAX(p_date)), INTERVAL 1 DAY), INTERVAL @lb DAY) AS STRING) s,
        CAST(DATE_SUB(DATE(MAX(p_date)), INTERVAL 1 DAY) AS STRING) e
      FROM `feishu-sync-493408.tiktok_data.ios_creative` WHERE p_date!='nan' AND p_date IS NOT NULL""",
      job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("lb", "INT64", LOOKBACK_DAYS - 1)])).result())[0]
    start, end = w["s"], w["e"]
    btt = bq.query(f"""SELECT p_date d, campaign_name, ad_name, region, app_id,
        SAFE_CAST(`bs_ios_dc_new_user的日均` AS FLOAT64) dnu
      FROM `feishu-sync-493408.tiktok_data.ios_creative`
      WHERE p_date>='{start}' AND p_date<='{end}' AND ad_name IS NOT NULL AND ad_name!=''""").result().to_dataframe()
    btt["cid"] = btt["ad_name"].str.extract(_CREATIVE_ID_RE)[0]
    btt = btt.dropna(subset=["cid"])
    btt["camp"] = btt["campaign_name"].map(str).str.strip()
    btt["reg"] = btt["region"].map(str).str.upper().str.strip()
    btt["dnu"] = pd.to_numeric(btt["dnu"], errors="coerce").fillna(0)
    b = btt.groupby(["cid", "camp", "d", "reg", "app_id"], as_index=False).agg(dnu=("dnu", "sum"))

    import json
    sdk = get_looker_sdk()
    from looker_sdk import models40 as md
    sql = ("SELECT cast(creative_id as varchar) cid, trim(campaign_name) camp, "
           "substr(cast(dt as varchar),1,10) d, round(sum(revenue_micros)/1e6,4) gr "
           "FROM hive.analytics.daily WHERE customer_id=968 "
           f"AND dt>='{start}T00:00:00Z' AND dt<'{end}T23:59:59Z' GROUP BY 1,2,3")
    q = sdk.create_sql_query(body=md.SqlQueryCreate(connection_name=TRINO_CONNECTION, sql=sql))
    rows = sdk.run_sql_query(slug=q.slug, result_format="json")
    tr = pd.DataFrame(json.loads(rows) if isinstance(rows, str) else rows)

    j = b.merge(tr, on=["cid", "camp", "d"], how="left")
    if len(j):
        print(f"   iOS GR match: {j['gr'].notna().sum()}/{len(j)} ({j['gr'].notna().mean():.0%}) rows")
    j["gr"] = pd.to_numeric(j.get("gr"), errors="coerce").fillna(0)
    agg = j.groupby(["reg", "app_id", "cid"], as_index=False).agg(
        gross_revenue=("gr", "sum"), dnu=("dnu", "sum"))
    agg = agg[agg["dnu"] > 0].rename(columns={"reg": "region", "cid": "creative_id"})
    agg["gross_revenue"] = agg["gross_revenue"].round(2)
    agg["dnu_cpi"] = (agg["gross_revenue"] / agg["dnu"]).round(4)
    agg["ltall"] = np.nan
    agg["roi2"] = np.nan
    return agg.sort_values("gross_revenue", ascending=False), (start, end)


# ==========================================
# 2) KPI + App map (per platform OS) → verdict
# ==========================================
_BOOK = None
def _book():
    global _BOOK
    if _BOOK is None:
        _BOOK = gc.open_by_key(KPI_SPREADSHEET_ID)
    return _BOOK

def read_kpi_tab_(tab, out_col, os_name):
    raw = safe_api(_book().worksheet(tab).get_all_values)
    k = pd.DataFrame(raw[1:], columns=[c.strip() for c in raw[0]])
    k = k[k["OS"].map(str).str.strip().str.lower() == os_name].copy()
    cpi_col = next((c for c in k.columns if "黑天鹅" in c and "CPI" in c.upper()),
                   next((c for c in k.columns if c.strip().lower() == "黑天鹅cpi"), "黑天鹅CPI"))
    k[out_col] = to_num(k[cpi_col])
    k["_app_k"] = k["app name"].map(str).str.strip()
    k["_reg_k"] = k["region"].map(str).str.upper().str.strip()
    return k.dropna(subset=[out_col]).drop_duplicates(["_app_k", "_reg_k"])[["_app_k", "_reg_k", out_col]]

def app_name_map_(os_name):
    amap = safe_api(_book().worksheet(APP_MAP_SHEET_NAME).get_all_values)
    adf = pd.DataFrame(amap[1:], columns=[c.strip() for c in amap[0]])
    adf = adf[adf["os"].map(str).str.strip().str.lower() == os_name]
    m = {}
    for _, r in adf.iterrows():
        tid = str(r["tiktok_app_id"]).strip()
        if tid and tid not in ("", "N/A", "nan"):
            m.setdefault(tid, str(r["liftoff_app_name"]).strip())
    return m

def verdict_(r):
    if pd.isna(r["cpi_kpi"]):                                       return "NO_KPI"
    if r["dnu"] < 1 or r["dnu_cpi"] == 0:                          return "NO_DNU"
    if r["dnu_cpi"] <= r["cpi_kpi"]:                               return "GOOD"
    if pd.notna(r["poor_kpi"]) and r["dnu_cpi"] <= r["poor_kpi"]: return "WATCH"
    return "POOR"

def process_platform(platform):
    os_name = "android" if platform == "android" else "ios"
    print(f"\n=== {platform.upper()} ===")
    df, win = (cpi_android() if platform == "android" else cpi_ios())
    print(f"   {len(df)} creative×region rows | 完整日窗口 {win[0]} ~ {win[1]}  GR=${df['gross_revenue'].sum():,.0f} DNU={df['dnu'].sum():,.0f}")
    tt2name = app_name_map_(os_name)
    df["app_name"] = df["app_id"].map(str).str.strip().map(tt2name)
    df["_app_k"] = df["app_name"].map(lambda x: str(x).strip() if pd.notna(x) else None)
    df["_reg_k"] = df["region"].map(str).str.upper().str.strip()
    if TARGET_REGIONS:
        df = df[df["_reg_k"].isin(TARGET_REGIONS)].copy()
    df = df.merge(read_kpi_tab_(KPI_SHEET_NAME, "cpi_kpi", os_name), on=["_app_k", "_reg_k"], how="left")
    df = df.merge(read_kpi_tab_(POOR_KPI_SHEET_NAME, "poor_kpi", os_name), on=["_app_k", "_reg_k"], how="left")
    df = df.drop(columns=["_app_k", "_reg_k"])
    df["cpi_kpi"] = pd.to_numeric(df["cpi_kpi"], errors="coerce")
    df["poor_kpi"] = pd.to_numeric(df["poor_kpi"], errors="coerce")
    if "ltall" not in df: df["ltall"] = np.nan
    if "roi2" not in df: df["roi2"] = np.nan
    df["platform"] = platform
    df["verdict"] = df.apply(verdict_, axis=1)
    vc = df["verdict"].value_counts().to_dict()
    print(f"   cpi_kpi coverage {df['cpi_kpi'].notna().mean():.0%} | POOR={vc.get('POOR',0)} WATCH={vc.get('WATCH',0)} "
          f"GOOD={vc.get('GOOD',0)} NO_KPI={vc.get('NO_KPI',0)} NO_DNU={vc.get('NO_DNU',0)}")
    return df[OUT_COLS], win


# ==========================================
# 3) Run selected platform(s) + write
# ==========================================
plats = ["android", "ios"] if PLATFORM == "both" else [PLATFORM]
parts, wins = [], {}
for p in plats:
    d, w = process_platform(p)
    parts.append(d); wins[p] = w
df = pd.concat(parts, ignore_index=True).sort_values("gross_revenue", ascending=False)
poor  = df[df["verdict"] == "POOR"].copy()
watch = df[df["verdict"] == "WATCH"].copy()
good  = df[df["verdict"] == "GOOD"].copy()

def write_tab(sh, title, frame):
    ws = get_or_create_ws(sh, title, rows=len(frame) + 10)
    safe_api(ws.update, range_name="A1", values=[OUT_COLS] + frame.fillna("").astype(object).values.tolist())
    safe_api(ws.format, "A1:Z1", {"textFormat": {"bold": True},
             "backgroundColor": {"red": 0.9, "green": 0.9, "blue": 0.9}})
    ci = OUT_COLS.index("dnu_cpi")
    safe_api(sh.batch_update, {"requests": [{"addConditionalFormatRule": {"rule": {
        "ranges": [{"sheetId": ws.id, "startRowIndex": 1, "endRowIndex": len(frame) + 1,
                    "startColumnIndex": ci, "endColumnIndex": ci + 1}],
        "gradientRule": {"minpoint": {"color": {"red": 1, "green": 1, "blue": 1}, "type": "MIN"},
                          "maxpoint": {"color": {"red": 0.9, "green": 0.3, "blue": 0.3}, "type": "MAX"}}},
        "index": 0}}]})
    print(f"   ✅ {title}: {len(frame)} rows")

print("\n📤 寫回輸出 sheet...")
sh_out = gc.open_by_key(OUTPUT_SPREADSHEET_ID)
write_tab(sh_out, "Creative CPI - All", df); time.sleep(2)
write_tab(sh_out, "Creative CPI - Poor", poor); time.sleep(2)
write_tab(sh_out, "Creative CPI - Watch", watch); time.sleep(2)
write_tab(sh_out, "Creative CPI - Good", good)
print(f"\n🎉 完成！platforms={plats} 窗口={wins}  |  POOR {len(poor)} / WATCH {len(watch)} / GOOD {len(good)}")
print(f"https://docs.google.com/spreadsheets/d/{OUTPUT_SPREADSHEET_ID}")
