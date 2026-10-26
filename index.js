const EXTENSION_NAME = 'Enhanced Lorebook UI';
const EXTENSION_DIR = 'ST-EnhancedLorebook';
const EL_API_BASE = '/api/plugins/enhanced-lorebook-agent';

function getExtensionUrl() {
    return `scripts/extensions/third-party/${EXTENSION_DIR}`;
}

let _csrfToken = null;
async function getCsrfToken() {
    try {
        const response = await fetch('/csrf-token');
        if (response.ok) {
            const data = await response.json();
            return data.token;
        }
    } catch (e) {
        console.error('Failed to fetch CSRF token', e);
    }
    const value = `; ${document.cookie}`;
    const parts = value.split('; X-CSRF-Token=');
    if (parts.length === 2) return parts.pop().split(';').shift();
    return '';
}

getCsrfToken().then(t => { _csrfToken = t; });

let _bridgeNonce = '';
try {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
        const _nonceBytes = crypto.getRandomValues(new Uint8Array(16));
        _bridgeNonce = Array.from(_nonceBytes, b => b.toString(16).padStart(2, '0')).join('');
    }
} catch (e) {
    console.error('Enhanced Lorebook: nonce mint failed', e);
}
if (!_bridgeNonce) {
    _bridgeNonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}
let _bridgeNonceWarned = false;

const _elHostListeners = [];
let _elLauncherReady = false;
let _elBridgeReady = false;
let _elEventsReady = false;
let _elTeardownOnUnloadRegistered = false;
let _elWandRetryId = null;

function _elOn(target, type, fn, opts) {
    try {
        if (!target) return;
        if (typeof target.addEventListener === 'function') {
            target.addEventListener(type, fn, opts);
        } else if (typeof target.on === 'function') {
            target.on(type, fn);
        } else {
            return;
        }
        _elHostListeners.push({ target, type, fn, opts });
    } catch (e) {
        console.error('Enhanced Lorebook: failed to attach listener', e);
    }
}

function _elRemoveTrackedListener(entry) {
    try {
        const target = entry && entry.target;
        if (!target) return;
        if (typeof target.removeEventListener === 'function') {
            target.removeEventListener(entry.type, entry.fn, entry.opts);
        } else if (typeof target.removeListener === 'function') {
            target.removeListener(entry.type, entry.fn);
        }
    } catch (e) {
        console.error('Enhanced Lorebook: listener removal failed', e);
    }
}

const _elLauncher = {
    dropdown: null,
    scrim: null,
    chevron: null,
    drawerToggle: null,
    drawerIcon: null,
    worldInfoContent: null,
    isOpen: false,
    bypassIntercept: false,
};

let appWindow = null;
let messageCounter = 0;
let lastPeriodicRun = 0;
let pendingPeriodicTrigger = false;
let pendingPeriodicAgentIds = null;
const periodicCounters = {};

function openStandaloneApp(tab = '') {
    // Reuse the existing app window instead of spawning a duplicate. Duplicate
    // windows were a primary cause of stale-copy whole-file overwrites that
    // silently deleted lorebook entries.
    if (appWindow && !appWindow.closed) {
        appWindow.focus();
        try {
            appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-navigate', tab, nonce: _bridgeNonce }, window.location.origin);
        } catch (e) {
            console.error('Enhanced Lorebook: failed to navigate existing window', e);
        }
        if (pendingPeriodicTrigger) {
            const ids = pendingPeriodicAgentIds;
            pendingPeriodicTrigger = false;
            pendingPeriodicAgentIds = null;
            setTimeout(() => sendPeriodicTriggerToApp(ids), 1000);
        }
        return;
    }

    const baseUrl = getExtensionUrl();
    const token = _csrfToken || '';
    const params = new URLSearchParams({ csrf: token, v: Date.now(), nonce: _bridgeNonce });
    if (tab) params.set('tab', tab);
    const url = `${baseUrl}/app/index.html?${params.toString()}`;
    appWindow = window.open(url, '_blank');
    window.__enhancedLorebookWindow = appWindow;
    if (pendingPeriodicTrigger) {
        const ids = pendingPeriodicAgentIds;
        pendingPeriodicTrigger = false;
        pendingPeriodicAgentIds = null;
        setTimeout(() => sendPeriodicTriggerToApp(ids), 1000);
    }
}

function sendPeriodicTriggerToApp(agentIds) {
    if (appWindow && !appWindow.closed) {
        const context = SillyTavern.getContext();
        const chatInfo = { characterId: context.characterId, chatId: context.chatId ?? context.chat?.chat_id };
        appWindow.postMessage({
            source: 'enhanced-lorebook',
            type: 'el-agent-periodic-trigger',
            nonce: _bridgeNonce,
            chatInfo,
            messageCounter: messageCounter,
            agentIds: agentIds || undefined,
        }, window.location.origin);
    }
}

function sendChatChangedToApp() {
    if (appWindow && !appWindow.closed) {
        const context = SillyTavern.getContext();
        appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-chat-changed', nonce: _bridgeNonce, characterId: context.characterId, chatId: context.chatId ?? context.chat?.chat_id }, window.location.origin);
    }
}

function sendSettingsSyncToApp(settings) {
    if (appWindow && !appWindow.closed) {
        appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-settings-sync', nonce: _bridgeNonce, settings }, window.location.origin);
    }
}

function sendAgentsSyncToApp() {
    if (appWindow && !appWindow.closed) {
        const context = SillyTavern.getContext();
        const agents = context.extensionSettings?.SillyTavernEnhancedLorebook?.agents || [];
        appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-settings-sync', nonce: _bridgeNonce, agents }, window.location.origin);
    }
}

function isAgentActiveForChat(agent, context) {
    if (!agent || agent.scope !== 'local') return true;
    const charId = context?.characterId ?? 'no-char';
    const chatFile = context?.chatId ?? context?.chat?.chat_id ?? 'default';
    const chatId = charId + '_' + chatFile;
    if (agent.boundCharacterId && String(agent.boundCharacterId) !== String(charId)) return false;
    if (agent.boundChatId && String(agent.boundChatId) !== String(chatId)) return false;
    return !!agent.boundChatId || !!agent.boundCharacterId;
}

async function getActiveCharacterLorebooks() {
    const context = SillyTavern.getContext();
    const charId = context?.characterId;

    // ST core stores this_chid as a string (setCharacterId stringifies it), so
    // accept both numeric strings and plain numbers.
    const charIndex = (charId !== undefined && charId !== null) ? Number(charId) : NaN;
    const character = (Number.isInteger(charIndex) && charIndex >= 0 && Array.isArray(context?.characters))
        ? context.characters[charIndex]
        : null;

    // Chat lore: lorebook attached to the active chat via chat_metadata['world_info'].
    // Works in single-character and group chats alike.
    const chatLorebook = (typeof context?.chatMetadata?.['world_info'] === 'string' && context.chatMetadata['world_info'])
        ? context.chatMetadata['world_info']
        : null;

    // Character lore: primary world + additional books (world_info.charLore), keyed by avatar filename.
    const characterLorebooks = [];
    let embeddedBook = null;
    if (character) {
        const primary = character?.data?.extensions?.world;
        if (typeof primary === 'string' && primary) {
            characterLorebooks.push(primary);
        } else {
            // Embedded-only lorebook that was never imported as a file.
            embeddedBook = character?.data?.character_book?.name;
            if (typeof embeddedBook === 'string' && embeddedBook) {
                characterLorebooks.push(embeddedBook);
            }
        }

        try {
            const wiModule = await import('/scripts/world-info.js');
            const fileName = (character?.avatar || '').replace(/\.[^/.]+$/, '');
            const entry = Array.isArray(wiModule.world_info?.charLore)
                ? wiModule.world_info.charLore.find(e => e && e.name === fileName)
                : null;
            const extraBooks = Array.isArray(entry?.extraBooks) ? entry.extraBooks.filter(Boolean) : [];
            for (const name of extraBooks) {
                if (!characterLorebooks.includes(name)) characterLorebooks.push(name);
            }
        } catch (e) {
            console.error('Enhanced Lorebook: failed to read character lorebooks', e);
        }
    }

    const result = {
        characterId: charId ?? null,
        characterName: character?.name || '',
        chatLorebook,
        characterLorebooks,
        embeddedBook,
    };
    console.debug('Enhanced Lorebook: active lorebooks =', result);
    return result;
}

// ── Legacy ST-native dynamic scan — REMOVED (Hub v2). ──
// Hub inline tools (hub-tools.js: ls/grep/read) inspect linked
// lorebooks at run time instead.

function handleNewMessage() {
    messageCounter++;
    try {
        Promise.resolve()
            .then(() => elRulesOnMessage())
            .catch((e) => { console.error('Enhanced Lorebook: rules on-message error', e); });
    } catch (e) {
        console.error('Enhanced Lorebook: rules on-message error', e);
    }
    // Reset per-agent counters when chat changes so intervals stay per-chat.
    try {
        const context = SillyTavern.getContext();
        const agents = context.extensionSettings?.SillyTavernEnhancedLorebook?.agents || [];
        if (!agents.length) return;

        const agentsToTrigger = [];
        for (const a of agents) {
            if (!a.enabled || a.mode !== 'periodic' || !isAgentActiveForChat(a, context)) continue;
            const interval = Math.max(1, Number(a.interval || a.periodicInterval || 10));
            periodicCounters[a.id] = (periodicCounters[a.id] || 0) + 1;
            if (periodicCounters[a.id] >= interval) {
                periodicCounters[a.id] = 0;
                agentsToTrigger.push(a);
            }
        }
        if (!agentsToTrigger.length) return;

        lastPeriodicRun = Date.now();

        const agentIds = agentsToTrigger.map(a => a.id);
        if (appWindow && !appWindow.closed) {
            sendPeriodicTriggerToApp(agentIds);
        } else {
            pendingPeriodicTrigger = true;
            pendingPeriodicAgentIds = agentIds;
        }
    } catch (e) {
        console.error('Enhanced Lorebook: handleNewMessage error', e);
    }
}

// ── EL-REVAMP B5: user-built systems, per-entry rows, message-received run ──
// Systems live in extensionSettings.systems [{id, name, check, n, target}]
// (check: 'message' | 'every-n' | 'manual'; target: entry content label to
// set, default 'Current_Location'). Per-entry rows live in
// extensionSettings.rules {'<book>|<uid>': {systemId, enabled, rows}} — row
// shape and evaluation come from lib/rules.js (ELRules), shared with the app
// window. Writes are set-field-text only (no toggle-flip/chain actions exist
// — see the assert comment in lib/rules.js) and go through
// EL.guard.guardSave, so the pre-write re-read (guard TOCTOU) protects them.
// A blocked write, or a write to an entry the app window currently holds
// open for editing, is queued app-side-persisted in
// extensionSettings.rulePending {key: [{target, value, at}]} and retried on
// subsequent messages / app open — the same pattern as the map queue.
// No polling timers anywhere here: clock values are read at evaluation time.
const EL_RULES_MAX_WRITES_PER_MESSAGE = 10;
const elRulesHeld = new Set(); // ruleKeys ('book|uid') the app window holds open
const elRulesMsgCounters = {}; // per-system message counters for 'every-n'
const _elLibPromises = {};

