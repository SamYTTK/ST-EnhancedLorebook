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
  '../lib/apply-core.js', '../lib/type-registry.js', '../lib/slot-parse.js', '../lib/dep-index.js', '../lib/type-compiler.js',
  'toast.js', 'modal.js', 'logger.js', 'agent-config-schema.js', 'context-builder.js',
  'hub-client.js', 'hub-tools.js', 'agent-chat.js', 'agent-manager.js', 'agent-backup.js',
  'worldinfo-guard.js', 'folder-url.js', 'app.js', 'agent-ui.js', 'el.js',
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
  'ELApplyCore', 'ELTypeRegistry', 'ELSlots', 'ELDepIndex', 'ELCompile',
  'EL_toast', 'EL_modalOpen', 'EL_modalClose',
  'ELLogger', 'EL_log', 'ELAgentConfigSchema',
  'EL_resolveAgentContext', 'EL_buildAgentContextAsync',
  'EL_apiFetch', 'EL_postToHost', 'EL_applyProposal', 'EL_runHubAgent', 'EL_ENTRY_FIELDS',
  'EL_buildHubTools', 'EL_entryFingerprint',
  'AgentChatManager', 'renderAgentChat', 'initAgentChatPanel',
  'ELG_guardSave', 'ELG_loadFresh', 'ELG_toast', 'ELG_listTrash', 'ELG_restoreSnapshot',
  'ELG_diff', 'EL_buildLineDiffHtml',
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

console.log('\n===== FINAL: ' + (failed === 0 ? 'PASS' : failed + ' FAILURE(S)') + ' =====');
process.exit(failed === 0 ? 0 : 1);
