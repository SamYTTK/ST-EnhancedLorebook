/**
 * rules.js (EL-REVAMP B5)
 *
 * The rule evaluator of the EL revamp. User-built systems hold per-entry
 * condition -> value rows; on message-received the host resolves them to
 * plain set-field-text writes (direct clock values only — no LLM, no fetch,
 * never throws).
 *
 * ASSERT + ENFORCE: actions are set-field-text only. No toggle-flip/chain
 * actions exist anywhere in this evaluator or its row shape: a row carries a
 * target label and a text value, nothing else. There is no op, kind, or flag
 * that flips a switch, fires another rule, or moves a map pin — evaluation
 * reads a pre-message snapshot ctx and writes never feed back into it, so
 * rule chaining is structurally impossible. (Map movement arrives via the
 * map module, never via rules.)
 *
 * It is deliberately DOM-free: pure string/data functions only, no window, no
 * document, no fetch. Like the other lib files it has no imports/exports — it
 * publishes one namespace object, ELRules, on the global scope, so the SAME
 * file runs in the app window and the host window.
 *
 * Row shape (malleable per Decision 06b — operator + N operands):
 *   { kind: 'if' | 'otherwise' | 'while',
 *     op: '=' | '!=' | 'contains' | '<' | '>' | 'empty',
 *     left: { src: 'time' | 'dow' | 'field' | 'map' | 'relation', ref: string },
 *     right: string,
 *     target: string,   // entry content label to set (default: system target)
 *     value: string }   // text to write when the row resolves
 * ctx shape:
 *   { time: 'HH:MM', dow: 0-6 (0 = Sunday), fieldValues: { normLabel: value },
 *     mapPlaced: bool, relations: [kinds] }
 *
 * Resolve semantics: the first matching 'if' wins; when no 'if' matches the
 * first 'otherwise' wins; every 'while' row always applies as a constant.
 * resolveSystem returns the ordered write list (main write first, then one
 * write per 'while' row). LLM/RequestHub judgment calls are deliberately NOT
 * here — they belong to the later agent phase, which can add an op kind and
 * evaluate it app-side. Unknown kinds/ops/sources evaluate false, never throw.
 */
