// ============================================================================
// TikTok × Liftoff Creative CPI Analysis — Apps Script Backend (v7)
// ============================================================================

// ── TT Data Source: BigQuery ──
// Project: feishu-sync-493408, Dataset: tiktok_data
var BQ_PROJECT = 'feishu-sync-493408';
var BQ_DATASET = 'tiktok_data';
var BQ_TABLE_ANDROID = 'android_creative';
var BQ_TABLE_IOS     = 'ios_creative';
var BQ_TABLE_RE      = 're_creative';
// Billing project (for running queries) — can be the same or different
var BQ_BILLING_PROJECT = 'tiktok-automation-493206';

var SHEET_KPI = '1DiFK3vwK3qi2DJyqU9GJK4WVUZM_8U6X_yebBMCbbkg';
var TAB_CAMP_MAP = 'Campaign ID Name Source';

// ── Looker API (replaces SHEET_LO) ──
// Credentials are read from Script Properties (Project Settings → Script Properties)
// so they are never hardcoded in source code.
var LOOKER_BASE = 'https://liftoff.cloud.looker.com';

function getLookerConfig_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  return {
    client_id:     props['LOOKER_CLIENT_ID']     || '',
    client_secret: props['LOOKER_CLIENT_SECRET'] || '',
    connection:    props['LOOKER_CONNECTION']    || ''
  };
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('dashboard')
    .setTitle('TikTok Creative CPI Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Return the deployment URL for shareable links
function getDeployUrl() {
  return ScriptApp.getService().getUrl();
}

// === DIAGNOSTIC: BigQuery — run manually to test connection ===
function debugBigQuery() {
  Logger.log('=== BigQuery Test ===');
  Logger.log('Project: ' + BQ_PROJECT);
  Logger.log('Dataset: ' + BQ_DATASET);
  Logger.log('Billing Project: ' + BQ_BILLING_PROJECT);
  
  var tables = [BQ_TABLE_ANDROID, BQ_TABLE_IOS, BQ_TABLE_RE];
  for (var t = 0; t < tables.length; t++) {
    var tbl = tables[t];
    try {
      var fqTable = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.' + tbl + '`';
      
      // Discover columns
      var schemaSql = "SELECT column_name, data_type FROM `" + BQ_PROJECT + "." + BQ_DATASET + ".INFORMATION_SCHEMA.COLUMNS` WHERE table_name = '" + tbl + "'";
      var schemaCols = readBigQuery_(schemaSql);
      var colNames = [];
      for (var i = 1; i < schemaCols.length; i++) colNames.push(schemaCols[i][0] + ' (' + schemaCols[i][1] + ')');
      Logger.log('\n' + tbl + ' columns: ' + colNames.join(', '));
      
      // Find date column
      var dateCol = null;
      var dateCandidates = ['p_date', 'date', 'active_date', 'event_date', 'dt'];
      for (var i = 1; i < schemaCols.length; i++) {
        if (dateCandidates.indexOf(String(schemaCols[i][0]).toLowerCase()) >= 0) { dateCol = schemaCols[i][0]; break; }
      }
      Logger.log('  Date column: ' + (dateCol || 'NOT FOUND'));
      
      // Row count + date range
      if (dateCol) {
        var statsSql = "SELECT COUNT(*) as cnt, MIN(CAST(" + dateCol + " AS STRING)) as min_d, MAX(CAST(" + dateCol + " AS STRING)) as max_d FROM " + fqTable + " WHERE " + dateCol + " IS NOT NULL AND CAST(" + dateCol + " AS STRING) != 'nan'";
        var stats = readBigQuery_(statsSql);
        Logger.log('  Total rows (valid dates): ' + stats[1][0] + ', dates: ' + stats[1][1] + ' ~ ' + stats[1][2]);
      } else {
        var statsSql = "SELECT COUNT(*) as cnt FROM " + fqTable;
        var stats = readBigQuery_(statsSql);
        Logger.log('  Total rows: ' + stats[1][0]);
      }
      
      // Sample row
      var sampleSql = 'SELECT * FROM ' + fqTable + ' LIMIT 2';
      var sample = readBigQuery_(sampleSql);
      Logger.log('  Header: ' + JSON.stringify(sample[0]));
      if (sample.length > 1) Logger.log('  Row 1: ' + JSON.stringify(sample[1]));
      
    } catch(e) {
      Logger.log('\n' + tbl + ': ERROR — ' + e.message);
    }
  }
}

// === DIAGNOSTIC — run this manually in Apps Script to see sample data ===
function debugData() {
  var ttSql = buildTTQuery_(BQ_TABLE_ANDROID, 'android', 'ua', null, null);
  var ttRows = readBigQuery_(ttSql);
  
  Logger.log('=== TT (BigQuery: ' + BQ_TABLE_ANDROID + ') ===');
  Logger.log('TT rows: ' + ttRows.length);
  Logger.log('TT header: ' + JSON.stringify(ttRows[0]));
  Logger.log('TT row1 raw: ' + JSON.stringify(ttRows[1]));
  Logger.log('TT row1 p_date type: ' + typeof ttRows[1][1] + ' instanceof Date: ' + (ttRows[1][1] instanceof Date));
  Logger.log('TT row1 normDate: ' + normDate_(ttRows[1][1]));
  
  var ttH = ttRows[0];
  for (var i = 0; i < ttH.length; i++) {
    Logger.log('TT col ' + i + ': "' + ttH[i] + '"');
  }
  
  var ttDate = normDate_(ttRows[1][1]);
  var ttAd = String(ttRows[1][6] || '').trim();
  var ttCamp = String(ttRows[1][5] || '').trim();
  Logger.log('TT sample key: ad="' + ttAd.substring(0,50) + '" date=' + ttDate + ' camp="' + ttCamp.substring(0,50) + '"');
  
  Logger.log('\n=== LO (Looker API) ===');
  var loData = fetchLookerData_();
  if (loData.error) {
    Logger.log('Looker error: ' + loData.error);
  } else {
    Logger.log('Looker rows: ' + loData.rows.length);
    if (loData.rows.length > 0) {
      var r = loData.rows[0];
      Logger.log('LO sample: date=' + r.date + ' app=' + r.dest_app_id + ' camp=' + String(r.campaign_name).substring(0,50) + ' disp=' + String(r.display_name).substring(0,50) + ' rev=' + r.revenue);
    }
  }
}

// === DIAGNOSTIC: KPI — run manually to check KPI loading ===
function debugKPI() {
  var kpi = readKPI_();
  var keys = Object.keys(kpi).sort();
  Logger.log('Total KPI keys: ' + keys.length);
  for (var i = 0; i < keys.length; i++) {
    var k = kpi[keys[i]];
    Logger.log(keys[i] + ' => cpi=' + k.cpi_kpi + ' poor=' + k.poor_cpi_kpi + ' ltall=' + k.ltall_kpi + ' roi2=' + k.roi2_kpi);
  }
  // Also log raw header for Performance KPI tab
  var ss = SpreadsheetApp.openById(SHEET_KPI);
  var ws = ss.getSheetByName('Performance KPI');
  if (ws) {
    var hdr = ws.getRange(1, 1, 1, ws.getLastColumn()).getValues()[0];
    Logger.log('Performance KPI header: ' + JSON.stringify(hdr));
    var row2 = ws.getRange(2, 1, 1, ws.getLastColumn()).getValues()[0];
    Logger.log('Performance KPI row2 raw: ' + JSON.stringify(row2));
    for (var j = 0; j < row2.length; j++) {
      Logger.log('  col ' + j + ': type=' + typeof row2[j] + ' val=' + row2[j]);
    }
  }
}

function getAnalysisData(dateConfig) {
  try {
    var kpi = readKPI_();
    var campAppMap = readCampAppMap_(); // campaign_name → Advertiser App Name
    
    // ── Read TT (Android + iOS + RE) ──
    var ttMinDate = null, ttMaxDate = null;
    var ttNorm = [];
    
    // Helper: parse a TT BigQuery table into ttNorm array
    // campType: 'ua' or 're'
    function parseTTData_(bqTable, platform, campType) {
      try {
        var dfStart = null, dfEnd = null, loadAll = false;
        if (dateConfig && dateConfig.startDate) dfStart = dateConfig.startDate;
        if (dateConfig && dateConfig.endDate) dfEnd = dateConfig.endDate;
        if (dateConfig && dateConfig.preset === 'all') loadAll = true;
        // For presets like 7d/14d/30d, load default 30 days from BQ, filter precisely later
        var sql = buildTTQuery_(bqTable, platform, campType, dfStart, dfEnd, loadAll);
        var rows = readBigQuery_(sql);
        if (rows.length < 2) return;
        var h = {};
        for (var j = 0; j < rows[0].length; j++) { h[String(rows[0][j]).trim()] = j; }
        function col(row, names) {
          for (var n = 0; n < names.length; n++) {
            if (h[names[n]] !== undefined) return row[h[names[n]]];
          }
          return undefined;
        }
        // Column name variants — includes RE-specific columns
        var DATE_COLS = ['p_date', 'date', 'Date', 'active_date'];
        var CAMP_COLS = ['campaign_name', 'Campaign Name'];
        var AD_COLS = ['ad_name', 'Ad Name', 'ad'];
        var REGION_COLS = campType === 're' 
          ? ['Geo', 'region_code', 'region', 'Region']
          : ['region', 'Region'];
        var APPID_COLS = ['app_id', 'App ID'];
        // DNU column varies by platform and type
        var DNU_COLS;
        if (campType === 're') {
          DNU_COLS = ['名义DRU', 'DRU', 'DNU', 'dnu'];
        } else if (platform === 'ios') {
          DNU_COLS = ['bs_ios_dc_new_user的日均', 'bs_ios_dc_new_user', 'DNU', 'dnu'];
        } else {
          DNU_COLS = ['DNU', 'dnu', 'Dnu'];
        }
        var LTALL_COLS = ['LTall', 'ltall', 'LT', '名义LTall【当前】', '名义LTall_当前_'];
        var ROI2_COLS = ['ROI2', 'roi2', 'ROI'];
        var SPEND_COLS = platform === 'ios'
          ? ['rebate_cost的日均', 'rebate_cost', 'spend', 'Spend', '拉失活rebate_cost']
          : ['spend', 'Spend', '拉失活rebate_cost'];
        
        for (var i = 1; i < rows.length; i++) {
          var row = rows[i];
          var campName = String(col(row, CAMP_COLS) || '').trim();
          var adName = String(col(row, AD_COLS) || '').trim();
          var actualRegion = String(col(row, REGION_COLS) || '').trim().toUpperCase();
          var appId = String(col(row, APPID_COLS) || '').replace(/\.0$/, '');
          
          // For RE: extract app_id from campaign name if missing
          // e.g., TT_engagement_1180_VN_0401_... or 0422-TT-NG-Re-engagement_...
          if ((!appId || appId === '' || appId === 'undefined') && campType === 're') {
            var reAppMatch = campName.match(/(?:engagement|TT)[_-]+(\d{3,5})[_-]/i);
            if (reAppMatch) appId = reAppMatch[1];
          }
          
          var dateN = normDate_(col(row, DATE_COLS));
          if (!dateN) continue;
          if (!ttMinDate || dateN < ttMinDate) ttMinDate = dateN;
          if (!ttMaxDate || dateN > ttMaxDate) ttMaxDate = dateN;
          
          // Skip region mismatch check for RE (region extraction patterns differ)
          if (campType !== 're') {
            var campRegion = extractCampRegion_(campName);
            if (campRegion && campRegion !== actualRegion) continue;
          }
          
          var dnu = parseFloat(col(row, DNU_COLS));
          if (isNaN(dnu)) dnu = 0;
          var ltall = parseFloat(col(row, LTALL_COLS));
          var roi2 = parseFloat(col(row, ROI2_COLS));
          var spend = parseFloat(col(row, SPEND_COLS));
          
          ttNorm.push({
            ad: adName, date: dateN, camp: campName,
            region: actualRegion, app_id: appId, 
            platform: platform || 'android', campaign_type: campType || 'ua',
            dnu: dnu,
            ltall: isNaN(ltall) ? null : ltall,
            roi2: isNaN(roi2) ? null : roi2,
            spend: isNaN(spend) ? 0 : spend
          });
        }
      } catch(e) {
        // Tab might not exist — skip silently
      }
    }
    
    // Read Android UA from BigQuery
    parseTTData_(BQ_TABLE_ANDROID, 'android', 'ua');
    // Read iOS UA from BigQuery
    parseTTData_(BQ_TABLE_IOS, 'ios', 'ua');
    // Read RE (re-engagement) from BigQuery
    parseTTData_(BQ_TABLE_RE, 'android', 're');
    
    if (ttNorm.length === 0) return {error: 'TT sheets empty (both Android and iOS)'};
    if (!ttMinDate || !ttMaxDate) return {error: 'No valid dates in TT sheets'};
    
    // ── Apply date range filter if provided ──
    var filterStart = null, filterEnd = null;
    if (dateConfig && dateConfig.startDate) filterStart = dateConfig.startDate;
    if (dateConfig && dateConfig.endDate) filterEnd = dateConfig.endDate;
    if (dateConfig && dateConfig.preset) {
      var refDate = new Date(ttMaxDate + 'T00:00:00');
      var days = dateConfig.preset === '7d' ? 7 : dateConfig.preset === '14d' ? 14 : dateConfig.preset === '30d' ? 30 : 0;
      if (days > 0) {
        var startD = new Date(refDate); startD.setDate(startD.getDate() - days + 1);
        filterStart = startD.toISOString().substring(0,10);
        filterEnd = ttMaxDate;
      }
    }
    if (filterStart || filterEnd) {
      ttNorm = ttNorm.filter(function(r) {
        if (filterStart && r.date < filterStart) return false;
        if (filterEnd && r.date > filterEnd) return false;
        return true;
      });
      ttMinDate = null; ttMaxDate = null;
      ttNorm.forEach(function(r) {
        if (!ttMinDate || r.date < ttMinDate) ttMinDate = r.date;
        if (!ttMaxDate || r.date > ttMaxDate) ttMaxDate = r.date;
      });
      if (ttNorm.length === 0) return {error: 'No data in selected date range'};
    }
    
    // ── Aggregate TT ──
    var ttAgg = {};
    for (var i = 0; i < ttNorm.length; i++) {
      var r = ttNorm[i];
      var key = r.ad + '||' + r.date + '||' + r.camp;
      if (!ttAgg[key]) ttAgg[key] = {ad:r.ad, date:r.date, camp:r.camp, region:r.region, app_id:r.app_id, platform:r.platform||'android', campaign_type:r.campaign_type||'ua', dnu:0, lt_sum:0, lt_n:0, roi_sum:0, roi_n:0, spend:0};
      var a = ttAgg[key];
      a.dnu += r.dnu;
      a.spend += r.spend;
      if (r.ltall !== null) { a.lt_sum += r.ltall; a.lt_n++; }
      if (r.roi2 !== null) { a.roi_sum += r.roi2; a.roi_n++; }
    }
    
    // ── Read LO from Looker API (date range from TT) ──
    var loData = fetchLookerData_(ttMinDate, ttMaxDate);
    if (loData.error) return {error: 'Looker: ' + loData.error};
    if (loData.rows.length === 0) return {error: 'Looker returned 0 rows'};
    
    var loAgg = {};
    for (var i = 0; i < loData.rows.length; i++) {
      var row = loData.rows[i];
      var dateN = normDate_(row.date);
      if (!dateN) continue;
      var gr = parseFloat(row.revenue);
      if (isNaN(gr) || gr <= 0) continue;
      var disp = String(row.display_name || '').trim();
      var camp = String(row.campaign_name || '').trim();
      var key = disp + '||' + dateN + '||' + camp;
      var campId = parseInt(row.campaign_id, 10);
      var cid = String(row.creative_id || '').trim();
      var fmt = String(row.creative_format || '').trim();
      var loAppId = String(row.dest_app_id || '').trim();
      var appName = String(row.customer_app_name || '').trim();
      var countryList = String(row.country_list || '').trim();
      var creativeState = String(row.creative_state || '').trim();
      var externalId = String(row.external_id || '').trim();
      var campaignState = String(row.campaign_state || '').trim();
      if (!loAgg[key]) loAgg[key] = {disp:disp, date:dateN, camp:camp, gr:0, cid:cid, fmt:fmt, 
        campaign_id: isNaN(campId)?null:campId, lo_app_id: loAppId,
        customer_app_name: appName, country_list: countryList, 
        creative_state: creativeState, external_id: externalId, campaign_state: campaignState};
      loAgg[key].gr += gr;
    }
    
    // ── Merge ──
    var daily = [];
    var ttKeys = Object.keys(ttAgg);
    for (var i = 0; i < ttKeys.length; i++) {
      var t = ttAgg[ttKeys[i]];
      var loKey = t.ad + '||' + t.date + '||' + t.camp;
      var l = loAgg[loKey];
      if (!l) continue;
      var cpi = t.dnu > 0 ? l.gr / t.dnu : 0;
      var ltall = t.lt_n > 0 ? t.lt_sum / t.lt_n : null;
      var roi2 = t.roi_n > 0 ? t.roi_sum / t.roi_n : null;
      // Use Looker's dest_app_id if TT app_id is empty
      var mergedAppId = (t.app_id && t.app_id !== '' && t.app_id !== 'NaN') ? t.app_id : (l.lo_app_id || t.app_id);
      daily.push({
        app_id: mergedAppId, region: t.region, camp: t.camp, ad: t.ad,
        platform: t.platform||'android', campaign_type: t.campaign_type||'ua',
        cid: l.cid, fmt: l.fmt, campaign_id: l.campaign_id, date: t.date,
        customer_app_name: l.customer_app_name || '', country_list: l.country_list || '',
        creative_state: l.creative_state || '', external_id: l.external_id || '', campaign_state: l.campaign_state || '',
        gr: Math.round(l.gr * 100) / 100,
        dnu: Math.round(t.dnu),
        cpi: Math.round(cpi * 100) / 100,
        ltall: ltall, roi2: roi2,
        spend: Math.round(t.spend * 100) / 100
      });
    }
    
    // If no merges, return diagnostic info
    if (daily.length === 0) {
      // Collect date ranges for diagnosis
      var ttDates = {}, loDates = {};
      for (var i = 0; i < ttKeys.length; i++) { var d = ttAgg[ttKeys[i]].date; ttDates[d] = 1; }
      for (var lk in loAgg) { loDates[loAgg[lk].date] = 1; }
      var ttDateList = Object.keys(ttDates).sort();
      var loDateList = Object.keys(loDates).sort();
      
      // Check for partial key matches (same date+camp but different ad/disp)
      var ttDateCamp = {}, loDateCamp = {};
      for (var i = 0; i < ttKeys.length; i++) { var t = ttAgg[ttKeys[i]]; ttDateCamp[t.date+'||'+t.camp] = t.ad.substring(0,40); }
      for (var lk in loAgg) { var l = loAgg[lk]; loDateCamp[l.date+'||'+l.camp] = l.disp.substring(0,40); }
      var overlap = 0;
      for (var k in ttDateCamp) { if (loDateCamp[k]) overlap++; }
      
      return {
        error: 'Merge=0. TT agg:' + ttKeys.length + ' LO agg:' + Object.keys(loAgg).length +
               ' TT norm:' + ttNorm.length +
               ' | TT dates:' + (ttDateList.length>0 ? ttDateList[0]+'~'+ttDateList[ttDateList.length-1] : 'NONE') + '(' + ttDateList.length + 'd)' +
               ' | LO dates:' + (loDateList.length>0 ? loDateList[0]+'~'+loDateList[loDateList.length-1] : 'NONE') + '(' + loDateList.length + 'd)' +
               ' | date+camp overlap:' + overlap +
               ' | TT sample key:' + String(ttKeys[0]||'').substring(0,100) +
               ' | LO sample key:' + String(Object.keys(loAgg)[0]||'').substring(0,100)
      };
    }
    
    // ── Summary per creative ──
    var summaryMap = {};
    for (var i = 0; i < daily.length; i++) {
      var d = daily[i];
      var skey = d.app_id + '|' + d.region + '|' + d.camp + '|' + d.ad;
      if (!summaryMap[skey]) {
        summaryMap[skey] = {
          app_id:d.app_id, region:d.region, camp:d.camp, ad:d.ad,
          platform:d.platform||'android', campaign_type:d.campaign_type||'ua',
          creative_id:d.cid, campaign_id:d.campaign_id, fmt:d.fmt,
          customer_app_name:d.customer_app_name||'', country_list:d.country_list||'',
          creative_state:d.creative_state||'', external_id:d.external_id||'', campaign_state:d.campaign_state||'',
          total_gr:0, total_dnu:0, total_spend:0, days:{},
          lt_w_sum:0, lt_w_n:0, roi_w_sum:0, roi_w_n:0,
          daily_dates:[], daily_gr:[], daily_dnu:[], daily_cpi:[], daily_spend:[]
        };
      }
      var s = summaryMap[skey];
      s.total_gr += d.gr;
      s.total_dnu += d.dnu;
      s.total_spend += d.spend || 0;
      s.days[d.date] = 1;
      if (d.ltall !== null && d.dnu > 0) { s.lt_w_sum += d.ltall * d.dnu; s.lt_w_n += d.dnu; }
      if (d.roi2 !== null && d.dnu > 0) { s.roi_w_sum += d.roi2 * d.dnu; s.roi_w_n += d.dnu; }
      s.daily_dates.push(d.date);
      s.daily_gr.push(d.gr);
      s.daily_dnu.push(d.dnu);
      s.daily_cpi.push(d.cpi);
      s.daily_spend.push(d.spend || 0);
    }
    
    var creatives = [];
    var skeys = Object.keys(summaryMap);
    for (var i = 0; i < skeys.length; i++) {
      var s = summaryMap[skeys[i]];
      var overall_cpi = s.total_dnu > 0 ? s.total_gr / s.total_dnu : 0;
      
      // Try KPI lookup: first by app_id|region, then fallback via Campaign ID Name Source
      var effectiveAppId = s.app_id;
      var platform = s.platform || 'android';
      // Try KPI: first app_id|region|platform, then app_id|region
      var k = {};
      if (effectiveAppId && effectiveAppId !== '' && effectiveAppId !== 'NaN') {
        k = kpi[effectiveAppId + '|' + s.region + '|' + platform] || kpi[effectiveAppId + '|' + s.region] || {};
      }
      
      if (k.cpi_kpi == null && campAppMap) {
        // Try find campaign info: first by exact campaign name, then by campaign_id
        var campInfo = campAppMap.byName[s.camp] || null;
        if (!campInfo && s.campaign_id) {
          campInfo = campAppMap.byId[String(s.campaign_id)] || null;
        }
        if (campInfo) {
          // Try 1: use app_id from campaign map (platform-specific first)
          if (campInfo.app_id) {
            var k2 = kpi[campInfo.app_id + '|' + s.region + '|' + platform] || kpi[campInfo.app_id + '|' + s.region];
            if (k2 && k2.cpi_kpi != null) {
              k = k2;
              effectiveAppId = campInfo.app_id;
            }
          }
          // Try 2: use app_name from campaign map
          if (k.cpi_kpi == null && campInfo.app_name) {
            var k3 = kpi[campInfo.app_name + '|' + s.region + '|' + platform] || kpi[campInfo.app_name + '|' + s.region];
            if (k3 && k3.cpi_kpi != null) {
              k = k3;
            }
          }
          // Fill in missing app_id
          if ((!effectiveAppId || effectiveAppId === '' || effectiveAppId === 'NaN') && campInfo.app_id) {
            effectiveAppId = campInfo.app_id;
          }
        }
      }
      // Determine CPI KPI and Poor KPI based on campaign type
      var cpi_kpi = null, poor_kpi = null;
      var isRE = (s.campaign_type === 're');
      if (isRE) {
        // RE campaigns: use re_ prefix KPI, poor = kpi * 1.5
        cpi_kpi = k.re_cpi_kpi != null ? k.re_cpi_kpi : null;
        poor_kpi = cpi_kpi != null ? Math.round(cpi_kpi * 1.5 * 100) / 100 : null;
      } else {
        // UA campaigns: use regular KPI
        cpi_kpi = k.cpi_kpi != null ? k.cpi_kpi : null;
        poor_kpi = k.poor_cpi_kpi != null ? k.poor_cpi_kpi : null;
      }
      
      var status = 'NO_KPI';
      if (cpi_kpi !== null) {
        if (s.total_dnu < 1 || overall_cpi === 0) {
          // No meaningful DNU — can't determine status even if CPI looks good
          status = 'NO_DNU';
        } else if (overall_cpi <= cpi_kpi) status = 'GOOD';
        else if (poor_kpi !== null && overall_cpi <= poor_kpi) status = 'WATCH';
        else status = 'POOR';
      }
      
      var cidMatch = s.ad.match(/_(\d{5,})_/);
      var cidShort = cidMatch ? cidMatch[1] : (s.creative_id || s.ad.substring(0,20));
      
      var ltall_avg = s.lt_w_n > 0 ? s.lt_w_sum / s.lt_w_n : null;
      var roi2_avg = s.roi_w_n > 0 ? s.roi_w_sum / s.roi_w_n : null;
      
      creatives.push({
        app_id:effectiveAppId||s.app_id, region:s.region, camp:s.camp, ad:s.ad,
        platform:s.platform||'android', campaign_type:s.campaign_type||'ua',
        cid:String(cidShort), creative_id:s.creative_id, campaign_id:s.campaign_id, fmt:s.fmt,
        customer_app_name: s.customer_app_name || '', country_list: s.country_list || '',
        creative_state: s.creative_state || '', external_id: s.external_id || '', campaign_state: s.campaign_state || '',
        total_gr: Math.round(s.total_gr*100)/100,
        total_dnu: Math.round(s.total_dnu),
        total_spend: Math.round(s.total_spend*100)/100,
        days_active: Object.keys(s.days).length,
        overall_cpi: Math.round(overall_cpi*100)/100,
        ltall: ltall_avg !== null ? Math.round(ltall_avg*100)/100 : null,
        roi2: roi2_avg !== null ? Math.round(roi2_avg*10000)/10000 : null,
        cpi_kpi: cpi_kpi, poor_kpi: poor_kpi,
        ltall_kpi: k.ltall_kpi || null,
        roi2_kpi: k.roi2_kpi || null,
        status: status
      });
    }
    
    // ── Region summary ──
    var regMap = {};
    for (var i = 0; i < creatives.length; i++) {
      var c = creatives[i];
      if (c.cpi_kpi === null) continue;
      var rk = c.app_id + '|' + c.region + '|' + (c.campaign_type||'ua');
      if (!regMap[rk]) regMap[rk] = {app_id:c.app_id, region:c.region,
        customer_app_name:c.customer_app_name||'', country_list:c.country_list||'',
        campaign_type:c.campaign_type||'ua',
        total_gr:0, total_dnu:0, n:0, n_good:0, n_watch:0, n_poor:0,
        cpi_kpi:c.cpi_kpi, poor_kpi:c.poor_kpi, ltall_kpi:c.ltall_kpi, roi2_kpi:c.roi2_kpi,
        lt_sum:0, lt_n:0, roi_sum:0, roi_n:0};
      var rm = regMap[rk];
      rm.total_gr += c.total_gr; rm.total_dnu += c.total_dnu; rm.n++;
      if (c.status==='GOOD') rm.n_good++;
      else if (c.status==='WATCH') rm.n_watch++;
      else if (c.status==='POOR') rm.n_poor++;
      if (c.ltall !== null && c.total_dnu > 0) { rm.lt_sum += c.ltall * c.total_dnu; rm.lt_n += c.total_dnu; }
      if (c.roi2 !== null && c.total_dnu > 0) { rm.roi_sum += c.roi2 * c.total_dnu; rm.roi_n += c.total_dnu; }
    }
    var regions = [];
    var rkeys = Object.keys(regMap);
    for (var i = 0; i < rkeys.length; i++) {
      var rm = regMap[rkeys[i]];
      rm.avg_cpi = rm.total_dnu > 0 ? Math.round(rm.total_gr/rm.total_dnu*100)/100 : 0;
      rm.cpi_pass = rm.avg_cpi <= rm.cpi_kpi;
      rm.ltall = rm.lt_n > 0 ? Math.round(rm.lt_sum/rm.lt_n*100)/100 : null;
      rm.roi2 = rm.roi_n > 0 ? Math.round(rm.roi_sum/rm.roi_n*10000)/10000 : null;
      rm.n_creatives = rm.n;
      rm.n_days = 10;
      delete rm.lt_sum; delete rm.lt_n; delete rm.roi_sum; delete rm.roi_n; delete rm.n;
      regions.push(rm);
    }
    regions.sort(function(a,b){return b.total_gr - a.total_gr});
    
    // ── Daily series (sorted by date) ──
    var dailySeries = {};
    for (var i = 0; i < skeys.length; i++) {
      var s = summaryMap[skeys[i]];
      // Sort parallel arrays by date
      var idx = s.daily_dates.map(function(_,j){return j});
      idx.sort(function(a,b){return s.daily_dates[a]<s.daily_dates[b]?-1:s.daily_dates[a]>s.daily_dates[b]?1:0});
      dailySeries[skeys[i]] = {
        dates: idx.map(function(j){return s.daily_dates[j]}),
        gr:    idx.map(function(j){return s.daily_gr[j]}),
        dnu:   idx.map(function(j){return s.daily_dnu[j]}),
        cpi:   idx.map(function(j){return s.daily_cpi[j]}),
        spend: idx.map(function(j){return s.daily_spend[j]})
      };
    }
    
    var allDates = daily.map(function(d){return d.date}).sort();
    var dateRange = allDates.length > 0 ? allDates[0] + ' ~ ' + allDates[allDates.length-1] : 'No data';
    
    // ── Format Audit: find missing creative formats per campaign ──
    var formatAudit = [];
    try {
      var fmtData = fetchFormatAudit_();
      if (fmtData && !fmtData.error) {
        formatAudit = fmtData;
      }
    } catch(e) { /* format audit is optional — don't break main data */ }
    
    return {
      summary: creatives,
      regions: regions,
      daily: dailySeries,
      format_audit: formatAudit,
      date_range: dateRange,
      total_creatives: creatives.length,
      total_matched: daily.length
    };
  } catch(e) {
    return {error: e.message + ' (line ' + (e.lineNumber || '?') + ')'};
  }
}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
function readSheet_(sheetId, tabName) {
  var ss = SpreadsheetApp.openById(sheetId);
  var ws = ss.getSheetByName(tabName);
  if (!ws) throw new Error('Tab not found: ' + tabName + ' in sheet ' + sheetId);
  return ws.getDataRange().getValues();
}

// ── BigQuery: run SQL query → return 2D array (same format as readSheet_) ──
// Requires: BigQuery Advanced Service enabled in Apps Script
//   → Extensions → Apps Script → Services → BigQuery API v2
function readBigQuery_(sql) {
  var request = {
    query: sql,
    useLegacySql: false,
    maxResults: 50000
  };
  
  var response = BigQuery.Jobs.query(request, BQ_BILLING_PROJECT);
  
  // Build header from schema
  var header = response.schema.fields.map(function(f) { return f.name; });
  var fieldTypes = response.schema.fields.map(function(f) { return f.type; });
  var rows = [header];
  
  // Convert BigQuery row format to flat array
  function appendRows(bqRows) {
    if (!bqRows) return;
    for (var i = 0; i < bqRows.length; i++) {
      var row = bqRows[i].f.map(function(field, idx) {
        var v = field.v;
        if (v === null || v === undefined) return '';
        var t = fieldTypes[idx];
        if (t === 'INTEGER' || t === 'INT64') return Number(v);
        if (t === 'FLOAT' || t === 'FLOAT64' || t === 'NUMERIC' || t === 'BIGNUMERIC') return Number(v);
        if (t === 'BOOLEAN' || t === 'BOOL') return v === 'true';
        if (t === 'DATE') return v;
        if (t === 'TIMESTAMP' || t === 'DATETIME') {
          var ts = Number(v);
          if (!isNaN(ts) && ts > 1e9) {
            var d = new Date(ts * 1000);
            return d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2);
          }
          return String(v).substring(0, 10);
        }
        return v;
      });
      rows.push(row);
    }
  }
  
  appendRows(response.rows);
  
  // Handle pagination
  var jobId = response.jobReference.jobId;
  while (response.pageToken) {
    response = BigQuery.Jobs.getQueryResults(BQ_BILLING_PROJECT, jobId, {
      pageToken: response.pageToken,
      maxResults: 50000
    });
    appendRows(response.rows);
  }
  
  return rows;
}

// Build SELECT query for a TT table with date filter
// Auto-detects date column by querying schema first
function buildTTQuery_(bqTable, platform, campType, startDate, endDate, loadAll) {
  var fqTable = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.' + bqTable + '`';
  
  // Discover columns from INFORMATION_SCHEMA
  var dateCol = null;
  try {
    var schemaSql = "SELECT column_name FROM `" + BQ_PROJECT + "." + BQ_DATASET + ".INFORMATION_SCHEMA.COLUMNS` WHERE table_name = '" + bqTable + "'";
    var schemaRows = readBigQuery_(schemaSql);
    var allCols = [];
    for (var i = 1; i < schemaRows.length; i++) { allCols.push(String(schemaRows[i][0]).toLowerCase()); }
    var dateCandidates = ['p_date', 'date', 'active_date', 'event_date', 'dt'];
    for (var d = 0; d < dateCandidates.length; d++) {
      if (allCols.indexOf(dateCandidates[d]) >= 0) { dateCol = dateCandidates[d]; break; }
    }
  } catch(e) {
    dateCol = 'p_date';
  }
  
  // Build query
  if (dateCol) {
    var dateFilter = '';
    if (loadAll) {
      // All dates — only filter out nan/null
      dateFilter = " WHERE CAST(" + dateCol + " AS STRING) != 'nan' AND " + dateCol + " IS NOT NULL";
    } else if (startDate && endDate) {
      dateFilter = " WHERE CAST(" + dateCol + " AS STRING) >= '" + startDate + "' AND CAST(" + dateCol + " AS STRING) <= '" + endDate + "'";
      dateFilter += " AND CAST(" + dateCol + " AS STRING) != 'nan' AND " + dateCol + " IS NOT NULL";
    } else {
      // Default: last 30 days from the LATEST date in the table
      dateFilter = " WHERE CAST(" + dateCol + " AS STRING) >= CAST(DATE_SUB((SELECT MAX(SAFE.PARSE_DATE('%Y-%m-%d', CAST(" + dateCol + " AS STRING))) FROM " + fqTable + "), INTERVAL 30 DAY) AS STRING)";
      dateFilter += " AND CAST(" + dateCol + " AS STRING) != 'nan' AND " + dateCol + " IS NOT NULL";
    }
    return "SELECT * FROM " + fqTable + dateFilter;
  } else {
    // No date column found — use LIMIT as safety net
    return "SELECT * FROM " + fqTable + " LIMIT 50000";
  }
}

// Normalize ANY date value to "YYYY-MM-DD"
// Handles: Date objects, "YYYY-MM-DD", "M/D/YYYY", "YYYYMMDD", epoch numbers, Date.toString()
function normDate_(val) {
  if (val == null || val === '') return null;
  
  // JavaScript Date object (most common from Sheets)
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    var y = val.getFullYear(), m = ('0'+(val.getMonth()+1)).slice(-2), d = ('0'+val.getDate()).slice(-2);
    return y+'-'+m+'-'+d;
  }
  
  // Number — could be serial date or epoch
  if (typeof val === 'number') {
    // Google Sheets serial date (days since 1899-12-30)
    if (val > 40000 && val < 55000) {
      var dt = new Date((val - 25569) * 86400 * 1000);
      if (!isNaN(dt.getTime())) {
        var y = dt.getFullYear(), m = ('0'+(dt.getMonth()+1)).slice(-2), d = ('0'+dt.getDate()).slice(-2);
        return y+'-'+m+'-'+d;
      }
    }
    return null;
  }
  
  var s = String(val).trim();
  if (!s || s === 'nan' || s === 'None' || s === 'NaN') return null;
  
  // "2026-04-12" or "2026-4-2"
  var m1 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m1) return m1[1]+'-'+('0'+m1[2]).slice(-2)+'-'+('0'+m1[3]).slice(-2);
  
  // "4/12/2026" or "04/12/2026"
  var m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m2) return m2[3]+'-'+('0'+m2[1]).slice(-2)+'-'+('0'+m2[2]).slice(-2);
  
  // "20260412"
  var m3 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m3) return m3[1]+'-'+m3[2]+'-'+m3[3];
  
  // Last resort — try Date.parse on the string
  var parsed = new Date(s);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2000) {
    var y = parsed.getFullYear(), mo = ('0'+(parsed.getMonth()+1)).slice(-2), da = ('0'+parsed.getDate()).slice(-2);
    return y+'-'+mo+'-'+da;
  }
  
  return null;
}

