// ============================================================
// Code.gs — v6: MCO fix, preview+optState, daily format metrics
// ============================================================

// ═══════════════════════════════════════════════════════════
// MCO INVENTORY GROUP MAPPING — SINGLE SOURCE OF TRUTH
// inventory_format → MCO Inventory Group display name.
//
// This is the ONLY copy of this mapping. Dashboard.html receives it via
// getConfig() (see CFG.mcoGroupMap) and the reverse lookup used for SQL-side
// filtering is derived from it by mcoGroupToBases() — do NOT re-declare it
// anywhere. The grouping IS the app's mental model: the Auto-Pauser competes
// creatives inside an inventory group, so every table, chart, filter and
// diagnosis has to group identically.
// ═══════════════════════════════════════════════════════════
var MCO_GROUP_MAP_GS = {
  'tablet-portrait-vast-60s':'Tablet Portrait VAST','tablet-portrait-vast-30s':'Tablet Portrait VAST','tablet-portrait-vast':'Tablet Portrait VAST',
  'tablet-landscape-vast-60s':'Tablet Landscape VAST','tablet-landscape-vast-30s':'Tablet Landscape VAST','tablet-landscape-vast':'Tablet Landscape VAST',
  'tablet-html-portrait-interstitial':'Tablet Portrait HTML',
  'tablet-html-landscape-interstitial':'Tablet Landscape HTML',
  'tablet-banner':'Tablet Banner',
  'phone-portrait-vast-60s':'Phone Portrait VAST','phone-portrait-vast-30s':'Phone Portrait VAST','phone-portrait-vast':'Phone Portrait VAST',
  'phone-landscape-vast-60s':'Phone Landscape VAST','phone-landscape-vast-30s':'Phone Landscape VAST','phone-landscape-vast':'Phone Landscape VAST',
  'phone-html-portrait-interstitial':'Phone Portrait HTML',
  'phone-html-landscape-interstitial':'Phone Landscape HTML',
  'phone-banner':'Phone Banner',
  'native-video':'Native VAST',
  'native-static':'Native Static',
  'mrect-vast-60s':'MRECT VAST','mrect-vast-30s':'MRECT VAST','mrect-vast':'MRECT VAST',
  'mrect':'MRECT Static'
};
function toMcoGroup(inventoryFormat) {
  if (!inventoryFormat) return 'Unknown';
  if (MCO_GROUP_MAP_GS[inventoryFormat]) return MCO_GROUP_MAP_GS[inventoryFormat];
  // Fallback: strip duration suffix
  var base = inventoryFormat.replace(/-\d+s$/, '');
  return MCO_GROUP_MAP_GS[base] || inventoryFormat;
}

/**
 * Reverse of toMcoGroup: an MCO Inventory Group display name → the duration-stripped
 * inventory_format bases that roll up into it. Derived from MCO_GROUP_MAP_GS, so a new
 * format only has to be added above. Used to translate a UI format filter into a
 * row-level predicate.
 */
function mcoGroupToBases(displayName) {
  var bases = {}, out = [];
  Object.keys(MCO_GROUP_MAP_GS).forEach(function(fmt) {
    if (MCO_GROUP_MAP_GS[fmt] !== displayName) return;
    var base = fmt.replace(/-\d+s$/, '').toLowerCase();
    if (!bases[base]) { bases[base] = true; out.push(base); }
  });
  return out.length ? out : [String(displayName || '').toLowerCase()];
}

// ═══════════════════════════════════════════════════════════
// MCO RULES — SINGLE SOURCE OF TRUTH for every threshold and diagnosis code
//
// The prose explanation of MCO lives in ONE place: the generated MCO_SKILL
// constant further down this file, synced from
//   skills/mco-creative-explainer/SKILL.md   (run: python3 tools/sync_skill.py)
// The NUMBERS live here, and flow to all three consumers:
//   1. the Claude system prompt   — mcoRulesPromptBlock() appends them as authoritative
//   2. the client-side fallback   — Dashboard.html reads CFG.mcoRules (getConfig())
//   3. anything server-side       — reference MCO_RULES directly
// Never hardcode 25000 / 7 / 5% / 10% anywhere else: change it here and all three move.
// ═══════════════════════════════════════════════════════════
var MCO_RULES = {
  selection_metric: 'ITI',            // MCO selects on ITI (30-day window), never ROAS/CPI/CPA
  iti_window_days: 30,

  // Calibration = the exploring → optimizing transition (WCS)
  calibration: { min_impressions: 25000, min_days_live: 7, impressions_window_months: 3 },

  // Auto-Pauser lose criteria (MCO campaigns only) — ALL must hold
  auto_pauser: {
    spend_share_pct: 5,               // < this share of the competing inventory group's spend
    spend_share_window_days: 3,
    selection_prob_pct: 10            // ...or selection probability below this
  },

  // Winner Candidate Substitution — forced impressions for exploring creatives
  wcs: { substitution_rate_pct_min: 5, substitution_rate_pct_max: 10, substitution_rate_pct_cap: 35 },

  // Creative throttle ("waiting room") for exploring creatives
  throttle: { min_capacity_per_format: 6 },

  // Inventory groups are not clean buckets: 30s/60s VAST overlap this often
  eligibility: { format_overlap_pct: 46.5 },

  // ── Creative state: AUTHORITATIVE, read from the queue PDT — never derived ──
  // There are exactly THREE states and they are MUTUALLY EXCLUSIVE. Each is a predicate
  // over looker.*queue_creative_statistics (auto-discovered by getQueuePDT()), and
  // buildQueueingSQL / buildExploringSQL / buildOptimizingSQL implement exactly these.
  // Do NOT compute a creative's state from impressions and age: the 25K/7-day rule below
  // is what makes the PLATFORM flip is_currently_optimizing, not a definition the app
  // should re-derive.
  creative_states: {
    queuing: {
      predicate: "is_currently_queue_eligible AND NOT is_currently_optimizing AND current_status = 'excluded'",
      meaning: 'In the creative-throttle waiting room: queue-eligible but excluded from serving, so it gets no WCS impressions yet. Waiting for capacity.'
    },
    exploring: {
      predicate: "is_currently_queue_eligible AND NOT is_currently_optimizing AND current_status = 'included'",
      meaning: 'Past the throttle and actively being served via WCS substitution, still pre-calibration. Protected from the Auto-Pauser.'
    },
    optimizing: {
      predicate: 'NOT is_currently_queue_eligible AND is_currently_optimizing',
      meaning: 'Calibrated: competing normally on ITI inside its inventory group, and eligible for the Auto-Pauser.'
    }
  },
  creative_state_source: "looker.*queue_creative_statistics PDT (dated — resolve via getQueuePDT()), joined on creative_id; both the creative and the campaign must be state='enabled'",
  // queuing vs exploring differ ONLY by current_status ('excluded' = throttled/not served,
  // 'included' = being served). Both are pre-calibration and both are Auto-Pauser-protected.
  creative_state_notes: 'A creative absent from the PDT (e.g. paused) has no state — report insufficient_data rather than guessing.',
  // What the platform uses to set is_currently_optimizing. A proxy at best, for when the
  // PDT returned nothing: failing EITHER calibration count means not-yet-optimized.
  calibration_trigger: 'is_currently_optimizing flips true once the creative clears BOTH calibration counts (impressions AND days live); failing either leaves it pre-calibration',

  // The closed vocabulary the AI must return and the UI must render
  diagnosis_codes: {
    auto_paused_low_iti:          'Paused: ITI lower than competitors',
    auto_paused_low_spend_share:  'Paused: spend share below the Auto-Pauser threshold',
    auto_paused_selection_prob:   'Paused: selection probability below the threshold',
    exploring_wcs_protected:      'In WCS exploration, exempt from pause',
    exploring_throttle_queued:    'In the throttle queue, waiting for capacity',
    winning_highest_iti:          'Spending: highest ITI in group',
    winning_by_eligibility:       'Spending: favorable eligibility matching',
    losing_iti_competition:       'Not spending: outcompeted on ITI',
    losing_eligibility_mismatch:  'Not eligible for high-volume bid requests',
    spend_shift_format_change:    'Spend moved to a different inventory format',
    newly_optimizing:             'Just exited exploration, competing normally',
    free_floating_random:         'Non-MCO: selected randomly',
    insufficient_data:            'Not enough data to diagnose'
  }
};

// ═══════════════════════════════════════════════════════════
// METRICS — SINGLE SOURCE OF TRUTH for what each metric means and which way is good
//
// Same three consumers as MCO_RULES: the AI prompt (metricsPromptBlock()), the client
// (CFG.metrics — labels, and which columns sort inverted), and server-side analysis
// (_getPrimaryMetric). "lower_is_better" is the only place cost-vs-return is encoded;
// do not re-write "RPI = cost of install (lower is better)" in a prompt or a UI label.
// ═══════════════════════════════════════════════════════════
var METRICS = {
  roas:    { label: '7D ROAS', direction: 'higher_is_better', definition: 'Return on ad spend over 7 days' },
  roas_d1: { label: 'D1 ROAS', direction: 'higher_is_better', definition: 'Return on ad spend over 1 day' },
  rpa:     { label: 'RPA',     direction: 'lower_is_better',  definition: 'Revenue Per Action — the cost of a target event' },
  rpi:     { label: 'RPI',     direction: 'lower_is_better',  definition: 'Revenue Per Install — the cost of an install' },
  iti:     { label: 'ITI',     direction: 'higher_is_better', definition: 'Impression-to-Install rate — the metric MCO selects on' },
  ipm:     { label: 'IPM',     direction: 'higher_is_better', definition: 'Installs Per Mille = ITI x 1000' }
};

/** Which metric a campaign type is judged on. Used by _getPrimaryMetric and by the client. */
var PRIMARY_METRIC_BY_CAMPAIGN_TYPE = { ua_cpr: 'roas', re: 'roas', ua_cpa: 'rpa', ua_cpi: 'rpi' };

/** Render METRICS as the "metric reminders" block of the AI system prompt. */
function metricsPromptBlock() {
  var L = ['## Metric definitions (authoritative)'];
  Object.keys(METRICS).forEach(function(k) {
    var m = METRICS[k];
    L.push('- **' + m.label + '** (`' + k + '`): ' + m.definition + '. ' +
           (m.direction === 'lower_is_better' ? 'LOWER is better.' : 'HIGHER is better.'));
  });
  return L.join('\n');
}

/** Render MCO_RULES as a markdown block appended to the AI system prompt. */
function mcoRulesPromptBlock() {
  var R = MCO_RULES, L = [];
  L.push('## Authoritative thresholds (these override any number in the prose above)');
  L.push('- Selection metric: ' + R.selection_metric + ' over ' + R.iti_window_days + ' days.');
  L.push('- Calibration: >= ' + R.calibration.min_impressions + ' impressions (past ' +
         R.calibration.impressions_window_months + ' months) AND >= ' + R.calibration.min_days_live + ' days live. ' +
         R.calibration_trigger + '.');
  L.push('- Auto-Pauser lose criteria (ALL): optimized; AND < ' + R.auto_pauser.spend_share_pct +
         '% of its competing inventory group spend over the past ' + R.auto_pauser.spend_share_window_days +
         ' days; AND (spent in that window OR selection probability < ' + R.auto_pauser.selection_prob_pct + '%).');
  L.push('- WCS substitution: ' + R.wcs.substitution_rate_pct_min + '-' + R.wcs.substitution_rate_pct_max +
         '% of won bids (max ' + R.wcs.substitution_rate_pct_cap + '%).');
  L.push('- Creative throttle: minimum ' + R.throttle.min_capacity_per_format + ' exploring creatives per inventory format.');
  L.push('- Inventory-format overlap: ~' + R.eligibility.format_overlap_pct + '% between duration variants.');
  L.push('');
  L.push('## Creative state (authoritative — three mutually exclusive states)');
  L.push('Read from ' + R.creative_state_source + '. Never infer a state from impressions or age.');
  Object.keys(R.creative_states).forEach(function(s) {
    var st = R.creative_states[s];
    L.push('- **' + s + '** — `' + st.predicate + '`. ' + st.meaning);
  });
  L.push('- ' + R.creative_state_notes);
  L.push('');
  L.push('## Allowed `diagnosis` values (return EXACTLY one of these strings)');
  Object.keys(R.diagnosis_codes).forEach(function(k) { L.push('- `' + k + '` — ' + R.diagnosis_codes[k]); });
  return L.join('\n');
}


// ═══════════════════════════════════════════════════════════
// CONFIG (merged from Config.gs)
// ═══════════════════════════════════════════════════════════
// Both halves of the Looker API3 key live in Script Properties — nothing credential-shaped
// in source. Set LOOKER_CLIENT_ID and LOOKER_CLIENT_SECRET under
// Project Settings → Script Properties before deploying.
var LOOKER_CONFIG = {
  BASE_URL: 'https://liftoff.cloud.looker.com',
  CLIENT_ID: PropertiesService.getScriptProperties().getProperty('LOOKER_CLIENT_ID') || '',
  CLIENT_SECRET: PropertiesService.getScriptProperties().getProperty('LOOKER_CLIENT_SECRET') || '',
};
var CACHE_TOKEN_SECONDS = 1500; // 25 minutes

var DEFAULT_LOOKBACK_DAYS = 30;

var THRESHOLDS = {
  MIN_CREATIVES_PER_GROUP: 5,
  UNDERPERFORM_THRESHOLD: 0.8,   // below 80% of avg = underperforming
  OVERPERFORM_THRESHOLD: 1.2,    // above 120% of avg = overperforming (CPA)
  SOW_WARN_PCT: 20,              // SOW > 20% = high concentration warning
  FRESHNESS_DAYS: 60,            // > 60 days since last upload = stale
};

var KEY_FORMATS = [
  'Phone Portrait VAST', 'Phone Landscape VAST',
  'Phone Portrait HTML', 'Phone Landscape HTML',
  'Phone Banner',
  'Tablet Portrait VAST', 'Tablet Landscape VAST',
  'Tablet Portrait HTML', 'Tablet Landscape HTML',
  'Tablet Banner',
  'Native VAST', 'Native Static',
  'MRECT VAST', 'MRECT Static',
];

