/**
 * folder-url.js — Stable URL per entry for extension-owned folders.
 *
 * Contract: URLs are *only* for things handled by this extension (virtual
 * folders in extensionSettings.folders). Nothing is written into the
 * lorebook entry itself, so ST is never polluted.
 *
 * URL form (derived, not stored on entry):
 *   el://<lorebookName>/<Folder Path>/uid
 *   root entries: el://<book>//uid  or el://<book>/uid (both normalize to root)
 *   folder path is slash or " / " joined names, e.g. "Bestiary / Dragons"
 *
 * The helpers below are the single source of truth. Every operation that
 * creates/moves/duplicates/restores entries must go through them so the
 * folder location is respected.
 *
 * Globals expected: extensionSettings, currentLorebookName (optional fallback).
 */

const EL_FOLDER_URL_PREFIX = 'el://';

function _EL_isVerboseFolder() {
    try {
        if (typeof extensionSettings !== 'undefined' && typeof extensionSettings.sync?.verbose === 'boolean') return !!extensionSettings.sync.verbose;
        if (typeof window !== 'undefined' && window.extensionSettings?.sync?.verbose) return !!window.extensionSettings.sync.verbose;
        const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
        if (host?.SillyTavern?.getContext) {
            const ctx = host.SillyTavern.getContext();
            const v = ctx?.extensionSettings?.SillyTavernEnhancedLorebook?.sync?.verbose;
            if (typeof v === 'boolean') return v;
        }
    } catch {}
    return false;
}
function EL_resolveBook(bookName) {
    if (typeof bookName === 'string' && bookName) return bookName;
    if (typeof currentLorebookName !== 'undefined' && currentLorebookName) return currentLorebookName;
    if (_EL_isVerboseFolder()) try { (window.ELLogger||console).debug('[EL:Folder] resolveBook null — no bookName and no currentLorebookName', { bookName }); } catch {}
    return null;
}

function EL_getFolders(bookName) {
    const b = EL_resolveBook(bookName);
    if (!b) return [];
    if (!extensionSettings || !extensionSettings.folders) return [];
    return extensionSettings.folders[b] || [];
}

function EL_ensureFoldersArray(bookName) {
    const b = EL_resolveBook(bookName);
    if (!b) return [];
    if (!extensionSettings.folders) extensionSettings.folders = {};
    if (!extensionSettings.folders[b]) extensionSettings.folders[b] = [];
    return extensionSettings.folders[b];
}

function EL_findFolderById(bookName, folderId) {
    if (!folderId) return null;
    const folders = EL_getFolders(bookName);
    return folders.find(f => f.id === folderId) || null;
}

function EL_getFolderIdForUid(uid, bookName) {
    const folders = EL_getFolders(bookName);
    const s = String(uid);
    for (const f of folders) {
        if (Array.isArray(f.entries) && f.entries.map(String).includes(s)) return f.id;
    }
    return null;
}

function EL_getFolderPathById(bookName, folderId) {
    if (!folderId) return '';
    const folders = EL_getFolders(bookName);
    const path = [];
    let current = folders.find(f => f.id === folderId);
    let guard = 0;
    while (current && guard < 64) {
        path.unshift(current.name);
        if (current.parentId) {
            current = folders.find(f => f.id === current.parentId);
        } else {
            current = null;
        }
        guard++;
    }
    return path.join(' / ');
}

function EL_getFolderPathForUid(uid, bookName) {
    const fid = EL_getFolderIdForUid(uid, bookName);
    return fid ? EL_getFolderPathById(bookName, fid) : '';
}

function EL_buildUrl(bookName, folderPath, uid) {
    const b = EL_resolveBook(bookName);
    if (!b) {
        // Keep warn — this indicates a real mis-call, not spam (rare)
        try { (window.ELLogger||console).warn('[EL:Folder] buildUrl null — resolveBook failed', { bookName, folderPath, uid }); } catch {}
        return null;
    }
    const uidStr = String(uid);
    const path = (folderPath || '').trim();
    if (!path) return `${EL_FOLDER_URL_PREFIX}${b}/${uidStr}`;
    const normalized = path.split('/').map(s => s.trim()).filter(Boolean).join(' / ');
    const url = `${EL_FOLDER_URL_PREFIX}${b}/${normalized}/${uidStr}`;
    if (_EL_isVerboseFolder()) try { (window.ELLogger||console).debug(`[EL:Folder] buildUrl book="${b}" path="${normalized}" uid=${uidStr} → ${url}`); } catch {}
    return url;
}