function extractCampRegion_(camp) {
  if (!camp) return null;
  // Android: TikTok_GB_AND_... or Bytedance_1233_CA_AND_...
  var m = camp.match(/(?:Bytedance|TikTok|Liftoff|CPA_TikTok)[_ ]+(?:\d+[_ ]+)?(\w{2})[_ ]+AND[_ ]/i);
  if (m) return m[1].toUpperCase();
  var m2 = camp.match(/TikTok\s+Android\s+(\w{2})\s/i);
  if (m2) return m2[1].toUpperCase();
  // iOS: Bytedance_1180_ID_IOS_... or TikTok_1233_CA_IOS_...
  var m3 = camp.match(/(?:Bytedance|TikTok|Liftoff)[_ ]+(?:\d+[_ ]+)?(\w{2})[_ ]+IOS[_ ]/i);
  if (m3) return m3[1].toUpperCase();
  // Generic: look for _XX_AND_ or _XX_IOS_ anywhere in name
  var m4 = camp.match(/[_ ](\w{2})[_ ]+(?:AND|IOS)[_ ]/i);
  if (m4) return m4[1].toUpperCase();
  // Fallback: look for known country codes after underscore+digits+underscore
  var m5 = camp.match(/[_ ]\d+[_ ](\w{2})[_ ]/);
  if (m5 && m5[1].length === 2) return m5[1].toUpperCase();
  return null;
}

