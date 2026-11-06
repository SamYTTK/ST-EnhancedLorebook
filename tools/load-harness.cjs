/**
 * Load harness: executes the extension's app-window scripts, in index.html order,
 * inside a minimal DOM/browser shim, and reports any load-time failure.
 *
 * It does NOT test runtime behaviour. It DOES catch the dominant failure mode for
 * a structural refactor: a load-time ReferenceError, a broken export block, a
 * missing forward reference, or a syntax error.
 *
 * Usage: node tools/load-harness.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..', 'app');

// Order must match app/index.html.
// The shared core (lib/apply-core.js) is loaded first: it is the file the
// HOST window loads too, so a load-time failure there breaks both windows.
const ORDER = [
  '../lib/apply-core.js', '../lib/type-registry.js', '../lib/dep-index.js', '../lib/sections.js', '../lib/rules.js',
  'toast.js', 'modal.js', 'logger.js', 'agent-config-schema.js', 'context-builder.js',
  'hub-client.js', 'hub-tools.js', 'agent-chat.js', 'agent-manager.js', 'agent-backup.js',
  'worldinfo-guard.js', 'folder-url.js', 'map.js', 'rules-ui.js', 'app.js', 'agent-ui.js', 'el.js',
];

function makeElement(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    nodeType: 1,
    id: '', className: '', innerHTML: '', textContent: '', value: '', checked: false,
    dataset: {}, style: {}, children: [], childNodes: [], parentNode: null,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    hasAttribute() { return false; }, appendChild(c) { return c; }, removeChild(c) { return c; },
    insertBefore(c) { return c; }, replaceChild(c) { return c; }, remove() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, contains() { return false; }, matches() { return false; },
    insertAdjacentHTML() {}, insertAdjacentElement() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; },
    focus() {}, blur() {}, click() {}, select() {}, scrollIntoView() {}, animate() { return { finished: Promise.resolve() }; },
    cloneNode() { return makeElement(tag); },
    get firstChild() { return null; }, get lastChild() { return null; },
    get firstElementChild() { return null; }, get nextSibling() { return null; },
    get offsetWidth() { return 0; }, get offsetHeight() { return 0; },
    get scrollTop() { return 0; }, set scrollTop(v) {},
    get scrollHeight() { return 0; }, get clientWidth() { return 0; }, get clientHeight() { return 0; },
  };
  return el;
}

const documentStub = {
  hidden: false, visibilityState: 'visible', readyState: 'complete',
  activeElement: null, body: makeElement('body'), head: makeElement('head'),
  documentElement: makeElement('html'),
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getElementsByClassName() { return []; },
  getElementsByTagName() { return []; },
  createElement(tag) { return makeElement(tag); },
  createElementNS(ns, tag) { return makeElement(tag); },
  createTextNode(t) { return { nodeType: 3, textContent: t }; },
  createDocumentFragment() { return makeElement('fragment'); },
  createEvent() { return { initEvent() {} }; },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  execCommand() { return true; },
  importNode(n) { return n; },
  elementFromPoint() { return null; },
  getSelection() { return { toString() { return ''; }, removeAllRanges() {} }; },
};

function makeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i], get length() { return m.size; } };
}

const timers = [];
const sandbox = {};
Object.assign(sandbox, {
  console,
  document: documentStub,
  navigator: { userAgent: 'node', language: 'en', clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') } },
  location: { origin: 'http://localhost', href: 'http://localhost/app/index.html', search: '', hash: '', protocol: 'http:', host: 'localhost', pathname: '/app/index.html', reload() {} },
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
  setTimeout: (fn, ms) => { timers.push(fn); return timers.length; },
  clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: (fn) => { timers.push(fn); return timers.length; },
  cancelAnimationFrame: () => {},
  fetch: () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve(null), text: () => Promise.resolve('') }),
  getComputedStyle: () => ({ getPropertyValue: () => '', position: 'static' }),
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  alert() {}, confirm: () => false, prompt: () => null,
  toastr: undefined,
  // Must NOT invoke the callback: init() needs a full DOM. We only test LOADING.
  jQuery: Object.assign(function () { return { on() { return this; }, off() { return this; }, ready() { return this; }, each() { return this; }, val() { return ''; }, text() { return ''; }, html() { return ''; }, attr() { return ''; }, append() { return this; }, remove() {}, addClass() { return this; }, removeClass() { return this; }, find() { return this; }, length: 0 }; },
    { fn: {}, extend: Object.assign, each() {}, ajax: () => Promise.resolve() }),
  $: undefined,
  SillyTavern: {
    getContext: () => ({
      characterId: undefined, chatId: undefined, chat: [], characters: [], groups: [],
      chatMetadata: {}, extensionSettings: {}, eventSource: { on() {}, off() {}, removeListener() {}, emit() {} },
      event_types: {}, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
      saveSettingsDebounced() {}, loadWorldInfo: async () => ({ entries: {} }),
      getWorldInfoNames: () => [], updateWorldInfoList: async () => {},
    }),
  },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
  Event: class { constructor(t) { this.type = t; } },
  DOMParser: class { parseFromString() { return documentStub; } },
  XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} addEventListener() {} },
  Image: class { constructor() { this.src = ''; } },
  FileReader: class { readAsText() {} },
  Blob: class { constructor() {} },
  URL: URL, URLSearchParams: URLSearchParams,
  TextEncoder: TextEncoder, TextDecoder: TextDecoder,
  structuredClone: globalThis.structuredClone,
  crypto: globalThis.crypto,
  performance: globalThis.performance,
  EventSource: class { addEventListener() {} close() {} },
});
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.dispatchEvent = () => true;
sandbox.postMessage = () => {};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.top = sandbox;
sandbox.parent = sandbox;
sandbox.opener = sandbox;
sandbox.frames = sandbox;

vm.createContext(sandbox);

let failed = 0;
console.log('===== LOAD HARNESS =====');
for (const f of ORDER) {
  const p = path.join(APP, f);
  if (!fs.existsSync(p)) { console.log(`  MISSING  ${f}`); failed++; continue; }
  const src = fs.readFileSync(p, 'utf8');
  try {
    new vm.Script(src, { filename: f }).runInContext(sandbox);
    console.log(`  OK       ${f}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL     ${f}  ->  ${e.name}: ${e.message}`);
    const m = /:(\d+)/.exec(String(e.stack || '').split('\n')[1] || '');
    if (m) console.log(`           at ${f}:${m[1]}`);
  }
}

console.log('\n===== EXPECTED EXPORTS PRESENT AFTER LOAD =====');
const EXPECT = [
  'ELApplyCore', 'ELTypeRegistry', 'ELDepIndex', 'ELSections',
  'EL_toast', 'EL_modalOpen', 'EL_modalClose',
  'ELLogger', 'EL_log', 'ELAgentConfigSchema',
  'EL_resolveAgentContext', 'EL_buildAgentContextAsync',
  'EL_apiFetch', 'EL_postToHost', 'EL_applyProposal', 'EL_runHubAgent', 'EL_ENTRY_FIELDS',
  'EL_buildHubTools', 'EL_entryFingerprint',
  'AgentChatManager', 'renderAgentChat', 'initAgentChatPanel',
  'ELG_guardSave', 'ELG_loadFresh', 'ELG_toast', 'ELG_listTrash', 'ELG_restoreSnapshot',
  'ELG_diff', 'EL_buildLineDiffHtml',
  'EL_mapRender', 'EL_mapUpsertLocationLine', 'EL_mapKindOf', 'EL_mapPin', 'EL_mapUnpin',
  'ELRules', 'EL_rulesRender', 'EL_rulesCheckNow', 'EL_rulesOnHostRefresh',
  'ELFolderUrl', 'EL_getUrlForUid', 'EL_ensureFolderByPath',
  'openEditEntryModal', 'EL_setLorebookData',
  // NOTE: EL_terminalBadge is assigned lazily inside initTerminalPanel(), so it is
  // correctly absent until the agent UI initialises — do not add it here.
];
const missing = [];
for (const name of EXPECT) {
  // Evaluate in-context: a top-level `class`/`const`/`let` in a classic script is a
  // GLOBAL LEXICAL binding, reachable as a bare identifier but NOT as window.<name>.
  let kind = 'undefined';
  try { kind = new vm.Script('typeof ' + name).runInContext(sandbox); } catch (e) { kind = 'throw:' + e.message; }
  if (kind === 'undefined') missing.push(name);
}
if (missing.length) {
  console.log('  MISSING: ' + missing.join(', '));
  failed += missing.length;
} else {
  console.log('  all ' + EXPECT.length + ' present');
}

console.log('  AgentManager: ' + new vm.Script('typeof AgentManager').runInContext(sandbox));
const elKeys = new vm.Script('(typeof EL === "object" && EL) ? Object.keys(EL).join(",") : "ABSENT"').runInContext(sandbox);
console.log('  window.EL modules: ' + elKeys);
if (elKeys === 'ABSENT') { console.log('  FAIL: window.EL namespace not assembled'); failed++; }

console.log('\n===== RESULT: ' + (failed === 0 ? 'ALL SCRIPTS LOADED CLEANLY' : failed + ' FAILURE(S)') + ' =====');

// ─────────────────────────────────────────────────────────────────────────────
// SIGNATURE REGRESSION TESTS (Phase 4.1)
// entriesSignature is what decides whether the UI re-renders after a server-side
// change. The old version hashed only content LENGTH, joined keys and comment
// LENGTH, so it was blind to every flag an agent edits and to same-length edits —
// which is exactly the "UI shows stale state indefinitely" bug. These assert the
// new signature is sensitive to each of those fields, stable when nothing changed,
// and independent of the entries object's key order.
// ─────────────────────────────────────────────────────────────────────────────
const SIG_TEST = `
(function () {
    const out = [];
    function book() {
        return { entries: { '0': {
            key: ['alpha'], keysecondary: [], comment: 'c0', content: 'content zero',
            order: 100, position: 0, role: 0, depth: 4, probability: 100,
            useProbability: true, disable: false, constant: false, selective: true,
        } } };
    }
    const base = entriesSignature(book());
    function differs(label, mutate) {
        const b = book();
        mutate(b.entries['0']);
        out.push([label, entriesSignature(b) !== base]);
    }
    differs('order',           e => { e.order = 50; });
    differs('position',        e => { e.position = 1; });
    differs('role',            e => { e.role = 2; });
    differs('depth',           e => { e.depth = 9; });
    differs('probability',     e => { e.probability = 40; });
    differs('disable',         e => { e.disable = true; });
    differs('constant',        e => { e.constant = true; });
    differs('useProbability',  e => { e.useProbability = false; });
    differs('selective',       e => { e.selective = false; });
    // same length as 'content zero' / 'c0' — the exact case the old hash missed
    differs('same-length content edit', e => { e.content = 'content ONE!'; });
    differs('same-length comment edit', e => { e.comment = 'c1'; });
    out.push(['identical book is stable', entriesSignature(book()) === base]);
    const two = { entries: { '0': { key:['a'], content:'x', order: 100 }, '1': { key:['b'], content:'y', order: 100 } } };
    const rev = { entries: { '1': { key:['b'], content:'y', order: 100 }, '0': { key:['a'], content:'x', order: 100 } } };
    out.push(['entries key-order independent', entriesSignature(two) === entriesSignature(rev)]);
    return out;
})()
`;

console.log('\n===== SIGNATURE REGRESSION TESTS (4.1) =====');
try {
  const sigResults = new vm.Script(SIG_TEST).runInContext(sandbox);
  const bad = sigResults.filter(([, ok]) => !ok);
  for (const [label, ok] of sigResults) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (bad.length) {
    failed += bad.length;
    console.log(`  -> ${bad.length} signature test(s) FAILED`);
  } else {
    console.log(`  all ${sigResults.length} signature assertions passed`);
  }
} catch (e) {
  failed++;
  console.log('  FAIL  signature tests threw: ' + e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// STATIC SURFACE CHECK
// Guards the bug class that the `clamp` collision belonged to: two scripts in the
// shared global scope declaring the same top-level name, so the later one silently
// wins. Also flags identifiers that are referenced but never declared anywhere
// (typos / forgotten declarations).
// ─────────────────────────────────────────────────────────────────────────────

function stripStringsAndComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c; i++;
  }
  return out;
}

function topLevelDecls(src) {
  const names = [];
  const lines = src.split(/\r?\n/);
  for (const l of lines) {
    let m = l.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (!m) m = l.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (!m) m = l.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (m) names.push(m[1]);
  }
  return names;
}

function anyDecls(src) {
  const names = new Set();
  const re = /(?:^|[^.\w$])(?:function\s+|class\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  // destructuring: const { a, b } = ...  /  const [a, b] = ...
  const re2 = /(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g;
  while ((m = re2.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(':').pop().trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  // function parameters and catch bindings
  const re3 = /(?:function\s*[\w$]*\s*|catch\s*)\(([^)]*)\)/g;
  while ((m = re3.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  return names;
}

const BUILTINS = new Set(('window document console JSON Object Array String Number Boolean Math Date ' +
  'Promise Map Set WeakMap WeakSet Error TypeError RangeError SyntaxError RegExp Symbol parseInt parseFloat ' +
  'isNaN isFinite NaN Infinity undefined null true false this super new typeof instanceof in of void delete ' +
  'setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame queueMicrotask ' +
  'fetch URL URLSearchParams Headers Request Response Blob File FileReader FormData AbortController ' +
  'navigator localStorage sessionStorage location history screen performance crypto structuredClone ' +
  'alert confirm prompt getComputedStyle matchMedia CustomEvent Event EventTarget MutationObserver ' +
  'ResizeObserver IntersectionObserver DOMParser XMLHttpRequest Image TextEncoder TextDecoder ' +
  'encodeURIComponent decodeURIComponent encodeURI decodeURI btoa atob eval arguments ' +
  'if else for while do return break continue switch case default try catch finally throw function class ' +
  'const let var new delete typeof void yield await async static get set extends ' +
  'jQuery $ toastr SillyTavern globalThis self top parent opener frames module exports require ' +
  'Intl Proxy Reflect BigInt WeakRef FinalizationRegistry global process Buffer ' +
  'addEventListener removeEventListener dispatchEvent postMessage import export from as ' +
  'let const of in async').split(/\s+/).filter(Boolean));

const sources = {};
for (const f of ORDER) {
  const p = path.join(APP, f);
  if (fs.existsSync(p)) sources[f] = fs.readFileSync(p, 'utf8');
}

// 1. duplicate top-level declarations across files
const byName = new Map();
for (const [f, src] of Object.entries(sources)) {
  for (const n of topLevelDecls(src)) {
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(f);
  }
}
const dupes = [...byName.entries()].filter(([, v]) => new Set(v).size > 1);

// 2. (removed) A referenced-but-never-declared identifier check was attempted here
//    and removed: without a real parser it cannot distinguish a local binding, a
//    destructured name, an arrow parameter or an object-literal key from a genuine
//    typo, and it produced hundreds of false positives. A check that cries wolf is
//    worse than no check. The duplicate-declaration test above is exact and is the
//    one that guards the `clamp` class of bug.

console.log('\n===== STATIC SURFACE CHECK =====');
console.log('  top-level declarations: ' + [...byName.keys()].length + ' distinct names across ' + Object.keys(sources).length + ' files');
if (dupes.length === 0) {
  console.log('  duplicate top-level names: NONE (the `clamp` collision class is closed)');
} else {
  failed += dupes.length;
  console.log('  DUPLICATE TOP-LEVEL NAMES:');
  for (const [n, files] of dupes) console.log(`    ${n}  <-  ${[...new Set(files)].join(', ')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAP LINE-EDIT TESTS (B4)
// EL_mapUpsertLocationLine is the only lorebook-content mutation the map ever
// makes outside the typed compiler path. It must replace exactly the
// Current_Location line and preserve every other byte (including EOL style
// and closing limiters), or append the line when absent.
// ─────────────────────────────────────────────────────────────────────────────
const MAP_TEST = `
(function () {
    const out = [];
    function eq(label, got, want) { out.push([label, got === want]); }
    eq('replace keeps other lines',
        EL_mapUpsertLocationLine('Name: Anna\\nCurrent_Location: Old\\nNote: x', 'New Place'),
        'Name: Anna\\nCurrent_Location: New Place\\nNote: x');
    eq('replace is case-insensitive on label, canonicalises it',
        EL_mapUpsertLocationLine('current_location: Old', 'X'),
        'Current_Location: X');
    eq('append when absent',
        EL_mapUpsertLocationLine('Name: Anna', 'Thornwall'),
        'Name: Anna\\nCurrent_Location: Thornwall');
    eq('append goes before closing limiter',
        EL_mapUpsertLocationLine('**<char_name>**\\nName: Anna\\n**</char_name>**', 'Thornwall'),
        '**<char_name>**\\nName: Anna\\nCurrent_Location: Thornwall\\n**</char_name>**');
    eq('empty content yields just the line',
        EL_mapUpsertLocationLine('', '"Unknown"'),
        'Current_Location: "Unknown"');
    eq('CRLF style preserved',
        EL_mapUpsertLocationLine('Name: A\\r\\nCurrent_Location: O\\r\\nNote: x', 'N'),
        'Name: A\\r\\nCurrent_Location: N\\r\\nNote: x');
    eq('character heuristic', EL_mapKindOf({ content: 'Name: A\\nCurrent_Location: X' }), 'character');
    eq('location heuristic', EL_mapKindOf({ content: 'Name: B\\nRegion: Blackmoor' }), 'location');
    eq('other entry not pinnable', EL_mapKindOf({ content: 'Just prose.' }), null);
    return out;
})()
`;

console.log('\n===== MAP LINE-EDIT TESTS (B4) =====');
try {
  const mapResults = new vm.Script(MAP_TEST).runInContext(sandbox);
  const bad = mapResults.filter(([, ok]) => !ok);
  for (const [label, ok] of mapResults) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (bad.length) {
    failed += bad.length;
    console.log(`  -> ${bad.length} map test(s) FAILED`);
  } else {
    console.log(`  all ${mapResults.length} map assertions passed`);
  }
} catch (e) {
  failed++;
  console.log('  FAIL  map tests threw: ' + e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// RULES EVALUATION TESTS (B5)
// ELRules is the only rule-evaluation path the host and the app share: pure,
// DOM-free, no fetch, never throws. If/otherwise/while resolution, every
// operand source, and the label-parameterized line upsert (the minimal edit
// the host uses to land set-field-text writes) must all behave here, or the
// message-received run cannot be trusted.
// ─────────────────────────────────────────────────────────────────────────────
const RULES_TEST = `
(function () {
    const out = [];
    function eq(label, got, want) { out.push([label, got === want]); }
    const R = ELRules;
    const ctx = function (over) {
        return Object.assign({
            time: '09:30', dow: 2,
            fieldValues: { mood: 'tense', place: 'Thornwall' },
            mapPlaced: true, relations: ['ally'],
        }, over || {});
    };
    const ifRow = function (over) {
        return Object.assign({ kind: 'if', op: '=', left: { src: 'time', ref: '' }, right: '', target: '', value: '' }, over || {});
    };
    eq('time = matches HH:MM', R.evaluateRow(ifRow({ right: '09:30' }), ctx()), true);
    eq('time = tolerates unpadded', R.evaluateRow(ifRow({ right: '9:30' }), ctx()), true);
    eq('time < compares minutes', R.evaluateRow(ifRow({ op: '<', right: '17:00' }), ctx()), true);
    eq('dow source reads day', R.evaluateRow(ifRow({ left: { src: 'dow', ref: '' }, op: '=', right: '2' }), ctx()), true);
    eq('field source reads label', R.evaluateRow(ifRow({ left: { src: 'field', ref: 'Mood' }, op: 'contains', right: 'ten' }), ctx()), true);
    eq('map source is exists-style', R.evaluateRow(ifRow({ left: { src: 'map', ref: '' }, op: '=', right: 'true' }), ctx()), true);
    eq('relation source matches kind', R.evaluateRow(ifRow({ left: { src: 'relation', ref: 'ALLY' }, op: '=', right: 'true' }), ctx()), true);
    eq('unknown kind never matches', R.evaluateRow({ kind: 'nope', op: '=', left: { src: 'time', ref: '' }, right: '09:30' }, ctx()), false);
    eq('never throws on garbage', R.evaluateRow(null, null), false);
    eq('empty op tests blank left', R.evaluateRow(ifRow({ left: { src: 'field', ref: 'missing' }, op: 'empty' }), ctx()), true);
    const rec = { systemId: 'schedule', enabled: true, rows: [
        ifRow({ right: '08:00', value: 'Early' }),
        ifRow({ op: 'contains', left: { src: 'field', ref: 'place' }, right: 'thorn', value: 'Market' }),
        { kind: 'otherwise', op: '=', left: { src: 'time', ref: '' }, right: '', target: '', value: 'Home' },
        { kind: 'while', op: '=', left: { src: 'time', ref: '' }, right: '', target: 'Status', value: 'Ledger' },
    ] };
    const res = R.resolveSystem(rec, ctx(), 'Current_Location');
    eq('first matching if wins', res.writes.length === 2 && res.writes[0].value === 'Market' && res.writes[0].target === 'Current_Location', true);
    eq('while always applies as constant', res.writes[1].kind === 'while' && res.writes[1].value === 'Ledger' && res.writes[1].target === 'Status', true);
    const res2 = R.resolveSystem(rec, ctx({ time: '23:00', fieldValues: {} }), 'Current_Location');
    eq('otherwise fills the else-branch', res2.writes[0].kind === 'otherwise' && res2.writes[0].value === 'Home', true);
    eq('disabled resolves nothing', R.resolveSystem({ systemId: 's', enabled: false, rows: rec.rows }, ctx(), 'X').writes.length, 0);
    eq('upsert replaces label line', R.upsertFieldLine('Name: Anna\\nCurrent_Location: Old', 'Current_Location', 'New'), 'Name: Anna\\nCurrent_Location: New');
    eq('upsert matches _/case variants', R.upsertFieldLine('current location: Old', 'Current_Location', 'N'), 'Current_Location: N');
    eq('upsert appends before limiter', R.upsertFieldLine('**<tag>**\\nName: A\\n**</tag>**', 'Status', 'Ledger'), '**<tag>**\\nName: A\\nStatus: Ledger\\n**</tag>**');
    eq('compute writes one plain line', R.computeFieldContent({ content: 'Name: A' }, 'Status', 'Ledger'), 'Name: A\\nStatus: Ledger');
    eq('compute null on bad entry', R.computeFieldContent(null, 'Status', 'X'), null);
    return out;
})()
`;

console.log('\n===== RULES EVALUATION TESTS (B5) =====');
try {
  const rulesResults = new vm.Script(RULES_TEST).runInContext(sandbox);
  const bad = rulesResults.filter(([, ok]) => !ok);
  for (const [label, ok] of rulesResults) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (bad.length) {
    failed += bad.length;
    console.log(`  -> ${bad.length} rules test(s) FAILED`);
  } else {
    console.log(`  all ${rulesResults.length} rules assertions passed`);
  }
} catch (e) {
  failed++;
  console.log('  FAIL  rules tests threw: ' + e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPE REGISTRY TESTS (types are tags: no templates, no parsing)
// A type only carries id/name/icon/accent + create defaults + literal presets.
// Legacy template fields are dropped on read and on migration; entry content
// is never read by the registry at all.
// ─────────────────────────────────────────────────────────────────────────────
const TYPE_TEST = `
(function () {
    const out = [];
    function eq(label, got, want) { out.push([label, got === want]); }
    function ok(label, cond) { out.push([label, !!cond]); }
    const R = ELTypeRegistry;

    const ch = R.BUILTIN_TYPES.character;
    ok('builtin character has a preset', Array.isArray(ch.presets) && ch.presets.length === 1);
    ok('builtin has no template sections', ch.sections === undefined && ch.tag === undefined);
    ok('builtin preset is literal text', ch.presets[0].content.indexOf('Name:') === 0);

    const legacy = {
        id: 'hero', name: 'Hero', icon: '🦸', accent: '#123456',
        tag: 'char_name', reorder: false, keyMain: 'Name', keySec: 'none', cssPath: 'x.css',
        sections: [{ title: 'Identity', slots: [{ kind: 'cont', label: 'Name' }] }],
    };
    const cleaned = R.sanitizeType(legacy);
    eq('legacy identity kept', cleaned.type.id + '|' + cleaned.type.name + '|' + cleaned.type.icon + '|' + cleaned.type.accent, 'hero|Hero|🦸|#123456');
    ok('legacy template fields dropped', cleaned.type.sections === undefined && cleaned.type.tag === undefined && cleaned.type.reorder === undefined && cleaned.type.keyMain === undefined && cleaned.type.cssPath === undefined);
    ok('defaults backfilled', cleaned.type.defaults && typeof cleaned.type.defaults === 'object' && !Array.isArray(cleaned.type.defaults));
    ok('presets backfilled', Array.isArray(cleaned.type.presets) && cleaned.type.presets.length === 0);

    const withDefaults = R.sanitizeType({
        id: 'x', name: 'X',
        defaults: { order: 120, position: 4, role: 1, depth: -3, probability: 250, constant: 'on', selective: false, bogus: 1 },
    }).type;
    eq('default order kept', withDefaults.defaults.order, 120);
    eq('default position/role kept', withDefaults.defaults.position + ':' + withDefaults.defaults.role, '4:1');
    eq('negative depth clamped to 0', withDefaults.defaults.depth, 0);
    eq('probability clamped to 100', withDefaults.defaults.probability, 100);
    eq('boolean default coerced', withDefaults.defaults.constant, true);
    eq('explicit false kept', withDefaults.defaults.selective, false);
    eq('unknown default dropped', Object.prototype.hasOwnProperty.call(withDefaults.defaults, 'bogus'), false);

    const presets = R.sanitizeType({
        id: 'p', name: 'P',
        presets: [
            { id: 'a', name: 'A', content: 'one' },
            { id: 'a', name: 'B', content: 'two' },
            { name: '', content: 'drop me' },
            { id: 'c', name: 'C' },
        ],
    });
    eq('duplicate preset id renamed', presets.type.presets[1].id, 'a-2');
    eq('nameless preset dropped', presets.type.presets.length, 3);
    eq('preset content backfilled', presets.type.presets[2].content, '');

    eq('getPreset finds by id', R.getPreset(ch, 'character-sheet').content.indexOf('Name:') === 0, true);
    eq('getPreset missing is null', R.getPreset(ch, 'nope'), null);

    ok('validate accepts a builtin', R.validateType(ch).ok === true);
    ok('validate rejects empty name', R.validateType({ id: 'x', name: '  ' }).ok === false);
    ok('validate rejects duplicate preset names', R.validateType({ id: 'x', name: 'X', presets: [{ id: 'a', name: 'Same' }, { id: 'b', name: 'same' }] }).ok === false);
    ok('validate accepts literal preset content', R.validateType({ id: 'x', name: 'X', presets: [{ id: 'a', name: 'A', content: 'Anything:\\nHere' }] }).ok === true);

    const both = R.sanitizeType({ id: 'x', name: 'X', defaults: { constant: true, vectorized: true } }).type.defaults;
    eq('constant wins over vectorized default', both.constant + ':' + Object.prototype.hasOwnProperty.call(both, 'vectorized'), 'true:false');
    eq('reserved id refused on sanitize', R.sanitizeType({ id: '__proto__', name: 'Evil' }).type.id, 'evil');
    const collision = { a: { id: 'same', name: 'A' }, b: { id: 'same', name: 'B' } };
    const collisionRes = R.migrateStore(collision);
    eq('collision keeps the first type', collision.same && collision.same.name, 'A');
    ok('collision leaves the loser untouched', collision.b && collision.b.name === 'B');
    ok('collision is reported', collisionRes.warnings.some(function (w) { return w.indexOf('already belongs') !== -1; }));

    const store = { legacy: legacy, custom: { id: 'custom', name: 'Custom', presets: [] } };
    const m = R.migrateStore(store);
    ok('migration reports changes', m.changed >= 1);
    ok('migrated type has no sections', store.hero && store.hero.sections === undefined && store.hero.tag === undefined && store.legacy === undefined);
    ok('user presets not resurrected', Array.isArray(store.custom.presets) && store.custom.presets.length === 0);

    const builtinStore = { character: { id: 'character', name: 'Character', sections: [] } };
    R.migrateStore(builtinStore);
    ok('builtin starter preset seeded once', Array.isArray(builtinStore.character.presets) && builtinStore.character.presets.length === 1);
    builtinStore.character.presets = [];
    R.migrateStore(builtinStore);
    eq('deleted builtin presets stay deleted', builtinStore.character.presets.length, 0);

    const list = R.listTypes({ a: legacy });
    eq('listTypes cleans on read', list.length === 1 && list[0].sections === undefined && list[0].name === 'Hero', true);

    eq('map upsert plain line', EL_mapUpsertLocationLine('Name: Anna', 'Thornwall'), 'Name: Anna\\nCurrent_Location: Thornwall');
    eq('rules upsert plain line', ELRules.upsertFieldLine('Name: A', 'Status', 'Ledger'), 'Name: A\\nStatus: Ledger');
    return out;
})()
`;

console.log('\n===== TYPE REGISTRY TESTS (types are tags) =====');
try {
  const typeResults = new vm.Script(TYPE_TEST).runInContext(sandbox);
  const bad = typeResults.filter(([, ok]) => !ok);
  for (const [label, ok] of typeResults) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (bad.length) {
    failed += bad.length;
    console.log(`  -> ${bad.length} type test(s) FAILED`);
  } else {
    console.log(`  all ${typeResults.length} type assertions passed`);
  }
} catch (e) {
  failed++;
  console.log('  FAIL  type tests threw: ' + e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPE TAG HELPERS TESTS (pure app-window helpers)
// The refactor's contract: a type is a tag. These helpers may add/clear
// extensions.el.type and may fill a NEW entry's body from a literal preset, but
// they must never read, rewrite, reorder or filter existing entry content, and
// must never clobber refs or foreign extensions.* keys.
// ─────────────────────────────────────────────────────────────────────────────
const TAG_HELPERS_TEST = `
(function () {
    const out = [];
    function eq(label, got, want) { out.push([label, got === want]); }
    function ok(label, cond) { out.push([label, !!cond]); }
    function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj || {}, key); }

    // Seed the store exactly as the app does on first use.
    const store = EL_getTypeStore();
    ok('type store seeded with builtin character', !!store && !!store.character);

    // ── EL_withEntryType ────────────────────────────────────────────────────
    const before = { el: { refs: [{ uid: 7, kind: 'mentions' }], extra: 1 }, foreign: { a: 1 }, other: 'keep' };
    const snapshot = JSON.stringify(before);
    const tagged = EL_withEntryType(before, 'character');
    eq('withEntryType sets el.type', tagged.el.type, 'character');
    ok('withEntryType keeps el.refs array', Array.isArray(tagged.el.refs) && tagged.el.refs.length === 1 && tagged.el.refs[0].uid === 7);
    eq('withEntryType keeps el sibling keys', tagged.el.extra, 1);
    eq('withEntryType keeps foreign extensions keys', tagged.foreign.a, 1);
    eq('withEntryType keeps other extensions keys', tagged.other, 'keep');
    eq('withEntryType never mutates input', JSON.stringify(before), snapshot);

    const cleared = EL_withEntryType(tagged, '');
    eq('withEntryType empty clears the tag', has(cleared.el, 'type'), false);
    ok('withEntryType empty keeps refs', Array.isArray(cleared.el.refs) && cleared.el.refs[0].uid === 7);
    eq('withEntryType empty keeps foreign keys', cleared.foreign.a, 1);

    const bare = EL_withEntryType({ el: { type: 'character' } }, '');
    eq('withEntryType removes el when nothing is left', has(bare, 'el'), false);
    eq('withEntryType empty stays empty for no input', JSON.stringify(EL_withEntryType(undefined, '')), '{}');

    // ── EL_applyCreateType ──────────────────────────────────────────────────
    const literal = 'Name: Anna\\r\\nCodename: Wraith\\r\\n\\r\\nNotes:\\n- keeps blank lines\\n- ends with newline\\n';
    const created = EL_applyCreateType({ key: ['anna'], content: '' }, 'character', literal);
    eq('applyCreateType sets the tag', created.extensions && created.extensions.el && created.extensions.el.type, 'character');
    eq('applyCreateType assigns literal content byte-for-byte', created.content === literal, true);
    eq('applyCreateType does not reorder or drop content lines', created.content.split('\\n').length, literal.split('\\n').length);

    const noneEntry = EL_applyCreateType({ key: ['x'], content: 'body' }, 'none', 'preset text');
    eq("applyCreateType 'none' writes content", noneEntry.content, 'preset text');
    eq("applyCreateType 'none' creates no extensions.el", noneEntry.extensions, undefined);

    const unknownEntry = EL_applyCreateType({ key: ['x'], content: 'body' }, 'does-not-exist', 'given');
    eq('applyCreateType unknown id creates no tag', unknownEntry.extensions, undefined);
    eq('applyCreateType unknown id still honours literal content', unknownEntry.content, 'given');

    const untouched = EL_applyCreateType({ key: ['x'], content: literal }, 'character');
    eq('applyCreateType without content never rewrites existing content', untouched.content === literal, true);

    // ── EL_presetContent ────────────────────────────────────────────────────
    const builtinSheet = ELTypeRegistry.BUILTIN_TYPES.character.presets[0].content;
    eq('presetContent returns the builtin character preset text', EL_presetContent('character', 'character-sheet'), builtinSheet);
    ok('presetContent text is literal (starts with Name:, no placeholders)', builtinSheet.indexOf('Name:') === 0 || EL_presetContent('character', 'character-sheet').indexOf('Name:') === 0);
    eq("presetContent 'none' is empty", EL_presetContent('character', 'none'), '');
    eq('presetContent unknown preset is empty', EL_presetContent('character', 'no-such-preset'), '');
    eq('presetContent unknown type is empty', EL_presetContent('no-such-type', 'character-sheet'), '');

    // ── EL_batchTypeResetWrites ─────────────────────────────────────────────
    const batchEntry = { key: ['a'], content: literal, extensions: { el: { type: 'character', refs: [{ uid: 3 }] }, foreign: true } };
    const batchBefore = JSON.stringify(batchEntry);
    const writes = EL_batchTypeResetWrites(batchEntry);
    ok('batchReset returns extensions only', Object.keys(writes).length === 1 && has(writes, 'extensions'));
    ok('batchReset emits no content key', has(writes, 'content') === false);
    ok('batchReset emits no key key', has(writes, 'key') === false);
    eq('batchReset clears only the tag', has(writes.extensions.el, 'type'), false);
    ok('batchReset keeps el.refs', Array.isArray(writes.extensions.el.refs) && writes.extensions.el.refs[0].uid === 3);
    eq('batchReset keeps foreign extensions keys', writes.extensions.foreign, true);
    eq('batchReset never mutates the entry', JSON.stringify(batchEntry), batchBefore);

    const untyped = EL_batchTypeResetWrites({ key: ['x'], content: 'body', extensions: { el: { refs: [] } } });
    eq('batchReset on untyped entry writes nothing', JSON.stringify(untyped), '{}');

    // ── constant/vectorized exclusivity at create time ──────────────────────
    const bothFlags = EL_applyCreateType({ content: '', constant: true, vectorized: true }, 'character', 'x');
    eq('applyCreateType forces vectorized off when constant is on', bothFlags.vectorized, false);
    eq('applyCreateType leaves constant on', bothFlags.constant, true);
    const vecOnly = EL_applyCreateType({ content: '', constant: false, vectorized: true }, 'character', 'x');
    eq('applyCreateType keeps a lone vectorized flag', vecOnly.vectorized, true);
    const bothNone = EL_applyCreateType({ content: '', constant: true, vectorized: true }, 'none', 'x');
    eq("applyCreateType exclusivity also applies to 'none'", bothNone.vectorized, false);

    // ── EL_readTypeSelect / EL_openTypeSelect (orphaned tags round-trip) ────
    // The select is DOM; give these two helpers a tiny fake element instead of
    // the harness's null getElementById.
    const origGetById = document.getElementById;
    const origCreate = document.createElement;
    try {
        document.getElementById = (id) => (id === 'edit-type' ? { value: 'deleted-type' } : null);
        eq('readTypeSelect returns a raw orphaned id', EL_readTypeSelect(), 'deleted-type');
        document.getElementById = (id) => (id === 'edit-type' ? { value: 'none' } : null);
        eq("readTypeSelect maps 'none' to none", EL_readTypeSelect(), 'none');
        document.getElementById = (id) => (id === 'edit-type' ? { value: '' } : null);
        eq('readTypeSelect maps an empty value to none', EL_readTypeSelect(), 'none');
        document.getElementById = () => null;
        eq('readTypeSelect defaults to none without an element', EL_readTypeSelect(), 'none');

        const madeOptions = [];
        document.createElement = (tag) => {
            const opt = { tagName: String(tag || '').toUpperCase(), value: '', textContent: '', selected: false };
            madeOptions.push(opt);
            return opt;
        };
        const fakeSel = { innerHTML: '', value: '', children: [], appendChild(c) { this.children.push(c); return c; } };
        document.getElementById = (id) => (id === 'edit-type' ? fakeSel : null);

        const orphanEntry = { key: ['anna'], content: 'Name: Anna', extensions: { el: { type: 'deleted-type', refs: [{ uid: 4 }] } } };
        const orphanBefore = JSON.stringify(orphanEntry);
        EL_openTypeSelect(orphanEntry);
        eq('openTypeSelect appends one orphan option', fakeSel.children.length, 1);
        eq('openTypeSelect orphan option carries the raw id', fakeSel.children[0].value, 'deleted-type');
        eq('openTypeSelect orphan option is labelled missing', fakeSel.children[0].textContent, 'deleted-type (missing type)');
        eq('openTypeSelect selects the orphan value', fakeSel.value, 'deleted-type');
        eq('openTypeSelect never writes the entry', JSON.stringify(orphanEntry), orphanBefore);

        madeOptions.length = 0;
        const knownSel = { innerHTML: '', value: '', children: [], appendChild(c) { this.children.push(c); return c; } };
        document.getElementById = (id) => (id === 'edit-type' ? knownSel : null);
        EL_openTypeSelect({ extensions: { el: { type: 'character' } } });
        eq('openTypeSelect adds no option for a known type', knownSel.children.length, 0);

        // Orphan id read back from the select must be what the save path writes,
        // i.e. a tag-only update: content is never part of this helper.
        document.getElementById = (id) => (id === 'edit-type' ? { value: 'deleted-type' } : null);
        const savedTag = EL_withEntryType({ el: { refs: [{ uid: 4 }] } }, EL_readTypeSelect());
        eq('orphan read-back preserves the tag on save', savedTag.el.type, 'deleted-type');
        ok('orphan read-back preserves refs', Array.isArray(savedTag.el.refs) && savedTag.el.refs[0].uid === 4);
        eq('orphan read-back produces no content field', has(savedTag, 'content'), false);
    } finally {
        document.getElementById = origGetById;
        document.createElement = origCreate;
    }

    return out;
})()
`;

console.log('\n===== TYPE TAG HELPERS TESTS =====');
try {
  const tagResults = new vm.Script(TAG_HELPERS_TEST).runInContext(sandbox);
  const bad = tagResults.filter(([, ok]) => !ok);
  for (const [label, ok] of tagResults) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (bad.length) {
    failed += bad.length;
    console.log(`  -> ${bad.length} type-tag helper test(s) FAILED`);
  } else {
    console.log(`  all ${tagResults.length} type-tag helper assertions passed`);
  }
} catch (e) {
  failed++;
  console.log('  FAIL  type-tag helper tests threw: ' + e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// RULES STORE TESTS (no seeded system)
// The rule language is user-authored: opening the panel must not invent a
// "Schedule system". Only the containers (systems/rules/rulePending) are
// initialised; an existing system is never overwritten or duplicated, and a
// user-created system takes its default target from the UI handler.
// ─────────────────────────────────────────────────────────────────────────────
const RULES_STORE_TEST = `
(function () {
    const out = [];
    function eq(label, got, want) { out.push([label, got === want]); }
    function ok(label, cond) { out.push([label, !!cond]); }

    const savedSystems = extensionSettings.systems;
    const savedRules = extensionSettings.rules;
    const savedPending = extensionSettings.rulePending;
    try {
        // 1. Empty store: no seeded system, containers initialised.
        extensionSettings.systems = [];
        delete extensionSettings.rules;
        delete extensionSettings.rulePending;
        const store = EL_rulesStoreApp();
        ok('rulesStoreApp returns the settings object', !!store);
        eq('empty systems array stays empty (no seed)', extensionSettings.systems.length, 0);
        eq('rules initialised to {}', JSON.stringify(extensionSettings.rules), '{}');
        eq('rulePending initialised to {}', JSON.stringify(extensionSettings.rulePending), '{}');
        EL_rulesStoreApp();
        eq('second open still seeds nothing', extensionSettings.systems.length, 0);

        // 2. Existing user system is left exactly as it was.
        const user = { id: 'user-sys', name: 'My system', check: 'manual', n: 2, target: 'Mood' };
        extensionSettings.systems = [user];
        const userSnapshot = JSON.stringify(extensionSettings.systems);
        EL_rulesStoreApp();
        eq('existing system count unchanged', extensionSettings.systems.length, 1);
        eq('existing system object untouched', JSON.stringify(extensionSettings.systems), userSnapshot);
        eq('existing system keeps its id', extensionSettings.systems[0].id, 'user-sys');
        EL_rulesStoreApp();
        eq('repeated open does not duplicate', extensionSettings.systems.length, 1);

        // 3. EL_rulesSystems returns only what the store holds.
        eq('systems lists the stored user system', EL_rulesSystems().map(function (s) { return s.id; }).join(','), 'user-sys');
        extensionSettings.systems.push({ id: 'second', name: 'Second' });
        eq('systems lists every stored system', EL_rulesSystems().length, 2);
        extensionSettings.systems.push({ name: 'no id' }, null, 'not-an-object');
        eq('systems ignores malformed records', EL_rulesSystems().length, 2);
        extensionSettings.systems = [];
        eq('systems is empty when the store is empty', EL_rulesSystems().length, 0);

        // 4. The real UI add handler (#el-rules-sysadd) creates one user system.
        extensionSettings.systems = [user];
        const handlers = {};
        const panel = {
            innerHTML: '',
            querySelector: function (sel) {
                if (sel === '#el-rules-sysadd') {
                    return { addEventListener: function (type, fn) { if (type === 'click') handlers.add = fn; } };
                }
                return null;
            },
            querySelectorAll: function () { return []; },
        };
        const origGetById = document.getElementById;
        try {
            document.getElementById = function (id) { return (id === 'rules-panel') ? panel : null; };
            EL_rulesWire(null, null);
            ok('add-system click handler wired', typeof handlers.add === 'function');
            handlers.add();
        } finally {
            document.getElementById = origGetById;
        }
        eq('add handler appends exactly one system', extensionSettings.systems.length, 2);
        const added = extensionSettings.systems[1];
        eq('new system default target is Current_Location', added && added.target, 'Current_Location');
        ok('new system id uses the system- prefix', !!added && typeof added.id === 'string' && added.id.indexOf('system-') === 0);
        eq('new system default check is manual', added && added.check, 'manual');
        eq('new system is named for its position', added && added.name, 'System 2');
        eq('pre-existing system untouched by add', JSON.stringify(extensionSettings.systems[0]), JSON.stringify(user));

        // Rule language unchanged: one plain "Label: value" line per write.
        eq('rule write is a single plain line', ELRules.computeFieldContent({ content: 'Name: A' }, 'Mood', 'Calm'), 'Name: A\\nMood: Calm');
    } finally {
        extensionSettings.systems = savedSystems;
        extensionSettings.rules = savedRules;
        extensionSettings.rulePending = savedPending;
    }
    return out;
})()
`;

console.log('\n===== RULES STORE TESTS (no seeded system) =====');
try {
  const rulesStoreResults = new vm.Script(RULES_STORE_TEST).runInContext(sandbox);
  const bad = rulesStoreResults.filter(([, ok]) => !ok);
  for (const [label, ok] of rulesStoreResults) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (bad.length) {
    failed += bad.length;
    console.log(`  -> ${bad.length} rules-store test(s) FAILED`);
  } else {
    console.log(`  all ${rulesStoreResults.length} rules-store assertions passed`);
  }
} catch (e) {
  failed++;
  console.log('  FAIL  rules-store tests threw: ' + e.message);
}

console.log('\n===== FINAL: ' + (failed === 0 ? 'PASS' : failed + ' FAILURE(S)') + ' =====');
process.exit(failed === 0 ? 0 : 1);
