-- creative_dnu_cpi.sql — TikTok UA creative-grain DNU CPI, PURE BigQuery.
--
-- WHY PURE BQ (validated 2026-07-24, penny-exact over $1.03M):
--   At the (creative_id × campaign_name × p_date) grain, BigQuery android_creative `spend`
--   is IDENTICAL to Looker/Trino gross revenue (corr=1.0000; rev-weighted GR/spend=1.0000;
--   $1,030,860 spend vs $1,030,863 Looker GR). "spend" here IS the Liftoff advertiser cost =
--   Looker Gross Revenue, just relabeled. So the trust-matrix "recompute Looker-GR ÷ BQ-DNU"
--   reduces to `SUM(spend) / SUM(DNU)` — no Looker, no Google Sheet, 100% creative coverage.
--   (This does NOT hold for iOS: ios_creative has no `spend` column — that path still needs Looker.)
--
-- TIMEFRAME RULES baked in (the two traps — see SKILL.md):
--   1. The LATEST p_date in the feishu sync is a PARTIAL day (≈40% of a full day: e.g. 2026-07-21
--      landed $62K spend / 16.8K DNU vs ~$157K / ~35K on complete days). It is auto-EXCLUDED.
--   2. Numerator (spend=GR) and denominator (DNU) are the SAME rows over the SAME window — never
--      mix a short revenue snapshot against a long DNU history (the original notebook's fatal bug).
--
-- @lookback_days = number of COMPLETE trailing days to include (ending at the last complete day).
--
-- Compare `dnu_cpi` to the region's CPI KPI (Performance KPI sheet, or android_region 黑天鹅CPI)
-- to split Good (CPI ≤ KPI) vs Poor (CPI > KPI). Higher CPI = worse.

DECLARE lookback_days INT64 DEFAULT 7;

WITH bounds AS (                       -- last complete day = MAX(p_date) - 1 (drop the partial tail)
  SELECT DATE_SUB(DATE(MAX(p_date)), INTERVAL 1 DAY) AS end_day
  FROM `feishu-sync-493408.tiktok_data.android_creative`
  WHERE p_date != 'nan' AND p_date IS NOT NULL
),
win AS (
  SELECT
    CAST(DATE_SUB(end_day, INTERVAL lookback_days - 1 DAY) AS STRING) AS start_day,
    CAST(end_day AS STRING)                                           AS end_day
  FROM bounds
),
creative_day AS (
  SELECT
    UPPER(c.region) AS region,
    c.app_id,                                                    -- = tiktok_app_id (join App Name ID Map)
    REGEXP_EXTRACT(c.ad_name,
      r'(?i)TikTok[ _.,]+Pte[ _.,]*\.?[ _.,]*Ltd[ _.,]+([0-9]+)') AS creative_id,
    SAFE_CAST(c.spend AS FLOAT64) AS rev_row,                    -- spend == Looker Gross Revenue
    SAFE_CAST(c.DNU   AS FLOAT64) AS dnu_row,
    SAFE_CAST(c.LTall AS FLOAT64) AS ltall_row,                  -- secondary quality signals (~40% filled)
    SAFE_CAST(c.ROI2  AS FLOAT64) AS roi2_row
  FROM `feishu-sync-493408.tiktok_data.android_creative` c, win
  WHERE c.p_date >= win.start_day AND c.p_date <= win.end_day    -- complete days only
    AND c.ad_name IS NOT NULL AND c.ad_name != ''
)
SELECT
  region,
  app_id,
  creative_id,
  ROUND(SUM(rev_row), 2)                             AS gross_revenue,   -- = Liftoff GR
  SUM(dnu_row)                                       AS dnu,             -- client-truth installs
  ROUND(SAFE_DIVIDE(SUM(rev_row), SUM(dnu_row)), 4)  AS dnu_cpi,         -- GR ÷ DNU (the gate)
  -- DNU-weighted secondary signals (only over rows where the metric is present)
  ROUND(SAFE_DIVIDE(SUM(ltall_row * dnu_row), SUM(IF(ltall_row IS NOT NULL, dnu_row, 0))), 2) AS ltall,
  ROUND(SAFE_DIVIDE(SUM(roi2_row  * dnu_row), SUM(IF(roi2_row  IS NOT NULL, dnu_row, 0))), 4) AS roi2
FROM creative_day
WHERE creative_id IS NOT NULL
GROUP BY region, app_id, creative_id
HAVING SUM(dnu_row) > 0
ORDER BY gross_revenue DESC;

-- VERDICT (applied downstream against region KPIs; higher CPI = worse):
--   cpi_kpi  = region CPI target  (sheet 'Performance KPI',      app+region)  -- full, has KR
--   poor_kpi = region POOR cutoff (sheet 'Poor Performance KPI', app+region)  -- subset; KR absent → null
--   GOOD  : dnu_cpi <= cpi_kpi
--   WATCH : cpi_kpi < dnu_cpi <= poor_kpi   (poor_kpi present)
--   POOR  : dnu_cpi > poor_kpi   (or > cpi_kpi when poor_kpi is null)
--   NO_DNU: dnu < 1 / dnu_cpi = 0    NO_KPI: no cpi_kpi for that (app, region)