function elLoadLibScript(name, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (_elLibPromises[name]) return _elLibPromises[name];
    _elLibPromises[name] = new Promise((resolve, reject) => {
        try {
            const script = document.createElement('script');
            script.id = 'el-lib-' + String(name).replace(/[^a-z0-9]+/gi, '-');
            script.src = `/${getExtensionUrl()}/lib/${name}?v=1`;
            script.async = true;
            script.onload = () => {
                if (window[globalName]) resolve(window[globalName]);
                else reject(new Error(name + ' did not publish ' + globalName));
            };
            script.onerror = () => reject(new Error('could not load lib/' + name));
            (document.head || document.body).appendChild(script);
        } catch (e) {
            reject(e);
        }
    }).catch((e) => {
        delete _elLibPromises[name];
        console.error('Enhanced Lorebook: lib failed to load', name, e);
        throw e;
    });
    return _elLibPromises[name];
}

function elLoadRulesLibs() {
    return elLoadLibScript('type-registry.js', 'ELTypeRegistry')
        .then(() => elLoadLibScript('slot-parse.js', 'ELSlots'))
        .then(() => elLoadLibScript('type-compiler.js', 'ELCompile'))
        .then(() => elLoadLibScript('rules.js', 'ELRules'));
}

function elRulesStore() {
    const ctx = elHostContext();
    const ext = ctx?.extensionSettings?.SillyTavernEnhancedLorebook;
    if (!ext) return null;
    let seeded = false;
    if (!Array.isArray(ext.systems)) { ext.systems = []; seeded = true; }
    const hasSystem = ext.systems.some((s) => s && typeof s === 'object' && typeof s.id === 'string' && s.id);
    if (!hasSystem) {
        ext.systems.unshift({ id: 'schedule', name: 'Schedule system', check: 'message', n: 2, target: 'Current_Location' });
        seeded = true;
    }
    if (!ext.rules || typeof ext.rules !== 'object' || Array.isArray(ext.rules)) { ext.rules = {}; seeded = true; }
    if (!ext.rulePending || typeof ext.rulePending !== 'object' || Array.isArray(ext.rulePending)) { ext.rulePending = {}; seeded = true; }
    if (seeded) {
        try { ctx.saveSettingsDebounced(); } catch (e) { /* seeding persists best-effort */ }
    }
    return ext;
}

function elRulesTypeForHost(entry) {
    try {
        const tid = entry && entry.extensions && entry.extensions.el && entry.extensions.el.type;
        if (!tid || typeof tid !== 'string') return null;
        const reg = window.ELTypeRegistry;
        if (!reg || typeof reg.getType !== 'function') return null;
        const ctx = elHostContext();
        const store = ctx?.extensionSettings?.SillyTavernEnhancedLorebook?.entryTypes;
        if (store && typeof store === 'object') {
            try {
                const t = reg.getType(store, tid);
                if (t) return t;
            } catch (e) { /* fall through to builtins */ }
        }
        if (reg.BUILTIN_TYPES && reg.BUILTIN_TYPES[tid]) {
            try { return JSON.parse(JSON.stringify(reg.BUILTIN_TYPES[tid])); } catch (e) { return reg.BUILTIN_TYPES[tid]; }
        }
    } catch (e) { /* untyped */ }
    return null;
}

// Clock values are read at evaluation time — no timers. dow: 0 = Sunday.
// relations reflects the entry's actual refs: kinds of el.refs on other
// entries of the loaded book whose target is this entry (empty when none).
// entries is the already-loaded book data the caller has in hand — no reads.
function elRulesBuildCtx(entry, book, uid, entries) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    let fieldValues = {};
    try {
        if (window.ELRules && typeof window.ELRules.parseFieldLines === 'function') {
            fieldValues = window.ELRules.parseFieldLines((entry && entry.content) || '');
        }
    } catch (e) { fieldValues = {}; }
    let mapPlaced = false;
    try {
        const ctx = elHostContext();
        const pins = ctx?.extensionSettings?.SillyTavernEnhancedLorebook?.maps?.[book]?.pins;
        mapPlaced = !!(pins && typeof pins === 'object' && Object.prototype.hasOwnProperty.call(pins, String(uid)));
    } catch (e) { mapPlaced = false; }
    let relations = [];
    try {
        if (window.ELRules && typeof window.ELRules.relationsForEntries === 'function') {
            relations = window.ELRules.relationsForEntries(entries || {}, book, uid) || [];
        }
    } catch (e) { relations = []; }
    return {
        time: pad(now.getHours()) + ':' + pad(now.getMinutes()),
        dow: now.getDay(),
        fieldValues,
        mapPlaced,
        relations,
    };
}

function elRulesQueueWrites(ext, key, writes) {
    try {
        const list = (writes || [])
            .map((w) => ({ target: String((w && w.target) || '').trim(), value: w ? String(w.value ?? '') : '' }))
            .filter((w) => !!w.target);
        if (!list.length) return;
        const cur = Array.isArray(ext.rulePending[key]) ? ext.rulePending[key].filter((q) => q && typeof q === 'object') : [];
        for (const w of list) {
            const rec = { target: w.target, value: w.value, at: Date.now() };
            const i = cur.findIndex((q) => q && q.target === w.target);
            if (i !== -1) cur[i] = rec;
            else cur.push(rec);
        }
        ext.rulePending[key] = cur;
    } catch (e) { /* queueing is best-effort */ }
}

function elRulesClearPending(ext, key) {
    try { delete ext.rulePending[key]; } catch (e) { /* tolerate */ }
}

function elRulesNotifyApp(payload) {
    try {
        if (appWindow && !appWindow.closed) {
            appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-rules-refresh', nonce: _bridgeNonce, ...(payload || {}) }, window.location.origin);
        }
    } catch (e) {
        console.error('Enhanced Lorebook: could not notify the app window of a rules write', e);
    }
}

// Apply a write list to one entry (in memory), then land it with one guarded
// save. Returns 'landed' | 'blocked' | 'skipped'. A null compute (or a
// missing guard) counts as blocked so the write retries instead of
// half-landing; the guard's own pre-write re-read is the held-edit TOCTOU.
async function elRulesApplyWrites(book, uid, fresh, writes) {
    try {
        const ELR = window.ELRules;
        if (!ELR) return 'blocked';
        const entry = fresh && fresh.entries ? fresh.entries[String(uid)] : null;
        if (!entry || typeof entry.content !== 'string') return 'skipped';
        const list = Array.isArray(writes) ? writes : [];
        if (!list.length) return 'skipped';
        let next = entry.content;
        for (const w of list) {
            let type = null;
            try { type = elRulesTypeForHost(entry); } catch (e) { type = null; }
            const probe = { ...entry, content: next };
            let out = null;
            try { out = ELR.computeFieldContent(probe, type, w.target, w.value); } catch (e) { out = null; }
            if (out === null || typeof out !== 'string') return 'blocked';
            if (out !== next) next = out;
        }
        if (next === entry.content) return 'landed';
        entry.content = next;
        const guard = elHostGuard();
        if (!guard) return 'blocked';
        let ok = false;
        try {
            ok = await guard.guardSave(book, fresh, { explicitDelete: false, source: 'rules', note: 'Rules write' });
        } catch (e) { ok = false; }
        return ok ? 'landed' : 'blocked';
    } catch (e) {
        return 'blocked';
    }
}

async function elRulesLoadFreshCached(ctx, book, cache) {
    if (cache[book]) return cache[book];
    let fresh = null;
    try { fresh = await ctx.loadWorldInfo(book); } catch (e) { fresh = null; }
    if (fresh && fresh.entries && typeof fresh.entries === 'object') cache[book] = fresh;
    return cache[book] || null;
}

// Retry one queued key (non-held). Used by the message flush and by the
// app→host held-release signal. Returns the number of field-writes landed
async function elRulesFlushKey(key, maxWrites) {
    try {
        await elLoadRulesLibs();
    } catch (e) { return 0; }
    const ELR = window.ELRules;
    if (!ELR) return 0;
    const ctx = elHostContext();
    if (!ctx || typeof ctx.loadWorldInfo !== 'function') return 0;
    const ext = elRulesStore();
    if (!ext) return 0;
    const queued = ext.rulePending[key];
    if (!Array.isArray(queued) || !queued.length) {
        elRulesClearPending(ext, key);
        return 0;
    }
    if (elRulesHeld.has(key)) return 0;
    const cap = (maxWrites === undefined || maxWrites === null)
        ? EL_RULES_MAX_WRITES_PER_MESSAGE
        : Math.max(0, Math.floor(Number(maxWrites)));
    if (cap <= 0) return 0;
    const { book, uid } = ELR.parseRuleKey(key);
    if (!book || !uid) {
        elRulesClearPending(ext, key);
        try { ctx.saveSettingsDebounced(); } catch (e) { /* tolerate */ }
        return 0;
    }
    const slice = queued.slice(0, cap);
    const fresh = await elRulesLoadFreshCached(ctx, book, {});
    if (!fresh || !fresh.entries || !fresh.entries[String(uid)]) {
        // Entry gone underneath: drop the queue, nothing left to retry against.
        elRulesClearPending(ext, key);
        try { ctx.saveSettingsDebounced(); } catch (e) { /* tolerate */ }
        return true;
    }
    const res = await elRulesApplyWrites(book, uid, fresh, slice.map((q) => ({ target: q.target, value: q.value })));
    if (res === 'landed') {
        const rest = queued.slice(slice.length);
        if (rest.length) ext.rulePending[key] = rest;
        else elRulesClearPending(ext, key);
        try { ctx.saveSettingsDebounced(); } catch (e) { /* tolerate */ }
        elRulesNotifyApp({ key, book, uid, ok: true, retried: true });
        return slice.length;
    }
    return 0;
}

async function elRulesOnMessage() {
    try {
        await elLoadRulesLibs();
    } catch (e) {
        console.warn('Enhanced Lorebook: rules libs unavailable, skipping message run');
        return;
    }
    const ELR = window.ELRules;
    if (!ELR) return;
    const ctx = elHostContext();
    if (!ctx || typeof ctx.loadWorldInfo !== 'function') return;
    const ext = elRulesStore();
    if (!ext) return;
    const systems = (ext.systems || []).filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && s.id);
    const sysById = {};
    for (const s of systems) sysById[String(s.id)] = s;
    let writesUsed = 0;
    const freshCache = {};
    for (const key of Object.keys(ext.rulePending || {})) {
        const budget = EL_RULES_MAX_WRITES_PER_MESSAGE - writesUsed;
        if (budget <= 0) break;
        try {
            const landed = await elRulesFlushKey(key, budget);
            writesUsed += Math.max(0, Number(landed) || 0);
        } catch (e) { /* one stuck key must not stop the run */ }
    }
    const dueBySystem = {};
    for (const s of systems) {
        if (String(s.check || 'message') === 'every-n') {
            const n = Math.max(1, Number(s.n) || 2);
            elRulesMsgCounters[String(s.id)] = (elRulesMsgCounters[String(s.id)] || 0) + 1;
            dueBySystem[String(s.id)] = (elRulesMsgCounters[String(s.id)] % n === 0);
        }
    }
    for (const key of Object.keys(ext.rules || {})) {
        let rec = null;
        try { rec = ELR.sanitizeEntryRules(ext.rules[key]); } catch (e) { continue; }
        if (!rec || !rec.enabled || !rec.rows.length) continue;
        const sys = sysById[String(rec.systemId || '')] || null;
        const check = sys ? String(sys.check || 'message') : 'message';
        if (check === 'manual') continue;
        if (check === 'every-n' && sys && dueBySystem[String(sys.id)] !== true) continue;
        const { book, uid } = ELR.parseRuleKey(key);
        if (!book || !uid) continue;
        let fresh = null;
        try { fresh = await elRulesLoadFreshCached(ctx, book, freshCache); } catch (e) { fresh = null; }
        if (!fresh || !fresh.entries || !fresh.entries[String(uid)]) continue;
        const rctx = elRulesBuildCtx(fresh.entries[String(uid)], book, uid, fresh.entries);
        const target = (sys && typeof sys.target === 'string' && sys.target.trim()) ? sys.target.trim() : 'Current_Location';
        let resolved = null;
        try { resolved = ELR.resolveSystem(rec, rctx, target); } catch (e) { continue; }
        if (!resolved || !resolved.writes || !resolved.writes.length) continue;
        const budget = EL_RULES_MAX_WRITES_PER_MESSAGE - writesUsed;
        if (budget <= 0) {
            console.log('Enhanced Lorebook: rules write cap reached (10) for this message — remaining entries skipped.');
            break;
        }
        const wb = resolved.writes.slice(0, budget);
        if (!wb.length) continue;
        if (elRulesHeld.has(key)) {
            elRulesQueueWrites(ext, key, wb);
            elRulesNotifyApp({ key, book, uid, ok: false, held: true });
            continue;
        }
        let res = 'blocked';
        try { res = await elRulesApplyWrites(book, uid, fresh, wb); } catch (e) { res = 'blocked'; }
        if (res === 'landed') {
            writesUsed += wb.length;
            elRulesClearPending(ext, key);
            elRulesNotifyApp({ key, book, uid, ok: true, value: String(wb[0].value ?? '') });
        } else if (res === 'blocked') {
            elRulesQueueWrites(ext, key, wb);
            elRulesNotifyApp({ key, book, uid, ok: false, held: false });
        }
    }
    try { ctx.saveSettingsDebounced(); } catch (e) { /* persist best-effort */ }
}

