/**
 * Built-in Enhanced Lorebook plugin: Memory Organizer.
 *
 * The formatter is a verbatim port of ST-MemoryOrganizer/organizer.html so the
 * output is byte-for-byte what the standalone page produced. It is a pure
 * transformation: it reads the source entry's content and returns plain items;
 * the hub creates entries, applies settings and performs the guarded save.
 */
(function () {
    'use strict';

    var STRAY_PATTERNS = [
        /^```\s*$/gm,
        /^#\s+\d+\s*$/gm,
    ];

    var WITNESS_MARKERS = [
        'List of characters who witnessed this memory or have knowledge of it:',
        'List of characters who witnessed this memory of have knowledge of it:',
        'List of characters who witnessed this memory:',
        'Characters present:',
        'Witnesses:',
    ];

    var MONTH_MAP = {
        january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
        july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    };

    function parseMemories(text) {
        var seen = new Set();
        var memories = [];
        var pattern = /<Memory_(\d+)>/g;
        var matches = [];
        var m;
        while ((m = pattern.exec(text)) !== null) {
            matches.push({ index: m.index, num: parseInt(m[1], 10) });
        }
        for (var i = 0; i < matches.length; i++) {
            var num = matches[i].num;
            var contentStart = matches[i].index + ('<Memory_' + num + '>').length;
            var contentEnd = (i + 1 < matches.length) ? matches[i + 1].index : text.length;
            var raw = text.slice(contentStart, contentEnd).trim();
            raw = raw.replace(/<\/Memory_\d+>/g, '').trim();
            if (!raw) continue;
            var titleMatch = raw.match(/^#\s+/m);
            if (titleMatch) raw = raw.slice(titleMatch.index).trim();
            var lastEnd = -1;
            for (var j = 0; j < WITNESS_MARKERS.length; j++) {
                var idx = raw.lastIndexOf(WITNESS_MARKERS[j]);
                if (idx !== -1) {
                    var lineEnd = raw.indexOf('\n', idx);
                    lastEnd = Math.max(lastEnd, lineEnd !== -1 ? lineEnd + 1 : raw.length);
                }
            }
            if (lastEnd !== -1) raw = raw.slice(0, lastEnd).trim();
            if (raw && !seen.has(raw)) {
                seen.add(raw);
                memories.push({ origNum: num, text: raw });
            }
        }
        return memories;
    }

    function fixRelevancy(content) {
        content = content.replace(/\(10\s*[Yy]ear\)/g, '(High)');
        content = content.replace(/\(5\s*[Yy]ear\)/g, '(Medium)');
        content = content.replace(/\(1\s*[Yy]ear\)/g, '(Low)');
        content = content.replace(/\([Ll]ife.?[Tt]ime\)/g, '(Life-time)');
        content = content.replace(/\([Hh]igh\)/g, '(High)');
        content = content.replace(/\([Mm]edium\)/g, '(Medium)');
        content = content.replace(/\([Ll]ow\)/g, '(Low)');
        return content;
    }

    function fixWitnessList(content) {
        content = content.replace(/of have knowledge/g, 'or have knowledge');
        content = content.replace(/Characters present:/g, 'List of characters who witnessed this memory or have knowledge of it:');
        content = content.replace(/List of characters who witnessed this memory:(?! or)/g, 'List of characters who witnessed this memory or have knowledge of it:');
        content = content.replace(/^Witnesses:/gm, 'List of characters who witnessed this memory or have knowledge of it:');
        return content;
    }

    function scrubStrayMarkup(content) {
        for (var i = 0; i < STRAY_PATTERNS.length; i++) content = content.replace(STRAY_PATTERNS[i], '');
        return content.trim();
    }

    function fixDates(content) {
        content = content.replace(/\[(\d{1,2})\/(\d{1,2})\/(\d{4})\]/g, 'On $1/$2/$3');
        content = content.replace(/On (\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})/g, function (_, month, day, year) {
            var mm = MONTH_MAP[String(month).toLowerCase()];
            if (!mm) return _;
            return 'On ' + String(day).padStart(2, '0') + '/' + String(mm).padStart(2, '0') + '/' + year;
        });
        return content;
    }

    function extractTitle(content) {
        var m1 = content.match(/#\s+(.+?)\s*\((?:High|Medium|Low|Life-time)\)/);
        if (m1) return m1[1].trim();
        var m2 = content.match(/#\s+(.+)/);
        if (m2) return m2[1].trim();
        return 'Untitled';
    }

    function formatXml(innerContent, order) {
        var reconstructed = '<Memory_' + order + '>\n' + innerContent + '\n</Memory_' + order + '>';
        var title = extractTitle(reconstructed);
        return '<Title>Memory ' + order + ': ' + title + '</Title>\n'
            + '<Content>\n' + reconstructed + '\n</Content>\n'
            + '<Order>' + order + '</Order>';
    }

    function processMemories(text, startAt) {
        var raw = parseMemories(String(text || ''));
        var fixed = raw.map(function (memory) {
            var content = fixRelevancy(memory.text);
            content = fixWitnessList(content);
            content = fixDates(content);
            return scrubStrayMarkup(content);
        });
        var items = fixed.map(function (content, i) {
            var order = startAt + i;
            return {
                comment: 'Memory ' + order + ': ' + extractTitle('<Memory_' + order + '>\n' + content + '\n</Memory_' + order + '>'),
                content: formatXml(content, order),
                order: order,
                key: [],
            };
        });
        return { items: items, count: items.length };
    }

    window.ELMemoryOrganizer = {
        parseMemories: parseMemories,
        fixRelevancy: fixRelevancy,
        fixWitnessList: fixWitnessList,
        scrubStrayMarkup: scrubStrayMarkup,
        fixDates: fixDates,
        extractTitle: extractTitle,
        formatXml: formatXml,
        processMemories: processMemories,
    };

    if (window.ELPluginRegistry && typeof window.ELPluginRegistry.register === 'function') {
        window.ELPluginRegistry.register({
            id: 'memory-organizer',
            name: 'Memory Organizer',
            title: 'Memory Organizer',
            icon: 'fa-brain',
            run: function (ctx) {
                var startAt = Math.max(1, parseInt((ctx && ctx.startAt) || 1, 10) || 1);
                return Promise.resolve(processMemories((ctx && ctx.sourceContent) || '', startAt));
            },
        });
    }
})();
