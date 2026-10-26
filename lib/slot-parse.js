/**
 * slot-parse.js
 *
 * The slot-template parser/renderer of the Enhanced Lorebook revamp
 * (Track A1). It owns the three template constructs:
 *   - limiter lines:  <tag> / </tag> (the tag itself is a parameter, never
 *     hardcoded). The legacy **<tag>** / **</tag>** form is still accepted
 *     on read (parse/extract/rename) but never emitted.
 *   - fixed text:     "any quoted text" — literal, never edited
 *   - slots:          ||kind:label|| or ||kind:label | param value ...||
 *   - section headers: == Title == (template/preview only — renderContent
 *     never emits them into entry content)
 *   - display lines:  >> show <label list>
 *
 * It is deliberately DOM-free: pure string functions only, no window, no
 * document, no fetch. Like apply-core.js it has no imports/exports — it
 * publishes one namespace object, ELSlots, on the global scope, so the SAME
 * file runs in the app window and the host window.
 */
(function (global) {
    'use strict';

    // Must stay in sync with lib/type-registry.js ELTypeRegistry.KNOWN_KINDS.
    // The parser itself keeps unknown kinds (dropping them is sanitizeType's
    // job); this list only drives the space-separated param sub-splitting.
    var KNOWN_KINDS = Object.freeze([
        'cont', 'img', 'ref', 'gallery', 'radar', 'display',
        'conditional', 'setref', 'getref', 'hub',
    ]);

    var KNOWN_PARAMS = Object.freeze([
        'limit', 'inject', 'axes', 'hide', 'keys', 'when', 'else', 'target', 'def',
    ]);

    // Params whose canonical emission is always double-quoted.
    var QUOTED_PARAMS = { else: true, def: true };

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

    // Canonical limiter form is <tag> / </tag> (no asterisks). The legacy
    // **<tag>** / **</tag>** forms are still accepted on READ (parse,
    // extract, rename, detach) for backward compatibility with entries
    // written before the migration; all emission uses the new form.
    var RE_OPEN = /^\s*<\s*([^<>\s][^<>]*?)\s*>\s*$/;
    var RE_CLOSE = /^\s*<\s*\/\s*([^<>\s][^<>]*?)\s*>\s*$/;
    var RE_OPEN_LEGACY = /^\s*\*\*<\s*([^<>\s][^<>]*?)\s*>\*\*\s*$/;
    var RE_CLOSE_LEGACY = /^\s*\*\*<\s*\/\s*([^<>\s][^<>]*?)\s*>\*\*\s*$/;
    var RE_HEADER = /^\s*==\s*(.+?)\s*==\s*$/;
    var RE_DISPLAY = /^\s*>>\s*show\s+(.+?)\s*$/;

    function isLimiter(line) { return RE_OPEN.test(line) || RE_CLOSE.test(line) || RE_OPEN_LEGACY.test(line) || RE_CLOSE_LEGACY.test(line); }
    function isHeader(line) { return RE_HEADER.test(line); }
    function isDisplay(line) { return RE_DISPLAY.test(line); }
    function isBlank(line) { return /^\s*$/.test(line); }
    function isStructural(line) { return isBlank(line) || isLimiter(line) || isHeader(line) || isDisplay(line); }

    function openTagOf(line) { var m = RE_OPEN.exec(line) || RE_OPEN_LEGACY.exec(line); return m ? m[1].trim() : null; }
    function closeTagOf(line) { var m = RE_CLOSE.exec(line) || RE_CLOSE_LEGACY.exec(line); return m ? m[1].trim() : null; }

    // Quote-aware param splitter: splits one '|' segment into [{key, value}]
    // on known param keywords found outside double quotes. Unknown leading
    // words are kept as params too (forward compatibility) with a warning.
    function splitParams(segment, warnings, loc) {
        var out = [];
        var text = str(segment, '').trim();
        if (!text) return out;
        var tokens = [];
        var buf = '';
        var inQ = false;
        for (var i = 0; i < text.length; i++) {
            var c = text[i];
            if (c === '"') { inQ = !inQ; buf += c; continue; }
            if (!inQ && (c === ' ' || c === '\t')) {
                if (buf) { tokens.push(buf); buf = ''; }
                continue;
            }
            buf += c;
        }
        if (buf) tokens.push(buf);
        var cur = null;
        for (var t = 0; t < tokens.length; t++) {
            var word = tokens[t];
            var key = word.toLowerCase();
            if (KNOWN_PARAMS.indexOf(key) !== -1 && cur !== null) {
                cur = { key: key, value: '' };
                out.push(cur);
                continue;
            }
            if (cur === null) {
                cur = { key: key, value: '' };
                out.push(cur);
                if (KNOWN_PARAMS.indexOf(key) === -1 && warnings) {
                    warnings.push(loc + ': unknown param "' + word + '" — kept as-is.');
                }
                continue;
            }
            cur.value = cur.value ? cur.value + ' ' + word : word;
        }
        return out;
    }

    function stripQuotes(v) {
        var s = str(v, '').trim();
        if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
        return s;
    }

    // Split on '|' characters that sit outside double quotes (quote-aware so
    // values like def "a | b" survive). Backslash-escaped quotes do not
    // toggle the in-quote state.
    function splitPipes(s) {
        var parts = [];
        var buf = '';
        var inQ = false;
        var text = str(s, '');
        for (var i = 0; i < text.length; i++) {
            var c = text[i];
            if (c === '"' && (i === 0 || text[i - 1] !== '\\')) { inQ = !inQ; buf += c; continue; }
            if (c === '|' && !inQ) { parts.push(buf); buf = ''; continue; }
            buf += c;
        }
        parts.push(buf);
        return parts;
    }

    function parseSlotInner(inner, raw, warnings, loc) {
        var parts = splitPipes(inner);
        var head = parts[0].trim();
        var m = /^([A-Za-z][\w-]*)\s*:\s*([\s\S]+?)\s*$/.exec(head);
        if (!m || !m[2].trim()) {
            warnings.push(loc + ': could not parse slot head "' + head + '" — kept as fixed text.');
            return { t: 'fixed', text: raw, quoted: false };
        }
        var slot = { t: 'slot', kind: m[1], label: m[2].trim(), params: {}, raw: raw };
        for (var p = 1; p < parts.length; p++) {
            var seg = parts[p].trim();
            if (!seg) continue;
            var found = splitParams(seg, warnings, loc);
            for (var f = 0; f < found.length; f++) {
                var key = found[f].key;
                var val = found[f].value;
                if (key === 'hide' && !val) { slot.params.hide = true; continue; }
                if (key === 'limit') {
                    var n = parseInt(val, 10);
                    if (isFinite(n) && n >= 0) { slot.params.limit = n; }
                    else if (warnings) { warnings.push(loc + ': invalid limit "' + val + '" — dropped the limit.'); }
                    continue;
                }
                if (key === 'else' || key === 'def') { slot.params[key] = stripQuotes(val); continue; }
                slot.params[key] = key === 'hide' ? true : stripQuotes(val);
            }
        }
        return slot;
    }

    // Tokenize one body line into blocks. Malformed input (unclosed slot or
    // quote) never throws: the remainder becomes fixed text plus a warning.
    function tokenizeLine(line, warnings, loc) {
        var blocks = [];
        var i = 0;
        var n = line.length;
        function skipSpaces() { while (i < n && (line[i] === ' ' || line[i] === '\t')) i++; }
        while (i < n) {
            skipSpaces();
            if (i >= n) break;
            if (line[i] === '"') {
                var j = i + 1;
                var val = '';
                var closed = false;
                while (j < n) {
                    if (line[j] === '\\' && j + 1 < n) { val += line[j] + line[j + 1]; j += 2; continue; }
                    if (line[j] === '"') { closed = true; break; }
                    val += line[j];
                    j++;
                }
                if (!closed) {
                    warnings.push(loc + ': unclosed quote — kept the rest of the line as fixed text.');
                    blocks.push({ t: 'fixed', text: line.slice(i), quoted: false });
                    i = n;
                    break;
                }
                blocks.push({ t: 'fixed', text: val, quoted: true });
                i = j + 1;
                continue;
            }
            if (line[i] === '|' && line[i + 1] === '|') {
                var end = line.indexOf('||', i + 2);
                if (end === -1) {
                    warnings.push(loc + ': unclosed slot — kept the rest of the line as fixed text.');
                    blocks.push({ t: 'fixed', text: line.slice(i).trim(), quoted: false });
                    i = n;
                    break;
                }
                var raw = line.slice(i, end + 2);
                var inner = line.slice(i + 2, end);
                blocks.push(parseSlotInner(inner, raw, warnings, loc));
                i = end + 2;
                continue;
            }
            var k = i;
            while (k < n && line[k] !== '"' && !(line[k] === '|' && line[k + 1] === '|')) k++;
            var bare = line.slice(i, k).trim();
            if (bare) blocks.push({ t: 'fixed', text: bare, quoted: false });
            i = k;
        }
        return blocks;
    }

    /**
     * Parse template text into {tag, sections:[{title, blocks}], warnings[]}.
     * Tolerates malformed input (missing limiters, unclosed slots/quotes,
     * unknown kinds) via warnings — never throws on string input.
     */
    function parseTemplate(text) {
        var warnings = [];
        if (typeof text !== 'string') {
            return { tag: '', sections: [], warnings: ['input is not a string — returned an empty template.'] };
        }
        var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        var tag = '';
        var start = 0;
        var openIdx = -1;
        for (var o = 0; o < lines.length; o++) {
            if (isBlank(lines[o])) continue;
            var ot = openTagOf(lines[o]);
            if (ot !== null) { tag = ot; openIdx = o; break; }
            warnings.push('line ' + (o + 1) + ': expected opening <tag> limiter — treated as body text.');
            break;
        }
        start = openIdx === -1 ? 0 : openIdx + 1;
        var closeIdx = -1;
        for (var c = start; c < lines.length; c++) {
            var ct = closeTagOf(lines[c]);
            if (ct !== null) {
                if (tag && ct !== tag) warnings.push('line ' + (c + 1) + ': closing tag "' + ct + '" does not match opening tag "' + tag + '".');
                if (!tag) tag = ct;
                closeIdx = c;
                break;
            }
        }
        if (openIdx !== -1 && closeIdx === -1) warnings.push('missing closing </' + (tag || 'tag') + '> limiter.');
        var end = closeIdx === -1 ? lines.length : closeIdx;
        if (closeIdx !== -1) {
            for (var a = closeIdx + 1; a < lines.length; a++) {
                if (!isBlank(lines[a])) { warnings.push('line ' + (a + 1) + ': content after the closing limiter is ignored.'); break; }
            }
        }
        var sections = [];
        var current = null;
        function ensureSection() {
            if (!current) { current = { title: '', blocks: [] }; sections.push(current); }
            return current;
        }
        for (var l = start; l < end; l++) {
            var line = lines[l];
            var loc = 'line ' + (l + 1);
            if (isBlank(line)) { ensureSection().blocks.push({ t: 'blank' }); continue; }
            if (isLimiter(line)) { warnings.push(loc + ': nested limiter line ignored.'); continue; }
            var h = RE_HEADER.exec(line);
            if (h) { current = { title: h[1].trim(), blocks: [] }; sections.push(current); continue; }
            var d = RE_DISPLAY.exec(line);
            if (d) {
                var labels = d[1].split(',').map(function (s) { return s.trim(); }).filter(function (s) { return !!s; });
                ensureSection().blocks.push({ t: 'display', labels: labels });
                continue;
            }
            var blocks = tokenizeLine(line, warnings, loc);
            if (!blocks.length) { ensureSection().blocks.push({ t: 'blank' }); continue; }
            var sec = ensureSection();
            for (var b = 0; b < blocks.length; b++) sec.blocks.push(blocks[b]);
        }
        return { tag: tag, sections: sections, warnings: warnings };
    }

    function emitSlot(slot) {
        var head = str(slot.kind, '') + ':' + str(slot.label, '');
        var params = (slot && slot.params) || {};
        var keys = Object.keys(params);
        if (!keys.length) return '||' + head + '||';
        var segs = keys.map(function (k) {
            var v = params[k];
            if (k === 'hide' && (v === true || v === '' || v === undefined)) return 'hide';
            var out = str(v, '');
            if (QUOTED_PARAMS[k]) out = '"' + out + '"';
            return (out ? k + ' ' + out : k);
        });
        return '|| ' + head + ' | ' + segs.join(' | ') + ' ||';
    }

    function emitBlockLine(blocks) {
        return blocks.map(function (b) {
            if (b.t === 'slot') return emitSlot(b);
            if (b.t === 'display') return '>> show ' + (b.labels || []).join(', ');
            if (b.t === 'fixed') return b.quoted ? '"' + b.text + '"' : str(b.text, '');
            return '';
        }).join(' ');
    }

    /**
     * Serialize an AST back to text. Grouping rule (no explicit line breaks
     * are stored on blocks): a fixed text ending in ':' stays on the same
     * line as a following slot; every slot, display line and blank ends its
     * line. parseTemplate(emitTemplate(parseTemplate(x))) is therefore stable.
     */
    function emitTemplate(ast) {
        var lines = [];
        try {
            if (!ast || typeof ast !== 'object') return '';
            var tag = str(ast.tag, '');
            if (tag) lines.push('<' + tag + '>');
            var sections = Array.isArray(ast.sections) ? ast.sections : [];
            for (var s = 0; s < sections.length; s++) {
                var sec = sections[s] || {};
                if (str(sec.title, '')) lines.push('== ' + str(sec.title, '') + ' ==');
                var blocks = Array.isArray(sec.blocks) ? sec.blocks : [];
                var cur = [];
                function flush() { if (cur.length) { lines.push(emitBlockLine(cur)); cur = []; } }
                for (var b = 0; b < blocks.length; b++) {
                    var blk = blocks[b] || {};
                    if (blk.t === 'display') { flush(); lines.push(emitBlockLine([blk])); continue; }
                    if (blk.t === 'blank') { flush(); lines.push(''); continue; }
                    if (blk.t === 'slot') { cur.push(blk); flush(); continue; }
                    if (blk.t === 'fixed') {
                        var next = blocks[b + 1] || {};
                        cur.push(blk);
                        var stays = !!blk.quoted && /:\s*$/.test(str(blk.text, '')) && next.t === 'slot';
                        if (!stays) flush();
                        continue;
                    }
                    // Unknown block shapes are stringified, never dropped.
                    cur.push({ t: 'fixed', text: str(blk.text !== undefined ? blk.text : '', ''), quoted: false });
                    flush();
                }
                flush();
            }
            if (tag) lines.push('</' + tag + '>');
            return lines.join('\n');
        } catch (e) { return lines.join('\n'); }
    }

    /**
     * Lightweight scan: [{kind, label, line}] (1-based) without a full parse.
     * Lines whose slot head cannot be parsed are skipped silently.
     */
    function findSlots(text) {
        var out = [];
        if (typeof text !== 'string') return out;
        var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        for (var l = 0; l < lines.length; l++) {
            var line = lines[l];
            var i = 0;
            while (i < line.length) {
                var start = line.indexOf('||', i);
                if (start === -1) break;
                var j = start + 2;
                var inQ = false;
                var end = -1;
                while (j < line.length) {
                    var c = line[j];
                    if (c === '"' && (j === 0 || line[j - 1] !== '\\')) { inQ = !inQ; j++; continue; }
                    if (!inQ && c === '|' && line[j + 1] === '|') { end = j; break; }
                    j++;
                }
                if (end === -1) break;
                var inner = line.slice(start + 2, end);
                var parts = splitPipes(inner);
                var m = /^\s*([A-Za-z][\w-]*)\s*:\s*([\s\S]+?)\s*$/.exec(parts[0]);
                i = end + 2;
                if (!m || !m[2].trim()) continue;
                out.push({ kind: m[1], label: m[2].trim(), line: l + 1 });
            }
        }
        return out;
    }

    function collectSlotLabels(ast) {
        var labels = [];
        var seen = {};
        var sections = (ast && Array.isArray(ast.sections)) ? ast.sections : [];
        for (var s = 0; s < sections.length; s++) {
            var blocks = (sections[s] && Array.isArray(sections[s].blocks)) ? sections[s].blocks : [];
            for (var b = 0; b < blocks.length; b++) {
                if (blocks[b] && blocks[b].t === 'slot') {
                    var label = str(blocks[b].label, '');
                    if (label && !Object.prototype.hasOwnProperty.call(seen, normLabel(label))) {
                        seen[normLabel(label)] = true;
                        labels.push(label);
                    }
                }
            }
        }
        return labels;
    }

    /**
     * Match-by-label value extraction: for each slot label, find `Label:`
     * line(s) in content (case/underscore/space-insensitive) and capture the
     * value up to the next `Label:`, limiter, header or display line.
     * Continuation lines (non-empty, non-structural) extend the current
     * value; a blank line ends it. A `Tags:` value continues only onto a
     * list-shaped line (containing `,` or `;`); any other follower ends the
     * tag run and is preserved as `extra`. Lines matching no slot become `extra`
     * (preserved, never dropped), EXCEPT `Tags:` lines: when no slot claims
     * the `tags` label those are old ST tag metadata, consumed into `tags`
     * (split on commas/semicolons) so the compiler can migrate them into the
     * typed limiter tag instead of leaking them into `extra`. Old `==...==`
     * section headers are structural (ignored, never extra), in either
     * limiter form. Every slot label is present in `values` (missing → '').
     */
    function extractValues(content, ast) {
        var values = {};
        var extra = [];
        var tags = [];
        try {
            var labels = collectSlotLabels(ast);
            var byNorm = {};
            for (var i = 0; i < labels.length; i++) {
                values[labels[i]] = '';
                byNorm[normLabel(labels[i])] = labels[i];
            }
            if (typeof content !== 'string') return { values: values, extra: extra, tags: tags };
            var lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
            var current = null;
            for (var l = 0; l < lines.length; l++) {
                var line = lines[l];
                if (isBlank(line)) { current = null; continue; }
                if (isLimiter(line) || isHeader(line) || isDisplay(line)) { current = null; continue; }
                var m = /^\s*(.+?)\s*:(.*)$/.exec(line);
                var key = m ? byNorm[normLabel(m[1])] : null;
                // A slot-syntax line in content is structural, not a value.
                if (!key && line.indexOf('||') !== -1) {
                    var found = findSlots(line);
                    if (found.length) { current = null; continue; }
                }
                if (!key && m && normLabel(m[1]) === 'tags') {
                    var bits = str(m[2], '').split(/[,\n;]+/);
                    for (var g = 0; g < bits.length; g++) {
                        var gb = bits[g].trim();
                        if (gb) tags.push(gb);
                    }
                    current = '@tags';
                    continue;
                }
                if (key) {
                    var v = str(m[2], '').trim();
                    values[key] = values[key] ? values[key] + '\n' + v : v;
                    current = key;
                    continue;
                }
                if (current) {
                    if (current === '@tags') {
                        // Only a list-shaped line continues a Tags: value. A
                        // plain prose line ends it and is preserved as extra:
                        // swallowing arbitrary followers into `tags` would
                        // silently drop real content on the next compile.
                        if (/[,;]/.test(line)) {
                            var more = line.split(/[,;]+/);
                            for (var h = 0; h < more.length; h++) {
                                var hb = more[h].trim();
                                if (hb) tags.push(hb);
                            }
                        } else {
                            current = null;
                            extra.push(line.trim());
                        }
                    } else {
                        values[current] = values[current] ? values[current] + '\n' + line.trim() : line.trim();
                    }
                } else {
                    extra.push(line.trim());
                }
            }
            return { values: values, extra: extra, tags: tags };
        } catch (e) { return { values: values, extra: extra, tags: tags }; }
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

    function slotRenderValue(slot, values, opts) {
        var label = str(slot.label, '');
        var params = (slot && slot.params) || {};
        var cond = (opts && opts.conditionStates) || {};
        var fb = (opts && opts.fallbacks) || {};
        if (slot.kind === 'conditional') {
            var state = Object.prototype.hasOwnProperty.call(cond, label) ? cond[label] : true;
            if (state === false) {
                if (Object.prototype.hasOwnProperty.call(fb, label)) return str(fb[label], '');
                return str(params.else !== undefined ? params.else : '', '');
            }
            var v = lookupValue(values, label);
            if (v) return v;
            if (Object.prototype.hasOwnProperty.call(fb, label)) return str(fb[label], '');
            return str(params.else !== undefined ? params.else : '', '');
        }
        return lookupValue(values, label);
    }

    /**
     * Rebuild content from an AST + values: fixed text verbatim (quotes
     * stripped), slots replaced by their value (missing → the `Label:` line
     * is kept with an empty value). Section headers (`== Title ==`) are
     * NEVER emitted — sections are UI-only groupings that live in the type
     * template/preview (parseTemplate/emitTemplate keep them) but must not
     * reach the prompt. Limiters use the canonical <tag> form; display lines
     * are reproduced verbatim; conditional slots resolved via
     * opts.conditionStates ({label:bool}) with opts.fallbacks ({label:text}).
     * opts.extra (string[]) is appended bare (no `== Extra ==` header, which
     * would itself be a prompt-injected `==` line); old `== ... ==` lines in
     * existing content are skipped as structural on extract, so this
     * round-trips cleanly.
     */
    function renderContent(ast, values, opts) {
        var lines = [];
        try {
            if (!ast || typeof ast !== 'object') return '';
            var o = opts || {};
            var extraLines = Array.isArray(o.extra) ? o.extra : [];
            var tag = str(ast.tag, '');
            if (tag) lines.push('<' + tag + '>');
            var sections = Array.isArray(ast.sections) ? ast.sections : [];
            for (var s = 0; s < sections.length; s++) {
                var sec = sections[s] || {};
                // Section titles are UI-only groupings: never emitted into
                // entry content (see doc comment above). Grouping survives
                // via block order; the form UI reads type.sections directly.
                var blocks = Array.isArray(sec.blocks) ? sec.blocks : [];
                var cur = [];
                function flush() {
                    if (!cur.length) return;
                    lines.push(cur.join(' '));
                    cur = [];
                }
                function pushMultiline(text) {
                    var parts = str(text, '').split('\n');
                    if (!parts.length) return;
                    cur.push(parts[0]);
                    flush();
                    for (var p = 1; p < parts.length - 1; p++) lines.push(parts[p]);
                    if (parts.length > 1) {
                        if (parts[parts.length - 1]) cur.push(parts[parts.length - 1]);
                        else if (parts.length > 2 || parts[0]) { /* trailing newline: nothing pending */ }
                    }
                }
                for (var b = 0; b < blocks.length; b++) {
                    var blk = blocks[b] || {};
                    if (blk.t === 'display') { flush(); lines.push('>> show ' + (blk.labels || []).join(', ')); continue; }
                    if (blk.t === 'blank') { flush(); lines.push(''); continue; }
                    if (blk.t === 'slot') {
                        var label = str(blk.label, '');
                        var fixedPrefix = cur.join(' ');
                        var hasLabel = false;
                        var hm = /^\s*(.+?)\s*:/.exec(fixedPrefix);
                        if (hm) hasLabel = normLabel(hm[1]) === normLabel(label);
                        var val = slotRenderValue(blk, values, o);
                        if (!fixedPrefix && !val) {
                            lines.push(label + ':');
                            continue;
                        }
                        if (!fixedPrefix) {
                            lines.push(label + ': ' + val);
                            continue;
                        }
                        if (!hasLabel && !val) { flush(); lines.push(label + ':'); continue; }
                        pushMultiline(val);
                        continue;
                    }
                    if (blk.t === 'fixed') {
                        var txt = blk.quoted ? str(blk.text, '') : str(blk.text, '');
                        var next = blocks[b + 1] || {};
                        cur.push(txt);
                        var stays = !!blk.quoted && /:\s*$/.test(str(blk.text, '')) && next.t === 'slot';
                        if (!stays) flush();
                        continue;
                    }
                }
                flush();
            }
            // Extras ride along bare, with no `== Extra ==` header: any `==`
            // line in final content would itself be prompt-injected section
            // markup, and old `== ... ==` lines are skipped as structural on
            // extract, so this round-trips cleanly.
            for (var e = 0; e < extraLines.length; e++) lines.push(str(extraLines[e], ''));
            if (tag) lines.push('</' + tag + '>');
            return lines.join('\n');
        } catch (e) { return lines.join('\n'); }
    }

    /**
     * Rename the tag in both limiter lines (canonical and legacy — the
     * line's form is preserved, not migrated; migration happens on the next
     * canonical render); every other line is untouched.
     */
    function renameTag(text, newTag) {
        if (typeof text !== 'string') return text;
        var name = str(newTag, '').trim();
        if (!name) return text;
        if (/[\r\n<>*|]/.test(name)) return text;
        var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        for (var l = 0; l < lines.length; l++) {
            var m = /^(\s*(?:\*\*<|<\s*)\s*\/?\s*)([^<>\*]+?)(\s*(?:>\*\*|>)\s*)$/.exec(lines[l]);
            if (m) lines[l] = m[1] + name + m[3];
        }
        return lines.join('\n');
    }

    global.ELSlots = {
        KNOWN_KINDS: KNOWN_KINDS,
        KNOWN_PARAMS: KNOWN_PARAMS,
        parseTemplate: parseTemplate,
        emitTemplate: emitTemplate,
        extractValues: extractValues,
        renderContent: renderContent,
        renameTag: renameTag,
        findSlots: findSlots,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
