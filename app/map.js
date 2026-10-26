/**
 * EL-REVAMP B4: schematic per-book map.
 *
 * A schematic (never auto-populated, never model-readable) canvas of waypoint
 * dots for one lorebook. All geometry lives app-side in
 * extensionSettings.maps[book] = { pins, background, extraBooks, zoom } and
 * is persisted through the existing saveSettings path. The ONLY lorebook-file
 * write this module ever performs is a Current_Location placement edit on a
 * character entry: typed entries whose type declares a Current_Location slot
 * go through CC.applyType with reorder:false (a minimal render that never
 * reorders), falling back to the plain single-line upsert when the typed path
 * leaves the line untouched; untyped entries take the single-line upsert
 * directly. Every write goes through ELG_guardSave (source:'user').
 * A write blocked by the guard is queued app-side
 * (maps[book].pendingLocation, plus the desired container in
 * maps[book].pendingInside) and retried on the next EL_mapRender — render-time
 * flush only, no timers.
 *
 * Pins are created ONLY by explicit user action (entry-card button or the map
 * "add" picker). There is intentionally no auto-pin / auto-populate code path
 * anywhere in this file.
 *
 * Depends on (resolved at call time, never at load): stContext,
 * extensionSettings, saveSettings, currentLorebookName, currentLorebookData,
 * EL_setLorebookData, EL_getEntryType, ELG_loadFresh, ELG_guardSave,
 * EL_toast/showToast, EL_modalOpen/EL_modalClose, openEditEntryModal,
 * escapeHtml, renderEntries.
 */

let EL_mapSelected = null; // { uid, book } | null
let EL_mapZoomFallback = 2;
const EL_MAP_ZOOMS = [
    { n: 'building', d: '1 tile ≈ a room' },
    { n: 'street', d: '1 tile ≈ a building' },
    { n: 'city', d: '1 tile ≈ a street' },
    { n: 'region', d: '1 tile ≈ a town' },
    { n: 'continent', d: '1 tile ≈ a city' },
];
const EL_MAP_ACCENTS = { location: '#7aa2ff', character: '#e08bb0', mystery: '#5cc993' };
const EL_MAP_HIT_RADIUS = 7; // percent-space distance for drop-onto nesting
const EL_MAP_DRAG_PX = 4; // pointer travel (px) before a press counts as a drag
let EL_mapFlushRunning = false; // re-entrancy guard for the render-time retry flush

/**
 * Collapse anything entering Current_Location content (parent label, toast,
 * note) to one printable line: newlines become spaces, capped at 80 chars.
 */
function EL_mapSingleLine(v) {
    try {
        return String(v === null || v === undefined ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    } catch (e) { return ''; }
}

function EL_mapAccentValid(a) {
    try {
        if (typeof a === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(a)) return a;
    } catch (e) {}
    return null;
}

/** Attribute selector for a waypoint uid (CSS.escape when available). */
function EL_mapUidSel(uid) {
    const s = String(uid);
    try {
        if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
            return '.el-map-wp[data-uid="' + CSS.escape(s) + '"]';
        }
    } catch (e) {}
    return '.el-map-wp[data-uid="' + s.replace(/"/g, '') + '"]';
}

function EL_mapStore() {
    try {
        if (!extensionSettings || typeof extensionSettings !== 'object') return {};
        if (!extensionSettings.maps || typeof extensionSettings.maps !== 'object' || Array.isArray(extensionSettings.maps)) {
            extensionSettings.maps = {};
        }
        return extensionSettings.maps;
    } catch (e) { return {}; }
}

function EL_mapForBook(book, seed) {
    const store = EL_mapStore();
    const key = (book === undefined || book === null) ? '' : String(book);
    if (!key) return { pins: {}, background: null, extraBooks: [], zoom: 2 };
    let m = store[key];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
        if (seed === false) return null;
        m = { pins: {}, background: null, extraBooks: [], zoom: 2 };
        store[key] = m;
    }
    if (!m.pins || typeof m.pins !== 'object' || Array.isArray(m.pins)) m.pins = {};
    if (!m.pendingLocation || typeof m.pendingLocation !== 'object' || Array.isArray(m.pendingLocation)) m.pendingLocation = {};
    if (!m.pendingInside || typeof m.pendingInside !== 'object' || Array.isArray(m.pendingInside)) m.pendingInside = {};
    if (typeof m.background !== 'string' && m.background !== null) m.background = null;
    if (!Array.isArray(m.extraBooks)) m.extraBooks = [];
    if (typeof m.zoom !== 'number') m.zoom = 2;
    return m;
}

function EL_mapReadBook(book) {
    try {
        const store = EL_mapStore();
        const m = store[String(book)];
        if (!m || typeof m !== 'object') return null;
        return m;
    } catch (e) { return null; }
}

function EL_mapSave() {
    try { saveSettings(); } catch (e) {}
}

