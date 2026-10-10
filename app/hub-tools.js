/**
 * hub-tools.js — Inline `tools.extra` definitions for hub agent-mode runs.
 *
 * These run IN-PAGE (popup or main window) as the `action` callbacks the hub
 * invokes each tool round. They NEVER write: propose_* only returns a JSON
 * string the model must embed in its final answer. The Feed + applyProposal
 * path commits everything after human review.
 *
 * Classic script. Factory: EL_buildHubTools(agent, st, opts) → extra[].
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
            name: 'LorebookListBooks',
            displayName: 'List linked lorebooks',
            description: 'List the lorebooks linked to this agent with entry counts. Call first to learn what is in scope.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            action: async () => {
                const ctx = EL_hubToolsResolveSt(st);
                if (!ctx) return JSON.stringify({ ok: false, error: 'SillyTavern context unavailable' });
                const names = EL_hubToolsLinkedNames(agent);
                const books = [];
                for (const n of names) {
                    try {
                        const entries = await EL_hubToolsLoadBook(ctx, n);
                        books.push({ name: n, entries: Object.keys(entries).length });
                    } catch (e) {
                        books.push({ name: n, entries: null, error: e?.message || String(e) });
                    }
                }
                return JSON.stringify({ ok: true, books });
            },
        },
        {
            name: 'LorebookSearch',
            displayName: 'Search lorebook entries',
            description: 'Keyword search across one linked lorebook (or all linked books when lorebookName is omitted). Returns matching UID, keys, comment, order, and truncated content.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Keyword or phrase to search for in keys and content.' },
                    lorebookName: { type: 'string', description: 'Single linked book to search. Omit to search all linked books.' },
                    limit: { type: 'number', description: 'Max matches to return (default 20, max 50).' },
                },
                required: ['query'],
                additionalProperties: false,
            },
            action: async (args) => {
                const ctx = EL_hubToolsResolveSt(st);
                if (!ctx) return JSON.stringify({ ok: false, error: 'SillyTavern context unavailable' });
                const q = String(args?.query || '').trim().toLowerCase();
                if (!q) return JSON.stringify({ ok: false, error: 'query is empty' });
                const limit = Math.max(1, Math.min(50, Number(args?.limit) || 20));
                const names = args?.lorebookName ? [String(args.lorebookName)] : EL_hubToolsLinkedNames(agent);
                const matches = [];
                for (const n of names) {
                    try { gate(n); } catch (e) { continue; }
                    let entries;
                    try { entries = await EL_hubToolsLoadBook(ctx, n); } catch { continue; }
                    for (const [uid, e] of Object.entries(entries)) {
                        if (matches.length >= limit) break;
                        const keys = Array.isArray(e?.key) ? e.key : [];
                        const hay = (keys.join(' ') + ' ' + EL_hubToolsStripHtml(e?.content) + ' ' + (e?.comment || '')).toLowerCase();
                        if (!hay.includes(q)) continue;
                        matches.push({
                            book: n, uid: Number(uid),
                            keys, comment: e?.comment || '', order: e?.order ?? 100,
                            content: cut(e?.content || ''),
                        });
                    }
                    if (matches.length >= limit) break;
                }
                return JSON.stringify({ ok: true, matches });
            },
        },
        {
            name: 'LorebookGet',
            displayName: 'Get full lorebook entry',
            description: 'Fetch the FULL content and metadata of one entry by UID from a linked lorebook. Use before proposing an edit or delete.',
            parameters: {
                type: 'object',
                properties: {
                    lorebookName: { type: 'string', description: 'Linked lorebook name.' },
                    uid: { type: 'number', description: 'Entry UID.' },
                },
                required: ['lorebookName', 'uid'],
                additionalProperties: false,
            },
            action: async (args) => {
                const ctx = EL_hubToolsResolveSt(st);
                if (!ctx) return JSON.stringify({ ok: false, error: 'SillyTavern context unavailable' });
                const name = String(args?.lorebookName || '');
                const uid = Number(args?.uid);
                try { gate(name); } catch (e) { return JSON.stringify({ ok: false, error: e?.message || String(e) }); }
                if (!Number.isInteger(uid)) return JSON.stringify({ ok: false, error: 'uid must be an integer' });
                let entries;
                try { entries = await EL_hubToolsLoadBook(ctx, name); }
                catch (e) { return JSON.stringify({ ok: false, error: e?.message || String(e) }); }
                const e = entries[String(uid)];
                if (!e) return JSON.stringify({ ok: false, error: `UID ${uid} not found in "${name}"` });
                return JSON.stringify({
                    ok: true,
                    entry: {
                        book: name, uid,
                        comment: e.comment || '', key: e.key || [], keysecondary: e.keysecondary || [],
                        content: EL_hubToolsStripHtml(e.content || ''),
                        order: e.order ?? 100, position: e.position ?? 0, depth: e.depth ?? 4,
                        probability: e.probability ?? 100, selective: !!e.selective,
                        constant: !!e.constant, disable: !!e.disable,
                    },
                });
            },
        },
    ];

    if (canCreate || canEdit || canDelete) {
        const allowed = [canCreate && 'create', canEdit && 'edit', canDelete && 'delete'].filter(Boolean).join('|');
        tools.push({
            name: 'LorebookProposeChange',
            displayName: 'Stage a lorebook change proposal',
            description: `Stage ONE proposal for human review (allowed actions here: ${allowed}). This does NOT write anything — it only validates and returns the proposal object in FINAL answer shape. Call once per change, then paste every returned "proposal" object VERBATIM into your final {"proposals":[...]} JSON answer with no retyping. Your final round must be ONLY that JSON object, no prose.`,
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: `One of: ${allowed}.` },
                    lorebookName: { type: 'string', description: 'Linked lorebook name (exact match).' },
                    uid: { type: 'number', description: 'Entry UID (required for edit/delete, omit for create). Fetch it with LorebookSearch/LorebookGet first — never guess.' },
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
                required: ['action', 'lorebookName'],
                additionalProperties: false,
            },
            action: async (args) => {
                const action = String(args?.action || '').toLowerCase().trim();
                const name = String(args?.lorebookName || '').trim();
                try { gate(name); } catch (e) { return JSON.stringify({ ok: false, error: e?.message || String(e) }); }
                if (!['create', 'edit', 'delete'].includes(action)) {
                    return JSON.stringify({ ok: false, error: `Unknown action "${action}".` });
                }
                if (action === 'create' && !canCreate) return JSON.stringify({ ok: false, error: 'This agent may not create entries.' });
                if (action === 'edit' && !canEdit) return JSON.stringify({ ok: false, error: 'This agent may not edit entries.' });
                if (action === 'delete' && !canDelete) return JSON.stringify({ ok: false, error: 'This agent may not delete entries.' });
                const uid = (args?.uid === undefined || args?.uid === null || args?.uid === '') ? null : Number(args.uid);
                if ((action === 'edit' || action === 'delete') && !Number.isInteger(uid)) {
                    return JSON.stringify({ ok: false, error: 'edit/delete require an integer uid (fetch it with LorebookSearch/LorebookGet first).' });
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
}