// e.source binding is the substantive fix: only the popup window this host
// opened (appWindow) may drive the bridge. A same-origin script can forge
// any message *content*, but it cannot forge e.source, which is the
// sender's WindowProxy. The per-load nonce checked below is defence-in-depth
// (and lets a reused popup follow a fresh host load); it must never replace
// the source check. Messages without a nonce are still accepted once with a
// warning so an older cached app build keeps working instead of silently
// breaking the bridge.
async function _elOnBridgeMessage(e) {
    if (e.origin !== window.location.origin) return;
    if (!appWindow || e.source !== appWindow) return;
    const msg = e.data;
    if (!msg || typeof msg !== 'object' || msg.source !== 'enhanced-lorebook') return;
    if (typeof msg.nonce === 'string' && msg.nonce) {
        if (msg.nonce !== _bridgeNonce) return;
    } else if (!_bridgeNonceWarned) {
        _bridgeNonceWarned = true;
        console.warn('Enhanced Lorebook: app message without nonce (older cached app build?) — accepted');
    }

    switch (msg.type) {
        case 'el-agent-toast': {
                const toastText = typeof msg.message === 'string' ? msg.message : String(msg.message || '');
                if (!toastText) break;
                const type = ['success', 'info', 'warning', 'error'].includes(msg.toastType) ? msg.toastType : 'warning';
                try {
                    const fn = typeof toastr === 'object' && toastr && typeof toastr[type] === 'function' ? toastr[type] : toastr?.warning;
                    if (typeof fn === 'function') {
                        fn.call(toastr, toastText);
                    } else {
                        console.warn('Enhanced Lorebook: toastr unavailable, toast dropped:', toastText);
                    }
                } catch (e) {
                    console.error('Enhanced Lorebook: failed to show toast', e);
                }
                break;
            }
            case 'el-agent-trigger-now': {
                const context = SillyTavern.getContext();
                const agents = context.extensionSettings?.SillyTavernEnhancedLorebook?.agents || [];
                if (agents.length) {
                    handleNewMessage();
                }
                break;
            }
            case 'el-pending-count': {
                const badge = document.getElementById('agent-pending-badge');
                if (!badge) break;
                const count = Math.min(999999, Math.max(0, Math.floor(Number(msg.count) || 0)));
                badge.textContent = count > 99 ? '99+' : String(count);
                badge.style.display = count > 0 ? 'inline' : 'none';
                break;
            }
            case 'el-agent-trigger-periodic': {
                const ctx = SillyTavern.getContext();
                const triggered = (ctx.extensionSettings?.SillyTavernEnhancedLorebook?.agents || []).some(a => a.enabled && a.mode === 'periodic' && isAgentActiveForChat(a, ctx));
                if (triggered) {
                    handleNewMessage();
                }
                break;
            }
            case 'el-rules-held': {
                // The app window holds an entry open for editing (held:true) or
                // released it (held:false — retry that key's queue on top of the
                // saved state). Same bridge envelope as every other case here.
                const heldKey = (msg && typeof msg.book === 'string' && typeof msg.uid === 'string' && msg.book && msg.uid)
                    ? msg.book + '|' + msg.uid
                    : '';
                if (!heldKey) break;
                if (msg.held === true) {
                    elRulesHeld.add(heldKey);
                } else {
                    elRulesHeld.delete(heldKey);
                    try {
                        Promise.resolve()
                            .then(() => elRulesFlushKey(heldKey))
                            .catch((e) => { console.error('Enhanced Lorebook: rules flush error', e); });
                    } catch (e) {
                        console.error('Enhanced Lorebook: rules flush error', e);
                    }
                }
                break;
            }
            case 'el-agent-request-chat-info': {
                const ctx2 = SillyTavern.getContext();
                if (e.source) {
                    const agents = ctx2.extensionSettings?.SillyTavernEnhancedLorebook?.agents || [];
                    e.source.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-chat-info', nonce: _bridgeNonce, characterId: ctx2.characterId, chatId: ctx2.chatId ?? ctx2.chat?.chat_id, agents }, window.location.origin);
                }
                break;
            }
            // (Hub v2: el-agent-dynamic-scan bridge removed — hub tools inspect lorebooks.)
            case 'el-agent-request-chat-books': {
                // Chat's active lorebook set for the "Sync with chat" button.
                // Response: el-agent-chat-books { requestId, globalBooks, chatLorebook, characterLorebooks, embeddedBook }
                try {
                    let globalBooks = [];
                    try {
                        const wi = await import('/scripts/world-info.js');
                        if (Array.isArray(wi.selected_world_info)) globalBooks = [...wi.selected_world_info];
                    } catch {}
                    if (!globalBooks.length) {
                        try {
                            const sel = document.getElementById('world_info');
                            if (sel) globalBooks = Array.from(sel.selectedOptions).map(o => o.text).filter(Boolean);
                        } catch {}
                    }
                    const info = await getActiveCharacterLorebooks();
                    if (e.source) {
                        e.source.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-chat-books', nonce: _bridgeNonce, requestId: typeof msg.requestId === 'string' ? msg.requestId : null, globalBooks, chatLorebook: info.chatLorebook, characterLorebooks: info.characterLorebooks, embeddedBook: info.embeddedBook }, window.location.origin);
                    }
                } catch (err) {
                    console.error('Enhanced Lorebook: chat books request failed', err);
                    if (e.source) {
                        e.source.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-chat-books', nonce: _bridgeNonce, requestId: typeof msg?.requestId === 'string' ? msg.requestId : null, globalBooks: [], chatLorebook: null, characterLorebooks: [], embeddedBook: null }, window.location.origin);
                    }
                }
                break;
            }
            case 'el-agent-request-character-lorebooks': {
                try {
                    const info = await getActiveCharacterLorebooks();
                    if (e.source) {
                        e.source.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-character-lorebooks', nonce: _bridgeNonce, ...info }, window.location.origin);
                    }
                } catch (err) {
                    console.error('Enhanced Lorebook: character lorebooks request failed', err);
                    if (e.source) {
                        e.source.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-character-lorebooks', nonce: _bridgeNonce, characterId: null, characterName: '', chatLorebook: null, characterLorebooks: [], embeddedBook: null }, window.location.origin);
                    }
                }
                break;
            }
            case 'el-agent-settings-changed': {
                try {
                    const ctx3 = SillyTavern.getContext();
                    if (!ctx3.extensionSettings.SillyTavernEnhancedLorebook) ctx3.extensionSettings.SillyTavernEnhancedLorebook = {};
                    const store = ctx3.extensionSettings.SillyTavernEnhancedLorebook;
                    if (Array.isArray(msg.agents)) {
                        if (!msg.agents.length || msg.agents.length > 200) {
                            console.error('Enhanced Lorebook: rejected agent settings push (bad agent count)');
                            break;
                        }
                        const valid = msg.agents.every(a => a && typeof a === 'object' && !Array.isArray(a) && typeof a.id === 'string' && a.id && typeof a.name === 'string');
                        if (!valid) {
                            console.error('Enhanced Lorebook: rejected agent settings push (bad agent shape)');
                            break;
                        }
                        delete store.agent;
                        store.agents = msg.agents;
                    } else if (msg.settings && typeof msg.settings === 'object' && !Array.isArray(msg.settings)) {
                        if (typeof msg.settings.id !== 'string' || !msg.settings.id) {
                            console.error('Enhanced Lorebook: rejected single-agent settings push (missing id)');
                            break;
                        }
                        if (!store.agents) {
                            store.agents = [];
                        }
                        const idx = store.agents.findIndex(a => a && a.id === msg.settings.id);
                        if (idx !== -1) {
                            store.agents[idx] = msg.settings;
                        } else {
                            store.agent = msg.settings;
                        }
                    } else {
                        console.error('Enhanced Lorebook: rejected agent settings push (no agents/settings payload)');
                        break;
                    }
                    ctx3.saveSettingsDebounced();
                } catch (e) {
                    console.error('Enhanced Lorebook: settings changed error', e);
                }
                break;
            }
            case 'el-agent-quick-task-ack': {
                // The app window confirms it received the task; stop re-sending.
                if (typeof msg.requestId !== 'string' || !msg.requestId) break;
                const entry = pendingQuickTasks.get(msg.requestId);
                if (entry) {
                    entry.acked = true;
                    try { if (entry.retryId) clearInterval(entry.retryId); } catch (_) {}
                    entry.retryId = null;
                }
                break;
            }
            case 'el-agent-quick-task-result': {
                if (typeof msg.requestId !== 'string' || !msg.requestId) break;
                const entry = pendingQuickTasks.get(msg.requestId);
                if (!entry) break;
                pendingQuickTasks.delete(msg.requestId);
                try { if (entry.timerId) clearTimeout(entry.timerId); } catch (_) {}
                try { if (entry.retryId) clearInterval(entry.retryId); } catch (_) {}
                const name = entry?.agentName || 'Agent';
                if (msg.ok) {
                    const n = Number(msg.proposalsCreated || 0);
                    if (n > 0) {
                        try { toastr.success('Agent "' + name + '" finished — ' + n + ' proposal(s). See Review Changes.'); } catch (_) {}
                        // New proposals landed — tell the rest of SillyTavern.
                        elRefreshQuickTaskBadge()
                            .then(count => elEmitProposalsChanged('created', elHostCanonicalChatId(), count))
                            .catch(() => {});
                    } else if (Array.isArray(msg.warnings) && msg.warnings.length) {
                        try { toastr.warning('Agent "' + name + '" finished with warnings: ' + msg.warnings[0]); } catch (_) {}
                    } else {
                        try { toastr.info('Agent "' + name + '" finished — no proposals needed.'); } catch (_) {}
                    }
                } else {
                    try { toastr.error('Agent "' + name + '" failed: ' + (msg.error || 'unknown error')); } catch (_) {}
                }
                try { elRefreshQuickTaskBadge(); } catch (_) {}
                break;
            }
        }
}

function setupPostMessageBridge() {
    if (_elBridgeReady) return;
    _elBridgeReady = true;
    _elOn(window, 'message', _elOnBridgeMessage);
}

