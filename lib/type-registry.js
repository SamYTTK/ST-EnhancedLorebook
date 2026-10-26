/**
 * type-registry.js
 *
 * The entry-type registry of the Enhanced Lorebook revamp (Track A1). It holds:
 *   - the default type object shape (blankType)
 *   - the tolerant input cleaner (sanitizeType — never throws)
 *   - the strict shape checker (validateType)
 *   - the plain-object store helpers (listTypes / getType / putType / deleteType)
 *   - the two built-in presets (BUILTIN_TYPES: Character + Location)
 *
 * It is deliberately DOM-free: it touches no window, no document, no fetch and
 * no SillyTavern context. The caller passes the store (a plain object, normally
 * the extensionSettings slice) in, so this file can run in two places:
 *   - the app window  (app/index.html loads it as a classic script)
 *   - the host window  (index.js may load the very same file and re-publish the
 *     public API on window.EL)
 * Like apply-core.js it therefore has no imports/exports — it publishes one
 * namespace object, ELTypeRegistry, on the global scope.
 */
(function (global) {
    'use strict';

    // Slot kinds the revamp understands. Must stay in sync with the slot parser
    // (lib/slot-parse.js ELSLOTS_KINDS): sanitizeType drops slots whose kind is
    // not listed here, validateType flags them.
    var KNOWN_KINDS = Object.freeze([
        'cont', 'img', 'ref', 'gallery', 'radar', 'display',
        'conditional', 'setref', 'getref', 'hub',
    ]);

    // Slot-level parameter keys carried flat on the slot object
    // ({kind, label, limit, inject, axes, hide, keys, when, else, target, def}).
    // Unknown extra keys are passed through untouched (forward compatibility);
    // only unknown KINDS cause a slot to be dropped.
    var KNOWN_PARAMS = Object.freeze([
        'limit', 'inject', 'axes', 'hide', 'keys', 'when', 'else', 'target', 'def',
    ]);

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

    function normLabel(label) {
        return str(label, '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
    }

    /**
     * Default type object shape. id is the slug of the name ('type' fallback).
     */
    function blankType(name) {
        var n = str(name, '').trim() || 'Untitled Type';
        return {
            id: slug(n) || 'type',
            name: n,
            icon: '',
            accent: '',
            tag: '',
            reorder: true,
            keyMain: 'none',
            keySec: 'none',
            cssPath: '',
            sections: [{ title: 'General', slots: [] }],
        };
    }

    function coerceSlotParams(slot, warnings, where) {
        var out = { kind: slot.kind, label: str(slot.label, '').trim() };
        if (slot.hide !== undefined) {
            var hs = (typeof slot.hide === 'string') ? slot.hide.toLowerCase() : slot.hide;
            out.hide = !(hs === false || hs === 0 || hs === 'false' || hs === 'off' || hs === '0');
        }
        if (slot.limit !== undefined && slot.limit !== null && slot.limit !== '') {
            var n = parseInt(slot.limit, 10);
            if (isFinite(n) && n >= 0) out.limit = n;
            else warnings.push(where + ': slot "' + out.label + '" has an invalid limit — dropped the limit.');
        }
        var stringKeys = ['inject', 'axes', 'keys', 'when', 'else', 'target', 'def'];
        for (var i = 0; i < stringKeys.length; i++) {
            var k = stringKeys[i];
            if (slot[k] !== undefined && slot[k] !== null && slot[k] !== '') out[k] = str(slot[k], '');
        }
        // Forward compatibility: keep anything else the caller attached.
        for (var key in slot) {
            if (!Object.prototype.hasOwnProperty.call(slot, key)) continue;
            if (key === 'kind' || key === 'label') continue;
            if (key === 'hide' || key === 'limit' || stringKeys.indexOf(key) !== -1) continue;
            out[key] = clone(slot[key]);
        }
        return out;
    }

    /**
     * Tolerant cleaner: returns {type, warnings[]}. Unknown-kind or
     * label-less slots are dropped (one warning each); everything else is
     * backfilled with defaults. Never throws on bad input — a non-object
     * yields a blank type plus a warning.
     */
    function sanitizeType(t) {
        var warnings = [];
        try {
            if (!isObj(t)) return { type: blankType('Untitled Type'), warnings: ['input is not an object — returned a blank type.'] };
            var base = blankType(t.name);
            var type = {
                id: str(t.id, '').trim() || base.id,
                name: str(t.name, '').trim() || base.name,
                icon: str(t.icon, ''),
                accent: str(t.accent, ''),
                tag: str(t.tag, ''),
                reorder: (t.reorder === undefined || t.reorder === null) ? true : !!t.reorder,
                keyMain: str(t.keyMain, 'none') || 'none',
                keySec: str(t.keySec, 'none') || 'none',
                cssPath: str(t.cssPath, ''),
                sections: [],
            };
            var rawSections = Array.isArray(t.sections) ? t.sections : null;
            if (!rawSections) {
                warnings.push('sections is not an array — replaced with an empty list.');
            } else {
                for (var s = 0; s < rawSections.length; s++) {
                    var rs = rawSections[s];
                    var where = 'section #' + (s + 1);
                    if (!isObj(rs)) { warnings.push(where + ' is not an object — skipped.'); continue; }
                    var section = { title: str(rs.title, ''), slots: [] };
                    var rawSlots = Array.isArray(rs.slots) ? rs.slots : null;
                    if (!rawSlots) {
                        warnings.push(where + ' "' + section.title + '": slots is not an array — emptied.');
                    } else {
                        for (var i = 0; i < rawSlots.length; i++) {
                            var rsl = rawSlots[i];
                            var loc = where + ' slot #' + (i + 1);
                            if (!isObj(rsl)) { warnings.push(loc + ' is not an object — dropped.'); continue; }
                            var kind = str(rsl.kind, '').trim().toLowerCase();
                            var label = str(rsl.label, '').trim();
                            if (!label) { warnings.push(loc + ' has no label — dropped.'); continue; }
                            if (KNOWN_KINDS.indexOf(kind) === -1) { warnings.push(loc + ' "' + label + '": unknown kind "' + str(rsl.kind, '') + '" — dropped.'); continue; }
                            var cleaned = coerceSlotParams(rsl, warnings, where);
                            cleaned.kind = kind;
                            cleaned.label = label;
                            section.slots.push(cleaned);
                        }
                    }
                    type.sections.push(section);
                }
            }
            return { type: type, warnings: warnings };
        } catch (e) {
            try { warnings.push('sanitize failed (' + (e && e.message ? e.message : e) + ') — returned best-effort result.'); } catch (e2) { /* ignore */ }
            return { type: blankType('Untitled Type'), warnings: warnings };
        }
    }

    /**
     * Strict checker: returns {ok, errors[]}. Flags an empty tag, unknown
     * kinds, label-less slots and duplicate slot labels (compared
     * type-wide, case/underscore/space-insensitive — labels back the
     * match-by-label value extraction, so they must be unique).
     */
    function validateType(t) {
        var errors = [];
        if (!isObj(t)) return { ok: false, errors: ['type must be an object.'] };
        if (!str(t.name, '').trim()) errors.push('name must be a non-empty string.');
        if (!str(t.id, '').trim()) errors.push('id must be a non-empty string.');
        if (!str(t.tag, '').trim()) errors.push('tag must be a non-empty string (it names the <tag> limiter).');
        if (!Array.isArray(t.sections) || t.sections.length === 0) {
            errors.push('at least one section is required.');
        } else {
            var seen = {};
            for (var s = 0; s < t.sections.length; s++) {
                var sec = t.sections[s];
                var where = 'section #' + (s + 1);
                if (!isObj(sec)) { errors.push(where + ' is not an object.'); continue; }
                if (!Array.isArray(sec.slots)) { errors.push(where + ' "' + str(sec.title, '') + '": slots must be an array.'); continue; }
                for (var i = 0; i < sec.slots.length; i++) {
                    var sl = sec.slots[i];
                    var loc = where + ' slot #' + (i + 1);
                    if (!isObj(sl)) { errors.push(loc + ' is not an object.'); continue; }
                    var kind = str(sl.kind, '').trim().toLowerCase();
                    if (KNOWN_KINDS.indexOf(kind) === -1) errors.push(loc + ': unknown kind "' + str(sl.kind, '') + '".');
                    var label = str(sl.label, '').trim();
                    if (!label) { errors.push(loc + ': label must be a non-empty string.'); continue; }
                    var nl = normLabel(label);
                    if (Object.prototype.hasOwnProperty.call(seen, nl)) {
                        errors.push(loc + ': duplicate slot label "' + label + '" (first seen in ' + seen[nl] + ').');
                    } else {
                        seen[nl] = loc;
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
     * List all stored types. Returns deep clones — mutating the result never
     * touches the store.
     */
    function listTypes(store) {
        if (!isObj(store)) return [];
        return Object.keys(store).filter(function (k) {
            return Object.prototype.hasOwnProperty.call(store, k) && isObj(store[k]);
        }).map(function (k) { return clone(store[k]); });
    }

    /**
     * Fetch one type by id. Returns a deep clone (null when missing) — the
     * caller never holds a live store reference.
     */
    function getType(store, id) {
        if (!isObj(store)) return null;
        var key = str(id, '');
        if (!Object.prototype.hasOwnProperty.call(store, key)) return null;
        var t = store[key];
        return isObj(t) ? clone(t) : null;
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
            cleaned.warnings.push('store is not an object — nothing was stored.');
            return { type: null, warnings: cleaned.warnings };
        }
        var id = cleaned.type && cleaned.type.id;
        if (id === '__proto__' || id === 'constructor' || id === 'prototype') {
            cleaned.warnings.push('refused to store type with reserved id "' + id + '" — nothing was stored.');
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

    // ── Built-in presets ─────────────────────────────────────────────────────
    function cont(label, extra) {
        var s = { kind: 'cont', label: label };
        if (isObj(extra)) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) s[k] = extra[k];
        return s;
    }

    function buildCharacter() {
        return {
            id: 'character',
            name: 'Character',
            icon: '👤',
            accent: '#7c6cf0',
            tag: 'char_name',
            reorder: true,
            keyMain: 'none',
            keySec: 'none',
            cssPath: '',
            sections: [
                { title: 'Identity', slots: [
                    cont('Name', { keys: 'main' }),
                    { kind: 'img', label: 'Portrait' },
                    cont('Codename', { hide: true }),
                    cont('Age', { hide: true }),
                    cont('Gender', { hide: true }),
                    cont('Height', { hide: true }),
                    cont('Date of Birth', { hide: true }),
                    cont('Place of Birth', { hide: true }),
                ] },
                { title: 'Basic Information', slots: [
                    cont('Appearance'),
                    cont('Personality'),
                    cont('Mannerisms & Preferences'),
                    cont('Voice'),
                    cont('Key Motivations'),
                    cont('Sexuality'),
                ] },
                { title: 'Background', slots: [
                    cont('Origin'),
                ] },
                { title: 'Ability Profile', slots: [
                    { kind: 'radar', label: 'Stats', axes: 'Strength,Agility,Intelligence,Willpower,Charm,Stamina' },
                    cont('Abilities'),
                ] },
                { title: 'Gallery', slots: [
                    { kind: 'gallery', label: 'Photos', inject: 'off' },
                ] },
                { title: 'Relationships', slots: [
                    { kind: 'ref', label: 'Connections', limit: 3 },
                    { kind: 'conditional', label: 'Current_Location', when: 'map-placed', else: 'Unknown' },
                ] },
                { title: 'System', slots: [
                    cont('Instructions'),
                ] },
            ],
        };
    }

    function buildLocation() {
        return {
            id: 'location',
            name: 'Location',
            icon: '📍',
            accent: '#3aa17e',
            tag: 'location',
            reorder: true,
            keyMain: 'none',
            keySec: 'none',
            cssPath: '',
            sections: [
                { title: 'General', slots: [
                    cont('Name', { keys: 'main' }),
                    cont('Type'),
                    { kind: 'ref', label: 'Region', limit: 1 },
                    cont('Coordinates'),
                ] },
                { title: 'Details', slots: [
                    cont('Description'),
                    cont('Notable'),
                ] },
                { title: 'Media', slots: [
                    { kind: 'img', label: 'Map image' },
                ] },
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
        KNOWN_KINDS: KNOWN_KINDS,
        KNOWN_PARAMS: KNOWN_PARAMS,
        slug: slug,
        blankType: blankType,
        sanitizeType: sanitizeType,
        validateType: validateType,
        listTypes: listTypes,
        getType: getType,
        putType: putType,
        deleteType: deleteType,
        BUILTIN_TYPES: BUILTIN_TYPES,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
