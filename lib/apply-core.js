/**
 * apply-core.js
 *
 * The shared core of the Enhanced Lorebook extension. It holds:
 *   - the canonical lorebook-entry contract (field allowlist + defaults)
 *   - the entry fingerprint (staleness check for proposals)
 *   - the entry diff (used by the save guard and by the audit trail)
 *   - the fail-closed save guard (read → diff → protect → snapshot → trash →
 *     write → verify), parameterised through injected dependencies
 *   - the proposal apply algorithm (create / edit / delete)
 *   - the VSCode-style line diff renderer
 *
 * It is deliberately DOM-free: every side effect that needs a window, a toast,
 * a confirmation dialog or a SillyTavern context is injected as a dependency.
 * That is what lets the SAME file run in two places:
 *   - the app window  (app/index.html loads it as a classic script)
 *   - the host window  (index.js loads the very same file and re-publishes the
 *     public API on window.EL)
 * There is therefore only one apply implementation and one guard
 * implementation — they cannot drift apart.
 */
(function (global) {
    'use strict';

    // ── Canonical entry contract ───────────────────────────────────────────
    // Field list mirrored from SillyTavern's newWorldInfoEntryDefinition
    // (public/scripts/world-info.js). The flat characterFilter* editor fields
    // are deliberately excluded: core stores the nested characterFilter object.
    // Note: characterFilter itself is not a definition key either — core creates
    // and reads it as the nested { isExclude, names, tags } object, so it is
    // allowlisted here as the stored shape.
    const ENTRY_FIELDS = Object.freeze([
        'key', 'keysecondary', 'comment', 'content', 'constant', 'vectorized', 'selective',
        'selectiveLogic', 'addMemo', 'order', 'position', 'disable', 'ignoreBudget',
        'excludeRecursion', 'preventRecursion',
        'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality',
        'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes',
        'delayUntilRecursion', 'probability', 'useProbability', 'depth', 'outletName',
        'group', 'groupOverride', 'groupWeight', 'scanDepth', 'caseSensitive',
        'matchWholeWords', 'useGroupScoring', 'automationId', 'role', 'sticky', 'cooldown',
        'delay', 'triggers', 'characterFilter',
    ]);

    // Template defaults mirrored from newWorldInfoEntryTemplate
    // (selectiveLogic 0 = world_info_logic.AND_ANY, depth 4 = DEFAULT_DEPTH,
    // groupWeight 100 = DEFAULT_WEIGHT). characterFilter is handled separately —
    // every created entry gets a fresh nested object, never a shared reference.
    const ENTRY_DEFAULTS = Object.freeze({
        key: [], keysecondary: [], comment: '', content: '', constant: false,
        vectorized: false, selective: true, selectiveLogic: 0, addMemo: false,
        order: 100, position: 0, disable: false, ignoreBudget: false,
        excludeRecursion: false, preventRecursion: false,
        matchPersonaDescription: false, matchCharacterDescription: false,
        matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
        matchScenario: false, matchCreatorNotes: false,
        delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4,
        outletName: '', group: '', groupOverride: false, groupWeight: 100,
        scanDepth: null, caseSensitive: null, matchWholeWords: null,
        useGroupScoring: null, automationId: '', role: 0, sticky: null,
        cooldown: null, delay: null, triggers: [],
    });

    const VALID_TRIGGERS = Object.freeze(['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet']);

    function cloneDefault(value) {
        if (Array.isArray(value)) return value.slice();
        if (value && typeof value === 'object') {
            try { return JSON.parse(JSON.stringify(value)); } catch (e) { return {}; }
        }
        return value;
    }

    // Normalise any characterFilter-ish snapshot input to the nested stored
    // shape { isExclude, names, tags }. Accepts the nested object, the legacy
    // flat editor keys (characterFilterExclude / characterFilterNames /
    // characterFilterTags) and a plain array or string of names. Returns null
    // when the snapshot carries no characterFilter input at all. Never returns
    // a string or an array.
    function normalizeCharacterFilter(src) {
        const s = (src && typeof src === 'object') ? src : {};
        const out = { isExclude: false, names: [], tags: [] };
        let seen = false;
        const v = s.characterFilter;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            seen = true;
            out.isExclude = v.isExclude === true;
            if (Array.isArray(v.names)) out.names = v.names.map(x => String(x ?? '').trim()).filter(Boolean);
            if (Array.isArray(v.tags)) out.tags = v.tags.filter(x => typeof x === 'string' || typeof x === 'number');
        } else if (Array.isArray(v)) {
            seen = true;
            out.names = v.map(x => String(x ?? '').trim()).filter(Boolean);
        } else if (typeof v === 'string' && v.trim()) {
            seen = true;
            out.names = [v.trim()];
        }
        if (s.characterFilterExclude !== undefined) {
            seen = true;
            out.isExclude = s.characterFilterExclude === true || String(s.characterFilterExclude).toLowerCase() === 'true';
        }
        if (Array.isArray(s.characterFilterNames)) {
            seen = true;
            if (!out.names.length) out.names = s.characterFilterNames.map(x => String(x ?? '').trim()).filter(Boolean);
        }
        if (Array.isArray(s.characterFilterTags)) {
            seen = true;
            if (!out.tags.length) out.tags = s.characterFilterTags.filter(x => typeof x === 'string' || typeof x === 'number');
        }
        return seen ? out : null;
    }

    // Filter a triggers value down to core's GENERATION_TYPE_TRIGGERS set.
    // Returns an array for array/string input, null for anything else (ignored).
    function normalizeTriggers(value) {
        if (Array.isArray(value)) {
            return value.map(x => String(x)).filter(x => VALID_TRIGGERS.includes(x));
        }
        if (typeof value === 'string' && VALID_TRIGGERS.includes(value.trim())) return [value.trim()];
        return null;
    }

    // Build a full stored entry from a create snapshot: allowlisted fields only,
    // template defaults backfilled for anything missing, characterFilter and
    // triggers normalised.
    function buildCreateEntry(snapshot) {
        const src = (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) ? snapshot : {};
        const entry = {};
        for (const key of ENTRY_FIELDS) {
            if (key === 'characterFilter' || key === 'triggers') continue;
            if (src[key] !== undefined) entry[key] = src[key];
            else entry[key] = cloneDefault(ENTRY_DEFAULTS[key]);
        }
        const cf = normalizeCharacterFilter(src);
        entry.characterFilter = cf || { isExclude: false, names: [], tags: [] };
        const t = (src.triggers !== undefined) ? normalizeTriggers(src.triggers) : null;
        entry.triggers = (t !== null) ? t : [];
        return entry;
    }

    // Build the writes map for an edit snapshot: allowlisted fields only,
    // skipping uid/_folderPath, normalising characterFilter and triggers.
    function buildEditWrites(snapshot) {
        const src = (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) ? snapshot : {};
        const writes = {};
        for (const key of ENTRY_FIELDS) {
            if (key === 'uid' || key === '_folderPath') continue;
            if (key === 'characterFilter') {
                const cf = normalizeCharacterFilter(src);
                if (cf) writes.characterFilter = cf;
                continue;
            }
            if (key === 'triggers') {
                if (src.triggers !== undefined) {
                    const t = normalizeTriggers(src.triggers);
                    if (t !== null) writes.triggers = t;
                }
                continue;
            }
            if (src[key] !== undefined) writes[key] = src[key];
        }
        return writes;
    }

    function fieldEquals(a, b) {
        try { return JSON.stringify(a) === JSON.stringify(b); }
        catch (e) { return false; }
    }

    // ── Fingerprints ───────────────────────────────────────────────────────
    // Deterministic JSON with sorted object keys, so two deep-equal values
    // always serialise identically regardless of key insertion order.
    function canonicalJson(v) {
        if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
        if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
        return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
    }

    // Two independent 32-bit mixing passes -> ~64 bits, plenty for a staleness check.
    function fingerprintHash(str) {
        let h1 = 0x811c9dc5, h2 = 0x01000193;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
            h2 = (Math.imul(h2 ^ c, 0x85ebca6b) + i) >>> 0;
        }
        return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
    }

    // Stable fingerprint of the entry fields a proposal depends on, so a stale
    // proposal cannot be applied on top of data the agent never saw.
    // HASHED, not raw: the raw JSON of a 40-field entry (including content) runs
    // to many kilobytes. It travels to the model as a tool result and must come
    // back verbatim, so a long string both bloats the request and gets
    // truncated on the return trip — which would make every fingerprint
    // comparison fail. A short hash keeps the round trip exact and small.
    function entryFingerprint(entry) {
        try {
            const keys = (entry && typeof entry === 'object') ? ENTRY_FIELDS : Object.keys(entry || {});
            const picked = {};
            for (const k of keys.slice().sort()) {
                if (entry && entry[k] !== undefined) picked[k] = entry[k];
            }
            const json = canonicalJson(picked);
            return 'v1:' + json.length + ':' + fingerprintHash(json);
        } catch (e) { return ''; }
    }

    // ── Canonical entry map (deep comparison) ──────────────────────────────
    function canon(value, inArray) {
        if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
            return inArray ? null : undefined;
        }
        if (value === null) return null;
        if (typeof value === 'number') {
            if (!isFinite(value)) return null;
            return value;
        }
        if (typeof value !== 'object') return value;
        if (value && typeof value.toJSON === 'function') {
            try {
                const unboxed = value.toJSON();
                if (unboxed !== value) return canon(unboxed, inArray);
            } catch (e) { /* fall through to structural handling */ }
        }
        if (Array.isArray(value)) {
            return value.map(item => canon(item, true));
        }
        const out = {};
        for (const key of Object.keys(value).sort()) {
            const v = canon(value[key], false);
            if (v !== undefined) out[key] = v;
        }
        return out;
    }

    /**
     * Stable canonical string for deep comparison of entry maps: recursively
     * sorts object keys, then JSON.stringify. Two deep-equal maps produce
     * identical strings; undefined values behave like JSON.stringify (dropped
     * from objects, null in arrays). Never throws (returns '' when
     * unserializable).
     */
    function canonicalEntries(entries) {
        try {
            const c = canon(entries || {}, false);
            return JSON.stringify(c === undefined ? null : c);
        } catch (e) {
            try { return JSON.stringify(entries || {}); } catch (e2) { return ''; }
        }
    }

    // ── Entry diff ─────────────────────────────────────────────────────────
    /**
     * Compare two entry maps.
     * @returns {{removed: Array<[uid, entry]>, added: Array<[uid, entry]>,
     *            changed: Array<{uid: string, comment: string, fields: string[],
     *            before: object|null, after: object|null}>,
     *            changedUids: string[]}}
     *   `changed` used to be an array of bare uids; it now carries the
     *   before/after snapshots so the audit trail can say WHICH entries changed
     *   and HOW. `changedUids` keeps the old flat list available.
     */
    function diffEntries(oldEntries, newEntries) {
        const removed = [];
        const added = [];
        const changed = [];

        const oldKeys = Object.keys(oldEntries || {});
        const newKeys = Object.keys(newEntries || {});

        for (const uid of oldKeys) {
            if (!newEntries[uid]) {
                removed.push([uid, oldEntries[uid]]);
            } else if (JSON.stringify(oldEntries[uid]) !== JSON.stringify(newEntries[uid])) {
                changed.push({
                    uid: String(uid),
                    comment: String((newEntries[uid] && newEntries[uid].comment) || (oldEntries[uid] && oldEntries[uid].comment) || ''),
                    fields: changedFields(oldEntries[uid], newEntries[uid]),
                    before: oldEntries[uid] || null,
                    after: newEntries[uid] || null,
                });
            }
        }
        for (const uid of newKeys) {
            if (!oldEntries[uid]) {
                added.push([uid, newEntries[uid]]);
            }
        }

        return {
            removed,
            added,
            changed,
            changedUids: changed.map(c => c.uid),
        };
    }

    // The field names that differ between two entries (best-effort, order stable).
    function changedFields(before, after) {
        const names = new Set();
        const b = (before && typeof before === 'object') ? before : {};
        const a = (after && typeof after === 'object') ? after : {};
        const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
        for (const k of keys) {
            if (!fieldEquals(b[k], a[k])) names.add(k);
        }
        return [...names].sort();
    }

    // ── Audit record ───────────────────────────────────────────────────────
    const AUDIT_MAX_CHANGED = 50;
    const AUDIT_MAX_SNAPSHOT_CHARS = 4000;
    const AUDIT_MAX_CHANGED_BYTES = 65536;

    // Snapshot one entry for the audit trail: the full entry, but with long
    // strings truncated so a single fat entry cannot bloat the audit file.
    function auditSnapshot(entry) {
        if (!entry || typeof entry !== 'object') return null;
        const out = {};
        for (const key of Object.keys(entry)) {
            const value = entry[key];
            if (typeof value === 'string' && value.length > AUDIT_MAX_SNAPSHOT_CHARS) {
                out[key] = value.slice(0, AUDIT_MAX_SNAPSHOT_CHARS) + '…[truncated]';
            } else if (value && typeof value === 'object') {
                try { out[key] = JSON.parse(JSON.stringify(value)); } catch (e) { out[key] = null; }
            } else {
                out[key] = value;
            }
        }
        return out;
    }

    /**
     * Build the audit record for one guarded save.
     * Old fields (action/removed/added/changedCount/source/note) are kept
     * exactly as they were; `changed` is added and names the entries that were
     * modified, with the fields that changed and the before/after snapshots.
     */
    function buildAuditRecord(diff, opts) {
        const o = opts || {};
        const d = diff || { removed: [], added: [], changed: [] };
        const changedList = Array.isArray(d.changed) ? d.changed : [];
        const changed = [];
        // The snapshots are the bulky part: keep the whole `changed` list
        // inside a byte budget so one fat entry cannot bloat the audit file.
        let budget = AUDIT_MAX_CHANGED_BYTES;
        for (const c of changedList.slice(0, AUDIT_MAX_CHANGED)) {
            const item = {
                uid: String(c.uid ?? ''),
                comment: String(c.comment || ''),
                fields: Array.isArray(c.fields) ? c.fields.slice(0, 50) : [],
                before: auditSnapshot(c.before),
                after: auditSnapshot(c.after),
            };
            let size = 0;
            try { size = JSON.stringify(item).length; } catch (e) { size = 0; }
            if (size > budget) break;
            budget -= size;
            changed.push(item);
        }
        return {
            action: (d.removed.length > 0 && d.added.length === 0 && d.changed.length === 0) ? 'delete' : 'save',
            removed: d.removed.map(([uid, e]) => ({ uid, comment: (e && e.comment) || '' })),
            added: d.added.map(([uid, e]) => ({ uid, comment: (e && e.comment) || '' })),
            changedCount: changedList.length,
            changed,
            source: o.source,
            note: o.note,
        };
    }

    // ── Line diff (VSCode-style) ──────────────────────────────────────────
    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Unified line diff (VSCode-style): removed lines red, added lines green,
     * unchanged lines neutral. LCS-based; falls back to whole-block remove+add
     * when the grid would get too big. Output is HTML-escaped.
     */
    function buildLineDiffHtml(oldStr, newStr) {
        const esc = escapeHtml;
        const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n');
        const splitLines = (s) => {
            const t = norm(s);
            if (t === '') return [];
            const arr = t.split('\n');
            if (arr.length > 1 && arr[arr.length - 1] === '') arr.pop();
            return arr;
        };
        const oldLines = splitLines(oldStr);
        const newLines = splitLines(newStr);

        const line = (cls, sign, text) =>
            '<div class="el-diff-line ' + cls + '"><span class="el-diff-gutter">' + sign + '</span><span>' + esc(text) + '</span></div>';

        const n = oldLines.length, m = newLines.length;
        // Cap the DP grid (~500x500); beyond that show all-removed + all-added.
        if (n * m > 250000) {
            let html = '';
            for (const l of oldLines) html += line('del', '−', l);
            for (const l of newLines) html += line('add', '+', l);
            return html;
        }
        // LCS lengths, suffix table.
        const dp = [];
        for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        let html = '', i = 0, j = 0;
        while (i < n && j < m) {
            if (oldLines[i] === newLines[j]) { html += line('ctx', ' ', oldLines[i]); i++; j++; }
            else if (dp[i + 1][j] >= dp[i][j + 1]) { html += line('del', '−', oldLines[i]); i++; }
            else { html += line('add', '+', newLines[j]); j++; }
        }
        while (i < n) { html += line('del', '−', oldLines[i]); i++; }
        while (j < m) { html += line('add', '+', newLines[j]); j++; }
        return html;
    }

    // ── The fail-closed save guard ─────────────────────────────────────────
    /**
     * Core guarded save (FAIL CLOSED — a blind overwrite never happens).
     *
     * @param {string} bookName      Lorebook name
     * @param {object} newData       Full new lorebook data to save
     * @param {object} [options]
     * @param {boolean} [options.explicitDelete=false]  true when the removal comes from a
     *        user-initiated delete/move action. Removed entries are still trashed.
     * @param {string}  [options.source='user']          'user' | 'agent' | 'external'
     * @param {string}  [options.note='']                human-readable note for audit/trash
     * @param {object}  [options.st]                     stContext override (defaults to global)
     * @returns {Promise<boolean>} true if the save was performed, false if it was blocked/skipped.
     */
    function createGuard(deps) {
        const d = deps || {};

        function logger() {
            try {
                if (typeof d.logger === 'function') return d.logger() || console;
                return d.logger || console;
            } catch (e) { return console; }
        }
        function toast(message, type) {
            try { if (typeof d.toast === 'function') d.toast(message, type); } catch (e) { /* toast is best-effort */ }
        }
        function isVerbose() {
            try { return typeof d.isVerbose === 'function' ? !!d.isVerbose() : false; } catch (e) { return false; }
        }

        async function guardSave(bookName, newData, options = {}) {
            const L = logger();
            const st = (typeof d.resolveSt === 'function') ? d.resolveSt(options.st) : null;
            if (!st || !bookName || !newData) {
                try { (L.error || L.warn || console.error).call(L, `[EL:Guard] guardSave aborted: missing st/bookName/newData`, { bookName, hasSt: !!st, hasData: !!newData }); } catch { console.error('[EL:Guard] guardSave aborted', bookName); }
                toast('Save blocked — missing lorebook context, nothing was written.', 'error');
                return false;
            }

            const opts = {
                explicitDelete: false,
                source: 'user',
                note: '',
                ...options,
            };
            try { L.info(`[EL:Guard] guardSave start book="${bookName}" source=${opts.source} note="${opts.note}" explicitDelete=${opts.explicitDelete} entries=${Object.keys(newData.entries||{}).length}`); } catch {}

            // Authoritative current state straight from the server (bypasses the client cache).
            // FAIL CLOSED: if we cannot read it, NOTHING is written — no bypass, no plain save.
            const fresh = await d.fetchServerStateEx(bookName);
            if (!fresh || !fresh.ok) {
                const reason = (fresh && fresh.reason) || 'unknown';
                try { (L.error||console.error).call(L, '[EL:Guard] guardSave BLOCKED — could not read server state, nothing written', bookName, reason); } catch { console.error('[EL:Guard] guardSave BLOCKED — could not read server state', bookName, reason); }
                toast('Save blocked — could not read the current file for "' + bookName + '" from the server (' + reason + '). Nothing was written.', 'error');
                return false;
            }

            const prevData = fresh.data;
            const diff = diffEntries(prevData.entries || {}, newData.entries || {});
            if (isVerbose()) try { L.info(`[EL:Guard] diff book="${bookName}" removed=${diff.removed.length} added=${diff.added.length} changed=${diff.changed.length}`); } catch {}
            if (diff.removed.length && isVerbose()) try { L.warn(`[EL:Guard] diff removed details`, bookName, diff.removed.map(([uid,e])=>`${uid}:${e?.comment||''}`).join(', ').slice(0,500)); } catch {}

            // Deletion protection FIRST: the confirmation modal can sit open for a
            // while, so it must happen before the final consistency check below.
            if (diff.removed.length > 0 && opts.explicitDelete !== true) {
                try { L.warn(`[EL:Guard] deletion protection BLOCK — ${diff.removed.length} entries would be lost without explicitDelete`, bookName, opts); } catch {}
                const proceed = await d.confirmDeletions(bookName, diff.removed, opts);
                try { L.info(`[EL:Guard] deletion modal result proceed=${proceed}`, bookName); } catch {}
                if (!proceed) {
                    try { L.warn(`[EL:Guard] save BLOCKED by user cancel`, bookName); } catch {}
                    toast('Save blocked — entries would have been lost', 'warning');
                    return false;
                }
            } else if (diff.removed.length > 0) {
                try { L.info(`[EL:Guard] explicitDelete=true — trashing ${diff.removed.length} entries`, bookName); } catch {}
            }

            // TOCTOU check: re-read the file just before writing; abort if it moved.
            // Done BEFORE audit/snapshot/trash so a rejected save leaves no artifacts
            // describing a change that never happened.
            const check = await d.fetchServerStateEx(bookName);
            if (!check || !check.ok) {
                const reason = (check && check.reason) || 'unknown';
                try { (L.error||console.error).call(L, '[EL:Guard] guardSave BLOCKED — could not re-verify before writing, nothing written', bookName, reason); } catch { console.error('[EL:Guard] guardSave BLOCKED — could not re-verify before writing', bookName, reason); }
                toast('Save blocked — could not re-verify the file before writing (' + reason + '). Nothing was written.', 'error');
                return false;
            }
            if (canonicalEntries(check.data.entries || {}) !== canonicalEntries(prevData.entries || {})) {
                try { L.warn(`[EL:Guard] guardSave BLOCKED — file changed on disk mid-edit`, bookName); } catch {}
                toast('Save blocked — "' + bookName + '" changed on disk while you were editing. Reload and try again.', 'warning');
                return false;
            }

            const hasDiff = !!(diff.removed.length || diff.added.length || diff.changed.length);

            // Audit the change. (INFO kept — lorebook-relevant)
            if (hasDiff) {
                const rec = buildAuditRecord(diff, { source: opts.source, note: opts.note });
                if (isVerbose()) try { L.info(`[EL:Guard] audit emit book="${bookName}" action=${rec.action}`); } catch {}
                await d.audit(bookName, rec);
            }

            // Snapshot the pre-change state so we can always roll back.
            if (hasDiff) {
                if (isVerbose()) try { L.info(`[EL:Guard] snapshot pre-change book="${bookName}"`); } catch {}
                await d.snapshot(bookName, prevData);
            }

            // Quarantine removed entries so they are never truly lost. Must succeed
            // (when the plugin is reachable) BEFORE we overwrite the file.
            if (diff.removed.length > 0) {
                const trashed = await d.trashEntries(bookName, diff.removed, opts.source, opts.note);
                if (trashed === false) {
                    if (await d.pluginAvailable()) {
                        try { (L.error||console.error).call(L, '[EL:Guard] guardSave BLOCKED — trash write failed, nothing written', bookName); } catch { console.error('[EL:Guard] guardSave BLOCKED — trash write failed', bookName); }
                        toast('Save blocked — removed entries could not be moved to Trash, so recovery would be impossible. Nothing was written.', 'error');
                        return false;
                    }
                    try { L.warn('[EL:Guard] trash write failed and plugin is unreachable — continuing, deletion will be permanent', bookName); } catch {}
                }
            }

            try {
                try { L.info(`[EL:Guard] saveWorldInfo → "${bookName}" entries=${Object.keys(newData.entries||{}).length}`); } catch {}
                await d.saveWorldInfo(bookName, newData, st);
                try { L.info(`[EL:Guard] saveWorldInfo ok`, bookName); } catch {}
            } catch (e) {
                try { (L.error||console.error).call(L, '[EL Guard] save failed', bookName, e); } catch { console.error('[EL Guard] save failed', e); }
                toast('Save failed for "' + bookName + '": ' + (e?.message||e), 'error');
                return false;
            }

            // Verify: read the file back and confirm it matches what was written.
            // If we cannot read it back we must NOT report success — callers treat
            // `true` as "confirmed on disk" and may consume recovery copies on it.
            const after = await d.fetchServerStateEx(bookName);
            if (!after || !after.ok) {
                const reason = (after && after.reason) || 'unknown';
                try { (L.error||console.error).call(L, '[EL:Guard] save written but could not be verified — reporting failure', bookName, reason); } catch { console.error('[EL:Guard] save written but could not be verified', bookName, reason); }
                toast('Save could not be verified (' + reason + ') — reload before continuing.', 'error');
                return false;
            }
            if (canonicalEntries(after.data.entries || {}) !== canonicalEntries(newData.entries || {})) {
                try { (L.error||console.error).call(L, '[EL:Guard] save verification FAILED — disk does not match what was written', bookName); } catch { console.error('[EL:Guard] save verification FAILED', bookName); }
                toast('Save verification failed for "' + bookName + '" — the file on disk does not match what was written. Reload before continuing.', 'error');
                return false;
            }
            return true;
        }

        return { guardSave };
    }

    // ── The proposal apply algorithm ───────────────────────────────────────
    /**
     * Apply one pending proposal to its lorebook.
     *
     * @param {object} proposal  the proposal record (contract unchanged)
     * @param {object} [opts]    { st, agentName }
     * @returns {Promise<void>} resolves when the lorebook was written
     */
    function createApplyCore(deps) {
        const d = deps || {};

        function logger() {
            try {
                if (typeof d.logger === 'function') return d.logger() || console;
                return d.logger || console;
            } catch (e) { return console; }
        }
        function warn(message) {
            try { const L = logger(); (L.warn || console.warn).call(L, '[EL:Apply] ' + message); } catch (e) { /* logging is best-effort */ }
        }
        function fingerprint(entry) {
            try {
                if (typeof d.fingerprint === 'function') return d.fingerprint(entry) || '';
                return entryFingerprint(entry);
            } catch (e) { return ''; }
        }
        function folders(bookName) {
            try {
                if (typeof d.getFolders === 'function') return d.getFolders(bookName) || null;
                return null;
            } catch (e) { return null; }
        }
        function folderOps() {
            try {
                if (typeof d.folderOps === 'function') return d.folderOps() || null;
                return d.folderOps || null;
            } catch (e) { return null; }
        }

        async function applyProposal(proposal, opts) {
            opts = opts || {};
            const st = (typeof d.resolveSt === 'function') ? d.resolveSt(opts.st) : null;
            if (!st) throw new Error('No SillyTavern context available');
            const data = await st.loadWorldInfo(proposal.lorebookName);
            if (!data || !data.entries) {
                throw new Error('Lorebook "' + proposal.lorebookName + '" not found');
            }

            if (proposal.action === 'edit' || proposal.action === 'delete') {
                const uid = proposal.uid;
                const current = data.entries[uid];
                if (!current) {
                    // IDEMPOTENT: a failed feed-delete can deliver a proposal twice —
                    // an already-absent delete target counts as applied, not an error.
                    if (proposal.action === 'delete') return;
                    throw new Error('Entry UID ' + uid + ' not found');
                }
                // Staleness check: refuse when the entry changed since the agent read it.
                // No linkage re-check here: linkage needs the full agent config
                // (ELAgentConfigSchema.isLorebookLinked(agent, name)) and apply-time
                // callers only pass the proposal (feed) or an agent name (auto-accept).
                const wantFp = (typeof proposal._baseFingerprint === 'string' && proposal._baseFingerprint) ? proposal._baseFingerprint : '';
                if (wantFp) {
                    const actualFp = fingerprint(current);
                    if (actualFp && actualFp !== wantFp) {
                        throw new Error('Proposal is stale — "' + proposal.lorebookName + '" entry ' + uid + ' changed since this proposal was created. Nothing was written.');
                    }
                    if (!actualFp) warn('could not recompute entry fingerprint for "' + proposal.lorebookName + '" uid ' + uid + ' — proceeding without staleness check.');
                } else {
                    warn('proposal for "' + proposal.lorebookName + '" uid ' + uid + ' carries no fingerprint (older proposal) — proceeding without staleness check.');
                }
                if (proposal.action === 'edit') {
                    const editWrites = buildEditWrites(proposal.changes || proposal.entrySnapshot || {});
                    // IDEMPOTENT: the entry already equals the intended result — a
                    // retried accept after a successful apply is a no-op success.
                    let alreadyApplied = true;
                    for (const k of Object.keys(editWrites)) {
                        let cur = current[k];
                        if (k === 'characterFilter') cur = normalizeCharacterFilter({ characterFilter: cur }) || { isExclude: false, names: [], tags: [] };
                        if (!fieldEquals(cur, editWrites[k])) { alreadyApplied = false; break; }
                    }
                    if (alreadyApplied) return;
                }
            }

            // Safety backup before mutating (server-side, 24h expiry).
            try {
                if (typeof d.createBackup === 'function') await d.createBackup(proposal.lorebookName);
            } catch (e) { /* a missing backup must not block the apply */ }

            if (proposal.action === 'create') {
                const snapshot = proposal.entryData || proposal.entrySnapshot || {};
                const folderPathFromProposal = proposal._folderPath || snapshot._folderPath || '';
                const newEntry = buildCreateEntry(snapshot);
                // IDEMPOTENT: a retried accept must not create a second copy. Compares the
                // FULL allowlisted entry, not just comment+content, so a legitimate second
                // entry that merely happens to share a comment and content is not swallowed.
                const intendedFp = fingerprint(newEntry);
                if (intendedFp) {
                    for (const existing of Object.values(data.entries)) {
                        if (existing && fingerprint(existing) === intendedFp) return;
                    }
                }
                let nextUid = null;
                for (let uid = 0; uid < 1000000; uid++) if (!(uid in data.entries)) { nextUid = uid; break; }
                if (nextUid === null) throw new Error('No free UID available');
                newEntry.uid = nextUid;
                data.entries[nextUid] = newEntry;

                let folderAssigned = false;
                const fops = folderOps();
                if (folderPathFromProposal && fops && typeof fops.assignEntryToUrl === 'function') {
                    try { folderAssigned = !!fops.assignEntryToUrl(nextUid, fops.buildUrl(proposal.lorebookName, folderPathFromProposal, nextUid), proposal.lorebookName); } catch (e) { folderAssigned = false; }
                }
                if (!folderAssigned && snapshot.folderId) {
                    const list = folders(proposal.lorebookName);
                    if (list) {
                        const folder = list.find(f => f.id === snapshot.folderId);
                        if (folder) { folder.entries.push(String(nextUid)); folderAssigned = true; }
                    }
                }
                if (!folderAssigned && proposal.url && fops && typeof fops.buildUrlForNewUid === 'function') {
                    try { fops.assignEntryToUrl(nextUid, fops.buildUrlForNewUid(proposal.url, nextUid), proposal.lorebookName); } catch (e) { /* folder assignment is best-effort */ }
                }
            } else if (proposal.action === 'edit') {
                const uid = proposal.uid;
                const entry = data.entries[uid];
                if (!entry) throw new Error('Entry UID ' + uid + ' not found');
                const snapshot = proposal.changes || proposal.entrySnapshot || {};
                const writes = buildEditWrites(snapshot);
                for (const key of Object.keys(writes)) {
                    entry[key] = writes[key];
                }
                const moveFolderPath = proposal._folderPath || snapshot._folderPath;
                const fops = folderOps();
                if (moveFolderPath !== undefined && moveFolderPath !== null && fops && typeof fops.assignEntryToUrl === 'function') {
                    try {
                        const targetUrl = fops.buildUrl(proposal.lorebookName, moveFolderPath || '', uid);
                        fops.assignEntryToUrl(uid, targetUrl, proposal.lorebookName);
                    } catch (e) { /* folder assignment is best-effort */ }
                }
            } else if (proposal.action === 'delete') {
                const uid = proposal.uid;
                if (!data.entries[uid]) throw new Error('Entry UID ' + uid + ' not found');
                delete data.entries[uid];
            } else {
                throw new Error('Unknown proposal action: ' + proposal.action);
            }

            if (typeof d.guardSave !== 'function') {
                throw new Error('Refusing to write "' + proposal.lorebookName + '": the lorebook guard (worldinfo-guard.js) is not loaded. Nothing was written.');
            }
            const saved = await d.guardSave(proposal.lorebookName, data, {
                explicitDelete: proposal.action === 'delete',
                source: 'agent',
                note: (proposal.action === 'delete' ? 'Hub delete' : 'Hub apply') + ' - ' + (opts.agentName || 'hub'),
            });
            if (!saved) {
                throw new Error('Apply blocked or failed — nothing was written to "' + proposal.lorebookName + '".');
            }
            if (proposal.action === 'delete') {
                const list = folders(proposal.lorebookName);
                if (list) {
                    for (const folder of list) {
                        folder.entries = folder.entries.filter(e => String(e) !== String(proposal.uid));
                    }
                }
                try {
                    if (typeof d.saveSettings === 'function') d.saveSettings();
                } catch (e) { /* settings persist is best-effort */ }
            }

            try {
                if (typeof d.refreshUi === 'function') d.refreshUi(proposal.lorebookName);
            } catch (e) { /* UI refresh is best-effort */ }
        }

        return { applyProposal };
    }

    // ── Change events ──────────────────────────────────────────────────────
    const PROPOSALS_CHANGED_EVENT = 'el:proposals-changed';
    const PROPOSALS_CHANGED_REASONS = Object.freeze(['created', 'accepted', 'denied', 'deleted', 'loaded']);

    /**
     * Emit the cross-extension "the proposal list changed" event on a
     * SillyTavern eventSource.
     * @param {object} eventSource  context.eventSource
     * @param {object} payload      { chatId, count, reason }
     */
    function emitProposalsChanged(eventSource, payload) {
        try {
            if (!eventSource || typeof eventSource.emit !== 'function') return false;
            const p = (payload && typeof payload === 'object') ? payload : {};
            const reason = PROPOSALS_CHANGED_REASONS.includes(p.reason) ? p.reason : 'loaded';
            const count = Math.max(0, Math.floor(Number(p.count) || 0));
            const chatId = (p.chatId === undefined || p.chatId === null) ? '' : String(p.chatId);
            eventSource.emit(PROPOSALS_CHANGED_EVENT, { chatId, count, reason });
            return true;
        } catch (e) { return false; }
    }

    global.ELApplyCore = {
        PROPOSALS_CHANGED_EVENT,
        PROPOSALS_CHANGED_REASONS,
        ENTRY_FIELDS,
        ENTRY_DEFAULTS,
        VALID_TRIGGERS,
        cloneDefault,
        normalizeCharacterFilter,
        normalizeTriggers,
        buildCreateEntry,
        buildEditWrites,
        fieldEquals,
        canonicalJson,
        fingerprintHash,
        entryFingerprint,
        canonicalEntries,
        diffEntries,
        changedFields,
        buildAuditRecord,
        escapeHtml,
        buildLineDiffHtml,
        createGuard,
        createApplyCore,
        emitProposalsChanged,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
