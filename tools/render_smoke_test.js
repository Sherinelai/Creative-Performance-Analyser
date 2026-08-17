/**
 * Render smoke test for appscript/Dashboard.html.
 *
 * Loads the dashboard's inline <script> in Node behind a Proxy-based DOM stub, then drives
 * the demo data path (loadDummy) so the whole render chain — renderDashboard, renderOverview,
 * the charts, the merged table — actually executes. A ReferenceError or TypeError anywhere in
 * that chain surfaces here with a stack, instead of silently truncating the page in a browser
 * (a thrown error mid-render leaves everything after the throw point unrendered).
 *
 *   node tools/render_smoke_test.js            # demo campaign types: ua_cpr, ua_cpa
 *
 * `google` is left undefined so the script takes the non-Apps-Script branch — which means CFG
 * is never populated. That is deliberate: it is the worst case for the getConfig()-fed config
 * (mcoRules/metrics/mcoGroupMap/ALL_DN all empty), so anything that assumes config is present
 * fails here.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'appscript', 'Dashboard.html');
const src = fs.readFileSync(HTML, 'utf8');
const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(src)[1];

// ── DOM stub ────────────────────────────────────────────────
// Every property read returns another stub, so unknown DOM usage doesn't crash the harness
// and we only see errors from the dashboard's own logic.
const makeEl = () => {
  const el = {
    innerHTML: '', textContent: '', value: '', tagName: 'DIV', selectedIndex: 0,
    style: {}, dataset: {}, classList: {
      add() {}, remove() {}, toggle() {}, contains: () => false,
    },
    children: [], options: [], offsetWidth: 800, offsetHeight: 400, checked: false,
    appendChild() {}, removeChild() {}, insertBefore() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    setAttribute() {}, getAttribute: () => null, closest: () => null,
    querySelector: () => makeEl(), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 400 }),
    scrollIntoView() {}, select() {},
  };
  return new Proxy(el, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string' && /^(on|has|is)/.test(k)) return undefined;
      return undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
};

// One element per id, so what the render WRITES is observable. A fresh stub per call made every
// assertion about content impossible — and "did not throw" is not the same as "drew something":
// campaign 73853 came back with an empty overview panel and no exception at all.
const elements = new Map();
const byId = (id) => {
  if (!elements.has(id)) elements.set(id, makeEl());
  return elements.get(id);
};

const document = {
  readyState: 'complete',
  getElementById: byId,
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  addEventListener() {},
  body: makeEl(),
  head: makeEl(),
  execCommand() {},
};

const errors = [];
const sandbox = {
  document,
  window: { addEventListener() {}, innerWidth: 1440, innerHeight: 900, getComputedStyle: () => ({}) },
  navigator: { clipboard: null, userAgent: 'node' },
  location: { href: '', search: '' },
  console: { log() {}, warn() {}, error(...a) { errors.push('console.error: ' + a.join(' ')); } },
  setTimeout: (fn) => { try { fn(); } catch (e) { errors.push('in setTimeout: ' + (e.stack || e)); } },
  clearTimeout() {}, setInterval() {}, clearInterval() {},
  requestAnimationFrame: (fn) => { try { fn(); } catch (e) { errors.push('in rAF: ' + (e.stack || e)); } },
  encodeURIComponent, decodeURIComponent, Math, Date, JSON, parseFloat, parseInt, isNaN,
  Object, Array, String, Number, Boolean, RegExp, Error, TypeError, Infinity, NaN, undefined,
};
sandbox.window.document = document;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(script, ctx, { filename: 'Dashboard.html<script>' });
} catch (e) {
  console.error('FAILED while loading the script (initApp):\n' + (e.stack || e));
  process.exit(1);
}

let failed = false;

// "Rendered" means content landed, not merely that nothing threw. These are the two elements the
// user actually looks at first: the KPI tiles and the overview panel that holds every module.
const REQUIRED = [
  ['kpiRow', 200],
  ['panel-overview', 2000],
];
// A rendered "NaN" or "undefined" is a broken reference that still paints. The SOW column showed
// NaN% for a week because `g.spend` had been renamed to `g.money` and one reference survived at the
// tail of a 300-character line, past where every grep was truncated. Cheap to assert, invisible
// otherwise.
const NO_JUNK = ['kpiRow', 'panel-overview'];
function assertNoJunk(label) {
  NO_JUNK.forEach((id) => {
    const html = (elements.get(id) || { innerHTML: '' }).innerHTML;
    ['NaN', 'undefined', 'Infinity'].forEach((bad) => {
      if (html.indexOf(bad) >= 0) {
        const at = html.indexOf(bad);
        throw new Error('#' + id + ' rendered "' + bad + '" (' + label + '): ...' +
          html.slice(Math.max(0, at - 90), at + 40).replace(/\s+/g, ' ') + '...');
      }
    });
  });
}

function assertRendered(label) {
  assertNoJunk(label);
  // The headline money figure is gross revenue, not spend — a regression here is silent, because
  // both are plausible dollar amounts (78841: $92,972.86 vs $55,927.50).
  const kpi = (elements.get('kpiRow') || { innerHTML: '' }).innerHTML;
  if (kpi && kpi.indexOf('Gross revenue') < 0) {
    throw new Error('KPI row lost its Gross revenue tile (' + label + ')');
  }
  const thin = REQUIRED
    .map(([id, min]) => [id, min, (elements.get(id) || { innerHTML: '' }).innerHTML.length])
    .filter(([, min, len]) => len < min);
  if (thin.length) {
    throw new Error('rendered but empty (' + label + '): ' +
      thin.map(([id, min, len]) => `#${id} ${len} chars < ${min}`).join(', '));
  }
}

// --real: drive the render chain with a REAL fetchCreativeData response (written by
// tools/run_pipeline.js). Demo fixtures can't reproduce production data shapes — null mco_group,
// metric-less rows, unassigned statusLog entries — so this is the mode that catches a client
// exception thrown only by real data.
if (process.argv.includes('--real')) {
  const real = JSON.parse(fs.readFileSync('/tmp/result.json', 'utf8'));
  ctx.R = real;
  try {
    vm.runInContext('R = globalThis.R || R; onData(R);', ctx);
    if (errors.length) throw new Error(errors.join('\n'));
    assertRendered('REAL data' + (real.partial ? ', overview pass' : ''));
    console.log('PASS  render chain on REAL data' + (real.partial ? ' (overview pass)' : ''));
  } catch (e) {
    console.error('FAIL  render chain on REAL data:\n' + (e.stack || e) + '\n');
    process.exit(1);
  }
  process.exit(0);
}

for (const type of ['cpr', 'cpa']) {
  errors.length = 0;
  try {
    vm.runInContext(`loadDummy(${JSON.stringify(type)})`, ctx);
    if (errors.length) throw new Error(errors.join('\n'));
    assertRendered(type);
    console.log(`PASS  render chain for ${type}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL  render chain for ${type}:\n${e.stack || e}\n`);
  }
}

// Video vs Non-video must be classified off the MCO Inventory Group name (VAST = Video), never
// off is_video_creative. The demo fixtures carry no is_video field at all, so the old flag-based
// rule filed every demo creative under Non-video — a degenerate chart that threw nothing and
// looked plausible. Counts are pinned to the fixtures; update them if the fixtures change.
errors.length = 0;
try {
  vm.runInContext(`
    var _expect = {cpr: {Video: 11, 'Non-video': 7}, cpa: {Video: 9, 'Non-video': 6}};
    Object.keys(_expect).forEach(function(t) {
      loadDummy(t);
      var vmap = aggregateBreakdown().videoMap;
      Object.keys(_expect[t]).forEach(function(bucket) {
        var got = vmap[bucket] ? vmap[bucket].count : 0;
        if (got !== _expect[t][bucket])
          throw new Error(t + ' ' + bucket + ': ' + got + ' creatives, expected ' + _expect[t][bucket]);
      });
    });
  `, ctx);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS  Video vs Non-video split follows the format name');
} catch (e) {
  failed = true;
  console.error(`FAIL  Video vs Non-video split:\n${e.stack || e}\n`);
}

// The overview pass: what the page renders BEFORE the performance query lands. Nothing that reads
// creativePerf may throw when it is empty, and the perf-dependent modules must be replaced by the
// pending card rather than drawing an empty chart.
errors.length = 0;
try {
  vm.runInContext(`
    loadDummy('cpr');
    R.partial = true;
    R.creativePerf = [];
    R.dailyFormatMetrics = [];
    R.dailyCreativeMetrics = [];
    R.typeBreakdown = [];
    R.campaignPerf = null;
    R.totalSpend = 0;
    R.avgMetric = null;
    onData(R);
    if (typeof perfPendingCard() !== 'string' || perfPendingCard().indexOf('Still querying') < 0)
      throw new Error('pending card did not render its waiting message');
    _perfError = 'simulated perf failure';
    if (perfPendingCard().indexOf('unavailable') < 0)
      throw new Error('pending card did not render its failure message');
    _perfError = null;
  `, ctx);
  if (errors.length) throw new Error(errors.join('\n'));
  assertRendered('overview pass');
  console.log('PASS  render chain on the overview pass (perf still pending)');
} catch (e) {
  failed = true;
  console.error(`FAIL  render chain on the overview pass:\n${e.stack || e}\n`);
}

if (!failed) console.log('render smoke test passed');
process.exit(failed ? 1 : 0);