function EL_getUrlForUid(uid, bookName) {
    const b = EL_resolveBook(bookName);
    if (!b) return null;
    const path = EL_getFolderPathForUid(uid, b);
    return EL_buildUrl(b, path, uid);
}

function EL_parseUrl(url) {
    if (typeof url !== 'string' || !url.startsWith(EL_FOLDER_URL_PREFIX)) {
        if (_EL_isVerboseFolder()) try { if (url) (window.ELLogger||console).warn('[EL:Folder] parseUrl invalid prefix', url); } catch {}
        return null;
    }
    const rest = url.slice(EL_FOLDER_URL_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
        if (_EL_isVerboseFolder()) try { (window.ELLogger||console).warn('[EL:Folder] parseUrl no slash', url); } catch {}
        return null;
    }
    const lorebook = rest.slice(0, slash);
    const tail = rest.slice(slash + 1); // path + "/" + uid  or just uid
    if (!tail) return { lorebook, folderPath: '', uid: '' };
    const parts = tail.split('/').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return { lorebook, folderPath: '', uid: '' };
    const uid = parts.pop();
    const folderPath = parts.join(' / ');
    return { lorebook, folderPath, uid };
}

function EL_buildUrlForNewUid(sourceUrl, newUid) {
    const parsed = EL_parseUrl(sourceUrl);
    if (!parsed) return EL_buildUrl(EL_resolveBook(null), '', newUid);
    return EL_buildUrl(parsed.lorebook, parsed.folderPath, newUid);
}

/**
 * Ensure a folder chain exists for `folderPath` in `bookName`.
 * Creates missing folders at each level. Returns folderId of deepest folder,
 * or null if path is empty (meaning root).
 */
function EL_ensureFolderByPath(bookName, folderPath) {
    const b = EL_resolveBook(bookName);
    if (!b) {
        if (_EL_isVerboseFolder()) try { (window.ELLogger||console).warn('[EL:Folder] ensureFolderByPath null book', { bookName, folderPath }); } catch {}
        return null;
    }
    const raw = (folderPath || '').trim();
    if (!raw) return null;
    const names = raw.split('/').map(s => s.trim()).filter(Boolean);
    if (!names.length) return null;
    const folders = EL_ensureFoldersArray(b);
    let parentId = null;
    let deepestId = null;
    for (const name of names) {
        let existing = folders.find(f => f.name === name && (f.parentId || null) === (parentId || null));
        if (!existing) {
            existing = {
                id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name,
                parentId: parentId || null,
                order: 100,
                entries: [],
            };
            folders.push(existing);
            try { (window.ELLogger||console).info(`[EL:Folder] created folder "${name}" parent=${parentId} book="${b}" id=${existing.id}`); } catch {}
        }
        deepestId = existing.id;
        parentId = existing.id;
    }
    return deepestId;
}

function EL_assignEntryToFolderId(uid, folderId, bookName) {
    const b = EL_resolveBook(bookName);
    if (!b) {
        if (_EL_isVerboseFolder()) try { (window.ELLogger||console).warn('[EL:Folder] assignEntryToFolderId null book', { uid, folderId, bookName }); } catch {}
        return false;
    }
    const folders = EL_ensureFoldersArray(b);
    const s = String(uid);
    for (const f of folders) {
        if (Array.isArray(f.entries)) {
            f.entries = f.entries.filter(x => String(x) !== s);
        }
    }
    if (!folderId) {
        if (_EL_isVerboseFolder()) try { (window.ELLogger||console).debug(`[EL:Folder] assign uid=${s} → root book="${b}"`); } catch {}
        return true;
    }
    const target = EL_findFolderById(b, folderId);
    if (!target) {
        if (_EL_isVerboseFolder()) try { (window.ELLogger||console).warn('[EL:Folder] assignEntryToFolderId target not found', { uid, folderId, bookName:b }); } catch {}
        return false;
    }
    if (!Array.isArray(target.entries)) target.entries = [];
    if (!target.entries.map(String).includes(s)) target.entries.push(s);
    if (_EL_isVerboseFolder()) try { (window.ELLogger||console).debug(`[EL:Folder] assign uid=${s} → folder="${target.name}" (${folderId}) book="${b}"`); } catch {}
    return true;
}

