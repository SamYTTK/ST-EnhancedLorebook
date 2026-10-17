/**
 * hub-client.js — ST-RequestHub connection layer for Enhanced Lorebook.
 *
 * This module OWNS all LLM execution for the extension. Nothing else in the
 * extension may touch HTTP model routes, vault secrets, or the old
 * `/agent/direct-complete` proxy. Flow:
 *
 *   agent config (v2 schema) → EL_buildHubRequest() → validateRequest()
 *   → hub.request() → EL_parseHubProposals() → /proposals/batch-save → Feed
 *
 * It also provides the plugin-storage transport (EL_apiFetch*) that used to
 * live in agent-tools.js, so proposals/backups/backup-watch/audit keep
 * working unchanged after the legacy backend is deleted.
 *
 * Classic script (no modules). Works in the popup AND in the main window
 * (quick-task): pass an explicit `st` (SillyTavern context) where available,
 * otherwise it resolves ST_Window / SillyTavern.getContext() itself.
 */

const EL_API_BASE = '/api/plugins/enhanced-lorebook-agent';
const EL_HUB_CONSUMER = 'EnhancedLorebook';
const EL_HUB_MIN_API = 3;

// ── Frozen proposal JSON contract (MemoryBooks-style — machine-parsed) ──
// This shape NEVER changes; only the contents do. It is identical for the
// LorebookProposeChange tool result and the final reply, so the model can
// copy-paste staged proposals verbatim into {"proposals":[...]} with no
// translation step. The parser (EL_parseHubProposals) accepts exactly this.
const EL_PROPOSAL_CONTRACT = Object.freeze({
    requiredTop: ['proposals'],
    actions: ['create', 'edit', 'delete'],
    // Full lorebook entry fields accepted inside entryData (create) and
    // inside changes (edit). Subset most models actually emit is listed first.
    entryFields: ['comment', 'key', 'keysecondary', 'content', 'order', 'position',
        'depth', 'probability', 'selective', 'constant', 'disable',
        'excludeRecursion', 'preventRecursion', 'vectorized', 'group',
        'groupWeight', 'groupOverride', 'sticky', 'cooldown', 'delay',
        'selectiveLogic', 'role', 'outletName'],
});

// ── Plugin-storage transport (moved verbatim from agent-tools.js) ──

function EL_fireToast(message, toastType = 'warning') {
    const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
    const text = String(message);
    try {
        if (host && typeof host.postMessage === 'function') {
            host.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-toast', message: text, toastType }, window.location.origin);
            return;
        }
    } catch (_) {}
    try {
        if (host && typeof host.toastr === 'object' && host.toastr) {
            const fn = host.toastr[toastType] || host.toastr.warning;
            if (typeof fn === 'function') {
                fn.call(host.toastr, text);
                return;
            }
        }
    } catch (_) {}
    if (typeof showToast === 'function') {
        showToast(text);
    }
}

