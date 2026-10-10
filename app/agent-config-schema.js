/**
 * agent-config-schema.js — Single source of truth for agent configuration (Hub v2).
 *
 * v2 replaces the entire legacy LLM backend (vault secrets, direct-complete
 * proxy, Connection Manager profiles, SearXNG research, multi-turn loop
 * tunables) with a plain JSON config for ST-RequestHub. The extension builds
 * the hub request (see hub-client.js), the hub executes it, and proposals
 * come back for human review in the Feed.
 *
 * Stored per agent under extensionSettings.SillyTavernEnhancedLorebook.agents.
 * Old v1 configs migrate automatically on load (see migrateAgentToHubV2).
 */

const DEFAULT_AGENT_CONFIG = Object.freeze({
    name: 'New Agent',
    enabled: true,
    // Run scheduling (owned by the extension, not the hub — the hub is stateless).
    mode: 'manual', // 'manual' | 'periodic'
    interval: 10,
    periodicInterval: 10,
    taskDescription: '',
    customInstructions: '',
    // ── Prompt delivery ──
    // role: which message role carries the identity+briefing+custom block.
    // position: 'before' = ahead of conversation history, 'after' = at depth 0
    // (immediately before generation). custom is appended after the auto
    // environment briefing; empty custom falls back to customInstructions.
    prompt: Object.freeze({
        role: 'system', // 'system' | 'user' | 'assistant'
        position: 'before', // 'before' | 'after'
        custom: '',
    }),
    // ── Hub request ──
    hubMode: 'agent', // 'single' (one-shot, static snapshot, no tools) | 'agent' (tool loop)
    model: '', // override model; empty = hub profile / ST backend default
    apiProfile: '', // hub API profile name; empty = hub default / ST backend
    preset: '', // ST chat-completion preset name; empty = none
    useOwnConfig: false, // true = ignore preset samplers, use samplers below only
    samplers: Object.freeze({
        temperature: 0.7,
    }),
    maxTokens: 1024, // output tokens per model round
    timeoutMs: 90000, // per model round (0 = hub default/off)
    retries: 1, // network/429/5xx/timeout only
    // ── Hub agent-mode loop ──
    maxSteps: 10, // model↔tool rounds (hub clamps to its cap)
    totalTimeoutMs: 600000, // whole-run wall clock (0 = off)
    // Which inline hub tools the agent may use (drives tools.extra subset).
    toolScope: Object.freeze({
        allowCreate: true,
        allowEdit: true,
        allowDelete: false,
        allowResearch: false, // reserved: no web tool exists yet; kept for forward-compat
    }),
    // ── Policy (extension-side; the hub enforces none of this) ──
    autoAccept: false,
    autoAcceptConfidence: 0.8,
    maxEntriesPerRun: 5,
    requireKeyConfidence: 'low',
    maxPendingProposals: 20,
    requireConfirmation: true,
    // Client-side display budget for lorebook snapshots fed to the model.
    maxCharsPerEntry: 8000,
    // Linked lorebooks = static injected picks + dynamic links (+ per-character
    // rule picks). This is the agent's ENTIRE visible world: anything not
    // linked is hard-blocked (tools + proposal validation). No allowlists.
    injectedContext: [],
    // Dynamic lorebook links: whole books the agent can inspect via tools.
    // Shape: [{ name: string, pinUids: number[] }]
    dynamicLinks: [],
    scope: 'global',
    boundCharacterId: null,
    boundChatId: null,
    conditionals: [],
    defaultRule: Object.freeze({
        injectedContext: [],
        taskOverride: '',
        instructionsOverride: '',
    }),
    notifyNoMatch: false,
    // ── Unified context (drives EVERY run path: dashboard, periodic,
    // quick-task, agent-chat static sources). Replaces the quick-task-only
    // quickDefaults message/source picks — quickDefaults is kept as a
    // deprecated mirror and migrates into context on load (see below).
    context: Object.freeze({
        messages: Object.freeze({
            mode: 'last', // 'none' | 'all' | 'last' | 'range'
            last: 10, // used when mode === 'last'
            start: 0, // message-ID range start (mode === 'range', 0-based chat index)
            end: 10, // message-ID range end (exclusive)
            excludeIds: Object.freeze([]), // granular per-message exclusions (chat indexes)
        }),
        previousMemories: Object.freeze({
            enabled: true,
            count: 3, // 0-7, MemoryBooks parity
            lorebookName: '', // empty = first linked lorebook
            includePriorEntry: false,
        }),
        sources: Object.freeze({
            charCard: Object.freeze({ enabled: true, maxChars: 2000 }),
            authorNote: Object.freeze({ enabled: true, maxChars: 1500 }),
            worldInfo: Object.freeze({ enabled: true, mode: 'names', maxCharsPerEntry: 2000 }), // mode: 'names' | 'full'
            injected: Object.freeze({ enabled: true }),
        }),
        prompt: Object.freeze({
            preset: 'lorekeeper', // built-in agent task preset key (see context-builder.js)
            custom: '', // non-empty overrides the preset text (same as prompt.custom)
            useRegex: false,
        }),
        tokenWarningThreshold: 50000, // pre-run confirm above this (0 = off)
    }),
    // Deprecated mirror of context (wand popup / /el-run readers). New code
    // reads agent.context; sanitize keeps both in sync (context wins).
    // profileId is now a HUB API PROFILE NAME (v1 Connection Manager ids do
    // not carry over — migration clears it, see migrateAgentToHubV2).
    quickDefaults: Object.freeze({
        profileId: '',
        messages: Object.freeze({
            type: 'last', // 'none' | 'all' | 'first' | 'last' | 'range'
            first: 10,
            last: 10,
            range: Object.freeze({ start: 0, end: 10 }),
        }),
        includeCharCard: true,
        includeAuthorNote: true,
        includeWorldInfo: true,
        includeInjected: true,
    }),
});