function readKPI_() {
  var ss = SpreadsheetApp.openById(SHEET_KPI);
  var kpi = {};
  var tabs = [
    {name:'Performance KPI', prefix:''},
    {name:'Poor Performance KPI', prefix:'poor_'},
    {name:'Good Performance KPI', prefix:'good_'},
    {name:'RE Performance KPI', prefix:'re_'}
  ];
  for (var t = 0; t < tabs.length; t++) {
    var ws = ss.getSheetByName(tabs[t].name);
    if (!ws) continue;
    var rows = ws.getDataRange().getValues();
    var pfx = tabs[t].prefix;
    
    // Auto-detect column layout by reading header row
    var hdr = rows[0];
    var colMap = {};
    for (var j = 0; j < hdr.length; j++) {
      var h = String(hdr[j]).trim().toLowerCase();
      if (h === 'app id' || h === 'app_id') colMap.app_id = j;
      else if (h === 'app name' || h === 'app_name' || h === 'app name') colMap.app_name = j;
      else if (h === 'os') colMap.os = j;
      else if (h === 'region') colMap.region = j;
      else if (h === 'roi2') colMap.roi2 = j;
      else if (h === 'dnu') colMap.dnu = j;
      else if (h.indexOf('cpi') >= 0 || h.indexOf('黑天鹅') >= 0) colMap.cpi = j;  // 黑天鹅CPI
      else if (h === 'ltall') colMap.ltall = j;
    }
    
    // Fallback to old layout if no header match: app_id(0) region(1) ROI2(2) DNU(3) CPI(4) LTall(5)
    if (colMap.app_id == null) colMap = {app_id:0, region:1, roi2:2, dnu:3, cpi:4, ltall:5};
    
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var appIdVal = r[colMap.app_id];
      if (appIdVal == null || appIdVal === '') continue;
      
      // Get OS if available (don't filter — include both android and ios)
      var os = '';
      if (colMap.os != null) {
        os = String(r[colMap.os] || '').trim().toLowerCase();
      }
      
      var appId = String(Math.round(Number(appIdVal)));
      var region = String(r[colMap.region] || '').trim().toUpperCase();
      
      // Store KPI values helper
      function storeKPI_(k) {
        if (!kpi[k]) kpi[k] = {};
        var obj = kpi[k];
        if (colMap.roi2 != null) obj[pfx+'roi2_kpi'] = parseNum_(r[colMap.roi2]);
        if (colMap.dnu != null) obj[pfx+'dnu_kpi'] = parseNum_(r[colMap.dnu]);
        if (colMap.cpi != null) obj[pfx+'cpi_kpi'] = parseNum_(r[colMap.cpi]);
        if (colMap.ltall != null) obj[pfx+'ltall_kpi'] = parseNum_(r[colMap.ltall]);
      }
      
      // Key with OS: app_id|region|os (e.g., 1233|GB|android)
      if (os) storeKPI_(appId + '|' + region + '|' + os);
      // Key without OS: app_id|region (fallback)
      storeKPI_(appId + '|' + region);
      
      // Also index by app_name|region and app_name|region|os
      if (colMap.app_name != null) {
        var appName = String(r[colMap.app_name] || '').trim().toLowerCase();
        if (appName) {
          if (os) storeKPI_(appName + '|' + region + '|' + os);
          storeKPI_(appName + '|' + region);
        }
      }
    }
  }
  return kpi;
}

