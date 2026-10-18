/**
 * worldinfo-guard.js
 *
 * Data-loss protection for the Enhanced Lorebook app.
 *
 * FAIL-CLOSED design: ELG_guardSave() never performs a blind overwrite.
 * Every lorebook save that goes through ELG_guardSave() is:
 *   - read from the authoritative server state FIRST; if that read fails the
 *     save is BLOCKED (no bypass, nothing is written)
 *   - diffed against that server state (kills the stale-copy overwrite bug)
 *   - snapshotted BEFORE the change (pre-state) so it can be rolled back
 *   - audited (who/what/when)
 *   - protected against silent entry removal: if entries vanish and the change
 *     did NOT originate from an explicit user delete, the save is BLOCKED and the
 *     user is asked to confirm, listing exactly which entries would be lost.
 *   - re-verified (TOCTOU check) just before writing, so a concurrent change
 *     on disk aborts the save instead of clobbering it
 *   - VERIFIED after writing: the file is read back and compared to what was
 *     written; a mismatch is reported as a failure.
 *
 * Explicitly-deleted entries are quarantined to the server-side Trash so
 * they can be restored later (two-phase: ELG_restoreTrash peeks, then
 * ELG_deleteTrashByIds consumes). If the Trash write fails while the plugin
 * is reachable, the save is BLOCKED so recovery stays possible.
 *
 * Depends on: stContext (global set by app.js) + the server plugin endpoints.
 */
const ELG_API_BASE = '/api/plugins/enhanced-lorebook-agent';

function ELG_getRequestHeaders() {
    try {
        const st = (typeof stContext !== 'undefined' && stContext) ? stContext : null;
        if (st && typeof st.getRequestHeaders === 'function') return st.getRequestHeaders();
    } catch (e) { try { (window.ELLogger||window.EL_log||console).warn('[EL:Guard] getRequestHeaders stContext failed', e); } catch {} }
    try {
        const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
        if (host && host.SillyTavern && typeof host.SillyTavern.getContext === 'function') {
            const ctx = host.SillyTavern.getContext();
            if (ctx && typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders();
        }
    } catch (e) { try { (window.ELLogger||window.EL_log||console).warn('[EL:Guard] getRequestHeaders host failed', e); } catch {} }
    return { 'Content-Type': 'application/json' };
}

/**
 * Popup-safe toast via window.EL_toast (app/toast.js): renders in the popup
 * window and mirrors to the host when the popup is hidden.
 */
function ELG_toast(message, type) {
    EL_toast(message, type || 'info');
}

async function ELG_apiFetch(method, path, body) {
    const url = `${ELG_API_BASE}${path}`;
    const opts = { method, headers: ELG_getRequestHeaders() };
    if (body !== undefined) {
        opts.body = JSON.stringify(body);
    }
    const resp = await fetch(url, opts);
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`API ${method} ${path}: ${resp.status}${text ? ' - ' + text.slice(0, 200) : ''}`);
    }
    return resp.json().catch(() => null);
}

function ELG_resolveSt() {
    return (typeof stContext !== 'undefined' && stContext) || null;
}

function ELG_entryLabel(entry) {
    if (!entry) return '(unknown entry)';
    const label = [];
    if (entry.comment) label.push(entry.comment);
    if (Array.isArray(entry.key) && entry.key.length) label.push(`Keys: ${entry.key.join(', ')}`);
    if (!label.length && entry.content) {
        const firstLine = String(entry.content).split(/\r?\n/).filter(l => l.trim())[0];
        if (firstLine) label.push(firstLine.slice(0, 80));
    }
    return label.join(' — ') || `UID ${entry.uid ?? '?'}`;
}

/**
 * Snapshot the given book data server-side (best-effort, never throws).
 * Extension-only: also snapshots folder mapping so URL is respected on restore.
 * Returns true on success, false on failure (callers ignore it today).
 */