function EL_mapNormLabel(s) {
    return String(s || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
}

/**
 * Classify one entry for the map: 'character' | 'location' | null.
 * Typed entries decide by type id; untyped entries fall back to content
 * heuristics (a Current_Location line reads as a character, Region/Coordinates
 * as a location). Anything else is not pinnable.
 */
function EL_mapKindOf(entry) {
    if (!entry || typeof entry !== 'object') return null;
    try {
        const tid = entry.extensions && entry.extensions.el && entry.extensions.el.type;
        if (typeof tid === 'string' && tid) {
            const low = tid.toLowerCase();
            if (low.indexOf('char') !== -1) return 'character';
            if (low.indexOf('loc') !== -1) return 'location';
        }
    } catch (e) {}
    try {
        const text = String(entry.content || '');
        if (/^\s*Current_Location\s*:/mi.test(text)) return 'character';
        if (/^\s*(Region|Coordinates)\s*:/mi.test(text)) return 'location';
    } catch (e) {}
    return null;
}

function EL_mapAccent(kind, entry) {
    try {
        const tid = entry && entry.extensions && entry.extensions.el && entry.extensions.el.type;
        if (tid && typeof EL_getEntryType === 'function') {
            const t = EL_getEntryType(tid);
            if (t && typeof t.accent === 'string') {
                const valid = EL_mapAccentValid(t.accent);
                if (valid) return valid;
            }
        }
    } catch (e) {}
    return EL_MAP_ACCENTS[kind] || '#9aa0b4';
}

function EL_mapEntryLabel(uid, entry) {
    try {
        if (entry && entry.comment && String(entry.comment).trim()) return String(entry.comment).trim();
        if (entry && Array.isArray(entry.key)) {
            for (const k of entry.key) {
                if (k && String(k).trim()) return String(k).trim();
            }
        }
        if (entry && typeof entry.content === 'string') {
            const line = entry.content.split(/\r?\n/).filter(l => l.trim())[0];
            if (line) return line.trim().slice(0, 60);
        }
    } catch (e) {}
    return 'Entry ' + String(uid);
}

function EL_mapIsPinned(book, uid) {
    try {
        const m = EL_mapReadBook(book);
        return !!(m && m.pins && Object.prototype.hasOwnProperty.call(m.pins, String(uid)));
    } catch (e) { return false; }
}

function EL_mapPinCount(book) {
    try {
        const m = EL_mapReadBook(book);
        return m && m.pins ? Object.keys(m.pins).length : 0;
    } catch (e) { return 0; }
}

function EL_mapDefaultSpot(pins) {
    const n = pins ? Object.keys(pins).length : 0;
    return { x: 12 + ((n * 17) % 76), y: 14 + ((n * 23) % 68) };
}

function EL_mapClamp(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.min(100, Math.max(0, n));
}

/**
 * Pin one entry of the OPEN book. Explicit user action only — no caller in
 * this file pins without a click behind it, and there is no scan/import path.
 * @returns {boolean} true when a pin was created.
 */
function EL_mapPin(uid) {
    try {
        const book = currentLorebookName;
        if (!book) { try { EL_toast('Open a lorebook first.', 'warning'); } catch (e) {} return false; }
        const entries = (currentLorebookData && currentLorebookData.entries) || {};
        const entry = entries[String(uid)];
        if (!entry) return false;
        const kind = EL_mapKindOf(entry);
        if (!kind) {
            try { EL_toast('Only location and character entries can be pinned to the map.', 'warning'); } catch (e) {}
            return false;
        }
        const m = EL_mapForBook(book);
        const key = String(uid);
        if (m.pins[key]) return true;
        const spot = EL_mapDefaultSpot(m.pins);
        m.pins[key] = { x: spot.x, y: spot.y, inside: null };
        EL_mapSave();
        try { EL_toast('Pinned "' + EL_mapSingleLine(EL_mapEntryLabel(key, entry)) + '" to the map.', 'success'); } catch (e) {}
        try { if (typeof renderEntries === 'function') renderEntries(); } catch (e) {}
        try { if (typeof EL_mapRender === 'function') EL_mapRender(); } catch (e) {}
        return true;
    } catch (e) { return false; }
}

/**
 * Unpin one entry of the open book. Character entries fall back to
 * Current_Location: "Unknown" via the guard; a blocked write is queued
 * app-side and retried on the next map render (pin removal itself stands).
 */
async function EL_mapUnpin(uid) {
    try {
        const book = currentLorebookName;
        if (!book) return false;
        const key = String(uid);
        const m = EL_mapForBook(book);
        if (!m.pins[key]) return true;
        const entries = (currentLorebookData && currentLorebookData.entries) || {};
        const wasChar = EL_mapKindOf(entries[key]) === 'character';
        // Children of an unpinned location become free pins (keep coords).
        for (const k of Object.keys(m.pins)) {
            if (m.pins[k] && m.pins[k].inside === key) m.pins[k].inside = null;
        }
        delete m.pins[key];
        try { if (m.pendingInside) delete m.pendingInside[key]; } catch (e) {}
        EL_mapSave();
        if (wasChar) {
            const ok = await EL_mapWriteLocationLine(book, key, null);
            if (!ok) {
                try { EL_toast('Unpinned, but the Current_Location fallback was blocked — queued and will retry on the next map render.', 'warning'); } catch (e) {}
            }
        }
        try { if (typeof renderEntries === 'function') renderEntries(); } catch (e) {}
        try { if (typeof EL_mapRender === 'function') EL_mapRender(); } catch (e) {}
        return true;
    } catch (e) { return false; }
}

/**
 * Set (or clear) the container of a character pin of the open book, then
 * rewrite its Current_Location line through the guard. Direct user action.
 * The pin's inside state is only committed (plus saveSettings) after the
 * guard returns ok; on block the in-memory pin change is reverted, the write
 * stays queued, and the user is told it will retry on the next map render.
 */
async function EL_mapSetInside(uid, parentUid) {
    try {
        const book = currentLorebookName;
        if (!book) return false;
        const key = String(uid);
        const m = EL_mapForBook(book);
        if (!m.pins[key]) return false;
        const next = parentUid ? String(parentUid) : null;
        const prev = m.pins[key].inside ? String(m.pins[key].inside) : null;
        if (prev === next) return true;
        // Single-line the parent label BEFORE it enters content, toast or note.
        let parentName = null;
        if (next) {
            try {
                const entries = (currentLorebookData && currentLorebookData.entries) || {};
                parentName = EL_mapSingleLine(EL_mapEntryLabel(next, entries[next]));
                if (!parentName) parentName = EL_mapSingleLine(next);
            } catch (e) { parentName = EL_mapSingleLine(next); }
        }
        // Pending-inside only: no pin mutation and no pin-state save pre-guard.
        // (The queued write below persists the retry queue via its own save.)
        if (!m.pendingInside || typeof m.pendingInside !== 'object') m.pendingInside = {};
        m.pendingInside[key] = next;
        const ok = await EL_mapWriteLocationLine(book, key, parentName);
        if (ok) {
            const pin = m.pins[key];
            if (pin) {
                pin.inside = next;
                if (next) {
                    // Snap beside the parent with a small cascade offset.
                    try {
                        const sibs = Object.keys(m.pins).filter(k => k !== key && m.pins[k] && m.pins[k].inside === next).length;
                        const par = m.pins[next];
                        if (par) {
                            pin.x = EL_mapClamp(par.x + 4 + sibs * 2);
                            pin.y = EL_mapClamp(par.y - 6 - sibs * 2);
                        }
                    } catch (e) {}
                }
            }
            try { delete m.pendingInside[key]; } catch (e) {}
            EL_mapSave();
        } else {
            // Revert the in-memory pin change (never committed pre-guard);
            // the desired container stays queued for the render-time flush.
            if (m.pins[key]) m.pins[key].inside = prev;
            try { EL_toast('Map placement kept, but the Current_Location write was blocked — queued and will retry on the next map render.', 'error'); } catch (e) {}
        }
        try { if (typeof EL_mapRender === 'function') EL_mapRender(); } catch (e) {}
        return ok;
    } catch (e) { return false; }
}

function EL_mapTypeHasLocationSlot(entry) {
    try {
        const tid = entry && entry.extensions && entry.extensions.el && entry.extensions.el.type;
        if (!tid || typeof tid !== 'string') return null;
        const getType = (typeof EL_getEntryType === 'function') ? EL_getEntryType : null;
        if (!getType) return null;
        const type = getType(tid);
        if (!type || !Array.isArray(type.sections)) return null;
        for (const sec of type.sections) {
            const slots = (sec && sec.slots) || [];
            for (const sl of slots) {
                if (sl && EL_mapNormLabel(sl.label) === 'current location') return type;
            }
        }
        return null;
    } catch (e) { return null; }
}

/**
 * Pure single-line edit: replace the existing Current_Location line value, or
 * append one before the closing limiter (or end of content). Every other byte
 * — including mixed EOL styles — is preserved exactly; only the edited (or
 * inserted) line changes.
 */
function EL_mapUpsertLocationLine(content, value) {
    const raw = (content === null || content === undefined) ? '' : String(content);
    const v = (value === null || value === undefined) ? '' : String(value);
    // Split keeping delimiters so mixed \r\n / \n / \r survive byte-identical.
    const parts = raw.split(/(\r\n|\n|\r)/);
    const lineCount = (parts.length + 1) / 2;
    const atLine = (i) => parts[i * 2];
    const isDelim = (s) => s === '\r\n' || s === '\n' || s === '\r';
    const re = /^(\s*)(Current_Location)(\s*:)(.*)$/i;
    for (let i = 0; i < lineCount; i++) {
        const m = re.exec(atLine(i));
        if (m) {
            parts[i * 2] = m[1] + 'Current_Location' + m[3] + ' ' + v;
            return parts.join('');
        }
    }
    const line = 'Current_Location: ' + v;
    // Spaced-closer-tolerant limiter, mirroring the canonical RE_CLOSE in
    // lib/type-compiler.js (~:48).
    const RE_LIM = /^\s*\*\*<\s*\/\s*([^<>\s][^<>]*?)\s*>\*\*\s*$/;
    let at = lineCount;
    for (let i = lineCount - 1; i >= 0; i--) {
        if (RE_LIM.test(atLine(i))) { at = i; break; }
    }
    if (raw === '') return line;
    if (at >= lineCount) {
        let tail = '\n';
        for (let k = parts.length - 1; k >= 0; k--) {
            if (isDelim(parts[k])) { tail = parts[k]; break; }
        }
        parts.push(tail, line);
    } else {
        const pos = at * 2;
        let ins = '\n';
        if (pos + 1 < parts.length && isDelim(parts[pos + 1])) ins = parts[pos + 1];
        else if (pos - 1 >= 0 && isDelim(parts[pos - 1])) ins = parts[pos - 1];
        parts.splice(pos, 0, line, ins);
    }
    return parts.join('');
}

/**
 * Compute the new content for a Current_Location placement. Typed entries
 * whose type declares a Current_Location slot go through the entry compiler
 * (canonical path) with reorder:false so map placement never reorders;
 * everything else takes the plain single-line edit.
 * @returns {string|null} New content, or null when it cannot be computed.
 */
function EL_mapComputeLocationContent(entry, value) {
    try {
        const type = EL_mapTypeHasLocationSlot(entry);
        const CC = (typeof ELCompile !== 'undefined') ? ELCompile : (typeof window !== 'undefined' ? window.ELCompile : null);
        if (type && CC && typeof CC.applyType === 'function') {
            try {
                // Minimal edit: force reorder off for the map placement (the
                // type's own reorder flag is ignored here on purpose), and pass
                // reorder:false through as well so the intent travels with the
                // call if the compiler ever honors the option directly.
                const tOff = Object.assign({}, type, { reorder: false });
                const r = CC.applyType(entry, tOff, { values: { 'Current_Location': value }, reorder: false });
                if (r && r.entry && typeof r.entry.content === 'string' && r.entry.content !== entry.content) return r.entry.content;
            } catch (e) {}
            // NOTE: reorder:false keeps existing lines byte-identical but does
            // not rewrite an already-present slot line to the new value, so
            // fall back to the plain single-line edit to land the placement
            // without reordering anything.
        }
        return EL_mapUpsertLocationLine(entry && entry.content, value);
    } catch (e) { return null; }
}

/**
 * Rewrite one entry's Current_Location line (parent name, or "Unknown" when
 * parentName is null) through the guard. Direct user action only.
 * The parent label is single-lined before it enters content, toast or note.
 * @returns {Promise<boolean>} true when the save landed.
 */
async function EL_mapWriteLocationLine(book, uid, parentName) {
    try {
        const label = EL_mapSingleLine(parentName);
        const value = label ? label : '"Unknown"';
        return await EL_mapWriteLocationValue(book, uid, value);
    } catch (e) { return false; }
}

/**
 * Write a pre-rendered (already single-line) Current_Location value through
 * the guard. A blocked write is queued app-side
 * (maps[book].pendingLocation[uid] = value) and retried by the render-time
 * flush; a landed write clears its queue entry.
 * @returns {Promise<boolean>} true when the save landed.
 */
async function EL_mapWriteLocationValue(book, uid, value, opts) {
    const quiet = !!(opts && opts.quiet);
    const wt = (msg, kind) => { if (!quiet) { try { EL_toast(msg, kind); } catch (e) {} } };
    try {
        const val = String(value === null || value === undefined ? '"Unknown"' : value);
        const key = String(uid);
        let m = null;
        try { m = EL_mapForBook(book); } catch (e) { m = null; }
        const queue = () => {
            try {
                if (m) {
                    if (!m.pendingLocation || typeof m.pendingLocation !== 'object') m.pendingLocation = {};
                    m.pendingLocation[key] = val;
                    EL_mapSave();
                }
            } catch (e) {}
        };
        const dequeue = () => { try { if (m && m.pendingLocation) delete m.pendingLocation[key]; } catch (e) {} };
        const fresh = (typeof ELG_loadFresh === 'function') ? await ELG_loadFresh(book) : null;
        if (!fresh || !fresh.entries || !fresh.entries[key]) {
            // Entry gone underneath: drop any queue entry, there is nothing
            // left to retry against.
            dequeue();
            wt('Could not load the lorebook to write Current_Location.', 'error');
            return false;
        }
        const entry = fresh.entries[key];
        const next = EL_mapComputeLocationContent(entry, val);
        if (next === null) {
            wt('Could not compute the Current_Location edit.', 'error');
            return false;
        }
        if (next === entry.content) {
            dequeue();
            EL_mapSave();
            return true;
        }
        entry.content = next;
        const note = (val === '"Unknown"')
            ? 'Map placement cleared (Unknown)'
            : 'Map placed in "' + val + '"';
        const ok = (typeof ELG_guardSave === 'function')
            ? await ELG_guardSave(book, fresh, { explicitDelete: false, source: 'user', note: note })
            : false;
        if (ok) {
            dequeue();
            try { if (typeof EL_setLorebookData === 'function') EL_setLorebookData(fresh, { own: true }); } catch (e) {}
            try { if (typeof renderEntries === 'function') renderEntries(); } catch (e) {}
            wt('Current_Location → ' + val, 'success');
        } else {
            queue();
            wt('Current_Location write was blocked (entry changed underneath) — placement queued, retry on next map render.', 'error');
        }
        return !!ok;
    } catch (e) { return false; }
}

/**
 * Render-time flush of the app-side retry queue: attempt each pending
 * Current_Location write for the open book, keep the entries that still fail.
 * Called from EL_mapRender only — never timers/intervals. Quiet, so a still
 * blocked guard does not toast on every render; landing a write commits any
 * queued container (pendingInside) for pins that still exist.
 */
async function EL_mapFlushPending(book, m) {
    try {
        if (!book || !m || !m.pendingLocation || typeof m.pendingLocation !== 'object') return;
        const uids = Object.keys(m.pendingLocation);
        if (!uids.length || EL_mapFlushRunning) return;
        EL_mapFlushRunning = true;
        try {
            for (const uid of uids) {
                let val = null;
                try { val = m.pendingLocation[uid]; } catch (e) { continue; }
                if (val === undefined || val === null) continue;
                const ok = await EL_mapWriteLocationValue(book, uid, val, { quiet: true });
                if (ok) {
                    try {
                        if (m.pendingInside && m.pendingInside[uid] !== undefined && m.pins && m.pins[uid]) {
                            m.pins[uid].inside = m.pendingInside[uid];
                        }
                        if (m.pendingInside) delete m.pendingInside[uid];
                    } catch (e) {}
                    EL_mapSave();
                }
            }
        } finally {
            EL_mapFlushRunning = false;
        }
    } catch (e) { EL_mapFlushRunning = false; }
}

/**
 * TRACK C2 STUB — background image upload/serving route.
 * The map stores only a path string (maps[book].background) and previews it.
 * Real file upload + serving arrives with Track C2; do NOT build it here.
 */
function EL_mapUploadBackground() {
    try { EL_toast('Background upload arrives in Track C2 — enter a path manually for now.', 'warning'); } catch (e) {}
}

function EL_mapSetBackground(path) {
    try {
        const book = currentLorebookName;
        if (!book) return;
        const m = EL_mapForBook(book);
        m.background = (path && String(path).trim()) ? String(path).trim() : null;
        EL_mapSave();
        try { if (typeof EL_mapRender === 'function') EL_mapRender(); } catch (e) {}
    } catch (e) {}
}

function EL_mapZoom() {
    try {
        const m = EL_mapReadBook(currentLorebookName);
        const z = m && typeof m.zoom === 'number' ? m.zoom : EL_mapZoomFallback;
        return Math.min(EL_MAP_ZOOMS.length - 1, Math.max(0, z));
    } catch (e) { return EL_mapZoomFallback; }
}

function EL_mapSetZoom(idx) {
    try {
        const z = Math.min(EL_MAP_ZOOMS.length - 1, Math.max(0, Number(idx) || 0));
        EL_mapZoomFallback = z;
        const m = EL_mapForBook(currentLorebookName);
        if (m) { m.zoom = z; EL_mapSave(); }
        try { if (typeof EL_mapRender === 'function') EL_mapRender(); } catch (e) {}
    } catch (e) {}
}

function EL_mapToggleExtra(book) {
    try {
        const cur = currentLorebookName;
        if (!cur || !book || String(book) === String(cur)) return;
        const m = EL_mapForBook(cur);
        const key = String(book);
        const i = m.extraBooks.indexOf(key);
        if (i === -1) m.extraBooks.push(key);
        else m.extraBooks.splice(i, 1);
        EL_mapSave();
        try { if (typeof EL_mapRender === 'function') EL_mapRender(); } catch (e) {}
    } catch (e) {}
}

async function EL_mapFetchBook(name) {
    try {
        let headers = { 'Content-Type': 'application/json' };
        try {
            if (typeof stContext !== 'undefined' && stContext && typeof stContext.getRequestHeaders === 'function') {
                headers = stContext.getRequestHeaders();
            }
        } catch (e) {}
        const resp = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ name: name }),
            cache: 'no-cache',
        });
        if (!resp || !resp.ok) return null;
        const data = await resp.json();
        if (!data || typeof data !== 'object' || !data.entries) return null;
        return data;
    } catch (e) { return null; }
}

