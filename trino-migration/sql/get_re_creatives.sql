-- get_re_creatives → Trino (hive.analytics.daily)
-- Validated 2026-07-08 against anchor D: 65880 SA L7D top creative 1121972 (VAST 320x480)
-- RPA $0.7392 (GR $383.64 / 519 conv) — exact match.
--
-- Creative-level performance, top_n by GR. Native dims: creative_id, creative_type, logical_size,
-- creative_language, is_interactive, video_length_vast — no Looker joins.
--
-- `creative_name` is DROPPED (decision 2026-07-08): it is not in `daily`, and no creatives dim
-- table exists anywhere in the connector's catalog (hive.analytics + hive.proto2parquet are the
-- only schemas; neither has one). `creative_id` is the stable key; resolve a name when needed via
-- the Gumshoe UI or the retained Looker path (pinpoint__creatives_simple.creative_name).
--
-- EVENT BASIS: default target_events, NO custom_event_name filter (see ledger — filtering zeroes
-- revenue). ALWAYS state the basis.
--
-- Params:
--   :campaign_ids  comma-separated campaign IDs
--   :geo           ISO country, e.g. 'SA' (recommended — drops $0 cross-geo bid noise)
--   :start_dt / :end_dt   full 20-char literals; end exclusive; complete days only
--   :top_n         creatives ranked by full-window GR, e.g. 10
--
-- This statement = the old tool's creative_rollup. The other old aggregations are derivations of
-- the same scope, shaped in SQL not Python:
--   ad_type_rollup      → GROUP BY creative_type (drop creative_id + LIMIT)
--   logical_size_rollup → GROUP BY logical_size
--   ad_type_daily / creative_daily → add `dt` to SELECT + GROUP BY (for creative_daily keep the
--     top_n scope via a ranked-CTE semi-join, as in get_re_source_apps_by_exchange.sql — semi-join,
--     not JOIN...USING).

SELECT
  creative_id,
  arbitrary(creative_type)       AS creative_type,     -- config dims: one value per creative;
  arbitrary(logical_size)        AS logical_size,      -- arbitrary(), never sum()
  arbitrary(creative_language)   AS creative_language,
  arbitrary(is_interactive)      AS is_interactive,
  arbitrary(video_length_vast)   AS video_length,
  round(sum(revenue_micros) / 1e6, 2) AS revenue,      -- GR: advertiser cost. NOT spend.
  sum(target_events)                  AS events,
  round((sum(revenue_micros) / 1e6) / NULLIF(sum(target_events), 0), 4) AS rpa
FROM hive.analytics.daily
WHERE customer_id = 968
  AND campaign_type = 'reengagement'   -- always-on guardrail
  AND campaign_id IN (:campaign_ids)
  AND country = :geo                   -- omit for a true multi-geo campaign
  AND dt >= :start_dt
  AND dt <  :end_dt
GROUP BY creative_id
ORDER BY revenue DESC
LIMIT :top_n;