function doGet(e) {
  logUsage('page_view', {});
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('Creative Performance Analyzer')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Returns the actual user's email (works even when deployed as "Execute as: Me")
function getActiveUserEmail() {
  try { return Session.getActiveUser().getEmail() || ''; }
  catch(e) { return ''; }
}

// Returns the web app deployment URL for sharing
function getWebAppUrl() {
  try { return ScriptApp.getService().getUrl(); }
  catch(e) { return ''; }
}

// ═══════════════════════════════════════════════════════════
// USAGE LOGGING — writes to Google Sheet
// ═══════════════════════════════════════════════════════════
var USAGE_LOG_SHEET_ID = '1URHDLIXlUqMLS41TpgepSAsX8L2BHtMDJrUcBnfleKA';

function logUsage(action, details) {
  try {
    // Use passed email first, then try Session methods
    var email = (details && details.userEmail) || '';
    if (!email) { try { email = Session.getActiveUser().getEmail(); } catch(e) {} }
    if (!email) { try { email = Session.getEffectiveUser().getEmail(); } catch(e) {} }
    var ss = SpreadsheetApp.openById(USAGE_LOG_SHEET_ID);
    var sheet = ss.getSheetByName('Usage Log');
    var HEADERS = ['Timestamp','User Email','Action','Campaign ID','App ID','Campaign Type','Model','Selection','Goal 2','VT Cap','Viewclick Tol','Target Event','Lookback Days','Duration (s)','Result'];
    if (!sheet) {
      sheet = ss.insertSheet('Usage Log');
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#273143').setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
    } else if (sheet.getLastColumn() < HEADERS.length) {
      // Migrate: old sheet had fewer columns — update header row
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#273143').setFontColor('#FFFFFF');
    }
    sheet.appendRow([
      new Date(),
      email || 'unknown',
      action || '',
      details.campaignId || '',
      details.appId || '',
      details.campaignType || '',
      details.model || '',
      details.selection || '',
      details.goal2 || '',
      details.vtCap || '',
      details.viewclick || '',
      details.targetEvent || '',
      details.lookbackDays || '',
      details.duration || '',
      details.result || ''
    ]);
  } catch(e) {
    Logger.log('logUsage failed: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════
// LOOKER AUTH + SQL RUNNER
// ═══════════════════════════════════════════════════════════
function getAccessToken() {
  var cache = CacheService.getScriptCache();
  var token = cache.get('looker_token');
  if (token) return token;
  if (!LOOKER_CONFIG.CLIENT_ID || !LOOKER_CONFIG.CLIENT_SECRET) {
    throw new Error('Looker credentials missing: set LOOKER_CLIENT_ID and LOOKER_CLIENT_SECRET in Script Properties');
  }
  var url = LOOKER_CONFIG.BASE_URL + '/api/4.0/login?client_id=' + encodeURIComponent(LOOKER_CONFIG.CLIENT_ID) + '&client_secret=' + encodeURIComponent(LOOKER_CONFIG.CLIENT_SECRET);
  var r = UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Looker auth failed');
  var data = JSON.parse(r.getContentText());
  cache.put('looker_token', data.access_token, CACHE_TOKEN_SECONDS);
  return data.access_token;
}

function lookerPost(endpoint, body) {
  var token = getAccessToken();
  var r = UrlFetchApp.fetch(LOOKER_CONFIG.BASE_URL + '/api/4.0' + endpoint, {
    method: 'post', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  if (r.getResponseCode() === 401) {
    CacheService.getScriptCache().remove('looker_token'); token = getAccessToken();
    r = UrlFetchApp.fetch(LOOKER_CONFIG.BASE_URL + '/api/4.0' + endpoint, {
      method: 'post', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
  }
  var txt = r.getContentText();
  if (r.getResponseCode() !== 200 && r.getResponseCode() !== 201) throw new Error('Looker POST ' + r.getResponseCode() + ': ' + txt.substring(0, 200));
  try { return JSON.parse(txt); } catch(e) { throw new Error('Looker POST not JSON: ' + txt.substring(0, 200)); }
}

function lookerGet(endpoint) {
  var token = getAccessToken();
  var r = UrlFetchApp.fetch(LOOKER_CONFIG.BASE_URL + '/api/4.0' + endpoint, { method: 'get', headers: { 'Authorization': 'Bearer ' + token }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Looker GET ' + r.getResponseCode());
  return JSON.parse(r.getContentText());
}

var SQL_CONN = 'accelerate_trino';
var DATA_BAKE_DAYS = 7; // Fully-baked data: exclude last 7 days (attribution window)


// Safe parseFloat: returns null only for NaN/undefined/null, preserves 0
function pf(v) { if (v == null || v === '' || v === 'null') return null; var n = parseFloat(v); return isNaN(n) ? null : n; }
function runSQL(sql) {
  var uniqueSQL = '-- ts:' + new Date().getTime() + '\n' + sql;
  var q = lookerPost('/sql_queries', { sql: uniqueSQL, connection_name: SQL_CONN });
  if (!q.slug) throw new Error('SQL creation failed');
  var token = getAccessToken();
  var r = UrlFetchApp.fetch(LOOKER_CONFIG.BASE_URL + '/api/4.0/sql_queries/' + q.slug + '/run/json', { method: 'post', headers: { 'Authorization': 'Bearer ' + token }, muteHttpExceptions: true });
  var body = r.getContentText();
  if (r.getResponseCode() !== 200) throw new Error('SQL run HTTP ' + r.getResponseCode() + ': ' + body.substring(0, 200));
  try { return JSON.parse(body); } catch(e) { throw new Error('SQL not JSON: ' + body.substring(0, 200)); }
}
// ═══════════════════════════════════════════════════════════
// PARALLEL SQL RUNNER
// Creates slugs sequentially (each needs auth), then runs
// all queries simultaneously via UrlFetchApp.fetchAll()
// ═══════════════════════════════════════════════════════════
function runSQLParallel(sqlMap) {
  // sqlMap: { key1: sqlString, key2: sqlString, ... }
  // Returns: { key1: rows, key2: rows, ... }
  var token = getAccessToken();
  var BASE = LOOKER_CONFIG.BASE_URL + '/api/4.0';
  var authHeader = { 'Authorization': 'Bearer ' + token };

  // Step 1: Create all slugs sequentially (POST /sql_queries)
  var slugs = {};
  Object.keys(sqlMap).forEach(function(key) {
    try {
      var uniqueSQL = '-- ts:' + new Date().getTime() + '_' + key + '\n' + sqlMap[key];
      var r = UrlFetchApp.fetch(BASE + '/sql_queries', {
        method: 'post',
        headers: Object.assign({'Content-Type':'application/json'}, authHeader),
        payload: JSON.stringify({ sql: uniqueSQL, connection_name: SQL_CONN }),
        muteHttpExceptions: true
      });
      var q = JSON.parse(r.getContentText());
      if (q.slug) slugs[key] = q.slug;
      else Logger.log('Slug creation failed for ' + key + ': ' + r.getContentText().substring(0,100));
    } catch(e) { Logger.log('Slug error for ' + key + ': ' + e.message); }
  });

  // Step 2: Fire all run/json requests in parallel
  var keys = Object.keys(slugs);
  if (keys.length === 0) return {};
  var requests = keys.map(function(key) {
    return {
      url: BASE + '/sql_queries/' + slugs[key] + '/run/json',
      method: 'post',
      headers: authHeader,
      muteHttpExceptions: true
    };
  });
  var responses = UrlFetchApp.fetchAll(requests);

  // Step 3: Parse responses
  var results = {};
  keys.forEach(function(key, i) {
    try {
      var body = responses[i].getContentText();
      if (responses[i].getResponseCode() !== 200) {
        Logger.log('Parallel query ' + key + ' HTTP ' + responses[i].getResponseCode());
        results[key] = [];
      } else {
        results[key] = JSON.parse(body);
      }
    } catch(e) {
      Logger.log('Parallel parse error for ' + key + ': ' + e.message);
      results[key] = [];
    }
  });
  return results;
}



// ═══════════════════════════════════════════════════════════
// PDT AUTO-DISCOVERY
// ═══════════════════════════════════════════════════════════
var _pdtTable = null;
function getPDT() {
  if (_pdtTable) return _pdtTable;
  var cache = CacheService.getScriptCache();
  var cached = cache.get('pdt_creative_format');
  if (cached) { _pdtTable = cached; return _pdtTable; }
  var rows = runSQL("SHOW TABLES FROM looker LIKE '%cstudio__creative_format%'");
  if (!rows.length) throw new Error('Creative format PDT not found in looker schema');
  _pdtTable = 'looker.' + rows[rows.length - 1].Table;
  cache.put('pdt_creative_format', _pdtTable, 3600);
  Logger.log('PDT discovered: ' + _pdtTable);
  return _pdtTable;
}

// ═══════════════════════════════════════════════════════════
// FEATURE 1+2: PRE-QUERY PREVIEW (fixed MCO + optimization_state)
// Uses cstudio_analytics_daily_v1 for MCO and opt state
// ═══════════════════════════════════════════════════════════
function previewCampaign(input) {
  try {
    if (!input || input.length < 2) return { error: 'Enter at least 2 characters.' };
    var isNum = /^\d+$/.test(input);
    var where = isNum
      ? "WHERE (c.id = " + input + " OR c.app_id = " + input + ")"
      : "WHERE LOWER(c.display_name) LIKE LOWER('%" + input.replace(/'/g, "''") + "%')";

    // Step 1: Get basic campaign info from pinpoint
    var sql1 = [
      "SELECT DISTINCT c.id AS campaign_id, c.display_name AS campaign_name, c.app_id,",
      "  c.state AS campaign_state, c.customer_id,",
      "  ct.name AS campaign_type",
      "FROM pinpoint.public.campaigns c",
      "LEFT JOIN pinpoint.public.campaign_types ct ON c.campaign_type_id = ct.id",
      where,
      "AND c.state IN ('enabled', 'paused')",
      "ORDER BY c.id DESC LIMIT 10",
    ].join('\n');
    var camps = runSQL(sql1);
    if (!camps.length) return { campaigns: [] };

    // Step 2: Enrich with MCO + optimization_state from cstudio_analytics
    // creative_mco_status values: mab_won, mab_competing, mab_explore → MCO is ON
    // creative_selection_strategy: if populated, use it; else check creative_mco_status
    var campIds = camps.map(function(c){ return c.campaign_id; });
    var sql2 = [
      "SELECT campaign_id,",
      "  MAX(current_optimization_state) AS optimization_state,",
      "  MAX(creative_selection_strategy) AS csc_strategy,",
      "  BOOL_OR(creative_mco_status IN ('mab_won','mab_competing','mab_explore','mab_learning')) AS has_mco_activity,",
      "  MAX(CASE WHEN csc2.selection_strategy='multiarm-bandit' AND csc2.enabled=True THEN 'MCO'",
      "           WHEN csc2.selection_strategy='random' AND csc2.enabled=True THEN 'Free-floating'",
      "           ELSE NULL END) AS csc_method",
      "FROM hive.bi.cstudio_analytics_daily_v1 a",
      "LEFT JOIN pinpoint.public.apps apps ON a.dest_app_id = apps.id",
      "LEFT JOIN pinpoint.public.creative_selection_configurations csc2 ON apps.id = csc2.app_id",
      "WHERE a.campaign_id IN (" + campIds.join(',') + ")",
      "  AND from_iso8601_timestamp(a.dt) >= DATE_ADD('day', -7, CURRENT_TIMESTAMP)",
      "GROUP BY 1",
    ].join('\n');

    var enrichMap = {};
    try {
      var enrichRows = runSQL(sql2);
      enrichRows.forEach(function(r) { enrichMap[String(r.campaign_id)] = r; });
    } catch(e) { Logger.log('Preview enrich failed: ' + e.message); }

    // Merge
    camps.forEach(function(c) {
      var e = enrichMap[String(c.campaign_id)] || {};
      // MCO: prefer csc_method from creative_selection_configurations,
      // fallback to cstudio mco activity detection
      if (e.csc_method) {
        c.creative_selection_method = e.csc_method;
      } else if (e.has_mco_activity) {
        c.creative_selection_method = 'MCO';
      } else if (e.csc_strategy) {
        c.creative_selection_method = e.csc_strategy === 'multiarm-bandit' ? 'MCO' : (e.csc_strategy === 'random' ? 'Free-floating' : e.csc_strategy);
      } else {
        c.creative_selection_method = 'Unknown';
      }
      c.optimization_state = e.optimization_state || null;
    });

    return { campaigns: camps };
  } catch(e) {
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════
// QUERY D: Campaign search
// ═══════════════════════════════════════════════════════════
function fetchCampaignSearch(input) {
  var isNum = /^\d+$/.test(input);
  var where = isNum
    ? "WHERE (c.id = " + input + " OR c.app_id = " + input + ")"
    : "WHERE LOWER(c.display_name) LIKE LOWER('%" + input.replace(/'/g, "''") + "%')";
  return runSQL("SELECT DISTINCT c.id AS campaign_id, c.display_name AS campaign_name, c.app_id, c.state AS campaign_state, c.customer_id FROM pinpoint.public.campaigns c " + where + " AND c.state IN ('enabled', 'paused') ORDER BY c.id DESC LIMIT 20");
}

// ═══════════════════════════════════════════════════════════
// STANDALONE QUERY FUNCTIONS (DEPRECATED)
// These are NOT used in the main fetchCreativeData flow.
// The main flow uses build*SQL() + runSQLParallel() instead.
// Kept for backward compatibility / manual testing only.
// MCO detection here may differ from the builder versions.
// ═══════════════════════════════════════════════════════════
function fetchCreativeLevelPerf(campaignId, lookbackDays) {
  var pdt = getPDT();
  var dtStart = "DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CAST(CAST(DATE_TRUNC('DAY', CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP))";
  var dtEnd   = "DATE_ADD('day', " + lookbackDays + ", DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CAST(CAST(DATE_TRUNC('DAY', CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP)))";
  var sql = [
    "WITH pinpoint__creatives_simple AS (",
    "  SELECT c.id, c.display_name, c.state, c.customer_id, c.created_at,",
    "    c.creative_type_id, c.is_interactive, c.inventory_format",
    "  FROM pinpoint.public.creatives c",
    "),",
    "pinpoint__campaigns AS (",
    "  SELECT c.id, c.current_optimization_state, c.vt_cap",
    "  FROM pinpoint.public.campaigns c",
    ")",
    "SELECT",
    "  revenue_summary.campaign_id,",
    "  revenue_summary.campaign_name,",
    "  cstudio__creative_format.creative_format_derived AS creative_format,",
    "  revenue_summary.customer_id,",
    "  revenue_summary.dest_app_id AS app_id,",
    "  revenue_summary.dest_app_name AS app_name,",
    "  revenue_summary.creative_id,",
    "  CASE WHEN revenue_summary.is_interactive = 'true' THEN 'Interactive'",
    "       WHEN revenue_summary.is_interactive = 'false' THEN 'Not Interactive'",
    "       ELSE 'N/A' END AS is_interactive,",
    "  revenue_summary.is_video_creative AS is_video,",
    "  pinpoint__creatives_simple.state AS creative_state,",
    "  revenue_summary.campaign_type,",
    "  pinpoint__campaigns.current_optimization_state AS optimization_state,",
    "  pinpoint__creatives_simple.inventory_format AS competing_group,",
    "  revenue_summary.target_event_name,",
    "  CAST(revenue_summary.target_event_id AS VARCHAR) AS target_event_id,",
    "  revenue_summary.campaign_goal_1,",
    "  revenue_summary.campaign_goal_2,",
    // Core metrics
    "  COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) AS revenue_d7,",
    "  COALESCE(SUM(revenue_summary.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.installs_d1), 0), 0) AS rpi_d1,",
    "  CAST(COALESCE(SUM(revenue_summary.installs_d7), 0) AS DOUBLE) / NULLIF(COALESCE(SUM(revenue_summary.impressions), 0), 0) AS iti,",
    "  COALESCE(SUM(revenue_summary.installs_d7), 0) / CAST(NULLIF(COALESCE(SUM(revenue_summary.impressions), 0), 0) AS DOUBLE) * 1000 AS ipm,",
    "  COALESCE(SUM(revenue_summary.coalesced_customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0), 0) AS roas_d7,",
    "  COALESCE(SUM(revenue_summary.coalesced_customer_revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0), 0) AS roas_d1,",
    "  COALESCE(SUM(revenue_summary.spend_micros / CAST(1e6 AS DOUBLE)), 0) AS spend,",
    "  COALESCE(SUM(revenue_summary.installs_d1), 0) AS installs,",
    // RPA (Revenue per first target event D7)
    "  COALESCE(SUM(revenue_summary.target_events_first_d7), 0) AS target_events_d7,",
    "  COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.target_events_first_d7), 0), 0) AS rpa_d7,",
    // ROAS CI
    "  CASE WHEN COALESCE(SUM(revenue_summary.customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) < 0.0005 THEN NULL",
    "       ELSE 1.96 * SQRT(COALESCE(SUM(revenue_summary.incremental_squared_capped_customer_revenue_d7), 0)) / COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) END AS roas_ci_margin,",
    "  CASE WHEN COALESCE(SUM(revenue_summary.customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) < 0.0005 THEN NULL",
    "       ELSE COALESCE(SUM(revenue_summary.customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) - 1.96 * SQRT(COALESCE(SUM(revenue_summary.incremental_squared_capped_customer_revenue_d7), 0)) / COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) END AS roas_d7_lower_ci,",
    "  CASE WHEN COALESCE(SUM(revenue_summary.customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) < 0.0005 THEN NULL",
    "       ELSE COALESCE(SUM(revenue_summary.customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) + 1.96 * SQRT(COALESCE(SUM(revenue_summary.incremental_squared_capped_customer_revenue_d7), 0)) / COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) END AS roas_d7_upper_ci,",
    // RPA CI (Poisson-based)
    "  CASE WHEN COALESCE(SUM(revenue_summary.target_events_first_d7), 0) < 5 THEN NULL",
    "       ELSE COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / (COALESCE(SUM(revenue_summary.target_events_first_d7), 0) + 1.96 * SQRT(COALESCE(SUM(revenue_summary.target_events_first_d7), 0))) END AS rpa_d7_lower_ci,",
    "  CASE WHEN COALESCE(SUM(revenue_summary.target_events_first_d7), 0) < 5 THEN NULL",
    "       ELSE COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / (COALESCE(SUM(revenue_summary.target_events_first_d7), 0) - 1.96 * SQRT(COALESCE(SUM(revenue_summary.target_events_first_d7), 0))) END AS rpa_d7_upper_ci,",
    "  CASE WHEN COALESCE(SUM(revenue_summary.target_events_first_d7), 0) < 5 THEN NULL",
    "       ELSE (COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / (COALESCE(SUM(revenue_summary.target_events_first_d7), 0) - 1.96 * SQRT(COALESCE(SUM(revenue_summary.target_events_first_d7), 0))) - COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.target_events_first_d7), 0), 0)) / NULLIF(COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.target_events_first_d7), 0), 0), 0) END AS rpa_ci_delta",
    "FROM analytics.daily_attr_event_d7 AS revenue_summary",
    "LEFT JOIN pinpoint__campaigns ON revenue_summary.campaign_id = pinpoint__campaigns.id",
    "LEFT JOIN pinpoint__creatives_simple ON revenue_summary.creative_id = pinpoint__creatives_simple.id",
    "LEFT JOIN " + pdt + " AS cstudio__creative_format ON pinpoint__creatives_simple.id = cstudio__creative_format.creative_id",
    "WHERE (from_iso8601_timestamp(revenue_summary.dt)) >= " + dtStart,
    "  AND (from_iso8601_timestamp(revenue_summary.dt)) < " + dtEnd,
    "  AND revenue_summary.campaign_id = " + campaignId,
    "  AND revenue_summary.is_uncredited <> 'true'",
    "GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17",
    "ORDER BY 18 DESC",
    "LIMIT 500",
  ].join('\n');
  return runSQL(sql);
}


// ═══════════════════════════════════════════════════════════
// QUERY E2: Non-cohorted ITI/IPM/RPI from analytics.daily
// (analytics.daily has revenue_micros, installs, impressions — not d1/d7 cohorted)
// ═══════════════════════════════════════════════════════════
function fetchCreativeDailyMetrics(campaignId, lookbackDays) {
  // analytics.daily is very large — cap at min(lookbackDays, 14) to avoid timeout
  // Use DATE_FORMAT string comparison for efficient partition pruning
  var capDays = Math.min(lookbackDays, 14) + DATA_BAKE_DAYS;
  var sql = [
    "SELECT",
    "  r.creative_id,",
    "  SUM(r.revenue_micros) / CAST(1e6 AS DOUBLE) / NULLIF(SUM(r.installs), 0) AS rpi,",
    "  CAST(SUM(r.installs) AS DOUBLE) / NULLIF(SUM(r.impressions), 0) * 1000 AS ipm,",
    "  CAST(SUM(r.installs) AS DOUBLE) / NULLIF(SUM(r.impressions), 0) AS iti",
    "FROM analytics.daily r",
    "WHERE r.campaign_id = " + campaignId,
    "  AND r.dt >= DATE_FORMAT(DATE_ADD('day', -" + capDays + ", CURRENT_DATE), '%Y-%m-%dT00:00:00Z')",
    "  AND r.dt < DATE_FORMAT(DATE_ADD('day', -" + DATA_BAKE_DAYS + ", CURRENT_DATE), '%Y-%m-%dT00:00:00Z')",
    "  AND r.is_uncredited <> 'true'",
    "GROUP BY 1",
    "HAVING SUM(r.installs) > 0",
    "ORDER BY rpi DESC NULLS LAST",
    "LIMIT 500",
  ].join('\n');
  return runSQL(sql);
}

// ═══════════════════════════════════════════════════════════
// QUERY B: Campaign config + MCO (enhanced with cstudio MCO detection)
// ═══════════════════════════════════════════════════════════
function fetchCampaignConfig(appId) {
  var sql = [
    "WITH pinpoint__apps AS (",
    "  SELECT apps.id,",
    "    MAX(CASE WHEN csc.selection_strategy = 'multiarm-bandit' AND csc.enabled = True THEN 'MCO'",
    "             WHEN csc.selection_strategy = 'random' AND csc.enabled = True THEN 'Free-floating'",
    "             ELSE 'MCO' END) AS creative_selection_method",
    "  FROM pinpoint.public.apps apps",
    "  LEFT JOIN pinpoint.public.creative_selection_configurations csc ON apps.id = csc.app_id",
    "  GROUP BY 1",
    "),",
    "cstudio_daily AS (",
    "  SELECT a.dest_app_id, a.dest_app_name, a.campaign_id, a.campaign_type,",
    "    a.current_optimization_state, a.creative_id, a.dt, a.campaign_name,",
    "    a.creative_mco_status",
    "  FROM hive.bi.cstudio_analytics_daily_v1 a",
    ")",
    "SELECT cstudio_daily.dest_app_id AS app_id,",
    "  MAX(cstudio_daily.dest_app_name) AS app_name,",
    "  cstudio_daily.campaign_id,",
    "  COALESCE(",
    "    MAX(pinpoint__apps.creative_selection_method),",
    "    CASE WHEN BOOL_OR(cstudio_daily.creative_mco_status IN ('mab_won','mab_competing','mab_explore','mab_learning')) THEN 'MCO'",
    "         ELSE 'MCO' END",
    "  ) AS mco_status,",
    "  MAX(cstudio_daily.campaign_type) AS campaign_type,",
    "  MAX(cstudio_daily.current_optimization_state) AS optimization_state,",
    "  MAX(cstudio_daily.campaign_name) AS campaign_name",
    "FROM cstudio_daily",
    "LEFT JOIN pinpoint__apps ON cstudio_daily.dest_app_id = pinpoint__apps.id",
    "WHERE from_iso8601_timestamp(cstudio_daily.dt) >= DATE_ADD('day', -30, CURRENT_DATE)",
    "  AND cstudio_daily.dest_app_id = " + appId,
    "GROUP BY 1, 3 ORDER BY 3 LIMIT 5000",
  ].join('\n');
  return runSQL(sql);
}

// ═══════════════════════════════════════════════════════════
// QUERY C: Creative inventory + status log
// ═══════════════════════════════════════════════════════════
function fetchCreativeInventory(campaignId) {
  var pdt = getPDT();
  var sql = [
    "WITH cstudio_daily_analytics_v1 AS (",
    "  SELECT a.*, c.external_id FROM hive.bi.cstudio_analytics_daily_v1 a",
    "  LEFT JOIN pinpoint.public.creatives c ON c.id = a.creative_id",
    "),",
    "pinpoint__creatives_simple AS (",
    "  SELECT c.id, c.display_name, c.state, c.created_at, c.is_interactive, c.inventory_format,",
    "    l.display_name AS creative_language_name",
    "  FROM pinpoint.public.creatives c LEFT JOIN pinpoint.public.languages l ON c.language_id = l.id",
    "),",
    "creative_state_events AS (",
    "  WITH t AS (SELECT b.creative_id, c.state,",
    "    MAX(CASE WHEN old_value IS NULL AND new_value='enabled' THEN changed_at WHEN old_value='deleted' AND new_value='enabled' THEN changed_at WHEN old_value='paused' AND new_value='enabled' THEN changed_at END) AS max_enabled_date,",
    "    MAX(CASE WHEN old_value='enabled' AND new_value='paused' THEN changed_at END) AS paused_date",
    "  FROM pinpoint.public.creative_state_events b LEFT JOIN pinpoint.public.creatives c ON b.creative_id=c.id GROUP BY 1,2)",
    "  SELECT creative_id, CASE WHEN state<>'enabled' THEN paused_date ELSE NULL END AS current_pause_date FROM t",
    "),",
    "cstudio__creative_paused_by AS (",
    "  WITH mcd AS (SELECT creative_id, MAX(created_at) AS max_created_at FROM pinpoint.public.creative_events WHERE event_type='paused' GROUP BY 1),",
    "  mchd AS (SELECT creative_id, MAX(changed_at) AS max_changed_at FROM pinpoint.public.creative_state_events WHERE new_value='paused' GROUP BY 1)",
    "  SELECT a.creative_id, json_extract_scalar(a.payload, '$.source.source') AS pause_method",
    "  FROM pinpoint.public.creative_events a",
    "  LEFT JOIN mchd ON a.creative_id=mchd.creative_id LEFT JOIN mcd ON a.creative_id=mcd.creative_id",
    "  WHERE a.created_at=mcd.max_created_at AND a.event_type='paused'",
    "),",
    "pinpoint__apps AS (",
    "  SELECT apps.id, MAX(CASE WHEN csc.selection_strategy='multiarm-bandit' AND csc.enabled=True THEN 'MCO' WHEN csc.selection_strategy='random' AND csc.enabled=True THEN 'Free-floating' ELSE 'MCO' END) AS creative_selection_method",
    "  FROM pinpoint.public.apps apps LEFT JOIN pinpoint.public.creative_selection_configurations csc ON apps.id=csc.app_id GROUP BY 1",
    ")",
    "SELECT cstudio_daily_analytics_v1.dest_app_id AS app_id, cstudio_daily_analytics_v1.campaign_id,",
    "  cstudio_daily_analytics_v1.campaign_name, pinpoint__creatives_simple.id AS creative_id,",
    "  DATE_FORMAT(pinpoint__creatives_simple.created_at,'%Y-%m-%d') AS created_date,",
    "  DATE_FORMAT(creative_state_events.current_pause_date,'%Y-%m-%d') AS paused_date,",
    "  cstudio__creative_paused_by.pause_method,",
    "  pinpoint__creatives_simple.inventory_format AS competing_group,",
    "  cstudio__creative_format.creative_format_derived AS creative_format,",
    "  pinpoint__creatives_simple.state AS creative_state,",
    "  pinpoint__creatives_simple.external_id AS external_id",
    "FROM cstudio_daily_analytics_v1",
    "LEFT JOIN pinpoint__apps ON cstudio_daily_analytics_v1.dest_app_id=pinpoint__apps.id",
    "LEFT JOIN pinpoint__creatives_simple ON cstudio_daily_analytics_v1.creative_id=pinpoint__creatives_simple.id",
    "LEFT JOIN " + pdt + " AS cstudio__creative_format ON cstudio_daily_analytics_v1.creative_id=cstudio__creative_format.creative_id",
    "LEFT JOIN creative_state_events ON cstudio_daily_analytics_v1.creative_id=creative_state_events.creative_id",
    "LEFT JOIN cstudio__creative_paused_by ON cstudio_daily_analytics_v1.creative_id=cstudio__creative_paused_by.creative_id",
    "WHERE cstudio_daily_analytics_v1.campaign_id=" + campaignId,
    "  AND (cstudio_daily_analytics_v1.campaign_type<>'reengagement' OR cstudio_daily_analytics_v1.campaign_type IS NULL)",
    "  AND (from_iso8601_timestamp(cstudio_daily_analytics_v1.dt))>=DATE_ADD('day',-30,CAST(CAST(DATE_TRUNC('DAY',CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP))",
    "  AND (from_iso8601_timestamp(cstudio_daily_analytics_v1.dt))<DATE_ADD('day',31,DATE_ADD('day',-30,CAST(CAST(DATE_TRUNC('DAY',CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP)))",
    "GROUP BY 1,2,3,4,5,6,7,8,9,10,11 ORDER BY 2 LIMIT 500",
  ].join('\n');
  return runSQL(sql);
}

// ═══════════════════════════════════════════════════════════
// QUERY C2: Status log — standalone, no CSC dependency
// Directly queries creative_state_events for the campaign's creatives
// ═══════════════════════════════════════════════════════════
function fetchStatusLog(campaignId, lookbackDays) {
  var dtStart = "DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CURRENT_DATE)";
  var dtEnd   = "DATE_ADD('day', 1, CURRENT_DATE)";
  var sql = [
    "WITH campaign_creatives AS (",
    "  SELECT DISTINCT creative_id FROM analytics.daily_attr_event_d7",
    "  WHERE campaign_id = " + campaignId,
    "    AND from_iso8601_timestamp(dt) >= " + dtStart,
    "    AND is_uncredited <> 'true'",
    "),",
    "paused_events AS (",
    "  SELECT cse.creative_id,",
    "    DATE_FORMAT(MAX(CASE WHEN cse.old_value='enabled' AND cse.new_value='paused' THEN cse.changed_at END), '%Y-%m-%d') AS paused_date",
    "  FROM pinpoint.public.creative_state_events cse",
    "  WHERE cse.creative_id IN (SELECT creative_id FROM campaign_creatives)",
    "  GROUP BY 1",
    "  HAVING MAX(CASE WHEN cse.old_value='enabled' AND cse.new_value='paused' THEN cse.changed_at END) IS NOT NULL",
    "),",
    "pause_source AS (",
    "  SELECT ce.creative_id,",
    "    json_extract_scalar(ce.payload, '$.source.source') AS pause_method,",
    "    ce.created_at",
    "  FROM pinpoint.public.creative_events ce",
    "  JOIN (SELECT creative_id, MAX(created_at) AS max_created_at FROM pinpoint.public.creative_events WHERE event_type='paused' GROUP BY 1) mx",
    "    ON ce.creative_id=mx.creative_id AND ce.created_at=mx.max_created_at",
    "  WHERE ce.event_type='paused'",
    ")",
    "SELECT p.creative_id, p.paused_date,",
    "  COALESCE(ps.pause_method, 'unknown') AS pause_method",
    "FROM paused_events p",
    "LEFT JOIN pause_source ps ON p.creative_id=ps.creative_id",
    "ORDER BY p.paused_date DESC",
    "LIMIT 50",
  ].join('\n');
  return runSQL(sql);
}



// ═══════════════════════════════════════════════════════════
// QUERY H: Campaign meta — view-click tolerance + vt_cap
// ═══════════════════════════════════════════════════════════
function fetchCampaignMeta(campaignId) {
  var sql = [
    "SELECT",
    "  r.campaign_id,",
    "  r.dest_app_id,",
    "  CASE WHEN vc.tolerance IS NULL THEN 'medium' ELSE vc.tolerance END AS view_click_tolerance,",
    "  MAX(c.vt_cap) AS vt_cap",
    "FROM analytics.trimmed_daily r",
    "LEFT JOIN pinpoint.public.campaigns c ON r.campaign_id = c.id",
    "LEFT JOIN pinpoint.public.app_viewclick_tolerance_view vc ON r.dest_app_id = vc.app_id",
    "WHERE from_iso8601_timestamp(r.dt) >= DATE_ADD('day', -7, CURRENT_DATE)",
    "  AND r.campaign_id = " + campaignId,
    "  AND r.is_uncredited <> 'true'",
    "GROUP BY 1, 2, 3",
    "LIMIT 1",
  ].join('\n');
  return runSQL(sql);
}

// ═══════════════════════════════════════════════════════════
// QUERY F: Daily format metrics for time-series charts
// Uses inventory_format from pinpoint.public.creatives (no PDT needed)
// ═══════════════════════════════════════════════════════════
function fetchDailyFormatMetrics(campaignId, lookbackDays) {
  var sql = [
    "SELECT",
    "  CAST(from_iso8601_timestamp(r.dt) AS DATE) AS dt,",
    "  c.inventory_format AS creative_format,",
    "  COALESCE(SUM(r.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) AS revenue_d7,",
    "  COALESCE(SUM(r.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(SUM(r.installs_d1), 0) AS rpi_d1,",
    "  COALESCE(SUM(r.coalesced_customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(r.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0), 0) AS roas_d7,",
    "  COALESCE(SUM(r.coalesced_customer_revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(r.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0), 0) AS roas_d1,",
    "  CASE WHEN SUM(r.target_events_first_d7) < 5 THEN NULL ELSE COALESCE(SUM(r.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(SUM(r.target_events_first_d7), 0) END AS rpa_d7",
    "FROM analytics.daily_attr_event_d7 r",
    "LEFT JOIN pinpoint.public.creatives c ON r.creative_id = c.id",
    "WHERE r.campaign_id = " + campaignId,
    "  AND from_iso8601_timestamp(r.dt) >= DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CURRENT_DATE)",
    "  AND from_iso8601_timestamp(r.dt) < DATE_ADD('day', -" + DATA_BAKE_DAYS + ", CURRENT_DATE)",
    "  AND r.is_uncredited <> 'true'",
    "  AND c.inventory_format IS NOT NULL",
    "GROUP BY 1, 2",
    "ORDER BY 1, 2",
  ].join('\n');
  return runSQL(sql);
}

// ═══════════════════════════════════════════════════════════
// QUERY G: Video / Interactive breakdown (simplified — no pinpoint__creatives CTE)
// ═══════════════════════════════════════════════════════════
function fetchTypeBreakdown(campaignId, lookbackDays) {
  var sql = [
    "SELECT",
    "  r.is_video_creative AS is_video,",
    "  CASE WHEN r.is_interactive = 'true' THEN 'Interactive'",
    "       WHEN r.is_interactive = 'false' THEN 'Not Interactive'",
    "       ELSE 'N/A' END AS interactive_label,",
    "  COUNT(DISTINCT r.creative_id) AS creative_count,",
    "  COALESCE(SUM(r.spend_micros / CAST(1e6 AS DOUBLE)), 0) AS spend,",
    "  COALESCE(SUM(r.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) AS revenue_d7,",
    "  COALESCE(SUM(r.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(SUM(r.installs_d1), 0) AS rpi,",
    "  COALESCE(SUM(r.coalesced_customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(SUM(r.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) AS roas_d7,",
    "  CAST(SUM(r.installs_d1) AS DOUBLE) / NULLIF(SUM(r.impressions), 0) AS iti",
    "FROM analytics.daily_attr_event_d7 r",
    "WHERE r.campaign_id = " + campaignId,
    "  AND from_iso8601_timestamp(r.dt) >= DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CURRENT_DATE)",
    "  AND from_iso8601_timestamp(r.dt) < DATE_ADD('day', -" + DATA_BAKE_DAYS + ", CURRENT_DATE)",
    "  AND r.is_uncredited <> 'true'",
    "GROUP BY 1, 2",
    "ORDER BY spend DESC",
  ].join('\n');
  return runSQL(sql);
}

// ═══════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════
function fetchCreativeData(searchInput, searchType, lookbackDays, dashFilters) {
  var _logStart = new Date().getTime();
  lookbackDays = lookbackDays || DEFAULT_LOOKBACK_DAYS;
  dashFilters = dashFilters || {};
  try {
    if (!searchInput) return { error: 'Please provide an App ID, Campaign ID, or App name.' };

    Logger.log('Step 1: Search "' + searchInput + '"');
    var campaigns = fetchCampaignSearch(searchInput);
    Logger.log('Found ' + campaigns.length + ' campaigns');
    if (!campaigns.length) return { error: 'No enabled campaigns found for "' + searchInput + '".' };

    var camp = searchType === 'campaign'
      ? (campaigns.find(function(c){ return String(c.campaign_id)===String(searchInput); }) || campaigns[0])
      : campaigns[0];
    var campaignId = camp.campaign_id, appId = camp.app_id, appName = 'App ' + appId;
    Logger.log('Selected: ' + campaignId + ' | app ' + appId);

    // ─── BATCH 1: Run Query E + Inventory + Config in parallel ───────────────
    Logger.log('Batch 1: Perf + Inventory + Config (parallel)...');
    var t1 = new Date().getTime();
    var b1SQLs = {
      perf:      buildCreativeLevelPerfSQL(campaignId, lookbackDays),
      inventory: buildCreativeInventorySQL(campaignId),
      config:    buildCampaignConfigSQL(appId)
    };
    var b1 = runSQLParallel(b1SQLs);
    Logger.log('Batch 1 done in ' + Math.round((new Date().getTime()-t1)/1000) + 's');

    var perfData  = b1.perf      || [];
    var inventory = b1.inventory || [];
    var cfgRows   = b1.config    || [];
    Logger.log('Perf: ' + perfData.length + ' | Inventory: ' + inventory.length + ' | Config: ' + cfgRows.length);

    // Parse config
    var mcoEnabled = false, campaignType = null, optState = null;
    var cfg = cfgRows.find(function(r){ return String(r.campaign_id)===String(campaignId); }) || cfgRows[0];
    if (cfg) {
      mcoEnabled = (cfg.mco_status||'').indexOf('MCO') >= 0;
      campaignType = detectType(cfg.campaign_type);
      optState = cfg.optimization_state;
      if (cfg.app_name) appName = cfg.app_name;
    }
    if (!campaignType) campaignType = detectTypeFromName(camp.campaign_name || '');

    // Merge
    Logger.log('Step 5: Merging...');
    var merged = mergeAllData(perfData, inventory, campaignId);
    Logger.log('Merged: ' + merged.length + ' rows');

    if (dashFilters.sql) {
      var sf = dashFilters.sql;
      if (sf.creativeState) { var ts = sf.creativeState==='enabled'?'active':sf.creativeState; merged = merged.filter(function(r){return r.status===ts}); }
      if (sf.creativeFormat) merged = merged.filter(function(r){return r.ad_format&&r.ad_format.toLowerCase().indexOf(sf.creativeFormat.toLowerCase())>=0});
      if (sf.competingGroup) {
        var cgArr = Array.isArray(sf.competingGroup) ? sf.competingGroup : (sf.competingGroup ? [sf.competingGroup] : []);
        if (cgArr.length > 0) {
          // Reverse lookup derived from MCO_GROUP_MAP_GS — no second copy of the mapping.
          var allowedBases = [];
          cgArr.forEach(function(dn){
            mcoGroupToBases(dn).forEach(function(b){ if (allowedBases.indexOf(b) < 0) allowedBases.push(b); });
          });
          merged = merged.filter(function(r){
            if(!r.competing_group) return false;
            var base = r.competing_group.replace(/-\d+s$/, '').toLowerCase();
            return allowedBases.indexOf(base) >= 0;
          });
        }
      }
      if (sf.creativeId) merged = merged.filter(function(r){return String(r.creative_id)===String(sf.creativeId)});
      if (sf.optimizationState) merged = merged.filter(function(r){return r.optimization_state&&r.optimization_state.toLowerCase()===sf.optimizationState.toLowerCase()});
      Logger.log('Post-filter: ' + merged.length + ' rows');
    }

    // StatusLog will be built after Batch 2 (which has the dedicated pauseLog query)
    var campaignCids = {};
    merged.forEach(function(m) { campaignCids[String(m.creative_id)] = true; });
    var statusLog = []; // placeholder — real data comes from pauseLog in Batch 2

    // Step 5b: analytics.daily enrichment — only if merged has creatives missing iti/ipm
    // Query E already provides iti/ipm from cohorted data; skip daily if all creatives have values
    var needsDaily = merged.some(function(m){ return m.iti == null || m.ipm == null; });
    if (needsDaily) {
      Logger.log('Step 5b: Daily metrics (some missing, fetching)...');
      try {
        var dailyMetrics = fetchCreativeDailyMetrics(campaignId, lookbackDays);
        var dmById = {};
        dailyMetrics.forEach(function(r) { dmById[String(r.creative_id)] = r; });
        merged.forEach(function(m) {
          var dm = dmById[String(m.creative_id)];
          if (dm) {
            var drpi = pf(dm.rpi); if (drpi != null) m.rpi = drpi;
            var diti = pf(dm.iti); if (diti != null) m.iti = diti;
            var dipm = pf(dm.ipm); if (dipm != null) m.ipm = dipm;
          }
        });
        Logger.log('Daily metrics merged for ' + dailyMetrics.length + ' creatives');
      } catch(e) { Logger.log('Daily metrics fallback: ' + e.message); }
    } else {
      Logger.log('Step 5b: Skipped (Query E already has iti/ipm)');
    }

    Logger.log('Step 6: Analysis...');
    var config = { campaign_type: campaignType, mco_enabled: mcoEnabled, kpi_target: null, app_id: appId, app_name: appName };
    var result = analyzeCreativePerformance(merged, statusLog, config, lookbackDays);

    // Always override statusLog with the fresh query result (Analysis.gs may have its own version)
    result.statusLog = statusLog;

    // Patch result.creativePerf with new fields that Analysis.gs doesn't know about
    // Build lookup map from merged (which has all our new fields)
    var mergedById = {};
    merged.forEach(function(m) { mergedById[String(m.creative_id)] = m; });
    if (result.creativePerf) {
      result.creativePerf.forEach(function(cp) {
        var m = mergedById[String(cp.creative_id)];
        if (m) {
          // Fields Analysis.gs drops — patch them back in
          cp.iti            = m.iti;
          cp.ipm            = m.ipm;
          cp.roas_d1        = m.roas_d1;
          cp.rpa            = m.rpa;
          cp.rpa_lower_ci   = m.rpa_lower_ci;
          cp.rpa_upper_ci   = m.rpa_upper_ci;
          cp.rpa_ci_delta   = m.rpa_ci_delta;
          cp.rpa_ci_range   = m.rpa_ci_range;
          cp.ci_range       = m.ci_range;
          cp.target_events_d7 = m.target_events_d7;
          cp.target_event_name = m.target_event_name;
          cp.campaign_goal_1 = m.campaign_goal_1;
          cp.campaign_goal_2 = m.campaign_goal_2;
          cp.is_cpa_campaign = m.is_cpa_campaign;
          cp.roas_lower_ci  = m.roas_lower_ci;
          cp.roas_upper_ci  = m.roas_upper_ci;
          cp.is_video       = m.is_video;
          cp.is_interactive = m.is_interactive;
          cp.external_id    = m.external_id;
          // Required by frontend weighted (ratio-of-sums) aggregations:
          cp.revenue        = m.revenue;    // weight for ROAS
          cp.installs       = m.installs;   // weight for RPI
          cp.paused_date    = m.paused_date || cp.paused_date;
        }
      });
      Logger.log('Patched creativePerf with new fields for ' + result.creativePerf.length + ' rows');
      if (result.creativePerf.length > 0) Logger.log('Patched row0: iti=' + result.creativePerf[0].iti + ' roas_d1=' + result.creativePerf[0].roas_d1 + ' rpa=' + result.creativePerf[0].rpa + ' rpa_ci_range=' + result.creativePerf[0].rpa_ci_range);
    }

    result.appName = appName;
    result.appId = appId;
    result.mcoEnabled = mcoEnabled;
    result.campType = campaignType || result.campType;
    result.campTypeLabel = getCampaignLabel(result.campType);
    if (optState) result.optimizationState = optState;
    result.availableCampaigns = campaigns.map(function(c){ return {campaign_id:c.campaign_id, campaign_name:c.campaign_name, app_id:c.app_id}; });

    // Format-level aggregate metrics — grouped by MCO Inventory Group
    var fmtMetrics = {};
    merged.forEach(function(r) {
      var f = toMcoGroup(r.competing_group) || 'Unknown';
      if (!fmtMetrics[f]) fmtMetrics[f] = { format: f, spend: 0, revenue: 0, rev1S: 0, inst1S: 0, custRevS: 0, revS: 0 };
      var m = fmtMetrics[f];
      var rev = r.revenue || 0;
      m.spend += (r.spend || 0);
      m.revenue += rev;
      // Weighted ratio-of-sums: RPI = Σrev_d1/Σinstalls, ROAS = Σcust_rev/Σrev
      if (r.rpi != null && r.installs > 0) { m.rev1S += r.rpi * r.installs; m.inst1S += r.installs; }
      if (r.roas != null && rev > 0) { m.custRevS += r.roas * rev; m.revS += rev; }
    });
    result.formatMetrics = Object.keys(fmtMetrics).map(function(k) {
      var m = fmtMetrics[k];
      return {
        format: m.format,
        revenue: Math.round(m.revenue),
        spend: Math.round(m.spend),
        rpi: m.inst1S > 0 ? parseFloat((m.rev1S / m.inst1S).toFixed(2)) : null,
        roas_d7: m.revS > 0 ? parseFloat((m.custRevS / m.revS).toFixed(4)) : null,
      };
    }).sort(function(a,b){ return b.revenue - a.revenue; });

    // ─── BATCH 2: Daily format + Type breakdown + Campaign meta (parallel) ──
    Logger.log('Batch 2: DailyFormat + TypeBreakdown + Meta (parallel)...');
    var t2 = new Date().getTime();
    var b2SQLs = {
      dailyFmt:  buildDailyFormatMetricsSQL(campaignId, lookbackDays),
      typeBreak: buildTypeBreakdownSQL(campaignId, lookbackDays),
      meta:      buildCampaignMetaSQL(campaignId),
      dailyCr:   buildDailyCreativeMetricsSQL(campaignId, lookbackDays),
      targetEvt: buildTargetEventSQL(campaignId),
      pauseLog:  buildPauseLogSQL(campaignId, lookbackDays),
      impInst:   buildImpressionInstallSQL(campaignId, lookbackDays),
      queuing:   buildQueueingSQL(campaignId)   || 'SELECT 1 AS _skip',
      exploring: buildExploringSQL(campaignId)  || 'SELECT 1 AS _skip',
      optimizing:buildOptimizingSQL(campaignId) || 'SELECT 1 AS _skip'
      // campBasic/campCohort REMOVED — computed from merged[] for perfect consistency + speed
    };
    var b2 = runSQLParallel(b2SQLs);
    Logger.log('Batch 2 done in ' + Math.round((new Date().getTime()-t2)/1000) + 's');

    // Parse daily format metrics
    result.dailyFormatMetrics = [];
    try {
      result.dailyFormatMetrics = (b2.dailyFmt || []).map(function(r) {
        return {
          dt: String(r.dt).substring(0, 10),
          format: r.creative_format,
          revenue: parseFloat(r.revenue_d7) || 0,
          rpi: pf(r.rpi_d1),
          roas_d7: pf(r.roas_d7),
          roas_d1: pf(r.roas_d1),
          rpa: pf(r.rpa_d7),
          ipm: pf(r.ipm),
        };
      });
      Logger.log('Daily format: ' + result.dailyFormatMetrics.length + ' rows');
    } catch(e) { Logger.log('Daily format parse failed: ' + e.message); }

    // Parse type breakdown
    result.typeBreakdown = [];
    try {
      result.typeBreakdown = (b2.typeBreak || []).map(function(r) {
        return {
          is_video: String(r.is_video),
          interactive: r.interactive_label || 'N/A',
          creative_count: parseInt(r.creative_count) || 0,
          spend: parseFloat(r.spend) || 0,
          revenue_d7: parseFloat(r.revenue_d7) || 0,
          rpi: pf(r.rpi),
          roas_d7: pf(r.roas_d7),
          iti: pf(r.iti),
        };
      });
      Logger.log('Type breakdown: ' + result.typeBreakdown.length + ' rows');
    } catch(e) { Logger.log('Type breakdown parse failed: ' + e.message); }

    // Parse campaign meta (now includes ad groups, goals, creative selection method)
    result.viewClickTolerance = null;
    result.vtCap = null;
    result.campaignInfo = null;
    result.adGroups = [];
    try {
      var metaRows = b2.meta || [];
      if (metaRows.length > 0) {
        var m0 = metaRows[0];
        result.viewClickTolerance = m0.view_click_tolerance || null;
        result.vtCap = m0.vt_cap != null ? parseFloat(m0.vt_cap) : null;
        result.campaignInfo = {
          campaign_id: m0.campaign_id,
          campaign_state: m0.campaign_state || null,
          campaign_type: m0.campaign_type || null,
          optimization_state: m0.current_optimization_state || null,
          creative_selection_method: m0.creative_selection_method || null,
          goal_1: m0.goal_1 || null,
          goal_1_value: m0.goal_1_value != null ? parseFloat(m0.goal_1_value) : null,
          goal_2: m0.goal_2 || null,
          goal_2_value: m0.goal_2_value != null ? parseFloat(m0.goal_2_value) : null,
          vt_cap: result.vtCap,
          view_click_tolerance: result.viewClickTolerance,
          target_event_name: m0.target_event_name || null,
          dest_app_id: m0.dest_app_id || null,
        };
        // Extract distinct ad groups
        var agMap = {};
        metaRows.forEach(function(r) {
          if (r.ad_group_id && !agMap[r.ad_group_id]) {
            agMap[r.ad_group_id] = { id: r.ad_group_id, name: r.ad_group_name || 'Ad Group ' + r.ad_group_id };
          }
        });
        result.adGroups = Object.keys(agMap).map(function(k) { return agMap[k]; });
        Logger.log('Campaign info parsed: ' + result.adGroups.length + ' ad groups');
      }
      // Override mcoEnabled from Batch 2 campaignInfo (more reliable than Batch 1 config)
      if (result.campaignInfo && result.campaignInfo.creative_selection_method) {
        var b2Mco = result.campaignInfo.creative_selection_method.indexOf('MCO') >= 0;
        if (b2Mco !== mcoEnabled) {
          Logger.log('MCO override: Batch1=' + mcoEnabled + ' → Batch2=' + b2Mco + ' (from ' + result.campaignInfo.creative_selection_method + ')');
          mcoEnabled = b2Mco;
          result.mcoEnabled = b2Mco;
          // Fix recommendations: remove wrong Free-Floating/MCO-specific recs
          if (result.recommendations) {
            result.recommendations = result.recommendations.filter(function(r) {
              var txt = (r.title || '').toLowerCase();
              if (b2Mco && txt.indexOf('free-floating') >= 0) return false; // remove wrong FF rec
              if (!b2Mco && (txt.indexOf('competing group') >= 0 || txt.indexOf('exceeding 20% sow') >= 0 || txt.indexOf('below recommended count') >= 0)) return false; // remove MCO-specific recs
              return true;
            });
            // Add correct rec if missing
            if (b2Mco) {
              // Was wrongly Free-Floating, now MCO — no need to add anything
            } else {
              // Was wrongly MCO, now Free-Floating — add FF rec
              result.recommendations.unshift({
                level: 'warning',
                title: 'Campaign is using Free-Floating (random creative selection)',
                body: 'Creatives are selected randomly instead of by performance. Consider enabling MCO for data-driven creative selection — MCO allocates impressions to the highest-performing creatives based on ITI. Contact your CST to enable MCO.'
              });
            }
          }
        }
      }
    } catch(e) { Logger.log('Campaign meta parse failed: ' + e.message); }

    // Parse daily creative metrics (per-CID daily data for charts)
    result.dailyCreativeMetrics = [];
    try {
      result.dailyCreativeMetrics = (b2.dailyCr || []).map(function(r) {
        return {
          dt: String(r.dt).substring(0, 10),
          creative_id: String(r.creative_id),
          spend: parseFloat(r.spend) || 0,
          rpi: pf(r.rpi),
          ipm: pf(r.ipm),
          roas_d7: pf(r.roas_d7),
          roas_d1: pf(r.roas_d1),
          rpa: pf(r.rpa),
        };
      });
      Logger.log('Daily creative: ' + result.dailyCreativeMetrics.length + ' rows');
    } catch(e) { Logger.log('Daily creative parse failed: ' + e.message); }

    // Parse lifecycle states from three PDT queries (queuing / exploring / optimizing)
    // These are mutually exclusive. Paused creatives won't appear in any set.
    // Priority: queuing > exploring > optimizing
    try {
      function buildCidSet(rows) {
        var s = {};
        (rows||[]).forEach(function(r) { if (r.creative_id && String(r.creative_id) !== '1') s[String(r.creative_id)] = true; });
        return s;
      }
      var queuingSet   = buildCidSet(b2.queuing);
      var exploringSet = buildCidSet(b2.exploring);
      var optimizingSet= buildCidSet(b2.optimizing);
      Logger.log('Lifecycle sets — queuing:' + Object.keys(queuingSet).length + ' exploring:' + Object.keys(exploringSet).length + ' optimizing:' + Object.keys(optimizingSet).length);
      if (result.creativePerf) {
        result.creativePerf.forEach(function(cp) {
          var cid = String(cp.creative_id);
          // The three states are mutually exclusive in the source data (queuing and
          // exploring differ only by current_status), so lifecycle_state carries all
          // three. It used to collapse queuing into 'exploring' with is_queuing as a
          // side flag, which made a queuing creative match BOTH the queuing and the
          // exploring filter and count twice in the pipeline totals.
          if (queuingSet[cid]) {
            cp.lifecycle_state = 'queuing';
          } else if (exploringSet[cid]) {
            cp.lifecycle_state = 'exploring';
          } else if (optimizingSet[cid]) {
            cp.lifecycle_state = 'optimizing';
          } else {
            cp.lifecycle_state = null; // paused or not in the PDT → no state
          }
          cp.is_queuing = (cp.lifecycle_state === 'queuing'); // kept as an alias for the UI
        });
      }
    } catch(e) { Logger.log('Lifecycle/queuing parse failed: ' + e.message); }

    // Parse target event name
    result.targetEventName = null;
    try {
      var teRows = b2.targetEvt || [];
      if (teRows.length > 0 && teRows[0].target_event_name) {
        result.targetEventName = teRows[0].target_event_name;
      }
      Logger.log('Target event: ' + (result.targetEventName || 'none'));
    } catch(e) { Logger.log('Target event parse failed: ' + e.message); }

    // Parse impressions + installs
    try {
      var iiRows = b2.impInst || [];
      var iiMap = {};
      iiRows.forEach(function(r) { if (r.creative_id) iiMap[String(r.creative_id)] = { impressions: parseInt(r.impressions)||0, installs: parseInt(r.installs)||0 }; });
      if (result.creativePerf && Object.keys(iiMap).length > 0) {
        result.creativePerf.forEach(function(cp) {
          var ii = iiMap[String(cp.creative_id)];
          if (ii) { cp.impressions = ii.impressions; cp.installs_cstudio = ii.installs; }
        });
        Logger.log('ImpInst: patched for ' + Object.keys(iiMap).length + ' creatives');
      }
    } catch(e) { Logger.log('ImpInst parse failed: ' + e.message); }

    // Parse pause log — new SQL returns: pause_method, current_pause_date, creative_id, external_id, latest_enabled_date
    try {
      var plRows = b2.pauseLog || [];
      var freshStatusLog = [];
      var plMap = {}; // creative_id → {pause_method, paused_date, external_id, latest_enabled_date}

      plRows.forEach(function(r) {
        var cid = String(r.creative_id);
        // Build lookup map for all creatives (not just paused ones)
        plMap[cid] = {
          pause_method:        r.pause_method || null,
          paused_date:         r.current_pause_date || null,
          external_id:         r.external_id || null,
          latest_enabled_date: r.latest_enabled_date || null
        };
        // statusLog: only include paused creatives
        if (r.current_pause_date && campaignCids[cid]) {
          freshStatusLog.push({
            date:        r.current_pause_date,
            creative_id: cid,
            change_type: 'paused',
            changed_by:  r.pause_method || 'unknown'
          });
        }
      });

      freshStatusLog.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });

      if (freshStatusLog.length > 0 || plRows.length > 0) {
        result.statusLog = freshStatusLog;
        Logger.log('PauseLog: ' + plRows.length + ' creatives, ' + freshStatusLog.length + ' paused');
      } else {
        // Fallback to inventory-based statusLog
        var fallbackLog = [];
        (b1.inventory || []).forEach(function(c) {
          if (c.paused_date && campaignCids[String(c.creative_id)]) {
            fallbackLog.push({ date: c.paused_date, creative_id: String(c.creative_id), change_type: 'paused', changed_by: c.pause_method || 'unknown' });
          }
        });
        fallbackLog.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });
        result.statusLog = fallbackLog;
        Logger.log('PauseLog: 0 rows, fallback to inventory (' + fallbackLog.length + ')');
      }

      // Patch external_id, paused_date, latest_enabled_date into creativePerf
      if (result.creativePerf && Object.keys(plMap).length > 0) {
        result.creativePerf.forEach(function(cp) {
          var pl = plMap[String(cp.creative_id)];
          if (pl) {
            if (pl.external_id)         cp.external_id         = pl.external_id;
            if (pl.paused_date)         cp.paused_date         = pl.paused_date;
            if (pl.latest_enabled_date) cp.latest_enabled_date = pl.latest_enabled_date;
          }
        });
        Logger.log('PauseLog: patched external_id/dates for ' + Object.keys(plMap).length + ' creatives');
      }
    } catch(e) {
      Logger.log('PauseLog parse failed: ' + e.message);
    }

    // Compute campaign-level performance from merged[] (same data as creative rows → perfect consistency)
    result.campaignPerf = null;
    try {
      var cpSpend=0, cpRevD7=0, cpCustRevD7=0, cpRevD1=0, cpCustRevD1=0, cpInst1=0, cpInstD7=0, cpImp=0, cpEvt=0;
      merged.forEach(function(m) {
        cpSpend += (m.spend || 0);
        var rev = m.revenue || 0;
        cpRevD7 += rev;
        if (m.roas != null && rev > 0) cpCustRevD7 += m.roas * rev;
        if (m.roas_d1 != null && rev > 0) cpCustRevD1 += m.roas_d1 * rev;
        if (m.rpi != null && m.installs > 0) cpRevD1 += m.rpi * m.installs;
        cpInst1 += (m.installs || 0);
        if (m.iti != null && m.impressions > 0) { cpInstD7 += m.iti * m.impressions; cpImp += m.impressions; }
        cpEvt += (m.target_events_d7 || 0);
      });
      if (merged.length > 0) {
        result.campaignPerf = {
          spend: cpSpend,
          iti: cpImp > 0 ? cpInstD7 / cpImp : null,
          ipm: cpImp > 0 ? cpInstD7 / cpImp * 1000 : null,
          rpi: cpInst1 > 0 ? cpRevD1 / cpInst1 : null,
          impressions: Math.round(cpImp),
          installs: Math.round(cpInst1),
          revenue_d7: cpRevD7,
          roas_d7: cpRevD7 > 0 ? cpCustRevD7 / cpRevD7 : null,
          roas_d1: cpRevD7 > 0 ? cpCustRevD1 / cpRevD7 : null,
          rpa: cpEvt > 0 ? cpRevD7 / cpEvt : null,
        };
        Logger.log('Campaign perf (from merged): spend=' + result.campaignPerf.spend + ' roas_d7=' + result.campaignPerf.roas_d7 + ' rpa=' + result.campaignPerf.rpa);
      }
    } catch(e) { Logger.log('Campaign perf compute failed: ' + e.message); }

    // ─── POST-PROCESS: Rebuild "Detach underperforming" recommendation ───
    // Only include creatives matching Poor Creative criteria:
    //   Low var CI (variance==='high') + RPI > campaign avg + bad main metric
    // Protect sole-active creatives in their format group (recommend adding more instead)
    try {
      var isCpa = (result.campType === 'ua_cpa') || (result.optimizationState || '').indexOf('cpa') >= 0 || (result.optimizationState || '').indexOf('rpa') >= 0;
      // Use campaignPerf weighted values (SAME numbers shown in KPI cards and Campaign table row)
      // so "below campaign average" in the rec matches what the user sees on screen.
      var campAvgRoas = (result.campaignPerf && result.campaignPerf.roas_d7 != null) ? result.campaignPerf.roas_d7 : null;
      var campAvgRpi  = (result.campaignPerf && result.campaignPerf.rpi != null) ? result.campaignPerf.rpi : null;
      var campAvgRpa  = (result.campaignPerf && result.campaignPerf.rpa != null) ? result.campaignPerf.rpa : null;
      // Fallback to simple averages only if campaignPerf missing
      if (campAvgRoas == null || campAvgRpi == null) {
        var cpRoasS=0,cpRoasN=0,cpRpiS=0,cpRpiN=0,cpRpaS=0,cpRpaN=0;
        merged.forEach(function(m){
          if(m.roas!=null){cpRoasS+=m.roas;cpRoasN++;}
          if(m.rpi!=null){cpRpiS+=m.rpi;cpRpiN++;}
          if(m.rpa!=null){cpRpaS+=m.rpa;cpRpaN++;}
        });
        if(campAvgRoas==null)campAvgRoas=cpRoasN>0?cpRoasS/cpRoasN:null;
        if(campAvgRpi==null)campAvgRpi=cpRpiN>0?cpRpiS/cpRpiN:null;
        if(campAvgRpa==null)campAvgRpa=cpRpaN>0?cpRpaS/cpRpaN:null;
      }

      // Count active creatives per format group
      var activePerGroup={};
      merged.forEach(function(m){
        if(m.status==='active'){
          var grp=m.competing_group||m.ad_format||'unknown';
          activePerGroup[grp]=(activePerGroup[grp]||0)+1;
        }
      });

      // Find Poor Creatives: Low var CI + RPI > campaign avg + bad main metric
      var poorCids=[], poorPausedCids=[], soleActiveFormats=[];
      merged.forEach(function(m){
        var lowVar=(m.variance==='high'); // 'high' in backend = narrow CI = high confidence
        var expensiveRpi=campAvgRpi!=null&&m.rpi!=null&&m.rpi>campAvgRpi;
        var badMetric=isCpa?(campAvgRpa!=null&&m.rpa!=null&&m.rpa>campAvgRpa):(campAvgRoas!=null&&m.roas!=null&&m.roas<campAvgRoas);
        if(lowVar&&expensiveRpi&&badMetric){
          if(m.status!=='active'){
            poorPausedCids.push(String(m.creative_id));
            return;
          }
          var grp=m.competing_group||m.ad_format||'unknown';
          if((activePerGroup[grp]||0)<=1){
            // Sole active in this group — don't recommend detach, recommend adding more
            if(soleActiveFormats.indexOf(grp)<0)soleActiveFormats.push(grp);
          } else {
            poorCids.push(String(m.creative_id));
          }
        }
      });

      // Remove old "Detach" recommendation and replace with new one
      if(result.recommendations){
        result.recommendations=result.recommendations.filter(function(r){
          var txt=(r.title||'')+(r.text||'')+(r.body||'');
          return txt.toLowerCase().indexOf('detach')< 0 && txt.toLowerCase().indexOf('underperforming creatives')<0;
        });
        // Add new detach rec (only if there are qualifying active poor creatives)
        if(poorCids.length>0){
          var pausedNote=poorPausedCids.length>0?' ('+poorPausedCids.length+' additional poor creatives already paused)':'';
          result.recommendations.push({
            level:'warning',
            title:'Detach '+poorCids.length+' confirmed poor active creative'+(poorCids.length>1?'s':''),
            body:'These active creatives have low variance CI (high confidence), RPI above campaign average, and '+(isCpa?'RPA above':'ROAS below')+' campaign average: '+poorCids.join(', ')+'. Detach from this campaign only — don\'t pause globally. Limit to 20% of GR per round. Keep at least 1 per format.'+pausedNote
          });
        } else if(poorPausedCids.length>0){
          result.recommendations.push({
            level:'info',
            title:poorPausedCids.length+' poor creative'+(poorPausedCids.length>1?'s':'')+' already paused',
            body:'Creatives matching poor performance criteria (high confidence, RPI above avg, '+(isCpa?'RPA above':'ROAS below')+' avg) are already paused: '+poorPausedCids.slice(0,5).join(', ')+(poorPausedCids.length>5?'...':'')+'. No further action needed for these.'
          });
        }
        // Add "add more creatives" rec for sole-active underperformer formats
        if(soleActiveFormats.length>0){
          result.recommendations.push({
            level:'info',
            title:soleActiveFormats.length+' format'+(soleActiveFormats.length>1?'s have':' has')+' only 1 active creative (underperforming)',
            body:'These formats have a single active creative with poor performance: '+soleActiveFormats.join(', ')+'. Even though it underperforms, do NOT detach — it\'s the only live creative in the format. Upload new creatives to this format first, then re-evaluate once alternatives have data.'
          });
        }
      }
      Logger.log('Detach rec rebuilt: '+poorCids.length+' poor CIDs, '+soleActiveFormats.length+' sole-active formats');
    } catch(e) { Logger.log('Detach rec post-process failed: '+e.message); }

    // ═══ Enhanced recommendations from Batch 2 data ═══
    try {
      if (result.recommendations) {
        var recs = result.recommendations;

        // 1. Lifecycle-based recs (MCO only — Free-Floating has no WCS/throttle)
        var exploringCnt = 0, queuingCnt = 0, optimizingCnt = 0, zeroSpendLive = 0;
        (result.creativePerf || []).forEach(function(c) {
          if (c.status !== 'active') return;
          // One creative, one state — see MCO_RULES.creative_states.
          if (c.lifecycle_state === 'queuing') queuingCnt++;
          else if (c.lifecycle_state === 'exploring') exploringCnt++;
          else if (c.lifecycle_state === 'optimizing') optimizingCnt++;
          if ((c.spend || 0) <= 0) zeroSpendLive++;
        });

        if (mcoEnabled) {
          if (queuingCnt > 0) {
            recs.push({
              level: 'info',
              title: queuingCnt + ' creative' + (queuingCnt > 1 ? 's' : '') + ' in throttle queue',
              body: 'These creatives are enabled but waiting for WCS exploration capacity. They\'ll start receiving impressions once capacity opens. This is normal for campaigns with many new uploads. If budgets were recently cut, queue capacity may have shrunk.'
            });
          }

          if (exploringCnt > 0 && exploringCnt > optimizingCnt) {
            recs.push({
              level: 'warning',
              title: 'More exploring creatives (' + exploringCnt + ') than optimizing (' + optimizingCnt + ')',
              body: 'Most active creatives are still in WCS exploration (<25K impressions or <7 days). Campaign performance may be volatile until these creatives calibrate. Avoid pausing or detaching during exploration — wait for calibration data.'
            });
          }

          // 2. Auto-Pause pattern recs (MCO only)
          var recentAutoPauses = 0;
          var cutoff14 = new Date(); cutoff14.setDate(cutoff14.getDate() - 14);
          (result.statusLog || []).forEach(function(e) {
            if (e.change_type !== 'paused') return;
            var by = (e.changed_by || '').toLowerCase();
            if (by.indexOf('mab') < 0 && by.indexOf('auto') < 0) return;
            var d = new Date(e.change_date || e.dt || '');
            if (d >= cutoff14) recentAutoPauses++;
          });

          if (recentAutoPauses >= 5) {
            recs.push({
              level: 'warning',
              title: recentAutoPauses + ' creatives auto-paused in the last 14 days',
              body: 'Frequent auto-pauses suggest new creatives are failing to compete after WCS exploration ends. Consider uploading creatives with stronger install-rate potential (higher ITI). Cloning paused creatives with good ROAS but low ITI gives them a fresh WCS period, but there is no guarantee MCO will select them.'
            });
          }
        }

        // Zero-spend active creatives (both MCO and Free-Floating)
        if (zeroSpendLive > 0 && !queuingCnt) {
          var zeroMsg = mcoEnabled
            ? 'These creatives are enabled but received no spend. They may be losing ITI competition in MCO. Check if they\'re in the throttle queue or have eligibility mismatches.'
            : 'These creatives are enabled but received no spend. In Free-Floating mode, this may indicate eligibility mismatches (wrong orientation/ad type for available inventory).';
          recs.push({
            level: 'warning',
            title: zeroSpendLive + ' active creative' + (zeroSpendLive > 1 ? 's' : '') + ' with zero spend',
            body: zeroMsg
          });
        }

        // 3. Campaign performance recs (both MCO and Free-Floating)
        var cp = result.campaignPerf;
        if (cp) {
          if (cp.roas_d7 != null && cp.roas_d7 < 0.02) {
            recs.push({
              level: 'critical',
              title: 'Campaign D7 ROAS is very low (' + (cp.roas_d7 * 100).toFixed(2) + '%)',
              body: 'D7 ROAS is under 2%. Review targeting, campaign goals, and whether the creative mix is driving quality installs.'
            });
          }
          if (cp.rpi != null && cp.rpi > 50) {
            recs.push({
              level: 'warning',
              title: 'High campaign RPI ($' + cp.rpi.toFixed(2) + ')',
              body: 'Revenue per install is elevated. This may indicate low install volume or expensive inventory.'
            });
          }
        }

        // 4. Spend shift recs (both MCO and Free-Floating)
        var shifts = result.spendShifts || [];
        var decliningFormats = shifts.filter(function(s) { return s.direction === 'declining' && s.pctChange < -30; });
        var growingFormats = shifts.filter(function(s) { return s.direction === 'growing' && s.pctChange > 50; });

        if (decliningFormats.length > 0) {
          recs.push({
            level: 'warning',
            title: decliningFormats.length + ' format' + (decliningFormats.length > 1 ? 's' : '') + ' with >30% spend decline',
            body: 'Declining formats: ' + decliningFormats.map(function(s) { return s.format + ' (' + s.pctChange + '%)'; }).join(', ') + '. Check if creatives were paused or lost competition. Consider uploading fresh creatives.'
          });
        }

        if (growingFormats.length > 0) {
          recs.push({
            level: 'success',
            title: growingFormats.length + ' format' + (growingFormats.length > 1 ? 's' : '') + ' with >50% spend growth',
            body: 'Growing formats: ' + growingFormats.map(function(s) { return s.format + ' (+' + s.pctChange + '%)'; }).join(', ') + '. Add more creatives to diversify and reduce concentration risk.'
          });
        }

        // Sort: critical first, then warning, info, success
        var levelOrder = { critical: 0, warning: 1, info: 2, success: 3 };
        recs.sort(function(a, b) { return (levelOrder[a.level] || 9) - (levelOrder[b.level] || 9); });
      }
      Logger.log('Enhanced recs generated: mco=' + mcoEnabled + ' exploring=' + exploringCnt + ' queuing=' + queuingCnt);
    } catch(e) { Logger.log('Enhanced recs failed: ' + e.message); }

    var _logDuration = Math.round((new Date().getTime() - _logStart) / 1000);
    var ci = result.campaignInfo || {};
    logUsage('analyze', {
      campaignId: campaignId,
      appId: appId || ci.dest_app_id || '',
      campaignType: ci.campaign_type || campaignType || '',
      model: ci.optimization_state || result.optimizationState || '',
      selection: ci.creative_selection_method || (mcoEnabled ? 'MCO' : 'Free-floating'),
      goal2: ci.goal_2 ? (ci.goal_2 + (ci.goal_2_value != null ? ' = ' + ci.goal_2_value : '')) : '',
      vtCap: result.vtCap != null ? result.vtCap + 'x' : '',
      viewclick: result.viewClickTolerance || '',
      targetEvent: ci.target_event_name || result.targetEventName || '',
      lookbackDays: lookbackDays,
      duration: _logDuration,
      result: 'ok (' + (result.totalCreatives||0) + ' creatives)'
    });

    Logger.log('Done! '  + result.totalCreatives + ' creatives, ' + result.recommendations.length + ' recs');
    return result;
  } catch(e) {
    var _logDuration2 = Math.round((new Date().getTime() - _logStart) / 1000);
    logUsage('analyze_error', {
      campaignId: searchInput,
      lookbackDays: lookbackDays,
      duration: _logDuration2,
      result: 'error: ' + e.message
    });
    Logger.log('Error: ' + e.message + '\n' + e.stack);
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════
// SQL BUILDER HELPERS (return SQL string without running)
// Used by runSQLParallel for batch execution
// ═══════════════════════════════════════════════════════════
function buildCreativeLevelPerfSQL(campaignId, lookbackDays) {
  var pdt = getPDT();
  var dtStart = "DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CAST(CAST(DATE_TRUNC('DAY', CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP))";
  var dtEnd   = "DATE_ADD('day', " + lookbackDays + ", DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CAST(CAST(DATE_TRUNC('DAY', CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP)))";
  return [
    "WITH pinpoint__creatives_simple AS (",
    "  SELECT c.id, c.state, c.inventory_format FROM pinpoint.public.creatives c",
    "),",
    "pinpoint__campaigns AS (",
    "  SELECT c.id, c.current_optimization_state, c.vt_cap FROM pinpoint.public.campaigns c",
    ")",
    "SELECT",
    "  revenue_summary.campaign_id,",
    "  revenue_summary.campaign_name,",
    "  cstudio__creative_format.creative_format_derived AS creative_format,",
    "  revenue_summary.customer_id,",
    "  revenue_summary.dest_app_id AS app_id,",
    "  revenue_summary.dest_app_name AS app_name,",
    "  revenue_summary.creative_id,",
    "  CASE WHEN revenue_summary.is_interactive = 'true' THEN 'Interactive'",
    "       WHEN revenue_summary.is_interactive = 'false' THEN 'Not Interactive'",
    "       ELSE 'N/A' END AS is_interactive,",
    "  revenue_summary.is_video_creative AS is_video,",
    "  pinpoint__creatives_simple.state AS creative_state,",
    "  revenue_summary.campaign_type,",
    "  pinpoint__campaigns.current_optimization_state AS optimization_state,",
    "  pinpoint__creatives_simple.inventory_format AS competing_group,",
    "  revenue_summary.target_event_name,",
    "  CAST(revenue_summary.target_event_id AS VARCHAR) AS target_event_id,",
    "  revenue_summary.campaign_goal_1,",
    "  revenue_summary.campaign_goal_2,",
    "  COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) AS revenue_d7,",
    "  COALESCE(SUM(revenue_summary.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.installs_d1), 0), 0) AS rpi_d1,",
    "  CAST(COALESCE(SUM(revenue_summary.installs_d7), 0) AS DOUBLE) / NULLIF(COALESCE(SUM(revenue_summary.impressions), 0), 0) AS iti,",
    "  COALESCE(SUM(revenue_summary.installs_d7), 0) / CAST(NULLIF(COALESCE(SUM(revenue_summary.impressions), 0), 0) AS DOUBLE) * 1000 AS ipm,",
    "  COALESCE(SUM(revenue_summary.coalesced_customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0), 0) AS roas_d7,",
    "  COALESCE(SUM(revenue_summary.coalesced_customer_revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0), 0) AS roas_d1,",
    "  COALESCE(SUM(revenue_summary.spend_micros / CAST(1e6 AS DOUBLE)), 0) AS spend,",
    "  COALESCE(SUM(revenue_summary.installs_d1), 0) AS installs,",
    "  COALESCE(SUM(revenue_summary.target_events_first_d7), 0) AS target_events_d7,",
    "  COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.target_events_first_d7), 0), 0) AS rpa_d7,",
    "  CASE WHEN COALESCE(SUM(revenue_summary.customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) < 0.0005 THEN NULL",
    "       ELSE 1.96 * SQRT(COALESCE(SUM(revenue_summary.incremental_squared_capped_customer_revenue_d7), 0)) / COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) END AS roas_ci_margin,",
    "  CASE WHEN COALESCE(SUM(revenue_summary.customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) < 0.0005 THEN NULL",
    "       ELSE COALESCE(SUM(revenue_summary.customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) - 1.96 * SQRT(COALESCE(SUM(revenue_summary.incremental_squared_capped_customer_revenue_d7), 0)) / COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) END AS roas_d7_lower_ci,",
    "  CASE WHEN COALESCE(SUM(revenue_summary.customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) < 0.0005 THEN NULL",
    "       ELSE COALESCE(SUM(revenue_summary.customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) + 1.96 * SQRT(COALESCE(SUM(revenue_summary.incremental_squared_capped_customer_revenue_d7), 0)) / COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) END AS roas_d7_upper_ci,",
    "  CASE WHEN COALESCE(SUM(revenue_summary.target_events_first_d7), 0) < 5 THEN NULL",
    "       ELSE COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / (COALESCE(SUM(revenue_summary.target_events_first_d7), 0) + 1.96 * SQRT(COALESCE(SUM(revenue_summary.target_events_first_d7), 0))) END AS rpa_d7_lower_ci,",
    "  CASE WHEN COALESCE(SUM(revenue_summary.target_events_first_d7), 0) < 5 THEN NULL",
    "       ELSE COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / (COALESCE(SUM(revenue_summary.target_events_first_d7), 0) - 1.96 * SQRT(COALESCE(SUM(revenue_summary.target_events_first_d7), 0))) END AS rpa_d7_upper_ci,",
    "  CASE WHEN COALESCE(SUM(revenue_summary.target_events_first_d7), 0) < 5 THEN NULL",
    "       ELSE (COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / (COALESCE(SUM(revenue_summary.target_events_first_d7), 0) - 1.96 * SQRT(COALESCE(SUM(revenue_summary.target_events_first_d7), 0))) - COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.target_events_first_d7), 0), 0)) / NULLIF(COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.target_events_first_d7), 0), 0), 0) END AS rpa_ci_delta",
    "FROM analytics.daily_attr_event_d7 AS revenue_summary",
    "LEFT JOIN pinpoint__campaigns ON revenue_summary.campaign_id = pinpoint__campaigns.id",
    "LEFT JOIN pinpoint__creatives_simple ON revenue_summary.creative_id = pinpoint__creatives_simple.id",
    "LEFT JOIN " + pdt + " AS cstudio__creative_format ON pinpoint__creatives_simple.id = cstudio__creative_format.creative_id",
    "WHERE (from_iso8601_timestamp(revenue_summary.dt)) >= " + dtStart,
    "  AND (from_iso8601_timestamp(revenue_summary.dt)) < " + dtEnd,
    "  AND revenue_summary.campaign_id = " + campaignId,
    "  AND revenue_summary.is_uncredited <> 'true'",
    "GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17",
    "ORDER BY 18 DESC",
    "LIMIT 500",
  ].join('\n');
}

function buildCreativeInventorySQL(campaignId) {
  var pdt = getPDT();
  return [
    "WITH cstudio_daily_analytics_v1 AS (",
    "  SELECT a.*, c.external_id FROM hive.bi.cstudio_analytics_daily_v1 a",
    "  LEFT JOIN pinpoint.public.creatives c ON c.id = a.creative_id",
    "),",
    "pinpoint__creatives_simple AS (",
    "  SELECT c.id, c.display_name, c.state, c.created_at, c.is_interactive, c.inventory_format,",
    "    l.display_name AS creative_language_name",
    "  FROM pinpoint.public.creatives c LEFT JOIN pinpoint.public.languages l ON c.language_id = l.id",
    "),",
    "creative_state_events AS (",
    "  WITH t AS (SELECT b.creative_id, c.state,",
    "    MAX(CASE WHEN old_value IS NULL AND new_value='enabled' THEN changed_at WHEN old_value='deleted' AND new_value='enabled' THEN changed_at WHEN old_value='paused' AND new_value='enabled' THEN changed_at END) AS max_enabled_date,",
    "    MAX(CASE WHEN old_value='enabled' AND new_value='paused' THEN changed_at END) AS paused_date",
    "  FROM pinpoint.public.creative_state_events b LEFT JOIN pinpoint.public.creatives c ON b.creative_id=c.id GROUP BY 1,2)",
    "  SELECT creative_id, CASE WHEN state<>'enabled' THEN paused_date ELSE NULL END AS current_pause_date FROM t",
    "),",
    "cstudio__creative_paused_by AS (",
    "  WITH mcd AS (SELECT creative_id, MAX(created_at) AS max_created_at FROM pinpoint.public.creative_events WHERE event_type='paused' GROUP BY 1),",
    "  mchd AS (SELECT creative_id, MAX(changed_at) AS max_changed_at FROM pinpoint.public.creative_state_events WHERE new_value='paused' GROUP BY 1)",
    "  SELECT a.creative_id, json_extract_scalar(a.payload, '$.source.source') AS pause_method",
    "  FROM pinpoint.public.creative_events a",
    "  LEFT JOIN mchd ON a.creative_id=mchd.creative_id LEFT JOIN mcd ON a.creative_id=mcd.creative_id",
    "  WHERE a.created_at=mcd.max_created_at AND a.event_type='paused'",
    "),",
    "pinpoint__apps AS (",
    "  SELECT apps.id, MAX(CASE WHEN csc.selection_strategy='multiarm-bandit' AND csc.enabled=True THEN 'MCO' WHEN csc.selection_strategy='random' AND csc.enabled=True THEN 'Free-floating' ELSE 'MCO' END) AS creative_selection_method",
    "  FROM pinpoint.public.apps apps LEFT JOIN pinpoint.public.creative_selection_configurations csc ON apps.id=csc.app_id GROUP BY 1",
    ")",
    "SELECT cstudio_daily_analytics_v1.dest_app_id AS app_id, cstudio_daily_analytics_v1.campaign_id,",
    "  cstudio_daily_analytics_v1.campaign_name, pinpoint__creatives_simple.id AS creative_id,",
    "  DATE_FORMAT(pinpoint__creatives_simple.created_at,'%Y-%m-%d') AS created_date,",
    "  DATE_FORMAT(creative_state_events.current_pause_date,'%Y-%m-%d') AS paused_date,",
    "  cstudio__creative_paused_by.pause_method,",
    "  pinpoint__creatives_simple.inventory_format AS competing_group,",
    "  cstudio__creative_format.creative_format_derived AS creative_format,",
    "  pinpoint__creatives_simple.state AS creative_state",
    "FROM cstudio_daily_analytics_v1",
    "LEFT JOIN pinpoint__apps ON cstudio_daily_analytics_v1.dest_app_id=pinpoint__apps.id",
    "LEFT JOIN pinpoint__creatives_simple ON cstudio_daily_analytics_v1.creative_id=pinpoint__creatives_simple.id",
    "LEFT JOIN " + pdt + " AS cstudio__creative_format ON cstudio_daily_analytics_v1.creative_id=cstudio__creative_format.creative_id",
    "LEFT JOIN creative_state_events ON cstudio_daily_analytics_v1.creative_id=creative_state_events.creative_id",
    "LEFT JOIN cstudio__creative_paused_by ON cstudio_daily_analytics_v1.creative_id=cstudio__creative_paused_by.creative_id",
    "WHERE cstudio_daily_analytics_v1.campaign_id=" + campaignId,
    "  AND (cstudio_daily_analytics_v1.campaign_type<>'reengagement' OR cstudio_daily_analytics_v1.campaign_type IS NULL)",
    "  AND (from_iso8601_timestamp(cstudio_daily_analytics_v1.dt))>=DATE_ADD('day',-30,CAST(CAST(DATE_TRUNC('DAY',CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP))",
    "  AND (from_iso8601_timestamp(cstudio_daily_analytics_v1.dt))<DATE_ADD('day',31,DATE_ADD('day',-30,CAST(CAST(DATE_TRUNC('DAY',CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP)))",
    "GROUP BY 1,2,3,4,5,6,7,8,9,10 ORDER BY 2 LIMIT 500",
  ].join('\n');
}

function buildCampaignConfigSQL(appId) {
  return [
    "WITH pinpoint__apps AS (",
    "  SELECT apps.id, apps.bundle_id,",
    "    MAX(CASE WHEN csc.selection_strategy = 'multiarm-bandit' AND csc.enabled = True THEN 'MCO'",
    "             WHEN csc.selection_strategy = 'random' AND csc.enabled = True THEN 'Free-floating'",
    "             ELSE NULL END) AS creative_selection_method",
    "  FROM pinpoint.public.apps apps",
    "  LEFT JOIN pinpoint.public.creative_selection_configurations csc ON apps.id = csc.app_id",
    "  WHERE apps.id = " + appId,
    "  GROUP BY 1, 2",
    "),",
    "cstudio_mco AS (",
    "  SELECT campaign_id,",
    "    BOOL_OR(creative_mco_status IN ('mab_won','mab_competing','mab_explore','mab_learning')) AS has_mco_activity",
    "  FROM hive.bi.cstudio_analytics_daily_v1",
    "  WHERE dest_app_id = " + appId,
    "    AND from_iso8601_timestamp(dt) >= DATE_ADD('day', -14, CURRENT_DATE)",
    "  GROUP BY 1",
    ")",
    "SELECT",
    "  c.id AS campaign_id,",
    "  c.display_name AS campaign_name,",
    "  c.app_id,",
    "  pa.bundle_id AS app_name,",
    "  c.campaign_type,",
    "  c.current_optimization_state AS optimization_state,",
    "  CASE",
    "    WHEN pa.creative_selection_method = 'MCO' THEN 'MCO'",
    "    WHEN cm.has_mco_activity = true THEN 'MCO'",
    "    WHEN pa.creative_selection_method IS NOT NULL THEN pa.creative_selection_method",
    "    ELSE 'Free-floating'",
    "  END AS mco_status",
    "FROM pinpoint.public.campaigns c",
    "LEFT JOIN pinpoint__apps pa ON c.app_id = pa.id",
    "LEFT JOIN cstudio_mco cm ON c.id = cm.campaign_id",
    "WHERE c.app_id = " + appId,
    "  AND c.state IN ('enabled', 'paused')",
    "ORDER BY c.id DESC",
    "LIMIT 50",
  ].join('\n');
}

function buildDailyFormatMetricsSQL(campaignId, lookbackDays) {
  return [
    "SELECT",
    "  CAST(from_iso8601_timestamp(r.dt) AS DATE) AS dt,",
    "  c.inventory_format AS creative_format,",
    "  COALESCE(SUM(r.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) AS revenue_d7,",
    "  COALESCE(SUM(r.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(SUM(r.installs_d1), 0) AS rpi_d1,",
    "  COALESCE(SUM(r.coalesced_customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(r.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0), 0) AS roas_d7,",
    "  COALESCE(SUM(r.coalesced_customer_revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(r.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0), 0) AS roas_d1,",
    "  CASE WHEN SUM(r.target_events_first_d7) < 5 THEN NULL ELSE COALESCE(SUM(r.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(SUM(r.target_events_first_d7), 0) END AS rpa_d7,",
    "  CAST(COALESCE(SUM(r.installs_d1), 0) AS DOUBLE) / NULLIF(SUM(r.impressions), 0) * 1000 AS ipm",
    "FROM analytics.daily_attr_event_d7 r",
    "LEFT JOIN pinpoint.public.creatives c ON r.creative_id = c.id",
    "WHERE r.campaign_id = " + campaignId,
    "  AND from_iso8601_timestamp(r.dt) >= DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CURRENT_DATE)",
    "  AND from_iso8601_timestamp(r.dt) < DATE_ADD('day', -" + DATA_BAKE_DAYS + ", CURRENT_DATE)",
    "  AND r.is_uncredited <> 'true'",
    "  AND c.inventory_format IS NOT NULL",
    "GROUP BY 1, 2",
    "ORDER BY 1, 2",
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// QUERY I: Daily metrics per creative (for CID-level charts)
// ═══════════════════════════════════════════════════════════
function buildDailyCreativeMetricsSQL(campaignId, lookbackDays) {
  return [
    "SELECT",
    "  CAST(from_iso8601_timestamp(r.dt) AS DATE) AS dt,",
    "  r.creative_id,",
    "  COALESCE(SUM(r.spend_micros / CAST(1e6 AS DOUBLE)), 0) AS spend,",
    "  COALESCE(SUM(r.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(SUM(r.installs_d1), 0) AS rpi,",
    "  CAST(COALESCE(SUM(r.installs_d1), 0) AS DOUBLE) / NULLIF(SUM(r.impressions), 0) * 1000 AS ipm,",
    "  COALESCE(SUM(r.coalesced_customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(r.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0), 0) AS roas_d7,",
    "  COALESCE(SUM(r.coalesced_customer_revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(r.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0), 0) AS roas_d1,",
    "  CASE WHEN SUM(r.target_events_first_d7) < 5 THEN NULL ELSE COALESCE(SUM(r.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(SUM(r.target_events_first_d7), 0) END AS rpa",
    "FROM analytics.daily_attr_event_d7 r",
    "WHERE r.campaign_id = " + campaignId,
    "  AND from_iso8601_timestamp(r.dt) >= DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CURRENT_DATE)",
    "  AND from_iso8601_timestamp(r.dt) < DATE_ADD('day', -" + DATA_BAKE_DAYS + ", CURRENT_DATE)",
    "  AND r.is_uncredited <> 'true'",
    "GROUP BY 1, 2",
    "ORDER BY 2, 1",
    "LIMIT 5000",
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// PDT AUTO-DISCOVERY — queue_creative_statistics
// Used by all three lifecycle queries (queuing / exploring / optimizing)
// ═══════════════════════════════════════════════════════════
var _queuePdtTable = null;
function getQueuePDT() {
  if (_queuePdtTable) return _queuePdtTable;
  var cache = CacheService.getScriptCache();
  var cached = cache.get('pdt_queue_creative_statistics');
  if (cached) { _queuePdtTable = cached; return _queuePdtTable; }
  var rows = runSQL("SHOW TABLES FROM looker LIKE '%queue_creative_statistics%'");
  if (!rows.length) throw new Error('queue_creative_statistics PDT not found');
  _queuePdtTable = 'looker.' + rows[rows.length - 1].Table;
  cache.put('pdt_queue_creative_statistics', _queuePdtTable, 3600);
  Logger.log('Queue PDT: ' + _queuePdtTable);
  return _queuePdtTable;
}

// (a `_queueCTEs()` helper used to live here and was never called — a fourth copy of the
// CTE the three state queries each inline. Removed; if you factor the CTE out, use it.)

// ═══════════════════════════════════════════════════════════
// QUERY M-1: QUEUING creatives
// queue_eligible=true, NOT optimizing, current_status='excluded', creative enabled
// Source: Doc 8 SQL
// ═══════════════════════════════════════════════════════════
function buildQueueingSQL(campaignId) {
  try {
    var qPdt = getQueuePDT();
    return [
      "WITH pinpoint__creatives_simple AS (",
      "  SELECT c.id, c.external_id, c.state FROM pinpoint.public.creatives c",
      "),",
      "pinpoint__campaigns_creatives AS (SELECT * FROM pinpoint.public.campaigns_creatives)",
      "SELECT DISTINCT",
      "  pinpoint__creatives_simple.external_id AS external_id,",
      "  pinpoint__creatives_simple.id          AS creative_id",
      "FROM " + qPdt + " AS queue_creative_statistics",
      "LEFT JOIN pinpoint__creatives_simple ON queue_creative_statistics.creative_id = pinpoint__creatives_simple.id",
      "LEFT JOIN pinpoint__campaigns_creatives ON CAST(queue_creative_statistics.creative_id AS INT) = CAST(pinpoint__campaigns_creatives.creative_id AS INT)",
      "WHERE (queue_creative_statistics.is_currently_queue_eligible)",
      "  AND (NOT (queue_creative_statistics.is_currently_optimizing) OR (queue_creative_statistics.is_currently_optimizing) IS NULL)",
      "  AND (queue_creative_statistics.current_status) = 'excluded'",
      "  AND (pinpoint__creatives_simple.state) = 'enabled'",
      "  AND CAST(pinpoint__campaigns_creatives.campaign_id AS INT) = " + campaignId,
      "LIMIT 500",
    ].join('\n');
  } catch(e) { Logger.log('buildQueueingSQL failed: ' + e.message); return null; }
}

// ═══════════════════════════════════════════════════════════
// QUERY M-2: EXPLORING creatives
// queue_eligible=true, NOT optimizing, current_status='included', creative enabled
// Source: Doc 9 SQL
// ═══════════════════════════════════════════════════════════
function buildExploringSQL(campaignId) {
  try {
    var qPdt = getQueuePDT();
    return [
      "WITH pinpoint__creatives_simple AS (",
      "  SELECT c.id, c.external_id, c.state FROM pinpoint.public.creatives c",
      "),",
      "pinpoint__campaigns_creatives AS (SELECT * FROM pinpoint.public.campaigns_creatives)",
      "SELECT DISTINCT",
      "  pinpoint__creatives_simple.external_id AS external_id,",
      "  pinpoint__creatives_simple.id          AS creative_id",
      "FROM " + qPdt + " AS queue_creative_statistics",
      "LEFT JOIN pinpoint__creatives_simple ON queue_creative_statistics.creative_id = pinpoint__creatives_simple.id",
      "LEFT JOIN pinpoint__campaigns_creatives ON CAST(queue_creative_statistics.creative_id AS INT) = CAST(pinpoint__campaigns_creatives.creative_id AS INT)",
      "WHERE (queue_creative_statistics.is_currently_queue_eligible)",
      "  AND (NOT (queue_creative_statistics.is_currently_optimizing) OR (queue_creative_statistics.is_currently_optimizing) IS NULL)",
      "  AND (queue_creative_statistics.current_status) = 'included'",
      "  AND (pinpoint__creatives_simple.state) = 'enabled'",
      "  AND CAST(pinpoint__campaigns_creatives.campaign_id AS INT) = " + campaignId,
      "LIMIT 500",
    ].join('\n');
  } catch(e) { Logger.log('buildExploringSQL failed: ' + e.message); return null; }
}

// ═══════════════════════════════════════════════════════════
// QUERY M-3: OPTIMIZING creatives
// NOT queue_eligible (or NULL), is_currently_optimizing=true, creative enabled
// Source: Doc 10 SQL
// ═══════════════════════════════════════════════════════════
function buildOptimizingSQL(campaignId) {
  try {
    var qPdt = getQueuePDT();
    return [
      "WITH pinpoint__creatives_simple AS (",
      "  SELECT c.id, c.external_id, c.state FROM pinpoint.public.creatives c",
      "),",
      "pinpoint__campaigns_creatives AS (SELECT * FROM pinpoint.public.campaigns_creatives)",
      "SELECT DISTINCT",
      "  pinpoint__creatives_simple.external_id AS external_id,",
      "  pinpoint__creatives_simple.id          AS creative_id",
      "FROM " + qPdt + " AS queue_creative_statistics",
      "LEFT JOIN pinpoint__creatives_simple ON queue_creative_statistics.creative_id = pinpoint__creatives_simple.id",
      "LEFT JOIN pinpoint__campaigns_creatives ON CAST(queue_creative_statistics.creative_id AS INT) = CAST(pinpoint__campaigns_creatives.creative_id AS INT)",
      "WHERE (NOT (queue_creative_statistics.is_currently_queue_eligible) OR (queue_creative_statistics.is_currently_queue_eligible) IS NULL)",
      "  AND (queue_creative_statistics.is_currently_optimizing)",
      "  AND (pinpoint__creatives_simple.state) = 'enabled'",
      "  AND CAST(pinpoint__campaigns_creatives.campaign_id AS INT) = " + campaignId,
      "LIMIT 500",
    ].join('\n');
  } catch(e) { Logger.log('buildOptimizingSQL failed: ' + e.message); return null; }
}

function buildTypeBreakdownSQL(campaignId, lookbackDays) {
  return [
    "SELECT",
    "  r.is_video_creative AS is_video,",
    "  CASE WHEN r.is_interactive = 'true' THEN 'Interactive'",
    "       WHEN r.is_interactive = 'false' THEN 'Not Interactive'",
    "       ELSE 'N/A' END AS interactive_label,",
    "  COUNT(DISTINCT r.creative_id) AS creative_count,",
    "  COALESCE(SUM(r.spend_micros / CAST(1e6 AS DOUBLE)), 0) AS spend,",
    "  COALESCE(SUM(r.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) AS revenue_d7,",
    "  COALESCE(SUM(r.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(SUM(r.installs_d1), 0) AS rpi,",
    "  COALESCE(SUM(r.coalesced_customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(SUM(r.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) AS roas_d7,",
    "  CAST(SUM(r.installs_d1) AS DOUBLE) / NULLIF(SUM(r.impressions), 0) AS iti",
    "FROM analytics.daily_attr_event_d7 r",
    "WHERE r.campaign_id = " + campaignId,
    "  AND from_iso8601_timestamp(r.dt) >= DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CURRENT_DATE)",
    "  AND from_iso8601_timestamp(r.dt) < DATE_ADD('day', -" + DATA_BAKE_DAYS + ", CURRENT_DATE)",
    "  AND r.is_uncredited <> 'true'",
    "GROUP BY 1, 2",
    "LIMIT 20",
  ].join('\n');
}

function buildCampaignMetaSQL(campaignId) {
  return [
    "WITH pinpoint__campaigns AS (",
    "  SELECT campaigns.*, campaign_types.name AS campaign_type_name,",
    "    csc.selection_strategy, csc.enabled AS csc_enabled",
    "  FROM pinpoint.public.campaigns campaigns",
    "  LEFT JOIN pinpoint.public.campaign_types ON campaigns.campaign_type_id = campaign_types.id",
    "  LEFT JOIN pinpoint.public.creative_selection_configurations csc ON campaigns.app_id = csc.app_id",
    "),",
    "pinpoint__apps AS (",
    "  SELECT apps.id,",
    "    CASE WHEN csc.selection_strategy = 'multiarm-bandit' AND csc.enabled = True THEN 'MCO'",
    "         WHEN csc.selection_strategy = 'random' AND csc.enabled = True THEN 'Free-floating'",
    "         ELSE 'MCO' END AS creative_selection_method",
    "  FROM pinpoint.public.apps apps",
    "  LEFT JOIN pinpoint.public.creative_selection_configurations csc ON apps.id = csc.app_id",
    "),",
    "pinpoint__goals AS (",
    "  SELECT campaign_id,",
    "    MAX(CASE WHEN priority=1 THEN type END) AS goal_1,",
    "    MAX(CASE WHEN priority=1 THEN target_value END) AS goal_1_value,",
    "    MAX(CASE WHEN priority=2 THEN type END) AS goal_2,",
    "    MAX(CASE WHEN priority=2 THEN target_value END) AS goal_2_value",
    "  FROM pinpoint.public.goals GROUP BY 1",
    ")",
    "SELECT",
    "  r.dest_app_id,",
    "  r.campaign_id,",
    "  pinpoint__campaigns.current_optimization_state,",
    "  pinpoint__apps.creative_selection_method,",
    "  pinpoint__campaigns.state AS campaign_state,",
    "  r.ad_group_id,",
    "  r.ad_group_name,",
    "  r.campaign_type,",
    "  pinpoint__goals.goal_1,",
    "  pinpoint__goals.goal_1_value,",
    "  pinpoint__goals.goal_2,",
    "  pinpoint__goals.goal_2_value,",
    "  pinpoint__campaigns.vt_cap,",
    "  CASE WHEN vc.tolerance IS NULL THEN 'medium' ELSE vc.tolerance END AS view_click_tolerance,",
    "  r.target_event_name",
    "FROM analytics.daily AS r",
    "LEFT JOIN pinpoint__apps ON r.dest_app_id = pinpoint__apps.id",
    "LEFT JOIN pinpoint__campaigns ON r.campaign_id = pinpoint__campaigns.id",
    "LEFT JOIN pinpoint__goals ON r.campaign_id = pinpoint__goals.campaign_id",
    "LEFT JOIN pinpoint.public.app_viewclick_tolerance_view AS vc ON r.dest_app_id = vc.app_id",
    "WHERE from_iso8601_timestamp(r.dt) >= DATE_ADD('day', -7, CURRENT_DATE)",
    "  AND r.campaign_id = " + campaignId,
    "  AND r.ad_group_state = 'enabled'",
    "  AND r.is_uncredited <> 'true'",
    "GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15",
    "ORDER BY 6",
    "LIMIT 500",
  ].join('\n');
}

function buildTargetEventSQL(campaignId) {
  return [
    "SELECT",
    "  r.target_event_name",
    "FROM analytics.trimmed_daily r",
    "WHERE from_iso8601_timestamp(r.dt) >= DATE_ADD('day', -30, CURRENT_DATE)",
    "  AND from_iso8601_timestamp(r.dt) < DATE_ADD('day', -" + DATA_BAKE_DAYS + ", CURRENT_DATE)",
    "  AND r.campaign_id = " + campaignId,
    "  AND r.is_uncredited <> 'true'",
    "  AND r.target_event_name IS NOT NULL",
    "GROUP BY 1",
    "ORDER BY 1",
    "LIMIT 10",
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// QUERY K: Creative info + pause log
// Matches user's production SQL — returns pause_method, paused_date,
// external_id, and latest_enabled_date per creative
// ═══════════════════════════════════════════════════════════
function buildPauseLogSQL(campaignId, lookbackDays) {
  var lb = lookbackDays || 30;
  return [
    "WITH cstudio_daily_analytics_v1 AS (",
    "  SELECT a.*, c.external_id",
    "  FROM hive.bi.cstudio_analytics_daily_v1 a",
    "  LEFT JOIN pinpoint.public.creatives c ON c.id = a.creative_id",
    "  WHERE a.campaign_id = " + campaignId,
    "    AND from_iso8601_timestamp(a.dt) >= DATE_ADD('day', -" + lb + ", CURRENT_DATE)",
    "),",
    "cstudio__creative_paused_by AS (",
    "  WITH max_created_dates AS (",
    "    SELECT creative_id, MAX(created_at) AS max_created_at",
    "    FROM pinpoint.public.creative_events",
    "    WHERE event_type = 'paused'",
    "    GROUP BY creative_id",
    "  ),",
    "  max_changed_dates AS (",
    "    SELECT creative_id, MAX(changed_at) AS max_changed_at",
    "    FROM pinpoint.public.creative_state_events",
    "    WHERE new_value = 'paused'",
    "    GROUP BY creative_id",
    "  )",
    "  SELECT a.creative_id,",
    "    CASE WHEN CONCAT(c.first_name,' ',c.last_name) IS NOT NULL",
    "         THEN CONCAT(CONCAT(c.first_name,' ',c.last_name),' in ',json_extract_scalar(a.payload,'$.source.source'))",
    "         ELSE json_extract_scalar(a.payload,'$.source.source') END AS pause_method,",
    "    b.changed_at AS paused_datetime",
    "  FROM pinpoint.public.creative_events a",
    "  LEFT JOIN pinpoint.public.creative_state_events b ON a.creative_id = b.creative_id",
    "  LEFT JOIN pinpoint.public.users c ON CAST(json_extract_scalar(a.payload,'$.source[\"user-id\"]') AS INT) = c.id",
    "  LEFT JOIN max_changed_dates ON a.creative_id = max_changed_dates.creative_id",
    "  LEFT JOIN max_created_dates ON a.creative_id = max_created_dates.creative_id",
    "  WHERE a.created_at = max_created_dates.max_created_at",
    "    AND b.changed_at = max_changed_dates.max_changed_at",
    "    AND b.old_value = 'enabled'",
    "    AND b.new_value = 'paused'",
    "),",
    "creative_state_events AS (",
    "  WITH t AS (",
    "    SELECT b.creative_id, c.state,",
    "      MAX(CASE WHEN old_value IS NULL AND new_value='enabled' THEN changed_at",
    "               WHEN old_value='deleted' AND new_value='enabled' THEN changed_at",
    "               WHEN old_value='paused'  AND new_value='enabled' THEN changed_at END) AS max_enabled_date,",
    "      MAX(CASE WHEN old_value='enabled' AND new_value='paused' THEN changed_at END) AS paused_date,",
    "      MIN(CASE WHEN old_value IS NULL AND new_value='enabled' THEN changed_at",
    "               WHEN old_value='deleted' AND new_value='enabled' THEN changed_at",
    "               WHEN old_value='paused'  AND new_value='enabled' THEN changed_at END) AS min_enabled_date",
    "    FROM pinpoint.public.creative_state_events b",
    "    LEFT JOIN pinpoint.public.creatives c ON b.creative_id = c.id",
    "    GROUP BY 1, 2",
    "  )",
    "  SELECT creative_id,",
    "    (CASE WHEN state <> 'enabled' THEN paused_date ELSE NULL END) AS current_pause_date,",
    "    max_enabled_date, min_enabled_date FROM t",
    "),",
    "pinpoint__creatives_simple AS (",
    "  SELECT c.id, c.external_id, c.inventory_format",
    "  FROM pinpoint.public.creatives c",
    "),",
    "pinpoint__apps AS (",
    "  SELECT apps.id,",
    "    CASE WHEN csc.selection_strategy='multiarm-bandit' AND csc.enabled=True THEN 'MCO'",
    "         WHEN csc.selection_strategy='random' AND csc.enabled=True THEN 'Free-floating (incl. CAB)'",
    "         ELSE 'MCO' END AS creative_selection_method",
    "  FROM pinpoint.public.apps apps",
    "  LEFT JOIN pinpoint.public.creative_selection_configurations csc ON apps.id = csc.app_id",
    ")",
    "SELECT",
    "  cstudio__creative_paused_by.pause_method AS pause_method,",
    "  DATE_FORMAT(creative_state_events.current_pause_date,'%Y-%m-%d') AS current_pause_date,",
    "  pinpoint__creatives_simple.id AS creative_id,",
    "  COALESCE(cstudio_daily_analytics_v1.external_id, pinpoint__creatives_simple.external_id) AS external_id,",
    "  DATE_FORMAT(creative_state_events.max_enabled_date,'%Y-%m-%d') AS latest_enabled_date",
    "FROM cstudio_daily_analytics_v1",
    "LEFT JOIN pinpoint__apps ON cstudio_daily_analytics_v1.dest_app_id = pinpoint__apps.id",
    "LEFT JOIN pinpoint__creatives_simple ON cstudio_daily_analytics_v1.creative_id = pinpoint__creatives_simple.id",
    "LEFT JOIN creative_state_events ON cstudio_daily_analytics_v1.creative_id = creative_state_events.creative_id",
    "LEFT JOIN cstudio__creative_paused_by ON cstudio_daily_analytics_v1.creative_id = cstudio__creative_paused_by.creative_id",
    "WHERE (pinpoint__apps.creative_selection_method) IS NOT NULL",
    "  AND (pinpoint__creatives_simple.inventory_format) IS NOT NULL",
    "GROUP BY 1, 2, 3, 4, 5",
    "HAVING COALESCE(SUM(cstudio_daily_analytics_v1.revenue_micros / CAST(1e6 AS DOUBLE)), 0) > 1",
    "ORDER BY 2 DESC",
    "LIMIT 500",
  ].join('\n');
}


// ═══════════════════════════════════════════════════════════
// QUERY L: Impressions + Installs per creative from cstudio
// Matches user's production SQL
// ═══════════════════════════════════════════════════════════
function buildImpressionInstallSQL(campaignId, lookbackDays) {
  var lb = lookbackDays || 30;
  return [
    "WITH cstudio_daily_analytics_v1 AS (",
    "  SELECT a.*, c.external_id",
    "  FROM hive.bi.cstudio_analytics_daily_v1 a",
    "  LEFT JOIN pinpoint.public.creatives c ON c.id = a.creative_id",
    "  WHERE a.campaign_id = " + campaignId,
    "    AND from_iso8601_timestamp(a.dt) >= DATE_ADD('day', -" + lb + ", CAST(CAST(DATE_TRUNC('DAY', CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP))",
    "),",
    "pinpoint__creatives_simple AS (",
    "  SELECT c.id, c.external_id, c.inventory_format",
    "  FROM pinpoint.public.creatives c",
    ")",
    "SELECT",
    "  pinpoint__creatives_simple.external_id AS external_id,",
    "  pinpoint__creatives_simple.id AS creative_id,",
    "  COALESCE(SUM(cstudio_daily_analytics_v1.impressions), 0) AS impressions,",
    "  COALESCE(SUM(cstudio_daily_analytics_v1.installs), 0) AS installs",
    "FROM cstudio_daily_analytics_v1",
    "LEFT JOIN pinpoint__creatives_simple ON cstudio_daily_analytics_v1.creative_id = pinpoint__creatives_simple.id",
    "GROUP BY 1, 2",
    "ORDER BY 3 DESC",
    "LIMIT 500",
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// QUERY N-1: Campaign-level performance (non-cohorted)
// Source: analytics.trimmed_daily — Spend(GR), ITI, IPM, RPI, Impressions, Installs
// ═══════════════════════════════════════════════════════════
function buildCampaignPerfBasicSQL(campaignId, lookbackDays) {
  // Uses the SAME table, columns, and date window as buildCreativeLevelPerfSQL (Query E)
  // so the Campaign row exactly equals the aggregation of the creative rows.
  var dtStart = "DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CAST(CAST(DATE_TRUNC('DAY', CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP))";
  var dtEnd   = "DATE_ADD('day', " + lookbackDays + ", DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CAST(CAST(DATE_TRUNC('DAY', CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP)))";
  return [
    "SELECT",
    "  revenue_summary.dest_app_id,",
    "  revenue_summary.campaign_id,",
    "  COALESCE(SUM(revenue_summary.spend_micros / CAST(1e6 AS DOUBLE)), 0) AS spend,",
    "  CAST(COALESCE(SUM(revenue_summary.installs_d7), 0) AS DOUBLE) / NULLIF(COALESCE(SUM(revenue_summary.impressions), 0), 0) AS iti,",
    "  COALESCE(SUM(revenue_summary.installs_d7), 0) / CAST(NULLIF(COALESCE(SUM(revenue_summary.impressions), 0), 0) AS DOUBLE) * 1000 AS ipm,",
    "  COALESCE(SUM(revenue_summary.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.installs_d1), 0), 0) AS rpi,",
    "  COALESCE(SUM(revenue_summary.impressions), 0) AS impressions,",
    "  COALESCE(SUM(revenue_summary.installs_d1), 0) AS installs",
    "FROM analytics.daily_attr_event_d7 AS revenue_summary",
    "WHERE (from_iso8601_timestamp(revenue_summary.dt)) >= " + dtStart,
    "  AND (from_iso8601_timestamp(revenue_summary.dt)) < " + dtEnd,
    "  AND revenue_summary.campaign_id = " + campaignId,
    "  AND revenue_summary.is_uncredited <> 'true'",
    "GROUP BY 1, 2",
    "ORDER BY 3 DESC",
    "LIMIT 1",
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// QUERY N-2: Campaign-level performance (D7 cohorted)
// Source: analytics.trimmed_daily_attr_event_d7_v1 — D7 ROAS, 1D ROAS, RPA
// ═══════════════════════════════════════════════════════════
function buildCampaignPerfCohortSQL(campaignId, lookbackDays) {
  // Same table + date window as buildCreativeLevelPerfSQL (Query E) for consistency
  var dtStart = "DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CAST(CAST(DATE_TRUNC('DAY', CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP))";
  var dtEnd   = "DATE_ADD('day', " + lookbackDays + ", DATE_ADD('day', -" + (lookbackDays + DATA_BAKE_DAYS) + ", CAST(CAST(DATE_TRUNC('DAY', CAST(NOW() AS TIMESTAMP)) AS DATE) AS TIMESTAMP)))";
  return [
    "SELECT",
    "  revenue_summary.dest_app_id,",
    "  revenue_summary.campaign_id,",
    "  COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) AS revenue_d7,",
    "  COALESCE(SUM(revenue_summary.coalesced_customer_revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.revenue_micros_d1 / CAST(1e6 AS DOUBLE)), 0), 0) AS roas_d1,",
    "  COALESCE(SUM(revenue_summary.coalesced_customer_revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0), 0) AS roas_d7,",
    "  COALESCE(SUM(revenue_summary.revenue_micros_d7 / CAST(1e6 AS DOUBLE)), 0) / NULLIF(COALESCE(SUM(revenue_summary.target_events_first_d7), 0), 0) AS rpa_d7",
    "FROM analytics.daily_attr_event_d7 AS revenue_summary",
    "WHERE (from_iso8601_timestamp(revenue_summary.dt)) >= " + dtStart,
    "  AND (from_iso8601_timestamp(revenue_summary.dt)) < " + dtEnd,
    "  AND revenue_summary.campaign_id = " + campaignId,
    "  AND revenue_summary.is_uncredited <> 'true'",
    "GROUP BY 1, 2",
    "ORDER BY 3 DESC",
    "LIMIT 1",
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
function mergeAllData(perfData, inventory, campaignId) {
  var invById = {};
  inventory.forEach(function(r) { if (r.creative_id) invById[String(r.creative_id)] = r; });

  if (perfData.length > 0) {
    return perfData.map(function(p) {
      var inv = invById[String(p.creative_id)] || {};
      var margin = parseFloat(p.roas_ci_margin);
      var variance = null;
      if (!isNaN(margin)) {
        if (margin < 0.1) variance = 'high';
        else if (margin > 0.2) variance = 'low';
        else variance = 'moderate';
      }
      var ciRange = null;
      if (p.roas_d7_lower_ci !== null && p.roas_d7_upper_ci !== null) {
        var rp = (parseFloat(p.roas_d7) * 100).toFixed(1);
        var lo = (parseFloat(p.roas_d7_lower_ci) * 100).toFixed(1);
        var hi = (parseFloat(p.roas_d7_upper_ci) * 100).toFixed(1);
        var mg = (Math.abs(parseFloat(p.roas_d7_upper_ci) - parseFloat(p.roas_d7)) * 100).toFixed(1);
        ciRange = rp + '% [' + lo + '%, ' + hi + '%] +/-' + mg + '%';
      }
      // Determine if CPA campaign (uses RPA) or CPR (uses ROAS)
      var isCpa = String(p.campaign_goal_1||'').toLowerCase().indexOf('cpa') >= 0 ||
                  String(p.campaign_goal_1||'').toLowerCase().indexOf('rpa') >= 0 ||
                  String(p.campaign_goal_2||'').toLowerCase().indexOf('cpa') >= 0 ||
                  String(p.campaign_goal_2||'').toLowerCase().indexOf('rpa') >= 0;
      var rpaVal = pf(p.rpa_d7);
      var rpaLo  = pf(p.rpa_d7_lower_ci);
      var rpaHi  = pf(p.rpa_d7_upper_ci);
      var rpaDelta = pf(p.rpa_ci_delta);
      // RPA CI range string
      var rpaCiRange = null;
      if (rpaVal != null && rpaLo != null && rpaHi != null) {
        rpaCiRange = '$' + rpaVal.toFixed(2) + ' [$' + rpaLo.toFixed(2) + ', $' + rpaHi.toFixed(2) + '] (+/-' + (rpaDelta != null ? (rpaDelta * 100).toFixed(1) + '%)' : '?)');
      }
      // Variance for CPA uses RPA CI delta; for CPR uses ROAS CI margin
      var primaryDelta = isCpa ? (rpaDelta == null ? null : rpaDelta) : (margin == null ? null : margin);
      if (primaryDelta !== null && !isCpa) {
        // ROAS variance already computed above
      } else if (primaryDelta !== null && isCpa) {
        // Recompute variance from RPA delta
        if (primaryDelta < 0.1) variance = 'high';
        else if (primaryDelta > 0.2) variance = 'low';
        else variance = 'moderate';
      }
      return {
        creative_id: p.creative_id, ad_format: p.creative_format,
        competing_group: p.competing_group || inv.competing_group || p.creative_format,
        mco_group: toMcoGroup(p.competing_group || inv.competing_group || ''),
        status: normState(p.creative_state),
        created_date: inv.created_date || null, paused_date: inv.paused_date || null, pause_method: inv.pause_method || null,
        external_id: inv.external_id || null,
        campaign_id: p.campaign_id, campaign_name: p.campaign_name, app_id: p.app_id, app_name: p.app_name,
        spend: pf(p.spend), revenue: pf(p.revenue_d7),
        roas: pf(p.roas_d7), roas_d1: pf(p.roas_d1),
        rpa: rpaVal, rpa_lower_ci: rpaLo, rpa_upper_ci: rpaHi, rpa_ci_delta: rpaDelta, rpa_ci_range: rpaCiRange,
        target_events_d7: pf(p.target_events_d7),
        target_event_name: p.target_event_name || null,
        campaign_goal_1: p.campaign_goal_1 || null, campaign_goal_2: p.campaign_goal_2 || null,
        is_cpa_campaign: isCpa,
        rpi: pf(p.rpi_d1), iti: pf(p.iti), ipm: pf(p.ipm), installs: pf(p.installs), sow_pct: null,
        variance: variance, ci_range: isCpa ? rpaCiRange : ciRange, dynamic_delta: primaryDelta,
        roas_lower_ci: pf(p.roas_d7_lower_ci), roas_upper_ci: pf(p.roas_d7_upper_ci),
        campaign_type: p.campaign_type, optimization_state: p.optimization_state,
        is_interactive: p.is_interactive, is_video: p.is_video || null, mco_enabled: null, kpi_target: null,
      };
    });
  }
  return inventory.map(function(c) {
    return {
      creative_id: c.creative_id, ad_format: c.creative_format, competing_group: c.competing_group || c.creative_format,
      status: normState(c.creative_state), created_date: c.created_date, campaign_id: c.campaign_id,
      campaign_name: c.campaign_name, app_id: c.app_id, spend: null, revenue: null, roas: null,
      rpi: null, installs: null, sow_pct: null, variance: null, ci_range: null,
    };
  });
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function normState(s) { if(!s)return 'unknown'; var l=String(s).toLowerCase(); if(l==='enabled'||l==='active')return 'active'; if(l==='paused'||l==='disabled')return 'paused'; return l; }
function detectType(t) { if(!t)return null; var l=t.toLowerCase(); if(l.indexOf('reengag')>=0)return 're'; if(l.indexOf('roas')>=0||l.indexOf('cpr')>=0)return 'ua_cpr'; if(l.indexOf('cpa')>=0)return 'ua_cpa'; if(l.indexOf('cpi')>=0)return 'ua_cpi'; return null; }
function detectTypeFromName(n) { if(!n)return 'ua_cpr'; var l=n.toLowerCase(); if(l.indexOf('roas')>=0)return 'ua_cpr'; if(l.indexOf('cpa')>=0)return 'ua_cpa'; if(l.indexOf('cpi')>=0)return 'ua_cpi'; if(l.indexOf('-re-')>=0)return 're'; return 'ua_cpr'; }

function getAvailableApps(q) {
  try { if(!q||q.length<2)return {apps:{},campaigns:{}}; var r=fetchCampaignSearch(q); var a={},c={}; r.forEach(function(x){if(x.app_id)a[x.app_id]='App '+x.app_id; if(x.campaign_id)c[x.campaign_id]={name:x.campaign_name,app_id:x.app_id,state:x.campaign_state};}); return {apps:a,campaigns:c}; }
  catch(e){return {apps:{},campaigns:{}};}
}
/**
 * Everything the front end needs that is defined server-side. Dashboard.html calls this
 * once on load (CFG) so the inventory-group mapping and the MCO thresholds exist in
 * exactly one place — see MCO_GROUP_MAP_GS / MCO_RULES at the top of this file.
 */
function getConfig() {
  return {
    thresholds: THRESHOLDS,
    keyFormats: KEY_FORMATS,
    defaultLookback: DEFAULT_LOOKBACK_DAYS,
    mcoGroupMap: MCO_GROUP_MAP_GS,
    mcoRules: MCO_RULES,
    metrics: METRICS,
    primaryMetricByCampaignType: PRIMARY_METRIC_BY_CAMPAIGN_TYPE
  };
}

// ═══════════════════════════════════════════════════════════
// TEST
// ═══════════════════════════════════════════════════════════
function testFullPipeline() {
  Logger.log('=== Campaign 70028 ===');
  var r = fetchCreativeData('70028', 'campaign', 30, {});
  if (r.error) { Logger.log('ERROR: ' + r.error); return; }
  Logger.log('App: ' + r.appName + ' (' + r.appId + ') | Type: ' + r.campTypeLabel + ' | MCO: ' + r.mcoEnabled);
  Logger.log('Creatives: ' + r.totalCreatives + ' (' + r.activeCreatives + ' active)');
  Logger.log('Daily format metrics: ' + r.dailyFormatMetrics.length + ' rows');
  Logger.log('Format metrics: ' + JSON.stringify(r.formatMetrics));
}

function testPreview() {
  Logger.log('=== Preview 70028 ===');
  var r = previewCampaign('70028');
  Logger.log(JSON.stringify(r, null, 2));
}

function testConnection() {
  try { getAccessToken(); Logger.log('Auth OK'); runSQL('SELECT 1 AS test'); Logger.log('SQL OK'); Logger.log('PDT: ' + getPDT()); return 'All OK'; }
  catch(e) { Logger.log('FAIL: ' + e.message); return 'FAIL'; }
}

// ═══════════════════════════════════════════════════════════
// CLAUDE API — AI INSIGHTS
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// SKILL LOADER — ONE source of MCO knowledge, no runtime fetch
//
// The prose below (MCO_SKILL) is GENERATED from the repo file
//   skills/mco-creative-explainer/SKILL.md
// by `python3 tools/sync_skill.py`, which also checks that the numbers in
// MCO_RULES appear in the prose. Edit the .md, run the script, `clasp push -f`.
//
// The previous design read SKILL.md + mco-knowledge-base.md from Google Drive at
// runtime (Script Properties SKILL_FILE_ID / KB_FILE_ID) with this constant as a
// fallback. That gave two copies that could disagree, with the invisible one
// winning in production. Drive loading is REMOVED — those two Script Properties
// are now unused and can be deleted. To change the skill: edit the repo .md.
// ═══════════════════════════════════════════════════════════

/**
 * The AI system prompt: generated MCO prose + the authoritative numbers (MCO_RULES) +
 * the metric definitions (METRICS). Every number and every "lower is better" the model
 * sees comes from those two objects — the same ones the client reads via getConfig().
 */
function getSkillContent() {
  return MCO_SKILL + '\n\n---\n\n' + mcoRulesPromptBlock() + '\n\n' + metricsPromptBlock();
}

// ── BEGIN GENERATED FROM skills/mco-creative-explainer/SKILL.md — DO NOT EDIT BY HAND ──
var MCO_SKILL = [
  '# MCO Creative Explainer — Complete Reference',
  '',
  'This document is the merged skill + knowledge base for diagnosing MCO creative behavior.',
  'It powers the AI diagnostic engine in the Creative Performance Analyzer.',
  '',
  '---',
  '',
  '## 1. Bidding Pipeline Overview',
  '',
  'The Liftoff ad serving pipeline has 4 sequential stages:',
  '',
  '```',
  'Bid Request → Eligibility Filtering → MCO (Creative Selection) → ML (Internal Auction)',
  '```',
  '',
  '**Stage 1 — Bid Request**: Ad slot size, orientation, device, ad format, ad type support (HTML/VAST), max video length, exchange.',
  '',
  '**Stage 2 — Eligibility Filtering**: Filters each ad group to only creatives compatible with the bid request.',
  '- Matches on: ad type, orientation, device, video length',
  '- LXA creatives only eligible on VX exchange',
  '- SAF campaigns: all creatives share same format',
  '',
  '**Stage 3 — MCO (Creative Selection)**: Selects the single best creative per ad group based on ITI (Impression-to-Install rate) over past 30 days. Highest ITI wins. Free Floating campaigns select randomly.',
  '',
  '**Stage 4 — ML (Internal Auction)**: Prices each (ad group, creative) pair. Considers dest app, source app, user features, campaign goals. Creative features have minor influence. Highest-priced pair wins.',
  '',
  '### Key Insight: MCO Chooses Creative, ML Chooses Ad Group',
  '',
  '**Per-bid-request auction flow:**',
  '1. A bid request comes in with ad slot specs (size, orientation, device, ad type, video length)',
  '2. Every ad group gets filtered to only **eligible** creatives (matching the bid request)',
  '3. MCO selects the **highest-ITI creative** per ad group (Free-Floating selects randomly)',
  '4. ML prices every **(ad group + creative) pair** for this bid request',
  '5. ML considers: dest app, source app, user features, campaign optimization type, creative features (ad type, video length — minor influence)',
  '6. The (ad group + creative) pair with the **highest ML price wins** the internal auction',
  '7. This internal auction happens across ALL customers',
  '',
  '**Critical distinctions:**',
  '- **Format/ad-group-level spend distribution is decided by ML** (pricing), NOT by MCO',
  '- **Creative selection within an ad group is decided by MCO** (ITI-based), NOT by ML',
  '- MCO does NOT "shift spend between formats" — ML pricing determines which ad groups win auctions',
  '- The selected creative has a **minor influence** on the final ML price',
  '- Pausing a creative does NOT guarantee spend shifts to where you want — ML may reprice the ad group differently with a different creative',
  '',
  '**Common misconception:** "MCO is shifting spend to format X" is incorrect. ML pricing determines format-level spend. MCO only affects WHICH creative represents each ad group. If a format\'s spend changes, it\'s because ML\'s pricing of that ad group changed (due to different user mix, source apps, or campaign goals), not because MCO moved budget.',
  '',
  '---',
  '',
  '## 2. Metric Definitions',
  '',
  '- **RPI** = Revenue Per Install = cost of install. LOWER is better.',
  '- **7D ROAS** = Return on ad spend over 7 days. HIGHER is better.',
  '- **1D ROAS** = Return on ad spend over 1 day. HIGHER is better.',
  '- **RPA** = Revenue Per Action = cost of target event. LOWER is better.',
  '- **ITI** = Impression-to-Install rate. HIGHER is better. This is what MCO selects on.',
  '- **IPM** = Installs Per Mille (per 1000 impressions). IPM = ITI × 1000. HIGHER is better.',
  '',
  '---',
  '',
  '## 3. Auto-Pauser (MCO campaigns only)',
  '',
  'The Auto-Pauser is a Rush job that is currently responsible for pausing creatives that use MCO.',
  '',
  '### Legacy Criteria (before WCS)',
  'With the Autopauser logic today, a creative is considered to be "lost" when it meets ALL of the following criteria:',
  '',
  '1. The creative has been live for **at least 5 days**',
  '2. AND the creative has accounted for **<5% of its competing creative format group\'s spend** for the past 3 days',
  '3. AND either:',
  '   - The creative has spent in the past 3 days',
  '   - OR the creative\'s selection probability is below 10%',
  '',
  '### Current Criteria (with WCS protection)',
  'To ensure new creatives reach the minimum threshold of 25K impressions and 7 days since launch, the Autopauser lose criteria has been updated to:',
  '',
  '1. Creative has **at least 25K impressions in the past 3 months** AND **7 days live since launch** ("Optimized")',
  '2. AND the creative has accounted for **<5% of its competing inventory group\'s spend** for the past 3 days',
  '3. AND either:',
  '   - The creative has spent in the past 3 days',
  '   - OR the creative\'s selection probability is below 10%',
  '',
  '### Key difference: Legacy vs Current',
  '- Legacy: "live for 5 days" + "competing **creative format** group"',
  '- Current: "25K impressions + 7 days live" + "competing **inventory** group"',
  '- The WCS-updated criteria protects new creatives until they have enough data (25K impressions) to compete fairly on ITI',
  '',
  '### In Practice',
  '- New creatives (exploring, <25K impressions or <7 days) are NEVER auto-paused — they are WCS-protected',
  '- The Auto-Pauser competes creatives within their "inventory group" (e.g. phone-portrait-vast, phone-banner)',
  '- Once auto-paused, reactivating the creative usually doesn\'t help because its ITI is still low — MCO will still not select it',
  '- **Cloning** the creative and relaunching gives it a fresh WCS exploration period with guaranteed 25K impressions',
  '',
  '### Auto-Pauser Logging (for diagnosis & backtesting)',
  'In order to allow for backtesting of new criteria, the existing job logs to Trino on each run. For each candidate creative, the following data is recorded:',
  '',
  '- **Lifecycle metric**: supporting data used at the current time',
  '- **Threshold used**: to calculate the state',
  '- **Calculated state**: the state the candidate was considered to be in based on the supporting data',
  '- **% of spend**: compared to competing group',
  '- **Spend amount**: in the past 3 days',
  '- **Creative selection probability**',
  '',
  'With this logging, we can backtest how many creatives would have been paused at a given time in the past using a new definition.',
  '',
  '---',
  '',
  '## 4. WCS (Winner Candidate Substitution, MCO only)',
  '',
  'Rolled out December 2024. Before WCS, ~75% of creatives were auto-paused before calibration.',
  '',
  '### How It Works',
  'When a bid is won by an "optimized" creative, 5-10% of the time (max 35%) the optimized creative is swapped out for an "exploring" creative. The exploring creative gets served using the optimized creative\'s bid price.',
  '',
  '### Lifecycle States',
  '',
  '| State | Criteria | Behavior |',
  '|-------|----------|----------|',
  '| **Queuing** | `is_currently_queue_eligible` AND NOT `is_currently_optimizing` AND `current_status = \'excluded\'` | In the throttle waiting room. Queue-eligible but excluded from serving, so no WCS impressions yet. Protected from Auto-Pauser. |',
  '| **Exploring** | `is_currently_queue_eligible` AND NOT `is_currently_optimizing` AND `current_status = \'included\'` | Past the throttle and being served via WCS substitution, still pre-calibration. Protected from Auto-Pauser. |',
  '| **Optimizing** | NOT `is_currently_queue_eligible` AND `is_currently_optimizing` | Calibrated. Normal MCO competition on ITI. Eligible for Auto-Pauser. |',
  '',
  '> **State is read, not derived.** There are exactly **three** states and they are **mutually',
  '> exclusive**. Each is a predicate over the `queue_creative_statistics` PDT',
  '> (`looker.*queue_creative_statistics`, joined on `creative_id`; the creative and the campaign',
  '> must both be `state = \'enabled\'`). Queuing and Exploring differ **only** by `current_status`',
  '> — `\'excluded\'` means throttled and not being served, `\'included\'` means being served.',
  '>',
  '> The 25K-impressions / 7-days rule is what makes the **platform** flip',
  '> `is_currently_optimizing`; it is not a definition to recompute. Do not infer a creative\'s',
  '> state from impressions and age — if the PDT has no row for a creative (e.g. it is paused),',
  '> it has no state, and the honest answer is `insufficient_data`.',
  '>',
  '> *History:* this table previously listed only two states, defined by the impressions/age',
  '> rule. A 2026-07-27 revision changed its Exploring row from AND to OR — correct as a',
  '> *proxy* for "not yet calibrated", but it was still describing a derivation rather than the',
  '> real definition, and it had no way to express Queuing at all. Superseded by the three',
  '> predicates above (authoritative source: the Looker queries behind the state counts).',
  '',
  '- All new creatives start as "exploring"',
  '- For net-new apps (all exploring), no substitutions until first creative becomes "optimizing"',
  '- Substitution rate not user-controllable',
  '- Platinum/Gold customers see lower substitution rates',
  '',
  '---',
  '',
  '## 5. Creative Throttle (MCO, exploring creatives only)',
  '',
  'Prevents too many creatives from exploring simultaneously.',
  '',
  '- Queue ("waiting room") before WCS starts serving',
  '- Minimum capacity: 6 creatives per inventory format',
  '- Scales with spend (larger customers = more capacity)',
  '- Budget cuts may shrink capacity → exploring creatives temporarily stop',
  '- **Queuing** state: enabled + queue-eligible + excluded from serving',
  '',
  '---',
  '',
  '## 6. Eligibility Filtering Details',
  '',
  'A creative is eligible if it matches the bid request on ALL of:',
  '- Ad type (HTML/VAST)',
  '- Orientation (portrait/landscape)',
  '- Device (phone/tablet)',
  '- Video length (within max duration)',
  '',
  '**Inventory format overlap**: e.g. phone-portrait-vast-30s overlaps with phone-portrait-vast-60s ~46.5% of the time. Competition groups are not as clean as the UI suggests.',
  '',
  '---',
  '',
  '## 7. Common Diagnosis Patterns',
  '',
  '### "Creative was auto-paused but has good ROAS"',
  'MCO selects on ITI, not ROAS. Clone and relaunch for fresh WCS period.',
  '',
  '### "New creative isn\'t getting any spend"',
  'If Queuing → waiting for throttle capacity. If Exploring with some impressions → WCS is working, just low volume.',
  '',
  '### "One creative gets all the spend"',
  'Highest-ITI creative dominates WITHIN each ad group. But format-level spend concentration is driven by ML pricing — if one format\'s ad groups consistently win auctions (due to higher ML prices), that format gets more spend. MCO only determines which creative represents each ad group.',
  '',
  '### "Creative was spending, then suddenly stopped"',
  'Check if exploring → optimizing transition. Or spend shifted to another format, or new creative with higher ITI entered.',
  '',
  '### "Why is this creative spending if it has low ROAS?"',
  'MCO picks on ITI. High ITI = high install rate, but installs may not lead to high-value events. ITI-ROAS disconnect is a known limitation.',
  '',
  '### "LXA creative isn\'t getting spend on non-VX"',
  'LXA only eligible on VX exchange. Filtered out in eligibility step on other exchanges.',
  '',
  '---',
  '',
  '## 8. Known Limitations',
  '',
  '1. **MCO selects on ITI only** — does not consider ROAS, CPI, CPA, or downstream metrics',
  '2. **Pausing may not have intended effect** — ML reprices ad group with different creative',
  '3. **Cloning is not guaranteed** — fresh WCS period, but may still lose on ITI',
  '4. **ITI susceptible to fraud** — install farming inflates ITI',
  '5. **CPI-ITI correlation** — lower CPI from higher ITI doesn\'t mean better user quality',
  '',
  '---',
  '',
  '## 9. Diagnosis Codes',
  '',
  '| Code | Meaning |',
  '|------|---------|',
  '| `auto_paused_low_iti` | Paused: ITI lower than competitors |',
  '| `auto_paused_low_spend_share` | Paused: spend share <5% |',
  '| `auto_paused_selection_prob` | Paused: selection probability <10% |',
  '| `exploring_wcs_protected` | In WCS exploration, exempt from pause |',
  '| `exploring_throttle_queued` | In throttle queue, waiting for capacity |',
  '| `winning_highest_iti` | Spending: highest ITI in group |',
  '| `winning_by_eligibility` | Spending: favorable eligibility matching |',
  '| `losing_iti_competition` | Not spending: outcompeted on ITI |',
  '| `losing_eligibility_mismatch` | Not eligible for high-volume bid requests |',
  '| `spend_shift_format_change` | Spend moved to different inventory format |',
  '| `newly_optimizing` | Just exited exploration, competing normally |',
  '| `free_floating_random` | Non-MCO: selected randomly |',
  '| `insufficient_data` | Not enough data to diagnose |',
  '',
  '---',
  '',
  '## 10. Diagnosis Logic',
  '',
  '1. **Free Floating** → `free_floating_random` (recommend adopting MCO)',
  '2. **State is `queuing`** (`current_status = \'excluded\'`) → `exploring_throttle_queued`;',
  '   **state is `exploring`** (`\'included\'`) → `exploring_wcs_protected`. Read the state, don\'t',
  '   derive it from impressions/age; if there is no state, say `insufficient_data`.',
  '3. **Paused**: compare ITI vs group, check spend share <5%, selection prob <10%',
  '4. **Spending + highest ITI** → `winning_highest_iti`; otherwise check eligibility',
  '5. **Not spending + lower ITI** → `losing_iti_competition`',
  '6. **Missing data** → `insufficient_data` with confidence: low',
  '',
  '---',
  '',
  '## 11. Terminology Glossary',
  '',
  '| Term | Definition |',
  '|------|-----------|',
  '| **MCO** | Multi-Creative Optimization |',
  '| **ITI** | Impression-to-Install rate (30-day window) |',
  '| **WCS** | Winner Candidate Substitution |',
  '| **Auto-Pauser** | Pauses underperforming optimized creatives |',
  '| **Queuing** | Queue-eligible, `current_status=\'excluded\'` — throttled, not yet served, protected |',
  '| **Exploring** | Queue-eligible, `current_status=\'included\'` — served via WCS, pre-calibration, protected |',
  '| **Optimizing** | `is_currently_optimizing` — calibrated, normal competition, Auto-Pauser-eligible |',
  '| **Free Floating** | Non-MCO, random selection |',
  '| **Inventory Format** | e.g. phone-portrait-vast-30s |',
  '| **MAF** | Multi-Ad Format ad group |',
  '| **SAF** | Single Ad Format ad group |',
  '| **LXA** | Liftoff XA, only eligible on VX exchange |',
  '| **Competition Group** | Creatives eligible for same bid requests |',
  '| **Selection Probability** | MCO\'s probability of selecting a creative |',
  '| **Calibration** | ~25K impressions over 7 days |',
  ''
].join('\n');
// ── END GENERATED ──

// ── Claude API config (one place) ───────────────────────────
// claude-sonnet-5: adaptive thinking is ON when `thinking` is omitted (Sonnet 4.x ran
// thinking-off), and max_tokens caps thinking + response TOGETHER — the old
// max_tokens:1024 would now truncate the JSON. Hence the larger budget below, plus
// `output_config.format` (structured outputs), which guarantees schema-valid JSON so
// there is nothing to un-fence and JSON.parse cannot fail on a stray preamble.
var CLAUDE_MODEL      = 'claude-sonnet-5';
var CLAUDE_API_URL    = 'https://api.anthropic.com/v1/messages';
var CLAUDE_MAX_TOKENS = 4096;

/**
 * One Claude call, one place. Both AI features go through here:
 * prompt caching on the system block (the MCO skill is ~3K tokens and identical on
 * every call — cache reads are ~10% of input price), structured outputs for guaranteed
 * JSON, and errors that say what actually happened instead of "unavailable".
 *
 * @param {string} systemPrompt  the skill + task instructions
 * @param {Object} userData      payload, JSON-stringified into the user turn
 * @param {Object} schema        JSON Schema the response must satisfy
 * @param {string} effort        'low' | 'medium' | 'high' — thinking depth / token spend
 * @param {string} label         for log lines
 */
function callClaudeJson_(systemPrompt, userData, schema, effort, label) {
  var API_KEY = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!API_KEY) throw new Error('CLAUDE_API_KEY not set');

  var payload = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: effort || 'medium', format: { type: 'json_schema', schema: schema } },
    messages: [{ role: 'user', content: JSON.stringify(userData) }]
  };

  var r = UrlFetchApp.fetch(CLAUDE_API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var body = r.getContentText();
  if (r.getResponseCode() !== 200) {
    Logger.log(label + ': HTTP ' + r.getResponseCode() + ' ' + body.substring(0, 400));
    throw new Error(label + ' failed (HTTP ' + r.getResponseCode() + ')');
  }

  var data;
  try { data = JSON.parse(body); }
  catch (e) { throw new Error(label + ': response was not JSON — ' + body.substring(0, 200)); }

  if (data.stop_reason === 'refusal') throw new Error(label + ': the model declined this request');
  if (data.stop_reason === 'max_tokens') throw new Error(label + ': response truncated — raise CLAUDE_MAX_TOKENS');

  var text = (data.content || []).filter(function(b) { return b.type === 'text'; })
                                 .map(function(b) { return b.text; }).join('');
  if (!text) throw new Error(label + ': empty response (stop_reason ' + data.stop_reason + ')');

  var u = data.usage || {};
  Logger.log(label + ': ok — in ' + (u.input_tokens || 0) + ' / cache_read ' +
             (u.cache_read_input_tokens || 0) + ' / out ' + (u.output_tokens || 0));
  return JSON.parse(text);
}

/**
 * Diagnose why a creative was paused or is in its current state.
 * Called from Dashboard.html for each statusLog entry.
 */
function diagnoseMcoCreative(creativeData) {
  var systemPrompt = getSkillContent() + '\n\n' + [
    '## Your Task',
    'Diagnose the single creative in the user JSON: why is it in this state?',
    'Apply the thresholds and diagnosis vocabulary above — they are authoritative.',
    '',
    'Decision order:',
    '1. Free Floating (non-MCO) → free_floating_random',
    '2. Below calibration on impressions OR days live → exploring (wcs_protected, or throttle_queued when it has no spend)',
    '3. Paused: rank its ITI in the competition group, check spend share against the Auto-Pauser threshold, check selection probability',
    '4. Spending with the highest ITI in its group → winning_highest_iti; otherwise consider eligibility',
    '5. Not spending with a lower ITI → losing_iti_competition',
    '6. Missing the data you would need → insufficient_data with confidence "low"',
    '',
    '`format` must be the MCO Inventory Group name (e.g. "Phone Portrait VAST"), not the raw inventory_format.',
    'Lead with the reason. Cite specific numbers from the data. Two to three sentences of explanation, no more.',
  ].join('\n');

  var schema = {
    type: 'object',
    properties: {
      diagnosis:           { type: 'string', enum: Object.keys(MCO_RULES.diagnosis_codes) },
      format:              { type: 'string' },
      explanation:         { type: 'string' },
      supporting_evidence: { type: 'array', items: { type: 'string' } },
      suggested_actions:   { type: 'array', items: { type: 'string' } },
      confidence:          { type: 'string', enum: ['high', 'medium', 'low'] }
    },
    required: ['diagnosis', 'format', 'explanation', 'supporting_evidence', 'suggested_actions', 'confidence'],
    additionalProperties: false
  };

  return callClaudeJson_(systemPrompt, creativeData, schema, 'low', 'diagnoseMcoCreative');
}

/**
 * Generate a short summary of format spend & revenue trends.
 * Called from Dashboard.html after charts render.
 */
function summarizeFormatTrends(trendData) {
  var systemPrompt = getSkillContent() + '\n\n' + [
    '## Your Task',
    'You are analyzing format-level performance trends for a Liftoff campaign.',
    'The user provides JSON with: formatMetrics (spend/ROAS/RPI per format), dailyFormatMetrics (time series), and campaign context.',
    '',
    'Rules:',
    '- Format names in the data are MCO Inventory Group names. ALWAYS use the exact name from the input.',
    '- Reference specific numbers (spend %, ROAS values, RPI).',
    '- Flag formats with declining ROAS or disproportionate spend vs performance.',
    '- Remember format-level spend is decided by ML pricing, not by MCO — do not attribute a spend shift to MCO.',
    '- Keep it actionable for a Performance Strategist.',
  ].join('\n');

  var schema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      format_insights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            format:  { type: 'string' },
            trend:   { type: 'string', enum: ['improving', 'declining', 'stable', 'volatile'] },
            insight: { type: 'string' }
          },
          required: ['format', 'trend', 'insight'],
          additionalProperties: false
        }
      },
      recommendation: { type: 'string' }
    },
    required: ['summary', 'format_insights', 'recommendation'],
    additionalProperties: false
  };

  return callClaudeJson_(systemPrompt, trendData, schema, 'medium', 'summarizeFormatTrends');
}


// ─── Skill utilities ────────────────────────────────────────
/**
 * Show what the AI actually receives as its system prompt — run from the editor.
 * The skill is compiled into this file (no Drive fetch, nothing to invalidate), so this
 * is a pure check that the generated block and the MCO_RULES block are both present.
 */
function testSkillLoad() {
  var content = getSkillContent();
  Logger.log('System prompt: ' + content.length + ' chars');
  Logger.log('First 200 chars: ' + content.substring(0, 200));
  var hasRules = content.indexOf('Authoritative thresholds') >= 0;
  Logger.log('MCO_RULES block present: ' + hasRules);
  return (content.length > 100 && hasRules)
    ? 'OK — ' + content.length + ' chars, rules block present'
    : 'WARN — check MCO_SKILL / mcoRulesPromptBlock()';
}


// ═══════════════════════════════════════════════════════════
// ANALYSIS ENGINE (merged from Analysis.gs)
// ═══════════════════════════════════════════════════════════

function analyzeCreativePerformance(perfData, statusLog, campaignConfig, lookbackDays) {
  if (!perfData || perfData.length === 0) {
    return { error: 'No creative performance data found for this query.' };
  }

  var mcoEnabled = detectMCO(campaignConfig, perfData);
  var campType = detectCampaignType(campaignConfig, perfData);
  var kpiTarget = parseFloat(campaignConfig.kpi_target) || null;
  var appName = perfData[0].app_name || campaignConfig.app_name || 'Unknown App';
  var appId = perfData[0].app_id || campaignConfig.app_id || '';

  var totalSpend = _sum(perfData, 'spend');
  var totalRevenue = _sum(perfData, 'revenue');
  var uniqueCreatives = _unique(perfData, 'creative_id');
  var totalCreatives = uniqueCreatives.length;

  perfData.forEach(function(r) {
    r._status = _normalizeStatus(r.status);
    r._spend = parseFloat(r.spend) || 0;
    r._roas = parseFloat(r.roas);
    r._rpa = parseFloat(r.rpa);
    r._rpi = parseFloat(r.rpi);
    r._sow = parseFloat(r.sow_pct) || (totalSpend > 0 ? (r._spend / totalSpend * 100) : 0);
    r._sow = Math.round(r._sow * 10) / 10;
    r._variance = (r.variance || '').toString().toLowerCase();
  });

  var activeCreatives = perfData.filter(function(r) { return r._status === 'active'; });
  var activeCount = _unique(activeCreatives, 'creative_id').length;

  var primaryMetric = _getPrimaryMetric(campType);
  var metricKey = '_' + primaryMetric;
  var isLowerBetter = (campType === 'ua_cpa');

  var validMetrics = perfData.filter(function(r) { return !isNaN(r[metricKey]) && r[metricKey] !== null; });
  // Spend-weighted average (ratio-of-sums) so it aligns with the campaign-level SQL:
  // For ROAS: Σ(roas_i × rev_i)/Σrev_i ≈ Σcust_rev/Σrev. Weight = revenue (GR); fallback to simple average.
  var avgMetric = 0;
  if (validMetrics.length > 0) {
    var wNum = 0, wDen = 0;
    validMetrics.forEach(function(r) {
      var w = (r._revenue != null ? r._revenue : (r.revenue != null ? r.revenue : null));
      if (w == null || isNaN(w) || w <= 0) w = (r._spend || 0);
      if (w > 0) { wNum += r[metricKey] * w; wDen += w; }
    });
    avgMetric = wDen > 0
      ? wNum / wDen
      : validMetrics.reduce(function(s, r) { return s + r[metricKey]; }, 0) / validMetrics.length;
  }

  var formatBreakdown = _groupBy(perfData, 'ad_format', function(rows) {
    return {
      spend: _sum(rows, '_spend'),
      count: rows.length,
      activeCount: rows.filter(function(r) { return r._status === 'active'; }).length,
    };
  });

  var groupBreakdown = _groupBy(perfData, 'mco_group', function(rows) {
    var active = rows.filter(function(r) { return r._status === 'active'; });
    return {
      spend: _sum(rows, '_spend'),
      count: rows.length,
      activeCount: active.length,
      healthy: active.length >= THRESHOLDS.MIN_CREATIVES_PER_GROUP,
      critical: active.length <= 1,
    };
  });

  var activeFormats = {};
  activeCreatives.forEach(function(r) {
    // Use mco_group (MCO Inventory Group name) — matches KEY_FORMATS and table grouping
    var grp = r.mco_group || toMcoGroup(r.competing_group) || r.ad_format;
    if (grp) activeFormats[grp] = true;
  });
  // Formats that have ANY creative (active or paused) — to distinguish Missing vs All-paused
  var anyFormats = {};
  perfData.forEach(function(r) {
    var grp = r.mco_group || toMcoGroup(r.competing_group) || r.ad_format;
    if (grp) anyFormats[grp] = true;
  });

  var coverage = {};
  var missingFormats = [];   // no creatives at all — matches table "Missing" tag
  var allPausedFormats = []; // creatives exist but 0 active — matches table "All paused" tag
  KEY_FORMATS.forEach(function(f) {
    var hasActive = !!activeFormats[f];
    coverage[f] = hasActive;
    if (!hasActive) {
      if (anyFormats[f]) allPausedFormats.push(f);
      else missingFormats.push(f);
    }
  });

  var freshnessResult = _checkFreshness(perfData);

  var creativePerf = perfData.map(function(r) {
    var flags = [];
    var metricVal = r[metricKey];

    if (!isNaN(metricVal) && metricVal !== null) {
      if (campType === 'ua_cpr' || campType === 're') {
        if (kpiTarget && metricVal < kpiTarget) flags.push('below_kpi');
        if (metricVal < avgMetric * THRESHOLDS.UNDERPERFORM_THRESHOLD) flags.push('below_avg');
      } else if (campType === 'ua_cpa') {
        if (kpiTarget && metricVal > kpiTarget) flags.push('above_kpi');
        if (metricVal > avgMetric * THRESHOLDS.OVERPERFORM_THRESHOLD) flags.push('above_avg');
      } else {
        if (metricVal > avgMetric * THRESHOLDS.OVERPERFORM_THRESHOLD) flags.push('high_rpi');
      }
    }

    if (r._sow > THRESHOLDS.SOW_WARN_PCT) flags.push('high_sow');
    if (r._sow >= 99) flags.push('sole_creative');

    return {
      creative_id: r.creative_id,
      ad_format: r.ad_format,
      competing_group: r.competing_group,
      status: r._status,
      spend: r._spend,
      roas: isNaN(r._roas) ? null : Math.round(r._roas * 100) / 100,
      rpa: isNaN(r._rpa) ? null : Math.round(r._rpa * 100) / 100,
      rpi: isNaN(r._rpi) ? null : Math.round(r._rpi * 1000) / 1000,
      sow: r._sow,
      variance: r._variance,
      metricVal: isNaN(metricVal) ? null : Math.round(metricVal * 100) / 100,
      flags: flags,
      created_date: r.created_date,
    };
  });

  creativePerf.sort(function(a, b) { return b.spend - a.spend; });

  var activeWithMetric = creativePerf.filter(function(r) {
    return r.status === 'active' && r.metricVal !== null;
  });

  var topPerformers, underperformers;
  if (campType === 'ua_cpr' || campType === 're') {
    activeWithMetric.sort(function(a, b) { return b.metricVal - a.metricVal; });
    topPerformers = activeWithMetric.slice(0, 3);
    underperformers = creativePerf.filter(function(r) {
      return r.flags.indexOf('below_kpi') >= 0 || r.flags.indexOf('below_avg') >= 0;
    });
  } else {
    activeWithMetric.sort(function(a, b) { return a.metricVal - b.metricVal; });
    topPerformers = activeWithMetric.slice(0, 3);
    underperformers = creativePerf.filter(function(r) {
      return r.flags.indexOf('above_kpi') >= 0 || r.flags.indexOf('above_avg') >= 0 || r.flags.indexOf('high_rpi') >= 0;
    });
  }

  var spendShifts = _analyzeSpendShifts(formatBreakdown);

  var recommendations = _generateRecommendations({
    missingFormats: missingFormats,
    allPausedFormats: allPausedFormats,
    groupBreakdown: groupBreakdown,
    underperformers: underperformers,
    topPerformers: topPerformers,
    highSow: creativePerf.filter(function(r) { return r.flags.indexOf('high_sow') >= 0 && r.flags.indexOf('sole_creative') < 0; }),
    freshnessResult: freshnessResult,
    campType: campType,
    primaryMetric: primaryMetric,
    kpiTarget: kpiTarget,
    avgMetric: avgMetric,
    mcoEnabled: mcoEnabled,
    totalSpend: totalSpend,
    activeCount: activeCount,
  });

  return {
    appName: appName,
    appId: appId,
    campType: campType,
    campTypeLabel: getCampaignLabel(campType),
    mcoEnabled: mcoEnabled,
    kpiTarget: kpiTarget,
    lookbackDays: lookbackDays,
    primaryMetric: primaryMetric,
    totalSpend: Math.round(totalSpend),
    totalRevenue: Math.round(totalRevenue),
    totalCreatives: totalCreatives,
    activeCreatives: activeCount,
    avgMetric: Math.round(avgMetric * 100) / 100,
    formatBreakdown: formatBreakdown,
    groupBreakdown: groupBreakdown,
    coverage: coverage,
    missingFormats: missingFormats,
    allPausedFormats: allPausedFormats,
    creativePerf: creativePerf,
    topPerformers: topPerformers,
    underperformers: underperformers,
    statusLog: _formatStatusLog(statusLog),
    freshnessResult: freshnessResult,
    spendShifts: spendShifts,
    recommendations: recommendations,
    ciDashboardSetup: _getCIDashboardSetup(campType),
  };
}

function detectMCO(config, data) {
  if (config.mco_enabled !== null && config.mco_enabled !== undefined) {
    var val = String(config.mco_enabled).toLowerCase();
    return val === 'true' || val === 'enabled' || val === '1' || val === 'yes';
  }
  return false;
}

function detectCampaignType(config, data) {
  if (config.campaign_type) {
    var t = String(config.campaign_type).toLowerCase();
    if (t.indexOf('cpr') >= 0 || t.indexOf('roas') >= 0) return 'ua_cpr';
    if (t.indexOf('cpa') >= 0) return 'ua_cpa';
    if (t.indexOf('cpi') >= 0) return 'ua_cpi';
    if (t.indexOf('reengag') >= 0 || t.indexOf('re ') >= 0 || t === 're') return 're';
  }
  if (data.some(function(r) { return r.roas !== null && r.roas !== undefined && r.roas !== ''; })) return 'ua_cpr';
  if (data.some(function(r) { return r.rpa !== null && r.rpa !== undefined && r.rpa !== ''; })) return 'ua_cpa';
  return 'ua_cpi';
}

function _getPrimaryMetric(campType) {
  // Mapping lives in PRIMARY_METRIC_BY_CAMPAIGN_TYPE (top of file) — the client reads the
  // same table via getConfig(), so a label there can't disagree with the metric used here.
  return PRIMARY_METRIC_BY_CAMPAIGN_TYPE[campType] || 'rpi';
}

function getCampaignLabel(t) {
  return { ua_cpr: 'UA CPR (ROAS)', ua_cpa: 'UA CPA', ua_cpi: 'UA CPI', re: 'Reengagement' }[t] || t;
}

function _getCIDashboardSetup(campType) {
  var setup = { model_type: '', primary_metric: '', secondary_metric: 'RPI (cross-format comparison)', variance_level: 'Auto (95% CI)', special_notes: '' };
  if (campType === 'ua_cpr') { setup.model_type = 'CPR'; setup.primary_metric = 'ROAS vs client KPI per competing group'; }
  else if (campType === 'ua_cpa') { setup.model_type = 'CPA'; setup.primary_metric = 'RPA vs campaign average per competing group'; }
  else if (campType === 'ua_cpi') { setup.model_type = 'CPI'; setup.primary_metric = 'RPI within each competing group'; setup.variance_level = '" - " (null)'; setup.special_notes = 'CI not available for CPI campaigns.'; }
  else if (campType === 're') { setup.model_type = 'Reengagement'; setup.primary_metric = 'Low Variance + ROAS/RPA below KPI target'; }
  return setup;
}

function _checkFreshness(data) {
  var dates = data.map(function(r) { return r.created_date ? new Date(r.created_date) : null; }).filter(function(d) { return d && !isNaN(d.getTime()); });
  if (dates.length === 0) return { available: false, message: 'No upload date data available.' };
  var latest = new Date(Math.max.apply(null, dates));
  var now = new Date();
  var daysSince = Math.floor((now - latest) / 86400000);
  return {
    available: true, lastUploadDate: latest.toISOString().split('T')[0], daysSinceUpload: daysSince,
    isStale: daysSince > THRESHOLDS.FRESHNESS_DAYS,
    healthStatus: daysSince <= 30 ? 'healthy' : daysSince <= THRESHOLDS.FRESHNESS_DAYS ? 'aging' : 'stale',
    refreshByDate: new Date(latest.getTime() + THRESHOLDS.FRESHNESS_DAYS * 86400000).toISOString().split('T')[0],
  };
}

function _formatStatusLog(log) {
  if (!log || log.length === 0) return [];
  return log.map(function(r) { return { date: r.status_change_date, creative_id: r.creative_id, change_type: r.status_change_type, changed_by: r.status_change_by }; })
    .sort(function(a, b) { return new Date(b.date) - new Date(a.date); }).slice(0, 20);
}

function _analyzeSpendShifts(formatBreakdown) {
  var total = 0;
  Object.keys(formatBreakdown).forEach(function(k) { total += formatBreakdown[k].spend; });
  var shifts = [];
  Object.keys(formatBreakdown).forEach(function(fmt) {
    var pct = total > 0 ? Math.round(formatBreakdown[fmt].spend / total * 1000) / 10 : 0;
    shifts.push({ format: fmt, spend: formatBreakdown[fmt].spend, pct: pct, count: formatBreakdown[fmt].count });
  });
  shifts.sort(function(a, b) { return b.spend - a.spend; });
  return shifts;
}

function _generateRecommendations(ctx) {
  var recs = [];
  var isMCO = !!ctx.mcoEnabled;

  // ── Always applicable (MCO + Free-Floating) ──

  if (ctx.missingFormats.length > 0) {
    recs.push({ level: 'critical', title: 'Fill ' + ctx.missingFormats.length + ' missing creative format' + (ctx.missingFormats.length > 1 ? 's' : ''),
      body: 'No creatives at all in: ' + ctx.missingFormats.join(', ') + '. This limits delivery. Upload creatives for these formats.' });
  }
  if (ctx.allPausedFormats && ctx.allPausedFormats.length > 0) {
    recs.push({ level: 'critical', title: ctx.allPausedFormats.length + ' format' + (ctx.allPausedFormats.length > 1 ? 's have' : ' has') + ' all creatives paused',
      body: 'Creatives exist but none are active in: ' + ctx.allPausedFormats.join(', ') + '. Re-enable the best performer or upload new creatives to restore delivery.' });
  }

  var allPausedGroups = [];
  Object.keys(ctx.groupBreakdown).forEach(function(g) {
    if (g === 'Unknown' || g === 'unknown') return;
    if (ctx.groupBreakdown[g].activeCount === 0 && ctx.groupBreakdown[g].count > 0) allPausedGroups.push(g);
  });
  if (allPausedGroups.length > 0) {
    recs.push({ level: 'critical', title: allPausedGroups.length + ' format' + (allPausedGroups.length > 1 ? 's' : '') + ' have ALL creatives paused',
      body: 'These formats have creatives but all are paused — zero live inventory: ' + allPausedGroups.join(', ') + '. Upload or re-enable creatives immediately to restore delivery.' });
  }

  if (ctx.underperformers.length > 0) {
    var ids = ctx.underperformers.slice(0, 5).map(function(r) { return r.creative_id; });
    var label = ctx.kpiTarget ? 'below KPI (' + ctx.kpiTarget + ')' : 'below campaign average';
    recs.push({ level: 'warning', title: 'Detach ' + ctx.underperformers.length + ' underperforming creative' + (ctx.underperformers.length > 1 ? 's' : ''),
      body: 'Creatives ' + label + ': ' + ids.join(', ') + (ctx.underperformers.length > 5 ? '...' : '') + '. Detach from this campaign only. Limit to 20% of GR per round. Keep at least 1 per format.' });
  }

  if (ctx.freshnessResult.available && ctx.freshnessResult.isStale) {
    recs.push({ level: 'warning', title: 'Creative set is stale (>' + THRESHOLDS.FRESHNESS_DAYS + ' days since last upload)',
      body: 'Last upload was ' + ctx.freshnessResult.daysSinceUpload + ' days ago. Work with CSTs to produce fresh creatives.' });
  }

  if (ctx.topPerformers.length > 0) {
    recs.push({ level: 'success', title: 'Roll out top performers to similar geos',
      body: 'Top creatives by ' + ctx.primaryMetric.toUpperCase() + ': ' + ctx.topPerformers.map(function(r) { return r.creative_id + ' (' + r.metricVal + ')'; }).join(', ') + '. Expand to matching-language geos.' });
  }

  // ── MCO-only recommendations ──

  if (isMCO) {
    var criticalGroups = [];
    Object.keys(ctx.groupBreakdown).forEach(function(g) {
      if (g === 'Unknown' || g === 'unknown') return;
      if (ctx.groupBreakdown[g].activeCount > 0 && ctx.groupBreakdown[g].critical) criticalGroups.push(g);
    });
    if (criticalGroups.length > 0) {
      recs.push({ level: 'critical', title: criticalGroups.length + ' competing group' + (criticalGroups.length > 1 ? 's' : '') + ' at risk',
        body: 'These groups have 1 or fewer active creatives: ' + criticalGroups.join(', ') + '. MCO needs multiple creatives to optimize — target 5-6 per group.' });
    }

    if (ctx.highSow.length > 0) {
      recs.push({ level: 'warning', title: ctx.highSow.length + ' creative' + (ctx.highSow.length > 1 ? 's' : '') + ' exceeding 20% SOW',
        body: 'High spend concentration on: ' + ctx.highSow.map(function(r) { return r.creative_id + ' (' + r.sow + '%)'; }).slice(0, 3).join(', ') + '. MCO is funneling spend to high-ITI creatives. Add more creatives to diversify.' });
    }

    var thinGroups = [];
    Object.keys(ctx.groupBreakdown).forEach(function(g) { if (g === 'Unknown' || g === 'unknown') return; var gb = ctx.groupBreakdown[g]; if (!gb.healthy && !gb.critical && gb.activeCount > 0) thinGroups.push(g + ' (' + gb.activeCount + ')'); });
    if (thinGroups.length > 0) {
      recs.push({ level: 'info', title: thinGroups.length + ' group' + (thinGroups.length > 1 ? 's' : '') + ' below recommended count',
        body: 'Groups with 2-4 active creatives (target 5-6): ' + thinGroups.join(', ') + '. Adding creatives improves MCO optimization.' });
    }
  }

  // ── Free-Floating specific ──

  if (!isMCO) {
    recs.push({ level: 'warning', title: 'Campaign is using Free-Floating (random creative selection)',
      body: 'Creatives are selected randomly instead of by performance. Consider enabling MCO for data-driven creative selection — MCO allocates impressions to the highest-performing creatives based on ITI, which typically improves install rates and overall campaign efficiency. Contact your CST to enable MCO.' });
  }

  // ── Campaign type specific ──

  if (ctx.campType === 'ua_cpi') { recs.push({ level: 'info', title: 'CPI campaign: CI not available', body: 'Use RPI as primary metric within each format group.' }); }
  if (ctx.campType === 're') { recs.push({ level: 'info', title: 'Reengagement: prioritize low-variance creatives', body: 'Focus on creatives with low variance and ROAS/RPA below KPI.' }); }

  recs.push({ level: 'info', title: 'Share findings with CSTs', body: 'Tag CSTs in Slack with: performance results, optimization actions, top performers for expansion, and any new production requests.' });
  return recs;
}

// Utility functions (prefixed with _ to avoid conflict with Code.gs helpers)
function _sum(arr, key) { return arr.reduce(function(s, r) { return s + (parseFloat(r[key]) || 0); }, 0); }
function _unique(arr, key) { var seen = {}; return arr.filter(function(r) { var v = r[key]; if (v && !seen[v]) { seen[v] = true; return true; } return false; }); }
function _groupBy(arr, key, aggregator) { var groups = {}; arr.forEach(function(r) { var k = r[key] || 'Unknown'; if (!groups[k]) groups[k] = []; groups[k].push(r); }); var result = {}; Object.keys(groups).forEach(function(k) { result[k] = aggregator(groups[k]); }); return result; }
function _normalizeStatus(s) { if (!s) return 'unknown'; var l = String(s).toLowerCase(); if (l.indexOf('active') >= 0 || l.indexOf('enabled') >= 0 || l === 'live') return 'active'; if (l.indexOf('paused') >= 0 || l.indexOf('disabled') >= 0) return 'paused'; return l; }