function _ELG_isVerboseGuard() {
    try {
        if (typeof extensionSettings !== 'undefined' && typeof extensionSettings.sync?.verbose === 'boolean') return !!extensionSettings.sync.verbose;
        if (typeof ST_Window !== 'undefined' && ST_Window?.SillyTavern?.getContext) {
            const ctx = ST_Window.SillyTavern.getContext();
            const v = ctx?.extensionSettings?.SillyTavernEnhancedLorebook?.sync?.verbose;
            if (typeof v === 'boolean') return v;
        }
    } catch {}
    return false;
}
async function ELG_snapshot(bookName, data) {
    try {
        let folders = [];
        try {
            if (window.ELFolderUrl && typeof window.ELFolderUrl.getFoldersSnapshot === 'function') {
                folders = window.ELFolderUrl.getFoldersSnapshot(bookName);
            } else if (typeof extensionSettings !== 'undefined' && extensionSettings?.folders?.[bookName]) {
                folders = extensionSettings.folders[bookName];
            }
        } catch (e) { if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).warn('[EL:Guard] snapshot getFoldersSnapshot failed', bookName, e); } catch {} }
        // Snapshot is lorebook-relevant but noisy; keep INFO for success, no DEBUG start unless verbose
        if (_ELG_isVerboseGuard()) {
            const L = window.ELLogger || window.EL_log || console;
            try { L.info(`[EL:Guard] snapshot → ${bookName} entries=${Object.keys(data?.entries||{}).length}`); } catch {}
        }
        await ELG_apiFetch('POST', '/snapshot/create', { lorebookName: bookName, lorebookData: data, folders });
        try { (window.ELLogger||console).info('[EL:Guard] snapshot ok', bookName); } catch {}
        return true;
    } catch (e) {
        try { (window.ELLogger||console).warn('[EL Guard] snapshot failed for', bookName, e); } catch { console.warn('[EL Guard] snapshot failed for', bookName, e); }
        return false;
    }
}

/**
 * Quarantine removed entries server-side (never throws).
 * removedEntries: array of [uid, entry]
 * Returns true when the entries were stored (or there was nothing to store),
 * false when the /trash/add call failed.
 */
async function ELG_trashEntries(bookName, removedEntries, source, note) {
    try {
        const entries = (removedEntries || []).map(([uid, entry]) => {
            let folderId = '';
            try {
                const folders = (typeof extensionSettings !== 'undefined' && extensionSettings?.folders?.[bookName]) || [];
                const folder = folders.find(f => f.entries.map(String).includes(String(uid)));
                if (folder) folderId = folder.id;
            } catch (e) { if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).warn('[EL:Guard] trash folderId lookup failed', bookName, uid, e); } catch {} }
            let folderPath = '';
            try {
                if (window.ELFolderUrl && typeof window.ELFolderUrl.getFolderPathById === 'function') {
                    folderPath = window.ELFolderUrl.getFolderPathById(bookName, folderId) || '';
                }
            } catch (e) { if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).warn('[EL:Guard] trash folderPath lookup failed', bookName, uid, e); } catch {} folderPath = ''; }
            return {
                uid: String(uid),
                entry,
                folderId,
                folderPath,
                deletedAt: Date.now(),
            };
        });
        if (!entries.length) return true;
        try {
            const L = window.ELLogger || window.EL_log || console;
            try { L.info(`[EL:Guard] trash → ${bookName} count=${entries.length} source=${source} note=${note}`); } catch {}
            await ELG_apiFetch('POST', '/trash/add', { lorebookName: bookName, entries, source, note });
            if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).info('[EL:Guard] trash ok', bookName, entries.length); } catch {}
            return true;
        } catch (e) {
            try { (window.ELLogger||console).warn('[EL Guard] trash add failed for', bookName, e); } catch { console.warn('[EL Guard] trash add failed for', bookName, e); }
            return false;
        }
    } catch (e) {
        try { (window.ELLogger||console).warn('[EL Guard] trash add failed for', bookName, e); } catch { console.warn('[EL Guard] trash add failed for', bookName, e); }
        return false;
    }
}

/**
 * Append an audit event (best-effort, never throws).
 */
async function ELG_audit(bookName, rec) {
    try {
        if (_ELG_isVerboseGuard()) {
            const L = window.ELLogger || window.EL_log || console;
            try { L.info(`[EL:Guard] audit → ${bookName} action=${rec?.action} removed=${rec?.removed?.length||0} added=${rec?.added?.length||0}`); } catch {}
        }
        await ELG_apiFetch('POST', '/audit/append', { lorebookName: bookName, entry: rec });
    } catch (e) {
        try { (window.ELLogger||console).warn('[EL Guard] audit append failed for', bookName, e); } catch { console.warn('[EL Guard] audit append failed for', bookName, e); }
    }
}

