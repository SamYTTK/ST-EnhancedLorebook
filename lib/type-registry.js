/**
 * type-registry.js
 *
 * The entry-type registry of the Enhanced Lorebook workspace. A type is a
 * pure organisational tag plus two optional conveniences:
 *
 *   - `defaults`  — entry settings applied to NEW entries of this type
 *                   (order, position, depth, probability, flags). Missing
 *                   keys mean "leave whatever the create dialog says".
 *   - `presets`   — named, literal content placeholders. Choosing one on
 *                   create drops its text into the entry content verbatim.
 *                   Nothing is parsed, substituted or rendered.
 *
 * A type NEVER touches existing entry content. There is no template, no
 * slot syntax and no compiler. The only thing a type writes on an entry is
 * `extensions.el.type` (the tag).
 *
 * It is deliberately DOM-free: it touches no window, no document, no fetch
 * and no SillyTavern context. The caller passes the store (a plain object,
 * normally the extensionSettings slice) in, so this file can run in two
 * places:
 *   - the app window  (app/index.html loads it as a classic script)
 *   - the host window  (index.js may load the very same file and re-publish
 *     the public API on window.EL)
 * Like apply-core.js it therefore has no imports/exports — it publishes one
 * namespace object, ELTypeRegistry, on the global scope.
 */