// Parse a numeric value that might have $, commas, or whitespace
function parseNum_(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') return isNaN(val) ? null : val;
  var s = String(val).replace(/[$,\s%]/g, '').trim();
  if (!s) return null;
  var n = Number(s);
  return isNaN(n) ? null : n;
}

// Read "Campaign ID Name Source" tab → build TWO maps:
//   .byName: campaign_name → {app_name, app_id, campaign_id}
//   .byId:   campaign_id   → {app_name, app_id}
function readCampAppMap_() {
  try {
    var rows = readSheet_(SHEET_KPI, TAB_CAMP_MAP);
    if (rows.length < 3) return {byName:{}, byId:{}};
    
    // Row 0 might be a Looker URL or metadata — find the actual header row
    var headerRow = 0;
    for (var r = 0; r < Math.min(rows.length, 5); r++) {
      var firstCell = String(rows[r][0] || '').trim().toLowerCase();
      // Header row should contain known column names
      if (firstCell.indexOf('campaign') >= 0 || firstCell.indexOf('country') >= 0 || firstCell.indexOf('app') >= 0) {
        headerRow = r;
        break;
      }
      // Check all cells in this row for header-like content
      var rowStr = rows[r].map(function(c){return String(c||'').trim().toLowerCase()}).join('|');
      if (rowStr.indexOf('campaign name') >= 0 || rowStr.indexOf('advertiser app') >= 0) {
        headerRow = r;
        break;
      }
    }
    
    // Auto-detect columns by header
    var hdr = rows[headerRow];
    var colMap = {};
    for (var j = 0; j < hdr.length; j++) {
      var h = String(hdr[j]).trim().toLowerCase();
      if (h.indexOf('campaign name') >= 0 || h === 'campaign_name') colMap.camp_name = j;
      if (h.indexOf('advertiser app name') >= 0) colMap.app_name = j;
      if (!colMap.app_name && (h === 'app name' || h === 'app_name')) colMap.app_name = j;
      if (h === 'campaign id' || h === 'campaign_id') colMap.camp_id = j;
      if (h === 'advertiser app id' || h === 'app id' || h === 'app_id') colMap.app_id = j;
    }
    
    var byName = {}, byId = {};
    for (var i = headerRow + 1; i < rows.length; i++) {
      var r = rows[i];
      
      var entry = {};
      if (colMap.app_name != null) {
        var appName = String(r[colMap.app_name] || '').trim();
        if (appName) entry.app_name = appName.toLowerCase();
      }
      if (colMap.app_id != null) {
        var appIdRaw = r[colMap.app_id];
        if (appIdRaw != null && appIdRaw !== '') {
          entry.app_id = String(Math.round(Number(appIdRaw)));
        }
      }
      
      if (!entry.app_name && !entry.app_id) continue;
      
      // Index by campaign name
      if (colMap.camp_name != null) {
        var campName = String(r[colMap.camp_name] || '').trim();
        if (campName) byName[campName] = entry;
      }
      // Index by campaign id
      if (colMap.camp_id != null) {
        var campIdRaw = r[colMap.camp_id];
        if (campIdRaw != null && campIdRaw !== '') {
          var campId = String(Math.round(Number(campIdRaw)));
          if (campId && campId !== 'NaN') byId[campId] = entry;
        }
      }
    }
    return {byName: byName, byId: byId};
  } catch(e) {
    return {byName:{}, byId:{}};
  }
}