function EL_assignEntryToUrl(uid, url, bookName) {
    const b = EL_resolveBook(bookName) || (url ? EL_parseUrl(url)?.lorebook : null);
    if (!b) {
        if (_EL_isVerboseFolder()) try { (window.ELLogger||console).warn('[EL:Folder] assignEntryToUrl null book', { uid, url, bookName }); } catch {}
        return false;
    }
    if (!url) {
        if (_EL_isVerboseFolder()) try { (window.ELLogger||console).debug(`[EL:Folder] assignEntryToUrl uid=${uid} → root (no url) book="${b}"`); } catch {}
        return EL_assignEntryToFolderId(uid, null, b);
    }
    const parsed = EL_parseUrl(url);
    if (!parsed) {
        if (_EL_isVerboseFolder()) try { (window.ELLogger||console).warn('[EL:Folder] assignEntryToUrl parse failed, fallback to root', { uid, url }); } catch {}
        return EL_assignEntryToFolderId(uid, null, b);
    }
    // If lorebook in URL differs from target book, ignore lorebook part and only use path.
    // This allows cross-book paste: el://OldBook/A/B/1 pasted into NewBook → path A/B
    if (parsed.lorebook !== b) {
        try { (window.ELLogger||console).info(`[EL:Folder] cross-book url rebase "${parsed.lorebook}" → "${b}" path="${parsed.folderPath}"`); } catch {}
    }
    const folderId = EL_ensureFolderByPath(b, parsed.folderPath);
    const ok = EL_assignEntryToFolderId(uid, folderId, b);
    if (!ok) try { (window.ELLogger||console).warn('[EL:Folder] assignEntryToUrl failed', { uid, url, folderId, bookName:b }); } catch {}
    return ok;
}

function EL_captureUrlMap(uids, bookName) {
    const b = EL_resolveBook(bookName);
    const map = new Map();
    for (const uid of uids) {
        map.set(String(uid), EL_getUrlForUid(uid, b));
    }
    return map;
}

function EL_getFoldersSnapshot(bookName) {
    const b = EL_resolveBook(bookName);
    if (!b) {
        if (_EL_isVerboseFolder()) try { (window.ELLogger||console).debug('[EL:Folder] getFoldersSnapshot null book', bookName); } catch {}
        return [];
    }
    const folders = EL_getFolders(b);
    try {
        return JSON.parse(JSON.stringify(folders));
    } catch (e) {
        if (_EL_isVerboseFolder()) try { (window.ELLogger||console).warn('[EL:Folder] getFoldersSnapshot clone failed, shallow fallback', bookName, e); } catch {}
        return folders.map(f => ({ ...f, entries: [...(f.entries || [])] }));
    }
}

function EL_setFoldersSnapshot(bookName, snapshot) {
    const b = EL_resolveBook(bookName);
    if (!b) return;
    if (!extensionSettings.folders) extensionSettings.folders = {};
    // Validate snapshot is array of folder-like objects
    if (!Array.isArray(snapshot)) {
        extensionSettings.folders[b] = [];
        return;
    }
    // Deep clone to avoid external mutation
    try {
        extensionSettings.folders[b] = JSON.parse(JSON.stringify(snapshot));
    } catch {
        extensionSettings.folders[b] = snapshot.map(f => ({ ...f, entries: [...(f.entries || [])] }));
    }
}

/**
 * After entries have been written (e.g., snapshot restore that overwrites
 * currentLorebookData.entries with same UIDs), ensure every uid referenced
 * by `foldersSnapshot` still exists. Missing uids are pruned, orphan entries
 * become root (which is correct for audit). Then install the snapshot.
 *
 * For cases where UIDs were remapped (e.g., lorebook duplicate with new UIDs),
 * pass uidRemap: Map<oldUidStr, newUidStr> and folders will be rewritten.
 */
