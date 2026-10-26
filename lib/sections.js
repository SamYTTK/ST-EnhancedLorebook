/**
 * sections.js — Track B3: sections as one-shot order/position recipes.
 *
 * Pure, DOM-free engine. No window, no document, no fetch, no imports.
 * Publishes one namespace object, ELSections, on the global scope, so the
 * SAME file runs in the app window and the load harness.
 *
 * A section spreads its members across a sequential order range [lo..hi]:
 * members are sorted by current order and assigned lo, lo+1, ... in turn.
 * Any entry whose `extensions.el.refs` targets a member uid (same book)
 * shares that member's slot (order + applied position/role/depth).
 * `hi` is a CAP: overflow still applies and is reported as a warning.
 *
 * Only order/position/role/depth are ever derived here — content is never
 * touched (the caller applies the rows through ELG_guardSave).
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

    function intOr(v, fallback) {
        var n = (typeof v === 'number') ? v : parseInt(v, 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.floor(n);
    }

    function orderOf(entry) {
        try {
            var n = Number(entry && entry.order);
            if (Number.isFinite(n)) return Math.floor(n);
        } catch (e) {}
        return 100;
    }

    /**
     * Stored type id of one entry ('' when untyped). Mirrors the app's
     * EL_oldTypeId reader so lock-to-type matches the same entries.
     */
    function entryTypeId(entry) {
        try {
            var t = entry && entry.extensions && entry.extensions.el && entry.extensions.el.type;
            return (typeof t === 'string' && t) ? t : '';
        } catch (e) { return ''; }
    }

    /**
     * Same-book ref targets of one entry. ONLY source is
     * entry.extensions.el.refs; cross-book targets (carrying a `book`) are
     * excluded. Malformed items are skipped, never throw.
     */
    function entryRefTargets(entry) {
        var out = [];
        try {
            var el = entry && entry.extensions && entry.extensions.el;
            var refs = el && el.refs;
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
                if (book) continue;
                if (out.indexOf(uid) === -1) out.push(uid);
            }
        } catch (e) { /* tolerant: return what was collected so far */ }
        return out;
    }

    /**
     * Normalise a raw section object. Never throws; unknown position values
     * fall back to 'keep', hi is clamped to >= lo.
     */
    function sanitizeSection(raw) {
        var s = isObj(raw) ? raw : {};
        var lo = Math.max(0, intOr(s.lo, 0));
        var hi = intOr(s.hi, lo);
        if (hi < lo) hi = lo;
        var pos = s.position;
        if (pos === undefined || pos === null || pos === 'keep') pos = 'keep';
        else {
            var pn = intOr(pos, -1);
            pos = (pn >= 0 && pn <= 4) ? pn : 'keep';
        }
        var depth = Math.max(0, intOr(s.depth, 4));
        var lock = str(s.lockType, 'off') || 'off';
        var members = [];
        try {
            var mu = Array.isArray(s.memberUids) ? s.memberUids : [];
            for (var i = 0; i < mu.length; i++) {
                var u = str(mu[i], '');
                if (u && members.indexOf(u) === -1) members.push(u);
            }
        } catch (e) {}
        return {
            id: str(s.id, ''),
            name: str(s.name, 'Section') || 'Section',
            lo: lo,
            hi: hi,
            position: pos,
            depth: depth,
            lockType: lock,
            memberUids: members,
        };
    }

    /**
     * Compute the resulting order/position/depth for every entry in the book.
     *
     * @param {object} bookEntries ST shape {uid: entry}.
     * @param {object} section {id,name,lo,hi,position,depth,lockType,memberUids}.
     * @param {object} [opts] Optional {index} — an ELDepIndex-style index
     *   whose .reverse maps member uid -> [dependent uids]. When absent or
     *   unusable, refs are read directly off the entries (same result).
     * @returns {{rows: Array, warnings: Array, changed: number}}
     *   rows are sorted by resulting order: {uid, oldOrder, newOrder, depth,
     *   position, role, linkedTo (when shared), outsider}. warnings are
     *   strings (cap overflow, stale uids). changed counts rows whose
     *   order/position/role/depth would actually change.
     */
    function computeSection(bookEntries, section, opts) {
        var rows = [];
        var warnings = [];
        var changed = 0;
        try {
            var entries = isObj(bookEntries) ? bookEntries : {};
            var sec = sanitizeSection(section);
            var uids = Object.keys(entries);
            var known = Object.create(null);
            for (var k = 0; k < uids.length; k++) known[uids[k]] = true;

            var explicit = [];
            var stale = [];
            for (var m = 0; m < sec.memberUids.length; m++) {
                var mu = sec.memberUids[m];
                if (known[mu]) {
                    if (explicit.indexOf(mu) === -1) explicit.push(mu);
                } else {
                    stale.push(mu);
                }
            }
            if (stale.length) {
                warnings.push('Dropped ' + stale.length + ' stale member uid(s) not in this book: '
                    + stale.slice(0, 10).join(', ') + (stale.length > 10 ? ' …' : ''));
            }

            var memberSet = Object.create(null);
            for (var e = 0; e < explicit.length; e++) memberSet[explicit[e]] = true;
            if (sec.lockType && sec.lockType !== 'off') {
                for (var l = 0; l < uids.length; l++) {
                    if (entryTypeId(entries[uids[l]]) === sec.lockType) memberSet[uids[l]] = true;
                }
            }
            var members = Object.keys(memberSet);

            var linkedTo = Object.create(null);
            var rev = null;
            try { rev = (opts && isObj(opts.index) && isObj(opts.index.reverse)) ? opts.index.reverse : null; } catch (e2) { rev = null; }
            if (rev) {
                for (var mi = 0; mi < members.length; mi++) {
                    var deps = rev[members[mi]];
                    if (!Array.isArray(deps)) continue;
                    for (var di = 0; di < deps.length; di++) {
                        var d = str(deps[di], '');
                        if (!d || !known[d]) continue;
                        if (Object.prototype.hasOwnProperty.call(memberSet, d)) continue;
                        if (Object.prototype.hasOwnProperty.call(linkedTo, d)) continue;
                        linkedTo[d] = members[mi];
                    }
                }
            } else {
                for (var u = 0; u < uids.length; u++) {
                    var cand = uids[u];
                    if (Object.prototype.hasOwnProperty.call(memberSet, cand)) continue;
                    var targets = entryRefTargets(entries[cand]);
                    for (var ti = 0; ti < targets.length; ti++) {
                        if (Object.prototype.hasOwnProperty.call(memberSet, targets[ti])) {
                            linkedTo[cand] = targets[ti];
                            break;
                        }
                    }
                }
            }

            var primaries = members.slice().sort(function (a, b) {
                var oa = orderOf(entries[a]);
                var ob = orderOf(entries[b]);
                if (oa !== ob) return oa - ob;
                return a < b ? -1 : (a > b ? 1 : 0);
            });
            var slotOf = Object.create(null);
            for (var pi = 0; pi < primaries.length; pi++) slotOf[primaries[pi]] = sec.lo + pi;

            if (primaries.length) {
                var last = sec.lo + primaries.length - 1;
                if (last > sec.hi) {
                    warnings.push('Range cap exceeded by ' + (last - sec.hi)
                        + ' order(s) — members spill past hi ' + sec.hi + ', still applied.');
                }
            }

            var setPos = sec.position !== 'keep';
            function appliedFor(uid) {
                var entry = entries[uid] || {};
                var res = {
                    order: Object.prototype.hasOwnProperty.call(slotOf, uid) ? slotOf[uid] : orderOf(entry),
                    position: entry.position,
                    role: (entry.role === undefined) ? null : entry.role,
                    depth: (entry.depth === undefined || entry.depth === null) ? 4 : entry.depth,
                };
                if (setPos) {
                    res.position = sec.position;
                    if (sec.position === 4) {
                        var r = entry.role;
                        res.role = (r === 0 || r === 1 || r === 2) ? r : 0;
                        res.depth = sec.depth;
                    }
                }
                return res;
            }
            var memberApplied = Object.create(null);
            for (var ai = 0; ai < members.length; ai++) memberApplied[members[ai]] = appliedFor(members[ai]);

            function oldVals(entry) {
                return {
                    order: orderOf(entry),
                    position: entry ? entry.position : undefined,
                    role: entry ? entry.role : undefined,
                    depth: (entry && (entry.depth !== undefined && entry.depth !== null)) ? entry.depth : 4,
                };
            }

            for (var ri = 0; ri < uids.length; ri++) {
                var uid = uids[ri];
                var entry = entries[uid] || {};
                var old = oldVals(entry);
                var isMember = Object.prototype.hasOwnProperty.call(memberSet, uid);
                var parent = Object.prototype.hasOwnProperty.call(linkedTo, uid) ? linkedTo[uid] : null;
                var ap;
                if (isMember) ap = memberApplied[uid];
                else if (parent) {
                    var pap = memberApplied[parent];
                    ap = { order: pap.order, position: pap.position, role: pap.role, depth: pap.depth };
                } else {
                    ap = { order: old.order, position: old.position, role: old.role, depth: old.depth };
                }
                var row = {
                    uid: uid,
                    oldOrder: old.order,
                    newOrder: ap.order,
                    depth: ap.depth,
                    position: ap.position,
                    role: ap.role,
                    outsider: (!isMember && !parent),
                };
                if (parent) row.linkedTo = parent;
                rows.push(row);
                if (ap.order !== old.order
                    || (setPos && (ap.position !== old.position || ap.role !== old.role))
                    || (setPos && sec.position === 4 && ap.depth !== old.depth)) {
                    changed++;
                }
            }

            rows.sort(function (a, b) {
                if (a.newOrder !== b.newOrder) return a.newOrder - b.newOrder;
                var al = a.linkedTo ? 1 : 0;
                var bl = b.linkedTo ? 1 : 0;
                if (al !== bl) return al - bl;
                if (a.oldOrder !== b.oldOrder) return a.oldOrder - b.oldOrder;
                return a.uid < b.uid ? -1 : (a.uid > b.uid ? 1 : 0);
            });
        } catch (e) {
            try { warnings.push('Compute failed partway (' + (e && e.message ? e.message : e) + ') — showing a best-effort preview.'); } catch (e2) {}
        }
        return { rows: rows, warnings: warnings, changed: changed };
    }

    global.ELSections = {
        sanitizeSection: sanitizeSection,
        computeSection: computeSection,
        entryTypeId: entryTypeId,
        entryRefTargets: entryRefTargets,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