(function (global) {
    'use strict';

    // Entry settings a type may pre-fill on creation. Must stay in sync with
    // the create dialogs (quick add / advanced add) and EL_ENTRY_DEFAULTS.
    var DEFAULT_KEYS = Object.freeze([
        'order', 'position', 'role', 'depth', 'probability',
        'constant', 'vectorized', 'selective', 'disable',
        'excludeRecursion', 'preventRecursion',
    ]);

    var BOOL_DEFAULT_KEYS = Object.freeze([
        'constant', 'vectorized', 'selective', 'disable',
        'excludeRecursion', 'preventRecursion',
    ]);

    // Keys that must never become a store id (prototype pollution).
    function isReservedId(id) {
        return id === '__proto__' || id === 'constructor' || id === 'prototype';
    }

    function isObj(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    function str(v, fallback) {
        if (typeof v === 'string') return v;
        if (v === undefined || v === null) return (fallback === undefined ? '' : fallback);
        try { return String(v); } catch (e) { return (fallback === undefined ? '' : fallback); }
    }

    function clone(v) {
        try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); }
        catch (e) { return null; }
    }

    // Slugify a display name into a stable id: lowercase, non-alphanumerics to
    // '-' collapsed and trimmed. Never throws; empty input yields ''.
    /**
     * Slugify a display name into a stable id ('my-type-2' style).
     * Never throws; empty input yields ''.
     */
    function slug(name) {
        try {
            return str(name, '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .replace(/-{2,}/g, '-');
        } catch (e) { return ''; }
    }

    function normName(v) {
        return str(v, '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
    }

    /**
     * Default type object shape. id is the slug of the name ('type' fallback).
     * defaults is an empty map (all settings left to the dialog) and presets
     * is an empty list.
     */
    function blankType(name) {
        var n = str(name, '').trim() || 'Untitled Type';
        var blankId = slug(n) || 'type';
        if (isReservedId(blankId)) blankId = 'type';
        return {
            id: blankId,
            name: n,
            icon: '',
            accent: '',
            defaults: {},
            presets: [],
        };
    }

    function cleanDefaultValue(key, value) {
        if (BOOL_DEFAULT_KEYS.indexOf(key) !== -1) {
            if (value === true || value === false) return value;
            if (value === 1 || value === 0) return !!value;
            if (typeof value === 'string') {
                var low = value.trim().toLowerCase();
                if (low === 'true' || low === 'on' || low === 'yes') return true;
                if (low === 'false' || low === 'off' || low === 'no') return false;
            }
            return undefined;
        }
        var n = parseInt(value, 10);
        if (!isFinite(n)) return undefined;
        if (key === 'probability') return Math.max(0, Math.min(100, n));
        if (key === 'role') return (n >= 0 && n <= 2) ? n : undefined;
        if (key === 'position') return (n >= 0 && n <= 7) ? n : undefined;
        return Math.max(0, n);
    }

    function sanitizeDefaults(raw, warnings) {
        var out = {};
        if (raw === undefined || raw === null) return out;
        if (!isObj(raw)) {
            warnings.push('defaults is not an object - ignored.');
            return out;
        }
        for (var i = 0; i < DEFAULT_KEYS.length; i++) {
            var key = DEFAULT_KEYS[i];
            if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
            var v = cleanDefaultValue(key, raw[key]);
            if (v === undefined) {
                warnings.push('default "' + key + '" has an invalid value - dropped.');
                continue;
            }
            out[key] = v;
        }
        // SillyTavern treats constant and vectorized as mutually exclusive; a
        // type default may carry both, so keep constant and drop vectorized.
        if (out.constant === true && out.vectorized === true) {
            delete out.vectorized;
            warnings.push('defaults enabled both constant and vectorized - constant kept, vectorized dropped.');
        }
        return out;
    }

    function sanitizePreset(raw, warnings, where, seenIds, seenNames) {
        if (!isObj(raw)) {
            warnings.push(where + ' is not an object - dropped.');
            return null;
        }
        var name = str(raw.name, '').trim();
        if (!name) {
            warnings.push(where + ' has no name - dropped.');
            return null;
        }
        var content = (typeof raw.content === 'string') ? raw.content : str(raw.content, '');
        var id = str(raw.id, '').trim() || slug(name) || 'preset';
        if (seenIds[id]) {
            var base = id;
            var n = 2;
            while (seenIds[base + '-' + n]) n++;
            id = base + '-' + n;
            warnings.push(where + ' "' + name + '": duplicate id - renamed to "' + id + '".');
        }
        seenIds[id] = true;
        var nn = normName(name);
        if (seenNames[nn]) warnings.push(where + ' "' + name + '" repeats an earlier preset name.');
        else seenNames[nn] = true;
        return { id: id, name: name, content: content };
    }

    function sanitizePresets(raw, warnings) {
        var out = [];
        if (raw === undefined || raw === null) return out;
        if (!Array.isArray(raw)) {
            warnings.push('presets is not an array - replaced with an empty list.');
            return out;
        }
        var seenIds = {};
        var seenNames = {};
        for (var i = 0; i < raw.length; i++) {
            var p = sanitizePreset(raw[i], warnings, 'preset #' + (i + 1), seenIds, seenNames);
            if (p) out.push(p);
        }
        return out;
    }

    /**
     * Tolerant cleaner: returns {type, warnings[]}. Backfills the current
     * shape and drops anything the type no longer owns (sections, slots,
     * limiter tags, reorder/keyMain/keySec/cssPath, ...). Never throws on bad
     * input — a non-object yields a blank type plus a warning.
     */
    function sanitizeType(t) {
        var warnings = [];
        try {
            if (!isObj(t)) return { type: blankType('Untitled Type'), warnings: ['input is not an object - returned a blank type.'] };
            var base = blankType(t.name);
            var rawId = str(t.id, '').trim();
            if (isReservedId(rawId)) rawId = '';
            var type = {
                id: rawId || base.id,
                name: str(t.name, '').trim() || base.name,
                icon: str(t.icon, ''),
                accent: str(t.accent, ''),
                defaults: sanitizeDefaults(t.defaults, warnings),
                presets: sanitizePresets(t.presets, warnings),
            };
            return { type: type, warnings: warnings };
        } catch (e) {
            try { warnings.push('sanitize failed (' + (e && e.message ? e.message : e) + ') - returned best-effort result.'); } catch (e2) { /* ignore */ }
            return { type: blankType('Untitled Type'), warnings: warnings };
        }
    }

    /**
     * Strict checker: returns {ok, errors[]}. A type needs a name, an id and
     * a well-formed presets list; preset names must be non-empty and unique.
     */
    function validateType(t) {
        var errors = [];
        if (!isObj(t)) return { ok: false, errors: ['type must be an object.'] };
        if (!str(t.name, '').trim()) errors.push('name must be a non-empty string.');
        if (!str(t.id, '').trim()) errors.push('id must be a non-empty string.');
        if (t.defaults !== undefined && t.defaults !== null && !isObj(t.defaults)) {
            errors.push('defaults must be an object.');
        }
        if (t.presets !== undefined && t.presets !== null) {
            if (!Array.isArray(t.presets)) {
                errors.push('presets must be an array.');
            } else {
                var seenIds = {};
                var seenNames = {};
                for (var i = 0; i < t.presets.length; i++) {
                    var p = t.presets[i];
                    var where = 'preset #' + (i + 1);
                    if (!isObj(p)) { errors.push(where + ' is not an object.'); continue; }
                    var pid = str(p.id, '').trim();
                    if (!pid) errors.push(where + ': id must be a non-empty string.');
                    else if (seenIds[pid]) errors.push(where + ': duplicate preset id "' + pid + '".');
                    else seenIds[pid] = true;
                    var name = str(p.name, '').trim();
                    if (!name) { errors.push(where + ': name must be a non-empty string.'); continue; }
                    var nn = normName(name);
                    if (seenNames[nn]) errors.push(where + ': duplicate preset name "' + name + '".');
                    else seenNames[nn] = true;
                    if (p.content !== undefined && typeof p.content !== 'string') {
                        errors.push(where + ' "' + name + '": content must be a string.');
                    }
                }
            }
        }
        return { ok: errors.length === 0, errors: errors };
    }

    // ── Plain-object store helpers ───────────────────────────────────────────
    // `store` is always caller-owned (normally the extensionSettings slice);
    // this file never touches any global. Keys are type ids.

    /**
     * List all stored types as cleaned clones. Mutating the result never
     * touches the store.
     */
    function listTypes(store) {
        if (!isObj(store)) return [];
        return Object.keys(store).filter(function (k) {
            return Object.prototype.hasOwnProperty.call(store, k) && isObj(store[k]);
        }).map(function (k) { return sanitizeType(store[k]).type; });
    }

    /**
     * Fetch one type by id as a cleaned clone (null when missing). Legacy
     * shapes are cleaned on read, so the rest of the app only ever sees the
     * current shape even before a migration pass runs.
     */
    function getType(store, id) {
        if (!isObj(store)) return null;
        var key = str(id, '');
        if (!Object.prototype.hasOwnProperty.call(store, key)) return null;
        var t = store[key];
        return isObj(t) ? sanitizeType(t).type : null;
    }

    /**
     * Stores a sanitized clone (putType never keeps the caller's reference, so
     * later caller-side mutation cannot corrupt the store). Returns
     * {type, warnings[]} — a fresh clone of what was stored plus sanitize
     * warnings; when the store itself is unusable, or the id is a
     * prototype-polluting key, nothing is stored and type is null.
     */
    function putType(store, t) {
        var cleaned = sanitizeType(t);
        if (!isObj(store)) {
            cleaned.warnings.push('store is not an object - nothing was stored.');
            return { type: null, warnings: cleaned.warnings };
        }
        var id = cleaned.type && cleaned.type.id;
        if (isReservedId(id)) {
            cleaned.warnings.push('refused to store type with reserved id "' + id + '" - nothing was stored.');
            return { type: null, warnings: cleaned.warnings };
        }
        var stored = clone(cleaned.type);
        store[stored.id] = stored;
        return { type: clone(stored), warnings: cleaned.warnings };
    }

    /**
     * Remove one type by id. Returns true when an own-property entry was
     * deleted, false otherwise.
     */
    function deleteType(store, id) {
        if (!isObj(store)) return false;
        var key = str(id, '');
        if (!Object.prototype.hasOwnProperty.call(store, key)) return false;
        delete store[key];
        return true;
    }

    /**
     * One preset of a type by id ('') when missing.
     */
    function getPreset(type, id) {
        try {
            var list = (type && Array.isArray(type.presets)) ? type.presets : [];
            var key = str(id, '');
            for (var i = 0; i < list.length; i++) {
                if (str(list[i].id, '') === key) return clone(list[i]);
            }
        } catch (e) { /* tolerant */ }
        return null;
    }

    // ── Migration ────────────────────────────────────────────────────────────

    // A stored type is "legacy" when it still carries fields/types the old
    // template system owned. Used only for notes/reporting; sanitizeType
    // drops them either way.
    function isLegacyType(t) {
        if (!isObj(t)) return false;
        if (t.sections !== undefined || t.tag !== undefined || t.reorder !== undefined) return true;
        if (t.keyMain !== undefined || t.keySec !== undefined || t.cssPath !== undefined) return true;
        return false;
    }

    /**
     * Rewrite every stored type into the current shape, in place. Legacy
     * template fields (sections/slots/limiter) are dropped; entry content is
     * never touched by this (or any) migration. Built-in types that predate
     * presets get their starter presets seeded once — only when the stored
     * object has no `presets` key at all, so user deletions are not undone.
     *
     * @returns {{changed: number, warnings: string[]}}
     */
    function migrateStore(store) {
        var changed = 0;
        var warnings = [];
        if (!isObj(store)) return { changed: 0, warnings: warnings };
        var keys = Object.keys(store);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var raw = store[key];
            if (!isObj(raw)) continue;
            var res = sanitizeType(raw);
            var next = res.type;
            var seededPresets = false;
            if (next && BUILTIN_TYPES[next.id] && raw.presets === undefined) {
                var builtin = BUILTIN_TYPES[next.id];
                if (builtin.presets && builtin.presets.length) {
                    next.presets = clone(builtin.presets);
                    seededPresets = true;
                }
            }
            var before = '';
            var after = '';
            try { before = JSON.stringify(raw); } catch (e) { before = ''; }
            try { after = JSON.stringify(next); } catch (e) { after = ''; }
            if (isReservedId(next.id)) {
                warnings.push(key + ': reserved id "' + next.id + '" - left untouched.');
                continue;
            }
            // The store key always follows the sanitized id so lookups stay
            // consistent (ids are the storage key everywhere else). Never
            // overwrite a different type that already owns the target id.
            if (next.id !== key) {
                if (Object.prototype.hasOwnProperty.call(store, next.id)) {
                    warnings.push(key + ': id "' + next.id + '" already belongs to another stored type - left untouched.');
                    continue;
                }
                delete store[key];
            }
            if (before !== after || isLegacyType(raw) || seededPresets || next.id !== key) {
                store[next.id] = clone(next);
                changed++;
            }
            for (var w = 0; w < res.warnings.length; w++) warnings.push(key + ': ' + res.warnings[w]);
        }
        return { changed: changed, warnings: warnings };
    }

    // ── Built-in types ───────────────────────────────────────────────────────
    // Two starter tags with one plain-text preset each. No defaults: a new
    // Character/Location entry keeps whatever the create dialog says unless
    // the user sets defaults themselves.

    function buildCharacter() {
        return {
            id: 'character',
            name: 'Character',
            icon: '👤',
            accent: '#7c6cf0',
            defaults: {},
            presets: [
                {
                    id: 'character-sheet',
                    name: 'Character sheet',
                    content: [
                        'Name:',
                        'Codename:',
                        'Age:',
                        'Gender:',
                        'Height:',
                        'Date of Birth:',
                        'Place of Birth:',
                        'Appearance:',
                        'Personality:',
                        'Mannerisms & Preferences:',
                        'Voice:',
                        'Key Motivations:',
                        'Sexuality:',
                        'Origin:',
                        'Abilities:',
                        'Instructions:',
                    ].join('\n'),
                },
            ],
        };
    }

    function buildLocation() {
        return {
            id: 'location',
            name: 'Location',
            icon: '📍',
            accent: '#3aa17e',
            defaults: {},
            presets: [
                {
                    id: 'location-sheet',
                    name: 'Location sheet',
                    content: [
                        'Name:',
                        'Type:',
                        'Region:',
                        'Coordinates:',
                        'Description:',
                        'Notable:',
                    ].join('\n'),
                },
            ],
        };
    }

    // Ready-made store-shaped presets (also usable directly as a store).
    // Deep-frozen: callers must clone (getType/listTypes do) before mutating.
    function deepFreeze(v) {
        if (v && typeof v === 'object' && !Object.isFrozen(v)) {
            Object.freeze(v);
            for (var k in v) {
                if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
            }
        }
        return v;
    }

    var BUILTIN_TYPES = deepFreeze({
        character: buildCharacter(),
        location: buildLocation(),
    });

    global.ELTypeRegistry = {
        DEFAULT_KEYS: DEFAULT_KEYS,
        BOOL_DEFAULT_KEYS: BOOL_DEFAULT_KEYS,
        slug: slug,
        blankType: blankType,
        sanitizeType: sanitizeType,
        validateType: validateType,
        listTypes: listTypes,
        getType: getType,
        putType: putType,
        deleteType: deleteType,
        getPreset: getPreset,
        migrateStore: migrateStore,
        BUILTIN_TYPES: BUILTIN_TYPES,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
