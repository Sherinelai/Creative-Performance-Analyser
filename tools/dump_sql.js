/**
 * Dump the exact SQL appscript/Code.js would send for one campaign, so it can be run against
 * Trino (via creative_mcp) and the app's derived numbers audited against the source rows.
 *
 *   node tools/dump_sql.js <campaignId> [lookbackDays] > /tmp/sql.json
 *
 * Code.js is loaded in a vm with Apps Script services stubbed. getPDT()/getQueuePDT() are
 * overridden with the resolved PDT names so no Looker call is needed — pass them in if they
 * ever change (runHealthCheck prints the current ones).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const campaignId = process.argv[2] || '41535';
const lookbackDays = parseInt(process.argv[3] || '30', 10);

const CREATIVE_FORMAT_PDT = 'looker.lr_rbd0d1785124923808_cstudio__creative_format';
const QUEUE_PDT = 'looker.lr_rbec01785126641966_queue_creative_statistics';

const src = fs.readFileSync(path.join(__dirname, '..', 'appscript', 'Code.js'), 'utf8');

const store = {};
const sandbox = {
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: (k) => store[k] || 'stub', getProperties: () => store }),
  },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  UrlFetchApp: { fetch() { throw new Error('no network in dump_sql'); }, fetchAll: () => [] },
  SpreadsheetApp: { openById: () => ({ getSheetByName: () => null, insertSheet: () => ({ appendRow() {}, getRange: () => ({ setValues: () => ({ setFontWeight: () => ({ setBackground: () => ({ setFontColor() {} }) }) }) }), setFrozenRows() {} }) }) },
  Session: { getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => '' }) },
  ScriptApp: { getService: () => ({ getUrl: () => '' }) },
  HtmlService: { createHtmlOutputFromFile: () => ({ setTitle: () => ({ setXFrameOptionsMode: () => ({ addMetaTag() {} }) }) }), XFrameOptionsMode: {} },
  DriveApp: {},
  Logger: { log() {} },
  console,
  JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, parseFloat, parseInt,
  isNaN, encodeURIComponent, decodeURIComponent, Infinity, NaN,
};
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'Code.js' });

// Pin the PDTs so nothing needs Looker.
vm.runInContext(
  `getPDT = function(){ return ${JSON.stringify(CREATIVE_FORMAT_PDT)}; };` +
  `getQueuePDT = function(){ return ${JSON.stringify(QUEUE_PDT)}; };`, ctx);

const wanted = {
  perf: `buildCreativeLevelPerfSQL(${campaignId}, ${lookbackDays})`,
  inventory: `buildCreativeInventorySQL(${campaignId})`,
  queuing: `buildQueueingSQL(${campaignId})`,
  exploring: `buildExploringSQL(${campaignId})`,
  optimizing: `buildOptimizingSQL(${campaignId})`,
  dailyFmt: `buildDailyFormatMetricsSQL(${campaignId}, ${lookbackDays})`,
  meta: `buildCampaignMetaSQL(${campaignId})`,
  dailyCr: `buildDailyCreativeMetricsSQL(${campaignId}, ${lookbackDays})`,
  impInst: `buildImpressionInstallSQL(${campaignId}, ${lookbackDays})`,
};

const out = {};
for (const [key, expr] of Object.entries(wanted)) {
  try {
    out[key] = vm.runInContext(expr, ctx);
  } catch (e) {
    out[key] = { error: String(e.message || e) };
  }
}
process.stdout.write(JSON.stringify(out, null, 1));