function EL_getRequestHeaders() {
    try {
        if (typeof stContext !== 'undefined' && stContext && typeof stContext.getRequestHeaders === 'function') {
            return stContext.getRequestHeaders();
        }
    } catch {}
    try {
        const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
        if (host && host.SillyTavern && typeof host.SillyTavern.getContext === 'function') {
            const ctx = host.SillyTavern.getContext();
            if (ctx && typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders();
        }
    } catch {}
    return { 'Content-Type': 'application/json' };
}

async function EL_apiFetch(method, path, body) {
    return EL_apiFetchWithSignal(method, path, body, null);
}

async function EL_apiFetchWithSignal(method, path, body, signal) {
    const url = `${EL_API_BASE}${path}`;
    let headers = EL_getRequestHeaders() || {};
    const hasCsrf = headers['X-CSRF-Token'] || headers['x-csrf-token'] || headers['X-Csrf-Token'];
    if (!hasCsrf) {
        try {
            const c = document.cookie || '';
            const m = c.match(/X-CSRF-Token=([^;]+)/);
            if (m && m[1]) headers = { ...headers, 'X-CSRF-Token': decodeURIComponent(m[1]) };
            else {
                const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
                if (host && host.document) {
                    const hc = host.document.cookie || '';
                    const hm = hc.match(/X-CSRF-Token=([^;]+)/);
                    if (hm && hm[1]) headers = { ...headers, 'X-CSRF-Token': decodeURIComponent(hm[1]) };
                }
            }
        } catch {}
        if (!headers['X-CSRF-Token'] && !headers['x-csrf-token']) {
            try {
                const r = await fetch('/csrf-token', { method: 'GET', cache: 'no-store' });
                if (r.ok) {
                    const j = await r.json().catch(() => null);
                    if (j && j.token) headers = { ...headers, 'X-CSRF-Token': j.token };
                }
            } catch {}
        }
    }
    const opts = { method, headers };
    if (body !== undefined) {
        opts.body = JSON.stringify(body);
    }
    if (signal) opts.signal = signal;
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

// ── Popup → main-window bridge (chat lorebooks lookup for "Sync with Chat") ──

const _elBridgePending = new Map();
let _elBridgeListenerInstalled = false;
let _elBridgeSeq = 0;

function EL_postToHost(msg) {
    try {
        const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
        if (host && typeof host.postMessage === 'function' && host !== window) {
            host.postMessage({ source: 'enhanced-lorebook', ...(msg || {}) }, window.location.origin);
            return true;
        }
    } catch {}
    return false;
}

function EL_installBridgeListener() {
    if (_elBridgeListenerInstalled) return;
    _elBridgeListenerInstalled = true;
    try {
        window.addEventListener('message', (e) => {
            try {
                if (e.origin !== window.location.origin) return;
                const msg = e.data;
                if (!msg || typeof msg !== 'object' || msg.source !== 'enhanced-lorebook') return;
                if ((msg.type === 'el-agent-dynamic-scan-result' || msg.type === 'el-agent-chat-books') && msg.requestId != null) {
                    const pending = _elBridgePending.get(msg.requestId);
                    if (pending) {
                        _elBridgePending.delete(msg.requestId);
                        try { clearTimeout(pending.timer); } catch {}
                        pending.resolve(msg);
                    }
                }
            } catch {}
        });
    } catch {}
}

function EL_bridgeRequest(type, payload, timeoutMs) {
    EL_installBridgeListener();
    return new Promise((resolve) => {
        const requestId = 'elq_' + Date.now().toString(36) + '_' + (++_elBridgeSeq) + '_' + Math.random().toString(36).slice(2, 6);
        const timer = setTimeout(() => {
            _elBridgePending.delete(requestId);
            resolve({ requestId, timeout: true });
        }, Math.max(1000, Number(timeoutMs) || 15000));
        _elBridgePending.set(requestId, { resolve, timer });
        const posted = EL_postToHost({ type, requestId, ...(payload || {}) });
        if (!posted) {
            try { clearTimeout(timer); } catch {}
            _elBridgePending.delete(requestId);
            resolve({ requestId, noHost: true });
        }
    });
}

/**
 * Request the chat's active lorebook set (global + chat-bound + character).
 * Returns { globalBooks, chatLorebook, characterLorebooks, embeddedBook } — never throws.
 */
async function EL_requestChatBooks(timeoutMs) {
    const fallback = { globalBooks: [], chatLorebook: null, characterLorebooks: [], embeddedBook: null };
    const res = await EL_bridgeRequest('el-agent-request-chat-books', {}, timeoutMs || 15000);
    if (!res || res.noHost || res.timeout) return fallback;
    return {
        globalBooks: Array.isArray(res.globalBooks) ? res.globalBooks : [],
        chatLorebook: typeof res.chatLorebook === 'string' ? res.chatLorebook : null,
        characterLorebooks: Array.isArray(res.characterLorebooks) ? res.characterLorebooks : [],
        embeddedBook: typeof res.embeddedBook === 'string' ? res.embeddedBook : null,
    };
}

// ── Hub access ──

function EL_getHub() {
    try {
        if (typeof globalThis !== 'undefined' && globalThis.STRequestHub) return globalThis.STRequestHub;
    } catch {}
    try {
        const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
        if (host && host.STRequestHub) return host.STRequestHub;
    } catch {}
    return null;
}

function EL_isHubReady() {
    const hub = EL_getHub();
    if (!hub || typeof hub.request !== 'function') return false;
    try {
        if (typeof hub.isReady === 'function' && !hub.isReady()) return false;
    } catch {
        return false;
    }
    return true;
}

function EL_hubStatus() {
    const hub = EL_getHub();
    if (!hub) return { ok: false, reason: 'missing', detail: 'ST-RequestHub is not installed or disabled.' };
    if (typeof hub.request !== 'function') return { ok: false, reason: 'incompatible', detail: 'ST-RequestHub global has no request() function.' };
    try {
        if (typeof hub.isReady === 'function' && !hub.isReady()) {
            return { ok: false, reason: 'disabled', detail: 'ST-RequestHub is installed but disabled.' };
        }
    } catch {
        return { ok: false, reason: 'unknown', detail: 'Could not probe ST-RequestHub readiness.' };
    }
    if (typeof hub.apiVersion === 'number' && hub.apiVersion < EL_HUB_MIN_API) {
        return { ok: false, reason: 'outdated', detail: `ST-RequestHub api v${hub.apiVersion} < required v${EL_HUB_MIN_API}. Update the hub.` };
    }
    return { ok: true, version: hub.version || '', apiVersion: hub.apiVersion || 0 };
}

function EL_onHubReady(cb) {
    if (typeof cb !== 'function') return () => {};
    if (EL_isHubReady()) {
        try { cb(EL_getHub()); } catch (e) { console.error('Enhanced Lorebook: hub ready callback failed', e); }
        return () => {};
    }
    let done = false;
    const fire = () => {
        if (done) return;
        done = true;
        try { cb(EL_getHub()); } catch (e) { console.error('Enhanced Lorebook: hub ready callback failed', e); }
    };
    const timers = [];
    try {
        const st = EL_resolveHubSt();
        if (st && st.eventSource && typeof st.eventSource.on === 'function' && st.event_types) {
            const evt = st.event_types['HUB_READY'] || 'hub:ready';
            const handler = () => fire();
            try { st.eventSource.on(evt, handler); } catch {}
            try { st.eventSource.on('hub:ready', handler); } catch {}
        }
    } catch {}
    try {
        const hub = EL_getHub();
        if (hub && typeof hub.on === 'function') hub.on('ready', fire);
    } catch {}
    timers.push(setTimeout(function poll() {
        if (done) return;
        if (EL_isHubReady()) { fire(); return; }
        timers.push(setTimeout(poll, 1500));
    }, 1500));
    return () => {
        done = true;
        for (const t of timers) clearTimeout(t);
    };
}

function EL_resolveHubSt(explicit) {
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

function EL_canonicalHubChatId(st) {
    const charId = st?.characterId ?? 'no-char';
    const chatFile = st?.chat?.chat_id ?? st?.chatId ?? 'default';
    return charId + '_' + chatFile;
}

// ── Prompt assembly ──

function EL_stripHubHtml(s) {
    return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function EL_buildLinkedBooksLine(agent) {
    const names = [];
    try {
        const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
        const list = schema ? schema.getLinkedLorebookNames(agent) : [];
        for (const n of (list || [])) {
            if (typeof n === 'string' && n.trim() && !names.includes(n.trim())) names.push(n.trim());
        }
    } catch {}
    return names;
}

async function EL_buildStaticContextBlock(st, agent, opts) {
    opts = opts || {};
    const access = (typeof agent?.toolScope === 'object' && agent.toolScope) || {};
    const canCreate = access.allowCreate !== false;
    const canEdit = access.allowEdit !== false;
    const canDelete = access.allowDelete === true;
    const allowedActions = [
        canCreate ? 'create' : null,
        canEdit ? 'edit' : null,
        canDelete ? 'delete' : null,
    ].filter(Boolean);
    const parts = [];
    const maxBooks = 20;
    const maxCharsPerBook = Math.max(500, Math.min(12000, Number(opts.maxCharsPerBook) || 4000));
    const names = EL_buildLinkedBooksLine(agent);
    if (!names.length) {
        parts.push('(No lorebooks linked. Link lorebooks in the agent config first.)');
    } else {
        for (const name of names.slice(0, maxBooks)) {
            let entries = null;
            try {
                const data = await st.loadWorldInfo(name);
                entries = data && data.entries ? data.entries : null;
            } catch {}
            if (!entries) {
                parts.push(`Lorebook "${name}": (could not load — skipped)`);
                continue;
            }
            const uids = Object.keys(entries);
            const lines = [`Lorebook "${name}" (${uids.length} entries):`];
            for (const uid of uids.slice(0, 60)) {
                const e = entries[uid] || {};
                const keys = Array.isArray(e.key) ? e.key.join(', ') : '';
                let content = EL_stripHubHtml(e.content || '');
                if (content.length > maxCharsPerBook) content = content.slice(0, maxCharsPerBook) + ' ...[truncated]';
                lines.push(`- UID ${uid} | keys=[${keys}] | comment="${e.comment || ''}" | order=${e.order ?? 100}\n  content="${content}"`);
            }
            if (uids.length > 60) lines.push(`  ... and ${uids.length - 60} more entries (use ls / grep / read tools to inspect).`);
            parts.push(lines.join('\n'));
        }
    }
    const header = [
        '## Lorebooks in scope (linked-only — you MUST NOT touch any other book)',
        `Allowed proposal actions: ${allowedActions.length ? allowedActions.join(', ') : '(none — read-only analysis, explain findings in plain text)'}`,
        `Max proposals this run: ${Number(agent?.maxEntriesPerRun) || 5}.`,
    ].join('\n');
    return header + '\n' + parts.join('\n\n');
}

function EL_hubAllowedActions(agent) {
    const access = (typeof agent?.toolScope === 'object' && agent.toolScope) || {};
    return [
        access.allowCreate !== false ? 'create' : null,
        access.allowEdit !== false ? 'edit' : null,
        access.allowDelete === true ? 'delete' : null,
    ].filter(Boolean);
}

function EL_resolveCustomText(agent) {
    // Unified context prompt first: explicit custom text (context or legacy
    // prompt.custom / customInstructions), then the preset guidance text.
    try {
        if (agent && typeof EL_resolveAgentContext === 'function') {
            const ctx = EL_resolveAgentContext(agent);
            const cc = String((ctx.prompt && ctx.prompt.custom) || '').trim();
            if (cc) return cc;
        }
    } catch {}
    const p = (agent?.prompt && typeof agent.prompt === 'object') ? agent.prompt : {};
    const custom = String(p.custom || '').trim();
    if (custom) return custom;
    const legacy = String(agent?.customInstructions || '').trim();
    if (legacy) return legacy;
    try {
        if (typeof EL_resolveContextPromptText === 'function') {
            return String(EL_resolveContextPromptText(agent) || '');
        }
    } catch {}
    return '';
}

function EL_resolvePromptRole(agent) {
    const p = (agent?.prompt && typeof agent.prompt === 'object') ? agent.prompt : {};
    return ['system', 'user', 'assistant'].includes(p.role) ? p.role : 'system';
}

function EL_resolvePromptPosition(agent) {
    const p = (agent?.prompt && typeof agent.prompt === 'object') ? agent.prompt : {};
    return p.position === 'after' ? 'after' : 'before';
}

// Client-side history collector (same semantics as the hub's buildHistoryText:
// skip ST system messages, last N, "Name: text"). Lets us place the prompt
// block before OR after history with full control.
function EL_collectHistoryText(st, maxHistory) {
    try {
        const chat = Array.isArray(st?.chat) ? st.chat : [];
        const n = Math.max(0, Number(maxHistory) || 0);
        if (!n) return '';
        return chat
            .filter(m => m && !m.is_system)
            .slice(-n)
            .map(m => `${m.name ?? (m.is_user ? 'User' : 'Assistant')}: ${m.mes ?? ''}`)
            .join('\n');
    } catch { return ''; }
}

/**
 * Environment briefing — the auto-generated head of every prompt message.
 * Tells the model what it is, how many turns it has, which tools exist,
 * and that its output goes to a human approval waitlist (never applied).
 * runCtx: { hubMode, maxSteps, toolDefs:[{name,description}], snapshotMode }
 * snapshotMode: 'static' (snapshots pasted below) | 'ondemand' (tools fetch)
 *   | 'none' (no book content this run).
 */
function EL_buildMetaBlock(agent, runCtx) {
    runCtx = runCtx || {};
    const hubMode = runCtx.hubMode === 'single' ? 'single' : 'agent';
    const maxSteps = Math.max(1, Math.min(100, Number(runCtx.maxSteps ?? agent?.maxSteps) || 10));
    const maxEntries = Math.max(1, Math.min(100, Number(agent?.maxEntriesPerRun) || 5));
    const allowed = EL_hubAllowedActions(agent);
    const names = EL_buildLinkedBooksLine(agent);
    const tools = Array.isArray(runCtx.toolDefs) ? runCtx.toolDefs : [];
    const snapshotMode = ['static', 'ondemand', 'none'].includes(runCtx.snapshotMode) ? runCtx.snapshotMode : 'ondemand';
    const autoAccept = agent?.autoAccept === true;
    const threshold = Number(agent?.autoAcceptConfidence ?? 0.8);
    const agentName = String(agent?.name || 'Agent').slice(0, 80);

    const lines = [];
    lines.push('# Environment briefing — read first, it defines your job');
    lines.push(`You are "${agentName}", a lorebook maintenance agent running inside SillyTavern (via the ST-RequestHub backend). You are NOT roleplaying and NOT talking to the user. Your reply is parsed as data (see output contract below) — no human reads your raw text, so put everything the reviewer needs INSIDE the JSON fields.`);
    lines.push('## How this run works');
    if (hubMode === 'single') {
        lines.push('- Mode: SINGLE one-shot. You get exactly ONE reply. There are no tools and no follow-ups. Do all of your reasoning in this reply and end it with the JSON object.');
        lines.push('- Pinned entries (if any) are already pasted in the task brief below as lorebook://<Book>/<uid> files. Treat them as the ONLY full entries you have — do not invent other UIDs.');
    } else {
        lines.push(`- Mode: AGENTIC tool loop. You have up to ${maxSteps} model↔tool round(s); this is round 1.`);
        lines.push('- Strategy: browse like a folder — ls lorebook:// first, then grep to find candidates, then read full files, then stage each change with propose. Batch independent tool calls in ONE block. Do not dribble one call per round.');
        lines.push('- Intermediate rounds are TOOL CALLS ONLY — do NOT write the JSON object until you are done calling tools.');
        lines.push('- Final round: call NO tools and reply with ONLY the JSON object defined in the output contract below (one JSON object, no prose before/after). The propose tool results are already in final shape — paste each returned proposal object VERBATIM into the "proposals" array.');
        lines.push('- If you hit the round cap, your last tool results are recovered automatically — but a clean final JSON round is still preferred.');
        if (tools.length) {
            lines.push(`- Tools available: ${tools.map(t => `${t.name} — ${String(t.description || '').split('.')[0]}`).join('; ')}.`);
            lines.push('- Never guess entry UIDs or book contents — ls/grep/read them first. Extra context lives at charcard://<name|active> and author-note:// — read them when an entry references a character or the author note.');
        }
    }
    lines.push(`- Proposals this run: at most ${maxEntries}. ${allowed.length ? `You may stage: ${allowed.join(', ')}.` : 'READ-ONLY analysis: stage nothing, explain findings in the note field.'}`);
    lines.push('## Approval workflow (you apply NOTHING yourself)');
    lines.push('- Everything you stage goes to a human review waitlist (Review Changes feed). A human accepts, denies, or sends feedback on each proposal. Nothing you output touches a lorebook directly.');
    lines.push(autoAccept
        ? `- Auto-accept is ON at confidence ≥ ${threshold}: calibrate confidence honestly, the reviewer trusts it.`
        : '- Nothing applies without explicit human approval — write reasoning + confidence for the HUMAN reviewer on each proposal.');
    lines.push(names.length
        ? `- Scope: ONLY these lorebooks exist for you: ${names.join(', ')}. Any other book name is rejected — do not invent books or entries outside them.`
        : '- Scope: NO lorebooks are linked. Ask for links (via a "note") instead of proposing changes.');
    if (snapshotMode === 'static') lines.push('- Full snapshots of the linked books follow in the task brief below — work from them, no tools available.');
    else if (snapshotMode === 'ondemand') lines.push('- Book contents load ON DEMAND through your tools; the brief below lists names only.');
    lines.push('- If the task is impossible or nothing is needed, reply {"proposals":[]} (you may add a top-level "note" string for the human; it is ignored by the parser).');
    return lines.join('\n');
}

function EL_buildHubTaskText(agent, opts) {
    opts = opts || {};
    // taskOverride lets one-shot callers (quick-task) replace the agent's
    // stored task while the unified builder still supplies history+sources.
    const task = String(opts.taskOverride !== undefined && opts.taskOverride !== null ? opts.taskOverride : (agent?.taskDescription || '')).trim();
    const names = EL_buildLinkedBooksLine(agent);
    const allowed = EL_hubAllowedActions(agent);
    const maxEntries = Math.max(1, Math.min(100, Number(agent?.maxEntriesPerRun) || 5));
    const lines = [];
    if (task) lines.push(`## Task\n${task}`);
    else lines.push('## Task\nGeneral lorebook maintenance: review the linked books against the conversation and propose needed changes.');
    lines.push(names.length ? `Linked lorebooks (ONLY these are visible/editable — address as lorebook://<Book>): ${names.map(n => 'lorebook://' + n).join(', ')}.` : 'No lorebooks are linked. Ask the user to link lorebooks before proposing changes.');
    if (opts.contextBlock) lines.push(opts.contextBlock);
    if (opts.extraContext) lines.push(String(opts.extraContext));
    lines.push([
        `Propose at most ${maxEntries} change(s).`,
        allowed.length ? `You may propose: ${allowed.join(', ')}.` : 'This is a READ-ONLY analysis: propose nothing, explain findings in the note field.',
        'OUTPUT CONTRACT (mandatory — MemoryBooks-style, machine-parsed):',
        'You must respond with ONLY valid JSON in this exact format. Return ONLY the JSON object, no other text — no greeting, no explanation, no markdown outside the object. (A single ```json fence wrapping ONLY the object is tolerated, but bare JSON is preferred.)',
        '{',
        '  "proposals": [',
        '    {"action":"create","lorebookName":"Exact Book Name",',
        '     "entryData":{"comment":"Short entry title","key":["keyword1","keyword2"],"keysecondary":[],',
        '      "content":"Full entry text...","order":100,"position":0,"depth":4,"probability":100,',
        '      "selective":false,"constant":false,"disable":false,"excludeRecursion":false,"preventRecursion":false},',
        '     "reasoning":"why this is needed (for the human reviewer)","confidence":0.9},',
        '    {"action":"edit","lorebookName":"Exact Book Name","uid":12,',
        '     "changes":{"content":"replacement text","key":["new","keys"]},',
        '     "reasoning":"why this edit is needed","confidence":0.9},',
        '    {"action":"delete","lorebookName":"Exact Book Name","uid":12,',
        '     "reasoning":"why this entry should go","confidence":0.9}',
        '  ],',
        '  "note": "optional human-readable note (string, ignored by the parser)"',
        '}',
        'Rules: create → lorebookName + entryData{comment,key[],content} (uid omitted; key/keys as string array; title alias accepted for comment).',
        'edit → lorebookName + uid (integer, from ls/grep/read — never guess) + changes{field:new value}.',
        'delete → lorebookName + uid + reasoning.',
        'reasoning (string) and confidence (0..1 number) are required on every proposal for the human reviewer.',
        'lorebookName must EXACTLY match a linked book. Empty result = {"proposals":[]} (you may add "note").',
        'In agent mode the propose tool returns objects already in this shape — paste them VERBATIM into "proposals", do not retype or translate them.',
    ].join('\n'));
    return lines.join('\n\n');
}

/**
 * Build the prompt message: [meta briefing] + [custom user text] + [task brief].
 * opts: { taskBrief?, contextBlock?, extraContext?, hubMode?, toolDefs?, snapshotMode? }
 */
function EL_buildPromptMessage(agent, opts) {
    opts = opts || {};
    const hubMode = opts.hubMode === 'single' ? 'single'
        : (opts.hubMode === 'agent' ? 'agent'
        : ((agent?.hubMode === 'single') ? 'single' : 'agent'));
    let toolDefs = Array.isArray(opts.toolDefs) ? opts.toolDefs : null;
    if (!toolDefs && hubMode === 'agent' && typeof EL_buildHubTools === 'function') {
        try { toolDefs = EL_buildHubTools(agent, null, {}) || []; } catch { toolDefs = []; }
    }
    const meta = EL_buildMetaBlock(agent, {
        hubMode,
        maxSteps: agent?.maxSteps,
        toolDefs: toolDefs || [],
        snapshotMode: opts.snapshotMode,
    });
    const custom = EL_resolveCustomText(agent);
    const taskBrief = (opts.taskBrief !== undefined && opts.taskBrief !== null)
        ? String(opts.taskBrief)
        : EL_buildHubTaskText(agent, { contextBlock: opts.contextBlock, extraContext: opts.extraContext });
    const parts = [meta];
    if (custom) parts.push(`## Agent instructions (user-configured, override defaults where they conflict)\n${custom}`);
    if (taskBrief && taskBrief.trim()) parts.push(taskBrief);
    return { role: EL_resolvePromptRole(agent), content: parts.join('\n\n') };
}

// ── Request builder (config v2 → hub JSON) ──

function EL_buildHubRequest(agent, runOpts) {
    runOpts = runOpts || {};
    const cfg = (agent && typeof agent === 'object') ? agent : {};
    const hubMode = cfg.hubMode === 'agent' ? 'agent' : 'single';
    const samplers = Object.assign({}, cfg.samplers || {});
    const settings = {
        apiProfile: typeof cfg.apiProfile === 'string' ? cfg.apiProfile : '',
        preset: typeof cfg.preset === 'string' ? cfg.preset : '',
        useOwnConfig: cfg.useOwnConfig === true,
        samplers,
        maxTokens: Math.max(1, Number(cfg.maxTokens) || 1024),
        timeoutMs: Math.max(0, Number(cfg.timeoutMs) || 0),
        retries: Math.max(0, Number(cfg.retries) || 0),
    };
    if (typeof cfg.model === 'string' && cfg.model.trim()) {
        settings.connection = { model: cfg.model.trim() };
    }
    // Tools first: the meta briefing names them, so both need the same list.
    let tools = [];
    if (hubMode === 'agent') {
        tools = (typeof EL_buildHubTools === 'function')
            ? EL_buildHubTools(cfg, runOpts.st || null, runOpts)
            : [];
    }
    // History is resolved client-side so prompt position (before/after) is exact.
    const st = runOpts.st || null;
    let historyText = '';
    if (runOpts._unifiedCtx) {
        // Unified builder output (exact selected history, possibly empty).
        historyText = String(runOpts._unifiedCtx.historyText || '');
    } else if (typeof runOpts.historyText === 'string' && runOpts.historyText) {
        historyText = runOpts.historyText;
    } else if (st && runOpts.attachChat !== false && !runOpts.messages) {
        historyText = EL_collectHistoryText(st, Math.max(0, Number(runOpts.maxHistory) || 20));
    }
    const stForSnapshot = st;
    const snapshotMode = !stForSnapshot ? 'none' : (hubMode === 'single' ? 'static' : 'ondemand');
    const taskBrief = (runOpts.taskText !== undefined && runOpts.taskText !== null && String(runOpts.taskText).trim())
        ? String(runOpts.taskText)
        : EL_buildHubTaskText(cfg, { contextBlock: runOpts.contextBlock, extraContext: runOpts.extraContext });
    const promptMsg = EL_buildPromptMessage(cfg, { taskBrief, hubMode, toolDefs: tools, snapshotMode });
    const position = EL_resolvePromptPosition(cfg);
    let messages;
    if (Array.isArray(runOpts.messages) && runOpts.messages.length) {
        // Ready-made thread (Agent Chat): prompt block placed per position —
        // 'before' unshifts ahead of the thread, 'after' appends at depth 0.
        const thread = runOpts.messages
            .filter(m => m && typeof m.content === 'string')
            .map(m => ({ role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user', content: m.content }));
        messages = position === 'after' ? [...thread, promptMsg] : [promptMsg, ...thread];
        // Agent-chat static sources: the thread carries its own history, but
        // the agent's configured source blocks (WI/char card/etc.) still ride
        // along next to the prompt message.
        if (typeof runOpts.extraContext === 'string' && runOpts.extraContext.trim()) {
            const ctxMsg = { role: 'user', content: runOpts.extraContext.trim() };
            messages = position === 'after'
                ? [...thread, ctxMsg, promptMsg]
                : [promptMsg, ctxMsg, ...thread];
        }
    } else {
        const histMsg = historyText.trim()
            ? [{ role: 'user', content: `Conversation so far:\n${historyText}` }]
            : [];
        messages = position === 'after' ? [...histMsg, promptMsg] : [promptMsg, ...histMsg];
    }
    const traceTitle = String(cfg.taskDescription || cfg.name || cfg.id || 'run').slice(0, 200);
    const input = {
        text: `Current task: ${traceTitle}`,
        messages,
        task: '{{input}}',
        useWI: false,
        attachChat: false,
        maxHistory: 20,
    };
    const req = {
        mode: hubMode,
        input,
        settings,
        label: String(runOpts.label || `lorebook:${cfg.name || cfg.id || 'run'}`),
        consumer: EL_HUB_CONSUMER,
    };
    if (hubMode === 'agent') {
        req.tools = { include: [], exclude: [], extra: tools, choice: 'auto' };
        req.limits = {
            maxSteps: Math.max(1, Math.min(100, Number(cfg.maxSteps) || 10)),
            totalTimeoutMs: Math.max(0, Number(cfg.totalTimeoutMs) || 0),
        };
        if (typeof runOpts.onStep === 'function') req.onStep = runOpts.onStep;
    }
    if (runOpts.signal) req.signal = runOpts.signal;
    if (typeof runOpts.onChunk === 'function') {
        req.stream = true;
        req.onChunk = runOpts.onChunk;
    }
    return req;
}

// ── Response parsing (hub content → proposals[]) ──
// MemoryBooks-style tolerant pipeline (see SillyTavern-MemoryBooks/stmemory.js
// parseAIJsonResponse): normalize → strip <think> → prefer fenced blocks →
// try full text → try balanced substring → strict parse then light repair.
// The contract shape itself never changes (EL_PROPOSAL_CONTRACT); only the
// contents do, so the model always emits something directly committable.

function EL_normalizeHubText(s) {
    return String(s ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/^\uFEFF/, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001F\u200B-\u200D\u2060]/g, '');
}

function EL_stripHubThink(s) {
    return String(s ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
}

function EL_extractFencedBlocks(s) {
    const re = /```(?:json)?\s*([\s\S]*?)```/gi;
    const out = [];
    let m;
    while ((m = re.exec(s)) !== null) {
        const body = (m[1] || '').trim();
        if (body) out.push(body);
    }
    return out;
}

function EL_extractBalancedJson(s) {
    const start = s.search(/[{[]/);
    if (start === -1) return null;
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === open) depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0) return s.slice(start, i + 1).trim();
        }
    }
    return null;
}

function EL_hasJsonDelimiter(s) {
    return /[{[]/.test(s);
}

function EL_likelyUnbalancedHub(raw) {
    try {
        let braces = 0, brackets = 0, inString = false, isEscaping = false;
        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];
            if (inString) {
                if (isEscaping) isEscaping = false;
                else if (ch === '\\') isEscaping = true;
                else if (ch === '"') inString = false;
            } else {
                if (ch === '"') inString = true;
                else if (ch === '{') braces++;
                else if (ch === '}') braces--;
                else if (ch === '[') brackets++;
                else if (ch === ']') brackets--;
            }
            if (braces < 0 || brackets < 0) return true;
        }
        return inString || braces !== 0 || brackets !== 0;
    } catch { return false; }
}

function EL_endsNicelyHub(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    if (/[.!?]["'’)\]]?$/.test(t)) return true;
    if (t.length >= 80 && !/[.!?]$/.test(t)) return false;
    return true;
}

// Light local repair (no npm deps in classic script): smart quotes → ASCII,
// trailing commas → dropped. Covers the vast majority of model JSON slips
// without a full dirty-json port.
function EL_repairJsonText(s) {
    let t = String(s ?? '');
    t = t.replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/[\u2018\u2019\u201A\u201B]/g, "'");
    t = t.replace(/,\s*([}\]])/g, '$1');
    return t;
}

function EL_tryParseCandidate(cand) {
    const t = String(cand ?? '').trim();
    if (!t) return null;
    try { return JSON.parse(t); } catch {}
    try { return JSON.parse(EL_repairJsonText(t)); } catch {}
    return null;
}

function EL_buildHubCandidates(rawText) {
    const normalized = EL_stripHubThink(EL_normalizeHubText(rawText)).trim();
    if (!normalized) return { normalized: '', candidates: [] };
    const fenced = EL_extractFencedBlocks(normalized);
    const list = [];
    if (fenced.length) list.push(...fenced);
    list.push(normalized);
    const balanced = EL_extractBalancedJson(normalized);
    if (balanced) list.push(balanced);
    // Also try balanced extraction inside each fenced block (fence may wrap prose+JSON).
    for (const f of fenced) {
        const b = EL_extractBalancedJson(f);
        if (b && !list.includes(b)) list.push(b);
    }
    const seen = new Set();
    const uniq = [];
    for (const c of list) {
        if (typeof c !== 'string' || !c.trim() || seen.has(c)) continue;
        seen.add(c);
        uniq.push(c);
    }
    return { normalized, candidates: uniq };
}

function EL_extractJsonObject(text) {
    const src = String(text || '');
    if (!src.trim()) return null;
    const { candidates } = EL_buildHubCandidates(src);
    for (const cand of candidates) {
        const parsed = EL_tryParseCandidate(cand);
        if (parsed !== null && parsed !== undefined) return parsed;
    }
    return null;
}

function EL_coerceHubStringArray(v, max) {
    const cap = Math.max(1, Math.min(50, Number(max) || 20));
    if (Array.isArray(v)) return v.map(x => String(x ?? '').trim()).filter(Boolean).slice(0, cap);
    if (typeof v === 'string' && v.trim()) return v.split(',').map(x => x.trim()).filter(Boolean).slice(0, cap);
    return [];
}

function EL_sanitizeHubProposal(raw, agent, idx) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const action = String(raw.action || '').toLowerCase().trim();
    if (!['create', 'edit', 'delete'].includes(action)) return null;
    const lorebookName = typeof raw.lorebookName === 'string' ? raw.lorebookName.trim().slice(0, 256) : '';
    if (!lorebookName) return null;
    try {
        const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
        if (schema && !schema.isLorebookLinked(agent, lorebookName)) return null;
    } catch {}
    const uid = (raw.uid === undefined || raw.uid === null || raw.uid === '') ? null : Number(raw.uid);
    if ((action === 'edit' || action === 'delete') && !Number.isInteger(uid)) return null;
    const access = (agent?.toolScope && typeof agent.toolScope === 'object') ? agent.toolScope : {};
    if (action === 'create' && access.allowCreate === false) return null;
    if (action === 'edit' && access.allowEdit === false) return null;
    if (action === 'delete' && access.allowDelete !== true) return null;
    let confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.5;
    confidence = Math.min(1, Math.max(0, confidence));
    const p = {
        id: EL_proposalId(),
        timestamp: Date.now(),
        action,
        lorebookName,
        status: 'pending',
        reasoning: String(raw.reasoning || raw.reason || '').slice(0, 4000),
        confidence,
        agentId: agent?.id || 'unknown',
        agentName: agent?.name || 'Agent',
        source: 'hub',
    };
    if (uid !== null) p.uid = uid;
    if (action === 'create') {
        // Accept BOTH shapes so tool results paste verbatim with zero translation:
        // final shape {entryData:{...}} AND flat tool-arg shape {comment,key,content,...}.
        const flat = raw;
        const ed = (raw.entryData && typeof raw.entryData === 'object') ? raw.entryData : null;
        const src = ed || {
            comment: flat.comment ?? flat.title,
            key: flat.key ?? flat.keys,
            keysecondary: flat.keysecondary ?? flat.secondaryKeys,
            content: flat.content,
            order: flat.order, position: flat.position, depth: flat.depth,
            probability: flat.probability, selective: flat.selective,
            constant: flat.constant, disable: flat.disable,
            excludeRecursion: flat.excludeRecursion, preventRecursion: flat.preventRecursion,
            vectorized: flat.vectorized,
        };
        const comment = String(src.comment ?? src.title ?? `Hub proposal ${idx + 1}`).slice(0, 500).trim();
        const content = String(src.content ?? '').slice(0, 50000);
        if (!content.trim()) return null;
        p.entryData = {
            comment: comment || `Hub proposal ${idx + 1}`,
            key: EL_coerceHubStringArray(src.key ?? src.keys, 20),
            keysecondary: EL_coerceHubStringArray(src.keysecondary ?? src.secondaryKeys, 20),
            content,
        };
        const numOr = (v, fb) => {
            if (v === undefined || v === null || v === '') return undefined;
            const n = Number(v);
            return Number.isFinite(n) ? n : fb;
        };
        const order = numOr(src.order, undefined);
        if (order !== undefined) p.entryData.order = order;
        const position = numOr(src.position, undefined);
        if (position !== undefined) p.entryData.position = position;
        const depth = numOr(src.depth, undefined);
        if (depth !== undefined) p.entryData.depth = depth;
        const prob = numOr(src.probability, undefined);
        if (prob !== undefined) p.entryData.probability = prob;
        for (const b of ['selective', 'constant', 'disable', 'excludeRecursion', 'preventRecursion', 'vectorized']) {
            if (src[b] !== undefined) p.entryData[b] = src[b] === true || String(src[b]).toLowerCase() === 'true';
        }
        for (const extra of ['group', 'groupWeight', 'groupOverride', 'sticky', 'cooldown', 'delay', 'selectiveLogic', 'role', 'outletName']) {
            if (src[extra] !== undefined) {
                const v = src[extra];
                if (typeof v === 'string') p.entryData[extra] = v.slice(0, 500);
                else if (typeof v === 'number' || typeof v === 'boolean') p.entryData[extra] = v;
                else if (Array.isArray(v)) p.entryData[extra] = v.map(String).slice(0, 20);
            }
        }
    } else if (action === 'edit') {
        // Accept {changes:{...}} AND flat {content / key / ...} tool-arg shape.
        let ch = (raw.changes && typeof raw.changes === 'object' && !Array.isArray(raw.changes)) ? { ...raw.changes } : null;
        if (!ch) {
            ch = {};
            const flatKeys = ['comment', 'title', 'key', 'keys', 'keysecondary', 'content', 'order',
                'position', 'depth', 'probability', 'selective', 'constant', 'disable',
                'excludeRecursion', 'preventRecursion', 'vectorized'];
            for (const k of flatKeys) {
                if (raw[k] !== undefined) {
                    if (k === 'title') ch.comment = raw[k];
                    else if (k === 'keys') ch.key = raw[k];
                    else ch[k] = raw[k];
                }
            }
            if (raw.content !== undefined && !ch.content) ch.content = raw.content;
        }
        if (!ch || !Object.keys(ch).length) return null;
        p.changes = {};
        for (const [k, v] of Object.entries(ch)) {
            if (k === 'uid' || k === '_folderPath') continue;
            if (typeof v === 'string') p.changes[k] = v.slice(0, 50000);
            else if (typeof v === 'number' || typeof v === 'boolean') p.changes[k] = v;
            else if (Array.isArray(v)) p.changes[k] = v.map(String).slice(0, 20);
            else if (v && typeof v === 'object') {
                try { p.changes[k] = JSON.parse(JSON.stringify(v)); } catch {}
            }
        }
        if (!Object.keys(p.changes).length) return null;
    }
    return p;
}

function EL_parseHubProposals(content, agent) {
    const out = { proposals: [], warnings: [], raw: String(content || '') };
    const rawText = String(content || '');
    if (!rawText.trim()) {
        out.warnings.push('Model returned an empty response — nothing to review. Retry or switch model.');
        return out;
    }
    const { normalized, candidates } = EL_buildHubCandidates(rawText);
    let parsed = null;
    for (const cand of candidates) {
        const attempt = EL_tryParseCandidate(cand);
        if (attempt !== null && attempt !== undefined) { parsed = attempt; break; }
    }
    if (parsed === null || parsed === undefined) {
        if (!EL_hasJsonDelimiter(normalized)) {
            out.warnings.push('Model did not return JSON (no { or [ found) — nothing to review. The output contract requires ONLY the JSON object; ask it to retry.');
        } else if (EL_likelyUnbalancedHub(normalized)) {
            out.warnings.push('Model JSON looks truncated (unbalanced { } / [ ]) — nothing to review. Raise maxTokens for this agent and retry.');
        } else if (normalized.trim().length >= 80 && !EL_endsNicelyHub(normalized)) {
            out.warnings.push('Model JSON looks incomplete (ends mid-sentence, likely truncated) — nothing to review. Raise maxTokens and retry.');
        } else {
            out.warnings.push('Model did not return valid JSON — nothing to review. Ask it to retry or switch model.');
        }
        return out;
    }
    if (typeof parsed === 'string') {
        const inner = EL_tryParseCandidate(parsed);
        if (inner && typeof inner === 'object') parsed = inner;
    }
    const list = Array.isArray(parsed?.proposals) ? parsed.proposals
        : Array.isArray(parsed) ? parsed
        : (parsed && typeof parsed === 'object' && parsed.proposal ? [parsed.proposal] : null);
    if (!list) {
        const keys = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? Object.keys(parsed).slice(0, 8).join(', ') : typeof parsed;
        out.warnings.push(`Model JSON parsed but has no "proposals" array (saw: ${keys || 'empty'}) — nothing to review. The contract requires {"proposals":[...]}.`);
        return out;
    }
    if (!list.length) return out;
    const maxEntries = Math.max(1, Math.min(100, Number(agent?.maxEntriesPerRun) || 5));
    list.slice(0, maxEntries).forEach((rawItem, i) => {
        // Tool-trace shape recovery: a staged result may be wrapped as
        // {ok:true, proposal:{...}} if the model echoed the tool payload.
        let raw = rawItem;
        try {
            if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.proposal && typeof raw.proposal === 'object') raw = raw.proposal;
            if (typeof raw === 'string') {
                const inner = EL_tryParseCandidate(raw);
                if (inner && typeof inner === 'object') raw = inner.proposal && typeof inner.proposal === 'object' ? inner.proposal : inner;
            }
        } catch {}
        try {
            const p = EL_sanitizeHubProposal(raw, agent, i);
            if (p) out.proposals.push(p);
            else out.warnings.push(`Proposal #${i + 1} rejected (bad action, unlinked book, disallowed action, or missing content/uid/changes).`);
        } catch (e) {
            out.warnings.push(`Proposal #${i + 1} failed validation: ${e?.message || e}`);
        }
    });
    if (list.length > maxEntries) out.warnings.push(`Capped at ${maxEntries} proposals (maxEntriesPerRun).`);
    return out;
}

// Mine successfully staged propose tool results from hub steps.
// Used when the final JSON is missing/invalid (or the run hit maxSteps) so a
// productive tool trace still lands in the Feed instead of vanishing.
function EL_recoverStagedHubProposals(steps, agent) {
    const out = [];
    try {
        const arr = Array.isArray(steps) ? steps : [];
        for (const step of arr) {
            const results = Array.isArray(step?.results) ? step.results : [];
            for (const r of results) {
                try {
                    if (!r || r.ok === false) continue;
                    const name = String(r.name || '');
                    if (name !== 'propose' && name !== 'LorebookProposeChange') continue;
                    const payload = EL_tryParseCandidate(String(r.result ?? ''));
                    if (!payload || typeof payload !== 'object') continue;
                    const raw = payload.proposal && typeof payload.proposal === 'object' ? payload.proposal : payload;
                    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
                    if (!raw.action || !raw.lorebookName) continue;
                    const p = EL_sanitizeHubProposal(raw, agent, out.length);
                    if (p) {
                        p.source = 'hub-tools';
                        out.push(p);
                    }
                } catch {}
            }
        }
    } catch {}
    // De-dupe identical (action/book/uid/content) doubles from retried rounds.
    const seen = new Set();
    return out.filter(p => {
        try {
            const key = [p.action, p.lorebookName, p.uid ?? '', String(p.entryData?.content ?? p.changes?.content ?? '').slice(0, 200)].join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        } catch { return true; }
    });
}

// ── Runner ──

function EL_friendlyHubError(e) {
    const code = e?.code || 'UNKNOWN';
    const map = {
        INVALID_REQUEST: 'Invalid hub request — check model/profile/preset and agent config.',
        TOOLS_UNSUPPORTED: 'This model has no function calling. Use single mode or pick a tool-capable model.',
        TOOL_CONFLICT: 'Tool name conflict in hub request.',
        MAX_STEPS: 'Agent hit max steps. Partial progress may still be usable — raise maxSteps or narrow the task.',
        EMPTY_RESPONSE: 'Model returned an empty response. Retry or switch model.',
        TIMEOUT: 'Hub request timed out. Raise timeout or narrow the task.',
        ABORTED: 'Run was stopped.',
        NETWORK: 'Network error reaching the model endpoint.',
        CONFIG: 'Hub is not configured for this request (no URL, model, or preset).',
    };
    let msg = map[code] || `Hub error (${code}).`;
    if (e?.message) msg += ` ${String(e.message).slice(0, 300)}`;
    if (Array.isArray(e?.details) && e.details.length) msg += ` Details: ${e.details.slice(0, 4).join('; ')}`;
    return { code, message: msg };
}

async function EL_commitHubProposals(proposals, chatId, agent) {
    if (!proposals.length) return { saved: 0 };
    const payload = { chatId, proposals };
    const res = await EL_apiFetch('POST', '/proposals/batch-save', payload);
    let saved = proposals.length;
    try {
        const list = await EL_apiFetch('GET', '/proposals/list?chatId=' + encodeURIComponent(chatId));
        if (list && Array.isArray(list.proposals)) saved = list.proposals.length;
    } catch {}
    // Auto-accept policy lives HERE (caller side), never in the hub.
    // Applied directly (the feed array doesn't hold these yet, so the
    // feed's handleAcceptProposal would no-op). Decided proposals are
    // deleted from storage per delete-on-decision.
    const autoApplied = [];
    try {
        if (agent && agent.autoAccept === true) {
            const threshold = Number(agent.autoAcceptConfidence ?? 0.8);
            // Deletes are deliberately excluded from auto-accept because they are destructive and must stay in the review feed.
            const eligible = proposals.filter(p => p.action !== 'delete' && Number(p.confidence) >= threshold);
            if (eligible.length && typeof EL_applyProposal === 'function') {
                for (const p of eligible) {
                    try { await EL_applyProposal(p, { agentName: agent?.name || 'hub' }); autoApplied.push(p.id); } catch {}
                }
                if (autoApplied.length) {
                    try { await EL_apiFetch('POST', '/proposals/delete', { chatId, proposalIds: autoApplied }); } catch {}
                }
            }
        }
    } catch {}
    try {
        if (typeof loadProposalsForCurrentChat === 'function') await loadProposalsForCurrentChat();
    } catch {}
    try {
        const pending = proposals.length;
        if (typeof sendPendingCount === 'function') sendPendingCount(pending);
        else if (typeof updatePendingBadge === 'function') updatePendingBadge();
    } catch {}
    return { saved, result: res, autoApplied };
}

/**
 * Full run: build → validate → hub.request → parse → commit to Feed.
 * @param {object} agent - v2 config object
 * @param {object} runOpts - { st?, taskText?, historyText?, attachChat?, maxHistory?,
 *   label?, signal?, onChunk?, onStep?, chatId?, commit=true, statusEl? }
 */
async function EL_runHubAgent(agent, runOpts) {
    runOpts = runOpts || {};
    const st = EL_resolveHubSt(runOpts.st);
    const status = EL_hubStatus();
    if (!status.ok) {
        throw new Error(status.detail + ' Open ST-RequestHub settings to configure it.');
    }
    const hub = EL_getHub();
    const preWarnings = [];
    // Unified context: one builder for all run paths (history selection,
    // previous memories, char card, author note, WI, injected). Skipped when
    // the caller passes ready-made messages/history/task (agent-chat thread,
    // revise calls, explicit overrides).
    let builtCtx = null;
    const wantsUnified = !(Array.isArray(runOpts.messages) && runOpts.messages.length)
        && typeof runOpts.historyText !== 'string';
    if (wantsUnified && st && typeof EL_buildAgentContextAsync === 'function') {
        try {
            builtCtx = await EL_buildAgentContextAsync(st, agent, { contextOverride: runOpts.contextOverride });
            for (const w of (builtCtx.warnings || [])) preWarnings.push(w);
        } catch (e) {
            preWarnings.push('Unified context build failed, falling back to legacy assembly.');
            builtCtx = null;
        }
    }
    // Token budget gate (MemoryBooks parity): confirm before sending a huge
    // first-request payload. Non-interactive callers without a confirm hook
    // continue with a warning attached.
    if (builtCtx && builtCtx.tokens && typeof EL_checkContextTokenWarning === 'function') {
        try {
            const gate = EL_checkContextTokenWarning(builtCtx, agent);
            if (gate.over) {
                const msg = `Context is ~${gate.total} tokens (threshold ${gate.threshold}).`;
                if (typeof runOpts.confirmTokenWarning === 'function') {
                    const ok = await runOpts.confirmTokenWarning(gate, builtCtx);
                    if (!ok) {
                        const err = new Error('Cancelled — ' + msg);
                        err.code = 'TOKEN_BUDGET';
                        throw err;
                    }
                    preWarnings.push(msg + ' Continued after confirmation.');
                } else {
                    preWarnings.push(msg + ' No confirm hook — continuing.');
                }
            }
        } catch (e) {
            if (e && e.code === 'TOKEN_BUDGET') throw e;
        }
    }
    // Default task text: agent task + static context snapshot. Skipped when
    // the caller passes ready-made messages (they carry their own context).
    let taskText = String(runOpts.taskText || '');
    if (!taskText && !(Array.isArray(runOpts.messages) && runOpts.messages.length)) {
        let contextBlock = '';
        try {
            if (builtCtx) {
                contextBlock = builtCtx.contextBlock || '';
            } else if (st && (agent?.hubMode !== 'agent')) {
                contextBlock = await EL_buildStaticContextBlock(st, agent, runOpts);
            } else if (st) {
                const names = EL_buildLinkedBooksLine(agent);
                contextBlock = names.length
                    ? `## Lorebooks in scope (use the Lorebook* tools to inspect — content loads on demand)\n${names.map(n => `- ${n}`).join('\n')}`
                    : '(No lorebooks linked. Link lorebooks in the agent config first.)';
            }
        } catch (e) {
            contextBlock = `(Context snapshot failed: ${e?.message || e})`;
        }
        taskText = EL_buildHubTaskText(agent, { taskOverride: runOpts.taskOverride, contextBlock, extraContext: runOpts.extraContext });
    }
    const req = EL_buildHubRequest(agent, Object.assign({}, runOpts, { st, taskText, _unifiedCtx: builtCtx }));
    try {
        if (typeof hub.validateRequest === 'function') {
            const v = hub.validateRequest(req);
            if (v && v.ok === false) {
                const errs = Array.isArray(v.errors) ? v.errors : ['unknown validation error'];
                throw new hub.HubError ? new hub.HubError('Request invalid: ' + errs.join('; '), 'INVALID_REQUEST', { details: errs }) : new Error('Request invalid: ' + errs.join('; '));
            }
        }
    } catch (e) {
        if (e && (e.code === 'INVALID_REQUEST' || /invalid/i.test(String(e?.message || '')))) throw e;
    }
    let res;
    try {
        if (typeof window !== 'undefined') window._elHubRunning = (Number(window._elHubRunning) || 0) + 1;
        res = await hub.request(req);
    } catch (e) {
        try {
            if (typeof window !== 'undefined') window._elHubRunning = Math.max(0, (Number(window._elHubRunning) || 1) - 1);
        } catch {}
        try {
            if (e && Array.isArray(e.partialSteps) && e.partialSteps.length && typeof runOpts.onPartialSteps === 'function') {
                runOpts.onPartialSteps(e.partialSteps);
            }
        } catch {}
        // MAX_STEPS / TIMEOUT mid-run: the tool trace may already hold valid
        // staged proposals — recover + commit them instead of losing the run.
        try {
            const partial = Array.isArray(e?.partialSteps) ? e.partialSteps : [];
            if (partial.length && (e?.code === 'MAX_STEPS' || e?.code === 'TIMEOUT')) {
                const recovered = EL_recoverStagedHubProposals(partial, agent);
                if (recovered.length) {
                    const chatId = String(runOpts.chatId || EL_canonicalHubChatId(st));
                    if (runOpts.commit !== false) {
                        try { await EL_commitHubProposals(recovered, chatId, agent); } catch {}
                    }
                    return {
                        success: true,
                        content: '',
                        reasoning: '',
                        steps: partial,
                        meta: {},
                        proposalsCreated: recovered.length,
                        proposals: recovered,
                        warnings: [`${e.code === 'MAX_STEPS' ? 'Hit max steps' : 'Timed out'} — recovered ${recovered.length} staged proposal(s) from the tool trace. Raise maxSteps or narrow the task for a clean final-JSON round.`],
                        recoveredFromSteps: true,
                    };
                }
            }
        } catch {}
        const friendly = EL_friendlyHubError(e);
        const err = new Error(friendly.message);
        err.code = friendly.code;
        err.hubError = e;
        throw err;
    }
    try {
        if (typeof window !== 'undefined') window._elHubRunning = Math.max(0, (Number(window._elHubRunning) || 1) - 1);
    } catch {}
    const parsed = EL_parseHubProposals(res?.content || '', agent);
    let proposals = parsed.proposals;
    const warnings = [...preWarnings, ...parsed.warnings];
    let recoveredFromSteps = false;
    // Fallback: final JSON missing/invalid but the tool loop staged valid work.
    // Recover it so the run still produces Feed entries instead of zero.
    if (!proposals.length && Array.isArray(res?.steps) && res.steps.length) {
        try {
            const recovered = EL_recoverStagedHubProposals(res.steps, agent);
            if (recovered.length) {
                proposals = recovered;
                recoveredFromSteps = true;
                warnings.unshift(`Final reply was not valid JSON — recovered ${recovered.length} staged proposal(s) from the tool trace instead.`);
            }
        } catch {}
    }
    const chatId = String(runOpts.chatId || EL_canonicalHubChatId(st));
    if (runOpts.commit !== false && proposals.length) {
        const commitRes = await EL_commitHubProposals(proposals, chatId, agent);
        const autoDone = (commitRes && Array.isArray(commitRes.autoApplied)) ? commitRes.autoApplied : [];
        if (autoDone.length) {
            const done = new Set(autoDone);
            proposals = proposals.filter(p => !done.has(p.id));
            warnings.push(`Auto-accepted + applied ${done.size} proposal(s) at/above confidence — removed from feed.`);
        }
    }
    return {
        success: true,
        content: res?.content || '',
        reasoning: res?.reasoning || '',
        steps: res?.steps || [],
        meta: res?.meta || {},
        proposalsCreated: proposals.length,
        proposals,
        warnings,
        contextTokens: builtCtx ? builtCtx.tokens : null,
        ...(recoveredFromSteps ? { recoveredFromSteps: true } : {}),
    };
}

/**
 * Apply one Feed proposal to its lorebook (human-approved commit step).
 * Supports hub shapes ({entryData} / {changes}) and legacy {entrySnapshot}.
 * Takes a safety backup first, then saves via the worldinfo guard.
 */
async function EL_applyProposal(proposal, opts) {
    opts = opts || {};
    const st = EL_resolveHubSt(opts.st);
    if (!st) throw new Error('No SillyTavern context available');
    const data = await st.loadWorldInfo(proposal.lorebookName);
    if (!data || !data.entries) {
        throw new Error('Lorebook "' + proposal.lorebookName + '" not found');
    }

    // Safety backup before mutating (server-side, 24h expiry).
    try {
        if (typeof BackupClient !== 'undefined') {
            const bc = new BackupClient({});
            if (typeof bc.createAgentBackup === 'function') await bc.createAgentBackup(proposal.lorebookName);
        }
    } catch {}

    const ENTRY_FIELDS = ['key', 'keysecondary', 'comment', 'content', 'order', 'position', 'depth',
        'probability', 'constant', 'vectorized', 'selective', 'disable', 'excludeRecursion',
        'preventRecursion', 'group', 'groupWeight', 'groupOverride', 'sticky', 'cooldown', 'delay',
        'triggers', 'characterFilter', 'characterFilterExclude', 'selectiveLogic', 'role', 'outletName'];

    if (proposal.action === 'create') {
        const snapshot = proposal.entryData || proposal.entrySnapshot || {};
        const folderPathFromProposal = proposal._folderPath || snapshot._folderPath || '';
        let nextUid = null;
        for (let uid = 0; uid < 1000000; uid++) if (!(uid in data.entries)) { nextUid = uid; break; }
        if (nextUid === null) throw new Error('No free UID available');
        const newEntry = {};
        for (const key of ENTRY_FIELDS) {
            if (snapshot[key] !== undefined) newEntry[key] = snapshot[key];
        }
        newEntry.uid = nextUid;
        data.entries[nextUid] = newEntry;

        let folderAssigned = false;
        if (folderPathFromProposal && typeof window !== 'undefined' && window.ELFolderUrl) {
            try { folderAssigned = window.ELFolderUrl.assignEntryToUrl(nextUid, window.ELFolderUrl.buildUrl(proposal.lorebookName, folderPathFromProposal, nextUid), proposal.lorebookName); } catch {}
        }
        if (!folderAssigned && snapshot.folderId) {
            try {
                const folders = (typeof extensionSettings !== 'undefined' ? extensionSettings?.folders?.[proposal.lorebookName] : null);
                if (folders) {
                    const folder = folders.find(f => f.id === snapshot.folderId);
                    if (folder) { folder.entries.push(String(nextUid)); folderAssigned = true; }
                }
            } catch (_) {}
        }
        if (!folderAssigned && proposal.url && typeof window !== 'undefined' && window.ELFolderUrl) {
            try { window.ELFolderUrl.assignEntryToUrl(nextUid, window.ELFolderUrl.buildUrlForNewUid(proposal.url, nextUid), proposal.lorebookName); } catch {}
        }
    } else if (proposal.action === 'edit') {
        const uid = proposal.uid;
        const entry = data.entries[uid];
        if (!entry) throw new Error('Entry UID ' + uid + ' not found');
        const snapshot = proposal.changes || proposal.entrySnapshot || {};
        for (const key of Object.keys(snapshot)) {
            if (key === 'uid' || key === '_folderPath') continue;
            entry[key] = snapshot[key];
        }
        const moveFolderPath = proposal._folderPath || snapshot._folderPath;
        if (moveFolderPath !== undefined && moveFolderPath !== null && typeof window !== 'undefined' && window.ELFolderUrl) {
            try {
                const targetUrl = window.ELFolderUrl.buildUrl(proposal.lorebookName, moveFolderPath || '', uid);
                window.ELFolderUrl.assignEntryToUrl(uid, targetUrl, proposal.lorebookName);
            } catch {}
        }
    } else if (proposal.action === 'delete') {
        const uid = proposal.uid;
        if (!data.entries[uid]) throw new Error('Entry UID ' + uid + ' not found');
        delete data.entries[uid];
    } else {
        throw new Error('Unknown proposal action: ' + proposal.action);
    }

    if (typeof window === 'undefined' || typeof window.ELG_guardSave !== 'function') {
        throw new Error('Refusing to write "' + proposal.lorebookName + '": the lorebook guard (worldinfo-guard.js) is not loaded. Nothing was written.');
    }
    const saved = await window.ELG_guardSave(proposal.lorebookName, data, {
        explicitDelete: proposal.action === 'delete',
        source: 'agent',
        note: (proposal.action === 'delete' ? 'Hub delete' : 'Hub apply') + ' - ' + (opts.agentName || 'hub'),
    });
    if (!saved) {
        throw new Error('Apply blocked or failed — nothing was written to "' + proposal.lorebookName + '".');
    }
    if (proposal.action === 'delete') {
        try {
            const folders = (typeof extensionSettings !== 'undefined' ? extensionSettings?.folders?.[proposal.lorebookName] : null);
            if (folders) {
                for (const folder of folders) {
                    folder.entries = folder.entries.filter(e => String(e) !== String(proposal.uid));
                }
            }
        } catch (_) {}
        try {
            if (typeof saveSettings === 'function') saveSettings();
        } catch {}
    }

    try {
        const currName = (typeof currentLorebookName !== 'undefined' ? currentLorebookName : null);
        if (currName === proposal.lorebookName) {
            if (typeof renderEntries === 'function') renderEntries();
            else if (typeof refreshAfterAgentChange === 'function') refreshAfterAgentChange(proposal.lorebookName);
        }
    } catch {}
}

/**
 * Revise one proposal with user feedback via a hub single-mode call.
 * Returns the updated proposal fields (caller persists via /proposals/save).
 */
async function EL_reviseHubProposal(agent, proposal, feedback, opts) {
    opts = opts || {};
    const status = EL_hubStatus();
    if (!status.ok) throw new Error(status.detail);
    const hub = EL_getHub();
    const reviseBrief = [
        '## Task\nRevise this lorebook proposal according to the user feedback.',
        `Original proposal: ${JSON.stringify(proposal).slice(0, 6000)}`,
        `User feedback: ${String(feedback || '').slice(0, 2000)}`,
        'OUTPUT CONTRACT (mandatory): You must respond with ONLY valid JSON in this exact format. Return ONLY the JSON object, no other text:',
        '{"proposal":{"action":"create|edit|delete","lorebookName":"...","uid":123,"entryData":{"comment":"...","key":["..."],"keysecondary":[],"content":"...","order":100,"position":0,"depth":4,"probability":100,"selective":false},"changes":{"content":"..."},"reasoning":"...","confidence":0.9}}',
        'Keep lorebookName and action unless the feedback demands otherwise. confidence is 0..1.',
    ].join('\n\n');
    const promptMsg = EL_buildPromptMessage(agent, { taskBrief: reviseBrief, hubMode: 'single', snapshotMode: 'none', toolDefs: [] });
    const req = {
        mode: 'single',
        input: { text: `Revise proposal ${proposal?.id || ''}`, messages: [promptMsg], task: '{{input}}', useWI: false, attachChat: false },
        settings: {
            apiProfile: agent?.apiProfile || '',
            preset: agent?.preset || '',
            useOwnConfig: agent?.useOwnConfig === true,
            samplers: Object.assign({}, agent?.samplers || {}),
            maxTokens: Math.max(1, Number(agent?.maxTokens) || 1024),
            timeoutMs: Math.max(0, Number(agent?.timeoutMs) || 0),
            retries: Math.max(0, Number(agent?.retries) || 0),
        },
        label: `lorebook-revise:${agent?.name || 'agent'}`,
        consumer: EL_HUB_CONSUMER,
    };
    const res = await hub.request(req);
    let parsed = EL_extractJsonObject(res?.content || '');
    if (typeof parsed === 'string') {
        try { const inner = EL_tryParseCandidate(parsed); if (inner && typeof inner === 'object') parsed = inner; } catch {}
    }
    const upd = parsed && typeof parsed === 'object' ? (parsed.proposal || parsed) : null;
    if (!upd || typeof upd !== 'object' || Array.isArray(upd)) throw new Error('Model did not return a revised proposal as JSON.');
    return upd;
}

if (typeof window !== 'undefined') {
    window.EL_API_BASE = EL_API_BASE;
    window.EL_fireToast = EL_fireToast;
    window.EL_getRequestHeaders = EL_getRequestHeaders;
    window.EL_apiFetch = EL_apiFetch;
    window.EL_apiFetchWithSignal = EL_apiFetchWithSignal;
    window.EL_proposalId = EL_proposalId;
    window.EL_getHub = EL_getHub;
    window.EL_isHubReady = EL_isHubReady;
    window.EL_hubStatus = EL_hubStatus;
    window.EL_onHubReady = EL_onHubReady;
    window.EL_buildHubRequest = EL_buildHubRequest;
    window.EL_buildHubTaskText = EL_buildHubTaskText;
    window.EL_buildMetaBlock = EL_buildMetaBlock;
    window.EL_buildPromptMessage = EL_buildPromptMessage;
    window.EL_collectHistoryText = EL_collectHistoryText;
    window.EL_resolveCustomText = EL_resolveCustomText;
    window.EL_resolvePromptRole = EL_resolvePromptRole;
    window.EL_resolvePromptPosition = EL_resolvePromptPosition;
    window.EL_hubAllowedActions = EL_hubAllowedActions;
    window.EL_buildStaticContextBlock = EL_buildStaticContextBlock;
    window.EL_parseHubProposals = EL_parseHubProposals;
    window.EL_runHubAgent = EL_runHubAgent;
    window.EL_commitHubProposals = EL_commitHubProposals;
    window.EL_canonicalHubChatId = EL_canonicalHubChatId;
    window.EL_applyProposal = EL_applyProposal;
    window.EL_reviseHubProposal = EL_reviseHubProposal;
    window.EL_extractJsonObject = EL_extractJsonObject;
    window.EL_recoverStagedHubProposals = EL_recoverStagedHubProposals;
    window.EL_sanitizeHubProposal = EL_sanitizeHubProposal;
    window.EL_PROPOSAL_CONTRACT = EL_PROPOSAL_CONTRACT;
    window.EL_postToHost = EL_postToHost;
    window.EL_bridgeRequest = EL_bridgeRequest;
    window.EL_requestChatBooks = EL_requestChatBooks;
}