function injectLauncherStyles() {
    if (document.getElementById('enhanced-lorebook-launcher-styles')) return;
    const style = document.createElement('style');
    style.id = 'enhanced-lorebook-launcher-styles';
    style.textContent = `
        .el-launcher-dropdown {
            position: fixed;
            z-index: 30000;
            min-width: 210px;
            background: var(--SmartThemeBlurTintColor, rgba(20, 22, 28, 0.95));
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 10px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.55);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            padding: 6px;
            opacity: 0;
            transform: translateY(-8px) scale(0.96);
            pointer-events: none;
            transition: opacity 0.18s ease, transform 0.18s ease;
        }
        .el-launcher-dropdown.visible {
            opacity: 1;
            transform: translateY(0) scale(1);
            pointer-events: auto;
        }
        .el-launcher-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            border-radius: 7px;
            cursor: pointer;
            color: var(--SmartThemeBodyColor, #dcdfe4);
            font-size: 13.5px;
            font-family: inherit;
            transition: background 0.14s ease;
            user-select: none;
            white-space: nowrap;
        }
        .el-launcher-item:hover {
            background: rgba(255,255,255,0.08);
        }
        .el-launcher-item:active {
            background: rgba(255,255,255,0.13);
        }
        .el-launcher-item i {
            width: 20px;
            text-align: center;
            font-size: 15px;
            opacity: 0.85;
        }
        .el-launcher-item[data-action="enhanced"] i {
            color: var(--SmartThemeQuoteColor, #b4a0ff);
        }
        .el-launcher-item[data-action="agent-config"] i {
            color: #6cd4ff;
        }
        .el-launcher-item[data-action="agent-feed"] i {
            color: #ffb347;
        }
        .el-launcher-divider {
            height: 1px;
            margin: 4px 8px;
            background: rgba(255,255,255,0.08);
        }
        .el-launcher-scrim {
            position: fixed;
            inset: 0;
            z-index: 29999;
            display: none;
        }
        .el-launcher-scrim.visible {
            display: block;
        }
    `;
    document.head.appendChild(style);
}

function _elPositionLauncherDropdown() {
    try {
        if (!_elLauncher.dropdown || !_elLauncher.drawerIcon) return;
        const rect = _elLauncher.drawerIcon.getBoundingClientRect();
        _elLauncher.dropdown.style.top = (rect.bottom + 6) + 'px';
        _elLauncher.dropdown.style.right = Math.max(8, window.innerWidth - rect.right - 10) + 'px';
        _elLauncher.dropdown.style.left = 'auto';
    } catch (e) {
        console.error('Enhanced Lorebook: launcher position failed', e);
    }
}

function _elShowLauncher() {
    _elPositionLauncherDropdown();
    if (_elLauncher.scrim) _elLauncher.scrim.classList.add('visible');
    if (_elLauncher.dropdown) _elLauncher.dropdown.classList.add('visible');
    _elLauncher.isOpen = true;
}

function _elHideLauncher() {
    if (_elLauncher.scrim) _elLauncher.scrim.classList.remove('visible');
    if (_elLauncher.dropdown) _elLauncher.dropdown.classList.remove('visible');
    _elLauncher.isOpen = false;
}

function _elOnLauncherDocClick(e) {
    try {
        if (!_elLauncher.drawerToggle || !_elLauncher.drawerToggle.contains(e.target)) return;

        if (_elLauncher.bypassIntercept) {
            _elLauncher.bypassIntercept = false;
            return;
        }

        if (_elLauncher.worldInfoContent && _elLauncher.worldInfoContent.classList.contains('openDrawer')) {
            if (_elLauncher.isOpen) _elHideLauncher();
            return;
        }

        e.stopPropagation();
        e.preventDefault();

        if (_elLauncher.isOpen) {
            _elHideLauncher();
        } else {
            _elShowLauncher();
        }
    } catch (err) {
        console.error('Enhanced Lorebook: launcher click failed', err);
    }
}

function _elOnLauncherScrimClick() {
    _elHideLauncher();
}

function _elOnLauncherDropdownClick(e) {
    try {
        const item = e.target.closest('[data-action]');
        if (!item) return;

        e.stopPropagation();
        _elHideLauncher();

        if (item.dataset.action === 'native') {
            _elLauncher.bypassIntercept = true;
            if (_elLauncher.drawerToggle) _elLauncher.drawerToggle.click();
        } else if (item.dataset.action === 'enhanced') {
            openStandaloneApp();
        } else if (item.dataset.action === 'agent-dashboard') {
            openStandaloneApp('agent-dashboard');
        } else if (item.dataset.action === 'agent-feed') {
            openStandaloneApp('agent-feed');
        }
    } catch (err) {
        console.error('Enhanced Lorebook: launcher action failed', err);
    }
}

function _elOnLauncherKeydown(e) {
    if (e.key === 'Escape' && _elLauncher.isOpen) {
        e.stopPropagation();
        _elHideLauncher();
    }
}

function setupLauncherDropdown() {
    if (_elLauncherReady) {
        if (document.getElementById('el-launcher-dropdown')) return true;
        _elLauncherReady = false;
    }
    const wiDrawer = document.getElementById('WI-SP-button');
    if (!wiDrawer) {
        console.warn(`${EXTENSION_NAME}: WI button not found.`);
        return false;
    }

    const drawerToggle = wiDrawer.querySelector('.drawer-toggle');
    const drawerIcon = wiDrawer.querySelector('.drawer-icon');

    if (!drawerToggle || !drawerIcon) {
        console.warn(`${EXTENSION_NAME}: WI drawer elements not found.`);
        return false;
    }

    injectLauncherStyles();

    const staleDropdown = document.getElementById('el-launcher-dropdown');
    if (staleDropdown) staleDropdown.remove();
    document.querySelectorAll('.el-launcher-scrim').forEach(el => el.remove());

    const dropdown = document.createElement('div');
    dropdown.id = 'el-launcher-dropdown';
    dropdown.className = 'el-launcher-dropdown';
    dropdown.innerHTML = `
        <div class="el-launcher-item" data-action="native">
            <i class="fa-solid fa-book-atlas"></i>
            <span>Normal Lorebook</span>
        </div>
        <div class="el-launcher-divider"></div>
        <div class="el-launcher-item" data-action="enhanced">
            <i class="fa-solid fa-book-open"></i>
            <span>Enhanced Lorebook</span>
        </div>
        <div class="el-launcher-divider"></div>
        <div class="el-launcher-item" data-action="agent-dashboard">
            <i class="fa-solid fa-robot"></i>
            <span>Agent Dashboard</span>
        </div>
        <div class="el-launcher-item" data-action="agent-feed">
            <i class="fa-solid fa-clipboard-list"></i>
            <span>Review Changes</span>
            <span id="agent-pending-badge" class="badge-count" style="display:none;">0</span>
        </div>
    `;

    const scrim = document.createElement('div');
    scrim.className = 'el-launcher-scrim';

    document.body.appendChild(scrim);
    document.body.appendChild(dropdown);

    if (getComputedStyle(drawerIcon).position === 'static') {
        drawerIcon.style.position = 'relative';
    }
    const staleChevron = drawerIcon.querySelector('.charlib-chevron-badge');
    if (staleChevron) staleChevron.remove();
    const chevron = document.createElement('i');
    chevron.className = 'fa-solid fa-caret-down charlib-chevron-badge';
    Object.assign(chevron.style, {
        position: 'absolute',
        bottom: '2px',
        right: '0px',
        fontSize: '7px',
        opacity: '0.5',
        pointerEvents: 'none',
        color: 'var(--SmartThemeBodyColor, #dcdfe4)',
    });
    drawerIcon.appendChild(chevron);

    _elLauncher.dropdown = dropdown;
    _elLauncher.scrim = scrim;
    _elLauncher.chevron = chevron;
    _elLauncher.drawerToggle = drawerToggle;
    _elLauncher.drawerIcon = drawerIcon;
    _elLauncher.worldInfoContent = document.getElementById('WorldInfo');
    _elLauncher.isOpen = false;
    _elLauncher.bypassIntercept = false;

    _elOn(document, 'click', _elOnLauncherDocClick, true);
    _elOn(scrim, 'click', _elOnLauncherScrimClick);
    _elOn(dropdown, 'click', _elOnLauncherDropdownClick);
    _elOn(document, 'keydown', _elOnLauncherKeydown);

    _elLauncherReady = true;
    return true;
}

// ── Quick-task: wand button + popup + slash, dispatched to the app window ──
// Lets the user pick an agent and give it a one-shot task from the chat bar,
// with a configurable RP message window (none/all/first/last/range), an
// optional hub API profile override, and snapshot toggles (character card,
// author note, lorebooks, static injects).
// Quick tasks are dispatched to the Enhanced Lorebook app window (which owns
// the lorebook guard) via postMessage; the app window runs the agent and
// posts the result back. Proposals land in Review Changes for review.

const EL_QUICK_SETTINGS_KEY = 'SillyTavernEnhancedLorebook';
const pendingQuickTasks = new Map();

