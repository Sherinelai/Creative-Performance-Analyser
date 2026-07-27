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

const document = {
  readyState: 'complete',
  getElementById: () => makeEl(),
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
    console.log('PASS  render chain on REAL data');
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
    console.log(`PASS  render chain for ${type}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL  render chain for ${type}:\n${e.stack || e}\n`);
  }
}

if (!failed) console.log('render smoke test passed');
process.exit(failed ? 1 : 0);