// Debug: show campaign → app mapping and KPI keys
function debugCampMap() {
  var maps = readCampAppMap_();
  var byName = maps.byName, byId = maps.byId;
  Logger.log('Campaign Map: byName=' + Object.keys(byName).length + ' byId=' + Object.keys(byId).length);
  
  // Show header of Campaign ID Name Source
  try {
    var rows = readSheet_(SHEET_KPI, TAB_CAMP_MAP);
    Logger.log('Campaign tab header: ' + JSON.stringify(rows[0]));
    Logger.log('Campaign tab row2: ' + JSON.stringify(rows[1]));
  } catch(e) { Logger.log('Error reading campaign tab: ' + e.message); }
  
  // Show sample byName entries
  var nameKeys = Object.keys(byName);
  Logger.log('\nSample byName (first 10):');
  for (var i = 0; i < Math.min(nameKeys.length, 10); i++) {
    var e = byName[nameKeys[i]];
    Logger.log('  "' + nameKeys[i].substring(0,70) + '" => app_name=' + (e.app_name||'?') + ' app_id=' + (e.app_id||'?'));
  }
  
  // Show sample byId entries
  var idKeys = Object.keys(byId);
  Logger.log('\nSample byId (first 10):');
  for (var i = 0; i < Math.min(idKeys.length, 10); i++) {
    var e = byId[idKeys[i]];
    Logger.log('  id=' + idKeys[i] + ' => app_name=' + (e.app_name||'?') + ' app_id=' + (e.app_id||'?'));
  }
  
  // Specifically check campaign 39539 (the GB one from screenshot)
  Logger.log('\n=== Specific check: campaign_id 39539 ===');
  Logger.log('byId[39539]: ' + JSON.stringify(byId['39539'] || 'NOT FOUND'));
  
  // Check all KPI keys
  var kpi = readKPI_();
  var kpiKeys = Object.keys(kpi).sort();
  Logger.log('\nAll KPI keys (' + kpiKeys.length + '):');
  for (var i = 0; i < kpiKeys.length; i++) {
    Logger.log('  ' + kpiKeys[i] + ' => cpi=' + kpi[kpiKeys[i]].cpi_kpi);
  }
  
  // Check if GB exists in KPI
  Logger.log('\n=== KPI keys containing GB ===');
  for (var i = 0; i < kpiKeys.length; i++) {
    if (kpiKeys[i].indexOf('GB') >= 0 || kpiKeys[i].indexOf('gb') >= 0) {
      Logger.log('  FOUND: ' + kpiKeys[i] + ' => cpi=' + kpi[kpiKeys[i]].cpi_kpi);
    }
  }
}