function elEscapeHtmlQt(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function elGetQuickTaskAgents() {
    try {
        const context = SillyTavern.getContext();
        const agents = context.extensionSettings?.[EL_QUICK_SETTINGS_KEY]?.agents;
        return Array.isArray(agents) ? agents : [];
    } catch (_) {
        return [];
    }
}

async function elRefreshQuickTaskBadge() {
    try {
        const context = SillyTavern.getContext();
        const charId = context?.characterId ?? 'no-char';
        const chatFile = context?.chatId ?? context?.chat?.chat_id ?? 'default';
        const chatId = charId + '_' + chatFile;
        const headers = (typeof context?.getRequestHeaders === 'function') ? context.getRequestHeaders() : { 'Content-Type': 'application/json' };
        const resp = await fetch('/api/plugins/enhanced-lorebook-agent/proposals/list?chatId=' + encodeURIComponent(chatId), { headers });
        if (!resp.ok) return 0;
        const data = await resp.json().catch(() => null);
        const count = (data?.proposals || []).filter(p => p.status === 'pending').length;
        const badge = document.getElementById('agent-pending-badge');
        if (badge) {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.style.display = count > 0 ? 'inline' : 'none';
        }
        return count;
    } catch (e) {
        console.error('Enhanced Lorebook: quick-task badge refresh failed', e);
        return 0;
    }
}

// ── Quick-task options: message window + profile + context toggles ──
// Shape mirrors the World Info Recommender's contextToSend.messages
// (none | all | first | last | range) plus a hub API profile name override
// and snapshot toggles.
const EL_QUICK_DEFAULT_OPTS = {
    profileId: '',
    messages: { type: 'last', first: 10, last: 10, range: { start: 0, end: 10 } },
    includeCharCard: true,
    includeAuthorNote: true,
    includeWorldInfo: true,
    includeInjected: true,
};

function elCloneQuickOpts() {
    return JSON.parse(JSON.stringify(EL_QUICK_DEFAULT_OPTS));
}

function elClampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

function elSanitizeQuickMessages(m) {
    const src = (m && typeof m === 'object') ? m : {};
    const type = ['none', 'all', 'first', 'last', 'range'].includes(src.type) ? src.type : 'last';
    const r = (src.range && typeof src.range === 'object') ? src.range : {};
    const start = elClampInt(r.start, 0, 100000, 0);
    let end = elClampInt(r.end, 0, 100000, 10);
    if (end < start) end = start;
    return {
        type,
        first: elClampInt(src.first, 1, 500, 10),
        last: elClampInt(src.last, 1, 500, 10),
        range: { start, end },
    };
}

function elSanitizeQuickOpts(input) {
    const src = (input && typeof input === 'object') ? input : {};
    return {
        profileId: typeof src.profileId === 'string' ? src.profileId.trim().slice(0, 120) : '',
        messages: elSanitizeQuickMessages(src.messages),
        includeCharCard: src.includeCharCard !== false,
        includeAuthorNote: src.includeAuthorNote !== false,
        includeWorldInfo: src.includeWorldInfo !== false,
        includeInjected: src.includeInjected !== false,
        // Granular one-shot exclusions (chat message IDs, "12, 15-18").
        excludeIds: elSanitizeIdList(src.excludeIds),
    };
}

// Parses "12, 15-18" / arrays into a sorted unique int list (cap 200).
function elSanitizeIdList(v) {
    const out = [];
    const push = (n) => {
        const i = Number(n);
        if (Number.isInteger(i) && i >= 0 && i <= 100000 && !out.includes(i)) out.push(i);
    };
    try {
        if (Array.isArray(v)) {
            for (const x of v) push(x);
        } else if (typeof v === 'string' && v.trim()) {
            for (const part of v.split(',')) {
                const t = part.trim();
                if (!t) continue;
                const rm = /^(\d+)\s*-\s*(\d+)$/.exec(t);
                if (rm) {
                    const lo = Math.min(Number(rm[1]), Number(rm[2]));
                    const hi = Math.max(Number(rm[1]), Number(rm[2]));
                    for (let i = lo; i <= hi && out.length < 200; i++) push(i);
                } else push(t);
                if (out.length >= 200) break;
            }
        }
    } catch (_) {}
    return out.sort((a, b) => a - b);
}

// ── Unified-context adapters ──
// The popup / /el-run still speak legacy quick-opts; the agent stores
// context. Popup controls act as ONE-SHOT overrides merged over the stored
// context for that run only (see EL_mergeContextOverride).
function elContextToQuickOpts(ctx, profileId) {
    const c = (ctx && typeof ctx === 'object') ? ctx : {};
    const m = (c.messages && typeof c.messages === 'object') ? c.messages : {};
    const s = (c.sources && typeof c.sources === 'object') ? c.sources : {};
    let type = ['none', 'all', 'last', 'range'].includes(m.mode) ? m.mode : 'last';
    let first = 10;
    const last = Math.max(1, Math.min(1000, Number(m.last) || 10));
    let range = { start: Math.max(0, Number(m.start) || 0), end: Math.max(0, Number(m.end) || 10) };
    if (range.end < range.start) range.end = range.start;
    if (type === 'range' && range.start === 0) { type = 'first'; first = Math.max(1, range.end); }
    return elSanitizeQuickOpts({
        profileId: typeof profileId === 'string' ? profileId : '',
        messages: { type, first, last, range },
        includeCharCard: !s.charCard || s.charCard.enabled !== false,
        includeAuthorNote: !s.authorNote || s.authorNote.enabled !== false,
        includeWorldInfo: !s.worldInfo || s.worldInfo.enabled !== false,
        includeInjected: !s.injected || s.injected.enabled !== false,
    });
}

// The quick-opts -> unified-context conversion now lives in the app window
// (agent-ui.js: EL_quickOptsToContextOverride), which is where the run happens.

// Last-used globals, persisted under the extension settings key.
function elGetQuickGlobals() {
    try {
        const context = SillyTavern.getContext();
        const stored = context.extensionSettings?.[EL_QUICK_SETTINGS_KEY]?.quickTask;
        if (stored && typeof stored === 'object') return elSanitizeQuickOpts(stored);
    } catch (_) {}
    return elCloneQuickOpts();
}

function elSaveQuickGlobals(opts) {
    try {
        const context = SillyTavern.getContext();
        if (!context.extensionSettings[EL_QUICK_SETTINGS_KEY]) context.extensionSettings[EL_QUICK_SETTINGS_KEY] = {};
        context.extensionSettings[EL_QUICK_SETTINGS_KEY].quickTask = elSanitizeQuickOpts(opts);
        context.saveSettingsDebounced();
    } catch (e) {
        console.error('Enhanced Lorebook: failed to save quick-task options', e);
    }
}

// Per-agent one-shot starting values for the popup: the agent's stored
// unified context translated back to popup controls (+ profile override).
// null when the agent has none, so the popup falls back to globals.
function elGetAgentQuickDefaults(agent) {
    try {
        if (agent && typeof agent === 'object') {
            const qd = (agent.quickDefaults && typeof agent.quickDefaults === 'object') ? agent.quickDefaults : {};
            let ctx = (agent.context && typeof agent.context === 'object') ? agent.context : null;
            if (!ctx && typeof EL_resolveAgentContext === 'function') {
                try { ctx = EL_resolveAgentContext(agent); } catch (_) { ctx = null; }
            }
            if (ctx) return elContextToQuickOpts(ctx, qd.profileId || '');
            if (agent.quickDefaults) return elSanitizeQuickOpts(agent.quickDefaults);
        }
    } catch (_) {}
    return null;
}

function elListHubProfiles() {
    // Hub v2: profiles live in ST-RequestHub (name + URL + key + model).
    // The profile NAME is what travels in the request JSON.
    try {
        const hub = globalThis.STRequestHub;
        if (!hub || typeof hub.listApiProfiles !== 'function') return [];
        const list = hub.listApiProfiles() || [];
        return list
            .filter(p => p && p.name)
            .map(p => ({ id: String(p.name), name: String(p.name), model: String(p.model || '') }));
    } catch (_) { return []; }
}

function elStripHtmlForQuick(s) {
    return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// NOTE: history + snapshot assembly now lives in app/context-builder.js
// (EL_buildAgentContextAsync) — the unified builder for all run paths.
// elBuildQuickHistory / elBuildQuickContextBlock were removed; the popup opts
// travel to the app window, which converts them into a one-shot context
// override for that run only.

function elCountRpMessages(chat) {
    try {
        let n = 0;
        for (const m of (Array.isArray(chat) ? chat : [])) {
            if (m && !m.is_system && String(m.mes ?? '').trim()) n++;
        }
        return n;
    } catch (_) { return 0; }
}

async function elRunQuickTask(agentId, taskText, runOpts) {
    let agentName = 'Agent';
    try {
        const task = String(taskText || '').trim();
        if (!task) { try { toastr.warning('Task is empty.'); } catch (_) {} return; }
        let context = null;
        try { context = SillyTavern.getContext(); } catch (_) { try { toastr.error('SillyTavern context unavailable'); } catch (_) {} return; }
        const agent = elGetQuickTaskAgents().find(a => a && a.id === agentId);
        if (!agent) { try { toastr.warning('Agent not found.'); } catch (_) {} return; }
        agentName = agent.name || 'Unnamed';
        if (agent.enabled === false) { try { toastr.warning('Agent "' + agentName + '" is disabled.'); } catch (_) {} return; }
        if (!isAgentActiveForChat(agent, context)) { try { toastr.warning('Agent "' + agentName + '" is bound to another chat.'); } catch (_) {} return; }
        const opts = elSanitizeQuickOpts(runOpts || elGetQuickGlobals());
        elSaveQuickGlobals(opts);
        let profileOverride = (opts.profileId || '').trim();
        if (profileOverride) {
            try {
                const hub = globalThis.STRequestHub;
                const names = (hub && typeof hub.listApiProfiles === 'function')
                    ? hub.listApiProfiles().map(p => p && p.name).filter(Boolean)
                    : [];
                if (!names.includes(profileOverride)) {
                    try { toastr.warning('Hub API profile "' + profileOverride + '" not found — using agent default.'); } catch (_) {}
                    profileOverride = '';
                }
            } catch (_) {}
        }
        if (!appWindow || appWindow.closed) {
            openStandaloneApp('agent-dashboard');
        }
        if (!appWindow || appWindow.closed) { try { toastr.error('Could not open the Enhanced Lorebook window — quick tasks now run there.'); } catch (_) {} return; }
        const requestId = 'qt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const entry = { agentName, startedAt: Date.now(), timerId: null, retryId: null, acked: false, attempts: 0 };
        const payload = {
            source: 'enhanced-lorebook',
            type: 'el-agent-quick-task',
            nonce: _bridgeNonce,
            requestId,
            agentId,
            task,
            opts: {
                profileId: profileOverride,
                messages: { type: opts.messages.type, first: opts.messages.first, last: opts.messages.last, range: { start: opts.messages.range.start, end: opts.messages.range.end } },
                includeCharCard: opts.includeCharCard,
                includeAuthorNote: opts.includeAuthorNote,
                includeWorldInfo: opts.includeWorldInfo,
                includeInjected: opts.includeInjected,
                excludeIds: opts.excludeIds || [],
            },
        };
        const stopRetry = () => { try { if (entry.retryId) clearInterval(entry.retryId); } catch (_) {} entry.retryId = null; };
        const postTask = () => {
            try {
                if (appWindow && !appWindow.closed) appWindow.postMessage(payload, window.location.origin);
            } catch (_) {}
        };
        entry.timerId = setTimeout(() => {
            try {
                if (pendingQuickTasks.has(requestId)) {
                    pendingQuickTasks.delete(requestId);
                    stopRetry();
                    try { toastr.warning('Agent "' + agentName + '" did not report back — check the Enhanced Lorebook window.'); } catch (_) {}
                }
            } catch (_) {}
        }, 10 * 60 * 1000);
        // The app window may have just been opened, so its message listener may
        // not be registered yet — keep re-sending until it acknowledges receipt.
        entry.retryId = setInterval(() => {
            if (entry.acked || !pendingQuickTasks.has(requestId)) { stopRetry(); return; }
            entry.attempts++;
            if (entry.attempts > 25) { stopRetry(); return; } // ~20s; the 10-min timeout still warns
            postTask();
        }, 800);
        pendingQuickTasks.set(requestId, entry);
        postTask();
        try { toastr.info('Agent "' + agentName + '" started in the Enhanced Lorebook window — review the results in Review Changes.'); } catch (_) {}
    } catch (e) {
        console.error('Enhanced Lorebook: quick-task failed', e);
        try { toastr.error('Agent "' + agentName + '" failed: ' + (e?.message || e)); } catch (_) {}
    }
}

function elReadQuickDialog(dlg) {
    const v = (s) => { try { const el = dlg.querySelector(s); return el ? el.value : ''; } catch (_) { return ''; } };
    const c = (s, fb) => { try { const el = dlg.querySelector(s); return el ? !!el.checked : fb; } catch (_) { return fb; } };
    return elSanitizeQuickOpts({
        profileId: v('#el-quick-profile'),
        messages: {
            type: v('#el-quick-msgtype'),
            first: v('#el-quick-first'),
            last: v('#el-quick-last'),
            range: { start: v('#el-quick-range-start'), end: v('#el-quick-range-end') },
        },
        includeCharCard: c('#el-quick-inc-char', true),
        includeAuthorNote: c('#el-quick-inc-author', true),
        includeWorldInfo: c('#el-quick-inc-wi', true),
        includeInjected: c('#el-quick-inc-inj', true),
    });
}

// Deep-ish merge for partial overrides (/el-run args): {messages:{...}}
// merges onto the base instead of replacing it.
function elMergeQuickOpts(base, partial) {
    const b = elSanitizeQuickOpts(base);
    const p = (partial && typeof partial === 'object') ? partial : {};
    const pm = (p.messages && typeof p.messages === 'object') ? p.messages : {};
    const pr = (pm.range && typeof pm.range === 'object') ? pm.range : {};
    return elSanitizeQuickOpts({
        ...b,
        ...p,
        messages: { ...b.messages, ...pm, range: { ...b.messages.range, ...pr } },
    });
}

// Parses: profile="Name" | last=N | first=N | range=A-B | msgs=none|all |
// excl=1,5-9 — everything else stays task text.
function elParseQuickSlashArgs(raw) {
    const out = { opts: {}, task: '' };
    let s = String(raw || '');
    const pm = s.match(/profile\s*=\s*("[^"]+"|\S+)/);
    if (pm) {
        let v = pm[1];
        if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        // Accept a profile name or id; resolve to id later against live list.
        out.opts.profileName = v;
        s = s.replace(pm[0], ' ');
    }
    const lm = s.match(/\blast\s*=\s*(\d+)/);
    if (lm) { out.opts.messages = Object.assign(out.opts.messages || {}, { type: 'last', last: parseInt(lm[1], 10) }); s = s.replace(lm[0], ' '); }
    const fm = s.match(/\bfirst\s*=\s*(\d+)/);
    if (fm) { out.opts.messages = Object.assign(out.opts.messages || {}, { type: 'first', first: parseInt(fm[1], 10) }); s = s.replace(fm[0], ' '); }
    const rm = s.match(/\brange\s*=\s*(\d+)\s*-\s*(\d+)/);
    if (rm) { out.opts.messages = Object.assign(out.opts.messages || {}, { type: 'range', range: { start: parseInt(rm[1], 10), end: parseInt(rm[2], 10) } }); s = s.replace(rm[0], ' '); }
    const mm = s.match(/\bmsgs\s*=\s*(none|all|first|last|range)/);
    if (mm) {
        out.opts.messages = Object.assign(out.opts.messages || {}, { type: mm[1] });
        s = s.replace(mm[0], ' ');
    }
    const xm = s.match(/\bexcl\s*=\s*([\d,\s-]+)/);
    if (xm) {
        out.opts.excludeIds = xm[1].trim();
        s = s.replace(xm[0], ' ');
    }
    out.task = s.replace(/\s+/g, ' ').trim();
    return out;
}

async function openElQuickPrompt(prefill) {
    const agents = elGetQuickTaskAgents();
    if (!agents.length) {
        try { toastr.warning('No agents yet — create one in Enhanced Lorebook → Agent Dashboard first.'); } catch (_) {}
        return;
    }
    let context = null;
    try { context = SillyTavern.getContext(); } catch (_) {}
    const activeAgents = agents.filter(a => { try { return isAgentActiveForChat(a, context); } catch (_) { return true; } });
    const fallbackList = activeAgents.length ? activeAgents : agents;
    const byId = {};
    try { for (const a of agents) { if (a && a.id) byId[a.id] = a; } } catch (_) {}
    const profiles = elListHubProfiles();
    const rpCount = elCountRpMessages(context?.chat);
    const globals = elGetQuickGlobals();
    const firstAgent = (fallbackList[0] && byId[fallbackList[0].id]) || fallbackList[0];
    let baseOpts = (firstAgent && elGetAgentQuickDefaults(firstAgent)) || globals;
    let prefillTask = '';
    if (typeof prefill === 'string') {
        prefillTask = prefill;
    } else if (prefill && typeof prefill === 'object') {
        prefillTask = String(prefill.task || '');
        const po = (prefill.opts && typeof prefill.opts === 'object') ? { ...prefill.opts } : {};
        // /el-run may pass a hub profile NAME — resolve against the live hub list.
        if (po.profileName && !po.profileId) {
            try {
                const needle = String(po.profileName).toLowerCase();
                const hit = profiles.find(p => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle)
                    || profiles.find(p => p.name.toLowerCase().includes(needle));
                if (hit) po.profileId = hit.id;
                else try { toastr.warning('Hub API profile "' + po.profileName + '" not found — using agent default.'); } catch (_) {}
            } catch (_) {}
            delete po.profileName;
        }
        baseOpts = elMergeQuickOpts(baseOpts, po);
    }
    baseOpts = elSanitizeQuickOpts(baseOpts);
    const options = agents.map(a => {
        let disabled = false;
        try { disabled = !isAgentActiveForChat(a, context); } catch (_) {}
        const suffix = (a.enabled === false ? ' (disabled)' : '') + (disabled ? ' (other chat)' : '');
        return '<option value="' + elEscapeHtmlQt(a.id) + '"' + (disabled ? ' disabled' : '') + '>' + elEscapeHtmlQt((a.name || 'Unnamed') + suffix) + '</option>';
    }).join('');
    const profileOptions = '<option value="">Agent default (hub profile / ST backend)</option>' + profiles.map(p => {
        const bits = [p.name];
        if (p.model) bits.push(p.model);
        return '<option value="' + elEscapeHtmlQt(p.id) + '">' + elEscapeHtmlQt(bits.join(' \u00B7 ')) + '</option>';
    }).join('');
    const msgTypeOptions = [['none', 'None'], ['all', 'All messages'], ['first', 'First X messages'], ['last', 'Last X messages'], ['range', 'Range']]
        .map(([v, l]) => '<option value="' + v + '"' + (baseOpts.messages.type === v ? ' selected' : '') + '>' + l + '</option>').join('');
    const chk = (on) => on ? ' checked' : '';
    const content = ''
        + '<h3>Ask Lorebook Agent</h3>'
        + '<div class="world_entry_form_control"><label for="el-quick-agent">Agent</label>'
        + '<select id="el-quick-agent" class="text_pole">' + options + '</select></div>'
        + '<div class="world_entry_form_control"><label for="el-quick-task">Task (one-shot — not saved, no history carried over)</label>'
        + '<textarea id="el-quick-task" class="text_pole" rows="5" placeholder="e.g. Create an entry for the tavern the party just entered…"></textarea></div>'
        + '<h4 style="margin:10px 0 4px;">Model</h4>'
        + '<div class="world_entry_form_control"><label for="el-quick-profile">Hub API profile override (empty = agent default)</label>'
        + '<select id="el-quick-profile" class="text_pole">' + profileOptions + '</select>'
        + '<div id="el-quick-profile-note" style="opacity:0.7;font-size:0.82rem;"></div></div>'
        + '<h4 style="margin:10px 0 4px;">Context to send</h4>'
        + '<div class="world_entry_form_control"><label for="el-quick-msgtype">RP messages to include (<span id="el-quick-chatcount">' + rpCount + '</span> in chat; ST system messages skipped)</label>'
        + '<select id="el-quick-msgtype" class="text_pole">' + msgTypeOptions + '</select></div>'
        + '<div class="world_entry_form_control" id="el-quick-first-row" style="display:none;"><label for="el-quick-first">First N messages</label>'
        + '<input id="el-quick-first" type="number" class="text_pole" min="1" max="500" value="' + baseOpts.messages.first + '"></div>'
        + '<div class="world_entry_form_control" id="el-quick-last-row" style="display:none;"><label for="el-quick-last">Last N messages</label>'
        + '<input id="el-quick-last" type="number" class="text_pole" min="1" max="500" value="' + baseOpts.messages.last + '"></div>'
        + '<div class="world_entry_form_control" id="el-quick-range-row" style="display:none;"><label>Range (chat message IDs; exclusions live in the agent config)</label>'
        + '<div style="display:flex;gap:6px;"><input id="el-quick-range-start" type="number" class="text_pole" min="0" max="100000" value="' + baseOpts.messages.range.start + '" title="Start">'
        + '<input id="el-quick-range-end" type="number" class="text_pole" min="0" max="100000" value="' + baseOpts.messages.range.end + '" title="End"></div></div>'
        + '<label class="checkbox_label"><input type="checkbox" id="el-quick-inc-char"' + chk(baseOpts.includeCharCard) + '> Active character card</label><br>'
        + '<label class="checkbox_label"><input type="checkbox" id="el-quick-inc-author"' + chk(baseOpts.includeAuthorNote) + '> Author note</label><br>'
        + '<label class="checkbox_label"><input type="checkbox" id="el-quick-inc-wi"' + chk(baseOpts.includeWorldInfo) + '> Lorebook snapshot (names + entry counts)</label><br>'
        + '<label class="checkbox_label"><input type="checkbox" id="el-quick-inc-inj"' + chk(baseOpts.includeInjected) + '> Agent&rsquo;s static injected context</label>'
        + '<div style="opacity:0.7;font-size:0.82rem;margin-top:6px;">Runs in the background while you keep roleplaying. Proposals land in Review Changes.</div>';
    try {
        const { Popup, POPUP_TYPE, POPUP_RESULT } = await import('/scripts/popup.js');
        const captured = { agentId: (fallbackList[0] && fallbackList[0].id) || '', task: prefillTask, opts: baseOpts };
        const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
            wide: true,
            allowVerticalScrolling: true,
            okButton: 'Run in background',
            cancelButton: 'Cancel',
            onClosing: (pop) => {
                try {
                    const sel = pop.dlg.querySelector('#el-quick-agent');
                    const ta = pop.dlg.querySelector('#el-quick-task');
                    if (sel && sel.value) captured.agentId = sel.value;
                    if (ta) captured.task = ta.value;
                    captured.opts = elReadQuickDialog(pop.dlg);
                } catch (_) {}
                return true;
            },
        });
        try {
            const dlg = popup.dlg;
            const q = (s) => dlg.querySelector(s);
            const sel = q('#el-quick-agent');
            if (sel && captured.agentId) sel.value = captured.agentId;
            const ta = q('#el-quick-task');
            if (ta && prefillTask) ta.value = prefillTask;
            const refreshRows = () => {
                try {
                    const t = q('#el-quick-msgtype') ? q('#el-quick-msgtype').value : 'last';
                    if (q('#el-quick-first-row')) q('#el-quick-first-row').style.display = t === 'first' ? '' : 'none';
                    if (q('#el-quick-last-row')) q('#el-quick-last-row').style.display = t === 'last' ? '' : 'none';
                    if (q('#el-quick-range-row')) q('#el-quick-range-row').style.display = t === 'range' ? '' : 'none';
                } catch (_) {}
            };
            const refreshProfileState = () => {
                try {
                    const psel = q('#el-quick-profile');
                    const note = q('#el-quick-profile-note');
                    if (!psel) return;
                    if (!profiles.length) {
                        psel.disabled = true;
                        if (note) note.textContent = 'No hub API profiles — agent default (hub default / ST backend) will be used.';
                    } else {
                        psel.disabled = false;
                        if (note) note.textContent = '';
                    }
                } catch (_) {}
            };
            const applyOpts = (o) => {
                try {
                    const oo = elSanitizeQuickOpts(o);
                    if (q('#el-quick-profile')) q('#el-quick-profile').value = oo.profileId || '';
                    if (q('#el-quick-msgtype')) q('#el-quick-msgtype').value = oo.messages.type;
                    if (q('#el-quick-first')) q('#el-quick-first').value = String(oo.messages.first);
                    if (q('#el-quick-last')) q('#el-quick-last').value = String(oo.messages.last);
                    if (q('#el-quick-range-start')) q('#el-quick-range-start').value = String(oo.messages.range.start);
                    if (q('#el-quick-range-end')) q('#el-quick-range-end').value = String(oo.messages.range.end);
                    if (q('#el-quick-inc-char')) q('#el-quick-inc-char').checked = oo.includeCharCard;
                    if (q('#el-quick-inc-author')) q('#el-quick-inc-author').checked = oo.includeAuthorNote;
                    if (q('#el-quick-inc-wi')) q('#el-quick-inc-wi').checked = oo.includeWorldInfo;
                    if (q('#el-quick-inc-inj')) q('#el-quick-inc-inj').checked = oo.includeInjected;
                    refreshRows();
                    refreshProfileState();
                } catch (_) {}
            };
            if (q('#el-quick-profile') && baseOpts.profileId) q('#el-quick-profile').value = baseOpts.profileId;
            if (sel) sel.addEventListener('change', () => {
                try {
                    const ag = sel.value ? byId[sel.value] : null;
                    applyOpts((ag && elGetAgentQuickDefaults(ag)) || globals);
                } catch (_) {}
            });
            if (q('#el-quick-msgtype')) q('#el-quick-msgtype').addEventListener('change', refreshRows);
            refreshRows();
            refreshProfileState();
        } catch (_) {}
        const result = await popup.show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        if (!captured.agentId) { try { toastr.warning('Select an agent.'); } catch (_) {} return; }
        elRunQuickTask(captured.agentId, captured.task, captured.opts);
    } catch (e) {
        console.error('Enhanced Lorebook: quick prompt failed', e);
        try { toastr.error('Could not open agent prompt: ' + (e?.message || e)); } catch (_) {}
    }
}

function _elOpenWandPopup() {
    try { if (window.jQuery) jQuery('#extensionsMenu').hide(); } catch (_) {}
    openElQuickPrompt('');
}

function _elOnWandKeydown(e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _elOpenWandPopup(); }
}

