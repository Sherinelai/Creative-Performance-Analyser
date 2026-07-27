-- get_re_campaign_perf → Trino (hive.analytics.daily)
-- Validated 2026-07-08 (basis shared with anchor A1). Campaign × date revenue/conv/RPA.
--
-- EVENT BASIS: default target_events (no custom_event_name filter). Named-event override →
-- custom_event_name='<event>' (zeroes revenue — counts only). ALWAYS state the basis. See ledger.
--
-- Params:
--   :campaign_ids  comma-separated campaign IDs
--   :geo           ISO country, e.g. 'SA' (recommended — drops $0 cross-geo bid noise)
--   :start_dt / :end_dt   full 20-char literals; end exclusive; complete days only
--
-- Contract (old tool): date, campaign_id, campaign_name, revenue, events, rpa (per campaign per day).
-- SELECT target_event_name so the Gumshoe verify link builds from output (one link per event).

SELECT
  dt                         AS date,
  campaign_id,
  arbitrary(campaign_name)   AS campaign_name,
  arbitrary(target_event_name) AS target_event_name,   -- basis label for the verify link
  round(sum(revenue_micros) / 1e6, 2)                       AS revenue,
  sum(target_events)                                        AS events,
  round((sum(revenue_micros) / 1e6) / NULLIF(sum(target_events), 0), 4) AS rpa
FROM hive.analytics.daily
WHERE customer_id = 968
  AND campaign_type = 'reengagement'
  AND campaign_id IN (:campaign_ids)
  AND country = :geo                 -- omit for a true multi-geo campaign
  AND dt >= :start_dt
  AND dt <  :end_dt
GROUP BY dt, campaign_id
ORDER BY dt DESC, campaign_id;