function ELG_diff(oldEntries, newEntries) {
    const removed = [];
    const added = [];
    const changed = [];

    const oldKeys = Object.keys(oldEntries || {});
    const newKeys = Object.keys(newEntries || {});

    for (const uid of oldKeys) {
        if (!newEntries[uid]) {
            removed.push([uid, oldEntries[uid]]);
        } else if (JSON.stringify(oldEntries[uid]) !== JSON.stringify(newEntries[uid])) {
            changed.push(uid);
        }
    }
    for (const uid of newKeys) {
        if (!oldEntries[uid]) {
            added.push([uid, newEntries[uid]]);
        }
    }

    return { removed, added, changed };
}

function _ELG_canon(value, inArray) {
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
            if (unboxed !== value) return _ELG_canon(unboxed, inArray);
        } catch (e) { /* fall through to structural handling */ }
    }
    if (Array.isArray(value)) {
        return value.map(item => _ELG_canon(item, true));
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
        const v = _ELG_canon(value[key], false);
        if (v !== undefined) out[key] = v;
    }
    return out;
}

/**
 * Stable canonical string for deep comparison of entry maps: recursively sorts
 * object keys, then JSON.stringify. Two deep-equal maps produce identical
 * strings; undefined values behave like JSON.stringify (dropped from objects,
 * null in arrays). Never throws (returns '' when unserializable).
 */
function ELG_canonicalEntries(entries) {
    try {
        const canon = _ELG_canon(entries || {}, false);
        return JSON.stringify(canon === undefined ? null : canon);
    } catch (e) {
        try { (window.ELLogger||console).warn('[EL:Guard] canonicalEntries failed', e); } catch {}
        try { return JSON.stringify(entries || {}); } catch (e2) { return ''; }
    }
}

let _ELG_pluginProbeCache = { value: false, at: 0 };
const _ELG_PLUGIN_PROBE_TTL_MS = 30000;

/**
 * Cached (~30s) probe of the server plugin health endpoint.
 * Returns boolean, never throws. Used to decide whether a failed trash
 * write is fatal (plugin reachable = recovery should have been possible).
 */
async function ELG_pluginAvailable() {
    try {
        const now = Date.now();
        if (now - _ELG_pluginProbeCache.at < _ELG_PLUGIN_PROBE_TTL_MS) return _ELG_pluginProbeCache.value;
        let ok = false;
        try {
            const resp = await fetch(`${ELG_API_BASE}/health`, { method: 'GET', headers: ELG_getRequestHeaders(), cache: 'no-cache' });
            ok = !!resp && resp.ok === true;
        } catch (e) { ok = false; }
        _ELG_pluginProbeCache = { value: ok, at: now };
        return ok;
    } catch (e) { return false; }
}

/**
 * Show a blocking confirmation modal listing entries that are about to be lost.
 * Resolves true if the user confirms the removal, false if they cancel.
 * When the Trash plugin is unreachable the modal says the entries CANNOT be
 * recovered and the confirm button reflects that the deletion is permanent.
 */