function addElWandButton(retries) {
    if (typeof retries !== 'number') retries = 40;
    try {
        if (document.getElementById('el-quick-wand')) return true;
        const menu = document.getElementById('extensionsMenu');
        if (!menu) {
            if (retries > 0) _elWandRetryId = setTimeout(() => addElWandButton(retries - 1), 500);
            return false;
        }
        const container = document.createElement('div');
        container.id = 'el-quick-wand';
        container.className = 'extension_container interactable';
        container.setAttribute('tabindex', '0');
        container.setAttribute('title', 'Ask a lorebook agent to do a one-shot task in the background');
        const item = document.createElement('div');
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.setAttribute('tabindex', '0');
        const icon = document.createElement('div');
        icon.className = 'fa-fw fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton';
        const label = document.createElement('span');
        label.textContent = 'Ask Lorebook Agent';
        item.appendChild(icon);
        item.appendChild(label);
        container.appendChild(item);
        menu.appendChild(container);
        _elOn(container, 'click', _elOpenWandPopup);
        _elOn(container, 'keydown', _elOnWandKeydown);
        return true;
    } catch (e) {
        console.error('Enhanced Lorebook: failed to add wand button', e);
        return false;
    }
}

let elSlashRegistered = false;
async function registerElSlash() {
    if (elSlashRegistered) return;
    try {
        const { SlashCommandParser } = await import('/scripts/slash-commands/SlashCommandParser.js');
        const { SlashCommand } = await import('/scripts/slash-commands/SlashCommand.js');
        const { SlashCommandArgument, ARGUMENT_TYPE } = await import('/scripts/slash-commands/SlashCommandArgument.js');
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'el-run',
            callback: async (args, value) => {
                try {
                    const parsed = elParseQuickSlashArgs(String(value || ''));
                    openElQuickPrompt({ task: parsed.task, opts: parsed.opts });
                } catch (_) {
                    openElQuickPrompt(String(value || ''));
                }
                return '';
            },
            helpString: 'Open the Enhanced Lorebook quick-task popup. Options: profile="Name" last=N first=N range=A-B msgs=none|all excl=1,5-9 — rest is task text. E.g. /el-run last=20 profile="My Preset" summarize the tavern scene',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({ description: 'options + task text to prefill (profile="Name" last=N first=N range=A-B msgs=none|all excl=1,5-9)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
            ],
            returns: 'empty string',
        }));
        elSlashRegistered = true;
    } catch (e) {
        console.error('Enhanced Lorebook: slash registration failed', e);
    }
}

