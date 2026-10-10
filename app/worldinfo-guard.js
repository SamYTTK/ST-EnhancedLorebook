/**
 * worldinfo-guard.js
 *
 * Data-loss protection for the Enhanced Lorebook app.
 *
 * Every lorebook save that goes through ELG_guardSave() is:
 *   - diffed against the authoritative server state (kills the stale-copy overwrite bug)
 *   - snapshotted BEFORE the change (pre-state) so it can be rolled back
 *   - audited (who/what/when)
 *   - protected against silent entry removal: if entries vanish and the change
 *     did NOT originate from an explicit user delete, the save is BLOCKED and the
 *     user is asked to confirm, listing exactly which entries would be lost.
 *
 * Explicitly-deleted entries are always quarantined to the server-side Trash so
 * they can be restored later.
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
    } catch (e) {
        try { (window.ELLogger||console).warn('[EL Guard] snapshot failed for', bookName, e); } catch { console.warn('[EL Guard] snapshot failed for', bookName, e); }
    }
}

/**
 * Quarantine removed entries server-side (best-effort, never throws).
 * removedEntries: array of [uid, entry]
 */
async function ELG_trashEntries(bookName, removedEntries, source, note) {
    const entries = removedEntries.map(([uid, entry]) => {
        let folderId = '';
        try {
            const folders = (typeof extensionSettings !== 'undefined' && extensionSettings?.folders?.[bookName]) || [];
            const folder = folders.find(f => f.entries.map(String).includes(String(uid)));
            if (folder) folderId = folder.id;
        } catch (e) { if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).warn('[EL:Guard] trash folderId lookup failed', bookName, uid, e); } catch {} }
        return {
            uid: String(uid),
            entry,
            folderId,
            deletedAt: Date.now(),
        };
    });
    if (!entries.length) return;
    try {
        const L = window.ELLogger || window.EL_log || console;
        try { L.info(`[EL:Guard] trash → ${bookName} count=${entries.length} source=${source} note=${note}`); } catch {}
        await ELG_apiFetch('POST', '/trash/add', { lorebookName: bookName, entries, source, note });
        if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).info('[EL:Guard] trash ok', bookName, entries.length); } catch {}
    } catch (e) {
        try { (window.ELLogger||console).warn('[EL Guard] trash add failed for', bookName, e); } catch { console.warn('[EL Guard] trash add failed for', bookName, e); }
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

/**
 * Show a blocking confirmation modal listing entries that are about to be lost.
 * Resolves true if the user confirms the removal, false if they cancel.
 */
function ELG_confirmDeletions(bookName, removedEntries, opts) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal active elg-confirm-modal';
        overlay.id = 'elg-delete-confirm-overlay';

        const listHtml = removedEntries
            .map(([, entry]) => `<div class="elg-delete-item"><span class="elg-delete-icon"><i class="fa-solid fa-triangle-exclamation"></i></span><span class="elg-delete-label">${ELG_escapeHtml(ELG_entryLabel(entry))}</span></div>`)
            .join('');

        overlay.innerHTML = `
            <div class="modal-content glass-panel" style="width: 560px; max-width: 92vw; max-height: 85vh; display: flex; flex-direction: column;">
                <div class="modal-header">
                    <h3><i class="fa-solid fa-shield-halved" style="margin-right: 8px; color: var(--danger-color, #ef4444);"></i>Potential Data Loss Blocked</h3>
                    <button class="close-modal elg-cancel"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body" style="overflow-y: auto; flex: 1; padding: 16px;">
                    <p style="margin-bottom: 12px; color: var(--text-muted); font-size: 0.9rem;">
                        Saving to <strong style="color: var(--text-color);">${ELG_escapeHtml(bookName)}</strong> would permanently remove <strong>${removedEntries.length}</strong> entr${removedEntries.length === 1 ? 'y' : 'ies'} that were not part of an explicit delete action${opts.source && opts.source !== 'user' ? ` (source: ${ELG_escapeHtml(opts.source)})` : ''}:
                    </p>
                    <div class="elg-delete-list">${listHtml}</div>
                    <p style="margin-top: 12px; font-size: 0.85rem; color: var(--text-muted);">
                        This usually means another window, the native editor, or the agent changed this lorebook and this copy is out of date.
                        <strong>Cancel</strong> and refresh to keep those entries.
                    </p>
                </div>
                <div class="modal-footer" style="padding: 12px 16px; border-top: 1px solid var(--panel-border); display: flex; justify-content: flex-end; gap: 12px;">
                    <button class="btn btn-secondary elg-cancel">Cancel</button>
                    <button class="btn elg-apply" style="background: var(--danger-color, #ef4444); color: #fff;">Apply Anyway (entries go to Trash)</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        function close() {
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
 * Core guarded save.
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
    let prevData = await ELG_fetchServerState(bookName);
    if (!prevData || !prevData.entries) {
        try { L.warn(`[EL:Guard] guardSave BYPASS — fetchServerState null, doing plain save (delete-protection SKIPPED)`, bookName, { hasPrev: !!prevData }); } catch {}
        try { if (typeof toastr !== 'undefined') toastr.warning(`Save bypassed guard (server fetch failed) for "${bookName}" — delete-protection skipped`); } catch {}
        // Can't diff — snapshot the incoming state, then fall back to a plain save.
        await ELG_snapshot(bookName, newData);
        try {
            await st.saveWorldInfo(bookName, newData, true);
            try { L.info(`[EL:Guard] guardSave plain ok (bypass)`, bookName); } catch {}
        } catch (e) {
            try { (L.error||console.error).call(L, '[EL Guard] save failed (bypass)', bookName, e); } catch { console.error('[EL Guard] save failed', e); }
            try { if (typeof toastr !== 'undefined') toastr.error(`Save failed for "${bookName}": ${e?.message||e}`); } catch {}
            return false;
        }
        return true;
    }

    const diff = ELG_diff(prevData.entries, newData.entries);
    if (_ELG_isVerboseGuard()) try { L.info(`[EL:Guard] diff book="${bookName}" removed=${diff.removed.length} added=${diff.added.length} changed=${diff.changed.length}`); } catch {}
    if (diff.removed.length && _ELG_isVerboseGuard()) try { L.warn(`[EL:Guard] diff removed details`, bookName, diff.removed.map(([uid,e])=>`${uid}:${e?.comment||''}`).join(', ').slice(0,500)); } catch {}

    // Audit any real change. (INFO kept — lorebook-relevant)
    if (diff.removed.length || diff.added.length || diff.changed.length) {
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
    if (diff.removed.length || diff.added.length || diff.changed.length) {
        if (_ELG_isVerboseGuard()) try { L.info(`[EL:Guard] snapshot pre-change book="${bookName}"`); } catch {}
        await ELG_snapshot(bookName, prevData);
    }

    // Deletion protection.
    if (diff.removed.length > 0) {
        const isExplicit = opts.explicitDelete === true;
        let proceed = true;

        if (!isExplicit) {
            try { L.warn(`[EL:Guard] deletion protection BLOCK — ${diff.removed.length} entries would be lost without explicitDelete`, bookName, opts); } catch {}
            // Not from an explicit delete — block unless the user confirms.
            proceed = await ELG_confirmDeletions(bookName, diff.removed, opts);
            try { L.info(`[EL:Guard] deletion modal result proceed=${proceed}`, bookName); } catch {}
            if (!proceed) {
                try { L.warn(`[EL:Guard] save BLOCKED by user cancel`, bookName); } catch {}
                if (typeof showToast === 'function') showToast('Save blocked — entries would have been lost');
                else try { if (typeof toastr !== 'undefined') toastr.warning('Save blocked — entries would have been lost'); } catch {}
                return false;
            }
        } else {
            try { L.info(`[EL:Guard] explicitDelete=true — trashing ${diff.removed.length} entries`, bookName); } catch {}
        }

        // Whatever the outcome, quarantined entries are never truly lost.
        await ELG_trashEntries(bookName, diff.removed, opts.source, opts.note);
    }

    try {
        try { L.info(`[EL:Guard] saveWorldInfo → "${bookName}" entries=${Object.keys(newData.entries||{}).length}`); } catch {}
        await st.saveWorldInfo(bookName, newData, true);
        try { L.info(`[EL:Guard] saveWorldInfo ok`, bookName); } catch {}
    } catch (e) {
        try { (L.error||console.error).call(L, '[EL Guard] save failed', bookName, e); } catch { console.error('[EL Guard] save failed', e); }
        try { if (typeof toastr !== 'undefined') toastr.error(`Save failed for "${bookName}": ${e?.message||e}`); } catch {}
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
 */
async function ELG_fetchServerState(bookName) {
    const st = ELG_resolveSt();
    if (!st || !bookName) {
        if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).warn('[EL:Guard] fetchServerState abort: missing st/bookName', bookName); } catch {}
        return null;
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
            const txt = await resp.text().catch(() => '');
            try { (window.ELLogger||console).warn('[EL:Guard] fetchServerState non-ok', bookName, resp.status, txt.slice(0,200)); } catch {}
            return null;
        }
        const data = await resp.json();
        if (_ELG_isVerboseGuard()) try { (window.ELLogger||console).debug(`[EL:Guard] fetchServerState ok ${bookName} entries=${Object.keys(data?.entries||{}).length}`); } catch {}
        return data;
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

async function ELG_restoreTrash(bookName, uids) {
    const result = await ELG_apiFetch('POST', '/trash/restore', { lorebookName: bookName, uids });
    return result?.entries || [];
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
window.ELG_snapshot = ELG_snapshot;
window.ELG_trashEntries = ELG_trashEntries;
window.ELG_audit = ELG_audit;
window.ELG_listTrash = ELG_listTrash;
window.ELG_restoreTrash = ELG_restoreTrash;
window.ELG_deleteTrash = ELG_deleteTrash;
window.ELG_listSnapshots = ELG_listSnapshots;
window.ELG_restoreSnapshot = ELG_restoreSnapshot;
window.ELG_deleteSnapshot = ELG_deleteSnapshot;
window.ELG_listAudit = ELG_listAudit;
