/**
 * hub-tools.js — Filesystem-style `tools.extra` definitions for hub agent-mode runs.
 *
 * Lorebooks are presented as folders, entries as files:
 *   lorebook://                    -> all linked books (root)
 *   lorebook://<Book>              -> entry listing for one book (directory)
 *   lorebook://<Book>/<uid>        -> one entry (file)
 *   charcard://                    -> character list (directory)
 *   charcard://<name|index|active>  -> one character card (file)
 *   author-note://                 -> active chat author note (file)
 *
 * Tools: ls / read / grep (read-only) + propose (stage-only, review-first).
 * propose NEVER writes: it only returns a JSON string the model must embed
 * in its final answer. The Feed + applyProposal path commits after review.
 *
 * Classic script. Factory: EL_buildHubTools(agent, st, opts) -> extra[].
 */

function EL_hubToolsStripHtml(s) {
    return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function EL_hubToolsLinkedNames(agent) {
    try {
        const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
        if (schema) return schema.getLinkedLorebookNames(agent) || [];
    } catch {}
    const names = new Set();
    try {
        for (const s of (agent?.injectedContext || [])) if (s?.lorebook) names.add(String(s.lorebook).trim());
        for (const l of (agent?.dynamicLinks || [])) if (l?.name) names.add(String(l.name).trim());
    } catch {}
    return [...names].filter(Boolean);
}

function EL_hubToolsIsLinked(agent, name) {
    try {
        const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
        if (schema) return schema.isLorebookLinked(agent, name);
    } catch {}
    return EL_hubToolsLinkedNames(agent).includes(String(name || '').trim());
}

function EL_hubToolsResolveSt(explicit) {
    if (explicit) return explicit;
    try {
        if (typeof stContext !== 'undefined' && stContext) return stContext;
    } catch {}
    try {
        const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
        if (host && host.SillyTavern && typeof host.SillyTavern.getContext === 'function') {
            return host.SillyTavern.getContext();
        }
    } catch {}
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) return SillyTavern.getContext();
    } catch {}
    return null;
}

async function EL_hubToolsLoadBook(st, name) {
    const data = await st.loadWorldInfo(name);
    if (!data || !data.entries) throw new Error(`Lorebook "${name}" not found or has no entries.`);
    return data.entries;
}

/**
 * Parse an fs-style path into { kind, book, uid, charRef }.
 * Tolerates bare book names (no scheme) and legacy lorebookName+uid args.
 */
function EL_parseFsPath(raw, fallback) {
    const fb = fallback || {};
    let p = String(raw ?? fb.path ?? '').trim();
    // Legacy fallback: { lorebookName, uid } without path.
    if (!p && fb.lorebookName) {
        const b = String(fb.lorebookName).trim();
        if (b && fb.uid !== undefined && fb.uid !== null && fb.uid !== '') return { kind: 'entry', book: b, uid: Number(fb.uid) };
        if (b) return { kind: 'entries', book: b };
    }
    if (!p) return { kind: 'books' };
    // Bare "Book/12" without scheme.
    if (!p.includes('://')) {
        const m = /^(.*?)\s*\/\s*(\d+)\s*$/.exec(p);
        if (m) return { kind: 'entry', book: m[1].trim(), uid: Number(m[2]) };
        return { kind: 'entries', book: p };
    }
    const [schemeRaw, ...rest] = p.split('://');
    const scheme = String(schemeRaw || '').toLowerCase().trim();
    const body = rest.join('://').trim().replace(/^\/+/, '');
    if (scheme === 'lorebook') {
        if (!body) return { kind: 'books' };
        const slash = body.lastIndexOf('/');
        if (slash === -1) return { kind: 'entries', book: body };
        const book = body.slice(0, slash).trim();
        const tail = body.slice(slash + 1).trim();
        if (/^\d+$/.test(tail)) return { kind: 'entry', book, uid: Number(tail) };
        // "Book/some comment" -> treat as entries listing (grep first).
        return { kind: 'entries', book: book || tail };
    }
    if (scheme === 'charcard' || scheme === 'char' || scheme === 'character') {
        if (!body) return { kind: 'chars' };
        return { kind: 'char', charRef: body };
    }
    if (scheme === 'author-note' || scheme === 'authornote' || scheme === 'author_note') {
        return { kind: 'author-note' };
    }
    if (scheme === 'persona' || scheme === 'user-persona') {
        return { kind: 'persona' };
    }
    return { kind: 'unknown', raw: p };
}