// ═══════════════════════════════════════════════
// LOOKER API
// ═══════════════════════════════════════════════

// Authenticate with Looker and return access token
// Uses x-www-form-urlencoded (matches working pattern from other projects)
function lookerLogin_() {
  var cfg = getLookerConfig_();
  if (!cfg.client_id || !cfg.client_secret) {
    throw new Error('Looker credentials not set in Script Properties (LOOKER_CLIENT_ID, LOOKER_CLIENT_SECRET)');
  }
  var resp = UrlFetchApp.fetch(LOOKER_BASE + '/api/4.0/login', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: 'client_id=' + encodeURIComponent(cfg.client_id) + '&client_secret=' + encodeURIComponent(cfg.client_secret),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Looker login failed (' + resp.getResponseCode() + '): ' + resp.getContentText().substring(0, 200));
  }
  return JSON.parse(resp.getContentText()).access_token;
}

// Run SQL via Looker SQL Runner API → return {rows:[], error:null}
// startDate/endDate are "YYYY-MM-DD" strings from TT sheet
function fetchLookerData_(startDate, endDate) {
  try {
    var token = lookerLogin_();
    var sql = getLookerSQL_(startDate, endDate);
    var cfg = getLookerConfig_();
    if (!cfg.connection) throw new Error('LOOKER_CONNECTION not set in Script Properties');

    // Step 1: Create SQL query
    var createResp = UrlFetchApp.fetch(LOOKER_BASE + '/api/4.0/sql_queries', {
      method: 'post',
      contentType: 'application/json',
      headers: {'Authorization': 'Bearer ' + token},
      payload: JSON.stringify({
        connection_name: cfg.connection,
        sql: sql
      }),
      muteHttpExceptions: true
    });

    if (createResp.getResponseCode() !== 200) {
      return {rows: [], error: 'SQL create failed (' + createResp.getResponseCode() + '): ' + createResp.getContentText().substring(0, 300)};
    }
    var queryInfo = JSON.parse(createResp.getContentText());
    var slug = queryInfo.slug;
    if (!slug) {
      return {rows: [], error: 'No slug returned. Keys: ' + Object.keys(queryInfo).join(',') + ' Response: ' + createResp.getContentText().substring(0, 300)};
    }

    // Step 2: Run the query — use POST (some Looker instances require POST, not GET)
    var runResp = UrlFetchApp.fetch(LOOKER_BASE + '/api/4.0/sql_queries/' + slug + '/run/json', {
      method: 'post',
      headers: {'Authorization': 'Bearer ' + token},
      muteHttpExceptions: true
    });

    // Fallback: if POST 404s, try GET
    if (runResp.getResponseCode() === 404) {
      runResp = UrlFetchApp.fetch(LOOKER_BASE + '/api/4.0/sql_queries/' + slug + '/run/json?apply_formatting=false', {
        method: 'get',
        headers: {'Authorization': 'Bearer ' + token},
        muteHttpExceptions: true
      });
    }

    if (runResp.getResponseCode() !== 200) {
      return {rows: [], error: 'SQL run failed (' + runResp.getResponseCode() + '): ' + runResp.getContentText().substring(0, 300)};
    }

    var rawRows = JSON.parse(runResp.getContentText());
    if (!Array.isArray(rawRows)) {
      return {rows: [], error: 'Unexpected response format: ' + runResp.getContentText().substring(0, 200)};
    }

    // Map Looker column aliases to our field names
    // Handles both old (revenue_summary.*) and new (cstudio_daily_analytics_v1.*) column names
    var mapped = [];
    for (var i = 0; i < rawRows.length; i++) {
      var r = rawRows[i];
      mapped.push({
        date:            r['event_date'] || r['cstudio_daily_analytics_v1.event_date'] || '',
        dest_app_id:     String(r['dest_app_id'] || r['cstudio_daily_analytics_v1.dest_app_id'] || ''),
        customer_app_name: r['customer_app_name'] || r['cstudio_daily_analytics_v1.customer_app_name'] || '',
        campaign_id:     r['campaign_id'] || r['cstudio_daily_analytics_v1.campaign_id'] || '',
        campaign_name:   r['campaign_name'] || r['cstudio_daily_analytics_v1.campaign_name'] || '',
        country_list:    r['campaign_targeted_country_list'] || r['cstudio_daily_analytics_v1.campaign_targeted_country_list'] || '',
        creative_id:     String(r['creative_id'] || r['pinpoint__creatives_simple.creative_id'] || ''),
        creative_format: r['inventory_format'] || r['pinpoint__creatives_simple.inventory_format'] || '',
        creative_state:  r['creative_state'] || r['pinpoint__creatives_simple.state'] || '',
        external_id:     r['external_id'] || r['pinpoint__creatives_simple.external_id'] || '',
        campaign_state:  r['campaign_state'] || r['pinpoint__campaigns.state'] || '',
        display_name:    r['display_name'] || r['pinpoint__creatives_simple.creative_name'] || '',
        revenue:         r['revenue'] || r['cstudio_daily_analytics_v1.revenue_micros'] || 0
      });
    }

    return {rows: mapped, error: null};
  } catch(e) {
    return {rows: [], error: e.message};
  }
}