function _elOnCharacterMessageRendered() {
    handleNewMessage();
}

function _elOnUserMessageRendered() {
    handleNewMessage();
}

function _elOnChatChanged() {
    for (const k of Object.keys(periodicCounters)) delete periodicCounters[k];
    for (const k of Object.keys(elRulesMsgCounters)) delete elRulesMsgCounters[k];
    messageCounter = 0;
    sendChatChangedToApp();
}

function _elCollectActivatedUids(data) {
    const out = { book: '', uids: [] };
    try {
        if (!data || typeof data !== 'object') return out;
        if (typeof data.book === 'string' && data.book) out.book = data.book;
        else if (typeof data.world === 'string' && data.world) out.book = data.world;
        else if (typeof data.name === 'string' && data.name) out.book = data.name;
        const cand = data.uids || data.entries || data.activated || data.ids;
        if (Array.isArray(cand)) {
            for (const e of cand) {
                const u = (e && typeof e === 'object') ? (e.uid ?? e.id) : e;
                if (u !== undefined && u !== null && String(u) !== '') out.uids.push(String(u));
            }
        } else if (cand && typeof cand === 'object') {
            for (const k of Object.keys(cand)) out.uids.push(String(k));
        }
    } catch (e) {}
    return out;
}

function _elOnWorldInfoActivated(data) {
    try {
        const hit = _elCollectActivatedUids(data);
        if (!hit.uids.length) return;
        if (appWindow && !appWindow.closed) {
            appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-worldinfo-activated', nonce: _bridgeNonce, book: hit.book, uids: hit.uids }, window.location.origin);
        }
    } catch (e) {}
}

function setupElEventSubscriptions() {
    if (_elEventsReady) return;
    try {
        const context = SillyTavern.getContext();
        _elOn(context.eventSource, context.event_types.CHARACTER_MESSAGE_RENDERED, _elOnCharacterMessageRendered);
        _elOn(context.eventSource, context.event_types.USER_MESSAGE_RENDERED, _elOnUserMessageRendered);
        _elOn(context.eventSource, context.event_types.CHAT_CHANGED, _elOnChatChanged);
        // Track A2 note: a future WORLDINFO_UPDATED subscription will live here
        // (host-side dep-index refresh). No listener is added in A2 — host
        // behavior must not change.
        // EL-REVAMP B6: in-prompt highlight. WORLD_INFO_ACTIVATED is read-only
        // here — the host forwards the activated uid set to the app window
        // through the existing postMessage bridge shape. Missing event type
        // (older ST) or a closed app window is a silent no-op.
        try {
            const et = context.event_types || {};
            if (et.WORLD_INFO_ACTIVATED) {
                _elOn(context.eventSource, et.WORLD_INFO_ACTIVATED, _elOnWorldInfoActivated);
            }
        } catch (e) { /* older host without WORLD_INFO_ACTIVATED: silent no-op */ }
        _elEventsReady = true;
    } catch (e) {
        console.error('Enhanced Lorebook: failed to subscribe to events', e);
    }
}

function setupElUnloadTeardown() {
    if (_elTeardownOnUnloadRegistered) return;
    _elTeardownOnUnloadRegistered = true;
    _elOn(window, 'beforeunload', elHostTeardown);
}

function elHostTeardown() {
    const tracked = _elHostListeners.splice(0, _elHostListeners.length);
    for (const entry of tracked) _elRemoveTrackedListener(entry);
    if (_elWandRetryId) {
        try { clearTimeout(_elWandRetryId); } catch (e) {
            console.error('Enhanced Lorebook: failed to clear wand retry', e);
        }
        _elWandRetryId = null;
    }
    try {
        if (_elLauncher.dropdown) _elLauncher.dropdown.remove();
        const orphanDropdown = document.getElementById('el-launcher-dropdown');
        if (orphanDropdown) orphanDropdown.remove();
        if (_elLauncher.scrim) _elLauncher.scrim.remove();
        document.querySelectorAll('.el-launcher-scrim').forEach(el => el.remove());
        if (_elLauncher.chevron) _elLauncher.chevron.remove();
        const wiDrawer = document.getElementById('WI-SP-button');
        const orphanChevron = wiDrawer ? wiDrawer.querySelector('.charlib-chevron-badge') : document.querySelector('.charlib-chevron-badge');
        if (orphanChevron) orphanChevron.remove();
        const styleEl = document.getElementById('enhanced-lorebook-launcher-styles');
        if (styleEl) styleEl.remove();
        const wand = document.getElementById('el-quick-wand');
        if (wand) wand.remove();
    } catch (e) {
        console.error('Enhanced Lorebook: teardown DOM removal failed', e);
    }
    _elLauncher.dropdown = null;
    _elLauncher.scrim = null;
    _elLauncher.chevron = null;
    _elLauncher.drawerToggle = null;
    _elLauncher.drawerIcon = null;
    _elLauncher.worldInfoContent = null;
    _elLauncher.isOpen = false;
    _elLauncher.bypassIntercept = false;
    _elLauncherReady = false;
    _elBridgeReady = false;
    _elEventsReady = false;
    _elTeardownOnUnloadRegistered = false;
}

window.EL_hostTeardown = elHostTeardown;

// ── Host-window apply API ───────────────────────────────────────────────
// The Review Changes feed lives in the app window, but other extensions (and
// scripts) may want to apply a pending proposal from the MAIN SillyTavern
// window. The apply algorithm is NOT re-implemented here: the host loads the
// very same shared core (lib/apply-core.js) the app window uses, so both
// windows apply proposals with identical rules, the identical staleness check
// and the identical fail-closed save guard.
//
// Public surface (main window):
//   window.EL.applyProposal(proposal, opts)   → Promise<void>
//   window.EL.hub.applyProposal(proposal, opts)
//   window.EL_hostApplyProposal(proposal, opts)
//   window.EL.ui.buildLineDiffHtml(oldStr, newStr)
//   window.EL.ready                             → Promise (core loaded)

let _elApplyCorePromise = null;

/**
 * Load the shared core into the HOST window. The app window loads the same
 * file as a classic script; here it is injected the same way SillyTavern
 * injects extension scripts (a <script> tag with a module-free classic
 * script), so both windows run byte-identical code.
 */
function elLoadApplyCore() {
    if (window.ELApplyCore) return Promise.resolve(window.ELApplyCore);
    if (_elApplyCorePromise) return _elApplyCorePromise;
    _elApplyCorePromise = new Promise((resolve, reject) => {
        try {
            const script = document.createElement('script');
            script.id = 'el-apply-core';
            script.src = `/${getExtensionUrl()}/lib/apply-core.js?v=1`;
            script.async = true;
            script.onload = () => {
                if (window.ELApplyCore) resolve(window.ELApplyCore);
                else reject(new Error('apply core did not publish ELApplyCore'));
            };
            script.onerror = () => reject(new Error('could not load lib/apply-core.js'));
            (document.head || document.body).appendChild(script);
        } catch (e) {
            reject(e);
        }
    }).catch((e) => {
        _elApplyCorePromise = null;
        console.error('Enhanced Lorebook: apply core failed to load', e);
        throw e;
    });
    return _elApplyCorePromise;
}

function elHostContext() {
    try { return SillyTavern.getContext(); } catch (e) { return null; }
}

function elHostHeaders() {
    const ctx = elHostContext();
    if (ctx && typeof ctx.getRequestHeaders === 'function') {
        try { return ctx.getRequestHeaders(); } catch (e) { /* fall through */ }
    }
    return { 'Content-Type': 'application/json' };
}

async function elHostApiFetch(method, path, body) {
    const opts = { method, headers: elHostHeaders() };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const resp = await fetch(`${EL_API_BASE}${path}`, opts);
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`API ${method} ${path}: ${resp.status}${text ? ' - ' + text.slice(0, 200) : ''}`);
    }
    return resp.json().catch(() => null);
}

