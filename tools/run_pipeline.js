/**
 * Run appscript/Code.js's fetchCreativeData end-to-end in Node against pre-fetched rows.
 *
 * dump_sql.js only proves the SQL builds. This runs the whole SERVER pipeline — mergeAllData,
 * analyzeCreativePerformance, the classification, the recommendations — which render_smoke_test.js
 * cannot reach (it drives the client with demo data). Use it whenever numbers in the dashboard look
 * wrong or missing: it prints the same figures the KPI tiles and the table read.
 *
 *   node tools/dump_sql.js <campaignId> <lookbackDays> <appId> > /tmp/sql_all.json
 *   <fetch each query through creative_mcp, save {key: rows} to /tmp/rows_all.json>
 *   node tools/run_pipeline.js <campaignId> [lookbackDays]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const campaignId = process.argv[2] || '41535';
const lookbackDays = parseInt(process.argv[3] || '30', 10);
const ROWS = JSON.parse(fs.readFileSync('/tmp/rows_all.json', 'utf8'));

// These are DATED PDTs: Looker regenerates them under a new name, and the old one stops existing
// (`Table 'hive.looker.lr_...' does not exist`). The app never hardcodes them — getPDT() /
// getQueuePDT() resolve and column-verify at runtime. These constants are only here so the SQL can
// be BUILT offline; when a query suddenly says the table is gone, refresh them with
//   SHOW TABLES FROM looker LIKE '%cstudio__creative_format%'
const CREATIVE_FORMAT_PDT = 'looker.lr_rbd0d1785211467189_cstudio__creative_format';
const QUEUE_PDT = 'looker.lr_rbec01785126641966_queue_creative_statistics';

const src = fs.readFileSync(path.join(__dirname, '..', 'appscript', 'Code.js'), 'utf8');
const logs = [];
const sandbox = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'stub', getProperties: () => ({}) }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  UrlFetchApp: { fetch() { throw new Error('no network'); }, fetchAll: () => [] },
  SpreadsheetApp: { openById: () => { throw new Error('no sheets'); } },
  Session: { getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => '' }) },
  ScriptApp: { getService: () => ({ getUrl: () => '' }) },
  HtmlService: { createHtmlOutputFromFile: () => ({}), XFrameOptionsMode: {} },
  DriveApp: {},
  Logger: { log: (m) => logs.push(String(m)) },
  console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
  parseFloat, parseInt, isNaN, encodeURIComponent, decodeURIComponent, Infinity, NaN,
};
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'Code.js' });

// Serve the pre-fetched rows instead of hitting Looker.
sandbox.__ROWS = ROWS;
vm.runInContext(`
  getPDT = function(){ return ${JSON.stringify(CREATIVE_FORMAT_PDT)}; };
  getQueuePDT = function(){ return ${JSON.stringify(QUEUE_PDT)}; };
  // The saved dump is a whole-window perf read, so drive the unchunked path here. Chunk combining
  // is verified straight against Trino instead — it needs the s_* sum columns this dump lacks.
  perfChunkWindows_ = function(){ return null; };
  runSQL = function(sql){
    if (/SHOW TABLES/i.test(sql)) return [];
    if (/campaigns c /i.test(sql) && /campaign_id/i.test(sql)) return __ROWS.search || [];
    return [];
  };
  runSQLParallel = function(map){
    var out = {};
    Object.keys(map).forEach(function(k){ out[k] = __ROWS[k] || []; });
    return out;
  };
  fetchCampaignSearch = function(){ return __ROWS.search || []; };
  fetchCreativeDailyMetrics = function(){ return __ROWS.dailyCr || []; };
`, ctx);

// `node tools/run_pipeline.js <cid> <days> overview` runs the fast pass the client asks for first.
const overviewOnly = process.argv[4] === 'overview';
const r = vm.runInContext(
  `fetchCreativeData(${JSON.stringify(String(campaignId))}, 'campaign', ${lookbackDays}, {}, ` +
  `${JSON.stringify({ overviewOnly })})`, ctx);

if (r && r.error) { console.error('ERROR from fetchCreativeData: ' + r.error); process.exit(1); }

const cp = r.campaignPerf || {};
const n = (v) => (v == null ? 'null' : (typeof v === 'number' ? v.toFixed(4) : String(v)));
console.log('── headline numbers the dashboard reads ──');
console.log('  totalSpend        ', n(r.totalSpend));
console.log('  totalCreatives    ', n(r.totalCreatives), ' activeCreatives', n(r.activeCreatives));
console.log('  primaryMetric     ', n(r.primaryMetric), ' _isCpa', n(r._isCpa));
console.log('  avgMetric         ', n(r.avgMetric), ' kpiTarget', n(r.kpiTarget));
// revenue_d7 is the field name, and it is what the "Gross revenue" KPI tile reads.
console.log('  campaignPerf      ', 'spend=' + n(cp.spend), 'grossRevenue=' + n(cp.revenue_d7),
            'roas_d7=' + n(cp.roas_d7), 'rpi=' + n(cp.rpi), 'rpa=' + n(cp.rpa));
console.log('  creativePerf rows ', (r.creativePerf || []).length,
            ' formatMetrics', (r.formatMetrics || []).length,
            ' dailyFormatMetrics', (r.dailyFormatMetrics || []).length);
console.log('  statusLog         ', (r.statusLog || []).length,
            ' recommendations', (r.recommendations || []).length);

const c0 = (r.creativePerf || []).find((c) => (c.spend || 0) > 0) || (r.creativePerf || [])[0];
if (c0) {
  console.log('── a creative row with spend ──');
  ['creative_id','status','competing_group','mco_group','spend','revenue','roas','rpi','rpa','iti','ipm','variance','perf_class','lifecycle_state','is_metricless','is_unassigned']
    .forEach((k) => console.log('  ' + k.padEnd(18), n(c0[k])));
}
const nulls = ['spend','revenue','roas','rpi'].filter(
  (k) => (r.creativePerf || []).every((c) => c[k] == null || c[k] === 0));
if (nulls.length) console.log('\n!! every creative has null/0 for: ' + nulls.join(', '));
fs.writeFileSync('/tmp/result.json', JSON.stringify(r));
console.log('\n(wrote /tmp/result.json for tools/render_smoke_test.js --real)');
console.log('\n── Logger output ──');
logs.forEach((l) => console.log('  ' + l));