// Debug: test Looker connection step by step
function debugLooker() {
  try {
    var cfg = getLookerConfig_();
    Logger.log('=== Looker API Test ===');
    Logger.log('Base: ' + LOOKER_BASE);
    Logger.log('Client ID: ' + (cfg.client_id ? cfg.client_id.substring(0,6)+'...' : 'NOT SET'));
    Logger.log('Connection: ' + (cfg.connection || 'NOT SET'));
    
    // Step 1: Read TT from BigQuery to get date range
    var ttSql = buildTTQuery_(BQ_TABLE_ANDROID, 'android', 'ua', null, null);
    var ttRows = readBigQuery_(ttSql);
    var ttH = {};
    for (var j = 0; j < ttRows[0].length; j++) { ttH[String(ttRows[0][j]).trim()] = j; }
    var dateIdx = ttH['p_date'] != null ? ttH['p_date'] : ttH['date'] != null ? ttH['date'] : ttH['active_date'] != null ? ttH['active_date'] : 1;
    var ttMin = null, ttMax = null;
    for (var i = 1; i < ttRows.length; i++) {
      var d = normDate_(ttRows[i][dateIdx]);
      if (!d) continue;
      if (!ttMin || d < ttMin) ttMin = d;
      if (!ttMax || d > ttMax) ttMax = d;
    }
    Logger.log('TT date range: ' + ttMin + ' ~ ' + ttMax);
    
    // Step 2: Login
    var token = lookerLogin_();
    Logger.log('✓ Login OK');
    
    // Step 3: Build and run SQL
    var sql = getLookerSQL_(ttMin, ttMax);
    Logger.log('SQL length: ' + sql.length);
    Logger.log('SQL first 300: ' + sql.substring(0, 300));
    
    var createResp = UrlFetchApp.fetch(LOOKER_BASE + '/api/4.0/sql_queries', {
      method: 'post', contentType: 'application/json',
      headers: {'Authorization': 'Bearer ' + token},
      payload: JSON.stringify({connection_name: cfg.connection, sql: sql}),
      muteHttpExceptions: true
    });
    Logger.log('Create code: ' + createResp.getResponseCode());
    if (createResp.getResponseCode() !== 200) {
      Logger.log('✗ Create failed: ' + createResp.getContentText().substring(0, 300));
      return;
    }
    
    var slug = JSON.parse(createResp.getContentText()).slug;
    Logger.log('slug: ' + slug);
    
    var runResp = UrlFetchApp.fetch(LOOKER_BASE + '/api/4.0/sql_queries/' + slug + '/run/json', {
      method: 'post', headers: {'Authorization': 'Bearer ' + token}, muteHttpExceptions: true
    });
    Logger.log('Run code: ' + runResp.getResponseCode());
    
    if (runResp.getResponseCode() !== 200) {
      Logger.log('✗ Run failed: ' + runResp.getContentText().substring(0, 500));
      return;
    }
    
    var rawRows = JSON.parse(runResp.getContentText());
    Logger.log('✓ Got ' + rawRows.length + ' rows');
    if (rawRows.length > 0) {
      Logger.log('Columns: ' + Object.keys(rawRows[0]).join(', '));
      Logger.log('Row 0: ' + JSON.stringify(rawRows[0]));
    }
    
    // Show date/app stats
    var dates = {}, apps = {};
    rawRows.forEach(function(r) {
      var d = r['event_date'] || r['cstudio_daily_analytics_v1.event_date'] || '';
      dates[d] = 1;
      var a = String(r['dest_app_id'] || r['cstudio_daily_analytics_v1.dest_app_id'] || '');
      apps[a] = (apps[a]||0)+1;
    });
    var dl = Object.keys(dates).sort();
    Logger.log('LO dates: ' + dl[0] + ' ~ ' + dl[dl.length-1] + ' (' + dl.length + 'd)');
    Logger.log('Apps: ' + JSON.stringify(apps));
    
  } catch(e) {
    Logger.log('✗ Error: ' + e.message);
  }
}