function EL_resolveCharCard(st, ref) {
    try {
        const chars = Array.isArray(st?.characters) ? st.characters : [];
        if (!chars.length) return null;
        const r = String(ref ?? 'active').trim();
        if (!r || /^active$/i.test(r)) {
            const idx = Number(st?.characterId);
            return Number.isInteger(idx) && chars[idx] ? { char: chars[idx], index: idx } : null;
        }
        const mIdx = /^index\s*:\s*(\d+)$/i.exec(r);
        if (mIdx) {
            const i = Number(mIdx[1]);
            return chars[i] ? { char: chars[i], index: i } : null;
        }
        if (/^\d+$/.test(r)) {
            const i = Number(r);
            return chars[i] ? { char: chars[i], index: i } : null;
        }
        const hit = chars.findIndex(c => String(c?.name || '').toLowerCase() === r.toLowerCase());
        if (hit !== -1) return { char: chars[hit], index: hit };
        const partial = chars.findIndex(c => String(c?.name || '').toLowerCase().includes(r.toLowerCase()));
        if (partial !== -1) return { char: chars[partial], index: partial };
        return null;
    } catch { return null; }
}

function EL_formatCharCard(st, found, maxChars) {
    if (!found || !found.char) return null;
    const c = found.char;
    const cut = (s, n) => {
        const t = EL_hubToolsStripHtml(s);
        return t.length > n ? t.slice(0, n) + ' ...[truncated]' : t;
    };
    return {
        path: `charcard://${c?.name || ('index:' + found.index)}`,
        index: found.index,
        name: c?.name || '',
        description: cut(c?.description ?? c?.data?.description ?? '', maxChars),
        personality: cut(c?.personality ?? c?.data?.personality ?? '', Math.floor(maxChars / 2)),
        scenario: cut(c?.scenario ?? c?.data?.scenario ?? '', Math.floor(maxChars / 2)),
        mes_example: cut(c?.mes_example ?? c?.data?.mes_example ?? '', Math.floor(maxChars / 2)),
        system_prompt: cut(c?.system_prompt ?? c?.data?.system_prompt ?? '', 2000),
        lorebook: c?.data?.extensions?.world || c?.data?.character_book?.name || '',
    };
}

/**
 * Build the inline extra-tools array for one hub agent-mode request.
 * @param {object} agent - v2 config
 * @param {object} st - SillyTavern context (resolved automatically if omitted)
 * @param {object} opts - { maxCharsPerEntry }
 */