function EL_restoreFoldersWithRemap(bookName, foldersSnapshot, uidRemap) {
    const b = EL_resolveBook(bookName);
    if (!b) return;
    let folders = Array.isArray(foldersSnapshot) ? JSON.parse(JSON.stringify(foldersSnapshot)) : [];
    if (uidRemap && uidRemap instanceof Map && uidRemap.size) {
        for (const f of folders) {
            if (!Array.isArray(f.entries)) continue;
            f.entries = f.entries.map(old => {
                const neu = uidRemap.get(String(old));
                return neu !== undefined ? String(neu) : String(old);
            });
        }
    }
    // Prune entries that no longer exist in currentLorebookData
    let existing = new Set();
    try {
        if (typeof currentLorebookData !== 'undefined' && currentLorebookData && currentLorebookData.entries) {
            existing = new Set(Object.keys(currentLorebookData.entries).map(String));
        } else if (typeof stContext !== 'undefined' && stContext) {
            // fallback: no pruning if we can't see entries
            existing = null;
        }
    } catch {
        existing = null;
    }
    if (existing) {
        for (const f of folders) {
            if (!Array.isArray(f.entries)) continue;
            f.entries = f.entries.filter(uid => existing.has(String(uid)));
        }
    }
    EL_setFoldersSnapshot(b, folders);
}

/**
 * Clone a folder subtree (by path) from one book to another, preserving
 * structure. Used for lorebook duplication and folder duplication that must
 * respect URLs. Returns Map<oldFolderId, newFolderId> and uidRemap must be
 * supplied by caller for entry UIDs.
 */
function EL_cloneFolderStructureByPath(sourceBook, targetBook, foldersSnapshot) {
    // foldersSnapshot is already cloned array for source; we just ensure
    // target gets same names/parent chain via path.
    // Simpler: copy entire snapshot and re-id folders to avoid id collision,
    // preserving names/parent links and entries (entries will be remapped by caller).
    const src = Array.isArray(foldersSnapshot) ? foldersSnapshot : EL_getFoldersSnapshot(sourceBook);
    if (!src.length) {
        EL_setFoldersSnapshot(targetBook, []);
        return new Map();
    }
    const idMap = new Map();
    const cloned = src.map(f => {
        const newId = `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        idMap.set(f.id, newId);
        return { ...JSON.parse(JSON.stringify(f)), id: newId };
    });
    // Fix parentId references
    for (const f of cloned) {
        if (f.parentId && idMap.has(f.parentId)) f.parentId = idMap.get(f.parentId);
    }
    EL_setFoldersSnapshot(targetBook, cloned);
    return idMap;
}

// Expose globally for app.js / agent-core.js / tests
if (typeof window !== 'undefined') {
    window.ELFolderUrl = {
        PREFIX: EL_FOLDER_URL_PREFIX,
        resolveBook: EL_resolveBook,
        getFolders: EL_getFolders,
        ensureFoldersArray: EL_ensureFoldersArray,
        findFolderById: EL_findFolderById,
        getFolderIdForUid: EL_getFolderIdForUid,
        getFolderPathById: EL_getFolderPathById,
        getFolderPathForUid: EL_getFolderPathForUid,
        buildUrl: EL_buildUrl,
        getUrlForUid: EL_getUrlForUid,
        parseUrl: EL_parseUrl,
        buildUrlForNewUid: EL_buildUrlForNewUid,
        ensureFolderByPath: EL_ensureFolderByPath,
        assignEntryToFolderId: EL_assignEntryToFolderId,
        assignEntryToUrl: EL_assignEntryToUrl,
        captureUrlMap: EL_captureUrlMap,
        getFoldersSnapshot: EL_getFoldersSnapshot,
        setFoldersSnapshot: EL_setFoldersSnapshot,
        restoreFoldersWithRemap: EL_restoreFoldersWithRemap,
        cloneFolderStructureByPath: EL_cloneFolderStructureByPath,
    };
    // Back-compat aliases
    window.EL_getUrlForUid = EL_getUrlForUid;
    window.EL_parseUrl = EL_parseUrl;
    window.EL_ensureFolderByPath = EL_ensureFolderByPath;
    window.EL_assignEntryToUrl = EL_assignEntryToUrl;
    window.EL_getFolderIdForUid = EL_getFolderIdForUid;
}
