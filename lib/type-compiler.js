/**
 * type-compiler.js
 *
 * The entry compiler of the Enhanced Lorebook revamp (Track A3). It turns a
 * sanitized type (lib/type-registry.js) plus a live ST entry into canonical
 * content, key patches and ref edges, using the slot template machinery
 * (lib/slot-parse.js) for all text work and the dependency index shape
 * (lib/dep-index.js) for the ref edges it records.
 *
 * It is deliberately DOM-free: pure string/data functions only, no window, no
 * document, no fetch. Like the other lib files it has no imports/exports — it
 * publishes one namespace object, ELCompile, on the global scope, so the SAME
 * file runs in the app window and the host window.
 */
(function (global) {
    'use strict';

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

    function normLabel(label) {
        return str(label, '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
    }

    function truncate(s, n) {
        var text = str(s, '');
        if (text.length > n) return text.slice(0, n) + '…';
        return text;
    }

    function detectEol(text) {
        return text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
    }

    var RE_OPEN = /^\s*\*\*<\s*([^<>\s][^<>]*?)\s*>\*\*\s*$/;
    var RE_CLOSE = /^\s*\*\*<\s*\/\s*([^<>\s][^<>]*?)\s*>\*\*\s*$/;

    /**
     * Convert a sanitized type object ({tag, sections:[{title, slots}]}) into
     * a slot-parse AST ({tag, sections:[{title, blocks}]}). Display-kind slots
     * become display blocks (their label holds the comma-separated show list);
     * every other slot becomes one slot block carrying its flat params.
     */
    function typeToAst(type) {
        var tag = (type && typeof type.tag === 'string') ? type.tag : str(type && type.tag, '');
        var sections = [];
        try {
            var raw = (type && Array.isArray(type.sections)) ? type.sections : [];
            for (var s = 0; s < raw.length; s++) {
                var sec = raw[s] || {};
                var out = { title: str(sec.title, ''), blocks: [] };
                var rawSlots = Array.isArray(sec.slots) ? sec.slots : [];
                for (var i = 0; i < rawSlots.length; i++) {
                    var sl = rawSlots[i] || {};
                    var kind = str(sl.kind, 'cont').trim().toLowerCase() || 'cont';
                    var label = str(sl.label, '').trim();
                    if (!label) continue;
                    if (kind === 'display') {
                        var labels = label.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return !!x; });
                        out.blocks.push({ t: 'display', labels: labels });
                        continue;
                    }
                    var params = {};
                    if (sl.hide !== undefined && sl.hide !== null && sl.hide !== '') params.hide = sl.hide;
                    if (sl.limit !== undefined && sl.limit !== null && sl.limit !== '') params.limit = sl.limit;
                    var keys = ['inject', 'axes', 'keys', 'when', 'else', 'target', 'def'];
                    for (var k = 0; k < keys.length; k++) {
                        if (sl[keys[k]] !== undefined && sl[keys[k]] !== null && sl[keys[k]] !== '') {
                            params[keys[k]] = sl[keys[k]];
                        }
                    }
                    out.blocks.push({ t: 'slot', kind: kind, label: label, params: params });
                }
                sections.push(out);
            }
        } catch (e) { /* tolerant: return sections collected so far */ }
        return { tag: tag, sections: sections };
    }

    /**
     * Accept either a slot-parse AST (sections carry blocks) or a type object
     * (sections carry slots); anything else becomes an empty AST.
     */
    function normalizeAst(ast) {
        try {
            if (ast && typeof ast === 'object' && Array.isArray(ast.sections) && ast.sections.length) {
                var first = ast.sections[0] || {};
                if (Array.isArray(first.blocks)) return clone(ast);
                if (Array.isArray(first.slots)) return typeToAst(ast);
            }
            if (ast && typeof ast === 'object' && Array.isArray(ast.sections)) return clone(ast);
        } catch (e) { /* fall through */ }
        return { tag: '', sections: [] };
    }

    /**
     * Value-bearing slots of a type in template order: [{kind, label, limit}].
     * Display-kind and label-less slots carry no value and are skipped.
     */
    function valueSlots(type) {
        var out = [];
        try {
            var raw = (type && Array.isArray(type.sections)) ? type.sections : [];
            for (var s = 0; s < raw.length; s++) {
                var sec = raw[s] || {};
                var list = Array.isArray(sec.slots) ? sec.slots : [];
                for (var i = 0; i < list.length; i++) {
                    var sl = list[i] || {};
                    var kind = str(sl.kind, '').trim().toLowerCase();
                    var label = str(sl.label, '').trim();
                    if (!label || kind === 'display') continue;
                    out.push({ kind: kind || 'cont', label: label, limit: sl.limit });
                }
            }
        } catch (e) { /* tolerant */ }
        return out;
    }

    function slotKindOf(type, canonLabel) {
        var want = normLabel(canonLabel);
        var list = valueSlots(type);
        for (var i = 0; i < list.length; i++) {
            if (normLabel(list[i].label) === want) return list[i].kind;
        }
        var raw = (type && Array.isArray(type.sections)) ? type.sections : [];
        for (var s = 0; s < raw.length; s++) {
            var inner = ((raw[s] || {}).slots) || [];
            for (var j = 0; j < inner.length; j++) {
                var sl = inner[j] || {};
                if (normLabel(sl.label) === want) return str(sl.kind, '').trim().toLowerCase();
            }
        }
        return '';
    }

    /**
     * Type-level fallbacks for renderContent: {label: def} for every slot that
     * declares a `def`. (`else` already travels inside the slot params; `def`
     * has no AST home, so this map is the bridge.)
     */
    function typeFallbacks(type) {
        var fb = {};
        try {
            var raw = (type && Array.isArray(type.sections)) ? type.sections : [];
            for (var s = 0; s < raw.length; s++) {
                var list = ((raw[s] || {}).slots) || [];
                if (!Array.isArray(list)) continue;
                for (var i = 0; i < list.length; i++) {
                    var sl = list[i] || {};
                    var label = str(sl.label, '').trim();
                    if (label && sl.def !== undefined && sl.def !== null && sl.def !== '') {
                        fb[label] = str(sl.def, '');
                    }
                }
            }
        } catch (e) { /* tolerant */ }
        return fb;
    }

    function lookupValue(values, label) {
        if (!values || typeof values !== 'object') return '';
        if (Object.prototype.hasOwnProperty.call(values, label)) {
            var v = values[label];
            return (v === undefined || v === null) ? '' : str(v, '');
        }
        var want = normLabel(label);
        for (var k in values) {
            if (Object.prototype.hasOwnProperty.call(values, k) && normLabel(k) === want) {
                var w = values[k];
                return (w === undefined || w === null) ? '' : str(w, '');
            }
        }
        return '';
    }

    function canonicalLabel(values, name) {
        if (!values || typeof values !== 'object') return null;
        if (Object.prototype.hasOwnProperty.call(values, name)) return name;
        var want = normLabel(name);
        for (var k in values) {
            if (Object.prototype.hasOwnProperty.call(values, k) && normLabel(k) === want) return k;
        }
        return null;
    }

    /**
     * Merge override values (keyed by slot label) over base values.
     * Override keys match base keys case/underscore/space-insensitively;
     * unknown override keys are kept as-is. Never mutates either input.
     */
    function mergeValues(base, overrides) {
        var out = {};
        var normMap = {};
        if (base && typeof base === 'object') {
            for (var k in base) {
                if (!Object.prototype.hasOwnProperty.call(base, k)) continue;
                out[k] = base[k];
                var nk = normLabel(k);
                if (!Object.prototype.hasOwnProperty.call(normMap, nk)) normMap[nk] = k;
            }
        }
        if (overrides && typeof overrides === 'object') {
            for (var k2 in overrides) {
                if (!Object.prototype.hasOwnProperty.call(overrides, k2)) continue;
                var want = normLabel(k2);
                if (Object.prototype.hasOwnProperty.call(normMap, want)) {
                    out[normMap[want]] = overrides[k2];
                } else {
                    out[k2] = overrides[k2];
                    normMap[want] = k2;
                }
            }
        }
        return out;
    }

    function safeExtract(content, ast) {
        var out = { values: {}, extra: [] };
        try {
            var ELS = global.ELSlots;
            if (ELS && typeof ELS.extractValues === 'function') {
                var ex = ELS.extractValues(content, ast);
                if (ex && typeof ex === 'object') {
                    if (ex.values && typeof ex.values === 'object') out.values = ex.values;
                    if (Array.isArray(ex.extra)) out.extra = ex.extra;
                }
            }
        } catch (e) { /* tolerant: empty extraction */ }
        return out;
    }

    function collectRefs(type, values, opts, warnings) {
        var refs = [];
        var list = valueSlots(type);
        var refSlots = list.filter(function (s) { return s.kind === 'ref'; });
        if (!refSlots.length) return refs;
        var pairs = [];
        for (var s = 0; s < refSlots.length; s++) {
            var label = refSlots[s].label;
            var raw = str(lookupValue(values, label), '');
            var names = raw.split(/[,\n;]+/).map(function (n) { return n.trim(); }).filter(function (n) { return !!n; });
            var lim = refSlots[s].limit;
            if (lim !== undefined && lim !== null && lim !== '') {
                var n = +lim;
                if (!isFinite(n) || n < 0) {
                    warnings.push('slot "' + label + '" has an invalid limit — dropped the limit.');
                } else if (names.length > n) {
                    warnings.push('slot "' + label + '" lists ' + names.length + ' ref(s) but allows ' + n + ' — kept the first ' + n + '.');
                    names = names.slice(0, n);
                }
            }
            for (var i = 0; i < names.length; i++) pairs.push({ label: label, name: names[i] });
        }
        if (!pairs.length) return refs;
        var lookup = (opts && typeof opts.lookupName === 'function') ? opts.lookupName : null;
        if (!lookup) {
            warnings.push('no lookupName provided — ' + pairs.length + ' ref name(s) left as plain text.');
            return refs;
        }
        var seen = {};
        for (var p = 0; p < pairs.length; p++) {
            var uid = null;
            try { uid = lookup(pairs[p].name); } catch (e) { uid = null; }
            uid = str(uid, '');
            if (!uid) {
                warnings.push('ref "' + pairs[p].name + '" in slot "' + pairs[p].label + '" did not resolve — kept as plain text.');
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(seen, uid)) continue;
            seen[uid] = true;
            refs.push({ kind: pairs[p].label, target: { uid: uid } });
        }
        return refs;
    }

    function keyEntry(which, values, role, type, warnings) {
        var name = str(which, '').trim();
        if (!name || name.toLowerCase() === 'none') return { present: false, keys: [] };
        var canon = canonicalLabel(values, name);
        var prop = role === 'keyMain' ? 'key' : role;
        if (!canon) {
            warnings.push(role + ' "' + name + '" matches no type slot — ' + prop + ' left empty.');
            return { present: true, keys: [] };
        }
        var kind = slotKindOf(type, canon);
        if (kind && kind !== 'cont' && kind !== 'conditional') {
            warnings.push(role + ' "' + name + '" points at a ' + kind + ' slot — derived keys from its text value anyway.');
        }
        var v = str(values[canon], '').trim();
        if (!v) return { present: true, keys: [] };
        return { present: true, keys: [v] };
    }

    function buildPatch(type, values, warnings) {
        var patch = {};
        var main = keyEntry(type ? type.keyMain : '', values, 'keyMain', type, warnings);
        if (main.present) patch.key = main.keys;
        var sec = keyEntry(type ? type.keySec : '', values, 'keysecondary', type, warnings);
        if (sec.present) patch.keysecondary = sec.keys;
        return patch;
    }

    function warnEmptySlots(type, values, warnings) {
        var list = valueSlots(type);
        for (var i = 0; i < list.length; i++) {
            if (!str(lookupValue(values, list[i].label), '').trim()) {
                warnings.push('slot "' + list[i].label + '" is empty — rendered an empty "' + list[i].label + ':" line.');
            }
        }
    }

    /**
     * Compile one entry against a type: extract values (matched by label),
     * apply overrides, render canonical content, resolve ref names to uids
     * and derive the key patch. Pure — never mutates entry, type or opts.
     */
    function compileEntry(entry, type, opts) {
        var warnings = [];
        var o = isObj(opts) ? opts : {};
        var t = clone(type);
        if (!isObj(t)) t = {};
        try {
            var reg = global.ELTypeRegistry;
            if (reg && typeof reg.validateType === 'function') {
                var checked = reg.validateType(t);
                if (checked && !checked.ok) {
                    warnings.push('type "' + (str(t.id, '') || str(t.name, '') || '?') + '" failed validation (' + (checked.errors || []).join('; ') + ') — compiling best-effort.');
                }
            }
        } catch (e) { warnings.push('type validation threw — compiling best-effort.'); }
        var ELS = global.ELSlots;
        var ast = typeToAst(t);
        var rawContent = (entry && typeof entry.content === 'string') ? entry.content : '';
        var extracted = safeExtract(rawContent, ast);
        if (!ELS || typeof ELS.extractValues !== 'function') {
            warnings.push('ELSlots.extractValues is unavailable — compiling from overrides only.');
        }
        var values = mergeValues(extracted.values, isObj(o.values) ? o.values : {});
        var fallbacks = typeFallbacks(t);
        var condStates = isObj(o.conditionStates) ? o.conditionStates : {};
        var extra = Array.isArray(o.extra) ? o.extra : [];
        var content = '';
        try {
            if (ELS && typeof ELS.renderContent === 'function') {
                content = ELS.renderContent(ast, values, { conditionStates: condStates, fallbacks: fallbacks, extra: extra });
            } else {
                warnings.push('ELSlots.renderContent is unavailable — content is empty.');
            }
        } catch (e) { warnings.push('content rendering failed — content is empty.'); content = ''; }
        var refs = collectRefs(t, values, o, warnings);
        var patch = buildPatch(t, values, warnings);
        warnEmptySlots(t, values, warnings);
        return { content: content, patch: patch, refs: refs, warnings: warnings };
    }

    function presentLabels(lines) {
        var present = {};
        for (var l = 0; l < lines.length; l++) {
            var line = lines[l];
            var trimmed = str(line, '').trim();
            if (!trimmed) continue;
            if (trimmed.indexOf('**') === 0 || trimmed.indexOf('==') === 0) continue;
            if (trimmed.indexOf('>>') === 0 || trimmed.indexOf('||') === 0) continue;
            var m = /^\s*(.+?)\s*:(.*)$/.exec(line);
            if (m) present[normLabel(m[1])] = true;
        }
        return present;
    }

    function labelLineOrder(content, slots) {
        var order = [];
        var seen = {};
        var byNorm = {};
        for (var i = 0; i < slots.length; i++) {
            var nk = normLabel(slots[i].label);
            if (!Object.prototype.hasOwnProperty.call(byNorm, nk)) byNorm[nk] = slots[i].label;
        }
        var lines = str(content, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        for (var l = 0; l < lines.length; l++) {
            var trimmed = lines[l].trim();
            if (!trimmed || trimmed.indexOf('**') === 0 || trimmed.indexOf('==') === 0) continue;
            if (trimmed.indexOf('>>') === 0 || trimmed.indexOf('||') === 0) continue;
            var m = /^\s*(.+?)\s*:(.*)$/.exec(lines[l]);
            if (!m) continue;
            var canon = byNorm[normLabel(m[1])];
            if (canon && !Object.prototype.hasOwnProperty.call(seen, normLabel(canon))) {
                seen[normLabel(canon)] = true;
                order.push(canon);
            }
        }
        return order;
    }

    function lastClosingLimiter(lines) {
        for (var i = lines.length - 1; i >= 0; i--) {
            if (RE_CLOSE.test(lines[i])) return i;
        }
        return -1;
    }

    /**
     * Apply a type to an entry (the Decision 01/07 application path). Returns
     * a NEW entry object — the input is never mutated. With reorder enabled
     * (default) the content is canonically re-rendered in template order and
     * unmapped lines survive in a marked Extra block; with reorder === false
     * existing lines are kept byte-identical and missing slots are appended
     * as `Label:` lines just before the closing limiter (or end of content).
     * Keys are only touched when the patch carries them; extensions.el is set
     * to {type, refs, deps: []} while every other extensions.* key is kept.
     */
    function applyType(entry, type, opts) {
        var o = isObj(opts) ? opts : {};
        var compiled = compileEntry(entry, type, o);
        var warnings = compiled.warnings.slice();
        var changes = [];
        var src = clone(entry);
        if (!isObj(src)) src = {};
        var t = clone(type);
        if (!isObj(t)) t = {};
        var newEntry = clone(entry);
        if (!isObj(newEntry)) newEntry = {};
        var ELS = global.ELSlots;
        var ast = typeToAst(t);
        var slots = valueSlots(t);
        var rawContent = (src && typeof src.content === 'string') ? src.content : '';
        if (t.reorder === false) {
            var eol = detectEol(rawContent);
            var lines = rawContent.split(eol);
            var present = presentLabels(lines);
            var merged = mergeValues(safeExtract(rawContent, ast).values, isObj(o.values) ? o.values : {});
            var closeIdx = lastClosingLimiter(lines);
            var at = closeIdx === -1 ? lines.length : closeIdx;
            var added = 0;
            for (var s = 0; s < slots.length; s++) {
                if (Object.prototype.hasOwnProperty.call(present, normLabel(slots[s].label))) continue;
                var val = str(lookupValue(merged, slots[s].label), '');
                lines.splice(at + added, 0, val ? slots[s].label + ': ' + val : slots[s].label + ':');
                added++;
                changes.push(val ? 'appended missing ' + slots[s].label + ': with provided value' : 'inserted empty ' + slots[s].label + ':');
            }
            newEntry.content = lines.join(eol);
        } else {
            var full = safeExtract(rawContent, ast);
            var merged2 = mergeValues(full.values, isObj(o.values) ? o.values : {});
            var content = compiled.content;
            try {
                if (ELS && typeof ELS.renderContent === 'function') {
                    content = ELS.renderContent(ast, merged2, {
                        conditionStates: isObj(o.conditionStates) ? o.conditionStates : {},
                        fallbacks: typeFallbacks(t),
                        extra: (full.extra || []).concat(Array.isArray(o.extra) ? o.extra : []),
                    });
                }
            } catch (e) { warnings.push('canonical re-render failed — kept compiled content without preserved extras.'); }
            newEntry.content = content;
            var oldOrder = labelLineOrder(rawContent, slots);
            var oldPos = {};
            for (var p = 0; p < oldOrder.length; p++) oldPos[normLabel(oldOrder[p])] = p;
            for (var i = 0; i < slots.length; i++) {
                var lb = slots[i].label;
                if (Object.prototype.hasOwnProperty.call(oldPos, normLabel(lb))) {
                    if (oldPos[normLabel(lb)] !== i) changes.push('moved ' + lb + ' block to position ' + (i + 1));
                } else {
                    var vv = str(lookupValue(merged2, lb), '');
                    changes.push(vv ? 'inserted ' + lb + ':' : 'inserted empty ' + lb + ':');
                }
            }
            for (var e = 0; e < full.extra.length; e++) {
                changes.push('kept extra line ' + JSON.stringify(truncate(str(full.extra[e], ''), 60)));
            }
        }
        if (Object.prototype.hasOwnProperty.call(compiled.patch, 'key')) {
            newEntry.key = compiled.patch.key.slice();
            changes.push('set key to [' + compiled.patch.key.join(', ') + ']');
        }
        if (Object.prototype.hasOwnProperty.call(compiled.patch, 'keysecondary')) {
            newEntry.keysecondary = compiled.patch.keysecondary.slice();
            changes.push('set keysecondary to [' + compiled.patch.keysecondary.join(', ') + ']');
        }
        var ext = clone(src.extensions);
        if (!isObj(ext)) ext = {};
        ext.el = { type: str(t.id, ''), refs: clone(compiled.refs) || [], deps: [] };
        newEntry.extensions = ext;
        return { entry: newEntry, changes: changes, warnings: warnings };
    }

    /**
     * Display extracts for portrait-adjacent rendering: every display-block
     * label plus the first Name-like slot (falling back to the first slot
     * when the type names nothing). Pure text map, no markup.
     */
    function renderDisplay(ast, values) {
        var out = {};
        try {
            var a = normalizeAst(ast);
            var vals = isObj(values) ? values : {};
            var sections = Array.isArray(a.sections) ? a.sections : [];
            for (var s = 0; s < sections.length; s++) {
                var blocks = ((sections[s] || {}).blocks) || [];
                if (!Array.isArray(blocks)) continue;
                for (var b = 0; b < blocks.length; b++) {
                    var blk = blocks[b] || {};
                    if (blk.t !== 'display' || !Array.isArray(blk.labels)) continue;
                    for (var l = 0; l < blk.labels.length; l++) {
                        var dl = str(blk.labels[l], '').trim();
                        if (dl && !Object.prototype.hasOwnProperty.call(out, dl)) {
                            out[dl] = lookupValue(vals, dl);
                        }
                    }
                }
            }
            var first = null;
            var named = null;
            for (var s2 = 0; s2 < sections.length; s2++) {
                var blocks2 = ((sections[s2] || {}).blocks) || [];
                if (!Array.isArray(blocks2)) continue;
                for (var b2 = 0; b2 < blocks2.length; b2++) {
                    var blk2 = blocks2[b2] || {};
                    if (blk2.t !== 'slot' || !str(blk2.label, '').trim()) continue;
                    if (!first) first = blk2.label;
                    if (!named && normLabel(blk2.label).indexOf('name') !== -1) named = blk2.label;
                    if (first && named) break;
                }
                if (first && named) break;
            }
            var chosen = named || first;
            if (chosen && !Object.prototype.hasOwnProperty.call(out, chosen)) {
                out[chosen] = lookupValue(vals, chosen);
            }
        } catch (e) { /* tolerant: return extracts collected so far */ }
        return out;
    }

    function memberName(m, idx, warnings) {
        try {
            if (m && typeof m === 'object') {
                if (Array.isArray(m.key)) {
                    for (var i = 0; i < m.key.length; i++) {
                        var k = str(m.key[i], '').trim();
                        if (k) return k;
                    }
                }
                if (typeof m.content === 'string') {
                    var lines = m.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
                    for (var l = 0; l < lines.length; l++) {
                        var mm = /^\s*(.+?)\s*:(.*)$/.exec(lines[l]);
                        if (mm && normLabel(mm[1]) === 'name') {
                            var v = str(mm[2], '').trim();
                            if (v) return v;
                        }
                    }
                }
            }
        } catch (e) { /* fall through to unnamed */ }
        warnings.push('member #' + (idx + 1) + ' has no key or Name — listed as "unnamed".');
        return 'unnamed';
    }

    function memberGroup(m, groupBy) {
        try {
            if (groupBy === 'none') return 'Members';
            if (groupBy === 'type') {
                var g = m && m.extensions && m.extensions.el && m.extensions.el.type;
                return str(g, '').trim() || 'untyped';
            }
            var f = m ? m[groupBy] : '';
            return str(f, '').trim() || 'untyped';
        } catch (e) { return 'untyped'; }
    }

    /**
     * Build a constant-style hub entry body listing member names grouped by
     * opts.groupBy ('type' by default: entry.extensions.el.type, 'untyped'
     * when absent; 'none' for one flat Members group). One `Names: a, b, c`
     * line per group under the hub limiter; an empty set still emits an
     * explicit empty line, never empty content.
     */
    function buildHub(type, memberEntries, opts) {
        var warnings = [];
        var o = isObj(opts) ? opts : {};
        var t = clone(type);
        if (!isObj(t)) t = {};
        var groupBy = str(o.groupBy, 'type').trim() || 'type';
        var list = [];
        if (Array.isArray(memberEntries)) {
            list = memberEntries;
        } else if (isObj(memberEntries)) {
            var ks = Object.keys(memberEntries);
            for (var q = 0; q < ks.length; q++) list.push(memberEntries[ks[q]]);
        } else {
            warnings.push('memberEntries is not an array — building an empty hub.');
        }
        var groups = {};
        var order = [];
        for (var i = 0; i < list.length; i++) {
            var g = memberGroup(list[i], groupBy);
            if (!Object.prototype.hasOwnProperty.call(groups, g)) {
                groups[g] = [];
                order.push(g);
            }
            groups[g].push(memberName(list[i], i, warnings));
        }
        order.sort();
        var lines = [];
        var tag = str(t.tag, '');
        if (tag) lines.push('**<' + tag + '>**');
        if (!list.length) {
            lines.push('Names: (empty)');
            warnings.push('hub has no members — emitted an explicit empty line.');
        } else {
            for (var n = 0; n < order.length; n++) {
                lines.push('== ' + order[n] + ' ==');
                lines.push('Names: ' + groups[order[n]].join(', '));
            }
        }
        if (tag) lines.push('**</' + tag + '>**');
        // NOTE: hub bodies always join with LF, even when surrounding content uses CRLF.
        return { content: lines.join('\n'), warnings: warnings };
    }

    /**
     * The convert-to-plain-text safety path: strip limiter lines
     * (**<tag>** / **</tag>**) and keep every other line byte-identical.
     * Returns {content, removed} where removed holds the limiter lines taken
     * out, in order.
     */
    function detachToPlain(entry) {
        var text = (entry && typeof entry.content === 'string') ? entry.content : '';
        var eol = detectEol(text);
        var lines = text.split(eol);
        var kept = [];
        var removed = [];
        for (var i = 0; i < lines.length; i++) {
            if (RE_OPEN.test(lines[i]) || RE_CLOSE.test(lines[i])) removed.push(lines[i]);
            else kept.push(lines[i]);
        }
        return { content: kept.join(eol), removed: removed };
    }

    global.ELCompile = {
        typeToAst: typeToAst,
        compileEntry: compileEntry,
        applyType: applyType,
        renderDisplay: renderDisplay,
        buildHub: buildHub,
        detachToPlain: detachToPlain,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
