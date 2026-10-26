/**
 * dep-index.js
 *
 * The dependency index of the Enhanced Lorebook revamp (Track A2). It owns:
 *   - the ref-source reader (entry.extensions.el.refs — the ONLY source, never
 *     entry content)
 *   - the forward/reverse edge builder (buildIndex)
 *   - the cycle reporter (findCycles — report only, never break)
 *   - the forward-edge differ (diffIndex)
 *   - the transitive-dirty resolver (markDirty)
 *   - a module-level holder for the latest app-window index
 *     (setCurrent / getCurrent — a pointer for future consumers, not a cache:
 *     every function above is pure and takes the index as an argument)
 *
 * It is deliberately DOM-free: pure data functions only, no window, no
 * document, no fetch. Like apply-core.js it has no imports/exports — it
 * publishes one namespace object, ELDepIndex, on the global scope, so the SAME
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

    function sameEdgeSet(a, b) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) {
            if (b.indexOf(a[i]) === -1) return false;
        }
        return true;
    }

    function sortedKeys(obj) {
        return Object.keys(obj).sort();
    }

    /**
     * Read the ref list of one entry. ONLY source is entry.extensions.el.refs,
     * an array of {kind, target} where target is {uid} (same book) or
     * {book, uid} (cross-book). Tolerates missing/partial `el` objects and
     * malformed items: anything unusable is skipped, never throws.
     * Returns [{kind, target:{uid, book}}]; book is '' when absent (same book).
     */
    function readRefs(entry) {
        var out = [];
        try {
            if (!isObj(entry)) return out;
            var ext = entry.extensions;
            if (!isObj(ext)) return out;
            var el = ext.el;
            if (!isObj(el)) return out;
            var refs = el.refs;
            if (!Array.isArray(refs)) return out;
            for (var i = 0; i < refs.length; i++) {
                var r = refs[i];
                if (!isObj(r)) continue;
                var t = r.target;
                var uid = '';
                var book = '';
                if (isObj(t)) {
                    uid = str(t.uid, '');
                    book = str(t.book, '');
                } else if (typeof t === 'string' || typeof t === 'number') {
                    uid = str(t, '');
                } else {
                    continue;
                }
                if (!uid) continue;
                out.push({ kind: str(r.kind, ''), target: { uid: uid, book: book } });
            }
        } catch (e) { /* tolerant: return what was collected so far */ }
        return out;
    }

    /**
     * Build the dependency index over entries ({uid: entry}, ST shape, uids as
     * string keys). opts.book is the current book name: a ref target carrying
     * a `book` that differs from it is recorded as cross-book (external) and
     * excluded from the local edges. Refs without a `book` are always local.
     * Returns {forward:{uid:[depUid,...]}, reverse:{uid:[dependentUid,...]},
     * external:{uid:[{book,uid,kind},...]}, warnings:[{uid,reason}]}.
     * Warnings cover dangling refs (target uid not in entries — cross-book
     * targets are external, not warnings), self-refs and duplicate refs.
     * Never throws on bad input — a non-object yields an empty index.
     */
    function buildIndex(entries, opts) {
        var forward = Object.create(null);
        var reverse = Object.create(null);
        var external = Object.create(null);
        var warnings = [];
        try {
            if (!isObj(entries)) {
                warnings.push({ uid: '', reason: 'entries is not an object — returned an empty index.' });
                return { forward: forward, reverse: reverse, external: external, warnings: warnings };
            }
            var o = isObj(opts) ? opts : {};
            var book = str(o.book, '');
            var uids = Object.keys(entries);
            for (var u = 0; u < uids.length; u++) {
                forward[uids[u]] = [];
                reverse[uids[u]] = [];
            }
            for (var s = 0; s < uids.length; s++) {
                var uid = uids[s];
                var refs = readRefs(entries[uid]);
                var seen = Object.create(null);
                for (var i = 0; i < refs.length; i++) {
                    var ref = refs[i];
                    var target = ref.target;
                    if (target.book && (!book || target.book !== book)) {
                        if (!Object.prototype.hasOwnProperty.call(external, uid)) external[uid] = [];
                        external[uid].push({ book: target.book, uid: target.uid, kind: ref.kind });
                        continue;
                    }
                    var dep = target.uid;
                    if (!Object.prototype.hasOwnProperty.call(entries, dep)) {
                        warnings.push({ uid: uid, reason: 'dangling ref to unknown uid "' + dep + '" — ignored.' });
                        continue;
                    }
                    if (dep === uid) {
                        warnings.push({ uid: uid, reason: 'self-ref to own uid — ignored.' });
                        continue;
                    }
                    if (Object.prototype.hasOwnProperty.call(seen, dep)) {
                        warnings.push({ uid: uid, reason: 'duplicate ref to uid "' + dep + '" — kept once.' });
                        continue;
                    }
                    seen[dep] = true;
                    forward[uid].push(dep);
                    reverse[dep].push(uid);
                }
            }
        } catch (e) {
            try { warnings.push({ uid: '', reason: 'build failed (' + (e && e.message ? e.message : e) + ') — returned a best-effort index.' }); } catch (e2) { /* ignore */ }
        }
        return { forward: forward, reverse: reverse, external: external, warnings: warnings };
    }

    /**
     * Report dependency cycles in the index as arrays of uids (each array is
     * one cycle, in edge order). Report only — the graph is never modified.
     * Deterministic: nodes and edges are visited in sorted order.
     */
    function findCycles(index) {
        var cycles = [];
        try {
            var forward = (index && isObj(index.forward)) ? index.forward : {};
            var WHITE = 0;
            var GRAY = 1;
            var BLACK = 2;
            var color = Object.create(null);
            var keys = sortedKeys(forward);
            for (var k = 0; k < keys.length; k++) color[keys[k]] = WHITE;
            var stack = [];
            function visit(node) {
                color[node] = GRAY;
                stack.push(node);
                var deps = Array.isArray(forward[node]) ? forward[node].slice().sort() : [];
                for (var i = 0; i < deps.length; i++) {
                    var dep = deps[i];
                    if (!Object.prototype.hasOwnProperty.call(color, dep)) continue;
                    if (color[dep] === GRAY) {
                        cycles.push(stack.slice(stack.indexOf(dep)).concat([dep]));
                    } else if (color[dep] === WHITE) {
                        visit(dep);
                    }
                }
                stack.pop();
                color[node] = BLACK;
            }
            for (var n = 0; n < keys.length; n++) {
                if (color[keys[n]] === WHITE) visit(keys[n]);
            }
        } catch (e) { /* tolerant: return cycles found so far */ }
        return cycles;
    }

    /**
     * Compare the forward edges of two indexes. Returns
     * {added:[uid], removed:[uid], changed:[uid]} — all three sorted. `added`
     * is in next but not prev, `removed` the reverse, `changed` is in both
     * with a different edge set (order-insensitive).
     */
    function diffIndex(prev, next) {
        var added = [];
        var removed = [];
        var changed = [];
        try {
            var pf = (prev && isObj(prev.forward)) ? prev.forward : {};
            var nf = (next && isObj(next.forward)) ? next.forward : {};
            var pk = sortedKeys(pf);
            var nk = sortedKeys(nf);
            var pset = Object.create(null);
            var nset = Object.create(null);
            for (var i = 0; i < pk.length; i++) pset[pk[i]] = true;
            for (var j = 0; j < nk.length; j++) nset[nk[j]] = true;
            for (var a = 0; a < nk.length; a++) {
                if (!Object.prototype.hasOwnProperty.call(pset, nk[a])) added.push(nk[a]);
            }
            for (var r = 0; r < pk.length; r++) {
                if (!Object.prototype.hasOwnProperty.call(nset, pk[r])) removed.push(pk[r]);
            }
            for (var c = 0; c < nk.length; c++) {
                if (Object.prototype.hasOwnProperty.call(pset, nk[c])) {
                    var pa = Array.isArray(pf[nk[c]]) ? pf[nk[c]] : [];
                    var na = Array.isArray(nf[nk[c]]) ? nf[nk[c]] : [];
                    if (!sameEdgeSet(pa, na)) changed.push(nk[c]);
                }
            }
        } catch (e) { /* tolerant: return what was collected so far */ }
        return { added: added, removed: removed, changed: changed };
    }

    /**
     * Resolve the transitive dirty set for a changed uid: the uid itself plus
     * every entry that depends on it, directly or indirectly (via reverse
     * edges). Cycle-safe through a visited set. Returns uids in breadth order
     * with the changed uid first. Cross-book (external) edges are excluded —
     * multi-book resolution is a later track.
     */
    function markDirty(index, changedUid) {
        var out = [];
        try {
            var reverse = (index && isObj(index.forward) && isObj(index.reverse)) ? index.reverse : null;
            if (!reverse) return out;
            var start = str(changedUid, '');
            if (!start) return out;
            var seen = Object.create(null);
            seen[start] = true;
            var queue = [start];
            out.push(start);
            while (queue.length) {
                var node = queue.shift();
                var dependents = Array.isArray(reverse[node]) ? reverse[node] : [];
                for (var i = 0; i < dependents.length; i++) {
                    var dep = str(dependents[i], '');
                    if (!dep || Object.prototype.hasOwnProperty.call(seen, dep)) continue;
                    if (!Object.prototype.hasOwnProperty.call(reverse, dep)) continue;
                    seen[dep] = true;
                    out.push(dep);
                    queue.push(dep);
                }
            }
        } catch (e) { /* tolerant: return what was collected so far */ }
        return out;
    }

    // ── Module-level holder ────────────────────────────────────────────────
    // The single pointer to the latest app-window index. NOT a cache used by
    // the pure functions above — the caller always holds the index object it
    // works with. This only lets the app window publish "the current index"
    // for future consumers (Track A3+) after each EL_setLorebookData adoption.
    var _current = null;

    /**
     * Publish the latest built index (called from EL_setLorebookData after it
     * adopts new data). Stores the reference as-is — no copy, no validation.
     */
    function setCurrent(idx) {
        _current = (idx && typeof idx === 'object') ? idx : null;
        return _current;
    }

    /**
     * Fetch the latest published index (null when none was published yet).
     */
    function getCurrent() {
        return _current;
    }

    var EMPTY = { forward: {}, reverse: {}, external: {}, warnings: [] };
    try {
        Object.freeze(EMPTY.forward);
        Object.freeze(EMPTY.reverse);
        Object.freeze(EMPTY.external);
        Object.freeze(EMPTY.warnings);
        Object.freeze(EMPTY);
    } catch (e) { /* ignore */ }

    global.ELDepIndex = {
        EMPTY: EMPTY,
        readRefs: readRefs,
        buildIndex: buildIndex,
        findCycles: findCycles,
        diffIndex: diffIndex,
        markDirty: markDirty,
        setCurrent: setCurrent,
        getCurrent: getCurrent,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