function EL_mapAllBookNames() {
    try {
        if (typeof stContext !== 'undefined' && stContext && typeof stContext.getWorldInfoNames === 'function') {
            const names = stContext.getWorldInfoNames();
            if (Array.isArray(names)) return names.filter(n => typeof n === 'string' && n);
        }
    } catch (e) {}
    return [];
}

function EL_mapEsc(s) {
    try {
        if (typeof escapeHtml === 'function') return escapeHtml(String(s === null || s === undefined ? '' : s));
    } catch (e) {}
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function EL_mapChildrenOf(pins, uid) {
    const out = [];
    try {
        for (const k of Object.keys(pins || {})) {
            if (pins[k] && pins[k].inside === String(uid)) out.push(k);
        }
    } catch (e) {}
    return out;
}

/**
 * Render the map view into #map-panel (toolbar + canvas + info side panel).
 * Re-entrant and null-safe: an empty state is shown when no book is open.
 */
async function EL_mapRender() {
    let panel = null;
    try { panel = document.getElementById('map-panel'); } catch (e) { panel = null; }
    if (!panel) return;
    const book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : null;
    if (!book) {
        panel.innerHTML = '<div class="empty-state" style="padding:40px 0;"><i class="fa-solid fa-map fa-3x"></i><p>Open a lorebook from the sidebar to use its map.</p></div>';
        return;
    }
    const m = EL_mapForBook(book);
    const entries = ((typeof currentLorebookData !== 'undefined') && currentLorebookData && currentLorebookData.entries) || {};
    // Retry queue first: blocked Current_Location writes land here on the
    // next render (render-time flush only, no timers).
    try { await EL_mapFlushPending(book, m); } catch (e) {}
    const z = EL_mapZoom();
    const zoom = EL_MAP_ZOOMS[z];

    // Extra books: explicit opt-in only; read their own pin stores + entries.
    const extras = [];
    try {
        for (const eb of (m.extraBooks || [])) {
            if (!eb || String(eb) === String(book)) continue;
            const em = EL_mapReadBook(eb);
            if (!em || !em.pins || !Object.keys(em.pins).length) continue;
            const edata = await EL_mapFetchBook(eb);
            if (!edata) continue;
            extras.push({ book: String(eb), pins: em.pins, entries: edata.entries || {} });
        }
    } catch (e) {}

    const pinUids = Object.keys(m.pins || {});
    const sizeStep = [10, 12, 13, 15, 17][z] || 13;

    let html = ''
        + '<div class="el-map-bar">'
        + '<span class="el-map-title"><i class="fa-solid fa-map"></i> ' + EL_mapEsc(book) + '</span>'
        + '<span class="el-map-count">' + pinUids.length + ' pinned · explicit only</span>'
        + '<button class="btn btn-secondary btn-sm" id="el-map-add" title="Pin an entry to the map"><i class="fa-solid fa-plus"></i> Add</button>'
        + '<button class="btn btn-secondary btn-sm" id="el-map-bgset" title="Set a background image path"><i class="fa-solid fa-image"></i> Background</button>'
        + '<span style="flex:1;"></span>'
        + '<span class="el-map-scale" id="el-map-scale">scale: ' + EL_mapEsc(zoom.n) + ' · ' + EL_mapEsc(zoom.d) + '</span>'
        + '<button class="btn btn-secondary btn-sm" id="el-map-zin" title="Zoom in">+</button>'
        + '<button class="btn btn-secondary btn-sm" id="el-map-zout" title="Zoom out">−</button>'
        + '</div>'
        + '<div class="el-map-extras"><details><summary>Extra books (' + m.extraBooks.length + ' opted in — never auto-included)</summary><div class="el-map-exlist">';

    const allNames = EL_mapAllBookNames().filter(n => String(n) !== String(book)).sort();
    if (!allNames.length) {
        html += '<span class="el-map-muted">No other lorebooks.</span>';
    } else {
        for (const n of allNames) {
            const on = m.extraBooks.indexOf(n) !== -1;
            html += '<label class="el-map-exitem"><input type="checkbox" data-ex="' + EL_mapEsc(n) + '"' + (on ? ' checked' : '') + '> ' + EL_mapEsc(n) + '</label>';
        }
    }
    html += '</div></details></div>'
        + '<div class="el-map-cols">'
        + '<div class="el-map-canvaswrap"><div class="el-map-canvas" id="el-map-canvas">';
    if (m.background) {
        html += '<img class="el-map-bg" src="' + EL_mapEsc(m.background) + '" alt="" draggable="false">';
    } else {
        html += '<span class="el-map-bghint">schematic · user-drawn grid</span>';
    }
    html += '</div></div>'
        + '<div class="el-map-side">'
        + '<h3>Selection</h3><div class="el-map-info" id="el-map-info"><div class="el-map-in-r">Click a waypoint.</div></div>'
        + '<h3>Pinned</h3><div class="el-map-pins" id="el-map-pins"></div>'
        + '<h3>Key</h3><div class="el-map-legend">'
        + '<span class="el-map-fchip" style="--c:' + EL_MAP_ACCENTS.location + '"><i></i>Location</span> '
        + '<span class="el-map-fchip" style="--c:' + EL_MAP_ACCENTS.character + '"><i></i>Character</span>'
        + '</div>'
        + '</div></div>';

    panel.innerHTML = html;

    const canvas = document.getElementById('el-map-canvas');
    if (canvas) {
        canvas.style.setProperty('--el-map-dot', sizeStep + 'px');
        // Current-book waypoints (draggable).
        for (const uid of pinUids) {
            const pin = m.pins[uid];
            if (!pin) continue;
            const entry = entries[uid];
            if (!entry) continue; // entry deleted underneath: pin stays, waypoint hidden
            EL_mapPaintWaypoint(canvas, uid, book, entry, pin, false, sizeStep);
        }
        // Extra-book waypoints (dimmed, tagged, not draggable).
        for (const ex of extras) {
            for (const uid of Object.keys(ex.pins || {})) {
                const entry = ex.entries[uid];
                if (!entry) continue;
                EL_mapPaintWaypoint(canvas, uid, ex.book, entry, ex.pins[uid], true, sizeStep);
            }
        }
    }

    EL_mapRenderPins(panel, m, entries, extras);
    EL_mapRenderInfo(panel, m, entries, extras);

    try {
        const addBtn = document.getElementById('el-map-add');
        if (addBtn) addBtn.addEventListener('click', () => EL_mapAddPicker());
        const bgBtn = document.getElementById('el-map-bgset');
        if (bgBtn) bgBtn.addEventListener('click', () => EL_mapBackgroundPrompt());
        const zin = document.getElementById('el-map-zin');
        if (zin) zin.addEventListener('click', () => EL_mapSetZoom(EL_mapZoom() - 1));
        const zout = document.getElementById('el-map-zout');
        if (zout) zout.addEventListener('click', () => EL_mapSetZoom(EL_mapZoom() + 1));
        panel.querySelectorAll('[data-ex]').forEach(cb => {
            cb.addEventListener('change', () => EL_mapToggleExtra(cb.getAttribute('data-ex')));
        });
    } catch (e) {}
}

function EL_mapPaintWaypoint(canvas, uid, book, entry, pin, dimmed, sizeStep) {
    try {
        const kind = EL_mapKindOf(entry) || 'location';
        const accent = EL_mapAccent(kind, entry);
        const label = EL_mapEntryLabel(uid, entry);
        const kids = dimmed ? 0 : EL_mapChildrenOf((EL_mapReadBook(book) || {}).pins || {}, uid).length;
        const d = document.createElement('div');
        d.className = 'el-map-wp'
            + (kind === 'character' ? ' char' : '')
            + (EL_mapSelected && String(EL_mapSelected.uid) === String(uid) && String(EL_mapSelected.book) === String(book) ? ' sel' : '')
            + (dimmed ? ' dim' : '');
        d.style.left = EL_mapClamp(pin.x) + '%';
        d.style.top = EL_mapClamp(pin.y) + '%';
        d.style.setProperty('--c', accent);
        d.setAttribute('data-uid', String(uid));
        d.setAttribute('data-book', String(book));
        const tag = dimmed ? '<span class="el-map-booktag">' + EL_mapEsc(book) + '</span>' : '';
        d.innerHTML = '<span class="dot"></span><span class="nm">' + EL_mapEsc(label) + '</span>' + tag
            + (kids ? '<span class="cnt">' + kids + '</span>' : '');
        if (!dimmed) EL_mapWireDrag(d, String(uid));
        d.addEventListener('click', (ev) => {
            if (d._elSuppressClick) {
                d._elSuppressClick = false;
                try { ev.stopPropagation(); ev.preventDefault(); } catch (e) {}
                return;
            }
            EL_mapSelected = { uid: String(uid), book: String(book) };
            try { EL_mapRender(); } catch (e) {}
        });
        canvas.appendChild(d);
    } catch (e) {}
}

function EL_mapRenderPins(panel, m, entries, extras) {
    let host = null;
    try { host = panel.querySelector('#el-map-pins'); } catch (e) { host = null; }
    if (!host) return;
    host.innerHTML = '';
    const uids = Object.keys(m.pins || {});
    if (!uids.length && !extras.length) {
        host.innerHTML = '<span class="el-map-muted">Nothing pinned — pin entries explicitly to build this map.</span>';
        return;
    }
    const book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : '';
    for (const uid of uids) {
        const pin = m.pins[uid];
        const entry = entries[uid];
        if (!entry || !pin) continue;
        const kind = EL_mapKindOf(entry) || 'location';
        const accent = EL_mapAccent(kind, entry);
        const row = document.createElement('div');
        row.className = 'el-map-pinrow';
        row.innerHTML = '<span class="dot" style="--c:' + EL_mapEsc(accent) + ';background:' + EL_mapEsc(accent) + '"></span>'
            + '<span>' + EL_mapEsc(EL_mapEntryLabel(uid, entry)) + '<small>' + EL_mapEsc(kind)
            + (pin.inside ? ' · in ' + EL_mapEsc(EL_mapEntryLabel(pin.inside, entries[pin.inside])) : '') + '</small></span>';
        const b = document.createElement('button');
        b.className = 'ibtn';
        b.title = 'Unpin';
        b.textContent = '×';
        b.addEventListener('click', () => EL_mapUnpin(uid));
        row.appendChild(b);
        row.addEventListener('click', (e) => {
            if (e.target === b) return;
            EL_mapSelected = { uid: String(uid), book: String(book) };
            try { EL_mapRender(); } catch (e) {}
        });
        host.appendChild(row);
    }
    for (const ex of extras) {
        for (const uid of Object.keys(ex.pins || {})) {
            const entry = ex.entries[uid];
            if (!entry) continue;
            const kind = EL_mapKindOf(entry) || 'location';
            const row = document.createElement('div');
            row.className = 'el-map-pinrow dim';
            row.innerHTML = '<span class="dot" style="background:' + EL_mapEsc(EL_mapAccent(kind, entry)) + '"></span>'
                + '<span>' + EL_mapEsc(EL_mapEntryLabel(uid, entry)) + '<small>' + EL_mapEsc(ex.book) + ' · ' + EL_mapEsc(kind) + '</small></span>';
            host.appendChild(row);
        }
    }
}

function EL_mapRenderInfo(panel, m, entries, extras) {
    let host = null;
    try { host = panel.querySelector('#el-map-info'); } catch (e) { host = null; }
    if (!host) return;
    const sel = EL_mapSelected;
    if (!sel) {
        host.innerHTML = '<div class="el-map-in-r">Click a waypoint to inspect it.</div>';
        return;
    }
    const isExtra = String(sel.book) !== String((typeof currentLorebookName !== 'undefined') ? currentLorebookName : '');
    let entry = null;
    let pin = null;
    if (isExtra) {
        const ex = (extras || []).find(e => String(e.book) === String(sel.book));
        entry = ex ? ex.entries[sel.uid] : null;
        pin = ex ? ex.pins[sel.uid] : null;
    } else {
        entry = entries[sel.uid];
        pin = m.pins[sel.uid];
    }
    if (!entry || !pin) {
        host.innerHTML = '<div class="el-map-in-r">Selection no longer exists.</div>';
        return;
    }
    const kind = EL_mapKindOf(entry) || 'location';
    const accent = EL_mapAccent(kind, entry);
    const label = EL_mapEntryLabel(sel.uid, entry);
    let linePreview = '— (position is map-only, no lorebook write)';
    if (kind === 'character') {
        const insideName = pin.inside ? EL_mapEntryLabel(pin.inside, entries[pin.inside]) : null;
        linePreview = 'Current_Location: ' + (insideName ? EL_mapEsc(insideName) : '"Unknown"');
    }
    let kidHtml = '';
    if (!isExtra && kind === 'location') {
        const kids = EL_mapChildrenOf(m.pins, sel.uid);
        if (kids.length) {
            kidHtml = '<div class="el-map-in-r">Contains (' + kids.length + '):<br>' + kids.map(k =>
                '<button class="btn btn-secondary btn-sm el-map-kid" data-kid="' + EL_mapEsc(k) + '">○ ' + EL_mapEsc(EL_mapEntryLabel(k, entries[k])) + '</button>'
            ).join('') + '</div>';
        }
    }
    host.innerHTML = '<div class="el-map-in-t"><span class="ty" style="--c:' + EL_mapEsc(accent) + ';color:' + EL_mapEsc(accent) + ';border-color:' + EL_mapEsc(accent) + '">'
        + EL_mapEsc(kind) + '</span>' + EL_mapEsc(label)
        + (isExtra ? ' <span class="el-map-booktag">' + EL_mapEsc(sel.book) + '</span>' : '') + '</div>'
        + '<div class="el-map-in-r">x ' + Math.round(EL_mapClamp(pin.x)) + ', y ' + Math.round(EL_mapClamp(pin.y))
        + (pin.inside ? ' · in ' + EL_mapEsc(EL_mapEntryLabel(pin.inside, entries[pin.inside])) : ' · free')
        + '<br>writes → <code>' + linePreview + '</code></div>'
        + kidHtml
        + (!isExtra ? '<div class="el-map-in-r"><button class="btn btn-secondary btn-sm" id="el-map-open">Open entry</button> '
        + '<button class="btn btn-secondary btn-sm" id="el-map-unpin">Unpin</button></div>' : '');
    try {
        host.querySelectorAll('.el-map-kid').forEach(b => {
            b.addEventListener('click', () => {
                EL_mapSelected = { uid: String(b.getAttribute('data-kid')), book: String((typeof currentLorebookName !== 'undefined') ? currentLorebookName : '') };
                try { EL_mapRender(); } catch (e) {}
            });
        });
        const openBtn = host.querySelector('#el-map-open');
        if (openBtn) openBtn.addEventListener('click', () => {
            try { if (typeof openEditEntryModal === 'function') openEditEntryModal(String(sel.uid)); } catch (e) {}
        });
        const unpinBtn = host.querySelector('#el-map-unpin');
        if (unpinBtn) unpinBtn.addEventListener('click', () => {
            EL_mapSelected = null;
            EL_mapUnpin(String(sel.uid));
        });
    } catch (e) {}
}

/**
 * Pointer drag for current-book waypoints. Moves update the pin store live
 * (map-only, never a lorebook write); the store persists on drop. Dragging
 * only starts after EL_MAP_DRAG_PX of pointer travel: below the threshold
 * nothing is mutated or saved and the press stays a click. Dropping a
 * character pin onto a location pin sets inside (guarded Current_Location
 * write); dragging it out clears to Unknown. Dragging a location carries its
 * contents along by the same delta.
 */
function EL_mapWireDrag(el, uid) {
    try {
        el.addEventListener('pointerdown', (ev) => {
            try { ev.preventDefault(); } catch (e) {}
            try { el.setPointerCapture(ev.pointerId); } catch (e) {}
            // Pointerdown snapshot: store + element geometry are restored from
            // this on pointercancel, and sub-threshold presses restore nothing
            // because they never mutate.
            const snap = { sx: ev.clientX, sy: ev.clientY, exceeded: false, pin: null, kids: {} };
            try {
                const book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : null;
                const m = book ? EL_mapForBook(book) : null;
                const pin = m && m.pins ? m.pins[String(uid)] : null;
                if (pin) snap.pin = { x: pin.x, y: pin.y };
                const kids = m ? EL_mapChildrenOf(m.pins, uid) : [];
                for (const k of kids) {
                    const kp = m.pins[k];
                    if (kp) snap.kids[k] = { x: kp.x, y: kp.y };
                }
            } catch (e) {}
            el._elDrag = {
                snap: snap,
                lastX: null, lastY: null,
                rect: null,
            };
            try {
                const canvas = document.getElementById('el-map-canvas');
                if (canvas) el._elDrag.rect = canvas.getBoundingClientRect();
            } catch (e) {}
        });
        el.addEventListener('pointermove', (ev) => {
            const st = el._elDrag;
            if (!st || !st.snap) return;
            if (!st.snap.exceeded) {
                const dx0 = ev.clientX - st.snap.sx;
                const dy0 = ev.clientY - st.snap.sy;
                if (Math.hypot(dx0, dy0) < EL_MAP_DRAG_PX) return;
                st.snap.exceeded = true;
            }
            const rect = st.rect || { left: 0, top: 0, width: 1, height: 1 };
            const nx = EL_mapClamp((ev.clientX - rect.left) / Math.max(1, rect.width) * 100);
            const ny = EL_mapClamp((ev.clientY - rect.top) / Math.max(1, rect.height) * 100);
            const book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : null;
            const m = book ? EL_mapForBook(book) : null;
            const pin = m && m.pins ? m.pins[String(uid)] : null;
            if (!pin) { el._elDrag = null; return; }
            const dx = (st.lastX === null) ? 0 : (nx - st.lastX);
            const dy = (st.lastY === null) ? 0 : (ny - st.lastY);
            st.lastX = nx; st.lastY = ny;
            pin.x = nx; pin.y = ny;
            el.style.left = nx + '%';
            el.style.top = ny + '%';
            // Carry-along: contents of a dragged location move by the same delta.
            try {
                const kids = EL_mapChildrenOf(m.pins, uid);
                for (const k of kids) {
                    const kp = m.pins[k];
                    if (!kp) continue;
                    kp.x = EL_mapClamp(kp.x + dx);
                    kp.y = EL_mapClamp(kp.y + dy);
                    const ke = document.querySelector(EL_mapUidSel(k));
                    if (ke) { ke.style.left = kp.x + '%'; ke.style.top = kp.y + '%'; }
                }
            } catch (e) {}
        });
        const finish = async (ev) => {
            const st = el._elDrag;
            el._elDrag = null;
            if (!st || !st.snap) return;
            if (!st.snap.exceeded) return; // tap: no mutation, no save; click proceeds
            el._elSuppressClick = true; // one-shot: consumed by the waypoint click handler
            const book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : null;
            const m = book ? EL_mapForBook(book) : null;
            const pin = m && m.pins ? m.pins[String(uid)] : null;
            if (!pin) return;
            EL_mapSave(); // moves persist on drop; never a lorebook write
            const entries = ((typeof currentLorebookData !== 'undefined') && currentLorebookData && currentLorebookData.entries) || {};
            const kind = EL_mapKindOf(entries[String(uid)]);
            if (kind === 'character') {
                // Hit-test location pins for nesting.
                let target = null;
                let best = EL_MAP_HIT_RADIUS;
                for (const k of Object.keys(m.pins)) {
                    if (k === String(uid)) continue;
                    const kp = m.pins[k];
                    if (!kp) continue;
                    if (EL_mapKindOf(entries[k]) !== 'location') continue;
                    const dist = Math.hypot(kp.x - pin.x, kp.y - pin.y);
                    if (dist < best) { best = dist; target = k; }
                }
                const prev = pin.inside ? String(pin.inside) : null;
                const next = target ? String(target) : null;
                if (prev !== next) {
                    await EL_mapSetInside(String(uid), next);
                    return;
                }
            }
            EL_mapSelected = { uid: String(uid), book: String(book) };
            try { EL_mapRender(); } catch (e) {}
        };
        el.addEventListener('pointerup', finish);
        el.addEventListener('pointercancel', () => {
            const st = el._elDrag;
            el._elDrag = null;
            try {
                if (st && st.snap) {
                    const book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : null;
                    const m = book ? EL_mapForBook(book) : null;
                    const pin = m && m.pins ? m.pins[String(uid)] : null;
                    if (pin && st.snap.pin) {
                        pin.x = st.snap.pin.x;
                        pin.y = st.snap.pin.y;
                        el.style.left = pin.x + '%';
                        el.style.top = pin.y + '%';
                    }
                    for (const k of Object.keys(st.snap.kids || {})) {
                        if (m && m.pins && m.pins[k]) {
                            m.pins[k].x = st.snap.kids[k].x;
                            m.pins[k].y = st.snap.kids[k].y;
                            const ke = document.querySelector(EL_mapUidSel(k));
                            if (ke) { ke.style.left = m.pins[k].x + '%'; ke.style.top = m.pins[k].y + '%'; }
                        }
                    }
                }
            } catch (e) {}
        });
    } catch (e) {}
}

/** Picker modal listing unpinned location/character entries of the open book. */
function EL_mapAddPicker() {
    try {
        const book = (typeof currentLorebookName !== 'undefined') ? currentLorebookName : null;
        if (!book) return;
        const entries = ((typeof currentLorebookData !== 'undefined') && currentLorebookData && currentLorebookData.entries) || {};
        const m = EL_mapForBook(book);
        const cands = Object.keys(entries || {}).filter(uid => {
            if (m.pins[String(uid)]) return false;
            return !!EL_mapKindOf(entries[uid]);
        });
        const overlay = document.createElement('div');
        overlay.className = 'modal active';
        overlay.id = 'el-map-add-overlay';
        const listHtml = cands.length ? cands.map(uid => {
            const kind = EL_mapKindOf(entries[uid]);
            return '<div class="el-map-pickrow"><span><b>' + EL_mapEsc(EL_mapEntryLabel(uid, entries[uid])) + '</b> '
                + '<span class="el-map-muted">(' + EL_mapEsc(kind) + ')</span></span>'
                + '<button class="btn btn-secondary btn-sm" data-pin="' + EL_mapEsc(uid) + '">Pin</button></div>';
        }).join('') : '<p class="el-map-muted">Every location/character entry is already pinned. Nothing to add — the map never auto-populates.</p>';
        overlay.innerHTML = '<div class="modal-content glass-panel" style="width:440px;">'
            + '<div class="modal-header"><h3><i class="fa-solid fa-thumbtack" style="margin-right:8px;"></i>Pin to map</h3>'
            + '<button class="close-modal"><i class="fa-solid fa-xmark"></i></button></div>'
            + '<div class="modal-body"><div class="el-map-picklist">' + listHtml + '</div></div></div>';
        document.body.appendChild(overlay);
        const close = () => { try { EL_modalClose(overlay); } catch (e) {} try { overlay.remove(); } catch (e) {} };
        try {
            const modalClose = (typeof EL_modalOpen === 'function') ? EL_modalOpen : null;
            if (modalClose) modalClose(overlay);
        } catch (e) {}
        overlay.querySelector('.close-modal').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelectorAll('[data-pin]').forEach(b => {
            b.addEventListener('click', () => {
                const uid = b.getAttribute('data-pin');
                close();
                EL_mapPin(uid);
            });
        });
    } catch (e) {}
}

function EL_mapBackgroundPrompt() {
    try {
        const m = EL_mapForBook((typeof currentLorebookName !== 'undefined') ? currentLorebookName : null);
        const cur = (m && m.background) || '';
        let next = null;
        try { next = prompt('Background image path (preview only — upload arrives in Track C2):', cur); } catch (e) { return; }
        if (next === null || next === undefined) return;
        EL_mapSetBackground(String(next));
    } catch (e) {}
}
