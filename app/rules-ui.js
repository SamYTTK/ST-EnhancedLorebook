/**
 * EL-REVAMP B5: user-built systems, per-entry rows.
 *
 * Main-surface panel for the rules sidepanel mockup (entry picker, system
 * card, applies-to switches, malleable condition -> value rows, "Check now"
 * manual button, activity log). Rule evaluation itself lives in
 * lib/rules.js (ELRules) so the host and this window share it; entry writes
 * here go through ELG_guardSave (source:'rules'), and a blocked write is
 * queued app-side-persisted (extensionSettings.rulePending) and retried on
 * the next render / flush — the same pattern as the map queue.
 *
 * Held-edit protection: opening the entry edit modal posts 'el-rules-held'
 * to the host (same bridge envelope as every EL_postToHost message), so the
 * host queues instead of writing while the user is inside the entry; the
 * modal's _elOnClose hook posts the release, and the queued write then
 * applies on top of the saved state. No polling timers anywhere in this
 * file: the release hook and render-time flushes are event-driven.
 *
 * Depends on (resolved at call time, never at load): stContext,
 * extensionSettings, saveSettings, currentLorebookName, currentLorebookData,
 * EL_setLorebookData, EL_getEntryType, ELG_loadFresh, ELG_guardSave,
 * EL_postToHost, renderEntries, escapeHtml, openEditEntryModal, ELRules.
 */
var EL_rulesActivity = [];
var EL_rulesSelSystem = null;
var EL_rulesSelKey = null;
var EL_rulesWrapInstalled = false;
var EL_rulesFlushRunning = false;
var EL_rulesFlushPromiseApp = null;
var EL_rulesHeldKeyApp = null;
var EL_rulesLastLandedApp = 0;
var EL_RULES_MAX_LOG = 20;
var EL_RULES_MAX_WRITES_PER_RUN = 10;

function EL_rulesStoreApp() {
    try {
        if (typeof extensionSettings !== 'object' || !extensionSettings) return null;
        if (!Array.isArray(extensionSettings.systems)) extensionSettings.systems = [];
        var hasSystem = extensionSettings.systems.some(function (s) {
            return s && typeof s === 'object' && typeof s.id === 'string' && s.id;
        });
        var seeded = false;
        if (!hasSystem) {
            extensionSettings.systems.unshift({ id: 'schedule', name: 'Schedule system', check: 'message', n: 2, target: 'Current_Location' });
            seeded = true;
        }
        if (!extensionSettings.rules || typeof extensionSettings.rules !== 'object' || Array.isArray(extensionSettings.rules)) {
            extensionSettings.rules = {};
            seeded = true;
        }
        if (!extensionSettings.rulePending || typeof extensionSettings.rulePending !== 'object' || Array.isArray(extensionSettings.rulePending)) {
            extensionSettings.rulePending = {};
            seeded = true;
        }
        if (seeded) { try { saveSettings(); } catch (e) {} }
        return extensionSettings;
    } catch (e) { return null; }
}

function EL_rulesSystems() {
    try {
        var store = EL_rulesStoreApp();
        if (!store) return [];
        return store.systems.filter(function (s) {
            return s && typeof s === 'object' && typeof s.id === 'string' && s.id;
        });
    } catch (e) { return []; }
}

function EL_rulesFindSystem(id) {
    try {
        var list = EL_rulesSystems();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(id)) return list[i];
        }
    } catch (e) {}
    return null;
}

function EL_rulesEntryIds() {
    try {
        var data = (typeof currentLorebookData !== 'undefined') ? currentLorebookData : null;
        var entries = (data && data.entries && typeof data.entries === 'object') ? data.entries : {};
        return Object.keys(entries);
    } catch (e) { return []; }
}

function EL_rulesEntryLabel(uid) {
    try {
        if (typeof EL_mapEntryLabel === 'function') {
            var data = (typeof currentLorebookData !== 'undefined') ? currentLorebookData : null;
            var entry = data && data.entries ? data.entries[uid] : null;
            if (entry) return EL_mapEntryLabel(uid, entry);
        }
    } catch (e) {}
    try {
        var d2 = (typeof currentLorebookData !== 'undefined') ? currentLorebookData : null;
        var e2 = d2 && d2.entries ? d2.entries[uid] : null;
        if (e2 && e2.comment) return String(e2.comment);
    } catch (e) {}
    return String(uid);
}