const ALLOWED_FIELDS = Object.freeze([
    'name', 'enabled', 'mode', 'interval', 'periodicInterval', 'taskDescription', 'customInstructions',
    'prompt',
    'hubMode', 'model', 'apiProfile', 'preset', 'useOwnConfig', 'samplers',
    'maxTokens', 'timeoutMs', 'retries', 'maxSteps', 'totalTimeoutMs', 'toolScope',
    'autoAccept', 'autoAcceptConfidence',
    'maxEntriesPerRun', 'requireKeyConfidence', 'maxPendingProposals', 'requireConfirmation',
    'maxCharsPerEntry',
    'injectedContext', 'dynamicLinks', 'scope', 'boundCharacterId', 'boundChatId',
    'conditionals', 'defaultRule', 'notifyNoMatch', 'context', 'quickDefaults',
    'hubMigratedAt', 'hubMigrateNotes',
]);

const SAMPLER_KEYS = Object.freeze([
    'temperature', 'top_p', 'top_k', 'top_a', 'min_p',
    'frequency_penalty', 'presence_penalty', 'repetition_penalty',
    'seed', 'stop', 'response_format', 'reasoning_effort', 'max_completion_tokens',
]);

function cloneDeep(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch { return Array.isArray(obj) ? [...obj] : { ...obj }; }
}

