const EL_API_BASE = '/api/plugins/enhanced-lorebook-agent';

async function EL_apiFetch(method, path, body) {
    const url = `${EL_API_BASE}${path}`;
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
        opts.body = JSON.stringify(body);
    }
    const resp = await fetch(url, opts);
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`API ${method} ${path}: ${resp.status}${text ? ' - ' + text.slice(0, 200) : ''}`);
    }
    return resp.json().catch(() => null);
}

function EL_proposalId() {
    return 'prop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function EL_resolveSt(ctx) {
    return ctx?.stContext || (typeof stContext !== 'undefined' ? stContext : null);
}

function EL_resolveSettings(ctx) {
    return ctx?.settings || {};
}

function EL_resolvePermissions(ctx) {
    return ctx?.permissions || {};
}

async function view_active_lorebooks(args, context) {
    try {
        const st = EL_resolveSt(context);
        if (!st) return { success: false, error: 'No SillyTavern context available' };
        const stSelect = (ST_Window || window.opener || window.parent).document.getElementById('world_info');
        const activeNames = stSelect
            ? Array.from(stSelect.selectedOptions).map(opt => opt.text).filter(v => v)
            : [];
        const allNames = st.getWorldInfoNames ? st.getWorldInfoNames() : [];
        const result = allNames.map(name => ({
            name,
            entryCount: 0,
            globalActive: activeNames.includes(name),
        }));
        for (const item of result) {
            const data = await st.loadWorldInfo(item.name);
            if (data && data.entries) {
                item.entryCount = Object.keys(data.entries).length;
            }
        }
        return { success: true, data: result };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function EL_resolveInjectedContext(selections, context) {
    if (!Array.isArray(selections) || selections.length === 0) {
        return { block: '', warnings: [] };
    }
    const st = EL_resolveSt(context);
    if (!st) return { block: '', warnings: ['Injected context unavailable: no SillyTavern context'] };
    const warnings = [];
    const sections = [];
    for (const sel of selections) {
        if (!sel || !sel.lorebook) continue;
        let data = null;
        try { data = await st.loadWorldInfo(sel.lorebook); } catch (_) { data = null; }
        if (!data || !data.entries) {
            warnings.push(`Injected context: lorebook "${sel.lorebook}" not found (skipped)`);
            continue;
        }
        const allEntries = Object.entries(data.entries).map(([uid, e]) => ({ uid: parseInt(uid), entry: e }));
        const picked = sel.all === true
            ? allEntries
            : allEntries.filter(({ uid }) => Array.isArray(sel.uids) && sel.uids.map(String).includes(String(uid)));
        if (picked.length === 0) {
            warnings.push(`Injected context: no selected entries found in "${sel.lorebook}" (skipped)`);
            continue;
        }
        const lines = picked.map(({ uid, entry }) => {
            const content = String(entry.content || '');
            const shown = content.length > 8000 ? content.slice(0, 8000) + ' ...[truncated]' : content;
            return `UID ${uid}:\n  keys=[${(entry.key || []).join(', ')}]\n  comment="${entry.comment || ''}"\n  order=${entry.order ?? 100} depth=${entry.depth ?? 4} prob=${entry.probability ?? 100}\n  content="${shown}"`;
        });
        sections.push(`Lorebook: "${sel.lorebook}" (${picked.length} of ${allEntries.length} entries injected)\n${lines.join('\n\n')}`);
    }
    return { block: sections.join('\n\n'), warnings };
}

async function view_lorebook_detail(args, context) {
    try {
        const st = EL_resolveSt(context);
        if (!st) return { success: false, error: 'No SillyTavern context available' };
        const lorebookName = args?.lorebookName;
        if (!lorebookName) return { success: false, error: 'lorebookName is required' };

        let data;
        const currName = context?.currentLorebookName || (typeof currentLorebookName !== 'undefined' ? currentLorebookName : null);
        const currData = context?.currentLorebookData || (typeof currentLorebookData !== 'undefined' ? currentLorebookData : null);
        if (currName === lorebookName && currData) {
            data = currData;
        } else {
            data = await st.loadWorldInfo(lorebookName);
        }

        if (!data || !data.entries) {
            return { success: true, data: { name: lorebookName, entries: [] } };
        }

        const entries = Object.entries(data.entries).map(([uid, entry]) => ({
            uid: parseInt(uid),
            keys: entry.key || [],
            comment: entry.comment || '',
            contentPreview: (entry.content || '').slice(0, 200),
            order: entry.order ?? 100,
            position: entry.position ?? 0,
            depth: entry.depth ?? 4,
            probability: entry.probability ?? 100,
        }));
        entries.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
        return { success: true, data: { name: lorebookName, entries } };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function view_chat_history(args, context) {
    try {
        const st = EL_resolveSt(context);
        if (!st) return { success: false, error: 'No SillyTavern context available' };
        const chat = st.chat || [];
        const count = (args?.count && args.count > 0) ? args.count : 20;
        const offset = (args?.offset && args.offset >= 0) ? args.offset : 0;
        const start = Math.max(0, chat.length - count - offset);
        const end = Math.max(0, chat.length - offset);
        const slice = chat.slice(start, end);
        const data = slice.map(m => ({
            role: m.is_system ? 'system' : (m.is_user ? 'user' : 'character'),
            name: m.name || '',
            content: (m.mes || '').slice(0, 1000),
        }));
        return { success: true, data };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function view_entry(args, context) {
    try {
        const st = EL_resolveSt(context);
        if (!st) return { success: false, error: 'No SillyTavern context available' };
        const lorebookName = args?.lorebookName;
        const uid = args?.uid;
        if (!lorebookName) return { success: false, error: 'lorebookName is required' };
        if (uid === undefined || uid === null) return { success: false, error: 'uid is required' };

        const data = await st.loadWorldInfo(lorebookName);
        if (!data || !data.entries) {
            return { success: false, error: 'Lorebook "' + lorebookName + '" not found' };
        }
        const entry = data.entries[uid];
        if (!entry) {
            return { success: false, error: 'Entry UID ' + uid + ' not found in "' + lorebookName + '"' };
        }
        return {
            success: true,
            data: {
                uid: parseInt(uid),
                keys: entry.key || [],
                keysecondary: entry.keysecondary || [],
                comment: entry.comment || '',
                content: entry.content || '',
                order: entry.order ?? 100,
                depth: entry.depth ?? 4,
                probability: entry.probability ?? 100,
                position: entry.position ?? 0,
                role: entry.role ?? null,
                constant: !!entry.constant,
                vectorized: !!entry.vectorized || !!entry.is_vector,
                selective: !!entry.selective,
                disable: !!entry.disable,
                selectiveLogic: entry.selectiveLogic ?? 0,
                excludeRecursion: !!entry.excludeRecursion,
                preventRecursion: !!entry.preventRecursion,
                group: entry.group || '',
                groupWeight: entry.groupWeight ?? 100,
                groupOverride: !!entry.groupOverride,
                sticky: entry.sticky ?? 0,
                cooldown: entry.cooldown ?? 0,
                delay: entry.delay ?? 0,
                triggers: entry.triggers || [],
                characterFilter: entry.characterFilter || [],
                characterFilterExclude: !!entry.characterFilterExclude,
                outletName: entry.outletName || '',
                caseSensitive: entry.caseSensitive,
                wholeWords: entry.wholeWords,
                scanDepth: entry.scanDepth ?? 1000,
                recursionLevel: entry.recursionLevel ?? 1,
                useGroupScoring: entry.useGroupScoring,
                automationId: entry.automationId || '',
                delayUntilRecursion: !!entry.delayUntilRecursion,
                ignoreBudget: !!entry.ignoreBudget,
                matchCharDescription: !!entry.matchCharDescription,
                matchCharPersonality: !!entry.matchCharPersonality,
                matchScenario: !!entry.matchScenario,
                matchPersona: !!entry.matchPersona,
                matchCharDepth: !!entry.matchCharDepth,
                matchCreatorNotes: !!entry.matchCreatorNotes,
            },
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function propose_create_entry(args, context) {
    try {
        const st = EL_resolveSt(context);
        if (!st) return { success: false, error: 'No SillyTavern context available' };
        const lorebookName = args?.lorebookName;
        const entryData = args?.entryData;
        const reasoning = args?.explanation || args?.reasoning || '';
        if (!lorebookName) return { success: false, error: 'lorebookName is required' };
        if (!entryData) return { success: false, error: 'entryData is required' };

        const permissions = EL_resolvePermissions(context);
        const guardrail = EL_createGuardrailValidator(permissions);
        const validation = guardrail.validateProposal('create', entryData);
        if (!validation.allowed) {
            return { success: false, error: validation.reason };
        }

        const proposalId = EL_proposalId();
        const entrySnapshot = {
            key: entryData.key || [],
            keysecondary: entryData.keysecondary || [],
            comment: entryData.comment || '',
            content: entryData.content || '',
            order: entryData.order ?? 100,
            position: entryData.position ?? 0,
            depth: entryData.depth ?? 4,
            probability: entryData.probability ?? 100,
            constant: !!entryData.constant,
            vectorized: !!entryData.vectorized,
            selective: !!entryData.selective,
            disable: !!entryData.disable,
            excludeRecursion: !!entryData.excludeRecursion,
            preventRecursion: !!entryData.preventRecursion,
            group: entryData.group || '',
            groupWeight: entryData.groupWeight ?? 100,
            groupOverride: !!entryData.groupOverride,
            sticky: entryData.sticky ?? 0,
            cooldown: entryData.cooldown ?? 0,
            delay: entryData.delay ?? 0,
            triggers: entryData.triggers || [],
            characterFilter: entryData.characterFilter || [],
            characterFilterExclude: !!entryData.characterFilterExclude,
            selectiveLogic: entryData.selectiveLogic ?? 0,
            role: entryData.role ?? null,
            outletName: entryData.outletName || '',
        };

        const proposal = {
            id: proposalId,
            timestamp: new Date().toISOString(),
            action: 'create',
            lorebookName,
            status: 'pending',
            entrySnapshot,
            originalSnapshot: null,
            reasoning,
        };

        return { success: true, data: { proposalId, proposal } };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function propose_edit_entry(args, context) {
    try {
        const st = EL_resolveSt(context);
        if (!st) return { success: false, error: 'No SillyTavern context available' };
        const lorebookName = args?.lorebookName;
        const uid = args?.uid;
        const changes = args?.changes;
        const reasoning = args?.explanation || args?.reasoning || '';
        if (!lorebookName) return { success: false, error: 'lorebookName is required' };
        if (uid === undefined || uid === null) return { success: false, error: 'uid is required' };
        if (!changes) return { success: false, error: 'changes are required' };

        const data = await st.loadWorldInfo(lorebookName);
        if (!data || !data.entries || !data.entries[uid]) {
            return { success: false, error: 'Entry UID ' + uid + ' not found in "' + lorebookName + '"' };
        }

        const original = data.entries[uid];
        const originalSnapshot = {
            key: original.key || [],
            keysecondary: original.keysecondary || [],
            comment: original.comment || '',
            content: original.content || '',
            order: original.order ?? 100,
            position: original.position ?? 0,
            depth: original.depth ?? 4,
            probability: original.probability ?? 100,
            constant: !!original.constant,
            vectorized: !!original.vectorized || !!original.is_vector,
            selective: !!original.selective,
            disable: !!original.disable,
            excludeRecursion: !!original.excludeRecursion,
            preventRecursion: !!original.preventRecursion,
            group: original.group || '',
            groupWeight: original.groupWeight ?? 100,
            groupOverride: !!original.groupOverride,
            sticky: original.sticky ?? 0,
            cooldown: original.cooldown ?? 0,
            delay: original.delay ?? 0,
            triggers: original.triggers || [],
            characterFilter: original.characterFilter || [],
            characterFilterExclude: !!original.characterFilterExclude,
            selectiveLogic: original.selectiveLogic ?? 0,
            role: original.role ?? null,
            outletName: original.outletName || '',
            caseSensitive: original.caseSensitive,
            wholeWords: original.wholeWords,
            scanDepth: original.scanDepth ?? 1000,
            recursionLevel: original.recursionLevel ?? 1,
            useGroupScoring: original.useGroupScoring,
            automationId: original.automationId || '',
            delayUntilRecursion: !!original.delayUntilRecursion,
            ignoreBudget: !!original.ignoreBudget,
            matchCharDescription: !!original.matchCharDescription,
            matchCharPersonality: !!original.matchCharPersonality,
            matchScenario: !!original.matchScenario,
            matchPersona: !!original.matchPersona,
            matchCharDepth: !!original.matchCharDepth,
            matchCreatorNotes: !!original.matchCreatorNotes,
        };

        const merged = { ...originalSnapshot };
        for (const key of Object.keys(changes)) {
            if (key in merged) {
                merged[key] = changes[key];
            }
        }

        const permissions = EL_resolvePermissions(context);
        const guardrail = EL_createGuardrailValidator(permissions);
        const validation = guardrail.validateProposal('edit', changes);
        if (!validation.allowed) {
            return { success: false, error: validation.reason };
        }

        const proposalId = EL_proposalId();
        const proposal = {
            id: proposalId,
            timestamp: new Date().toISOString(),
            action: 'edit',
            lorebookName,
            uid: parseInt(uid),
            status: 'pending',
            entrySnapshot: merged,
            originalSnapshot,
            reasoning,
        };

        return { success: true, data: { proposalId, proposal } };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function propose_delete_entry(args, context) {
    try {
        const st = EL_resolveSt(context);
        if (!st) return { success: false, error: 'No SillyTavern context available' };
        const lorebookName = args?.lorebookName;
        const uid = args?.uid;
        const reasoning = args?.explanation || args?.reasoning || '';
        if (!lorebookName) return { success: false, error: 'lorebookName is required' };
        if (uid === undefined || uid === null) return { success: false, error: 'uid is required' };

        const permissions = EL_resolvePermissions(context);
        const guardrail = EL_createGuardrailValidator(permissions);
        const validation = guardrail.validateProposal('delete', { uid });
        if (!validation.allowed) {
            return { success: false, error: validation.reason };
        }

        const data = await st.loadWorldInfo(lorebookName);
        if (!data || !data.entries || !data.entries[uid]) {
            return { success: false, error: 'Entry UID ' + uid + ' not found in "' + lorebookName + '"' };
        }

        const original = data.entries[uid];
        const originalSnapshot = {
            key: original.key || [],
            keysecondary: original.keysecondary || [],
            comment: original.comment || '',
            content: original.content || '',
            order: original.order ?? 100,
            position: original.position ?? 0,
            depth: original.depth ?? 4,
            probability: original.probability ?? 100,
            constant: !!original.constant,
            vectorized: !!original.vectorized || !!original.is_vector,
            selective: !!original.selective,
            disable: !!original.disable,
        };

        const proposalId = EL_proposalId();
        const proposal = {
            id: proposalId,
            timestamp: new Date().toISOString(),
            action: 'delete',
            lorebookName,
            uid: parseInt(uid),
            status: 'pending',
            entrySnapshot: null,
            originalSnapshot,
            reasoning,
        };

        return { success: true, data: { proposalId, proposal } };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function research(args, context) {
    try {
        const query = args?.query;
        if (!query) return { success: false, error: 'query is required' };

        const settings = EL_resolveSettings(context);
        const source = settings?.research?.source || 'disabled';

        if (source === 'disabled') {
            return { success: true, data: { results: [], note: 'Research is disabled. Enable SearXNG in agent settings.' } };
        }

        if (source === 'st_websearch') {
            return { success: true, data: { results: [], note: 'Web search is handled at the LLM level via SillyTavern.' } };
        }

        if (source === 'searxng') {
            const result = await EL_apiFetch('POST', '/agent/research', { query, source: 'searxng' });
            const results = (result?.results || []).map(r => ({
                title: r.title || '',
                snippet: r.snippet || r.content || '',
                url: r.url || '',
            }));
            return { success: true, data: { results, note: '' } };
        }

        return { success: true, data: { results: [], note: 'Unknown research source: ' + source } };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function get_feasibility_report(args, context) {
    try {
        const st = EL_resolveSt(context);
        if (!st) return { success: false, error: 'No SillyTavern context available' };
        const lorebookName = args?.lorebookName;
        if (!lorebookName) return { success: false, error: 'lorebookName is required' };

        const data = await st.loadWorldInfo(lorebookName);
        if (!data || !data.entries) {
            return { success: true, data: { totalEntries: 0, keysList: [], topics: {} } };
        }

        const keysList = [];
        const topics = {};
        const entries = Object.entries(data.entries);

        for (const [uid, entry] of entries) {
            const keys = entry.key || [];
            const comment = (entry.comment || '').toLowerCase();
            keysList.push({ uid: parseInt(uid), keys, comment: entry.comment || '' });

            for (const key of keys) {
                const firstWord = key.toLowerCase().split(/[\s_]+/)[0];
                if (firstWord) {
                    if (!topics[firstWord]) topics[firstWord] = [];
                    if (!topics[firstWord].includes(uid)) {
                        topics[firstWord].push(uid);
                    }
                }
            }

            if (comment) {
                const words = comment.split(/[\s_]+/).filter(w => w.length > 3);
                for (const word of words.slice(0, 3)) {
                    if (!topics[word]) topics[word] = [];
                    if (!topics[word].includes(uid)) {
                        topics[word].push(uid);
                    }
                }
            }
        }

        return {
            success: true,
            data: {
                totalEntries: entries.length,
                keysList,
                topics,
            },
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}
