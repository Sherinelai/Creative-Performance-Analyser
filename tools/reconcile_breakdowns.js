/**
 * Prove the four places that show the same money agree, on a REAL server response.
 *
 * "Video vs Non-video" and "Interactive vs Not Interactive" are sums over subsets of the SAME
 * creative rows the format table and the format chart read, so every one of these must equal
 * Σ gross revenue over creativePerf:
 *
 *   1. Σ moneyOf(c) over creativePerf            — the ground truth
 *   2. aggregateBreakdown().videoMap             — Video + Non-video
 *   3. aggregateBreakdown().interMap             — Interactive + Not Interactive + N/A
 *   4. seriesFromPerf()                          — the format donut / bar
 *   5. the format table's own group accumulator  — Creative Performance by Format
 *
 * It also checks the weighted metrics reconcile: a ratio-of-sums over every slice has to come back
 * to the campaign figure, or one of them is weighting by something else.
 *
 *   node tools/run_pipeline.js <campaignId> <days>     # writes /tmp/result.json
 *   node tools/reconcile_breakdowns.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'appscript', 'Dashboard.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('could not find the <script> block in Dashboard.html'); process.exit(1); }

const makeEl = () => new Proxy({
  innerHTML: '', textContent: '', value: '', tagName: 'DIV', selectedIndex: 0, style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  children: [], options: [], offsetWidth: 800, offsetHeight: 400, checked: false,
  appendChild() {}, removeChild() {}, insertBefore() {}, remove() {}, addEventListener() {},
  removeEventListener() {}, focus() {}, blur() {}, click() {}, setAttribute() {},
  getAttribute: () => null, closest: () => null, querySelector: () => makeEl(),
  querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 400 }),
  scrollIntoView() {}, select() {},
}, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } });

const document = {
  readyState: 'complete', getElementById: () => makeEl(), querySelector: () => makeEl(),
  querySelectorAll: () => [], createElement: () => makeEl(), addEventListener() {},
  body: makeEl(), head: makeEl(), execCommand() {},
};
const sandbox = {
  document,
  window: { addEventListener() {}, innerWidth: 1440, innerHeight: 900, getComputedStyle: () => ({}) },
  navigator: { clipboard: null, userAgent: 'node' }, location: { href: '', search: '' },
  console: { log() {}, warn() {}, error() {} },
  setTimeout: () => 0, clearTimeout() {}, setInterval() {}, clearInterval() {},
  requestAnimationFrame: () => 0,
  encodeURIComponent, decodeURIComponent, Math, Date, JSON, parseFloat, parseInt, isNaN,
  Object, Array, String, Number, Boolean, RegExp, Error, TypeError, Infinity, NaN, undefined,
};
sandbox.window.document = document;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(m[1], ctx, { filename: 'Dashboard.html<script>' });

const real = JSON.parse(fs.readFileSync('/tmp/result.json', 'utf8'));
sandbox.R = real;
vm.runInContext('R = globalThis.R || R;', ctx);

const money = (v) => '$' + Number(v).toFixed(2);
const run = (expr) => vm.runInContext(expr, ctx);

const truth = run("(R.creativePerf||[]).reduce(function(s,c){return s+moneyOf(c);},0)");
const agg = run('aggregateBreakdown()');
const sumMap = (map) => Object.keys(map).reduce((s, k) => s + (map[k].money || 0), 0);
const videoTotal = sumMap(agg.videoMap);
const interTotal = sumMap(agg.interMap);
const donutTotal = run("seriesFromPerf().reduce(function(s,r){return s+r.value;},0)");
// the format table groups exactly as buildTableSection does
const tableTotal = run(`(function(){
  var g={};
  (R.creativePerf||[]).forEach(function(c){
    var dn=c.mco_group||invToDN(c.competing_group);
    g[dn]=(g[dn]||0)+moneyOf(c);
  });
  return Object.keys(g).reduce(function(s,k){return s+g[k];},0);
})()`);

console.log('campaign response: ' + (real.creativePerf || []).length + ' creative rows, lookback ' +
            (real.lookbackDays || '?') + 'd');
console.log('');
const checks = [
  ['Σ gross revenue over creativePerf (truth)', truth],
  ['Video + Non-video', videoTotal],
  ['Interactive + Not Interactive + N/A', interTotal],
  ['Format donut / bar (seriesFromPerf)', donutTotal],
  ['Creative Performance by Format groups', tableTotal],
];
let failed = false;
checks.forEach(([label, v]) => {
  const diff = Math.abs(v - truth);
  const ok = diff < 0.01;
  if (!ok) failed = true;
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + '  ' + label.padEnd(42) + money(v) +
              (ok ? '' : '   off by ' + money(diff)));
});

// The slices themselves, so a mismatch is readable rather than just a total that is wrong.
console.log('\n  slices:');
[['video', agg.videoMap], ['interactive', agg.interMap]].forEach(([dim, map]) => {
  Object.keys(map).forEach((k) => {
    const b = map[k];
    console.log('    ' + dim.padEnd(12) + String(k).padEnd(18) + money(b.money || 0).padStart(14) +
                '  ' + String(b.count).padStart(4) + ' creatives' +
                '  (' + (truth > 0 ? ((b.money || 0) / truth * 100).toFixed(1) : '0') + '%)');
  });
});

// Weighted metrics: the aggregates' OWN accumulators, summed over every slice, must come back to
// the campaign figure. Comparing against a formula invented here would only test the formula.
const cp = real.campaignPerf || {};
const acc = (map, k) => Object.keys(map).reduce((s2, key) => s2 + (map[key][k] || 0), 0);
const aggRoas = acc(agg.videoMap, 'revS') > 0 ? acc(agg.videoMap, 'custRevS') / acc(agg.videoMap, 'revS') : null;
const aggRpa = acc(agg.videoMap, 'evtS') > 0 ? acc(agg.videoMap, 'rpaRevS') / acc(agg.videoMap, 'evtS') : null;
console.log('\n  aggregateBreakdown totals vs campaignPerf:');
const cmp = (label, a, b, tol) => {
  if (a == null || b == null) { console.log('    --    ' + label + ' not comparable'); return; }
  const rel = Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
  if (rel > tol) failed = true;
  console.log('    ' + (rel <= tol ? 'OK  ' : 'FAIL') + '  ' + label.padEnd(22) +
              a.toFixed(6) + ' vs ' + b.toFixed(6) + '   rel ' + rel.toExponential(1));
};
// ROAS tolerance is 1e-4 because creativePerf stores roas rounded to 6 decimals; RPA is exact.
cmp('ROAS (rev-weighted)', aggRoas, cp.roas_d7 != null ? cp.roas_d7 : null, 1e-4);
cmp('RPA (revenue/events)', aggRpa, cp.rpa != null ? cp.rpa : null, 1e-9);

console.log('\n' + (failed ? 'RECONCILE FAILED' : 'all four views reconcile'));
process.exit(failed ? 1 : 0);