function EL_buildHubTools(agent, st, opts) {
    opts = opts || {};
    const access = (agent?.toolScope && typeof agent.toolScope === 'object') ? agent.toolScope : {};
    const canCreate = access.allowCreate !== false;
    const canEdit = access.allowEdit !== false;
    const canDelete = access.allowDelete === true;
    const maxChars = Math.max(100, Math.min(50000, Number(opts.maxCharsPerEntry) || 8000));
    const cut = (s) => {
        const t = EL_hubToolsStripHtml(s);
        return t.length > maxChars ? t.slice(0, maxChars) + ' ...[truncated]' : t;
    };
    const gate = (name) => {
        if (!name || !EL_hubToolsIsLinked(agent, name)) {
            throw new Error(`Lorebook "${name}" is not linked to this agent — refusing. Linked: ${EL_hubToolsLinkedNames(agent).join(', ') || '(none)'}.`);
        }
    };

    const tools = [
        {
            name: 'ls',
            displayName: 'List lorebooks / entries',
            description: 'List like a folder. ls "lorebook://" lists linked books with entry counts. ls "lorebook://<Book>" lists entries (uid, keys, comment, order). ls "charcard://" lists characters. Paginate with limit/offset.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Folder path. Defaults to "lorebook://" (linked books).' },
                    limit: { type: 'number', description: 'Max rows (default 50, max 200).' },
                    offset: { type: 'number', description: 'Skip first N rows (default 0).' },
                },
                additionalProperties: false,
            },
            action: async (args) => {
                const ctx = EL_hubToolsResolveSt(st);
                if (!ctx) return JSON.stringify({ ok: false, error: 'SillyTavern context unavailable' });
                const parsed = EL_parseFsPath(args?.path || 'lorebook://', args);
                const limit = Math.max(1, Math.min(200, Number(args?.limit) || 50));
                const offset = Math.max(0, Number(args?.offset) || 0);
                try {
                    if (parsed.kind === 'books') {
                        const names = EL_hubToolsLinkedNames(agent);
                        const books = [];
                        for (const n of names) {
                            try {
                                const entries = await EL_hubToolsLoadBook(ctx, n);
                                books.push({ path: `lorebook://${n}`, name: n, entries: Object.keys(entries).length });
                            } catch (e) {
                                books.push({ path: `lorebook://${n}`, name: n, entries: null, error: e?.message || String(e) });
                            }
                        }
                        return JSON.stringify({ ok: true, path: 'lorebook://', books: books.slice(offset, offset + limit), total: books.length });
                    }
                    if (parsed.kind === 'chars') {
                        const chars = Array.isArray(ctx.characters) ? ctx.characters : [];
                        const list = chars.map((c, i) => ({ path: `charcard://${c?.name || ('index:' + i)}`, index: i, name: c?.name || `char_${i}` }));
                        return JSON.stringify({ ok: true, path: 'charcard://', characters: list.slice(offset, offset + limit), total: list.length, activeIndex: ctx.characterId ?? null });
                    }
                    if (parsed.kind === 'entries' || parsed.kind === 'entry') {
                        const book = String(parsed.book || '').trim();
                        try { gate(book); } catch (e) { return JSON.stringify({ ok: false, error: e?.message || String(e) }); }
                        const entries = await EL_hubToolsLoadBook(ctx, book);
                        const rows = Object.entries(entries).map(([uid, e]) => ({
                            path: `lorebook://${book}/${uid}`,
                            uid: Number(uid),
                            keys: Array.isArray(e?.key) ? e.key : [],
                            comment: e?.comment || '',
                            order: e?.order ?? 100,
                        }));
                        rows.sort((a, b) => (b.order - a.order) || (a.uid - b.uid));
                        return JSON.stringify({ ok: true, path: `lorebook://${book}`, book, entries: rows.slice(offset, offset + limit), total: rows.length });
                    }
                    return JSON.stringify({ ok: false, error: `Cannot ls "${args?.path || ''}". Use lorebook://, lorebook://<Book>, or charcard://.` });
                } catch (e) {
                    return JSON.stringify({ ok: false, error: e?.message || String(e) });
                }
            },
        },
        {
            name: 'read',
            displayName: 'Read entry / card file',
            description: 'Read one file fully. read "lorebook://<Book>/<uid>" for an entry (fetch uid via ls/grep first — never guess). read "charcard://<name|active>" for a character card. read "author-note://" for the author note.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path, e.g. lorebook://MyBook/12 or charcard://Aldric.' },
                },
                required: ['path'],
                additionalProperties: false,
            },
            action: async (args) => {
                const ctx = EL_hubToolsResolveSt(st);
                if (!ctx) return JSON.stringify({ ok: false, error: 'SillyTavern context unavailable' });
                const parsed = EL_parseFsPath(args?.path, args);
                try {
                    if (parsed.kind === 'entry') {
                        const book = String(parsed.book || '').trim();
                        const uid = Number(parsed.uid);
                        try { gate(book); } catch (e) { return JSON.stringify({ ok: false, error: e?.message || String(e) }); }
                        if (!Number.isInteger(uid)) return JSON.stringify({ ok: false, error: 'uid must be an integer — list it with ls first.' });
                        const entries = await EL_hubToolsLoadBook(ctx, book);
                        const e = entries[String(uid)];
                        if (!e) return JSON.stringify({ ok: false, error: `lorebook://${book}/${uid} not found` });
                        return JSON.stringify({
                            ok: true,
                            path: `lorebook://${book}/${uid}`,
                            entry: {
                                book, uid,
                                comment: e.comment || '', key: e.key || [], keysecondary: e.keysecondary || [],
                                content: cut(e.content || ''),
                                order: e.order ?? 100, position: e.position ?? 0, depth: e.depth ?? 4,
                                probability: e.probability ?? 100, selective: !!e.selective,
                                constant: !!e.constant, disable: !!e.disable,
                            },
                        });
                    }
                    if (parsed.kind === 'char') {
                        const found = EL_resolveCharCard(ctx, parsed.charRef);
                        if (!found) return JSON.stringify({ ok: false, error: `Character "${parsed.charRef || ''}" not found. ls charcard:// first.` });
                        return JSON.stringify({ ok: true, character: EL_formatCharCard(ctx, found, maxChars) });
                    }
                    if (parsed.kind === 'author-note') {
                        const note = EL_hubToolsStripHtml(ctx?.chatMetadata?.author_note ?? ctx?.chat_metadata?.author_note ?? '');
                        return JSON.stringify({ ok: true, path: 'author-note://', content: cut(note) });
                    }
                    if (parsed.kind === 'entries' && parsed.book) {
                        return JSON.stringify({ ok: false, error: `lorebook://${parsed.book} is a folder — ls it first, then read lorebook://${parsed.book}/<uid>.` });
                    }
                    return JSON.stringify({ ok: false, error: `Cannot read "${args?.path || ''}". Use lorebook://<Book>/<uid>, charcard://<name>, or author-note://.` });
                } catch (e) {
                    return JSON.stringify({ ok: false, error: e?.message || String(e) });
                }
            },
        },
        {
            name: 'grep',
            displayName: 'Search lorebook files',
            description: 'Search entry keys, content, and comments. grep "Status" in lorebook:// searches all linked books. Pass path lorebook://<Book> to narrow. Returns book, uid, keys, comment, and a snippet — then read the full file.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Keyword or phrase (regex allowed with regex:true).' },
                    path: { type: 'string', description: 'Where to search. Default lorebook:// (all linked books).' },
                    limit: { type: 'number', description: 'Max matches (default 20, max 50).' },
                    regex: { type: 'boolean', description: 'Treat pattern as regex (default false).' },
                },
                required: ['pattern'],
                additionalProperties: false,
            },
            action: async (args) => {
                const ctx = EL_hubToolsResolveSt(st);
                if (!ctx) return JSON.stringify({ ok: false, error: 'SillyTavern context unavailable' });
                const rawPattern = String(args?.pattern ?? args?.query ?? '').trim();
                if (!rawPattern) return JSON.stringify({ ok: false, error: 'pattern is empty' });
                const limit = Math.max(1, Math.min(50, Number(args?.limit) || 20));
                const useRegex = args?.regex === true;
                let re = null;
                if (useRegex) {
                    try { re = new RegExp(rawPattern, 'i'); }
                    catch (e) { return JSON.stringify({ ok: false, error: `Invalid regex: ${e?.message || e}` }); }
                }
                const q = rawPattern.toLowerCase();
                const parsed = EL_parseFsPath(args?.path || 'lorebook://', args);
                let names;
                if (parsed.kind === 'entries' || parsed.kind === 'entry') {
                    names = [String(parsed.book || '').trim()].filter(Boolean);
                } else {
                    names = EL_hubToolsLinkedNames(agent);
                }
                const matches = [];
                for (const n of names) {
                    try { gate(n); } catch (e) { continue; }
                    let entries;
                    try { entries = await EL_hubToolsLoadBook(ctx, n); } catch { continue; }
                    for (const [uid, e] of Object.entries(entries)) {
                        if (matches.length >= limit) break;
                        const keys = Array.isArray(e?.key) ? e.key : [];
                        const content = EL_hubToolsStripHtml(e?.content || '');
                        const hay = (keys.join(' ') + ' ' + content + ' ' + (e?.comment || ''));
                        let hit = false;
                        let snippet = '';
                        if (re) {
                            const m = hay.match(re);
                            if (m && m.index !== undefined) {
                                hit = true;
                                const start = Math.max(0, m.index - 60);
                                snippet = hay.slice(start, start + 220);
                            }
                        } else if (hay.toLowerCase().includes(q)) {
                            hit = true;
                            const idx = hay.toLowerCase().indexOf(q);
                            const start = Math.max(0, idx - 60);
                            snippet = hay.slice(start, start + 220);
                        }
                        if (!hit) continue;
                        matches.push({
                            path: `lorebook://${n}/${uid}`,
                            book: n, uid: Number(uid),
                            keys, comment: e?.comment || '', order: e?.order ?? 100,
                            snippet: snippet.length > maxChars ? snippet.slice(0, maxChars) + ' ...[truncated]' : snippet,
                        });
                    }
                    if (matches.length >= limit) break;
                }
                return JSON.stringify({ ok: true, pattern: rawPattern, matches });
            },
        },
    ];

    if (canCreate || canEdit || canDelete) {
        const allowed = [canCreate && 'create', canEdit && 'edit', canDelete && 'delete'].filter(Boolean).join('|');
        tools.push({
            name: 'propose',
            displayName: 'Stage a lorebook change proposal',
            description: `Stage ONE proposal for human review (allowed actions here: ${allowed}). This does NOT write anything — it only validates and returns the proposal object in FINAL answer shape. Call once per change, then paste every returned "proposal" object VERBATIM into your final {"proposals":[...]} JSON answer with no retyping. Your final round must be ONLY that JSON object, no prose. Paths: create at lorebook://<Book>, edit/delete at lorebook://<Book>/<uid>.`,
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: `One of: ${allowed}.` },
                    path: { type: 'string', description: 'Target path: lorebook://<Book> (create) or lorebook://<Book>/<uid> (edit/delete).' },
                    comment: { type: 'string', description: 'Entry title/comment (create; "title" alias also accepted).' },
                    title: { type: 'string', description: 'Alias for comment (create).' },
                    key: { type: 'array', items: { type: 'string' }, description: 'Primary keys (create).' },
                    keysecondary: { type: 'array', items: { type: 'string' }, description: 'Secondary keys (create, optional).' },
                    content: { type: 'string', description: 'Full new content (create) or replacement content (edit via changes.content).' },
                    order: { type: 'number', description: 'Entry order (create, optional, default 100).' },
                    position: { type: 'number', description: 'Insertion position (create, optional, default 0).' },
                    depth: { type: 'number', description: 'Recursion depth (create, optional, default 4).' },
                    probability: { type: 'number', description: 'Probability 0-100 (create, optional).' },
                    selective: { type: 'boolean', description: 'Selective logic toggle (create, optional).' },
                    constant: { type: 'boolean', description: 'Constant toggle (create, optional).' },
                    disable: { type: 'boolean', description: 'Disabled toggle (create, optional).' },
                    excludeRecursion: { type: 'boolean', description: 'Exclude recursion (create, optional).' },
                    preventRecursion: { type: 'boolean', description: 'Prevent recursion (create, optional).' },
                    vectorized: { type: 'boolean', description: 'Vectorized toggle (create, optional).' },
                    changes: { type: 'object', description: 'Edit only: {field: new value} map, e.g. {"content":"..."} or {"key":["a","b"]}. Same field names as entryData.' },
                    reasoning: { type: 'string', description: 'Why this change is needed (for the human reviewer).' },
                    confidence: { type: 'number', description: 'Your confidence 0..1.' },
                },
                required: ['action', 'path'],
                additionalProperties: false,
            },
            action: async (args) => {
                const action = String(args?.action || '').toLowerCase().trim();
                const parsed = EL_parseFsPath(args?.path, args);
                const name = String(parsed.book || args?.lorebookName || '').trim();
                try { gate(name); } catch (e) { return JSON.stringify({ ok: false, error: e?.message || String(e) }); }
                if (!['create', 'edit', 'delete'].includes(action)) {
                    return JSON.stringify({ ok: false, error: `Unknown action "${action}".` });
                }
                if (action === 'create' && !canCreate) return JSON.stringify({ ok: false, error: 'This agent may not create entries.' });
                if (action === 'edit' && !canEdit) return JSON.stringify({ ok: false, error: 'This agent may not edit entries.' });
                if (action === 'delete' && !canDelete) return JSON.stringify({ ok: false, error: 'This agent may not delete entries.' });
                let uid = (parsed.kind === 'entry' && Number.isInteger(Number(parsed.uid))) ? Number(parsed.uid) : null;
                if (uid === null && (args?.uid !== undefined && args.uid !== null && args.uid !== '')) {
                    const n = Number(args.uid);
                    if (Number.isInteger(n)) uid = n;
                }
                if ((action === 'edit' || action === 'delete') && !Number.isInteger(uid)) {
                    return JSON.stringify({ ok: false, error: 'edit/delete require a path like lorebook://<Book>/<uid> (ls/grep/read it first — never guess).' });
                }
                const strArr = (v) => Array.isArray(v) ? v.map(String).slice(0, 20) : [];
                const proposal = {
                    action, lorebookName: name,
                    reasoning: String(args?.reasoning || '').slice(0, 2000),
                    confidence: Math.min(1, Math.max(0, Number(args?.confidence ?? 0.5) || 0.5)),
                };
                if (uid !== null) proposal.uid = uid;
                if (action === 'create') {
                    const content = String(args?.content || '');
                    if (!content.trim()) return JSON.stringify({ ok: false, error: 'create requires content.' });
                    // Final-shape entryData: identical to what the parser expects,
                    // so the model pastes this object verbatim into {"proposals":[...]}.
                    proposal.entryData = {
                        comment: String(args?.comment ?? args?.title ?? 'Hub proposal').slice(0, 500),
                        key: strArr(args?.key),
                        keysecondary: strArr(args?.keysecondary),
                        content,
                    };
                    if (args?.order !== undefined && args.order !== null && args.order !== '') {
                        const n = Number(args.order);
                        if (Number.isFinite(n)) proposal.entryData.order = n;
                    }
                    if (args?.position !== undefined && args.position !== null && args.position !== '') {
                        const n = Number(args.position);
                        if (Number.isFinite(n)) proposal.entryData.position = n;
                    }
                    if (args?.depth !== undefined && args.depth !== null && args.depth !== '') {
                        const n = Number(args.depth);
                        if (Number.isFinite(n)) proposal.entryData.depth = n;
                    }
                    if (args?.probability !== undefined && args.probability !== null && args.probability !== '') {
                        const n = Number(args.probability);
                        if (Number.isFinite(n)) proposal.entryData.probability = n;
                    }
                    for (const b of ['selective', 'constant', 'disable', 'excludeRecursion', 'preventRecursion', 'vectorized']) {
                        if (args?.[b] !== undefined) proposal.entryData[b] = args[b] === true || String(args[b]).toLowerCase() === 'true';
                    }
                } else if (action === 'edit') {
                    const changes = (args?.changes && typeof args.changes === 'object') ? args.changes : null;
                    const fallback = args?.content !== undefined ? { content: String(args.content) } : null;
                    if (!changes && !fallback) return JSON.stringify({ ok: false, error: 'edit requires changes{...} or content.' });
                    proposal.changes = changes || fallback;
                }
                return JSON.stringify({ ok: true, proposal, note: 'Staged only — paste this "proposal" object VERBATIM into your final {"proposals":[...]} JSON answer. Nothing was written.' });
            },
        });
    }

    return tools;
}

if (typeof window !== 'undefined') {
    window.EL_buildHubTools = EL_buildHubTools;
    window.EL_parseFsPath = EL_parseFsPath;
}