// ── Looker SQL Query ──
// Uses cstudio_daily_analytics_v1 from hive.bi
// Date range is dynamic — passed from TT sheet's date range
// Returns: event_date, dest_app_id, campaign_id, campaign_name, creative_id,
//          display_name, inventory_format, revenue
function getLookerSQL_(startDate, endDate) {
  // Safety: if dates not provided, use last 14 days as fallback
  if (!startDate || !endDate || startDate === 'undefined' || endDate === 'undefined') {
    var now = new Date();
    var end = new Date(now); end.setDate(end.getDate() - 1);
    var start = new Date(now); start.setDate(start.getDate() - 14);
    function pad(d) { return ('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
    startDate = end.getFullYear()+'-'+('0'+(start.getMonth()+1)).slice(-2)+'-'+('0'+start.getDate()).slice(-2);
    endDate = end.getFullYear()+'-'+('0'+(end.getMonth()+1)).slice(-2)+'-'+('0'+end.getDate()).slice(-2);
  }
  // Check Script Properties for custom SQL override
  var stored = PropertiesService.getScriptProperties().getProperty('LOOKER_SQL');
  if (stored) {
    // Replace date placeholders if present
    return stored.replace(/\{start_date\}/g, startDate).replace(/\{end_date\}/g, endDate);
  }
  
  // Default SQL — simplified, no PDT dependency
  return "SELECT\n"
+ "    DATE_FORMAT(from_iso8601_timestamp(a.dt), '%Y-%m-%d') AS \"event_date\",\n"
+ "    a.dest_app_id AS \"dest_app_id\",\n"
+ "    a.dest_app_name AS \"customer_app_name\",\n"
+ "    a.campaign_id AS \"campaign_id\",\n"
+ "    a.campaign_name AS \"campaign_name\",\n"
+ "    a.campaign_targeted_country_list AS \"campaign_targeted_country_list\",\n"
+ "    a.creative_id AS \"creative_id\",\n"
+ "    c.display_name AS \"display_name\",\n"
+ "    c.inventory_format AS \"inventory_format\",\n"
+ "    c.state AS \"creative_state\",\n"
+ "    c.external_id AS \"external_id\",\n"
+ "    camp.state AS \"campaign_state\",\n"
+ "    COALESCE(SUM(a.revenue_micros / CAST(1e6 AS DOUBLE)), 0) AS \"revenue\"\n"
+ "FROM hive.bi.cstudio_analytics_daily_v1 a\n"
+ "LEFT JOIN pinpoint.public.creatives c ON a.creative_id = c.id\n"
+ "LEFT JOIN pinpoint.public.campaigns camp ON a.campaign_id = camp.id\n"
+ "WHERE a.customer_id = 968\n"
+ "  AND from_iso8601_timestamp(a.dt) >= TIMESTAMP '" + startDate + " 00:00:00'\n"
+ "  AND from_iso8601_timestamp(a.dt) <= TIMESTAMP '" + endDate + " 23:59:59'\n"
+ "GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12\n"
+ "HAVING COALESCE(SUM(a.revenue_micros / CAST(1e6 AS DOUBLE)), 0) > 1\n"
+ "LIMIT 100000";
}

// ── Override SQL: run once to store custom SQL in Script Properties ──
// If the inline SQL above needs updating, you can either:
//   (A) Edit it directly in getLookerSQL_() above, OR
//   (B) Paste your full SQL below and run storeLookerSQL() once — it takes priority
function storeLookerSQL() {
  var sql = ''; // ← PASTE YOUR FULL SQL HERE (between the quotes)
  if (!sql) { Logger.log('No SQL provided. Paste it into the sql variable first.'); return; }
  PropertiesService.getScriptProperties().setProperty('LOOKER_SQL', sql);
  Logger.log('✓ SQL stored! Length: ' + sql.length + ' chars. This will override the inline SQL.');
}

function clearStoredSQL() {
  PropertiesService.getScriptProperties().deleteProperty('LOOKER_SQL');
  Logger.log('✓ Stored SQL cleared. Will use inline SQL from getLookerSQL_().');
}

function checkStoredSQL() {
  var sql = PropertiesService.getScriptProperties().getProperty('LOOKER_SQL');
  if (sql) {
    Logger.log('✓ Custom SQL found in Script Properties (takes priority). Length: ' + sql.length);
    Logger.log('First 200 chars: ' + sql.substring(0, 200));
  } else {
    Logger.log('No custom SQL stored. Using inline SQL from getLookerSQL_().');
    var inline = getLookerSQL_();
    Logger.log('Inline SQL length: ' + inline.length);
  }
}

// ═══════════════════════════════════════════════
// CREATIVE FORMAT AUDIT
// ═══════════════════════════════════════════════
var MAJOR_FORMATS = [
  'VAST Portrait Phone',
  'HTML Portrait Phone Interstitial',
  'Native Static',
  'VAST Landscape Phone',
  'Banner Phone',
  'VX Only Interstitial',
  'HTML Landscape Phone Interstitial',
  'MREC Static'
];

// Fetch creative format data per campaign from Looker, compute missing formats
function fetchFormatAudit_() {
  try {
    var token = lookerLogin_();
    var cfg = getLookerConfig_();
    
    var sql = "WITH pinpoint__creatives_simple AS ("
    + "SELECT c.id, c.state FROM pinpoint.public.creatives c), "
    + "pinpoint__campaigns AS ("
    + "SELECT campaigns.id, campaigns.state FROM pinpoint.public.campaigns campaigns) "
    + "SELECT "
    + "  revenue_summary.campaign_id, "
    + "  revenue_summary.campaign_name, "
    + "  cstudio__creative_format.creative_format_derived AS creative_format, "
    + "  revenue_summary.campaign_targeted_country_list, "
    + "  revenue_summary.dest_app_name, "
    + "  COUNT(DISTINCT revenue_summary.creative_id) AS creative_count "
    + "FROM analytics.daily AS revenue_summary "
    + "LEFT JOIN pinpoint__campaigns ON revenue_summary.campaign_id = pinpoint__campaigns.id "
    + "LEFT JOIN pinpoint__creatives_simple ON revenue_summary.creative_id = pinpoint__creatives_simple.id "
    + "LEFT JOIN looker.LR_RBD0D1784177178505_cstudio__creative_format AS cstudio__creative_format "
    + "  ON pinpoint__creatives_simple.id = cstudio__creative_format.creative_id "
    + "WHERE from_iso8601_timestamp(revenue_summary.dt) >= DATE_ADD('day', -30, CURRENT_TIMESTAMP) "
    + "  AND revenue_summary.customer_id = 968 "
    + "  AND pinpoint__campaigns.state = 'enabled' "
    + "  AND pinpoint__creatives_simple.state = 'enabled' "
    + "  AND cstudio__creative_format.creative_format_derived IN ("
    + "    'Banner Phone','HTML Landscape Phone Interstitial','HTML Portrait Phone Interstitial',"
    + "    'MREC Static','Native Static','VAST Landscape Phone','VAST Portrait Phone','VX Only Interstitial') "
    + "  AND revenue_summary.is_uncredited <> 'true' "
    + "GROUP BY 1,2,3,4,5 "
    + "LIMIT 5000";
    
    var createResp = UrlFetchApp.fetch(LOOKER_BASE + '/api/4.0/sql_queries', {
      method: 'post', contentType: 'application/json',
      headers: {'Authorization': 'Bearer ' + token},
      payload: JSON.stringify({connection_name: cfg.connection, sql: sql}),
      muteHttpExceptions: true
    });
    if (createResp.getResponseCode() !== 200) return {error: 'Format audit SQL create failed'};
    
    var slug = JSON.parse(createResp.getContentText()).slug;
    var runResp = UrlFetchApp.fetch(LOOKER_BASE + '/api/4.0/sql_queries/' + slug + '/run/json', {
      method: 'post', headers: {'Authorization': 'Bearer ' + token}, muteHttpExceptions: true
    });
    if (runResp.getResponseCode() !== 200) return {error: 'Format audit SQL run failed'};
    
    var rawRows = JSON.parse(runResp.getContentText());
    if (!Array.isArray(rawRows)) return {error: 'Format audit: unexpected response'};
    
    // Group formats by campaign
    var campFormats = {}; // campaign_name → { formats: {}, campaign_id, app_name, country_list }
    for (var i = 0; i < rawRows.length; i++) {
      var r = rawRows[i];
      var campName = r['campaign_name'] || r['revenue_summary.campaign_name'] || '';
      var fmt = r['creative_format'] || r['cstudio__creative_format.creative_format'] || '';
      var cnt = parseInt(r['creative_count'] || r['count_of_creative_id'] || '0');
      var campId = r['campaign_id'] || r['revenue_summary.campaign_id'] || '';
      var appName = r['dest_app_name'] || r['revenue_summary.dest_app_name'] || '';
      var countryList = r['campaign_targeted_country_list'] || r['revenue_summary.campaign_targeted_country_list'] || '';
      
      if (!campFormats[campName]) {
        campFormats[campName] = {formats: {}, campaign_id: campId, app_name: appName, country_list: countryList};
      }
      if (fmt) campFormats[campName].formats[fmt] = (campFormats[campName].formats[fmt] || 0) + cnt;
    }
    
    // Compute missing formats per campaign
    var audit = [];
    var campNames = Object.keys(campFormats);
    for (var i = 0; i < campNames.length; i++) {
      var cn = campNames[i];
      var cf = campFormats[cn];
      var present = Object.keys(cf.formats);
      var missing = [];
      for (var j = 0; j < MAJOR_FORMATS.length; j++) {
        if (present.indexOf(MAJOR_FORMATS[j]) === -1) missing.push(MAJOR_FORMATS[j]);
      }
      audit.push({
        campaign_name: cn,
        campaign_id: cf.campaign_id,
        app_name: cf.app_name,
        country_list: cf.country_list,
        present: present,
        present_counts: cf.formats,
        missing: missing,
        total_formats: present.length,
        missing_count: missing.length
      });
    }
    // Sort by most missing first
    audit.sort(function(a,b) { return b.missing_count - a.missing_count; });
    return audit;
  } catch(e) {
    return {error: e.message};
  }
}