async function ELG_confirmDeletions(bookName, removedEntries, opts) {
    const o = opts || {};
    let trashAvailable = true;
    try { trashAvailable = await ELG_pluginAvailable(); } catch (e) { trashAvailable = false; }
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal active elg-confirm-modal';
        overlay.id = 'elg-delete-confirm-overlay';

        const listHtml = removedEntries
            .map(([, entry]) => `<div class="elg-delete-item"><span class="elg-delete-icon"><i class="fa-solid fa-triangle-exclamation"></i></span><span class="elg-delete-label">${ELG_escapeHtml(ELG_entryLabel(entry))}</span></div>`)
            .join('');

        const noTrashHtml = trashAvailable ? '' : `
                    <p class="elg-no-trash-warning" style="margin-top: 12px; font-size: 0.85rem; color: var(--danger-color, #ef4444);">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        The Trash service is currently unreachable, so these entries <strong>CANNOT be recovered</strong> once deleted. This deletion will be permanent.
                    </p>`;

        const applyLabel = trashAvailable ? 'Apply Anyway (entries go to Trash)' : 'Delete Permanently (no Trash available)';

        overlay.innerHTML = `
            <div class="modal-content glass-panel" style="width: 560px; max-width: 92vw; max-height: 85vh; display: flex; flex-direction: column;">
                <div class="modal-header">
                    <h3><i class="fa-solid fa-shield-halved" style="margin-right: 8px; color: var(--danger-color, #ef4444);"></i>Potential Data Loss Blocked</h3>
                    <button class="close-modal elg-cancel"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body" style="overflow-y: auto; flex: 1; padding: 16px;">
                    <p style="margin-bottom: 12px; color: var(--text-muted); font-size: 0.9rem;">
                        Saving to <strong style="color: var(--text-color);">${ELG_escapeHtml(bookName)}</strong> would permanently remove <strong>${removedEntries.length}</strong> entr${removedEntries.length === 1 ? 'y' : 'ies'} that were not part of an explicit delete action${o.source && o.source !== 'user' ? ` (source: ${ELG_escapeHtml(o.source)})` : ''}:
                    </p>
                    <div class="elg-delete-list">${listHtml}</div>
                    <p style="margin-top: 12px; font-size: 0.85rem; color: var(--text-muted);">
                        This usually means another window, the native editor, or the agent changed this lorebook and this copy is out of date.
                        <strong>Cancel</strong> and refresh to keep those entries.
                    </p>${noTrashHtml}
                </div>
                <div class="modal-footer" style="padding: 12px 16px; border-top: 1px solid var(--panel-border); display: flex; justify-content: flex-end; gap: 12px;">
                    <button class="btn btn-secondary elg-cancel">Cancel</button>
                    <button class="btn elg-apply" style="background: var(--danger-color, #ef4444); color: #fff;">${applyLabel}</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        EL_modalOpen(overlay);

        function close() {
            EL_modalClose(overlay);
            overlay.remove();
        }

        overlay.querySelectorAll('.elg-cancel').forEach(el => {
            el.addEventListener('click', () => { close(); resolve(false); });
        });
        overlay.querySelector('.elg-apply').addEventListener('click', () => { close(); resolve(true); });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { close(); resolve(false); }
        });
    });
}

function ELG_escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

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
async function ELG_guardSave(bookName, newData, options = {}) {
    const L = window.ELLogger || window.EL_log || console;
    const st = options.st || ELG_resolveSt();
    if (!st || !bookName || !newData) {
        try { (L.error || L.warn || console.error).call(L, `[EL:Guard] guardSave aborted: missing st/bookName/newData`, { bookName, hasSt: !!st, hasData: !!newData }); } catch { console.error('[EL:Guard] guardSave aborted', bookName); }
        ELG_toast('Save blocked — missing lorebook context, nothing was written.', 'error');
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
    const fresh = await ELG_fetchServerStateEx(bookName);
    if (!fresh.ok) {
        try { (L.error||console.error).call(L, '[EL:Guard] guardSave BLOCKED — could not read server state, nothing written', bookName, fresh.reason); } catch { console.error('[EL:Guard] guardSave BLOCKED — could not read server state', bookName, fresh.reason); }
        ELG_toast('Save blocked — could not read the current file for "' + bookName + '" from the server (' + fresh.reason + '). Nothing was written.', 'error');
        return false;
    }

    const prevData = fresh.data;
    const diff = ELG_diff(prevData.entries || {}, newData.entries || {});
    if (_ELG_isVerboseGuard()) try { L.info(`[EL:Guard] diff book="${bookName}" removed=${diff.removed.length} added=${diff.added.length} changed=${diff.changed.length}`); } catch {}
    if (diff.removed.length && _ELG_isVerboseGuard()) try { L.warn(`[EL:Guard] diff removed details`, bookName, diff.removed.map(([uid,e])=>`${uid}:${e?.comment||''}`).join(', ').slice(0,500)); } catch {}

    // Deletion protection FIRST: the confirmation modal can sit open for a
    // while, so it must happen before the final consistency check below.
    if (diff.removed.length > 0 && opts.explicitDelete !== true) {
        try { L.warn(`[EL:Guard] deletion protection BLOCK — ${diff.removed.length} entries would be lost without explicitDelete`, bookName, opts); } catch {}
        const proceed = await ELG_confirmDeletions(bookName, diff.removed, opts);
        try { L.info(`[EL:Guard] deletion modal result proceed=${proceed}`, bookName); } catch {}
        if (!proceed) {
            try { L.warn(`[EL:Guard] save BLOCKED by user cancel`, bookName); } catch {}
            ELG_toast('Save blocked — entries would have been lost', 'warning');
            return false;
        }
    } else if (diff.removed.length > 0) {
        try { L.info(`[EL:Guard] explicitDelete=true — trashing ${diff.removed.length} entries`, bookName); } catch {}
    }

    // TOCTOU check: re-read the file just before writing; abort if it moved.
    // Done BEFORE audit/snapshot/trash so a rejected save leaves no artifacts
    // describing a change that never happened.
    const check = await ELG_fetchServerStateEx(bookName);
    if (!check.ok) {
        try { (L.error||console.error).call(L, '[EL:Guard] guardSave BLOCKED — could not re-verify before writing, nothing written', bookName, check.reason); } catch { console.error('[EL:Guard] guardSave BLOCKED — could not re-verify before writing', bookName, check.reason); }
        ELG_toast('Save blocked — could not re-verify the file before writing (' + check.reason + '). Nothing was written.', 'error');
        return false;
    }
    if (ELG_canonicalEntries(check.data.entries || {}) !== ELG_canonicalEntries(prevData.entries || {})) {
        try { L.warn(`[EL:Guard] guardSave BLOCKED — file changed on disk mid-edit`, bookName); } catch {}
        ELG_toast('Save blocked — "' + bookName + '" changed on disk while you were editing. Reload and try again.', 'warning');
        return false;
    }

    const hasDiff = !!(diff.removed.length || diff.added.length || diff.changed.length);

    // Audit the change. (INFO kept — lorebook-relevant)
    if (hasDiff) {
        if (_ELG_isVerboseGuard()) try { L.info(`[EL:Guard] audit emit book="${bookName}" action=${diff.removed.length>0&&diff.added.length===0&&diff.changed.length===0?'delete':'save'}`); } catch {}
        await ELG_audit(bookName, {
            action: diff.removed.length > 0 && diff.added.length === 0 && diff.changed.length === 0 ? 'delete' : 'save',
            removed: diff.removed.map(([uid, e]) => ({ uid, comment: e?.comment || '' })),
            added: diff.added.map(([uid, e]) => ({ uid, comment: e?.comment || '' })),
            changedCount: diff.changed.length,
            source: opts.source,
            note: opts.note,
        });
    }

    // Snapshot the pre-change state so we can always roll back.
    if (hasDiff) {
        if (_ELG_isVerboseGuard()) try { L.info(`[EL:Guard] snapshot pre-change book="${bookName}"`); } catch {}
        await ELG_snapshot(bookName, prevData);
    }

    // Quarantine removed entries so they are never truly lost. Must succeed
    // (when the plugin is reachable) BEFORE we overwrite the file.
    if (diff.removed.length > 0) {
        const trashed = await ELG_trashEntries(bookName, diff.removed, opts.source, opts.note);
        if (trashed === false) {
            if (await ELG_pluginAvailable()) {
                try { (L.error||console.error).call(L, '[EL:Guard] guardSave BLOCKED — trash write failed, nothing written', bookName); } catch { console.error('[EL:Guard] guardSave BLOCKED — trash write failed', bookName); }
                ELG_toast('Save blocked — removed entries could not be moved to Trash, so recovery would be impossible. Nothing was written.', 'error');
                return false;
            }
            try { L.warn('[EL:Guard] trash write failed and plugin is unreachable — continuing, deletion will be permanent', bookName); } catch {}
        }
    }

    try {
        try { L.info(`[EL:Guard] saveWorldInfo → "${bookName}" entries=${Object.keys(newData.entries||{}).length}`); } catch {}
        await st.saveWorldInfo(bookName, newData, true);
        try { L.info(`[EL:Guard] saveWorldInfo ok`, bookName); } catch {}
    } catch (e) {
        try { (L.error||console.error).call(L, '[EL Guard] save failed', bookName, e); } catch { console.error('[EL Guard] save failed', e); }
        ELG_toast('Save failed for "' + bookName + '": ' + (e?.message||e), 'error');
        return false;
    }

    // Verify: read the file back and confirm it matches what was written.
    // If we cannot read it back we must NOT report success — callers treat
    // `true` as "confirmed on disk" and may consume recovery copies on it.
    const after = await ELG_fetchServerStateEx(bookName);
    if (!after.ok) {
        try { (L.error||console.error).call(L, '[EL:Guard] save written but could not be verified — reporting failure', bookName, after.reason); } catch { console.error('[EL:Guard] save written but could not be verified', bookName, after.reason); }
        ELG_toast('Save could not be verified (' + after.reason + ') — reload before continuing.', 'error');
        return false;
    }
    if (ELG_canonicalEntries(after.data.entries || {}) !== ELG_canonicalEntries(newData.entries || {})) {
        try { (L.error||console.error).call(L, '[EL:Guard] save verification FAILED — disk does not match what was written', bookName); } catch { console.error('[EL:Guard] save verification FAILED', bookName); }
        ELG_toast('Save verification failed for "' + bookName + '" — the file on disk does not match what was written. Reload before continuing.', 'error');
        return false;
    }
    return true;
}

/**
 * Fetch the authoritative current data for a book straight from the server,
 * bypassing ST's client-side worldInfoCache.
 *
 * IMPORTANT: ST's loadWorldInfo() returns the cached object, and saveWorldInfo()
 * stores the saved object in that cache BY REFERENCE. If we compared against
 * st.loadWorldInfo() we would be diffing against the very object we are about to
 * save — the diff would always be empty and every save after the first would
 * silently skip its snapshot/audit/delete-protection. This endpoint reads the
 * file fresh from disk every call.
 *
 * NOTE: /api/worldinfo/get returns HTTP 200 with {entries:{}} for a lorebook
 * file that does not exist yet, so there is no 404 case — a non-OK response
 * is always a real failure.
 *
 * @returns {{ok:boolean, data:object|null, status:number|null, reason:string}}
 *   reason is '' on success, else one of
 *   'no-context' | 'http-<status>' | 'parse' | 'shape' | 'network'.
 */
async function ELG_fetchServerStateEx(bookName) {
    const st = ELG_resolveSt();
    if (!st || !bookName) {
        if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).warn('[EL:Guard] fetchServerState abort: missing st/bookName', bookName); } catch {}
        return { ok: false, data: null, status: null, reason: 'no-context' };
    }
    try {
        const headers = (typeof st.getRequestHeaders === 'function') ? st.getRequestHeaders() : { 'Content-Type': 'application/json' };
        if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).debug(`[EL:Guard] fetchServerState → ${bookName}`); } catch {}
        const resp = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: bookName }),
            cache: 'no-cache',
        });
        if (!resp.ok) {
            let txt = '';
            try { txt = await resp.text(); } catch (e) {}
            try { (window.ELLogger||console).warn('[EL:Guard] fetchServerState non-ok', bookName, resp.status, String(txt).slice(0,200)); } catch {}
            return { ok: false, data: null, status: resp.status, reason: 'http-' + resp.status };
        }
        let data;
        try {
            data = await resp.json();
        } catch (e) {
            try { (window.ELLogger||console).warn('[EL:Guard] fetchServerState parse failed', bookName, resp.status, e); } catch {}
            return { ok: false, data: null, status: resp.status, reason: 'parse' };
        }
        if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
            try { (window.ELLogger||console).warn('[EL:Guard] fetchServerState bad shape', bookName, resp.status); } catch {}
            return { ok: false, data: null, status: resp.status, reason: 'shape' };
        }
        if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).debug(`[EL:Guard] fetchServerState ok ${bookName} entries=${Object.keys(data?.entries||{}).length}`); } catch {}
        return { ok: true, data, status: resp.status, reason: '' };
    } catch (e) {
        try { (window.ELLogger||console).error('[EL Guard] server state fetch failed', bookName, e); } catch { console.error('[EL Guard] server state fetch failed', e); }
        return { ok: false, data: null, status: null, reason: 'network' };
    }
}

/**
 * Fetch the authoritative current data for a book straight from the server
 * (same cache-bypass notes as ELG_fetchServerStateEx above).
 * Thin wrapper: returns the parsed data object, or null on any failure.
 */
async function ELG_fetchServerState(bookName) {
    try {
        const res = await ELG_fetchServerStateEx(bookName);
        return res.ok ? res.data : null;
    } catch (e) {
        try { (window.ELLogger||console).error('[EL Guard] server state fetch failed', bookName, e); } catch { console.error('[EL Guard] server state fetch failed', e); }
        return null;
    }
}

/**
 * Load the authoritative current data for a book from the server (no caching).
 */
async function ELG_loadFresh(bookName) {
    const server = await ELG_fetchServerState(bookName);
    if (server && server.entries) return server;
    if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).warn('[EL:Guard] loadFresh fallback to cache (server miss)', bookName); } catch {}
    const st = ELG_resolveSt();
    if (!st) {
        try { (window.ELLogger||console).error('[EL:Guard] loadFresh no stContext', bookName); } catch {}
        return null;
    }
    try {
        const data = await st.loadWorldInfo(bookName);
        if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).warn('[EL:Guard] loadFresh used stale cache', bookName, `entries=${Object.keys(data?.entries||{}).length}`); } catch {}
        return data;
    } catch (e) {
        try { (window.ELLogger||console).error('[EL Guard] loadWorldInfo failed', bookName, e); } catch { console.error('[EL Guard] loadWorldInfo failed', e); }
        return null;
    }
}

// ── Trash / Snapshot / Audit client helpers (for the recovery UI) ────

async function ELG_listTrash(bookName) {
    const q = bookName ? '?lorebookName=' + encodeURIComponent(bookName) : '';
    const result = await ELG_apiFetch('GET', '/trash/list' + q);
    return result?.entries || [];
}

async function ELG_restoreTrash(bookName, ids) {
    // NOTE: two-phase restore — the server-side /trash/restore only RETURNS the
    // matching records and no longer deletes them. Callers must confirm the
    // restored data landed and then call ELG_deleteTrashByIds() to consume them.
    const result = await ELG_apiFetch('POST', '/trash/restore', { lorebookName: bookName, ids });
    return result?.entries || [];
}

async function ELG_deleteTrashByIds(bookName, ids) {
    await ELG_apiFetch('POST', '/trash/delete', { lorebookName: bookName, ids });
}

async function ELG_deleteTrash(bookName, uids) {
    await ELG_apiFetch('POST', '/trash/delete', { lorebookName: bookName, uids });
}

async function ELG_listSnapshots(bookName) {
    const q = bookName ? '?lorebookName=' + encodeURIComponent(bookName) : '';
    const result = await ELG_apiFetch('GET', '/snapshot/list' + q);
    return result?.snapshots || [];
}

async function ELG_restoreSnapshot(snapshotId, bookName) {
    return ELG_apiFetch('POST', '/snapshot/restore', { snapshotId, lorebookName: bookName });
}

async function ELG_deleteSnapshot(snapshotId, bookName) {
    await ELG_apiFetch('POST', '/snapshot/delete', { snapshotId, lorebookName: bookName });
}

async function ELG_listAudit(bookName) {
    const q = bookName ? '?lorebookName=' + encodeURIComponent(bookName) : '';
    const result = await ELG_apiFetch('GET', '/audit/list' + q);
    return result?.entries || [];
}

// Expose for use by app.js / agent-core.js.
window.ELG_guardSave = ELG_guardSave;
window.ELG_loadFresh = ELG_loadFresh;
window.ELG_fetchServerState = ELG_fetchServerState;
window.ELG_fetchServerStateEx = ELG_fetchServerStateEx;
window.ELG_snapshot = ELG_snapshot;
window.ELG_trashEntries = ELG_trashEntries;
window.ELG_audit = ELG_audit;
window.ELG_toast = ELG_toast;
window.ELG_canonicalEntries = ELG_canonicalEntries;
window.ELG_pluginAvailable = ELG_pluginAvailable;
window.ELG_listTrash = ELG_listTrash;
window.ELG_restoreTrash = ELG_restoreTrash;
window.ELG_deleteTrashByIds = ELG_deleteTrashByIds;
window.ELG_deleteTrash = ELG_deleteTrash;
window.ELG_listSnapshots = ELG_listSnapshots;
window.ELG_restoreSnapshot = ELG_restoreSnapshot;
window.ELG_deleteSnapshot = ELG_deleteSnapshot;
window.ELG_listAudit = ELG_listAudit;
