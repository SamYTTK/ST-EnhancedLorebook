/**
 * context-builder.js — Unified per-agent context assembly (MemoryBooks parity).
 *
 * ONE assembler for EVERY run path (dashboard, periodic, quick-task,
 * agent-chat static sources). Replaces the three divergent builders
 * (EL_collectHistoryText, elBuildQuickHistory, elBuildQuickContextBlock).
 *
 * Block order mirrors MemoryBooks' buildPrompt():
 *   1. conversation history (message-ID selection: last-N / range / all / none
 *      + granular excludeIds)
 *   2. previous memories (count 0-7 pulled from a lorebook, DO-NOT-SUMMARIZE)
 *   3. sources: char card, author note, world info (names|full), static injected
 *
 * Token counting: ST's real tokenizer via st.getTokenCountAsync when
 * available, len/4 heuristic otherwise (MemoryBooks only ever did len/4).
 *
 * Classic script (no modules). Depends on nothing at load time; hub-client.js
 * calls EL_buildAgentContextAsync() at run time.
 */

const EL_CONTEXT_VERSION = 1;

// Built-in agent task-guidance presets. These are INSTRUCTIONS (what to do),
// not MemoryBooks summary prompts — our output contract is proposals JSON.
// context.prompt.custom non-empty always wins over the preset.
const EL_CONTEXT_PRESETS = Object.freeze([
    {
        key: 'lorekeeper',
        name: 'Lorekeeper (balanced)',
        text: 'Review the conversation against the linked lorebooks and propose needed changes. '
            + 'Create entries for new durable facts (people, places, events, relationships, rules). '
            + 'Edit entries that are outdated or incomplete. Only propose deletes for directly contradicted entries. '
            + 'Every create needs 2+ concrete keys. Calibrate confidence honestly.',
    },
    {
        key: 'minimal',
        name: 'Minimal (low token)',
        text: 'Propose ONLY the highest-value changes (at most 3). Skip anything marginal or uncertain. '
            + 'Keep reasoning to one sentence per proposal.',
    },
    {
        key: 'strict',
        name: 'Strict (explicit facts only)',
        text: 'Propose entries ONLY for facts explicitly stated in the conversation — never infer, '
            + 'never combine hints, never write flavor. When in doubt, propose nothing and explain why in the note field.',
    },
    {
        key: 'comprehensive',
        name: 'Comprehensive (full audit)',
        text: 'Audit every linked entry against the conversation: fix staleness, normalize keys and titles, '
            + 'fill gaps with new entries up to the per-run limit. Prefer edits over creates when an entry already covers the topic.',
    },
    {
        key: 'none',
        name: 'None (legacy behavior)',
        text: '',
    },
]);

function EL_getContextPreset(key) {
    const k = String(key || '').trim();
    const hit = EL_CONTEXT_PRESETS.find(p => p.key === k);
    return hit || EL_CONTEXT_PRESETS[0];
}