function EL_rulesEsc(s) {
    try {
        if (typeof escapeHtml === 'function') return escapeHtml(s);
    } catch (e) {}
    return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function EL_rulesLogPush(text) {
    try {
        var now = new Date();
        var pad = function (n) { return String(n).padStart(2, '0'); };
        EL_rulesActivity.unshift(pad(now.getHours()) + ':' + pad(now.getMinutes()) + ' ' + String(text || ''));
        while (EL_rulesActivity.length > EL_RULES_MAX_LOG) EL_rulesActivity.pop();
    } catch (e) {}
}

function EL_rulesToast(msg, kind) {
    try {
        if (typeof EL_toast === 'function') EL_toast(msg, kind || 'info');
    } catch (e) {}
}

function EL_rulesPostHeld(uid, held) {
    try {
        if (typeof EL_postToHost !== 'function') return;
        var book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : null;
        if (!book || !uid) return;
        EL_postToHost({ type: 'el-rules-held', book: String(book), uid: String(uid), held: held === true });
    } catch (e) {}
}

// Wrap the entry edit modal once: report held-start on open; on every close
// path (save, backdrop, Escape — all funnel through EL_modalClose, which runs
// modal._elOnClose) report held-release and flush this window's queue for the
// key on top of the saved state. Event-driven, no timers.
function EL_rulesWatchEditing() {
    if (EL_rulesWrapInstalled) return;
    EL_rulesWrapInstalled = true;
    try {
        if (typeof window === 'undefined' || typeof window.openEditEntryModal !== 'function') return;
        if (window.openEditEntryModal._elRulesWrapped) return;
        var orig = window.openEditEntryModal;
        var wrapped = function (uid) {
            var key = String(uid === null || uid === undefined ? '' : uid);
            try { EL_rulesPostHeld(key, true); } catch (e) {}
            try {
                var _book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : '';
                EL_rulesHeldKeyApp = _book ? (String(_book) + '|' + key) : null;
            } catch (e) { EL_rulesHeldKeyApp = null; }
            try {
                var modal = document.getElementById('edit-entry-modal');
                if (modal) {
                    modal._elOnClose = function () {
                        try { EL_rulesPostHeld(key, false); } catch (e) {}
                        try { EL_rulesHeldKeyApp = null; } catch (e) {}
                        try {
                            if (typeof EL_rulesFlushPendingApp === 'function') EL_rulesFlushPendingApp();
                        } catch (e) {}
                    };
                }
            } catch (e) {}
            return orig.apply(this, arguments);
        };
        wrapped._elRulesWrapped = true;
        window.openEditEntryModal = wrapped;
        try { openEditEntryModal = wrapped; } catch (e) {}
    } catch (e) {}
}

function EL_rulesBuildCtxApp(entry, uid) {
    var now = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var ELR = (typeof ELRules !== 'undefined') ? ELRules : ((typeof window !== 'undefined' && window.ELRules) || null);
    var fieldValues = {};
    try {
        if (ELR && typeof ELR.parseFieldLines === 'function') {
            fieldValues = ELR.parseFieldLines((entry && entry.content) || '');
        }
    } catch (e) { fieldValues = {}; }
    var mapPlaced = false;
    try {
        if (typeof extensionSettings === 'object' && extensionSettings) {
            var book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : '';
            var maps = extensionSettings.maps;
            var pins = maps && maps[book] && maps[book].pins;
            mapPlaced = !!(pins && typeof pins === 'object' && Object.prototype.hasOwnProperty.call(pins, String(uid)));
        }
    } catch (e) { mapPlaced = false; }
    var relations = [];
    try {
        if (typeof extensionSettings === 'object' && extensionSettings && Array.isArray(extensionSettings.relations)) {
            relations = extensionSettings.relations;
        }
    } catch (e) { relations = []; }
    return {
        time: pad(now.getHours()) + ':' + pad(now.getMinutes()),
        dow: now.getDay(),
        fieldValues: fieldValues,
        mapPlaced: mapPlaced,
        relations: relations,
    };
}

function EL_rulesTypeForApp(entry) {
    try {
        var tid = entry && entry.extensions && entry.extensions.el && entry.extensions.el.type;
        if (!tid || typeof tid !== 'string') return null;
        if (typeof EL_getEntryType === 'function') return EL_getEntryType(tid);
    } catch (e) {}
    return null;
}

function EL_rulesQueueApp(key, writes) {
    try {
        var store = EL_rulesStoreApp();
        if (!store) return;
        var list = (writes || [])
            .map(function (w) { return { target: String((w && w.target) || '').trim(), value: w ? String(w.value === null || w.value === undefined ? '' : w.value) : '' }; })
            .filter(function (w) { return !!w.target; });
        if (!list.length) return;
        var cur = Array.isArray(store.rulePending[key]) ? store.rulePending[key].filter(function (q) { return q && typeof q === 'object'; }) : [];
        for (var i = 0; i < list.length; i++) {
            var rec = { target: list[i].target, value: list[i].value, at: Date.now() };
            var at = -1;
            for (var j = 0; j < cur.length; j++) {
                if (cur[j] && cur[j].target === rec.target) { at = j; break; }
            }
            if (at !== -1) cur[at] = rec;
            else cur.push(rec);
        }
        store.rulePending[key] = cur;
        try { saveSettings(); } catch (e) {}
    } catch (e) {}
}

// Evaluate + write one key through the guard. Returns 'landed' | 'blocked' |
// 'skipped'. Held keys are queued without attempting the write.
async function EL_rulesApplyKeyApp(key, opts) {
    var quiet = !!(opts && opts.quiet);
    var maxW = (opts && opts.maxWrites !== undefined && opts.maxWrites !== null)
        ? Math.max(0, Math.floor(Number(opts.maxWrites)))
        : EL_RULES_MAX_WRITES_PER_RUN;
    EL_rulesLastLandedApp = 0;
    var say = function (msg, kind) { if (!quiet) EL_rulesToast(msg, kind); };
    if (maxW <= 0) return 'skipped';
    try {
        var ELR = (typeof ELRules !== 'undefined') ? ELRules : ((typeof window !== 'undefined' && window.ELRules) || null);
        if (!ELR) return 'skipped';
        var store = EL_rulesStoreApp();
        if (!store) return 'skipped';
        var book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : '';
        var parsed = ELR.parseRuleKey(key);
        if (!book || parsed.book !== String(book)) return 'skipped';
        var uid = parsed.uid;
        if (!uid) return 'skipped';
        var rec = ELR.sanitizeEntryRules(store.rules[key]);
        var sys = EL_rulesFindSystem(rec.systemId);
        var target = (sys && typeof sys.target === 'string' && sys.target.trim()) ? sys.target.trim() : 'Current_Location';
        var fresh = (typeof ELG_loadFresh === 'function') ? await ELG_loadFresh(book) : null;
        if (!fresh || !fresh.entries || !fresh.entries[String(uid)]) return 'skipped';
        var entry = fresh.entries[String(uid)];
        var rctx = EL_rulesBuildCtxApp(entry, uid);
        var resolved = ELR.resolveSystem(rec, rctx, target);
        if (!resolved || !resolved.writes || !resolved.writes.length) return 'skipped';
        var wb = resolved.writes.slice(0, maxW);
        if (!wb.length) return 'skipped';
        if (EL_rulesHeldKeyApp && String(key) === String(EL_rulesHeldKeyApp)) {
            EL_rulesQueueApp(key, wb);
            if (!quiet) EL_rulesLogPush(String(uid).slice(0, 8) + ' blocked (edit held) — queued');
            return 'blocked';
        }
        var next = entry.content;
        for (var i = 0; i < wb.length; i++) {
            var w = wb[i];
            var out = null;
            try { out = ELR.computeFieldContent({ content: next }, EL_rulesTypeForApp(entry), w.target, w.value); } catch (e) { out = null; }
            if (out === null || typeof out !== 'string') {
                EL_rulesQueueApp(key, wb);
                if (!quiet) EL_rulesLogPush(String(uid).slice(0, 8) + ' blocked (edit held) — queued');
                return 'blocked';
            }
            if (out !== next) next = out;
        }
        if (next === entry.content) {
            try { delete store.rulePending[key]; } catch (e) {}
            EL_rulesLastLandedApp = wb.length;
            return 'landed';
        }
        entry.content = next;
        var ok = (typeof ELG_guardSave === 'function')
            ? await ELG_guardSave(book, fresh, { explicitDelete: false, source: 'rules', note: 'Rules write (manual)' })
            : false;
        if (ok) {
            try { delete store.rulePending[key]; } catch (e) {}
            try { if (typeof EL_setLorebookData === 'function') EL_setLorebookData(fresh, { own: true }); } catch (e) {}
            try { if (typeof renderEntries === 'function') renderEntries(); } catch (e) {}
            try { saveSettings(); } catch (e) {}
            EL_rulesLastLandedApp = wb.length;
            if (!quiet) EL_rulesLogPush(EL_rulesEntryLabel(uid) + ' → ' + String(wb[0].value).slice(0, 60));
            return 'landed';
        }
        EL_rulesQueueApp(key, wb);
        if (!quiet) EL_rulesLogPush(EL_rulesEntryLabel(uid) + ' blocked — queued, retry on next render');
        say('Rules write was blocked (entry changed underneath) — queued.', 'error');
        return 'blocked';
    } catch (e) { return 'blocked'; }
}

// Render-time retry of this window's queue for the open book. Called from
// EL_rulesRender and from the edit-modal release hook — never timers.
// Accepts an optional field-write budget (default: per-run max) and returns
// the number of field-writes landed, so Check-now can spend what is left.
async function EL_rulesFlushPendingApp(budget) {
    try {
        if (EL_rulesFlushRunning) return 0;
        var store = EL_rulesStoreApp();
        if (!store) return 0;
        var book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : '';
        if (!book) return 0;
        var cap = (budget === undefined || budget === null)
            ? EL_RULES_MAX_WRITES_PER_RUN
            : Math.max(0, Math.floor(Number(budget)));
        if (cap <= 0) return 0;
        var keys = Object.keys(store.rulePending || {}).filter(function (k) {
            try {
                var ELR = (typeof ELRules !== 'undefined') ? ELRules : window.ELRules;
                return ELR && ELR.parseRuleKey(k).book === String(book);
            } catch (e) { return false; }
        });
        if (!keys.length) return 0;
        EL_rulesFlushRunning = true;
        var _resolveFlush = null;
        EL_rulesFlushPromiseApp = new Promise(function (res) { _resolveFlush = res; });
        var landedTotal = 0;
        try {
            for (var i = 0; i < keys.length && landedTotal < cap; i++) {
                try {
                    EL_rulesLastLandedApp = 0;
                    await EL_rulesApplyKeyApp(keys[i], { quiet: true, maxWrites: cap - landedTotal });
                    landedTotal += Math.max(0, Number(EL_rulesLastLandedApp) || 0);
                } catch (e) {}
            }
        } finally {
            EL_rulesFlushRunning = false;
            try { if (typeof _resolveFlush === 'function') _resolveFlush(); } catch (e) {}
            EL_rulesFlushPromiseApp = null;
        }
        return landedTotal;
    } catch (e) { return 0; }
}

// "Check now": run the selected system over every enabled entry of the open
// book (manual systems included — this is their trigger), bounded at 10.
async function EL_rulesCheckNow() {
    try {
        var store = EL_rulesStoreApp();
        if (!store) return;
        var book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : '';
        if (!book) { EL_rulesToast('Open a lorebook first.', 'warning'); return; }
        var sys = EL_rulesFindSystem(EL_rulesSelSystem) || EL_rulesSystems()[0] || null;
        if (!sys) { EL_rulesToast('No rules system yet.', 'warning'); return; }
        var ELR = (typeof ELRules !== 'undefined') ? ELRules : ((typeof window !== 'undefined' && window.ELRules) || null);
        if (!ELR) return;
        var keys = Object.keys(store.rules || {}).filter(function (k) {
            try {
                if (ELR.parseRuleKey(k).book !== String(book)) return false;
                var r = ELR.sanitizeEntryRules(store.rules[k]);
                return r && r.enabled && String(r.systemId) === String(sys.id) && r.rows.length;
            } catch (e) { return false; }
        });
        if (!keys.length) { EL_rulesToast('No enabled entries for this system in this book.', 'info'); return; }
        try { if (EL_rulesFlushPromiseApp) await EL_rulesFlushPromiseApp; } catch (e) {}
        var flushed = 0;
        try { flushed = await EL_rulesFlushPendingApp(EL_RULES_MAX_WRITES_PER_RUN) || 0; } catch (e) { flushed = 0; }
        var remaining = Math.max(0, EL_RULES_MAX_WRITES_PER_RUN - Math.max(0, Number(flushed) || 0));
        var done = 0;
        var doneWrites = 0;
        var blocked = 0;
        for (var i = 0; i < keys.length && doneWrites < remaining; i++) {
            var res = 'skipped';
            try {
                EL_rulesLastLandedApp = 0;
                res = await EL_rulesApplyKeyApp(keys[i], { quiet: true, maxWrites: remaining - doneWrites });
                doneWrites += Math.max(0, Number(EL_rulesLastLandedApp) || 0);
            } catch (e) { res = 'blocked'; }
            if (res === 'landed') done += 1;
            else if (res === 'blocked') blocked += 1;
        }
        EL_rulesLogPush('check now: ' + done + ' wrote, ' + blocked + ' blocked (' + String(sys.name || sys.id) + ')');
        EL_rulesToast('Check now: ' + done + ' wrote, ' + blocked + ' blocked.', done ? 'success' : 'info');
        EL_rulesRender();
    } catch (e) { EL_rulesToast('Check now failed.', 'error'); }
}

// Host → app refresh (same bridge envelope as 'el-proposals-refresh'): log the
// outcome and re-render when the panel is visible.
function EL_rulesOnHostRefresh(msg) {
    try {
        var key = (msg && typeof msg.key === 'string') ? msg.key : '';
        var ok = !!(msg && msg.ok);
        var held = !!(msg && msg.held);
        var text = key
            ? (key.split('|')[1] || key).slice(0, 8) + (ok ? ' → wrote' + (msg && msg.retried ? ' (retry)' : '') : (held ? ' held — queued' : ' blocked — queued'))
            : (ok ? 'rules wrote' : 'rules blocked — queued');
        EL_rulesLogPush(text);
        var panel = null;
        try { panel = document.getElementById('rules-panel'); } catch (e) {}
        if (panel && !panel.classList.contains('hidden')) {
            try { EL_rulesFlushPendingApp(); } catch (e) {}
            EL_rulesRender();
        }
        if (!ok && !held) { try { EL_rulesToast('A rules write was blocked — queued for retry.', 'error'); } catch (e) {} }
    } catch (e) {}
}

function EL_rulesCheckLabel(check) {
    if (check === 'every-n') return 'every-n';
    if (check === 'manual') return 'manual';
    return 'message';
}

function EL_rulesDowName(dow) {
    var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var n = Number(dow);
    if (n >= 0 && n <= 6) return names[n];
    return String(dow);
}

function EL_rulesRowHint(src, op) {
    if (op === 'empty') return 'empty left side wins';
    if (src === 'time') return 'HH:MM, e.g. 09:00';
    if (src === 'dow') return '0–6 (0=Sun)';
    if (src === 'field') return 'sibling label → value';
    if (src === 'map') return '= true when pinned';
    if (src === 'relation') return 'kind, e.g. ally';
    return '';
}

function EL_rulesRender() {
    try { EL_rulesWatchEditing(); } catch (e) {}
    var panel = null;
    try { panel = document.getElementById('rules-panel'); } catch (e) {}
    if (!panel) return;
    try {
        var ELR = (typeof ELRules !== 'undefined') ? ELRules : ((typeof window !== 'undefined' && window.ELRules) || null);
        var store = EL_rulesStoreApp();
        var book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : '';
        if (!ELR || !store) {
            panel.innerHTML = '<div class="el-rules-empty">Rules engine unavailable.</div>';
            return;
        }
        if (!book) {
            panel.innerHTML = '<div class="el-rules-empty">Open a lorebook to edit its rules.</div>';
            return;
        }
        var systems = EL_rulesSystems();
        if (!EL_rulesFindSystem(EL_rulesSelSystem)) EL_rulesSelSystem = systems.length ? systems[0].id : null;
        var sys = EL_rulesFindSystem(EL_rulesSelSystem);
        var entryIds = EL_rulesEntryIds();
        var selKey = null;
        for (var e = 0; e < entryIds.length; e++) {
            var k = ELR.ruleKey(book, entryIds[e]);
            if (store.rules[k] && ELR.sanitizeEntryRules(store.rules[k]).systemId === (sys ? String(sys.id) : '')) { selKey = selKey || k; }
            if (k === EL_rulesSelKey) selKey = k;
        }
        if (!selKey && entryIds.length) selKey = ELR.ruleKey(book, entryIds[0]);
        EL_rulesSelKey = selKey;

        var html = '';
        html += '<div class="el-rules-bar">';
        html += '<div class="el-rules-title"><i class="fa-solid fa-hourglass-half"></i> Rules' + (sys ? ' — ' + EL_rulesEsc(sys.name || sys.id) : '') + '</div>';
        html += '<button class="btn btn-secondary btn-sm" id="el-rules-checknow" title="Evaluate this system now for every enabled entry of this book"><i class="fa-solid fa-play"></i> Check now</button>';
        html += '</div>';

        html += '<div class="el-rules-pickrow">';
        html += '<select id="el-rules-entrypick" title="Entry">';
        for (var p = 0; p < entryIds.length; p++) {
            var pk = ELR.ruleKey(book, entryIds[p]);
            html += '<option value="' + EL_rulesEsc(pk) + '"' + (pk === selKey ? ' selected' : '') + '>' + EL_rulesEsc(EL_rulesEntryLabel(entryIds[p])) + '</option>';
        }
        html += '</select>';
        html += '<select id="el-rules-syspick" title="System">';
        for (var s = 0; s < systems.length; s++) {
            html += '<option value="' + EL_rulesEsc(String(systems[s].id)) + '"' + (sys && String(systems[s].id) === String(sys.id) ? ' selected' : '') + '>' + EL_rulesEsc(String(systems[s].name || systems[s].id)) + '</option>';
        }
        html += '</select>';
        html += '<button class="btn btn-secondary btn-sm" id="el-rules-sysadd" title="New system">＋</button>';
        html += '</div>';

        if (sys) {
            var check = EL_rulesCheckLabel(sys.check);
            html += '<div class="el-rules-sys">';
            html += '<div class="el-rules-syshead"><span class="el-rules-sysname">' + EL_rulesEsc(sys.name || sys.id) + '</span>';
            html += '<button class="btn btn-secondary btn-sm" id="el-rules-sysdel" title="Delete system">Delete</button></div>';
            html += '<div class="el-rules-sysdesc">Clock + on-message triggers · no chaining · per-entry rows below</div>';
            html += '<label class="el-rules-lab">Name <input id="el-rules-sysname" value="' + EL_rulesEsc(sys.name || '') + '" maxlength="80"></label>';
            html += '<label class="el-rules-lab">Writes to field (label) <input id="el-rules-systarget" value="' + EL_rulesEsc(sys.target || 'Current_Location') + '" maxlength="80" placeholder="Current_Location"></label>';
            html += '<label class="el-rules-lab">Check <select id="el-rules-syscheck">'
                + '<option value="message"' + (check === 'message' ? ' selected' : '') + '>Check: clock + on message-received</option>'
                + '<option value="every-n"' + (check === 'every-n' ? ' selected' : '') + '>Check: every N replies</option>'
                + '<option value="manual"' + (check === 'manual' ? ' selected' : '') + '>Check: manual only</option>'
                + '</select></label>';
            if (check === 'every-n') {
                html += '<label class="el-rules-lab">Every N replies <input id="el-rules-sysn" type="number" min="1" max="1000" value="' + EL_rulesEsc(String(Math.max(1, Number(sys.n) || 2))) + '"></label>';
            }
            html += '<div class="el-rules-appliesto">Applies to — system is global, enabled per entry:</div>';
            html += '<div class="el-rules-applies" id="el-rules-applies">';
            for (var a = 0; a < entryIds.length; a++) {
                var ak = ELR.ruleKey(book, entryIds[a]);
                var arec = ELR.sanitizeEntryRules(store.rules[ak]);
                var on = !!(store.rules[ak] && arec.systemId === String(sys.id));
                html += '<div class="el-rules-applyrow"><span>' + EL_rulesEsc(EL_rulesEntryLabel(entryIds[a])) + '</span>'
                    + '<button class="el-rules-sw" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" data-apply="' + EL_rulesEsc(ak) + '" title="Enable this entry for the system"></button></div>';
            }
            html += '</div>';
            html += '</div>';
        }

        var rec = selKey ? ELR.sanitizeEntryRules(store.rules[selKey]) : null;
        var hasRec = !!(selKey && store.rules[selKey] && rec && rec.systemId === (sys ? String(sys.id) : ''));
        html += '<div class="el-rules-rows" id="el-rules-rows">';
        if (!sys) {
            html += '<div class="el-rules-empty">Create a system to start adding rows.</div>';
        } else if (!hasRec) {
            html += '<div class="el-rules-empty">This entry is not in the system — flip its Applies-to switch above to add rows.</div>';
        } else {
            html += '<div class="el-rules-rowshead"><span>Rows for ' + EL_rulesEsc(EL_rulesEntryLabel(ELR.parseRuleKey(selKey).uid)) + '</span>'
                + '<button class="el-rules-sw" role="switch" aria-checked="' + (rec.enabled ? 'true' : 'false') + '" id="el-rules-recenabled" title="Enabled for this entry"></button></div>';
            for (var r = 0; r < rec.rows.length; r++) {
                html += EL_rulesRowHtml(rec.rows[r], r, sys);
            }
            html += '<div class="el-rules-addrow"><button class="el-rules-tbtn" id="el-rules-addrow">＋ Add condition → value</button></div>';
        }
        html += '</div>';

        html += '<div class="el-rules-note">Held-edit protection: if you are inside the entry when a rule fires, the update waits until you exit, then applies on top of your saved state. A tracker re-resolves blocked writes and backup loads — nothing goes stale silently.</div>';
        html += '<div class="el-rules-log">recent<br>' + EL_rulesActivity.map(function (l) { return EL_rulesEsc(l); }).join('<br>') + '</div>';
        panel.innerHTML = html;
        EL_rulesWire(sys, selKey);
        try { EL_rulesFlushPendingApp(); } catch (e) {}
    } catch (e) {
        try { panel.innerHTML = '<div class="el-rules-empty">Rules panel failed to render.</div>'; } catch (e2) {}
    }
}

function EL_rulesRowHtml(row, idx, sys) {
    var kind = row.kind || 'if';
    var isIf = kind === 'if';
    var sysTarget = (sys && sys.target) || 'Current_Location';
    var html = '<div class="el-rules-rrow" data-row="' + idx + '">';
    html += '<select class="el-rules-kind" data-f="kind" title="Row kind">'
        + '<option value="if"' + (kind === 'if' ? ' selected' : '') + '>if</option>'
        + '<option value="otherwise"' + (kind === 'otherwise' ? ' selected' : '') + '>otherwise</option>'
        + '<option value="while"' + (kind === 'while' ? ' selected' : '') + '>while</option>'
        + '</select>';
    if (isIf) {
        var op = row.op || '=';
        var ops = ['=', '!=', 'contains', '<', '>', 'empty'];
        html += '<select class="el-rules-op" data-f="op" title="Operator">';
        for (var i = 0; i < ops.length; i++) {
            html += '<option value="' + ops[i] + '"' + (op === ops[i] ? ' selected' : '') + '>' + ops[i] + '</option>';
        }
        html += '</select>';
        var src = (row.left && row.left.src) || 'time';
        html += '<select class="el-rules-src" data-f="src" title="Left operand source">'
            + '<option value="time"' + (src === 'time' ? ' selected' : '') + '>time</option>'
            + '<option value="dow"' + (src === 'dow' ? ' selected' : '') + '>day-of-week</option>'
            + '<option value="field"' + (src === 'field' ? ' selected' : '') + '>field value</option>'
            + '<option value="map"' + (src === 'map' ? ' selected' : '') + '>map-placed</option>'
            + '<option value="relation"' + (src === 'relation' ? ' selected' : '') + '>relation</option>'
            + '</select>';
        if (src === 'field' || src === 'relation') {
            html += '<input class="el-rules-ref" data-f="ref" value="' + EL_rulesEsc((row.left && row.left.ref) || '') + '" placeholder="' + (src === 'field' ? 'field label' : 'relation kind') + '" title="Right operand source detail">';
        }
        if (op !== 'empty') {
            html += '<input class="el-rules-right" data-f="right" value="' + EL_rulesEsc(row.right || '') + '" placeholder="' + EL_rulesEsc(EL_rulesRowHint(src, op)) + '" title="Right operand">';
        }
    } else {
        html += '<span class="el-rules-else" title="' + (kind === 'otherwise' ? 'else-branch: when no if matched' : 'constant value: always applies') + '">' + (kind === 'otherwise' ? 'else' : 'always') + '</span>';
    }
    html += '<input class="el-rules-target" data-f="target" value="' + EL_rulesEsc(row.target || '') + '" placeholder="' + EL_rulesEsc(sysTarget) + '" title="Target field label (blank = system target)">';
    html += '<span class="el-rules-arr">→</span>';
    html += '<input class="el-rules-value" data-f="value" value="' + EL_rulesEsc(row.value || '') + '" placeholder="value to write" title="Value to write">';
    html += '<button class="el-rules-x" data-del="' + idx + '" title="Delete row">×</button>';
    html += '</div>';
    return html;
}

function EL_rulesPersistRow(selKey, idx, field, value) {
    try {
        var ELR = (typeof ELRules !== 'undefined') ? ELRules : window.ELRules;
        var store = EL_rulesStoreApp();
        if (!ELR || !store || !store.rules[selKey]) return false;
        var rec = ELR.sanitizeEntryRules(store.rules[selKey]);
        if (!rec.rows[idx]) return false;
        var row = rec.rows[idx];
        if (field === 'kind') {
            row.kind = (value === 'otherwise' || value === 'while') ? value : 'if';
            if (row.kind !== 'if' && !EL_rulesFindSystem(rec.systemId)) { /* orphan systems still resolve with defaults */ }
        } else if (field === 'op') {
            row.op = (['=', '!=', 'contains', '<', '>', 'empty'].indexOf(value) !== -1) ? value : '=';
        } else if (field === 'src') {
            if (!row.left) row.left = { src: 'time', ref: '' };
            row.left.src = (['time', 'dow', 'field', 'map', 'relation'].indexOf(value) !== -1) ? value : 'time';
        } else if (field === 'ref') {
            if (!row.left) row.left = { src: 'time', ref: '' };
            row.left.ref = String(value || '');
        } else if (field === 'right') {
            row.right = String(value || '');
        } else if (field === 'target') {
            row.target = String(value || '').trim();
        } else if (field === 'value') {
            row.value = String(value || '');
        } else {
            return false;
        }
        store.rules[selKey] = { systemId: rec.systemId, enabled: rec.enabled, rows: rec.rows };
        try { saveSettings(); } catch (e) {}
        return true;
    } catch (e) { return false; }
}

function EL_rulesWire(sys, selKey) {
    var panel = null;
    try { panel = document.getElementById('rules-panel'); } catch (e) { return; }
    if (!panel) return;
    var q = function (sel) { try { return panel.querySelector(sel); } catch (e) { return null; } };
    var qa = function (sel) { try { return Array.prototype.slice.call(panel.querySelectorAll(sel)); } catch (e) { return []; } };

    var entryPick = q('#el-rules-entrypick');
    if (entryPick) entryPick.addEventListener('change', function () {
        EL_rulesSelKey = entryPick.value || null;
        EL_rulesRender();
    });
    var sysPick = q('#el-rules-syspick');
    if (sysPick) sysPick.addEventListener('change', function () {
        EL_rulesSelSystem = sysPick.value || null;
        EL_rulesSelKey = null;
        EL_rulesRender();
    });
    var sysAdd = q('#el-rules-sysadd');
    if (sysAdd) sysAdd.addEventListener('click', function () {
        try {
            var store = EL_rulesStoreApp();
            if (!store) return;
            var n = store.systems.length + 1;
            var id = 'system-' + Date.now().toString(36);
            store.systems.push({ id: id, name: 'System ' + n, check: 'manual', n: 2, target: 'Current_Location' });
            try { saveSettings(); } catch (e) {}
            EL_rulesSelSystem = id;
            EL_rulesSelKey = null;
            EL_rulesLogPush('system created: System ' + n);
            EL_rulesRender();
        } catch (e) {}
    });
    var sysDel = q('#el-rules-sysdel');
    if (sysDel && sys) sysDel.addEventListener('click', function () {
        try {
            var store = EL_rulesStoreApp();
            if (!store) return;
            store.systems = store.systems.filter(function (s) { return String(s.id) !== String(sys.id); });
            try { saveSettings(); } catch (e) {}
            EL_rulesSelSystem = null;
            EL_rulesSelKey = null;
            EL_rulesLogPush('system deleted: ' + String(sys.name || sys.id));
            EL_rulesRender();
        } catch (e) {}
    });
    var sysName = q('#el-rules-sysname');
    if (sysName && sys) sysName.addEventListener('change', function () {
        sys.name = String(sysName.value || '').slice(0, 80) || sys.id;
        try { saveSettings(); } catch (e) {}
        EL_rulesRender();
    });
    var sysTarget = q('#el-rules-systarget');
    if (sysTarget && sys) sysTarget.addEventListener('change', function () {
        sys.target = String(sysTarget.value || '').trim() || 'Current_Location';
        try { saveSettings(); } catch (e) {}
        EL_rulesRender();
    });
    var sysCheck = q('#el-rules-syscheck');
    if (sysCheck && sys) sysCheck.addEventListener('change', function () {
        var v = sysCheck.value;
        sys.check = (v === 'every-n' || v === 'manual') ? v : 'message';
        try { saveSettings(); } catch (e) {}
        EL_rulesRender();
    });
    var sysN = q('#el-rules-sysn');
    if (sysN && sys) sysN.addEventListener('change', function () {
        var n = Math.max(1, Math.min(1000, Number(sysN.value) || 2));
        sys.n = n;
        try { saveSettings(); } catch (e) {}
        EL_rulesRender();
    });
    var checkNow = q('#el-rules-checknow');
    if (checkNow) checkNow.addEventListener('click', function () {
        try { EL_rulesCheckNow(); } catch (e) {}
    });

    qa('[data-apply]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            try {
                var ELR = (typeof ELRules !== 'undefined') ? ELRules : window.ELRules;
                var store = EL_rulesStoreApp();
                if (!ELR || !store || !sys) return;
                var key = btn.getAttribute('data-apply');
                var isOn = btn.getAttribute('aria-checked') === 'true';
                if (isOn) {
                    delete store.rules[key];
                    if (EL_rulesSelKey === key) EL_rulesSelKey = null;
                    EL_rulesLogPush('applies-to off: ' + key.split('|')[1].slice(0, 8));
                } else {
                    store.rules[key] = { systemId: String(sys.id), enabled: true, rows: [{ kind: 'if', op: '=', left: { src: 'time', ref: '' }, right: '', target: '', value: '' }] };
                    EL_rulesSelKey = key;
                    EL_rulesLogPush('applies-to on: ' + key.split('|')[1].slice(0, 8));
                }
                try { saveSettings(); } catch (e) {}
                EL_rulesRender();
            } catch (e) {}
        });
    });

    var recEnabled = q('#el-rules-recenabled');
    if (recEnabled && selKey) recEnabled.addEventListener('click', function () {
        try {
            var ELR = (typeof ELRules !== 'undefined') ? ELRules : window.ELRules;
            var store = EL_rulesStoreApp();
            if (!ELR || !store || !store.rules[selKey]) return;
            var rec = ELR.sanitizeEntryRules(store.rules[selKey]);
            rec.enabled = !(rec.enabled !== false);
            store.rules[selKey] = rec;
            try { saveSettings(); } catch (e) {}
            EL_rulesRender();
        } catch (e) {}
    });

    qa('#el-rules-rows .el-rules-rrow').forEach(function (rowEl) {
        var idx = Number(rowEl.getAttribute('data-row'));
        rowEl.querySelectorAll('select[data-f], input[data-f]').forEach(function (input) {
            var field = input.getAttribute('data-f');
            input.addEventListener('change', function () {
                if (EL_rulesPersistRow(selKey, idx, field, input.value)) {
                    if (field === 'kind' || field === 'op' || field === 'src') EL_rulesRender();
                }
            });
        });
        var del = rowEl.querySelector('[data-del]');
        if (del) del.addEventListener('click', function () {
            try {
                var ELR = (typeof ELRules !== 'undefined') ? ELRules : window.ELRules;
                var store = EL_rulesStoreApp();
                if (!ELR || !store || !store.rules[selKey]) return;
                var rec = ELR.sanitizeEntryRules(store.rules[selKey]);
                rec.rows.splice(idx, 1);
                store.rules[selKey] = rec;
                try { saveSettings(); } catch (e) {}
                EL_rulesLogPush('row deleted');
                EL_rulesRender();
            } catch (e) {}
        });
    });

    var addRow = q('#el-rules-addrow');
    if (addRow && selKey) addRow.addEventListener('click', function () {
        try {
            var ELR = (typeof ELRules !== 'undefined') ? ELRules : window.ELRules;
            var store = EL_rulesStoreApp();
            if (!ELR || !store || !store.rules[selKey]) return;
            var rec = ELR.sanitizeEntryRules(store.rules[selKey]);
            rec.rows.push({ kind: 'if', op: '=', left: { src: 'time', ref: '' }, right: '', target: '', value: '' });
            store.rules[selKey] = rec;
            try { saveSettings(); } catch (e) {}
            EL_rulesRender();
        } catch (e) {}
    });
}