(function (global) {
    'use strict';

    var KINDS = { 'if': true, otherwise: true, 'while': true };
    var OPS = { '=': true, '!=': true, contains: true, '<': true, '>': true, empty: true };
    var SRCS = { time: true, dow: true, field: true, map: true, relation: true };

    function isObj(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    function str(v, fallback) {
        if (typeof v === 'string') return v;
        if (v === undefined || v === null) return (fallback === undefined ? '' : fallback);
        try { return String(v); } catch (e) { return (fallback === undefined ? '' : fallback); }
    }

    function normLabel(s) {
        return str(s, '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
    }

    function ruleKey(book, uid) {
        return str(book, '') + '|' + str(uid, '');
    }

    function parseRuleKey(key) {
        var s = str(key, '');
        var i = s.indexOf('|');
        if (i === -1) return { book: s, uid: '' };
        return { book: s.slice(0, i), uid: s.slice(i + 1) };
    }

    /**
     * Clean one row; null when the shape is unusable. Otherwise/while rows
     * need no condition, but sanitize keeps whatever condition they carry so
     * switching kind back to 'if' restores it.
     */
    function sanitizeRow(raw) {
        try {
            if (!isObj(raw)) return null;
            var kind = str(raw.kind, 'if').trim().toLowerCase();
            if (!KINDS[kind]) kind = 'if';
            var op = str(raw.op, '=').trim();
            if (!OPS[op]) op = '=';
            var left = isObj(raw.left) ? raw.left : {};
            var src = str(left.src, 'time').trim().toLowerCase();
            if (!SRCS[src]) src = 'time';
            return {
                kind: kind,
                op: op,
                left: { src: src, ref: str(left.ref, '') },
                right: str(raw.right, ''),
                target: str(raw.target, '').trim(),
                value: str(raw.value, ''),
            };
        } catch (e) { return null; }
    }

    /**
     * Clean one entry's rule record; never throws, always returns a record.
     */
    function sanitizeEntryRules(raw) {
        var out = { systemId: '', enabled: true, rows: [] };
        try {
            if (!isObj(raw)) return out;
            out.systemId = str(raw.systemId, '');
            out.enabled = raw.enabled !== false;
            var list = Array.isArray(raw.rows) ? raw.rows : [];
            for (var i = 0; i < list.length; i++) {
                var r = sanitizeRow(list[i]);
                if (r) out.rows.push(r);
            }
        } catch (e) { /* return the record collected so far */ }
        return out;
    }

    function tryTimeMinutes(v) {
        try {
            var m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(str(v, ''));
            if (!m) return null;
            var h = parseInt(m[1], 10);
            var min = parseInt(m[2], 10);
            if (h < 0 || h > 23 || min < 0 || min > 59) return null;
            return h * 60 + min;
        } catch (e) { return null; }
    }

    function tryNum(v) {
        try {
            var s = str(v, '').trim();
            if (!s) return null;
            var n = Number(s);
            return isFinite(n) ? n : null;
        } catch (e) { return null; }
    }

    /**
     * Raw left value for a row against ctx. Time/dow/field come back as
     * strings; map/relation come back as booleans (exists-style sources).
     */
    function leftValue(row, ctx) {
        try {
            var c = isObj(ctx) ? ctx : {};
            var src = row && row.left ? row.left.src : 'time';
            if (src === 'time') return str(c.time, '');
            if (src === 'dow') return str(c.dow, '');
            if (src === 'field') {
                var fv = isObj(c.fieldValues) ? c.fieldValues : {};
                var ref = normLabel(row.left.ref);
                if (Object.prototype.hasOwnProperty.call(fv, ref)) return str(fv[ref], '');
                return '';
            }
            if (src === 'map') return c.mapPlaced === true;
            if (src === 'relation') {
                var kinds = Array.isArray(c.relations) ? c.relations : [];
                var want = str(row.left.ref, '').trim().toLowerCase();
                if (!want) return false;
                for (var i = 0; i < kinds.length; i++) {
                    if (str(kinds[i], '').trim().toLowerCase() === want) return true;
                }
                return false;
            }
            return '';
        } catch (e) { return ''; }
    }

    function eqLoose(a, b) {
        var ta = tryTimeMinutes(a);
        var tb = tryTimeMinutes(b);
        if (ta !== null && tb !== null) return ta === tb;
        var na = tryNum(a);
        var nb = tryNum(b);
        if (na !== null && nb !== null) return na === nb;
        return str(a, '').trim().toLowerCase() === str(b, '').trim().toLowerCase();
    }

    function cmpLoose(a, b) {
        var ta = tryTimeMinutes(a);
        var tb = tryTimeMinutes(b);
        if (ta !== null && tb !== null) return ta < tb ? -1 : (ta > tb ? 1 : 0);
        var na = tryNum(a);
        var nb = tryNum(b);
        if (na !== null && nb !== null) return na < nb ? -1 : (na > nb ? 1 : 0);
        var sa = str(a, '').trim().toLowerCase();
        var sb = str(b, '').trim().toLowerCase();
        return sa < sb ? -1 : (sa > sb ? 1 : 0);
    }

    function compare(op, left, right) {
        try {
            if (op === 'empty') return str(left, '').trim() === '';
            if (typeof left === 'boolean' || typeof right === 'boolean') {
                var lb = left === true || str(left, '').trim().toLowerCase() === 'true';
                var rb = right === true || str(right, '').trim().toLowerCase() === 'true';
                if (op === '=') return lb === rb;
                if (op === '!=') return lb !== rb;
                return false;
            }
            if (op === '=') return eqLoose(left, right);
            if (op === '!=') return !eqLoose(left, right);
            if (op === 'contains') {
                return str(left, '').toLowerCase().indexOf(str(right, '').toLowerCase()) !== -1;
            }
            if (op === '<') return cmpLoose(left, right) < 0;
            if (op === '>') return cmpLoose(left, right) > 0;
            return false;
        } catch (e) { return false; }
    }

    /**
     * One row against ctx. Otherwise/while rows always match (they are
     * else-branch / constant rows — their condition inputs stay hidden in the
     * UI). A row whose raw kind/op/source is unknown matches nothing
     * (fail-closed); sanitizeRow's coercion is a UI/persist convenience only
     * and never widens evaluation. Never throws.
     */
    function evaluateRow(row, ctx) {
        try {
            if (!isObj(row)) return false;
            var k = str(row.kind, 'if').trim().toLowerCase();
            if (!KINDS[k]) return false;
            if (k === 'otherwise' || k === 'while') return true;
            var o = str(row.op, '=').trim();
            if (!OPS[o]) return false;
            var s = (isObj(row.left) && typeof row.left.src === 'string') ? row.left.src.trim().toLowerCase() : 'time';
            if (!SRCS[s]) return false;
            var r = sanitizeRow(row);
            if (!r) return false;
            return compare(r.op, leftValue(r, ctx), r.right);
        } catch (e) { return false; }
    }

    function rowTarget(row, systemTarget) {
        var t = row && typeof row.target === 'string' ? row.target.trim() : '';
        if (t) return t;
        t = str(systemTarget, '').trim();
        return t || 'Current_Location';
    }

    /**
     * Resolve one entry's rules to an ordered write list:
     *   { writes: [{ target, value, rowIndex, kind }], matched: row|null }
     * First matching 'if' wins, else the first 'otherwise', plus every
     * 'while' row as a constant write. Every write is set-field-text only —
     * there is no other action kind to resolve to.
     */
    function resolveSystem(entryRules, ctx, systemTarget) {
        var out = { writes: [], matched: null };
        try {
            var rec = sanitizeEntryRules(entryRules);
            if (!rec.enabled || !rec.rows.length) return out;
            var rawList = (isObj(entryRules) && Array.isArray(entryRules.rows)) ? entryRules.rows : [];
            // Pair every usable raw row with its sanitized twin AT ITS RAW INDEX,
            // once. sanitizeEntryRules drops unusable rows, so indexing the
            // compacted list with a raw index would shift row identity: an
            // unusable row would make a later row's condition/value land on an
            // earlier row's write, and a trailing 'while'/'otherwise' could be
            // skipped entirely. Skip rows whose raw kind is unknown (fail-closed);
            // the sanitized twin is only used for its coerced operands.
            var pairs = [];
            for (var p = 0; p < rawList.length; p++) {
                var praw = rawList[p];
                if (!isObj(praw)) continue;
                var prk = str(praw.kind, 'if').trim().toLowerCase();
                if (!KINDS[prk]) continue;
                var pclean = sanitizeRow(praw);
                if (pclean) pairs.push({ raw: praw, row: pclean, index: p });
            }
            var fallback = null;
            for (var i = 0; i < pairs.length; i++) {
                var pr = pairs[i];
                var r = pr.row;
                if (r.kind === 'while') continue;
                if (r.kind === 'otherwise') {
                    if (!fallback) fallback = pr;
                    continue;
                }
                if (evaluateRow(pr.raw, ctx)) {
                    out.matched = r;
                    out.writes.push({ target: rowTarget(r, systemTarget), value: r.value, rowIndex: pr.index, kind: 'if' });
                    break;
                }
            }
            if (!out.matched && fallback) {
                out.matched = fallback.row;
                out.writes.push({ target: rowTarget(fallback.row, systemTarget), value: fallback.row.value, rowIndex: fallback.index, kind: 'otherwise' });
            }
            for (var w = 0; w < pairs.length; w++) {
                var pw = pairs[w];
                if (pw.row.kind !== 'while') continue;
                out.writes.push({ target: rowTarget(pw.row, systemTarget), value: pw.row.value, rowIndex: pw.index, kind: 'while' });
            }
        } catch (e) { /* resolve failure = no writes, never throws */ }
        return out;
    }

    /**
     * Parse `Label: value` lines of entry content into { normLabel: value }.
     * Used to build ctx.fieldValues ("another field's value") from the live
     * entry. Last occurrence of a label wins.
     */
    function parseFieldLines(content) {
        var out = {};
        try {
            var lines = str(content, '').split('\n');
            for (var i = 0; i < lines.length; i++) {
                var m = /^\s*([^:<>][^:]*?)\s*:(.*)$/.exec(lines[i]);
                if (!m) continue;
                var key = normLabel(m[1]);
                if (!key) continue;
                out[key] = str(m[2], '').trim();
            }
        } catch (e) { /* return what was collected */ }
        return out;
    }

    /**
     * Pure single-line edit: replace the existing `Label:` line value, or
     * append one before the closing limiter (or end of content). Generic,
     * label-parameterized form of the map's Current_Location upsert — every
     * other byte (including mixed EOL styles) is preserved exactly. The label
     * is canonicalised to its trimmed form on write; matching is
     * case-insensitive on the normalized label.
     */
    function upsertFieldLine(content, label, value) {
        try {
            var want = str(label, '').trim();
            if (!want) return null;
            var raw = (content === null || content === undefined) ? '' : String(content);
            var v = (value === null || value === undefined) ? '' : String(value);
            var parts = raw.split(/(\r\n|\n|\r)/);
            var lineCount = (parts.length + 1) / 2;
            var atLine = function (i) { return parts[i * 2]; };
            var isDelim = function (s) { return s === '\r\n' || s === '\n' || s === '\r'; };
            var wantN = normLabel(want);
            var lineRe = /^(\s*)([^:<>][^:]*?)(\s*:)(.*)$/;
            for (var i = 0; i < lineCount; i++) {
                var line = atLine(i);
                var m = lineRe.exec(line);
                if (m && normLabel(m[2]) === wantN) {
                    parts[i * 2] = m[1] + want + m[3] + ' ' + v;
                    return parts.join('');
                }
            }
            var lineOut = want + ': ' + v;
            var RE_LIM = /^\s*\*\*<\s*\/\s*([^<>\s][^<>]*?)\s*>\*\*\s*$/;
            var at = lineCount;
            for (var k = lineCount - 1; k >= 0; k--) {
                if (RE_LIM.test(atLine(k))) { at = k; break; }
            }
            if (raw === '') return lineOut;
            if (at >= lineCount) {
                var tail = '\n';
                for (var p = parts.length - 1; p >= 0; p--) {
                    if (isDelim(parts[p])) { tail = parts[p]; break; }
                }
                parts.push(tail, lineOut);
            } else {
                var pos = at * 2;
                var ins = '\n';
                if (pos + 1 < parts.length && isDelim(parts[pos + 1])) ins = parts[pos + 1];
                else if (pos - 1 >= 0 && isDelim(parts[pos - 1])) ins = parts[pos - 1];
                parts.splice(pos, 0, lineOut, ins);
            }
            return parts.join('');
        } catch (e) { return null; }
    }

    /**
     * Compute new content for one set-field-text write. Typed entries whose
     * type declares the target slot go through CC.applyType with
     * reorder:false (a minimal render that never reorders); because
     * reorder:false keeps existing lines byte-identical, the plain
     * single-line upsert then lands the value — the same two-step the map
     * uses for Current_Location placements. Untyped entries take the
     * single-line upsert directly. Returns the new content, the unchanged
     * content when the value already matches, or null when it cannot be
     * computed.
     */
    function computeFieldContent(entry, type, label, value) {
        try {
            if (!entry || typeof entry.content !== 'string') return null;
            var want = str(label, '').trim();
            if (!want) return null;
            var val = str(value, '');
            var base = entry.content;
            try {
                var CC = (typeof ELCompile !== 'undefined') ? ELCompile : (global && global.ELCompile) || null;
                if (type && isObj(type) && CC && typeof CC.applyType === 'function') {
                    var tOff = {};
                    for (var k in type) {
                        if (Object.prototype.hasOwnProperty.call(type, k)) tOff[k] = type[k];
                    }
                    tOff.reorder = false;
                    var vals = {};
                    vals[want] = val;
                    var r = CC.applyType(entry, tOff, { values: vals, reorder: false });
                    if (r && r.entry && typeof r.entry.content === 'string') base = r.entry.content;
                }
            } catch (e) { /* fall through to the upsert on the original content */ }
            return upsertFieldLine(base, want, val);
        } catch (e) { return null; }
    }

    global.ELRules = {
        KINDS: ['if', 'otherwise', 'while'],
        OPS: ['=', '!=', 'contains', '<', '>', 'empty'],
        SRCS: ['time', 'dow', 'field', 'map', 'relation'],
        ruleKey: ruleKey,
        parseRuleKey: parseRuleKey,
        sanitizeRow: sanitizeRow,
        sanitizeEntryRules: sanitizeEntryRules,
        evaluateRow: evaluateRow,
        resolveSystem: resolveSystem,
        parseFieldLines: parseFieldLines,
        upsertFieldLine: upsertFieldLine,
        computeFieldContent: computeFieldContent,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