// The folder mapping of the extension (app window: ELFolderUrl, host window:
// the extension settings of the current chat).
function elHostFolders(bookName) {
    try {
        const ctx = elHostContext();
        const store = ctx?.extensionSettings?.SillyTavernEnhancedLorebook;
        const folders = store?.folders?.[bookName];
        return Array.isArray(folders) ? folders : [];
    } catch (e) {
        return [];
    }
}

// Authoritative current state, read straight from the server (bypasses the
// client-side world-info cache) — the guard compares against this.
async function elHostFetchServerStateEx(bookName) {
    const ctx = elHostContext();
    if (!ctx || !bookName) return { ok: false, data: null, status: null, reason: 'no-context' };
    try {
        const resp = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: elHostHeaders(),
            body: JSON.stringify({ name: bookName }),
            cache: 'no-cache',
        });
        if (!resp.ok) return { ok: false, data: null, status: resp.status, reason: 'http-' + resp.status };
        let data;
        try {
            data = await resp.json();
        } catch (e) {
            return { ok: false, data: null, status: resp.status, reason: 'parse' };
        }
        if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
            return { ok: false, data: null, status: resp.status, reason: 'shape' };
        }
        return { ok: true, data, status: resp.status, reason: '' };
    } catch (e) {
        return { ok: false, data: null, status: null, reason: 'network' };
    }
}

async function elHostSnapshot(bookName, data) {
    try {
        await elHostApiFetch('POST', '/snapshot/create', { lorebookName: bookName, lorebookData: data, folders: elHostFolders(bookName) });
        return true;
    } catch (e) {
        console.error('Enhanced Lorebook: snapshot failed for', bookName, e);
        return false;
    }
}

async function elHostTrashEntries(bookName, removedEntries, source, note) {
    try {
        const entries = (removedEntries || []).map(([uid, entry]) => ({
            uid: String(uid),
            entry,
            folderId: '',
            folderPath: '',
            deletedAt: Date.now(),
        }));
        if (!entries.length) return true;
        await elHostApiFetch('POST', '/trash/add', { lorebookName: bookName, entries, source, note });
        return true;
    } catch (e) {
        console.error('Enhanced Lorebook: trash write failed for', bookName, e);
        return false;
    }
}

async function elHostAudit(bookName, rec) {
    try {
        await elHostApiFetch('POST', '/audit/append', { lorebookName: bookName, entry: rec });
    } catch (e) {
        console.error('Enhanced Lorebook: audit append failed for', bookName, e);
    }
}

let _elHostPluginProbe = { value: false, at: 0 };
async function elHostPluginAvailable() {
    try {
        const now = Date.now();
        if (now - _elHostPluginProbe.at < 30000) return _elHostPluginProbe.value;
        let ok = false;
        try {
            const resp = await fetch(`${EL_API_BASE}/health`, { method: 'GET', headers: elHostHeaders(), cache: 'no-cache' });
            ok = !!resp && resp.ok === true;
        } catch (e) { ok = false; }
        _elHostPluginProbe = { value: ok, at: now };
        return ok;
    } catch (e) {
        return false;
    }
}

function elHostToast(message, type) {
    try {
        const fn = (typeof toastr === 'object' && toastr && typeof toastr[type] === 'function') ? toastr[type] : null;
        if (fn) fn.call(toastr, message);
        else if (typeof toastr === 'object' && toastr && typeof toastr.warning === 'function') toastr.warning(message);
    } catch (e) { /* toasts are best-effort */ }
}

// The host window has no app-window modal, so the "these entries would be
// lost" confirmation falls back to the browser confirm dialog.
async function elHostConfirmDeletions(bookName, removedEntries) {
    const names = (removedEntries || []).map(([, entry]) => (entry && entry.comment) ? entry.comment : 'entry').slice(0, 10);
    const message = `Saving to "${bookName}" would remove ${removedEntries.length} entr${removedEntries.length === 1 ? 'y' : 'ies'}:\n${names.map(n => '• ' + n).join('\n')}\n\nSave anyway?`;
    try {
        return window.confirm(message) === true;
    } catch (e) {
        return false;
    }
}

// The fail-closed guard, wired to the host window.
function elHostGuard() {
    const core = window.ELApplyCore;
    if (!core || typeof core.createGuard !== 'function') return null;
    return core.createGuard({
        resolveSt: (st) => st || elHostContext(),
        fetchServerStateEx: (bookName) => elHostFetchServerStateEx(bookName),
        snapshot: (bookName, data) => elHostSnapshot(bookName, data),
        trashEntries: (bookName, removed, source, note) => elHostTrashEntries(bookName, removed, source, note),
        audit: (bookName, rec) => elHostAudit(bookName, rec),
        pluginAvailable: () => elHostPluginAvailable(),
        confirmDeletions: (bookName, removed) => elHostConfirmDeletions(bookName, removed),
        toast: (message, type) => elHostToast(message, type),
        saveWorldInfo: (bookName, data, st) => st.saveWorldInfo(bookName, data, true),
        logger: () => console,
        isVerbose: () => false,
    });
}

// The apply algorithm, wired to the host window.
function elHostApplyDeps() {
    return {
        resolveSt: (st) => st || elHostContext(),
        guardSave: (bookName, data, options) => {
            const guard = elHostGuard();
            if (!guard) {
                throw new Error('Refusing to write "' + bookName + '": the lorebook guard core is not loaded. Nothing was written.');
            }
            return guard.guardSave(bookName, data, options);
        },
        createBackup: async (lorebookName) => {
            const ctx = elHostContext();
            if (!ctx || typeof ctx.loadWorldInfo !== 'function') return;
            const lorebookData = await ctx.loadWorldInfo(lorebookName);
            await elHostApiFetch('POST', '/agent-backup/create', { lorebookName, lorebookData, folders: elHostFolders(lorebookName) });
        },
        fingerprint: (entry) => {
            const core = window.ELApplyCore;
            return (core && typeof core.entryFingerprint === 'function') ? core.entryFingerprint(entry) : '';
        },
        // Folder URLs are an app-window feature; the host only keeps the plain
        // folder membership in sync.
        folderOps: () => null,
        getFolders: (bookName) => elHostFolders(bookName),
        saveSettings: () => {
            const ctx = elHostContext();
            if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        },
        refreshUi: (lorebookName) => { elHostRefreshLorebookUi(lorebookName); },
        logger: () => console,
    };
}

// Refresh the native World Info editor when the touched book is open there.
async function elHostRefreshLorebookUi(lorebookName) {
    try {
        const wi = await import('/scripts/world-info.js');
        if (wi && typeof wi.reloadEditor === 'function') wi.reloadEditor(lorebookName);
    } catch (e) { /* the native editor refresh is best-effort */ }
}

function elHostCanonicalChatId() {
    try {
        const ctx = elHostContext();
        const charId = ctx?.characterId ?? 'no-char';
        const chatFile = ctx?.chatId ?? ctx?.chat?.chat_id ?? 'default';
        return charId + '_' + chatFile;
    } catch (e) {
        return 'no-char_default';
    }
}

function elHostProposalChatId(proposal) {
    if (proposal && typeof proposal._chatId === 'string' && proposal._chatId) return proposal._chatId;
    return elHostCanonicalChatId();
}

/**
 * Emit the cross-extension change event on the SillyTavern eventSource:
 *   eventSource.emit('el:proposals-changed', { chatId, count, reason })
 * reason is one of 'created' | 'accepted' | 'denied' | 'deleted' | 'loaded'.
 */
async function elEmitProposalsChanged(reason, chatId, count) {
    try {
        const ctx = elHostContext();
        const source = ctx?.eventSource;
        let core = null;
        try { core = await elLoadApplyCore(); } catch (e) { core = window.ELApplyCore || null; }
        if (core && typeof core.emitProposalsChanged === 'function') {
            return core.emitProposalsChanged(source, { chatId, count, reason });
        }
        if (source && typeof source.emit === 'function') {
            source.emit('el:proposals-changed', {
                chatId: String(chatId || ''),
                count: Math.max(0, Math.floor(Number(count) || 0)),
                reason,
            });
            return true;
        }
        return false;
    } catch (e) {
        console.error('Enhanced Lorebook: could not emit el:proposals-changed', e);
        return false;
    }
}

// Delete-on-decision, exactly like the app window's accept flow.
async function elHostDeleteDecidedProposals(proposal) {
    try {
        if (!proposal || !proposal.id) return false;
        const chatId = elHostProposalChatId(proposal);
        await elHostApiFetch('POST', '/proposals/delete', { chatId, proposalIds: [proposal.id] });
        return true;
    } catch (e) {
        console.error('Enhanced Lorebook: could not remove the decided proposal', e);
        return false;
    }
}

// Badge + popup + event, so the host and the app window stay in sync.
async function elHostAfterProposalChange(reason, proposal) {
    try {
        if (appWindow && !appWindow.closed) {
            appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-proposals-refresh', nonce: _bridgeNonce }, window.location.origin);
        }
    } catch (e) {
        console.error('Enhanced Lorebook: could not notify the app window', e);
    }
    let count = 0;
    try { count = await elRefreshQuickTaskBadge(); } catch (e) { count = 0; }
    await elEmitProposalsChanged(reason, elHostProposalChatId(proposal), count);
}

/**
 * Apply one pending proposal to its lorebook — from the MAIN window.
 * @param {object} proposal  the proposal record (contract unchanged:
 *        id / action / lorebookName / status / uid / entryData / changes /
 *        _baseFingerprint)
 * @param {object} [opts]    { st, agentName }
 */
async function elHostApplyProposal(proposal, opts) {
    const core = await elLoadApplyCore();
    if (!core || typeof core.createApplyCore !== 'function') {
        throw new Error('The Enhanced Lorebook apply core is not loaded — nothing was written.');
    }
    const apply = core.createApplyCore(elHostApplyDeps());
    await apply.applyProposal(proposal, opts);
    await elHostDeleteDecidedProposals(proposal);
    await elHostAfterProposalChange('accepted', proposal);
    return true;
}

// Public namespace for other extensions (main window).
const _elHostNamespace = window.EL = window.EL || {};
_elHostNamespace.applyProposal = elHostApplyProposal;
_elHostNamespace.hub = Object.assign(_elHostNamespace.hub || {}, { applyProposal: elHostApplyProposal });
_elHostNamespace.ui = Object.assign(_elHostNamespace.ui || {}, {
    buildLineDiffHtml: (oldStr, newStr) => {
        const core = window.ELApplyCore;
        return (core && typeof core.buildLineDiffHtml === 'function') ? core.buildLineDiffHtml(oldStr, newStr) : '';
    },
});
_elHostNamespace.guard = Object.assign(_elHostNamespace.guard || {}, {
    guardSave: (bookName, data, options) => {
        const guard = elHostGuard();
        return guard ? guard.guardSave(bookName, data, options) : Promise.resolve(false);
    },
});
_elHostNamespace.rules = Object.assign(_elHostNamespace.rules || {}, {
    onMessage: () => elRulesOnMessage(),
    flushKey: (key) => elRulesFlushKey(key),
    held: elRulesHeld,
});
_elHostNamespace.ready = elLoadApplyCore().catch(() => null);

// Flat alias for extensions that do not want to walk the namespace.
window.EL_hostApplyProposal = elHostApplyProposal;

jQuery(async () => {
    setupLauncherDropdown();
    setupPostMessageBridge();
    setupElEventSubscriptions();
    setupElUnloadTeardown();
    addElWandButton();
    registerElSlash();
    // Load the shared core eagerly so window.EL.ui.buildLineDiffHtml and
    // window.EL.applyProposal are usable right away.
    try { await _elHostNamespace.ready; } catch (e) { /* reported by elLoadApplyCore */ }
});