function clamp(n, min, max, fallback) {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function sanitizeSamplers(src) {
    const out = {};
    const s = (src && typeof src === 'object') ? src : {};
    for (const k of SAMPLER_KEYS) {
        if (s[k] === undefined || s[k] === null || s[k] === '') continue;
        if (k === 'stop') {
            if (typeof s[k] === 'string' && s[k].trim()) out[k] = s[k].split('\n').map(x => x.trim()).filter(Boolean).slice(0, 10);
            else if (Array.isArray(s[k])) out[k] = s[k].map(String).slice(0, 10);
            continue;
        }
        if (k === 'seed') {
            const v = Number(s[k]);
            if (Number.isInteger(v)) out[k] = v;
            continue;
        }
        if (k === 'response_format' || k === 'reasoning_effort' || k === 'max_completion_tokens') {
            out[k] = s[k];
            continue;
        }
        const v = Number(s[k]);
        if (Number.isFinite(v)) out[k] = v;
    }
    if (out.temperature === undefined) out.temperature = 0.7;
    out.temperature = clamp(out.temperature, 0, 2, 0.7);
    return out;
}

function sanitizeExcludeIds(v) {
    const out = [];
    const push = (n) => {
        const i = Number(n);
        if (Number.isInteger(i) && i >= 0 && i <= 100000 && !out.includes(i)) out.push(i);
    };
    if (Array.isArray(v)) {
        for (const x of v) push(x);
    } else if (typeof v === 'string' && v.trim()) {
        // Accept "12, 15-18, 20" (ranges expand, capped at 200 ids).
        for (const part of v.split(',')) {
            const t = part.trim();
            if (!t) continue;
            const rm = /^(\d+)\s*-\s*(\d+)$/.exec(t);
            if (rm) {
                const a = Number(rm[1]), b = Number(rm[2]);
                const lo = Math.min(a, b), hi = Math.max(a, b);
                for (let i = lo; i <= hi && out.length < 200; i++) push(i);
            } else {
                push(t);
            }
            if (out.length >= 200) break;
        }
    }
    return out.sort((a, b) => a - b);
}

function sanitizeContextMessages(m, fallbackQm) {
    const src = (m && typeof m === 'object') ? m : null;
    const q = (fallbackQm && typeof fallbackQm === 'object') ? fallbackQm : {};
    const qr = (q.range && typeof q.range === 'object') ? q.range : {};
    // Legacy quickDefaults type 'first' maps to a head range.
    let mode = src ? src.mode : undefined;
    if (mode === undefined && q.type) mode = q.type === 'first' ? 'range' : q.type;
    if (!['none', 'all', 'last', 'range'].includes(mode)) mode = 'last';
    let start = src ? clamp(src.start, 0, 100000, 0) : clamp(qr.start, 0, 100000, 0);
    let end = src ? clamp(src.end, 0, 100000, 10) : clamp(qr.end, 0, 100000, 10);
    if (mode === 'range' && q.type === 'first' && !src) {
        start = 0;
        end = clamp(q.first, 1, 1000, 10);
    }
    if (end < start) end = start;
    return {
        mode,
        last: src ? clamp(src.last, 1, 1000, 10) : clamp(q.last, 1, 1000, 10),
        start,
        end,
        excludeIds: sanitizeExcludeIds(src ? src.excludeIds : undefined),
    };
}

/**
 * Sanitize the unified per-agent context config. When no explicit context
 * exists, migrate from deprecated quickDefaults picks (qd) so stored agents
 * behave identically under the new builder.
 */
function sanitizeContextConfig(ctx, qd) {
    const src = (ctx && typeof ctx === 'object') ? ctx : null;
    const q = (qd && typeof qd === 'object') ? qd : {};
    const s = (v, fb) => (v && typeof v === 'object') ? v : {};
    const srcSources = s(src && src.sources);
    const srcPrev = s(src && src.previousMemories);
    const srcPrompt = s(src && src.prompt);
    const srcWI = s(srcSources.worldInfo);
    const srcCC = s(srcSources.charCard);
    const srcAN = s(srcSources.authorNote);
    const srcInj = s(srcSources.injected);
    const num = (v, min, max, fb) => clamp(v, min, max, fb);
    return {
        messages: sanitizeContextMessages(src && src.messages, q.messages),
        previousMemories: {
            enabled: src ? srcPrev.enabled !== false : true,
            count: num(srcPrev.count, 0, 7, 3),
            lorebookName: typeof srcPrev.lorebookName === 'string' ? srcPrev.lorebookName.trim().slice(0, 256) : '',
            includePriorEntry: srcPrev.includePriorEntry === true,
        },
        sources: {
            charCard: {
                enabled: src ? srcCC.enabled !== false : q.includeCharCard !== false,
                maxChars: num(srcCC.maxChars, 100, 20000, 2000),
            },
            authorNote: {
                enabled: src ? srcAN.enabled !== false : q.includeAuthorNote !== false,
                maxChars: num(srcAN.maxChars, 100, 10000, 1500),
            },
            worldInfo: {
                enabled: src ? srcWI.enabled !== false : q.includeWorldInfo !== false,
                mode: srcWI.mode === 'full' ? 'full' : 'names',
                maxCharsPerEntry: num(srcWI.maxCharsPerEntry, 100, 20000, 2000),
            },
            injected: {
                enabled: src ? srcInj.enabled !== false : q.includeInjected !== false,
            },
        },
        prompt: {
            preset: typeof srcPrompt.preset === 'string' && srcPrompt.preset.trim() ? srcPrompt.preset.trim().slice(0, 64) : 'lorekeeper',
            custom: typeof srcPrompt.custom === 'string' ? srcPrompt.custom.slice(0, 8000) : '',
            useRegex: srcPrompt.useRegex === true,
        },
        tokenWarningThreshold: src ? num(src.tokenWarningThreshold, 0, 1000000, 50000) : 50000,
    };
}

/**
 * Migrate a v1 (legacy backend) agent object to Hub v2. Returns
 * { config, notes[] } — notes describe anything the user must re-do
 * (vault secrets, Connection Manager profiles, SearXNG).
 */
function migrateAgentToHubV2(src) {
    const notes = [];
    const s = (src && typeof src === 'object') ? src : {};
    const out = {};

    // Legacy model connection → hub model + sampler.
    if (typeof s.apiModel === 'string' && s.apiModel.trim()) {
        out.model = s.apiModel.trim().slice(0, 256);
        notes.push(`Model "${out.model}" carried over as a model override — pick a hub API profile or preset for it.`);
    }
    if (s.temperature !== undefined) {
        out.samplers = { temperature: clamp(s.temperature, 0, 2, 0.7) };
    }
    if (s.useSeparateApi || s.secretId) {
        notes.push('Vault secret removed — the hub now owns connections. Recreate it as a hub API profile in ST-RequestHub settings, then select it below.');
    }
    // Legacy tool permissions → toolScope.
    const tp = (s.toolPermissions && typeof s.toolPermissions === 'object') ? s.toolPermissions : {};
    const pick = (key, legacy) => {
        if (tp[key] !== undefined) return !!tp[key];
        if (legacy !== undefined) return !!legacy;
        return undefined;
    };
    out.toolScope = {
        allowCreate: pick('propose_create_entry', s.canCreate) !== false,
        allowEdit: pick('propose_edit_entry', s.canEdit) !== false,
        allowDelete: pick('propose_delete_entry', s.canDelete) === true,
        allowResearch: (pick('research', s.canResearch) === true) || ((s.research && s.research.source && s.research.source !== 'disabled')),
    };
    if (out.toolScope.allowResearch) {
        notes.push('Research flag carried over, but the hub has no web-search tool yet — it is reserved for now.');
    }
    if (s.research && (s.research.searxngUrl || s.research.searxngToken)) {
        notes.push('SearXNG URL/token removed — the hub owns execution and has no SearXNG integration.');
    }
    // Legacy multi-turn → hub agent loop. The old engine always had tools, so
    // v1 agents become hubMode 'agent' (never 'single' — that would drop tools).
    out.hubMode = 'agent';
    if (s.hubMode === 'single' || s.hubMode === 'agent') {
        out.hubMode = s.hubMode;
    } else if (s.multiTurn && typeof s.multiTurn === 'object') {
        if (s.multiTurn.enabled === true) {
            out.maxSteps = clamp(s.multiTurn.maxCalls ?? s.multiTurn.safetyCap ?? 10, 1, 25, 10);
            notes.push(`Agentic loop carried over: maxSteps=${out.maxSteps}.`);
        } else {
            out.maxSteps = 3;
            notes.push('Single-round agent migrated to hub agent mode with maxSteps=3 (was: one tool round). Raise it for deeper runs.');
        }
    }
    if (s.maxTokens !== undefined && out.maxTokens === undefined) {
        out.maxTokens = clamp(s.maxTokens, 1, 128000, 1024);
    }
    // Legacy token budget (context) does not map to hub output tokens.
    if (s.limits && typeof s.limits === 'object') {
        if (s.limits.maxCharsPerEntry !== undefined) out.maxCharsPerEntry = clamp(s.limits.maxCharsPerEntry, 100, 50000, 8000);
        else if (s.maxCharsPerEntry !== undefined) out.maxCharsPerEntry = clamp(s.maxCharsPerEntry, 100, 50000, 8000);
    }
    // Legacy quick-task Connection Manager profile ids are meaningless to the hub.
    if (s.quickDefaults && typeof s.quickDefaults === 'object' && s.quickDefaults.profileId) {
        notes.push('One-shot connection profile cleared — v1 Connection Manager profiles are not hub API profiles. Re-pick it below.');
    }
    if (!notes.length) notes.push('Migrated to Hub v2 request config.');
    return { config: out, notes };
}

function sanitizeAgentConfig(input) {
    const src = input && typeof input === 'object' ? input : {};
    // Migrate legacy fields first so sanitize sees v2 shapes.
    let migrated = null;
    const looksLegacy = src.useSeparateApi !== undefined || src.secretId !== undefined
        || src.apiModel !== undefined || src.toolPermissions !== undefined
        || src.multiTurn !== undefined || src.temperature !== undefined
        || (src.research && (src.research.searxngUrl !== undefined || src.research.searxngToken !== undefined));
    if (looksLegacy && src.hubMigratedAt === undefined) {
        migrated = migrateAgentToHubV2(src);
    }
    const base = migrated ? Object.assign({}, src, migrated.config) : src;
    const out = {};
    out.name = typeof base.name === 'string' && base.name.trim() ? base.name.trim().slice(0, 120) : DEFAULT_AGENT_CONFIG.name;
    out.enabled = base.enabled !== false;
    out.mode = base.mode === 'periodic' ? 'periodic' : 'manual';
    out.interval = clamp(base.interval ?? base.periodicInterval ?? 10, 1, 1000, 10);
    out.periodicInterval = out.interval;
    out.taskDescription = typeof base.taskDescription === 'string' ? base.taskDescription.slice(0, 4000) : '';
    out.customInstructions = typeof base.customInstructions === 'string' ? base.customInstructions.slice(0, 8000) : '';
    const pr = (base.prompt && typeof base.prompt === 'object') ? base.prompt : {};
    out.prompt = {
        role: ['system', 'user', 'assistant'].includes(pr.role) ? pr.role : 'system',
        position: pr.position === 'after' ? 'after' : 'before',
        custom: typeof pr.custom === 'string' ? pr.custom.slice(0, 8000) : '',
    };

    out.hubMode = base.hubMode === 'single' ? 'single' : 'agent';
    out.model = typeof base.model === 'string' ? base.model.trim().slice(0, 256) : '';
    out.apiProfile = typeof base.apiProfile === 'string' ? base.apiProfile.trim().slice(0, 256) : '';
    out.preset = typeof base.preset === 'string' ? base.preset.trim().slice(0, 256) : '';
    out.useOwnConfig = base.useOwnConfig === true;
    out.samplers = sanitizeSamplers(base.samplers);
    out.maxTokens = clamp(base.maxTokens, 1, 128000, 1024);
    out.timeoutMs = clamp(base.timeoutMs, 0, 3600000, 90000);
    if (base.timeoutMs === 0) out.timeoutMs = 0;
    out.retries = clamp(base.retries, 0, 5, 1);
    out.maxSteps = clamp(base.maxSteps, 1, 100, 10);
    out.totalTimeoutMs = clamp(base.totalTimeoutMs, 0, 3600000, 600000);
    if (base.totalTimeoutMs === 0) out.totalTimeoutMs = 0;

    const ts = (base.toolScope && typeof base.toolScope === 'object') ? base.toolScope : {};
    out.toolScope = {
        allowCreate: ts.allowCreate !== false,
        allowEdit: ts.allowEdit !== false,
        allowDelete: ts.allowDelete === true,
        allowResearch: ts.allowResearch === true,
    };

    out.autoAccept = base.autoAccept === true;
    out.autoAcceptConfidence = clamp(base.autoAcceptConfidence, 0, 1, 0.8);
    out.maxEntriesPerRun = clamp(base.maxEntriesPerRun, 1, 100, 5);
    out.requireKeyConfidence = ['low', 'medium', 'high'].includes(base.requireKeyConfidence) ? base.requireKeyConfidence : 'low';
    out.maxPendingProposals = clamp(base.maxPendingProposals, 1, 100, 20);
    out.requireConfirmation = base.requireConfirmation !== false;
    out.maxCharsPerEntry = clamp(base.maxCharsPerEntry, 100, 50000, 8000);
    out.scope = base.scope === 'local' ? 'local' : 'global';
    out.boundCharacterId = base.boundCharacterId ?? null;
    out.boundChatId = base.boundChatId ?? null;
    out.notifyNoMatch = base.notifyNoMatch === true;

    out.injectedContext = Array.isArray(base.injectedContext) ? cloneDeep(base.injectedContext) : [];
    // Unified context: explicit context wins; otherwise migrate from the
    // deprecated quickDefaults message/source picks so old agents keep
    // behaving identically under the new builder.
    out.context = sanitizeContextConfig(base.context, base.quickDefaults);
    const qd = base.quickDefaults && typeof base.quickDefaults === 'object' ? base.quickDefaults : {};
    const qm = qd.messages && typeof qd.messages === 'object' ? qd.messages : {};
    const qr = qm.range && typeof qm.range === 'object' ? qm.range : {};
    const qRangeStart = clamp(qr.start, 0, 100000, 0);
    let qRangeEnd = clamp(qr.end, 0, 100000, 10);
    if (qRangeEnd < qRangeStart) qRangeEnd = qRangeStart;
    out.quickDefaults = {
        // v1 CM profile ids are dropped on migration (see migrateAgentToHubV2).
        profileId: (migrated && qd.profileId) ? '' : (typeof qd.profileId === 'string' ? qd.profileId.trim().slice(0, 256) : ''),
        messages: {
            type: ['none', 'all', 'first', 'last', 'range'].includes(qm.type) ? qm.type : 'last',
            first: clamp(qm.first, 1, 1000, 10),
            last: clamp(qm.last, 1, 1000, 10),
            range: { start: qRangeStart, end: qRangeEnd },
        },
        includeCharCard: qd.includeCharCard !== false,
        includeAuthorNote: qd.includeAuthorNote !== false,
        includeWorldInfo: qd.includeWorldInfo !== false,
        includeInjected: qd.includeInjected !== false,
    };
    out.dynamicLinks = [];
    if (Array.isArray(base.dynamicLinks)) {
        const seenNames = new Set();
        for (const link of base.dynamicLinks) {
            if (!link || typeof link.name !== 'string' || !link.name.trim()) continue;
            const name = link.name.trim().slice(0, 256);
            if (seenNames.has(name)) continue;
            seenNames.add(name);
            const pinUids = Array.isArray(link.pinUids)
                ? [...new Set(link.pinUids.map(Number).filter(n => Number.isInteger(n) && n >= 0))]
                : [];
            out.dynamicLinks.push({ name, pinUids });
        }
    }
    out.conditionals = [];
    if (Array.isArray(base.conditionals)) {
        const seenRule = new Set();
        for (const r of base.conditionals) {
            if (!r || r.characterId === undefined || r.characterId === null || String(r.characterId) === '') continue;
            const cid = String(r.characterId);
            if (seenRule.has(cid)) continue;
            seenRule.add(cid);
            out.conditionals.push({
                characterId: cid,
                characterName: typeof r.characterName === 'string' ? r.characterName.slice(0, 120) : '',
                enabled: r.enabled !== false,
                injectedContext: Array.isArray(r.injectedContext) ? r.injectedContext.filter(s => s && typeof s.lorebook === 'string' && s.lorebook.trim()) : [],
                taskOverride: typeof r.taskOverride === 'string' ? r.taskOverride.slice(0, 4000) : '',
                instructionsOverride: typeof r.instructionsOverride === 'string' ? r.instructionsOverride.slice(0, 8000) : '',
            });
        }
    }
    const dr = base.defaultRule && typeof base.defaultRule === 'object' ? base.defaultRule : {};
    out.defaultRule = {
        injectedContext: Array.isArray(dr.injectedContext) ? cloneDeep(dr.injectedContext) : [],
        taskOverride: typeof dr.taskOverride === 'string' ? dr.taskOverride.slice(0, 4000) : '',
        instructionsOverride: typeof dr.instructionsOverride === 'string' ? dr.instructionsOverride.slice(0, 8000) : '',
    };
    if (migrated) {
        out.hubMigratedAt = Date.now();
        out.hubMigrateNotes = migrated.notes.slice(0, 8);
    } else {
        if (base.hubMigratedAt !== undefined) out.hubMigratedAt = base.hubMigratedAt;
        if (Array.isArray(base.hubMigrateNotes)) out.hubMigrateNotes = base.hubMigrateNotes.slice(0, 8);
    }
    return out;
}

// Linked-only access: the agent's visible world is exactly the union of
// static injected picks, every conditional rule's picks, the default rule's
// picks, and dynamic link names. Anything else is hard-blocked.
function getLinkedLorebookNames(agent) {
    const names = new Set();
    const addSel = (s) => {
        if (s && typeof s.lorebook === 'string' && s.lorebook.trim()) names.add(s.lorebook.trim());
    };
    try {
        (agent?.injectedContext || []).forEach(addSel);
        for (const r of (agent?.conditionals || [])) (r?.injectedContext || []).forEach(addSel);
        (agent?.defaultRule?.injectedContext || []).forEach(addSel);
        for (const l of (agent?.dynamicLinks || [])) {
            if (l && typeof l.name === 'string' && l.name.trim()) names.add(l.name.trim());
        }
    } catch {}
    return [...names];
}

function isLorebookLinked(agent, lorebookName) {
    if (typeof lorebookName !== 'string' || !lorebookName.trim()) return false;
    return getLinkedLorebookNames(agent).includes(lorebookName.trim());
}

function validateAgentConfig(config) {
    const c = sanitizeAgentConfig(config);
    return { valid: true, config: c };
}

// Expose globally for non-module consumers (app.js loads as script)
if (typeof window !== 'undefined') {
    window.ELAgentConfigSchema = {
        DEFAULT_AGENT_CONFIG,
        ALLOWED_FIELDS,
        SAMPLER_KEYS,
        sanitizeAgentConfig,
        sanitizeSamplers,
        sanitizeContextConfig,
        sanitizeExcludeIds,
        migrateAgentToHubV2,
        getLinkedLorebookNames,
        isLorebookLinked,
        validateAgentConfig,
        cloneDeep,
    };
}