function EL_stripContextHtml(s) {
    return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function EL_clampCtx(n, min, max, fallback) {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/**
 * Read-only resolved context config for an agent. Never writes; missing
 * context migrates from deprecated quickDefaults (same rule as the schema).
 */
function EL_resolveAgentContext(agent) {
    try {
        const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
        if (schema && typeof schema.sanitizeContextConfig === 'function') {
            return schema.sanitizeContextConfig(agent && agent.context, agent && agent.quickDefaults);
        }
    } catch {}
    const d = (typeof window !== 'undefined' && window.ELAgentConfigSchema && window.ELAgentConfigSchema.DEFAULT_AGENT_CONFIG)
        ? window.ELAgentConfigSchema.DEFAULT_AGENT_CONFIG.context
        : null;
    try { return JSON.parse(JSON.stringify(d || {})); } catch { return {}; }
}

/** Deep-ish merge of a partial one-shot override onto a resolved context. */
function EL_mergeContextOverride(base, over) {
    const out = JSON.parse(JSON.stringify(base || {}));
    const o = (over && typeof over === 'object') ? over : {};
    if (o.messages && typeof o.messages === 'object') {
        out.messages = Object.assign({}, out.messages, o.messages);
    }
    if (o.previousMemories && typeof o.previousMemories === 'object') {
        out.previousMemories = Object.assign({}, out.previousMemories, o.previousMemories);
    }
    if (o.sources && typeof o.sources === 'object') {
        for (const k of ['charCard', 'authorNote', 'worldInfo', 'injected']) {
            if (o.sources[k] && typeof o.sources[k] === 'object') {
                out.sources[k] = Object.assign({}, out.sources[k], o.sources[k]);
            }
        }
    }
    if (o.prompt && typeof o.prompt === 'object') {
        out.prompt = Object.assign({}, out.prompt, o.prompt);
    }
    return out;
}

/** Prompt text for the "Agent instructions" block: custom > preset > ''. */
function EL_resolveContextPromptText(agent) {
    try {
        const ctx = EL_resolveAgentContext(agent);
        const custom = String((ctx.prompt && ctx.prompt.custom) || '').trim();
        if (custom) return custom;
        return String(EL_getContextPreset(ctx.prompt && ctx.prompt.preset).text || '');
    } catch { return ''; }
}

function EL_linkedContextNames(agent) {
    try {
        if (typeof EL_buildLinkedBooksLine === 'function') return EL_buildLinkedBooksLine(agent) || [];
    } catch {}
    try {
        const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
        if (schema) return schema.getLinkedLorebookNames(agent) || [];
    } catch {}
    return [];
}

// ── Message selection (message IDs = 0-based chat indexes, MemoryBooks-style) ──

function EL_collectContextMessages(st, msgCfg) {
    const cfg = msgCfg || {};
    const mode = ['none', 'all', 'last', 'range'].includes(cfg.mode) ? cfg.mode : 'last';
    const out = { items: [], totalRp: 0, skippedSystem: 0, skippedEmpty: 0, excluded: 0, mode };
    try {
        const chat = Array.isArray(st && st.chat) ? st.chat : [];
        const rp = [];
        chat.forEach((m, i) => {
            if (!m) return;
            if (m.is_system) { out.skippedSystem++; return; }
            out.totalRp++;
            rp.push({ idx: i, m });
        });
        let picked = [];
        if (mode === 'none') picked = [];
        else if (mode === 'all') picked = rp.slice(-500);
        else if (mode === 'range') {
            const start = EL_clampCtx(cfg.start, 0, 100000, 0);
            let end = EL_clampCtx(cfg.end, 0, 100000, 10);
            if (end < start) end = start;
            picked = rp.filter(e => e.idx >= start && e.idx < end);
        } else {
            picked = rp.slice(-EL_clampCtx(cfg.last, 1, 1000, 10));
        }
        const excluded = new Set(Array.isArray(cfg.excludeIds) ? cfg.excludeIds.map(Number).filter(n => Number.isInteger(n)) : []);
        for (const e of picked) {
            if (excluded.has(e.idx)) { out.excluded++; continue; }
            const name = String(e.m.name || '').trim() || (e.m.is_user ? 'User' : 'Assistant');
            const text = EL_stripContextHtml(e.m.mes).slice(0, 4000);
            if (!text) { out.skippedEmpty++; continue; }
            out.items.push({ id: e.idx, name, role: e.m.is_user ? 'user' : 'assistant', content: (name ? name + ': ' : '') + text });
        }
    } catch {}
    return out;
}

function EL_formatContextHistory(items) {
    return (items || []).map(it => it.content).join('\n');
}

// ── Previous memories (MemoryBooks parity: prior summaries as context-only) ──

async function EL_fetchPreviousMemories(st, agent, cfg) {
    const out = { lorebookName: '', entries: [], warning: '' };
    try {
        const c = cfg || {};
        if (!c.enabled || EL_clampCtx(c.count, 0, 7, 0) <= 0) return out;
        let book = String(c.lorebookName || '').trim();
        if (!book) {
            const linked = EL_linkedContextNames(agent);
            book = linked[0] || '';
        }
        if (!book) { out.warning = 'Previous memories skipped: no lorebook selected and none linked.'; return out; }
        out.lorebookName = book;
        let data = null;
        try { data = await st.loadWorldInfo(book); } catch (e) { out.warning = `Previous memories skipped: could not load "${book}".`; return out; }
        const all = data && data.entries ? data.entries : {};
        // MemoryBooks-flagged summaries (ours or theirs) — never arbitrary entries.
        const flagged = Object.entries(all)
            .filter(([, e]) => e && (e.stmemorybooks === true || e.enhancedLorebookMemory === true))
            .map(([uid, e]) => ({ uid: Number(uid), title: String(e.comment || `Memory ${uid}`), content: EL_stripContextHtml(e.content).slice(0, 3000), keywords: Array.isArray(e.key) ? e.key : [] }));
        if (!flagged.length) { out.warning = `Previous memories skipped: "${book}" has no flagged memory entries.`; return out; }
        flagged.sort((a, b) => a.uid - b.uid);
        out.entries = flagged.slice(-EL_clampCtx(c.count, 0, 7, 3));
    } catch (e) { out.warning = 'Previous memories skipped: ' + (e && e.message ? e.message : e); }
    return out;
}

function EL_formatPreviousMemories(prev) {
    if (!prev.entries.length) return '';
    const lines = [
        '=== PREVIOUS SCENE CONTEXT (DO NOT SUMMARIZE) ===',
        'These are previous memories for context only. Do NOT include them in your new proposals:',
        '',
    ];
    prev.entries.forEach((m, i) => {
        lines.push(`Context ${i + 1} - ${m.title}:`);
        lines.push(m.content);
        if (m.keywords.length) lines.push(`Keywords: ${m.keywords.join(', ')}`);
        lines.push('');
    });
    lines.push('=== END PREVIOUS SCENE CONTEXT - BASE NEW PROPOSALS ON THE CONVERSATION BELOW ===');
    return lines.join('\n');
}

// ── Source blocks ──

function EL_buildCharCardBlock(st, cfg) {
    try {
        if (!cfg.enabled) return '';
        const idx = (st && st.characterId !== undefined && st.characterId !== null) ? Number(st.characterId) : NaN;
        const ch = (Number.isInteger(idx) && idx >= 0 && Array.isArray(st.characters)) ? st.characters[idx] : null;
        if (!ch) return '';
        const desc = EL_stripContextHtml(ch.description ?? ch?.data?.description ?? '').slice(0, EL_clampCtx(cfg.maxChars, 100, 20000, 2000));
        if (!desc) return '';
        return `Active character: ${String(ch.name || '')}\n${desc}`;
    } catch { return ''; }
}

function EL_buildAuthorNoteBlock(st, cfg) {
    try {
        if (!cfg.enabled) return '';
        const note = EL_stripContextHtml(st?.chatMetadata?.author_note ?? st?.chat_metadata?.author_note ?? '').slice(0, EL_clampCtx(cfg.maxChars, 100, 10000, 1500));
        if (!note) return '';
        return `Author note:\n${note}`;
    } catch { return ''; }
}

async function EL_buildWorldInfoBlock(st, agent, cfg) {
    try {
        if (!cfg.enabled) return '';
        const names = [];
        const push = (n) => { if (typeof n === 'string' && n.trim() && !names.includes(n.trim())) names.push(n.trim()); };
        try {
            const meta = st?.chatMetadata || st?.chat_metadata || {};
            push(meta?.world_info);
            const info = (typeof getActiveCharacterLorebooks === 'function') ? await getActiveCharacterLorebooks() : null;
            push(info?.chatLorebook);
            for (const n of (info?.characterLorebooks || [])) push(n);
        } catch {}
        try { for (const l of (agent?.dynamicLinks || [])) push(l?.name); } catch {}
        for (const n of EL_linkedContextNames(agent)) push(n);
        if (!names.length) return '';
        if (cfg.mode === 'pins') {
            const perEntry = EL_clampCtx(cfg.maxCharsPerEntry, 100, 20000, 2000);
            const pinMap = new Map();
            try {
                for (const l of (agent?.dynamicLinks || [])) {
                    if (!l || typeof l.name !== 'string' || !l.name.trim()) continue;
                    if (Array.isArray(l.pinUids) && l.pinUids.length) pinMap.set(l.name.trim(), [...new Set(l.pinUids.map(Number).filter(n => Number.isInteger(n)))]);
                }
            } catch {}
            const parts = ['Pinned lorebook entries (single-mode one-shot injection — these are the ONLY full entries in this prompt):'];
            for (const n of names.slice(0, 10)) {
                const pins = pinMap.get(n);
                if (!pins || !pins.length) continue;
                let data = null;
                try { data = await st.loadWorldInfo(n); } catch { continue; }
                const all = data && data.entries ? data.entries : {};
                parts.push(`--- Book "${n}" (lorebook://${n}) ---`);
                for (const uid of pins.slice(0, 30)) {
                    const e = all[String(uid)];
                    if (!e) continue;
                    const keys = Array.isArray(e?.key) ? e.key.join(', ') : '';
                    const content = EL_stripContextHtml(e?.content || '').slice(0, perEntry);
                    parts.push(`[lorebook://${n}/${uid}] keys=[${keys}] comment="${String(e?.comment || '').slice(0, 200)}"\n${content}`);
                }
            }
            const lines = [];
            for (const n of names.slice(0, 20)) {
                let count = null;
                try {
                    const data = await st.loadWorldInfo(n);
                    if (data && data.entries) count = Object.keys(data.entries).length;
                } catch {}
                lines.push('- lorebook://' + n + (count === null ? '' : ' (' + count + ' entries)'));
            }
            parts.push('Other linked books (names only — not injected in single mode):\n' + lines.join('\n'));
            return parts.join('\n');
        }
        if (cfg.mode === 'full') {
            const perEntry = EL_clampCtx(cfg.maxCharsPerEntry, 100, 20000, 2000);
            const parts = ['Lorebook entries in scope:'];
            for (const n of names.slice(0, 10)) {
                let data = null;
                try { data = await st.loadWorldInfo(n); } catch { continue; }
                const entries = data && data.entries ? Object.entries(data.entries) : [];
                if (!entries.length) continue;
                parts.push(`--- Book "${n}" ---`);
                for (const [uid, e] of entries.slice(0, 30)) {
                    const keys = Array.isArray(e?.key) ? e.key.join(', ') : '';
                    const content = EL_stripContextHtml(e?.content || '').slice(0, perEntry);
                    parts.push(`[UID ${uid}] keys=[${keys}] comment="${String(e?.comment || '').slice(0, 200)}"\n${content}`);
                }
                if (entries.length > 30) parts.push(`... and ${entries.length - 30} more entries (use ls / grep / read tools).`);
            }
            return parts.join('\n');
        }
        const lines = [];
        for (const n of names.slice(0, 20)) {
            let count = null;
            try {
                const data = await st.loadWorldInfo(n);
                if (data && data.entries) count = Object.keys(data.entries).length;
            } catch {}
            lines.push('- lorebook://' + n + (count === null ? '' : ' (' + count + ' entries)'));
        }
        return 'Lorebooks in scope (browse like folders — ls lorebook:// then read lorebook://<Book>/<uid>; charcard://<name> and author-note:// are also readable):\n' + lines.join('\n');
    } catch { return ''; }
}

async function EL_buildInjectedBlock(st, agent, cfg) {
    try {
        if (!cfg.enabled) return '';
        if (typeof EL_buildStaticContextBlock !== 'function') return '';
        return await EL_buildStaticContextBlock(st, agent, { maxCharsPerBook: EL_clampCtx(agent?.maxCharsPerEntry, 500, 12000, 4000) });
    } catch (e) { return `(Static injected context failed: ${e?.message || e})`; }
}

// ── Regex (stored option; applied only when an engine bridge is present) ──

function EL_applyContextRegex(st, text, ctx) {
    try {
        if (!ctx || !ctx.prompt || ctx.prompt.useRegex !== true) return { text, applied: false };
        const runner = (st && typeof st.runRegexScript === 'function') ? st.runRegexScript
            : (typeof window !== 'undefined' && typeof window.runRegexScript === 'function') ? window.runRegexScript : null;
        if (!runner) return { text, applied: false, warning: 'Regex enabled but no regex engine bridge is exposed — prompt sent unmodified.' };
        // Minimal outgoing pass over enabled scripts when the bridge exists.
        return { text: runner(text, { placement: 'outgoing' }), applied: true };
    } catch (e) { return { text, applied: false, warning: 'Regex pass failed, prompt sent unmodified.' }; }
}

// ── Token counting: real ST tokenizer first, len/4 heuristic fallback ──

function EL_heuristicTokens(text) {
    return Math.ceil(String(text ?? '').length / 4);
}

async function EL_countTokensAsync(st, text) {
    const s = String(text ?? '');
    if (!s) return { tokens: 0, method: 'none' };
    try {
        if (st && typeof st.getTokenCountAsync === 'function') {
            const n = await st.getTokenCountAsync(s);
            if (Number.isFinite(Number(n))) return { tokens: Number(n), method: 'real' };
        }
    } catch {}
    return { tokens: EL_heuristicTokens(s), method: 'heuristic' };
}

/**
 * Build the full unified context for an agent run.
 * Returns { history, blocks, historyText, contextBlock, promptText,
 *   tokens: { perBlock, total, method }, warnings[] }.
 * blocks[] order: previousMemories, charCard, authorNote, worldInfo, injected.
 */
async function EL_buildAgentContextAsync(st, agent, opts) {
    opts = opts || {};
    let ctx = EL_resolveAgentContext(agent);
    if (opts.contextOverride) ctx = EL_mergeContextOverride(ctx, opts.contextOverride);
    const out = {
        history: { items: [], totalRp: 0, mode: 'last' },
        blocks: [],
        historyText: '',
        contextBlock: '',
        promptText: '',
        tokens: { perBlock: {}, total: 0, method: 'heuristic' },
        warnings: [],
    };
    // 1. History (message-ID selection). Skipped for thread-based callers
    // (agent-chat) that supply their own history — they use blocks only.
    if (opts.includeHistory !== false) {
        const hist = EL_collectContextMessages(st, ctx.messages);
        out.history = { items: hist.items, totalRp: hist.totalRp, mode: hist.mode };
        out.historyText = EL_formatContextHistory(hist.items);
        if (hist.mode === 'range') {
            out.warnings.push(`History: range ${ctx.messages.start}–${ctx.messages.end} of ${hist.totalRp} RP messages (${hist.items.length} selected${hist.excluded ? `, ${hist.excluded} excluded` : ''}).`);
        } else if (hist.excluded) {
            out.warnings.push(`History: ${hist.excluded} message(s) excluded by ID.`);
        }
    }
    // 2. Previous memories.
    try {
        const prev = await EL_fetchPreviousMemories(st, agent, ctx.previousMemories);
        if (prev.warning) out.warnings.push(prev.warning);
        const t = EL_formatPreviousMemories(prev);
        if (t) out.blocks.push({ key: 'previousMemories', label: `Previous memories (${prev.entries.length} from "${prev.lorebookName}")`, text: t });
    } catch {}
    // 3. Sources.
    const cc = EL_buildCharCardBlock(st, ctx.sources.charCard || {});
    if (cc) out.blocks.push({ key: 'charCard', label: 'Character card', text: cc });
    const an = EL_buildAuthorNoteBlock(st, ctx.sources.authorNote || {});
    if (an) out.blocks.push({ key: 'authorNote', label: 'Author note', text: an });
    try {
        const wi = await EL_buildWorldInfoBlock(st, agent, ctx.sources.worldInfo || {});
        if (wi) out.blocks.push({ key: 'worldInfo', label: `Lorebook snapshot (${(ctx.sources.worldInfo || {}).mode === 'full' ? 'full' : 'names'})`, text: wi });
    } catch {}
    try {
        const inj = await EL_buildInjectedBlock(st, agent, ctx.sources.injected || {});
        if (inj) out.blocks.push({ key: 'injected', label: 'Static injected context', text: inj });
    } catch {}
    out.contextBlock = out.blocks.map(b => b.text).join('\n\n');
    // 4. Prompt text (custom > preset), with optional regex pass.
    let promptText = EL_resolveContextPromptText(agent);
    try {
        const rx = EL_applyContextRegex(st, promptText, ctx);
        promptText = rx.text;
        if (rx.warning) out.warnings.push(rx.warning);
    } catch {}
    out.promptText = promptText;
    // 5. Token count over the EXACT first-request payload pieces.
    try {
        const pieces = [{ key: 'history', label: 'History', text: out.historyText }];
        for (const b of out.blocks) pieces.push(b);
        if (promptText) pieces.push({ key: 'promptText', label: 'Agent instructions', text: promptText });
        let total = 0, seenReal = false, seenHeur = false;
        for (const p of pieces) {
            if (!p.text) { out.tokens.perBlock[p.key] = 0; continue; }
            const r = opts.countTokens === false ? { tokens: EL_heuristicTokens(p.text), method: 'heuristic' } : await EL_countTokensAsync(st, p.text);
            out.tokens.perBlock[p.key] = r.tokens;
            total += r.tokens;
            if (r.method === 'real') seenReal = true;
            else if (r.method === 'heuristic') seenHeur = true;
        }
        out.tokens.total = total;
        out.tokens.method = !total ? 'none' : (seenReal && seenHeur ? 'mixed' : (seenReal ? 'real' : 'heuristic'));
    } catch {}
    return out;
}

/** Pre-run budget gate: { over, total, threshold }. */
function EL_checkContextTokenWarning(built, agent) {
    const ctx = EL_resolveAgentContext(agent);
    const threshold = EL_clampCtx(ctx.tokenWarningThreshold, 0, 1000000, 0);
    const total = Number(built && built.tokens && built.tokens.total) || 0;
    if (!threshold || total <= threshold) return { over: false, total, threshold };
    return { over: true, total, threshold };
}

if (typeof window !== 'undefined') {
    window.EL_CONTEXT_VERSION = EL_CONTEXT_VERSION;
    window.EL_CONTEXT_PRESETS = EL_CONTEXT_PRESETS;
    window.EL_getContextPreset = EL_getContextPreset;
    window.EL_resolveAgentContext = EL_resolveAgentContext;
    window.EL_mergeContextOverride = EL_mergeContextOverride;
    window.EL_resolveContextPromptText = EL_resolveContextPromptText;
    window.EL_collectContextMessages = EL_collectContextMessages;
    window.EL_formatContextHistory = EL_formatContextHistory;
    window.EL_fetchPreviousMemories = EL_fetchPreviousMemories;
    window.EL_buildAgentContextAsync = EL_buildAgentContextAsync;
    window.EL_countTokensAsync = EL_countTokensAsync;
    window.EL_heuristicTokens = EL_heuristicTokens;
    window.EL_checkContextTokenWarning = EL_checkContextTokenWarning;
    window.EL_sanitizeCtxExcludeIds = function (v) {
        try {
            const schema = window.ELAgentConfigSchema;
            if (schema && typeof schema.sanitizeExcludeIds === 'function') return schema.sanitizeExcludeIds(v);
        } catch {}
        return [];
    };
}
