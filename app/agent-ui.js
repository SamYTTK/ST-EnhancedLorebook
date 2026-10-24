let currentChatId = null;
let proposals = [];
let activeFilter = 'all';
let activeAgentFilter = 'all';
// Feed scope: 'chat' (current chat only) or 'all' (every chat file — finds
// proposals saved under a different chatId).
let feedScope = 'chat';
let chatPollInterval = null;
let backupClient = null;
let activeAgentId = null;
let pendingInjectedContext = [];
let pendingConditionals = [];
let pendingDefaultRule = { injectedContext: [], taskOverride: '', instructionsOverride: '' };
let pickerRuleTarget = null; // rule/default object whose injectedContext the picker edits
let pendingPicker = { lorebooks: [], search: '', selected: new Map(), expanded: new Set() };
// Dynamic links state. pickerMode: 'static' (always-inject picks) | 'link'
// (whole-book dynamic links) | 'pin' (always-inject pins inside one book).
let pendingDynamicLinks = [];
let pickerMode = 'static';
let pinTargetBook = null;
if (typeof escapeHtml !== 'function' && typeof window !== 'undefined' && typeof window.escapeHtml !== 'function') {
    // fallback for renderSecretsList when app.js escapeHtml not yet loaded
    if (typeof window !== 'undefined') window.escapeHtml = function(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
}
function _escapeHtml(s){ try{ if(typeof escapeHtml==='function') return escapeHtml(s); if(typeof window!=='undefined' && typeof window.escapeHtml==='function') return window.escapeHtml(s);}catch{} return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function getChatId() {
    // Delegates to the single source of truth in hub-client.js. It drifted once
    // already (chat.chat_id first here vs chatId first there), which made the
    // feed and the run disagree about the chat key and show nothing.
    return EL_canonicalHubChatId();
}

async function initAgentUI(context) {
    // Wire buttons FIRST so the UI is never dead even if later init steps fail.
    try { wireConfigEvents(); } catch (e) { try { console.error('Enhanced Lorebook: wireConfigEvents failed', e); } catch {} }
    try { wireFeedEvents(); } catch {}
    try { wireDashboardEvents(); } catch {}
    try { initTerminalPanel(); } catch {}

    try {
        if (typeof BackupClient !== 'undefined') backupClient = new BackupClient(context || {});
    } catch {}

    try { renderHubStatus(); } catch {}
    try { renderTokenDocs(); } catch {}
    loadSettingsToConfig();
    try { await refreshHubDropdowns(); } catch {}
    wireConfigEvents();
    wireFeedEvents();
    try { if (typeof initAgentChatPanel === 'function') initAgentChatPanel(); } catch {}
    try { if (typeof wireAgentChatUI === 'function') wireAgentChatUI(); } catch {}
    try { if (typeof renderAgentChat === 'function') renderAgentChat(); } catch {}

    currentChatId = getChatId();
    await loadProposalsForCurrentChat();

    if (chatPollInterval) clearInterval(chatPollInterval);
    chatPollInterval = setInterval(async () => {
        const newId = getChatId();
        if (newId !== currentChatId) {
            currentChatId = newId;
            await loadProposalsForCurrentChat();
            handleChatScopeChange();
        }
    }, 2000);

    window.addEventListener('message', onAppMessage);

    renderAgentSidebar();
    wireDashboardEvents();

    const chatIdEl = document.getElementById('agent-chat-id');
    if (chatIdEl) chatIdEl.textContent = 'Chat: ' + currentChatId;
}

function EL_quickOptsToContextOverride(opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const m = (o.messages && typeof o.messages === 'object') ? o.messages : {};
    const clampInt = (v, min, max, fb) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return fb;
        return Math.min(max, Math.max(min, Math.floor(n)));
    };
    const type = ['none', 'all', 'first', 'last', 'range'].includes(m.type) ? m.type : 'last';
    const r = (m.range && typeof m.range === 'object') ? m.range : {};
    const start = clampInt(r.start, 0, 100000, 0);
    let end = clampInt(r.end, 0, 100000, 10);
    if (end < start) end = start;
    const first = clampInt(m.first, 1, 500, 10);
    const last = clampInt(m.last, 1, 500, 10);
    const messages = (type === 'first')
        ? { mode: 'range', start: 0, end: Math.max(1, first) }
        : { mode: type, last, start, end };
    const excl = Array.isArray(o.excludeIds) ? o.excludeIds.map(Number).filter(n => Number.isInteger(n) && n >= 0).slice(0, 200) : [];
    if (excl.length) messages.excludeIds = excl;
    return {
        messages,
        sources: {
            charCard: { enabled: o.includeCharCard !== false },
            authorNote: { enabled: o.includeAuthorNote !== false },
            worldInfo: { enabled: o.includeWorldInfo !== false },
            injected: { enabled: o.includeInjected !== false },
        },
    };
}

function onAppMessage(e) {
    if (e.origin !== window.location.origin) return;
    // Source binding: only the host window may drive this popup. e.source is the
    // sender's WindowProxy and cannot be forged.
    const hostWin = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
    if (hostWin && hostWin !== window && e.source !== hostWin) return;
    const msg = e.data;
    if (!msg || typeof msg !== 'object' || msg.source !== 'enhanced-lorebook') return;
    try {
        if (typeof _elBridgeNonce !== 'undefined' && _elBridgeNonce !== null) {
            if (typeof msg.nonce === 'string' && msg.nonce) {
                _elBridgeNonce = msg.nonce;
            } else if (typeof _elBridgeNonceWarned !== 'undefined' && !_elBridgeNonceWarned) {
                _elBridgeNonceWarned = true;
                try { console.warn('[EL:Bridge] host message without nonce — accepted (older host build?)'); } catch (e) {}
            }
        }
    } catch (e) {}
    if (msg.type === 'el-agent-chat-changed') {
        const newId = getChatId();
        if (newId !== currentChatId) {
            currentChatId = newId;
            loadProposalsForCurrentChat();
            handleChatScopeChange();
        }
    }
    if (msg.type === 'el-agent-quick-task') {
        try { handleQuickTaskFromHost(msg); } catch (e) { console.error('Enhanced Lorebook: quick task handler failed', e); }
    }
}

// Quick tasks dispatched by the host window. The host re-sends the task until
// this window acknowledges receipt (it may have been opened moments ago and its
// listener not yet registered), so deliveries can arrive more than once — the
// seen-set makes handling idempotent.
const _elHandledQuickTaskIds = new Set();

async function handleQuickTaskFromHost(msg) {
    // Not ready yet: `agentManager` is created during app init(). Return WITHOUT
    // acknowledging so the host's retry loop delivers the task again once we are
    // ready, instead of the task being acked and then dropped.
    if (typeof agentManager === 'undefined' || !agentManager) return;
    const requestId = msg?.requestId || null;
    const task = String(msg?.task || '').trim();
    const postToHost = (payload) => {
        try {
            if (typeof EL_postToHost === 'function') {
                EL_postToHost(Object.assign({ requestId }, (payload || {})));
            }
        } catch (e) {}
    };
    const reply = (payload) => postToHost(Object.assign({ type: 'el-agent-quick-task-result' }, payload));
    // Acknowledge receipt first so the host stops re-sending, then ignore any
    // duplicate delivery of the same request.
    postToHost({ type: 'el-agent-quick-task-ack' });
    if (requestId) {
        if (_elHandledQuickTaskIds.has(requestId)) return;
        _elHandledQuickTaskIds.add(requestId);
        if (_elHandledQuickTaskIds.size > 100) {
            try { _elHandledQuickTaskIds.delete(_elHandledQuickTaskIds.values().next().value); } catch (e) {}
        }
    }
    if (!task) {
        reply({ ok: false, error: 'Task is empty.' });
        return;
    }
    if (typeof EL_runHubAgent !== 'function') {
        reply({ ok: false, error: 'Hub client not loaded.' });
        return;
    }
    const agent = (typeof agentManager !== 'undefined' && agentManager) ? agentManager.getAgent(msg.agentId) : null;
    if (!agent) {
        reply({ ok: false, error: 'Agent not found.' });
        return;
    }
    if (agent.enabled === false) {
        reply({ ok: false, error: 'Agent is disabled.' });
        return;
    }
    try {
        if (agentManager.isActiveForChat && !agentManager.isActiveForChat(agent, (typeof stContext !== 'undefined' && stContext) ? stContext : null)) {
            reply({ ok: false, error: 'Agent is bound to another chat.' });
            return;
        }
    } catch {}
    const agentId = msg.agentId;
    if (typeof _elHubRunningAgents !== 'undefined' && _elHubRunningAgents.has(agentId)) {
        reply({ ok: false, error: 'Agent is already running.' });
        return;
    }
    try {
        if (typeof _elHubRunningAgents !== 'undefined') _elHubRunningAgents.add(agentId);
    } catch {}
    try {
        const profileOverride = typeof msg?.opts?.profileId === 'string' ? msg.opts.profileId.trim() : '';
        const contextOverride = EL_quickOptsToContextOverride(msg.opts);
        const liveAgent = agent;
        const runAgentObj = profileOverride ? Object.assign({}, liveAgent, { apiProfile: profileOverride }) : liveAgent;
        const st = (typeof stContext !== 'undefined' && stContext) ? stContext : null;
        const result = await EL_runHubAgent(runAgentObj, {
            st,
            taskOverride: task,
            contextOverride,
            label: 'lorebook-quick:' + (agent.name || 'agent'),
            onStep: ({ step, toolCalls }) => {
                try { console.debug('Enhanced Lorebook quick-task step ' + step, (toolCalls || []).map(t => t?.function?.name || t?.name)); } catch {}
            },
            confirmTokenWarning: async (gate) => {
                try { return confirm('Agent context is ~' + Number(gate.total).toLocaleString() + ' tokens (threshold ' + Number(gate.threshold).toLocaleString() + '). Run anyway?'); } catch { return true; }
            },
        });
        reply({ ok: true, proposalsCreated: Number(result?.proposalsCreated || 0), warnings: Array.isArray(result?.warnings) ? result.warnings : [] });
        try { await loadProposalsForCurrentChat(); } catch {}
        try { renderDashboard(); } catch {}
    } catch (e) {
        reply({ ok: false, error: (e && e.message) ? e.message : String(e) });
    } finally {
        try { if (typeof _elHubRunningAgents !== 'undefined') _elHubRunningAgents.delete(agentId); } catch {}
    }
}

function handleChatScopeChange() {
    renderDashboard();
    renderAgentSidebar();
    if (typeof currentViewMode === 'string' && currentViewMode === 'agent-config' && activeAgentId) {
        const st = elResolveSt();
        const agent = typeof agentManager !== 'undefined' && agentManager ? agentManager.getAgent(activeAgentId) : null;
        if (agent && agentManager && typeof agentManager.isActiveForChat === 'function' && !agentManager.isActiveForChat(agent, st)) {
            switchToView('agent-dashboard');
        }
    }
}

function elResolveSt() {
    if (typeof stContext !== 'undefined' && stContext) return stContext;
    if (typeof ST_Window !== 'undefined' && ST_Window?.SillyTavern) return ST_Window.SillyTavern.getContext();
    return null;
}

function renderInjectedContextList(selections) {
    const list = document.getElementById('agent-injected-list');
    const countEl = document.getElementById('agent-injected-count');
    if (!list) return;
    list.innerHTML = '';
    const count = (selections || []).length;
    if (countEl) countEl.textContent = count ? `(${count} selection${count === 1 ? '' : 's'})` : '';
    for (const sel of (selections || [])) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:8px; background:rgba(0,0,0,0.2); padding:6px 10px; border-radius:4px;';
        const span = document.createElement('span');
        span.style.flex = '1';
        span.textContent = sel.all === true
            ? `"${sel.lorebook}" (entire lorebook)`
            : `"${sel.lorebook}" (${(sel.uids || []).length} entries)`;
        const rm = document.createElement('button');
        rm.className = 'btn btn-secondary btn-sm';
        rm.textContent = '✕';
        rm.addEventListener('click', () => removeInjectedSelection(sel));
        row.appendChild(span);
        row.appendChild(rm);
        list.appendChild(row);
    }
}

function removeInjectedSelection(sel) {
    pendingInjectedContext = (pendingInjectedContext || []).filter(s => !(
        s.lorebook === sel.lorebook &&
        s.all === sel.all &&
        JSON.stringify(s.uids || []) === JSON.stringify(sel.uids || [])
    ));
    renderInjectedContextList(pendingInjectedContext);
}

function cloneDynamicLinks(links) {
    try { return JSON.parse(JSON.stringify(Array.isArray(links) ? links : [])); }
    catch { return []; }
}

// ── Per-character rules (conditionals) ──────────────────────────
function elListCharacters() {
    try {
        const st = elResolveSt();
        const chars = st && Array.isArray(st.characters) ? st.characters : [];
        return chars.map((c, i) => ({ id: String(i), name: (c && c.name) || ('Character ' + (i + 1)) }));
    } catch { return []; }
}

function refreshRuleCharOptions() {
    const sel = document.getElementById('agent-rule-char');
    if (!sel) return;
    const chars = elListCharacters();
    const used = new Set((pendingConditionals || []).map(r => String(r.characterId)));
    sel.innerHTML = '';
    const avail = chars.filter(c => !used.has(c.id));
    if (!chars.length) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = '(open a chat first to list characters)';
        sel.appendChild(o);
        return;
    }
    if (!avail.length) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = '(all characters have rules)';
        sel.appendChild(o);
        return;
    }
    for (const c of avail) {
        const o = document.createElement('option');
        o.value = c.id; o.textContent = c.name;
        sel.appendChild(o);
    }
}

function rulePicksLabel(r) {
    const n = Array.isArray(r.injectedContext) ? r.injectedContext.length : 0;
    return n ? `${n} pick${n === 1 ? '' : 's'}` : 'no picks';
}

function renderRulesList() {
    const list = document.getElementById('agent-rules-list');
    const countEl = document.getElementById('agent-rules-count');
    if (countEl) countEl.textContent = pendingConditionals.length ? `(${pendingConditionals.length})` : '';
    refreshRuleCharOptions();
    updateDefaultPicksCount();
    if (!list) return;
    list.innerHTML = '';
    if (!pendingConditionals.length) {
        const d = document.createElement('div');
        d.style.cssText = 'opacity:0.6; font-size:0.85rem;';
        d.textContent = 'No per-character rules — every chat uses the agent defaults + fallback below.';
        list.appendChild(d);
        return;
    }
    pendingConditionals.forEach((r) => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'background:rgba(0,0,0,0.2); border-radius:6px; padding:8px 10px; display:flex; flex-direction:column; gap:6px;';
        const head = document.createElement('div');
        head.style.cssText = 'display:flex; align-items:center; gap:8px;';
        const en = document.createElement('input');
        en.type = 'checkbox'; en.checked = r.enabled !== false; en.title = 'Enabled';
        en.addEventListener('change', () => { r.enabled = en.checked; });
        const nm = document.createElement('strong');
        nm.style.flex = '1';
        nm.textContent = r.characterName || ('Character ' + r.characterId);
        const picks = document.createElement('span');
        picks.style.cssText = 'opacity:0.7; font-size:0.82rem;';
        picks.textContent = rulePicksLabel(r);
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-secondary btn-sm';
        editBtn.textContent = 'Edit picks';
        editBtn.addEventListener('click', (e) => { e.preventDefault(); pickerRuleTarget = r; openInjectedPicker('rule'); });
        const del = document.createElement('button');
        del.className = 'btn btn-secondary btn-sm';
        del.textContent = '✕';
        del.title = 'Delete rule';
        del.addEventListener('click', () => {
            pendingConditionals = pendingConditionals.filter(x => x !== r);
            renderRulesList();
        });
        head.appendChild(en); head.appendChild(nm); head.appendChild(picks); head.appendChild(editBtn); head.appendChild(del);
        const det = document.createElement('details');
        const sum = document.createElement('summary');
        sum.style.cssText = 'cursor:pointer; font-size:0.82rem; opacity:0.8;';
        sum.textContent = 'Task / instructions overrides';
        const task = document.createElement('textarea');
        task.placeholder = 'Task override (empty = agent task)';
        task.value = r.taskOverride || '';
        task.style.cssText = 'width:100%; min-height:36px; margin-top:6px; background:rgba(0,0,0,0.3); border:1px solid var(--panel-border); color:var(--text-color); padding:6px 8px; border-radius:6px; font-size:0.82rem;';
        task.addEventListener('input', () => { r.taskOverride = task.value; });
        const inst = document.createElement('textarea');
        inst.placeholder = 'Instructions override (empty = agent instructions)';
        inst.value = r.instructionsOverride || '';
        inst.style.cssText = task.style.cssText;
        inst.addEventListener('input', () => { r.instructionsOverride = inst.value; });
        det.appendChild(sum); det.appendChild(task); det.appendChild(inst);
        wrap.appendChild(head); wrap.appendChild(det);
        list.appendChild(wrap);
    });
}

function addConditionalRule() {
    const sel = document.getElementById('agent-rule-char');
    const cid = sel ? (sel.value || '') : '';
    if (!cid) {
        if (typeof showToast === 'function') showToast('Pick a character first');
        return;
    }
    const cname = sel.options && sel.selectedIndex >= 0 ? (sel.options[sel.selectedIndex].textContent || '') : '';
    if ((pendingConditionals || []).some(r => String(r.characterId) === String(cid))) {
        if (typeof showToast === 'function') showToast('That character already has a rule');
        return;
    }
    pendingConditionals.push({ characterId: String(cid), characterName: cname, enabled: true, injectedContext: [], taskOverride: '', instructionsOverride: '' });
    renderRulesList();
}

function updateDefaultPicksCount() {
    const el = document.getElementById('agent-default-picks-count');
    if (el) el.textContent = String(Array.isArray(pendingDefaultRule.injectedContext) ? pendingDefaultRule.injectedContext.length : 0);
}

function loadRulesToConfig(src) {
    const s = src || {};
    let rules = [];
    try { rules = JSON.parse(JSON.stringify(Array.isArray(s.conditionals) ? s.conditionals : [])); } catch { rules = []; }
    pendingConditionals = rules
        .filter(r => r && r.characterId !== undefined && r.characterId !== null && String(r.characterId) !== '')
        .map(r => ({
            characterId: String(r.characterId),
            characterName: typeof r.characterName === 'string' ? r.characterName : '',
            enabled: r.enabled !== false,
            injectedContext: Array.isArray(r.injectedContext) ? r.injectedContext : [],
            taskOverride: typeof r.taskOverride === 'string' ? r.taskOverride : '',
            instructionsOverride: typeof r.instructionsOverride === 'string' ? r.instructionsOverride : '',
        }));
    const dr = (s.defaultRule && typeof s.defaultRule === 'object') ? s.defaultRule : {};
    let drPicks = [];
    try { drPicks = JSON.parse(JSON.stringify(Array.isArray(dr.injectedContext) ? dr.injectedContext : [])); } catch { drPicks = []; }
    pendingDefaultRule = {
        injectedContext: drPicks,
        taskOverride: typeof dr.taskOverride === 'string' ? dr.taskOverride : '',
        instructionsOverride: typeof dr.instructionsOverride === 'string' ? dr.instructionsOverride : '',
    };
    setVal('agent-default-task', pendingDefaultRule.taskOverride);
    setVal('agent-default-instructions', pendingDefaultRule.instructionsOverride);
    setChecked('agent-notify-no-match', s.notifyNoMatch === true);
    renderRulesList();
}

function renderDynamicLinksList() {
    const list = document.getElementById('agent-dynamic-list');
    const countEl = document.getElementById('agent-dynamic-count');
    if (!list) return;
    list.innerHTML = '';
    const links = pendingDynamicLinks || [];
    if (countEl) countEl.textContent = links.length ? `(${links.length} link${links.length === 1 ? '' : 's'})` : '';
    if (!links.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'opacity:0.6; font-size:12px;';
        empty.textContent = 'No linked lorebooks. Link one to enable keyword-activated injection.';
        list.appendChild(empty);
        return;
    }
    for (const link of links) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:8px; background:rgba(0,0,0,0.2); padding:6px 10px; border-radius:4px;';
        const span = document.createElement('span');
        span.style.flex = '1';
        const pins = Array.isArray(link.pinUids) ? link.pinUids.length : 0;
        span.textContent = `"${link.name}" (dynamic scan${pins ? `, ${pins} pinned` : ''})`;
        const pinBtn = document.createElement('button');
        pinBtn.className = 'btn btn-secondary btn-sm';
        pinBtn.textContent = pins ? `Pins (${pins})` : 'Pin entries';
        pinBtn.title = 'Choose entries that are always injected, even without keyword hits';
        pinBtn.addEventListener('click', () => openInjectedPicker('pin', link.name));
        const rm = document.createElement('button');
        rm.className = 'btn btn-secondary btn-sm';
        rm.textContent = '✕';
        rm.title = 'Remove link';
        rm.addEventListener('click', () => {
            pendingDynamicLinks = (pendingDynamicLinks || []).filter(l => l.name !== link.name);
            renderDynamicLinksList();
        });
        row.appendChild(span);
        row.appendChild(pinBtn);
        row.appendChild(rm);
        list.appendChild(row);
    }
}

function setPickerLabels() {
    const titleEl = document.querySelector('#injected-picker-modal h3');
    const confirmBtn = document.getElementById('btn-injected-confirm');
    const searchEl = document.getElementById('injected-picker-search');
    const setTitle = (t) => { if (titleEl) titleEl.innerHTML = '<i class="fa-solid fa-book" style="margin-right: 8px;"></i>' + _escapeHtml(t); };
    const setConfirm = (t) => { if (confirmBtn) confirmBtn.innerHTML = '<i class="fa-solid fa-check"></i> ' + _escapeHtml(t); };
    if (pickerMode === 'link') {
        setTitle('Link Lorebooks (dynamic scan)');
        setConfirm('Link Selected');
        if (searchEl) searchEl.placeholder = 'Filter lorebooks by name...';
    } else if (pickerMode === 'rule') {
        setTitle('Rule Injected Picks (always injected for this character)');
        setConfirm('Save Picks');
        if (searchEl) searchEl.placeholder = 'Search entries by key, comment, or content...';
    } else if (pickerMode === 'pin') {
        setTitle(`Pin Entries — "${pinTargetBook || ''}" (always injected)`);
        setConfirm('Save Pins');
        if (searchEl) searchEl.placeholder = 'Search entries by key, comment, or content...';
    } else {
        setTitle('Add Injected Context');
        setConfirm('Add Selected');
        if (searchEl) searchEl.placeholder = 'Search entries by key, comment, or content...';
    }
}

function showModalEl(modal) {
    if (!modal) return;
    if (typeof EL_modalOpen === 'function') { EL_modalOpen(modal); return; }
    try { modal.style.display = ''; } catch {}
    modal.classList.add('active');
}

function hideModalEl(modal) {
    if (!modal) return;
    if (typeof EL_modalClose === 'function') { EL_modalClose(modal); return; }
    modal.classList.remove('active');
    try { modal.style.display = ''; } catch {}
}

async function openInjectedPicker(mode, bookName) {
    pickerMode = (mode === 'link' || mode === 'pin' || mode === 'rule') ? mode : 'static';
    pinTargetBook = pickerMode === 'pin' ? (bookName || null) : null;
    const modal = document.getElementById('injected-picker-modal');
    if (!modal) {
        try { console.error('Enhanced Lorebook: injected-picker-modal element missing'); } catch {}
        return;
    }

    // Show modal immediately so the button always gives feedback,
    // then load lorebooks async with a loading state.
    const containerPre = document.getElementById('injected-picker-lorebooks');
    if (containerPre) containerPre.innerHTML = '<div style="opacity:0.7; padding:12px;">Loading lorebooks…</div>';
    const countPre = document.getElementById('injected-picker-count');
    if (countPre) countPre.textContent = '';
    try { setPickerLabels(); } catch {}
    showModalEl(modal);

    const st = elResolveSt();
    if (!st || typeof st.getWorldInfoNames !== 'function') {
        if (containerPre) containerPre.innerHTML = '<div style="padding:12px; color:#ef4444;">Lorebook access unavailable in this context. Open this app from SillyTavern (World Info → Enhanced Lorebook), not as a standalone tab.</div>';
        try { if (typeof showToast === 'function') showToast('Lorebook access unavailable in this context'); } catch {}
        try { console.error('Enhanced Lorebook: elResolveSt failed', { hasSt: !!st }); } catch {}
        return;
    }

    // Seed selections per mode so reopening the picker shows current state.
    const keepSelected = new Map();
    try {
        if (pickerMode === 'rule' && pickerRuleTarget && Array.isArray(pickerRuleTarget.injectedContext)) {
            for (const s of pickerRuleTarget.injectedContext) {
                if (!s || !s.lorebook) continue;
                if (s.all === true) keepSelected.set(s.lorebook, { all: true, uids: new Set() });
                else if (Array.isArray(s.uids) && s.uids.length) keepSelected.set(s.lorebook, { all: false, uids: new Set(s.uids) });
            }
        } else if (pickerMode === 'link') {
            for (const l of (pendingDynamicLinks || [])) {
                if (l && l.name) keepSelected.set(l.name, { all: true, uids: new Set() });
            }
        } else if (pickerMode === 'pin' && pinTargetBook) {
            const link = (pendingDynamicLinks || []).find(l => l.name === pinTargetBook);
            const pins = link && Array.isArray(link.pinUids) ? link.pinUids : [];
            if (pins.length) keepSelected.set(pinTargetBook, { all: false, uids: new Set(pins) });
        } else {
            for (const s of (pendingInjectedContext || [])) {
                if (!s || !s.lorebook) continue;
                if (s.all === true) keepSelected.set(s.lorebook, { all: true, uids: new Set() });
                else if (Array.isArray(s.uids) && s.uids.length) keepSelected.set(s.lorebook, { all: false, uids: new Set(s.uids) });
            }
        }
    } catch {}
    pendingPicker = { lorebooks: [], search: '', selected: keepSelected, expanded: new Set() };
    const searchEl = document.getElementById('injected-picker-search');
    if (searchEl) searchEl.value = '';

    let names = st.getWorldInfoNames() || [];
    if (pickerMode === 'pin' && pinTargetBook) names = names.filter(n => n === pinTargetBook);
    for (const name of names) {
        try {
            const data = await st.loadWorldInfo(name);
            const entries = data && data.entries ? Object.entries(data.entries).map(([uid, e]) => ({
                uid: parseInt(uid),
                keys: e.key || [],
                comment: e.comment || '',
                content: (e.content || '').slice(0, 120),
            })) : [];
            entries.sort((a, b) => (a.uid || 0) - (b.uid || 0));
            pendingPicker.lorebooks.push({ name, entries });
            // Hydrate "all" uid sets so counts stay accurate.
            const ks = pendingPicker.selected.get(name);
            if (ks && ks.all) ks.uids = new Set(entries.map(e => e.uid));
        } catch (_) {
            pendingPicker.lorebooks.push({ name, entries: [] });
        }
    }
    // Auto-expand: all books when few, else books that already have selections.
    if (pendingPicker.lorebooks.length <= 3) {
        for (const lb of pendingPicker.lorebooks) pendingPicker.expanded.add(lb.name);
    } else {
        for (const name of pendingPicker.selected.keys()) pendingPicker.expanded.add(name);
        if (pendingPicker.expanded.size === 0 && pendingPicker.lorebooks.length) {
            pendingPicker.expanded.add(pendingPicker.lorebooks[0].name);
        }
    }

    renderInjectedPicker();
    showModalEl(modal);
}

function closeInjectedPicker() {
    hideModalEl(document.getElementById('injected-picker-modal'));
}

function renderInjectedPicker() {
    const container = document.getElementById('injected-picker-lorebooks');
    const searchEl = document.getElementById('injected-picker-search');
    if (!container) return;
    const search = (searchEl?.value || '').trim().toLowerCase();

    container.innerHTML = '';

    let totalSelected = 0;
    const getSel = (name) => pendingPicker.selected.get(name) || { all: false, uids: new Set() };
    const getOrCreateSel = (name) => {
        let s = pendingPicker.selected.get(name);
        if (!s) {
            s = { all: false, uids: new Set() };
            pendingPicker.selected.set(name, s);
        }
        return s;
    };
    if (!pendingPicker.lorebooks.length) {
        container.innerHTML = '<div style="opacity:0.7; padding:12px;">No lorebooks found. Create one in SillyTavern first.</div>';
        const countEl0 = document.getElementById('injected-picker-count');
        if (countEl0) countEl0.textContent = '';
        return;
    }
    for (const lb of pendingPicker.lorebooks) {
        const sel = getSel(lb.name);

        // Link mode: whole-book selection only — no entry rows.
        if (pickerMode === 'link') {
            if (search && !lb.name.toLowerCase().includes(search)) continue;
            const header = document.createElement('label');
            header.style.cssText = 'display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid var(--panel-border); cursor:pointer;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = pendingPicker.selected.has(lb.name);
            cb.addEventListener('change', function () {
                if (this.checked) pendingPicker.selected.set(lb.name, { all: true, uids: new Set(lb.entries.map(e => e.uid)) });
                else pendingPicker.selected.delete(lb.name);
                renderInjectedPicker();
            });
            const title = document.createElement('strong');
            title.style.flex = '1';
            title.textContent = `${lb.name} (${lb.entries.length} entries)`;
            header.appendChild(cb);
            header.appendChild(title);
            container.appendChild(header);
            if (pendingPicker.selected.has(lb.name)) totalSelected += 1;
            continue;
        }

        const filtered = search
            ? lb.entries.filter(e =>
                e.keys.join(' ').toLowerCase().includes(search) ||
                (e.comment || '').toLowerCase().includes(search) ||
                (e.content || '').toLowerCase().includes(search))
            : lb.entries;

        if (search && filtered.length === 0) continue;

        const header = document.createElement('div');
        header.style.cssText = 'display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid var(--panel-border);';
        const chevron = document.createElement('span');
        chevron.style.cssText = 'cursor:pointer; width:18px; text-align:center;';
        chevron.textContent = pendingPicker.expanded.has(lb.name) ? '▾' : '▸';
        chevron.addEventListener('click', function () {
            if (pendingPicker.expanded.has(lb.name)) {
                pendingPicker.expanded.delete(lb.name);
            } else {
                pendingPicker.expanded.add(lb.name);
            }
            renderInjectedPicker();
        });
        const title = document.createElement('strong');
        title.style.flex = '1';
        title.textContent = `${lb.name} (${lb.entries.length} entries)`;
        const allBtn = document.createElement('button');
        allBtn.className = 'btn btn-secondary btn-sm';
        allBtn.textContent = 'All';
        allBtn.addEventListener('click', function () {
            pendingPicker.selected.set(lb.name, { all: true, uids: new Set(lb.entries.map(e => e.uid)) });
            renderInjectedPicker();
        });
        const noneBtn = document.createElement('button');
        noneBtn.className = 'btn btn-secondary btn-sm';
        noneBtn.textContent = 'None';
        noneBtn.addEventListener('click', function () {
            pendingPicker.selected.delete(lb.name);
            renderInjectedPicker();
        });
        header.appendChild(chevron);
        header.appendChild(title);
        header.appendChild(allBtn);
        header.appendChild(noneBtn);
        container.appendChild(header);

        const countForLb = sel.all ? lb.entries.length : sel.uids.size;
        totalSelected += countForLb;

        // When searching, auto-expand matching books so results are visible.
        const isExpanded = pendingPicker.expanded.has(lb.name) || !!search;
        if (pendingPicker.expanded.has(lb.name)) {
            // keep explicit state
        } else if (search) {
            // transient expand for search only (do not mutate set)
        }
        if (isExpanded) {
            for (const e of filtered) {
                const row = document.createElement('label');
                row.style.cssText = 'display:flex; align-items:flex-start; gap:8px; padding:4px 0 4px 26px; cursor:pointer;';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = sel.all || sel.uids.has(e.uid);
                cb.addEventListener('change', function () {
                    if (this.checked) {
                        const s = getOrCreateSel(lb.name);
                        if (s.all) {
                            // already covers all; nothing to add
                        } else {
                            s.uids.add(e.uid);
                            // promote to all when every entry is now checked
                            if (lb.entries.length > 0 && s.uids.size >= lb.entries.length) {
                                s.all = true;
                            }
                        }
                    } else {
                        const s = pendingPicker.selected.get(lb.name);
                        if (!s) {
                            renderInjectedPicker();
                            return;
                        }
                        if (s.all) {
                            // split "all" into explicit set minus the unchecked uid
                            s.all = false;
                            s.uids = new Set(lb.entries.map(x => x.uid));
                        }
                        s.uids.delete(e.uid);
                        if (s.uids.size === 0 && !s.all) {
                            pendingPicker.selected.delete(lb.name);
                        }
                    }
                    renderInjectedPicker();
                });
                const text = document.createElement('span');
                text.textContent = `UID ${e.uid}: keys=[${e.keys.join(', ')}] comment="${e.comment}" ${e.content ? 'content="' + e.content + '"' : ''}`;
                row.appendChild(cb);
                row.appendChild(text);
                container.appendChild(row);
            }
        }
    }

    const countEl = document.getElementById('injected-picker-count');
    if (countEl) {
        if (pickerMode === 'link') countEl.textContent = totalSelected > 0 ? `${totalSelected} linked` : '';
        else countEl.textContent = totalSelected > 0 ? `${totalSelected} selected` : '';
    }
}

function EL_dynToast(msg, type) {
    EL_toast(msg, type || 'info');
}

/**
 * "Sync with Chat": merge the current chat's active lorebooks
 * (global + chat-bound + character) into the agent's dynamic links.
 * Merge, never overwrite — existing links (and their pins) are kept.
 */
async function syncChatBooks() {
    if (typeof EL_requestChatBooks !== 'function') {
        EL_dynToast('Chat sync unavailable (bridge helper missing)', 'error');
        return;
    }
    EL_dynToast('Reading chat lorebooks…', 'info');
    let res;
    try { res = await EL_requestChatBooks(15000); }
    catch (e) { EL_dynToast('Chat sync failed: ' + (e?.message || e), 'error'); return; }
    const names = [];
    for (const n of (res?.globalBooks || [])) if (n && !names.includes(n)) names.push(n);
    if (res?.chatLorebook && !names.includes(res.chatLorebook)) names.push(res.chatLorebook);
    for (const n of (res?.characterLorebooks || [])) if (n && !names.includes(n)) names.push(n);
    if (res?.embeddedBook && !names.includes(res.embeddedBook)) names.push(res.embeddedBook);
    if (!names.length) {
        EL_dynToast('No active lorebooks on the current chat to sync', 'warning');
        return;
    }
    const have = new Set((pendingDynamicLinks || []).map(l => l.name));
    let added = 0;
    for (const n of names) {
        if (have.has(n)) continue;
        pendingDynamicLinks.push({ name: n, pinUids: [] });
        have.add(n);
        added++;
    }
    renderDynamicLinksList();
    EL_dynToast(added ? `Synced ${added} lorebook${added === 1 ? '' : 's'} from chat (${names.length - added} already linked)` : 'All chat lorebooks already linked', added ? 'success' : 'info');
}

/**
 * "Preview Matches": dry-run the dynamic scan with the current form state
 * (links + task/instructions + live chat) and render the result inline.
 * Uses the exact same host-side scan path as real runs.
 */
async function previewDynamicScan() {
    const box = document.getElementById('dynamic-preview');
    const links = pendingDynamicLinks || [];
    if (!links.length) {
        EL_dynToast('Link a lorebook first, then preview', 'warning');
        return;
    }
    if (box) {
        box.style.display = 'block';
        box.textContent = 'Loading linked lorebooks…';
    }
    const st = elResolveSt();
    if (!st) {
        if (box) box.textContent = 'Preview failed: SillyTavern context unavailable.';
        return;
    }
    const lines = [];
    for (const l of links) {
        const name = l?.name;
        if (!name) continue;
        try {
            const data = await st.loadWorldInfo(name);
            const entries = data && data.entries ? data.entries : {};
            const uids = Object.keys(entries);
            const pins = Array.isArray(l.pinUids) ? l.pinUids.length : 0;
            lines.push(`${name}: ${uids.length} entries${pins ? ` (${pins} pinned)` : ''}`);
            for (const uid of uids.slice(0, 10)) {
                const e = entries[uid] || {};
                const keys = Array.isArray(e.key) ? e.key.slice(0, 6).join(', ') : '';
                lines.push(`  UID ${uid} keys=[${keys}] "${(e.comment || '').slice(0, 80)}"`);
            }
            if (uids.length > 10) lines.push(`  …and ${uids.length - 10} more (agent tools inspect the rest at run time)`);
        } catch (e) {
            lines.push(`${name}: could not load (${e?.message || e})`);
        }
    }
    if (box) box.textContent = lines.join('\n');
}

// ── Hub status + dropdowns (ST-RequestHub) ──

function renderHubStatus() {
    const el = document.getElementById('agent-hub-status');
    if (!el) return;
    let status = { ok: false, detail: 'Hub client not loaded.' };
    try {
        if (typeof EL_hubStatus === 'function') status = EL_hubStatus();
    } catch (e) { status = { ok: false, detail: String(e?.message || e) }; }
    if (status.ok) {
        el.style.borderLeft = '3px solid var(--success-color,#10b981)';
        el.innerHTML = `<b>Hub:</b> connected${status.version ? ` (v${_escapeHtml(status.version)}, api v${status.apiVersion})` : ''}. Runs execute via ST-RequestHub; replies land in the Feed for review.`;
    } else {
        el.style.borderLeft = '3px solid var(--danger-color,#ef4444)';
        el.innerHTML = `<b>Hub unavailable:</b> ${_escapeHtml(status.detail || 'unknown')}<br>Runs are disabled until ST-RequestHub is installed and enabled. Lorebook editing is unaffected.`;
    }
    const runBtn = document.getElementById('btn-run-agent-now');
    if (runBtn) runBtn.disabled = !status.ok;
}

async function refreshHubDropdowns() {
    const hub = (typeof EL_getHub === 'function') ? EL_getHub() : null;
    const profSel = document.getElementById('agent-hub-profile');
    if (profSel) {
        const cur = profSel.value;
        profSel.innerHTML = '<option value="">-- Hub default / ST backend --</option>';
        try {
            const profiles = (hub && typeof hub.listApiProfiles === 'function') ? hub.listApiProfiles() : [];
            for (const p of (profiles || [])) {
                if (!p || !p.name) continue;
                const opt = document.createElement('option');
                opt.value = p.name;
                opt.textContent = `${p.name}${p.model ? ` (${p.model})` : ''}${p.isDefault ? ' [default]' : ''}`;
                profSel.appendChild(opt);
            }
        } catch {}
        if (cur) {
            try { profSel.value = cur; } catch {}
        }
    }
    const presetSel = document.getElementById('agent-hub-preset');
    if (presetSel) {
        const cur = presetSel.value;
        presetSel.innerHTML = '<option value="">-- None --</option>';
        try {
            const presets = (hub && typeof hub.listPresets === 'function') ? hub.listPresets() : [];
            for (const name of (presets || [])) {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                presetSel.appendChild(opt);
            }
        } catch {}
        if (cur) {
            try { presetSel.value = cur; } catch {}
        }
    }
    try {
        const cfgId = document.getElementById('agent-config-id')?.value || activeAgentId || null;
        const agent = (typeof agentManager !== 'undefined' && agentManager && cfgId) ? agentManager.getAgent(cfgId) : null;
        if (agent) {
            if (profSel && agent.apiProfile) { try { profSel.value = agent.apiProfile; } catch {} }
            if (presetSel && agent.preset) { try { presetSel.value = agent.preset; } catch {} }
        }
    } catch {}
}

function toggleHubAgentConfig(isAgent) {
    const el = document.getElementById('agent-hub-agent-config');
    if (el) el.style.display = isAgent ? 'flex' : 'none';
}

// Legacy stubs (kept so nothing crashes if called from stale code paths).
function loadToolPermissionCheckboxes() {}
function syncToolPermCheckboxes() {}

// Legacy vault UI — REMOVED. Secrets now live as hub API profiles in
// ST-RequestHub settings. Stubs kept so stale callers fail soft.
async function refreshSecretsList() {}
function populateAgentSecretSelect() {}
function renderSecretsList() {}
function wireSecretsEvents() {}

function renderTokenDocs() {
    const el = document.getElementById('agent-token-docs');
    if (!el) return;
    el.textContent = [
        '{"proposals":[{',
        '  "action": "create" | "edit" | "delete",',
        '  "lorebookName": "My Lorebook",',
        '  "uid": 123,                       // edit/delete only',
        '  "entryData": {                    // create only',
        '    "comment": "Entry title",',
        '    "key": ["key1", "key2"],',
        '    "content": "Full entry text…"',
        '  },',
        '  "changes": {"content": "…"},      // edit only: {field: new value}',
        '  "reasoning": "why this change",',
        '  "confidence": 0.9',
        '}]}',
        '',
        'Empty result: {"proposals":[]}. Only linked lorebooks are accepted;',
        'anything else is rejected with a warning and never written.',
    ].join('\n');
}

async function openAgentConfig(agentId) {
    activeAgentId = agentId;
    try { if (typeof _chatActiveAgentId !== 'undefined') _chatActiveAgentId = agentId; } catch {}
    const idEl = document.getElementById('agent-config-id');
    if (idEl) idEl.value = agentId || '';

    if (typeof agentManager === 'undefined' || !agentManager) {
        loadSettingsToConfig();
        return;
    }

    const agent = agentManager.getAgent(agentId);
    if (!agent) {
        loadSettingsToConfig();
        return;
    }

    const nameDisplay = document.getElementById('agent-config-name-display');
    if (nameDisplay) nameDisplay.textContent = agent.name || 'Unnamed';

    setVal('agent-config-name', agent.name || '');
    setChecked('agent-enabled', agent.enabled !== false);
    setVal('agent-task-description', agent.taskDescription || '');
    setVal('agent-custom-instructions', agent.customInstructions || '');

    const pr = (agent.prompt && typeof agent.prompt === 'object') ? agent.prompt : {};
    setVal('agent-prompt-role', ['system', 'user', 'assistant'].includes(pr.role) ? pr.role : 'system');
    setVal('agent-prompt-position', pr.position === 'after' ? 'after' : 'before');
    setVal('agent-prompt-custom', typeof pr.custom === 'string' ? pr.custom : '');

    const scope = agent.toolScope || {};
    setChecked('agent-scope-create', scope.allowCreate !== false);
    setChecked('agent-scope-edit', scope.allowEdit !== false);
    setChecked('agent-scope-delete', scope.allowDelete === true);
    setChecked('agent-perm-auto-accept', agent.autoAccept === true);

    const mode = agent.mode === 'periodic' ? 'periodic' : 'manual';
    const modeRadio = document.querySelector('input[name="agent-mode"][value="' + mode + '"]');
    if (modeRadio) modeRadio.checked = true;
    togglePeriodicConfig(mode === 'periodic');
    setVal('agent-periodic-interval', agent.interval ?? agent.periodicInterval ?? 10);

    // Hub request config
    const hubMode = agent.hubMode === 'single' ? 'single' : 'agent';
    const hubRadio = document.querySelector('input[name="agent-hubmode"][value="' + hubMode + '"]');
    if (hubRadio) hubRadio.checked = true;
    toggleHubAgentConfig(hubMode === 'agent');
    setVal('agent-hub-maxsteps', agent.maxSteps ?? 10);
    setVal('agent-hub-total-timeout', agent.totalTimeoutMs ?? 600000);

    // Model & sampling (dropdown options refresh async; re-apply after)
    try { await refreshHubDropdowns(); } catch {}
    setVal('agent-hub-profile', agent.apiProfile || '');
    setVal('agent-hub-preset', agent.preset || '');
    setVal('agent-hub-model', agent.model || '');
    setChecked('agent-hub-own-config', agent.useOwnConfig === true);
    const samplers = agent.samplers || {};
    setVal('agent-hub-temperature', samplers.temperature ?? 0.7);
    const hubTempVal = document.getElementById('agent-hub-temp-value');
    if (hubTempVal) hubTempVal.textContent = samplers.temperature ?? 0.7;
    setVal('agent-hub-top-p', samplers.top_p ?? '');
    setVal('agent-hub-seed', samplers.seed ?? '');
    setVal('agent-hub-max-tokens', agent.maxTokens ?? 1024);
    setVal('agent-hub-timeout', agent.timeoutMs ?? 90000);
    setVal('agent-hub-retries', agent.retries ?? 1);
    try { renderHubStatus(); } catch {}

    if (Array.isArray(agent.hubMigrateNotes) && agent.hubMigrateNotes.length && !agent._hubNotesShown) {
        agent._hubNotesShown = true;
        if (typeof showToast === 'function') showToast('Migrated to Hub v2: ' + agent.hubMigrateNotes[0]);
    }

    setVal('agent-guard-max-entries', agent.maxEntriesPerRun ?? 5);
    setVal('agent-guard-key-confidence', agent.requireKeyConfidence || 'low');
    setVal('agent-guard-max-pending', agent.maxPendingProposals ?? 20);
    setChecked('agent-guard-require-confirmation', agent.requireConfirmation !== false);
    setVal('agent-limit-chars', agent.maxCharsPerEntry ?? 8000);

    // Unified context section (drives ALL run types). The message/source
    // controls below used to be one-shot-only quickDefaults; they now edit
    // agent.context, with quickDefaults kept as a deprecated mirror on save.
    loadContextToConfig(agent);
    toggleQuickMsgRows();

    setVal('agent-confidence-threshold', agent.autoAcceptConfidence ?? 0.8);
    const confVal = document.getElementById('agent-confidence-value');
    if (confVal) confVal.textContent = agent.autoAcceptConfidence ?? 0.8;
    toggleAutoAcceptConfig(agent.autoAccept === true);

    try { renderTokenDocs(); } catch {}

    pendingInjectedContext = Array.isArray(agent.injectedContext) ? JSON.parse(JSON.stringify(agent.injectedContext)) : [];
    renderInjectedContextList(pendingInjectedContext);

    pendingDynamicLinks = cloneDynamicLinks(agent.dynamicLinks);
    renderDynamicLinksList();

    try { loadRulesToConfig(agent); } catch {}

    renderDashboard();
    renderAgentSidebar();
}

function renderAgentConfig(agentId) {
    openAgentConfig(agentId);
}

function loadSettingsToConfig() {
    const settings = (typeof extensionSettings !== 'undefined' && extensionSettings?.agent) ||
                     (typeof extensionSettings !== 'undefined' && extensionSettings?.agents?.[0]) || {};

    const nameDisplay = document.getElementById('agent-config-name-display');
    if (nameDisplay) nameDisplay.textContent = settings.name || 'Agent';

    setVal('agent-config-name', settings.name || '');
    setChecked('agent-enabled', settings.enabled !== false);
    setVal('agent-task-description', settings.taskDescription || '');
    setVal('agent-custom-instructions', settings.customInstructions || '');

    const spr = (settings.prompt && typeof settings.prompt === 'object') ? settings.prompt : {};
    setVal('agent-prompt-role', ['system', 'user', 'assistant'].includes(spr.role) ? spr.role : 'system');
    setVal('agent-prompt-position', spr.position === 'after' ? 'after' : 'before');
    setVal('agent-prompt-custom', typeof spr.custom === 'string' ? spr.custom : '');

    const stp = settings.toolScope || {};
    setChecked('agent-scope-create', stp.allowCreate !== false);
    setChecked('agent-scope-edit', stp.allowEdit !== false);
    setChecked('agent-scope-delete', stp.allowDelete === true);
    setChecked('agent-perm-auto-accept', settings.autoAccept === true);

    const mode = settings.mode === 'periodic' ? 'periodic' : 'manual';
    const modeRadio = document.querySelector('input[name="agent-mode"][value="' + mode + '"]');
    if (modeRadio) modeRadio.checked = true;
    togglePeriodicConfig(mode === 'periodic');

    setVal('agent-periodic-interval', settings.interval ?? settings.periodicInterval ?? 10);

    const hubMode = settings.hubMode === 'single' ? 'single' : 'agent';
    const hubRadio = document.querySelector('input[name="agent-hubmode"][value="' + hubMode + '"]');
    if (hubRadio) hubRadio.checked = true;
    toggleHubAgentConfig(hubMode === 'agent');
    setVal('agent-hub-maxsteps', settings.maxSteps ?? 10);
    setVal('agent-hub-total-timeout', settings.totalTimeoutMs ?? 600000);

    setVal('agent-hub-profile', settings.apiProfile || '');
    setVal('agent-hub-preset', settings.preset || '');
    setVal('agent-hub-model', settings.model || '');
    setChecked('agent-hub-own-config', settings.useOwnConfig === true);
    const ss = settings.samplers || {};
    setVal('agent-hub-temperature', ss.temperature ?? 0.7);
    const tempVal = document.getElementById('agent-hub-temp-value');
    if (tempVal) tempVal.textContent = ss.temperature ?? 0.7;
    setVal('agent-hub-top-p', ss.top_p ?? '');
    setVal('agent-hub-seed', ss.seed ?? '');
    setVal('agent-hub-max-tokens', settings.maxTokens ?? 1024);
    setVal('agent-hub-timeout', settings.timeoutMs ?? 90000);
    setVal('agent-hub-retries', settings.retries ?? 1);
    try { renderHubStatus(); } catch {}

    setVal('agent-guard-max-entries', settings.maxEntriesPerRun ?? 5);
    setVal('agent-guard-key-confidence', settings.requireKeyConfidence || 'low');
    setVal('agent-guard-max-pending', settings.maxPendingProposals ?? 20);
    setChecked('agent-guard-require-confirmation', settings.requireConfirmation !== false);
    setVal('agent-limit-chars', settings.maxCharsPerEntry ?? settings.limits?.maxCharsPerEntry ?? 8000);
    loadContextToConfig(settings);
    toggleQuickMsgRows();
    try { renderTokenDocs(); } catch {}

    setVal('agent-confidence-threshold', settings.autoAcceptConfidence ?? 0.8);
    const confVal = document.getElementById('agent-confidence-value');
    if (confVal) confVal.textContent = settings.autoAcceptConfidence ?? 0.8;
    toggleAutoAcceptConfig(settings.autoAccept === true);

    pendingInjectedContext = Array.isArray(settings.injectedContext) ? JSON.parse(JSON.stringify(settings.injectedContext)) : [];
    renderInjectedContextList(pendingInjectedContext);

    pendingDynamicLinks = cloneDynamicLinks(settings.dynamicLinks);
    renderDynamicLinksList();

    try { loadRulesToConfig(settings); } catch {}

    wireStaticConfigToggles();
}

let _elStaticTogglesWired = false;
function wireStaticConfigToggles() {
    if (_elStaticTogglesWired) return;
    _elStaticTogglesWired = true;
    document.querySelectorAll('input[name="agent-mode"]').forEach(r => {
        r.addEventListener('change', function () {
            togglePeriodicConfig(this.value === 'periodic');
        });
    });
    document.querySelectorAll('input[name="agent-hubmode"]').forEach(r => {
        r.addEventListener('change', function () {
            toggleHubAgentConfig(this.value === 'agent');
        });
    });
    const autoAcceptCb = document.getElementById('agent-perm-auto-accept');
    if (autoAcceptCb) {
        autoAcceptCb.addEventListener('change', function () {
            toggleAutoAcceptConfig(this.checked);
        });
    }
    const quickMsgType = document.getElementById('agent-quick-msg-type');
    if (quickMsgType) {
        quickMsgType.addEventListener('change', function () {
            toggleQuickMsgRows();
        });
    }
    const tempSlider = document.getElementById('agent-hub-temperature');
    if (tempSlider) {
        tempSlider.addEventListener('input', function () {
            const tv = document.getElementById('agent-hub-temp-value');
            if (tv) tv.textContent = this.value;
        });
    }
    const confSlider = document.getElementById('agent-confidence-threshold');
    if (confSlider) {
        confSlider.addEventListener('input', function () {
            const cv = document.getElementById('agent-confidence-value');
            if (cv) cv.textContent = this.value;
        });
    }
}

function togglePeriodicConfig(show) {
    const el = document.getElementById('agent-periodic-config');
    if (el) el.style.display = show ? 'block' : 'none';
}

// Legacy toggle stubs (old panels removed from the DOM).
function toggleSeparateApiConfig() {}
function toggleSearxngConfig() {}
function toggleMultiTurnConfig() {}

function toggleAutoAcceptConfig(show) {
    const el = document.getElementById('agent-auto-accept-config');
    if (el) el.style.display = show ? 'block' : 'none';
}



// ── Unified context section (load / read / live token count) ─────────────

function getResolvedContextUI(agent) {
    try {
        if (typeof EL_resolveAgentContext === 'function') return EL_resolveAgentContext(agent);
    } catch {}
    return null;
}

// Push an agent's (migrated) context into the Context section controls.
function loadContextToConfig(agent) {
    const a = (agent && typeof agent === 'object') ? agent : {};
    const ctx = getResolvedContextUI(a);
    const qd = (a.quickDefaults && typeof a.quickDefaults === 'object') ? a.quickDefaults : {};
    setVal('agent-quick-profile', qd.profileId || '');
    if (!ctx) { toggleQuickMsgRows(); scheduleContextLiveCount(); return; }
    const m = ctx.messages || {};
    setVal('agent-quick-msg-type', ['none', 'all', 'last', 'range'].includes(m.mode) ? m.mode : 'last');
    setVal('agent-quick-last', m.last ?? 10);
    setVal('agent-quick-range-start', m.start ?? 0);
    setVal('agent-quick-range-end', m.end ?? 10);
    setVal('agent-ctx-exclude', Array.isArray(m.excludeIds) && m.excludeIds.length ? m.excludeIds.join(', ') : '');
    const s = ctx.sources || {};
    setChecked('agent-quick-inc-char', !s.charCard || s.charCard.enabled !== false);
    setChecked('agent-quick-inc-author', !s.authorNote || s.authorNote.enabled !== false);
    setChecked('agent-quick-inc-wi', !s.worldInfo || s.worldInfo.enabled !== false);
    setChecked('agent-quick-inc-inj', !s.injected || s.injected.enabled !== false);
    setVal('agent-ctx-wi-mode', ['names', 'full', 'pins'].includes(s.worldInfo && s.worldInfo.mode) ? s.worldInfo.mode : 'names');
    setVal('agent-ctx-wi-maxchars', (s.worldInfo && s.worldInfo.maxCharsPerEntry) ?? 2000);
    setVal('agent-ctx-cc-maxchars', (s.charCard && s.charCard.maxChars) ?? 2000);
    setVal('agent-ctx-an-maxchars', (s.authorNote && s.authorNote.maxChars) ?? 1500);
    const pm = ctx.previousMemories || {};
    setChecked('agent-ctx-prevmem-enabled', pm.enabled !== false);
    setVal('agent-ctx-prevmem-count', pm.count ?? 3);
    setVal('agent-ctx-prevmem-book', pm.lorebookName || '');
    const pr = ctx.prompt || {};
    setVal('agent-ctx-preset', typeof pr.preset === 'string' && pr.preset ? pr.preset : 'lorekeeper');
    setChecked('agent-ctx-useregex', pr.useRegex === true);
    setVal('agent-ctx-tokens-warn', ctx.tokenWarningThreshold ?? 50000);
    toggleQuickMsgRows();
    scheduleContextLiveCount();
}

// Read the Context section into a (sanitized-by-schema-on-save) context object.
function readContextSettings() {
    const msgType = strVal('agent-quick-msg-type', 'last');
    // Preserved rather than reset: no form control edits this yet, so keep
    // the stored agent's value (false for new agents).
    let includePriorEntry = false;
    try {
        const priorCfgId = document.getElementById('agent-config-id')?.value || activeAgentId || null;
        const priorStored = (typeof agentManager !== 'undefined' && agentManager && priorCfgId) ? agentManager.getAgent(priorCfgId) : null;
        const priorPrevMem = (priorStored && priorStored.context && priorStored.context.previousMemories) ? priorStored.context.previousMemories : null;
        if (priorPrevMem && priorPrevMem.includePriorEntry === true) includePriorEntry = true;
        else if (priorStored && priorStored.includePriorEntry === true) includePriorEntry = true;
    } catch {}
    return {
        messages: {
            mode: ['none', 'all', 'last', 'range'].includes(msgType) ? msgType : 'last',
            last: intVal('agent-quick-last', 10),
            start: intVal('agent-quick-range-start', 0),
            end: intVal('agent-quick-range-end', 10),
            excludeIds: strVal('agent-ctx-exclude'),
        },
        previousMemories: {
            enabled: document.getElementById('agent-ctx-prevmem-enabled')?.checked !== false,
            count: intVal('agent-ctx-prevmem-count', 3),
            lorebookName: strVal('agent-ctx-prevmem-book'),
            includePriorEntry: includePriorEntry,
        },
        sources: {
            charCard: { enabled: document.getElementById('agent-quick-inc-char')?.checked !== false, maxChars: intVal('agent-ctx-cc-maxchars', 2000) },
            authorNote: { enabled: document.getElementById('agent-quick-inc-author')?.checked !== false, maxChars: intVal('agent-ctx-an-maxchars', 1500) },
            worldInfo: {
                enabled: document.getElementById('agent-quick-inc-wi')?.checked !== false,
                mode: ['names', 'full', 'pins'].includes(strVal('agent-ctx-wi-mode', 'names')) ? strVal('agent-ctx-wi-mode', 'names') : 'names',
                maxCharsPerEntry: intVal('agent-ctx-wi-maxchars', 2000),
            },
            injected: { enabled: document.getElementById('agent-quick-inc-inj')?.checked !== false },
        },
        prompt: {
            preset: strVal('agent-ctx-preset', 'lorekeeper'),
            custom: strVal('agent-prompt-custom'),
            useRegex: document.getElementById('agent-ctx-useregex')?.checked === true,
        },
        tokenWarningThreshold: intVal('agent-ctx-tokens-warn', 50000),
    };
}

let _ctxLiveTimer = null;
function scheduleContextLiveCount() {
    try {
        if (typeof EL_buildAgentContextAsync !== 'function') return;
        if (!document.getElementById('agent-ctx-tokens')) return;
        if (_ctxLiveTimer) clearTimeout(_ctxLiveTimer);
        _ctxLiveTimer = setTimeout(updateContextLiveCount, 450);
    } catch {}
}

// Live total over the EXACT first-request payload pieces for the on-screen
// draft overlaid on the stored agent (same overlay rule as renderPromptPreview).
async function updateContextLiveCount() {
    const totalEl = document.getElementById('agent-ctx-tokens');
    if (!totalEl) return;
    const brEl = document.getElementById('agent-ctx-tokens-breakdown');
    try {
        const draft = readAgentSettings();
        let agent = draft;
        try {
            const cfgId = document.getElementById('agent-config-id')?.value || activeAgentId || null;
            const stored = (typeof agentManager !== 'undefined' && agentManager && cfgId) ? agentManager.getAgent(cfgId) : null;
            if (stored) agent = Object.assign({}, stored, draft);
        } catch {}
        let st = null;
        try { st = (typeof EL_resolveHubSt === 'function') ? EL_resolveHubSt() : null; } catch {}
        if (!st || !Array.isArray(st.chat)) {
            totalEl.textContent = 'Context tokens: — (no chat open)';
            if (brEl) brEl.textContent = '';
            return;
        }
        const built = await EL_buildAgentContextAsync(st, agent, {});
        const t = built.tokens || { total: 0, method: 'heuristic', perBlock: {} };
        const methodLabel = t.method === 'real' ? 'real tokenizer' : (t.method === 'mixed' ? 'mixed' : 'estimate');
        totalEl.textContent = `Context tokens: ~${Number(t.total || 0).toLocaleString()} (${methodLabel}) — history ${built.history.items.length}/${built.history.totalRp} msgs`;
        try {
            const gate = (typeof EL_checkContextTokenWarning === 'function') ? EL_checkContextTokenWarning(built, agent) : null;
            if (gate && gate.over) totalEl.textContent += ` — OVER threshold ${gate.threshold.toLocaleString()}!`;
        } catch {}
        if (brEl) {
            const names = { history: 'History', previousMemories: 'Prev memories', charCard: 'Char card', authorNote: 'Author note', worldInfo: 'WI snapshot', injected: 'Injected', promptText: 'Instructions' };
            const order = ['history', 'previousMemories', 'charCard', 'authorNote', 'worldInfo', 'injected', 'promptText'];
            const pb = t.perBlock || {};
            const parts = [];
            for (const k of order) {
                if (pb[k]) parts.push(`${names[k] || k} ${Number(pb[k]).toLocaleString()}`);
            }
            brEl.textContent = parts.join(' · ') || 'Empty context — nothing will be sent.';
        }
    } catch (e) {
        totalEl.textContent = 'Context tokens: (count failed)';
    }
}

function wireContextLiveCount() {
    const ids = ['agent-quick-msg-type', 'agent-quick-first', 'agent-quick-last', 'agent-quick-range-start',
        'agent-quick-range-end', 'agent-ctx-exclude', 'agent-quick-inc-char', 'agent-quick-inc-author',
        'agent-quick-inc-wi', 'agent-quick-inc-inj', 'agent-ctx-wi-mode', 'agent-ctx-wi-maxchars',
        'agent-ctx-cc-maxchars', 'agent-ctx-an-maxchars', 'agent-ctx-prevmem-enabled', 'agent-ctx-prevmem-count',
        'agent-ctx-prevmem-book', 'agent-ctx-preset', 'agent-ctx-useregex', 'agent-ctx-tokens-warn',
        'agent-prompt-custom', 'agent-task-description'];
    for (const id of ids) {
        try {
            const el = document.getElementById(id);
            if (el && !el.dataset.ctxLive) {
                el.dataset.ctxLive = '1';
                el.addEventListener('input', scheduleContextLiveCount);
                el.addEventListener('change', scheduleContextLiveCount);
            }
        } catch {}
    }
}

function toggleQuickMsgRows() {
    try {
        const t = document.getElementById('agent-quick-msg-type')?.value || 'last';
        const fr = document.getElementById('agent-quick-first-row');
        const lr = document.getElementById('agent-quick-last-row');
        const rr = document.getElementById('agent-quick-range-row');
        if (fr) fr.style.display = t === 'first' ? '' : 'none';
        if (lr) lr.style.display = t === 'last' ? '' : 'none';
        if (rr) rr.style.display = t === 'range' ? '' : 'none';
    } catch (_) {}
}



function setChecked(id, val) {
    const el = document.getElementById(id);
    if (el) el.checked = !!val;
}

function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

// Preview: render the exact prompt message the model would receive with the
// current on-screen settings (overlaid on the stored agent so unsaved edits
// show). Names-only context — full snapshots load at run time.
async function renderPromptPreview() {
    const pre = document.getElementById('agent-prompt-preview');
    if (!pre) return;
    try {
        if (typeof EL_buildPromptMessage !== 'function' || typeof EL_buildHubTaskText !== 'function') {
            pre.textContent = 'Preview unavailable: hub client not loaded.';
            return;
        }
        const draft = readAgentSettings();
        let agent = draft;
        try {
            const cfgId = document.getElementById('agent-config-id')?.value || activeAgentId || null;
            const stored = (typeof agentManager !== 'undefined' && agentManager && cfgId) ? agentManager.getAgent(cfgId) : null;
            if (stored) agent = Object.assign({}, stored, draft);
        } catch {}
        const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
        const names = schema ? schema.getLinkedLorebookNames(agent) : [];
        const contextBlock = names.length
            ? `## Lorebooks in scope (preview — full snapshots load at run time)\n${names.map(n => `- ${n}`).join('\n')}`
            : '(No lorebooks linked.)';
        const hubMode = agent.hubMode === 'single' ? 'single' : 'agent';
        const msg = EL_buildPromptMessage(agent, {
            taskBrief: EL_buildHubTaskText(agent, { contextBlock }),
            hubMode,
            snapshotMode: hubMode === 'single' ? 'static' : 'ondemand',
        });
        const pos = (typeof EL_resolvePromptPosition === 'function') ? EL_resolvePromptPosition(agent) : 'before';
        let header = `[${msg.role}]  ·  position: ${pos === 'after' ? 'after history (depth 0)' : 'before history'}  ·  mode: ${hubMode}`;
        try {
            if (typeof EL_buildAgentContextAsync === 'function' && typeof EL_resolveHubSt === 'function') {
                const st = EL_resolveHubSt();
                if (st && Array.isArray(st.chat)) {
                    const built = await EL_buildAgentContextAsync(st, agent, {});
                    const t = built.tokens || {};
                    header += `\n[context: ~${Number(t.total || 0).toLocaleString()} tokens (${t.method || '?'}) — ${built.history.items.length}/${built.history.totalRp} msgs]`;
                }
            }
        } catch {}
        pre.textContent = `${header}\n\n${msg.content}`;
    } catch (e) {
        pre.textContent = 'Preview failed: ' + (e?.message || e);
    }
}

function readHubSamplerFloat(id) {
    const el = document.getElementById(id);
    if (!el) return undefined;
    const raw = String(el.value ?? '').trim();
    if (!raw) return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : undefined;
}

function readAgentSettings() {
    const modeRadio = document.querySelector('input[name="agent-mode"]:checked');
    const hubRadio = document.querySelector('input[name="agent-hubmode"]:checked');
    const intervalVal = intVal('agent-periodic-interval', 10);

    // Look up the stored agent the same way the rest of the file does, so
    // form-exposed fields overlay (rather than wipe) its sampler keys.
    const existingAgentId = strVal('agent-config-id') || activeAgentId || '';
    const existingAgent = (typeof agentManager !== 'undefined' && agentManager && existingAgentId)
        ? agentManager.getAgent(existingAgentId) : null;
    const existingResearch = (existingAgent && existingAgent.toolScope) ? existingAgent.toolScope.allowResearch : undefined;

    const toolScope = {
        allowCreate: document.getElementById('agent-scope-create')?.checked !== false,
        allowEdit: document.getElementById('agent-scope-edit')?.checked !== false,
        allowDelete: document.getElementById('agent-scope-delete')?.checked === true,
        // Preserved rather than reset: no form control edits this yet.
        allowResearch: existingResearch === true,
    };

    const samplers = Object.assign({}, (existingAgent && existingAgent.samplers) ? existingAgent.samplers : {});
    samplers.temperature = floatVal('agent-hub-temperature', 0.7);
    const topP = readHubSamplerFloat('agent-hub-top-p');
    if (topP !== undefined) samplers.top_p = topP; else delete samplers.top_p;
    const seedRaw = String(document.getElementById('agent-hub-seed')?.value ?? '').trim();
    if (seedRaw && Number.isInteger(Number(seedRaw))) samplers.seed = Number(seedRaw); else delete samplers.seed;

    return {
        id: strVal('agent-config-id') || undefined,
        name: strVal('agent-config-name') || 'Unnamed',
        enabled: document.getElementById('agent-enabled')?.checked !== false,
        taskDescription: strVal('agent-task-description'),
        customInstructions: strVal('agent-custom-instructions'),
        prompt: {
            role: ['system', 'user', 'assistant'].includes(strVal('agent-prompt-role', 'system')) ? strVal('agent-prompt-role', 'system') : 'system',
            position: strVal('agent-prompt-position', 'before') === 'after' ? 'after' : 'before',
            custom: strVal('agent-prompt-custom'),
        },
        toolScope,
        mode: modeRadio ? modeRadio.value : 'manual',
        interval: intervalVal,
        periodicInterval: intervalVal,
        hubMode: hubRadio ? hubRadio.value : 'agent',
        model: strVal('agent-hub-model'),
        apiProfile: strVal('agent-hub-profile'),
        preset: strVal('agent-hub-preset'),
        useOwnConfig: document.getElementById('agent-hub-own-config')?.checked === true,
        samplers,
        maxTokens: intVal('agent-hub-max-tokens', 1024),
        timeoutMs: intVal('agent-hub-timeout', 90000),
        retries: intVal('agent-hub-retries', 1),
        maxSteps: intVal('agent-hub-maxsteps', 10),
        totalTimeoutMs: intVal('agent-hub-total-timeout', 600000),
        autoAccept: document.getElementById('agent-perm-auto-accept')?.checked === true,
        autoAcceptConfidence: floatVal('agent-confidence-threshold', 0.8),
        maxEntriesPerRun: intVal('agent-guard-max-entries', 5),
        requireKeyConfidence: strVal('agent-guard-key-confidence', 'low'),
        maxPendingProposals: intVal('agent-guard-max-pending', 20),
        requireConfirmation: document.getElementById('agent-guard-require-confirmation')?.checked !== false,
        maxCharsPerEntry: intVal('agent-limit-chars', 8000),
        context: readContextSettings(),
        quickDefaults: {
            // Deprecated mirror (wand popup / /el-run readers) — context wins.
            profileId: strVal('agent-quick-profile'),
            messages: {
                type: ['none', 'all', 'last', 'range'].includes(strVal('agent-quick-msg-type', 'last')) ? strVal('agent-quick-msg-type', 'last') : 'last',
                first: intVal('agent-quick-first', 10),
                last: intVal('agent-quick-last', 10),
                range: {
                    start: intVal('agent-quick-range-start', 0),
                    end: intVal('agent-quick-range-end', 10),
                },
            },
            includeCharCard: document.getElementById('agent-quick-inc-char')?.checked !== false,
            includeAuthorNote: document.getElementById('agent-quick-inc-author')?.checked !== false,
            includeWorldInfo: document.getElementById('agent-quick-inc-wi')?.checked !== false,
            includeInjected: document.getElementById('agent-quick-inc-inj')?.checked !== false,
        },
        injectedContext: pendingInjectedContext,
        dynamicLinks: cloneDynamicLinks(pendingDynamicLinks),
        conditionals: JSON.parse(JSON.stringify(pendingConditionals || [])),
        defaultRule: {
            injectedContext: JSON.parse(JSON.stringify(pendingDefaultRule.injectedContext || [])),
            taskOverride: strVal('agent-default-task'),
            instructionsOverride: strVal('agent-default-instructions'),
        },
        notifyNoMatch: document.getElementById('agent-notify-no-match')?.checked === true,
    };
}

function intVal(id, def) {
    const el = document.getElementById(id);
    if (!el) return def;
    const v = parseInt(el.value);
    return isNaN(v) ? def : v;
}

function floatVal(id, def) {
    const el = document.getElementById(id);
    if (!el) return def;
    const v = parseFloat(el.value);
    return isNaN(v) ? def : v;
}

function strVal(id, def) {
    const el = document.getElementById(id);
    return el ? el.value : (def || '');
}

async function loadProposalsForCurrentChat() {
    currentChatId = getChatId();
    // Captured AFTER currentChatId is set: the module-global may change if
    // the user switches chats while a request is in flight.
    const loadedForChatId = currentChatId;
    const chatIdEl = document.getElementById('agent-chat-id');
    if (chatIdEl) chatIdEl.textContent = feedScope === 'all' ? 'All chats' : 'Chat: ' + currentChatId;

    try {
        if (feedScope === 'all' && typeof EL_apiFetch === 'function') {
            const result = await EL_apiFetch('GET', '/proposals/list-all');
            const chats = (result && Array.isArray(result.chats)) ? result.chats : [];
            const flat = [];
            for (const c of chats) {
                const cid = (c && typeof c.chatId === 'string' && c.chatId) ? c.chatId : '';
                for (const p of ((c && Array.isArray(c.proposals)) ? c.proposals : [])) {
                    if (p && typeof p === 'object') {
                        if (cid && !p._chatId) { try { p._chatId = cid; } catch {} }
                        flat.push(p);
                    }
                }
            }
            proposals = flat;
        } else {
            const result = await EL_apiFetch('GET', '/proposals/list?chatId=' + encodeURIComponent(loadedForChatId));
            proposals = (result?.proposals || []).map(p => {
                if (p && typeof p === 'object' && !p._chatId) { try { p._chatId = loadedForChatId; } catch {} }
                return p;
            });
        }
    } catch (e) {
        const msg = String(e?.message || e || '');
        if (msg.includes('404')) {
            try { (window.ELLogger||console).warn('[EL:Feed] proposals API missing (404) — server plugin outdated. Copy plugin and restart.'); } catch {}
            try { if (typeof EL_fireToast === 'function') EL_fireToast('Proposals server missing (404) — copy plugin & restart SillyTavern. Feed will be empty.', 'error'); } catch {}
            const historyEl = document.getElementById('agent-chat-status');
            if (historyEl) { /* keep proposals empty but warn in feed via logger */ }
        }
        proposals = [];
    }
    renderProposalsFeed(proposals, activeFilter);
    sendPendingCount();
    renderDashboard();
    EL_emitProposalsChanged('loaded', loadedForChatId);
}

function populateAgentFilterDropdown() {
    const sel = document.getElementById('agent-feed-agent-filter');
    if (!sel) return;
    const currentVal = sel.value;
    sel.innerHTML = '<option value="all">All Agents</option>';
    const agents = typeof agentManager !== 'undefined' && agentManager ? agentManager.getAgents() : [];
    for (const a of agents) {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name || 'Unnamed';
        sel.appendChild(opt);
    }
    sel.value = currentVal;
}

function renderProposalsFeed(items, filter) {
    const container = document.getElementById('proposals-list');
    if (!container) return;

    container.innerHTML = '';
    populateAgentFilterDropdown();

    const f = filter || 'all';
    const agentF = activeAgentFilter || 'all';
    let filtered = items;
    if (f !== 'all') {
        filtered = items.filter(p => p.status === f);
    }
    if (agentF !== 'all') {
        filtered = filtered.filter(p => (p.agentId === agentF));
    }
    // Numeric-aware sort: hub proposals store timestamp as Date.now() (number),
    // legacy ones may hold ISO strings. A plain localeCompare on numbers
    // throws and used to blank the entire feed.
    const tsOf = (p) => {
        const t = p ? p.timestamp : 0;
        if (typeof t === 'number' && Number.isFinite(t)) return t;
        if (typeof t === 'string' && t) {
            const n = Date.parse(t);
            if (Number.isFinite(n)) return n;
            const f = Number(t);
            if (Number.isFinite(f)) return f;
        }
        return 0;
    };
    filtered = [...filtered].sort((a, b) => {
        const d = tsOf(b) - tsOf(a);
        if (d) return d;
        return String(b.id || '').localeCompare(String(a.id || ''));
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:40px 0;"><i class="fa-solid fa-file-circle-plus fa-3x"></i><p>No proposals yet. Run the agent to generate suggestions.</p></div>';
        updatePendingBadge(0);
        return;
    }

    let pendingCount = 0;
    for (const p of items) {
        if (p.status === 'pending') pendingCount++;
    }
    updatePendingBadge(pendingCount);

    const acceptAllBtn = document.getElementById('btn-accept-all-pending');
    const denyAllBtn = document.getElementById('btn-deny-all-pending');
    const applyAllBtn = document.getElementById('btn-apply-all-accepted');
    if (acceptAllBtn) acceptAllBtn.style.display = pendingCount > 0 ? '' : 'none';
    if (denyAllBtn) denyAllBtn.style.display = pendingCount > 0 ? '' : 'none';

    const acceptedUnapplied = items.filter(p => (p.status === 'accepted' || p.status === 'auto-accepted') && !p.applied);
    if (applyAllBtn) applyAllBtn.style.display = acceptedUnapplied.length > 0 ? '' : 'none';

    for (const p of filtered) {
        // One malformed proposal must never blank the whole feed again.
        try {
            const card = createProposalCard(p);
            container.appendChild(card);
        } catch (e) {
            try {
                const err = document.createElement('div');
                err.className = 'proposal-card';
                err.innerHTML = '<div class="proposal-title">(Could not render proposal ' + _escapeHtml(String((p && p.id) || '?')) + ')</div>';
                container.appendChild(err);
            } catch {}
            try { (window.ELLogger || console).warn('[EL:Feed] card render failed', (p && p.id) || '?', e?.message || e); } catch {}
        }
    }
}

function updatePendingBadge(count) {
    const badge = document.getElementById('agent-pending-badge');
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
}

/**
 * Unified line diff (VSCode-style): removed lines red, added lines green,
 * unchanged lines neutral. LCS-based; falls back to whole-block remove+add
 * when the grid would get too big. Output is HTML-escaped.
 *
 * The renderer lives in the shared core (lib/apply-core.js) so the host window
 * can render the same diff for other extensions.
 */
function EL_buildLineDiffHtml(oldStr, newStr) {
    if (typeof ELApplyCore !== 'undefined' && typeof ELApplyCore.buildLineDiffHtml === 'function') {
        return ELApplyCore.buildLineDiffHtml(oldStr, newStr);
    }
    const esc = (typeof escapeHtml === 'function') ? escapeHtml : _escapeHtml;
    const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n');
    const splitLines = (s) => {
        const t = norm(s);
        if (t === '') return [];
        const arr = t.split('\n');
        if (arr.length > 1 && arr[arr.length - 1] === '') arr.pop();
        return arr;
    };
    const oldLines = splitLines(oldStr);
    const newLines = splitLines(newStr);

    const line = (cls, sign, text) =>
        '<div class="el-diff-line ' + cls + '"><span class="el-diff-gutter">' + sign + '</span><span>' + esc(text) + '</span></div>';

    const n = oldLines.length, m = newLines.length;
    // Cap the DP grid (~500x500); beyond that show all-removed + all-added.
    if (n * m > 250000) {
        let html = '';
        for (const l of oldLines) html += line('del', '−', l);
        for (const l of newLines) html += line('add', '+', l);
        return html;
    }
    // LCS lengths, suffix table.
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    let html = '', i = 0, j = 0;
    while (i < n && j < m) {
        if (oldLines[i] === newLines[j]) { html += line('ctx', ' ', oldLines[i]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { html += line('del', '−', oldLines[i]); i++; }
        else { html += line('add', '+', newLines[j]); j++; }
    }
    while (i < n) { html += line('del', '−', oldLines[i]); i++; }
    while (j < m) { html += line('add', '+', newLines[j]); j++; }
    return html;
}

// Exposed for other extensions (and for the EL.ui aggregator in el.js).
window.EL_buildLineDiffHtml = EL_buildLineDiffHtml;

function createProposalCard(p) {    const card = document.createElement('div');
    card.className = 'proposal-card ' + (p.status || 'pending');
    card.dataset.proposalId = p.id;

    const statusLabel = p.status === 'auto-accepted' ? 'auto-accepted' : (p.status || 'pending');

    const actionIcon = p.action === 'create' ? 'fa-plus' : (p.action === 'edit' ? 'fa-pencil' : 'fa-trash');
    const actionColor = p.action === 'create' ? '#10b981' : (p.action === 'edit' ? '#f59e0b' : '#ef4444');

    // Hub shapes first (entryData for create, changes for edit), legacy
    // snapshot shapes as fallback. Without this every hub card rendered
    // "(untitled)" with no keys or content.
    const snap = (p.entryData && typeof p.entryData === 'object') ? p.entryData
        : (p.entrySnapshot && typeof p.entrySnapshot === 'object' ? p.entrySnapshot : null);
    const orig = (p.originalSnapshot && typeof p.originalSnapshot === 'object') ? p.originalSnapshot : null;
    const entryComment = (snap && (snap.comment || snap.title))
        || (orig && orig.comment)
        || (p.action === 'delete' ? `Delete entry UID ${p.uid ?? ''}`.trim() : '')
        || '(untitled)';
    const keys = (snap && (snap.key || snap.keys)) || (orig && orig.key) || [];

    const agentName = p.agentName || '';
    const agentColor = '#6366f1';

    let headerHtml = '<div class="proposal-card-header">';
    headerHtml += '<span class="proposal-status-badge ' + statusLabel + '">' + statusLabel.replace('-', ' ') + '</span>';
    headerHtml += '<i class="fa-solid ' + actionIcon + ' proposal-action-icon" style="color:' + actionColor + '"></i>';
    headerHtml += '<span class="proposal-lorebook">' + escapeHtml(p.lorebookName || '') + '</span>';
    if (agentName) {
        headerHtml += '<span class="proposal-agent-tag" style="margin-left:auto; font-size:0.72rem; padding:2px 8px; border-radius:10px; background:rgba(99,102,241,0.15); color:#6366f1; font-weight:600; white-space:nowrap;">' + escapeHtml(agentName) + '</span>';
    } else {
        headerHtml += '<span style="margin-left:auto;"></span>';
    }
    // Augment badge: chat vs analyze share same feed
    const src = p.source || '';
    if (src) {
        const srcIcon = src === 'chat' ? 'fa-comments' : (src === 'periodic' ? 'fa-clock' : 'fa-robot');
        const srcLabel = src === 'chat' ? 'chat' : (src === 'periodic' ? 'periodic' : src);
        const srcColor = src === 'chat' ? 'rgba(16,185,129,0.18)' : 'rgba(255,255,255,0.08)';
        const srcText = src === 'chat' ? '#10b981' : 'var(--text-muted)';
        headerHtml += '<span class="proposal-source-tag" title="Created via ' + escapeHtml(src) + '" style="margin-left:6px; font-size:0.68rem; padding:2px 6px; border-radius:10px; background:' + srcColor + '; color:' + srcText + '; font-weight:600; white-space:nowrap;"><i class="fa-solid ' + srcIcon + '" style="margin-right:3px;"></i>' + escapeHtml(srcLabel) + '</span>';
    }
    headerHtml += '</div>';

    let bodyHtml = '<div class="proposal-title">' + escapeHtml(entryComment) + '</div>';
    if (p._chatId) {
        bodyHtml = '<div style="font-size:0.72rem;opacity:0.65;margin-bottom:2px;">from chat: ' + escapeHtml(p._chatId) + '</div>' + bodyHtml;
    }

    if (keys.length > 0) {
        bodyHtml += '<div class="proposal-keys">';
        for (const k of keys) {
            bodyHtml += '<span class="proposal-key-tag">' + escapeHtml(k) + '</span>';
        }
        bodyHtml += '</div>';
    }

    if (p.reasoning) {
        bodyHtml += '<div class="proposal-reasoning collapsed" id="reason-' + p.id + '">' + escapeHtml(p.reasoning) + '</div>';
        bodyHtml += '<button class="proposal-reasoning-toggle" data-target="reason-' + p.id + '"><i class="fa-solid fa-chevron-down"></i> Show reasoning</button>';
    }

    if (p.action === 'edit' && orig?.content !== undefined && snap?.content !== undefined && snap !== orig) {
        bodyHtml += '<div class="el-diff-box" title="Click to expand">' + EL_buildLineDiffHtml(orig.content || '', snap.content || '') + '</div>';
    } else if (p.action === 'edit' && p.changes && typeof p.changes === 'object' && Object.keys(p.changes).length) {
        // Hub edit shape: {field: new value} map. Content gets a real
        // red/green line diff against the original when we have it;
        // other fields render old → new, or +new when no baseline exists.
        const fieldNames = Object.keys(p.changes);
        bodyHtml += '<div class="el-diff-box" title="Click to expand">';
        for (const k of fieldNames.slice(0, 12)) {
            const v = p.changes[k];
            const vs = Array.isArray(v) ? v.join(', ') : String(v ?? '');
            const oldV = orig ? orig[k] : undefined;
            const oldS = Array.isArray(oldV) ? oldV.join(', ') : (oldV === undefined ? undefined : String(oldV ?? ''));
            if (k === 'content' && oldS !== undefined && oldS !== vs) {
                bodyHtml += '<div class="el-diff-field">content:</div>' + EL_buildLineDiffHtml(oldS, vs);
            } else if (oldS !== undefined && oldS !== vs) {
                bodyHtml += EL_buildLineDiffHtml(k + ': ' + oldS, k + ': ' + vs);
            } else {
                const addLines = (k + ': ' + vs).split('\n');
                for (const l of addLines.slice(0, 60)) {
                    bodyHtml += '<div class="el-diff-line add"><span class="el-diff-gutter">+</span><span>' + escapeHtml(l) + '</span></div>';
                }
                if (addLines.length > 60) bodyHtml += '<div class="el-diff-line ctx"><span class="el-diff-gutter"> </span><span>…(' + (addLines.length - 60) + ' more lines)</span></div>';
            }
        }
        if (fieldNames.length > 12) bodyHtml += '<div class="el-diff-line ctx"><span class="el-diff-gutter"> </span><span>…and ' + (fieldNames.length - 12) + ' more field(s)</span></div>';
        bodyHtml += '</div>';
    } else if (p.action === 'create' && snap?.content) {
        bodyHtml += '<div class="proposal-content-preview" data-expanded="false">' + escapeHtml(snap.content) + '</div>';
    } else if (p.action === 'delete' && (orig?.comment || p.uid !== undefined)) {
        bodyHtml += '<div style="font-size:0.82rem;color:var(--text-muted);padding:4px 0;">Delete entry: <strong>' + escapeHtml(orig?.comment || ('UID ' + p.uid)) + '</strong> from ' + escapeHtml(p.lorebookName || '') + '</div>';
    }

    if (p.status === 'pending') {
        const ac = p.action === 'delete' ? 'btn-danger' : 'btn-primary';
        bodyHtml += '<div class="proposal-actions">';
        bodyHtml += '<button class="btn btn-sm ' + ac + ' btn-agent-accept" data-pid="' + p.id + '"><i class="fa-solid fa-check"></i> Accept</button>';
        bodyHtml += '<button class="btn btn-sm btn-agent-deny" data-pid="' + p.id + '" style="background:rgba(239,68,68,0.2);color:#ef4444;"><i class="fa-solid fa-xmark"></i> Deny</button>';
        bodyHtml += '<div class="proposal-feedback-input"><input type="text" class="feedback-text" placeholder="Feedback..."><button class="btn btn-sm btn-agent-feedback" data-pid="' + p.id + '" style="background:var(--hover-bg);color:var(--text-color);"><i class="fa-solid fa-reply"></i></button></div>';
        bodyHtml += '</div>';
    } else if (p.status === 'accepted' || p.status === 'auto-accepted') {
        if (!p.applied) {
            bodyHtml += '<div class="proposal-actions"><button class="btn btn-sm btn-primary btn-agent-apply" data-pid="' + p.id + '"><i class="fa-solid fa-check-double"></i> Apply</button></div>';
        } else {
            bodyHtml += '<div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;"><i class="fa-solid fa-circle-check" style="color:#10b981;"></i> Applied</div>';
        }
    }

    card.innerHTML = headerHtml + bodyHtml;

    const toggleBtn = card.querySelector('.proposal-reasoning-toggle');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            const targetId = this.dataset.target;
            const target = document.getElementById(targetId);
            if (target) {
                target.classList.toggle('collapsed');
                this.innerHTML = target.classList.contains('collapsed')
                    ? '<i class="fa-solid fa-chevron-down"></i> Show reasoning'
                    : '<i class="fa-solid fa-chevron-up"></i> Hide reasoning';
            }
        });
    }

    const previewEl = card.querySelector('.proposal-content-preview');
    if (previewEl) {
        previewEl.addEventListener('click', function () {
            this.classList.toggle('expanded');
        });
    }

    for (const diffBox of card.querySelectorAll('.el-diff-box')) {
        diffBox.addEventListener('click', function () {
            this.classList.toggle('expanded');
        });
    }

    return card;
}

let _elConfigWired = false;
function wireConfigEvents() {
    if (typeof wireStaticConfigToggles === 'function') wireStaticConfigToggles();
    try { if (typeof wireContextLiveCount === 'function') wireContextLiveCount(); } catch {}
    if (_elConfigWired) return;
    _elConfigWired = true;
    const saveBtn = document.getElementById('btn-save-agent-settings');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveAgentConfig);
    }

    const testBtn = document.getElementById('btn-test-connection');
    if (testBtn) {
        testBtn.addEventListener('click', testConnection);
    }

    const runBtn = document.getElementById('btn-run-agent-now');
    if (runBtn) {
        runBtn.addEventListener('click', runAgentNow);
    }

    const previewPromptBtn = document.getElementById('btn-preview-prompt');
    if (previewPromptBtn) {
        previewPromptBtn.addEventListener('click', (e) => { e.preventDefault(); renderPromptPreview(); });
    }

    const listBackupsBtn = document.getElementById('btn-list-backups');
    if (listBackupsBtn) {
        listBackupsBtn.addEventListener('click', listBackups);
    }

    const backBtn = document.getElementById('btn-back-to-dashboard');
    if (backBtn) {
        backBtn.addEventListener('click', function () {
            switchToView('agent-dashboard');
        });
    }

    const duplicateBtn = document.getElementById('btn-config-duplicate');
    if (duplicateBtn) {
        duplicateBtn.addEventListener('click', async function () {
            const agentId = document.getElementById('agent-config-id')?.value;
            if (agentId) await duplicateAgent(agentId);
        });
    }

    const deleteBtn = document.getElementById('btn-config-delete');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async function () {
            const agentId = document.getElementById('agent-config-id')?.value;
            if (agentId) await deleteAgent(agentId);
            switchToView('agent-dashboard');
        });
    }

    const addInjectedBtn = document.getElementById('btn-add-injected-context');
    if (addInjectedBtn) {
        addInjectedBtn.addEventListener('click', (e) => { e.preventDefault(); openInjectedPicker('static'); });
    }
    const linkBookBtn = document.getElementById('btn-link-lorebook');
    if (linkBookBtn) {
        linkBookBtn.addEventListener('click', (e) => { e.preventDefault(); openInjectedPicker('link'); });
    }
    const addRuleBtn = document.getElementById('btn-add-rule');
    if (addRuleBtn) {
        addRuleBtn.addEventListener('click', (e) => { e.preventDefault(); addConditionalRule(); });
    }
    const defaultPicksBtn = document.getElementById('btn-default-picks');
    if (defaultPicksBtn) {
        defaultPicksBtn.addEventListener('click', (e) => { e.preventDefault(); pickerRuleTarget = pendingDefaultRule; openInjectedPicker('rule'); });
    }
    const syncBooksBtn = document.getElementById('btn-sync-chat-books');
    if (syncBooksBtn) {
        syncBooksBtn.addEventListener('click', (e) => { e.preventDefault(); syncChatBooks(); });
    }
    const previewDynBtn = document.getElementById('btn-preview-dynamic');
    if (previewDynBtn) {
        previewDynBtn.addEventListener('click', (e) => { e.preventDefault(); previewDynamicScan(); });
    }
    const clearDynBtn = document.getElementById('btn-clear-dynamic-links');
    if (clearDynBtn) {
        clearDynBtn.addEventListener('click', (e) => {
            e.preventDefault();
            pendingDynamicLinks = [];
            renderDynamicLinksList();
        });
    }
    // Delegation safety net: works even if direct binding ran before DOM ready
    // or if the config panel was re-rendered.
    document.addEventListener('click', (e) => {
        const addBtn = e.target?.closest?.('#btn-add-injected-context');
        if (addBtn) { e.preventDefault(); openInjectedPicker('static'); return; }
        const linkBtn = e.target?.closest?.('#btn-link-lorebook');
        if (linkBtn) { e.preventDefault(); openInjectedPicker('link'); return; }
        const syncBtn = e.target?.closest?.('#btn-sync-chat-books');
        if (syncBtn) { e.preventDefault(); syncChatBooks(); return; }
        const prevBtn = e.target?.closest?.('#btn-preview-dynamic');
        if (prevBtn) { e.preventDefault(); previewDynamicScan(); return; }
        const clearDyn = e.target?.closest?.('#btn-clear-dynamic-links');
        if (clearDyn) {
            e.preventDefault();
            pendingDynamicLinks = [];
            renderDynamicLinksList();
            return;
        }
        const clearBtn = e.target?.closest?.('#btn-clear-injected-context');
        if (clearBtn) {
            e.preventDefault();
            pendingInjectedContext = [];
            renderInjectedContextList(pendingInjectedContext);
            return;
        }
        const prevPromptBtn = e.target?.closest?.('#btn-preview-prompt');
        if (prevPromptBtn) { e.preventDefault(); renderPromptPreview(); return; }
        const cancelBtn = e.target?.closest?.('#btn-injected-cancel');
        if (cancelBtn) { e.preventDefault(); closeInjectedPicker(); return; }
    });

    const clearInjectedBtn = document.getElementById('btn-clear-injected-context');
    if (clearInjectedBtn) {
        clearInjectedBtn.addEventListener('click', function () {
            pendingInjectedContext = [];
            renderInjectedContextList(pendingInjectedContext);
        });
    }

    const injectedSearch = document.getElementById('injected-picker-search');
    if (injectedSearch) {
        injectedSearch.addEventListener('input', renderInjectedPicker);
    }

    const injectedCancel = document.getElementById('btn-injected-cancel');
    if (injectedCancel) {
        injectedCancel.addEventListener('click', closeInjectedPicker);
    }

    const injectedConfirm = document.getElementById('btn-injected-confirm');
    if (injectedConfirm) {
        injectedConfirm.addEventListener('click', function () {
            if (pickerMode === 'rule' && pickerRuleTarget) {
                const arr = [];
                for (const [name, sel] of pendingPicker.selected.entries()) {
                    const uids = Array.from(sel.uids).sort((a, b) => a - b);
                    if (sel.all) arr.push({ lorebook: name, all: true });
                    else if (uids.length) arr.push({ lorebook: name, uids });
                }
                pickerRuleTarget.injectedContext = arr;
                pickerRuleTarget = null;
                renderRulesList();
                updateDefaultPicksCount();
                closeInjectedPicker();
                return;
            }
            if (pickerMode === 'link') {
                const have = new Set((pendingDynamicLinks || []).map(l => l.name));
                for (const name of pendingPicker.selected.keys()) {
                    if (have.has(name)) continue;
                    pendingDynamicLinks.push({ name, pinUids: [] });
                    have.add(name);
                }
                renderDynamicLinksList();
                closeInjectedPicker();
                return;
            }
            if (pickerMode === 'pin' && pinTargetBook) {
                const sel = pendingPicker.selected.get(pinTargetBook);
                const uids = sel ? Array.from(sel.uids).sort((a, b) => a - b) : [];
                let link = (pendingDynamicLinks || []).find(l => l.name === pinTargetBook);
                if (!link) {
                    link = { name: pinTargetBook, pinUids: [] };
                    pendingDynamicLinks.push(link);
                }
                link.pinUids = uids;
                renderDynamicLinksList();
                closeInjectedPicker();
                return;
            }
            const existing = pendingInjectedContext.map(s => s.lorebook + '|' + (s.all ? 'all' : (s.uids || []).slice().sort().join(',')));
            for (const [name, sel] of pendingPicker.selected.entries()) {
                const uids = Array.from(sel.uids).sort((a, b) => a - b);
                const key = name + '|' + (sel.all ? 'all' : uids.join(','));
                if (existing.includes(key)) continue;
                const item = { lorebook: name };
                if (sel.all) {
                    item.all = true;
                } else if (uids.length > 0) {
                    item.uids = uids;
                } else {
                    continue;
                }
                pendingInjectedContext.push(item);
                existing.push(key);
            }
            renderInjectedContextList(pendingInjectedContext);
            closeInjectedPicker();
        });
    }

    const injectedModal = document.getElementById('injected-picker-modal');
    if (injectedModal) {
        injectedModal.addEventListener('click', function (e) {
            if (e.target === injectedModal || e.target.closest('.close-modal')) {
                closeInjectedPicker();
            }
        });
    }

    // (Legacy tool/permission checkbox sync removed with the vault UI —
    // toolScope checkboxes are standalone now.)
}

let _elFeedWired = false;
function wireFeedEvents() {
    if (_elFeedWired) return;
    _elFeedWired = true;
    const container = document.getElementById('proposals-list');
    if (container) {
        container.addEventListener('click', function (e) {
            const acceptBtn = e.target.closest('.btn-agent-accept');
            if (acceptBtn) {
                handleAcceptProposal(acceptBtn.dataset.pid);
                return;
            }
            const denyBtn = e.target.closest('.btn-agent-deny');
            if (denyBtn) {
                handleDenyProposal(denyBtn.dataset.pid);
                return;
            }
            const feedbackBtn = e.target.closest('.btn-agent-feedback');
            if (feedbackBtn) {
                const input = feedbackBtn.parentElement.querySelector('.feedback-text');
                const text = input ? input.value.trim() : '';
                if (text) handleFeedback(feedbackBtn.dataset.pid, text);
                return;
            }
            const applyBtn = e.target.closest('.btn-agent-apply');
            if (applyBtn) {
                handleApplyProposal(applyBtn.dataset.pid);
                return;
            }
        });
    }

    const acceptAllBtn = document.getElementById('btn-accept-all-pending');
    if (acceptAllBtn) {
        acceptAllBtn.addEventListener('click', handleAcceptAll);
    }

    const denyAllBtn = document.getElementById('btn-deny-all-pending');
    if (denyAllBtn) {
        denyAllBtn.addEventListener('click', handleDenyAll);
    }

    const applyAllBtn = document.getElementById('btn-apply-all-accepted');
    if (applyAllBtn) {
        applyAllBtn.addEventListener('click', handleApplyAllAccepted);
    }

    const refreshBtn = document.getElementById('btn-refresh-proposals');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadProposalsForCurrentChat);
    }

    const filterBar = document.querySelector('.agent-feed-filter-bar');
    if (filterBar) {
        filterBar.addEventListener('click', function (e) {
            const pill = e.target.closest('.pill-btn');
            if (!pill) return;
            filterBar.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
            pill.classList.add('active');
            activeFilter = pill.dataset.filter || 'all';
            renderProposalsFeed(proposals, activeFilter);
        });
    }

    const agentFilter = document.getElementById('agent-feed-agent-filter');
    if (agentFilter) {
        agentFilter.addEventListener('change', function () {
            activeAgentFilter = this.value;
            renderProposalsFeed(proposals, activeFilter);
        });
    }

    const scopeSel = document.getElementById('agent-feed-scope');
    if (scopeSel) {
        try { scopeSel.value = feedScope; } catch {}
        scopeSel.addEventListener('change', function () {
            feedScope = this.value === 'all' ? 'all' : 'chat';
            loadProposalsForCurrentChat();
        });
    }
}

function showAgentPanel(panel) {
    const entriesContainer = document.getElementById('entries-container');
    if (entriesContainer) entriesContainer.classList.add('hidden');

    const configPanel = document.getElementById('agent-config-panel');
    const feedPanel = document.getElementById('agent-feed-panel');

    if (configPanel) configPanel.classList.add('hidden');
    if (feedPanel) feedPanel.classList.add('hidden');

    document.querySelectorAll('.agent-sidebar-item').forEach(i => i.classList.remove('active'));

    if (panel === 'config') {
        if (configPanel) configPanel.classList.remove('hidden');
        const nav = document.getElementById('nav-agent-config');
        if (nav) nav.classList.add('active');
    } else {
        if (feedPanel) feedPanel.classList.remove('hidden');
        const nav = document.getElementById('nav-agent-feed');
        if (nav) nav.classList.add('active');
    }
}

function hideAgentPanels() {
    const configPanel = document.getElementById('agent-config-panel');
    const feedPanel = document.getElementById('agent-feed-panel');
    const chatPanel = document.getElementById('agent-chat-panel');
    if (configPanel) configPanel.classList.add('hidden');
    if (feedPanel) feedPanel.classList.add('hidden');
    if (chatPanel) chatPanel.classList.add('hidden');
    const recoveryPanel = document.getElementById('recovery-panel');
    if (recoveryPanel) recoveryPanel.classList.add('hidden');
}

async function saveAgentConfig() {
    const settings = readAgentSettings();
    let targetId = settings.id || activeAgentId || null;
    delete settings.id;

    if (typeof agentManager !== 'undefined' && agentManager) {
        if (targetId && agentManager.getAgent(targetId)) {
            agentManager.updateAgent(targetId, settings);
        } else if (targetId) {
            // Stale id (e.g. agent deleted elsewhere): create fresh, keep name/settings.
            const created = agentManager.createAgent(settings);
            targetId = created?.id || targetId;
            const idEl = document.getElementById('agent-config-id');
            if (idEl && created?.id) idEl.value = created.id;
            activeAgentId = targetId;
        } else {
            const created = agentManager.createAgent(settings);
            targetId = created?.id || null;
            const idEl = document.getElementById('agent-config-id');
            if (idEl && created?.id) idEl.value = created.id;
            activeAgentId = targetId;
        }
    } else if (typeof extensionSettings !== 'undefined') {
        // Fallback when manager is unavailable (should be rare).
        if (extensionSettings.agent) {
            extensionSettings.agent = { ...settings, id: targetId };
        } else if (Array.isArray(extensionSettings.agents) && extensionSettings.agents.length > 0) {
            const idx = extensionSettings.agents.findIndex(a => a.id === targetId);
            if (idx !== -1) {
                const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
                const cleaned = schema ? schema.sanitizeAgentConfig({ ...extensionSettings.agents[idx], ...settings }) : { ...extensionSettings.agents[idx], ...settings };
                cleaned.id = targetId;
                extensionSettings.agents[idx] = cleaned;
            } else {
                Object.assign(extensionSettings.agents[0], settings);
            }
        }
    }

    if (typeof saveSettings === 'function') {
        saveSettings();
    }

    // No engine cache anymore — runs build a fresh hub request every time.
    renderDashboard();
    renderAgentSidebar();

    if (typeof showToast === 'function') {
        showToast('Agent settings saved');
    }
}

async function testConnection() {
    // Tests the CURRENT on-screen hub config without saving: builds the same
    // JSON a run would send (single mode, no tools) and fires it at the hub.
    const show = (m) => { if (typeof showToast === 'function') showToast(m); };
    try {
        if (typeof EL_getHub !== 'function' || !EL_isHubReady()) {
            const detail = (typeof EL_hubStatus === 'function') ? EL_hubStatus().detail : 'hub unavailable';
            show('Hub unavailable: ' + detail);
            return;
        }
        const hub = EL_getHub();
        const draft = readAgentSettings();
        const req = {
            mode: 'single',
            input: { text: 'Reply with exactly: CONNECTION_OK', task: '{{input}}', useWI: false, attachChat: false },
            settings: {
                apiProfile: draft.apiProfile || '',
                preset: draft.preset || '',
                useOwnConfig: draft.useOwnConfig === true,
                samplers: Object.assign({}, draft.samplers, { temperature: 0 }),
                maxTokens: 32,
                timeoutMs: draft.timeoutMs || 90000,
                retries: 0,
            },
            label: 'lorebook:connection-test',
            consumer: 'EnhancedLorebook',
        };
        if (draft.model) req.settings.connection = { model: draft.model };
        if (typeof hub.validateRequest === 'function') {
            const v = hub.validateRequest(req);
            if (v && v.ok === false) {
                show('Invalid config: ' + (v.errors || []).slice(0, 3).join('; '));
                return;
            }
        }
        const res = await hub.request(req);
        const content = String(res?.content || '');
        if (/CONNECTION_OK/i.test(content)) show('Hub connection OK: model replied.');
        else if (content.trim()) show(`Hub OK, unexpected reply: "${content.slice(0, 80)}"`);
        else show('Hub OK but the reply was empty.');
    } catch (e) {
        const code = e?.code ? ` (${e.code})` : '';
        show('Connection failed' + code + ': ' + (e?.message || e));
    }
}

async function runAgentNow() {
    const agentId = document.getElementById('agent-config-id')?.value || activeAgentId || null;
    if (!agentId) {
        if (typeof showToast === 'function') showToast('No agent selected');
        return;
    }
    const runBtn = document.getElementById('btn-run-agent-now');
    const statusEl = document.getElementById('agent-run-status');
    if (runBtn) {
        runBtn.disabled = true;
        runBtn.innerHTML = '<i class="fa-solid fa-spinner agent-spinner"></i> Running...';
    }
    if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-spinner agent-spinner"></i> Agent is analyzing...';

    try {
        const result = await runSpecificAgent(agentId);
        if (statusEl) {
            const msg = 'Analyzed. Created ' + (result?.proposalsCreated || 0) + ' proposal(s).';
            const accepted = result?.autoAccepted || 0;
            const extra = accepted > 0 ? ' (' + accepted + ' auto-accepted)' : '';
            statusEl.innerHTML = '<span style="color:var(--success-color,#10b981);">' + msg + extra + '</span>';
        }
    } catch (e) {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger-color);">Error: ' + e.message + '</span>';
    } finally {
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.innerHTML = '<i class="fa-solid fa-play"></i> Run Now';
        }
        renderDashboard();
    }
}

function findProposal(id) {
    return proposals.find(p => p.id === id || p.proposalId === id);
}

// Which server-side chat file owns this proposal (All-chats scope tags
// foreign proposals with _chatId; current-chat scope uses currentChatId).
function proposalChatId(p) {
    return (p && typeof p._chatId === 'string' && p._chatId) ? p._chatId : currentChatId;
}

// Delete decided proposals from server storage (user choice: nothing lingers
// after accept/deny). Groups ids by owning chat file for All-chats scope.
async function EL_deleteDecidedProposals(list) {
    const byChat = new Map();
    for (const p of (list || [])) {
        if (!p || !p.id) continue;
        const cid = proposalChatId(p);
        if (!cid) continue;
        if (!byChat.has(cid)) byChat.set(cid, []);
        byChat.get(cid).push(p.id);
    }
    for (const [cid, ids] of byChat) {
        await EL_apiFetch('POST', '/proposals/delete', { chatId: cid, proposalIds: ids });
    }
    // The feed drops the cards itself right after this call, so the pending
    // count is computed without the deleted ids.
    const deletedIds = new Set();
    for (const ids of byChat.values()) for (const id of ids) deletedIds.add(id);
    const pending = proposals.filter(p => p && p.status === 'pending' && !deletedIds.has(p.id)).length;
    const chatId = (list && list[0]) ? proposalChatId(list[0]) : currentChatId;
    EL_emitProposalsChanged('deleted', chatId, pending);
}

function shouldConfirmAgentAction() {
    try {
        const cfgId = document.getElementById('agent-config-id')?.value || activeAgentId || null;
        if (typeof agentManager !== 'undefined' && agentManager && cfgId) {
            const a = agentManager.getAgent(cfgId);
            if (a) return a.requireConfirmation !== false;
        }
        // Fallback to on-screen checkbox (config panel open).
        const cb = document.getElementById('agent-guard-require-confirmation');
        if (cb) return cb.checked !== false;
    } catch {}
    return true;
}

async function handleAcceptProposal(id) {
    const p = findProposal(id);
    if (!p) return;
    if (p.applied) {
        if (typeof showToast === 'function') showToast('This proposal was already applied.');
        return;
    }

    if (shouldConfirmAgentAction()) {
        if (!confirm('Accept and apply this proposal to the lorebook? It will be removed from the feed.')) return;
    }

    try {
        await EL_applyProposal(p);
        // Delete-on-decision: the change is in the lorebook — drop the feed copy.
        try {
            await EL_deleteDecidedProposals([p]);
        } catch (delErr) {
            // The server record is still pending: keep the card but mark it
            // decided so a reload cannot apply it a second time.
            p.applied = true;
            p.status = 'applied';
            try {
                await EL_apiFetch('POST', '/proposals/update-status', { chatId: proposalChatId(p), proposalId: p.id, newStatus: 'applied' });
            } catch {}
            renderProposalsFeed(proposals, activeFilter);
            if (typeof showToast === 'function') showToast('Applied, but the feed entry could not be removed — it is marked applied and cannot be applied again.');
            return;
        }
        proposals = proposals.filter(x => x.id !== p.id);
        renderProposalsFeed(proposals, activeFilter);
        if (typeof showToast === 'function') showToast('Proposal accepted and applied');
        EL_emitProposalsChanged('accepted', proposalChatId(p));
    } catch (e) {
        if (typeof showToast === 'function') showToast('Failed: ' + e.message);
    }
}

async function handleDenyProposal(id) {
    const p = findProposal(id);
    if (!p) return;

    try {
        await EL_deleteDecidedProposals([p]);
        proposals = proposals.filter(x => x.id !== p.id);
        renderProposalsFeed(proposals, activeFilter);
        if (typeof showToast === 'function') showToast('Proposal denied and removed');
        EL_emitProposalsChanged('denied', proposalChatId(p));
    } catch (e) {
        if (typeof showToast === 'function') showToast('Failed: ' + e.message);
    }
}

async function handleFeedback(id, text) {
    const p = findProposal(id);
    if (!p) return;

    let feedbackOk = false;
    try {
        await EL_apiFetch('POST', '/proposals/update-status', {
            chatId: proposalChatId(p),
            proposalId: p.id,
            newStatus: p.status,
            userFeedback: text,
        });
        feedbackOk = true;
    } catch (fbErr) {
        if (typeof showToast === 'function') showToast('Could not record feedback: ' + (fbErr?.message || fbErr));
    }

    try {
        if (typeof EL_reviseHubProposal === 'function') {
            const cfgId = document.getElementById('agent-config-id')?.value || activeAgentId || null;
            const agent = (typeof agentManager !== 'undefined' && agentManager && cfgId)
                ? agentManager.getAgent(cfgId)
                : (typeof agentManager !== 'undefined' && agentManager ? agentManager.getAgent(p.agentId) : null);
            const revised = await EL_reviseHubProposal(agent || {}, p, text);
            if (revised && typeof revised === 'object') {
                // Replace (don't duplicate): the revised copy gets a fresh id.
                // Save-then-delete: if the save fails the original is
                // untouched; if the trailing delete fails the worst case
                // is two visible copies (deny one).
                const oldId = p.id;
                const newId = (typeof EL_proposalId === 'function') ? EL_proposalId() : ('prop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
                Object.assign(p, revised);
                p.id = newId;
                p.status = 'pending';
                delete p.applied;
                try {
                    await EL_apiFetch('POST', '/proposals/save', { chatId: proposalChatId(p), proposal: p });
                    try { await EL_deleteDecidedProposals([{ ...p, id: oldId, _chatId: proposalChatId(p) }]); } catch {}
                } catch (saveErr) {
                    p.id = oldId;
                    throw saveErr;
                }
            }
        }
    } catch (revErr) {
        if (typeof showToast === 'function') showToast('Revise failed: ' + (revErr?.message || revErr));
    }

    renderProposalsFeed(proposals, activeFilter);
    if (feedbackOk && typeof showToast === 'function') showToast('Feedback recorded');
}

async function handleApplyProposal(id) {
    const p = findProposal(id);
    if (!p) return;
    if (p.applied) {
        if (typeof showToast === 'function') showToast('This proposal was already applied.');
        return;
    }

    if (shouldConfirmAgentAction()) {
        if (!confirm('Apply this proposal to the lorebook? It will be removed from the feed.')) return;
    }

    try {
        await EL_applyProposal(p);
        try {
            await EL_deleteDecidedProposals([p]);
        } catch (delErr) {
            // The server record is still pending: keep the card but mark it
            // decided so a reload cannot apply it a second time.
            p.applied = true;
            p.status = 'applied';
            try {
                await EL_apiFetch('POST', '/proposals/update-status', { chatId: proposalChatId(p), proposalId: p.id, newStatus: 'applied' });
            } catch {}
            renderProposalsFeed(proposals, activeFilter);
            if (typeof showToast === 'function') showToast('Applied, but the feed entry could not be removed — it is marked applied and cannot be applied again.');
            return;
        }
        proposals = proposals.filter(x => x.id !== p.id);
        renderProposalsFeed(proposals, activeFilter);
        if (typeof showToast === 'function') showToast('Proposal applied');
        EL_emitProposalsChanged('accepted', proposalChatId(p));
    } catch (e) {
        if (typeof showToast === 'function') showToast('Failed: ' + e.message);
    }
}

async function handleAcceptAll() {
    const pending = proposals.filter(p => p.status === 'pending' && !p.applied);
    if (pending.length === 0) return;
    if (!confirm('Accept and apply all ' + pending.length + ' pending proposals? Decided proposals are removed from the feed.')) return;

    const applied = [];
    for (const p of pending) {
        try {
            await EL_applyProposal(p);
            p.status = 'accepted';
            p.applied = true;
            applied.push(p);
        } catch (_) {}
    }
    // Only drop a card from memory when its server-side delete actually
    // succeeded; otherwise keep it marked applied so it cannot be applied
    // again. Batched first (existing behaviour); per-card fallback on failure.
    const removedAcceptIds = new Set();
    try {
        if (applied.length) await EL_deleteDecidedProposals(applied);
        for (const p of applied) removedAcceptIds.add(p.id);
    } catch (_) {
        for (const p of applied) {
            try {
                await EL_deleteDecidedProposals([p]);
                removedAcceptIds.add(p.id);
            } catch (_) {
                p.status = 'applied';
                try {
                    await EL_apiFetch('POST', '/proposals/update-status', { chatId: proposalChatId(p), proposalId: p.id, newStatus: 'applied' });
                } catch {}
            }
        }
    }
    proposals = proposals.filter(x => !removedAcceptIds.has(x.id));
    renderProposalsFeed(proposals, activeFilter);
    if (typeof showToast === 'function') showToast('Accepted ' + applied.length + '/' + pending.length + ' proposals');
    EL_emitProposalsChanged('accepted');
}

async function handleDenyAll() {
    const pending = proposals.filter(p => p.status === 'pending');
    if (pending.length === 0) return;
    if (!confirm('Deny all ' + pending.length + ' pending proposals? They will be removed from the feed.')) return;

    try {
        await EL_deleteDecidedProposals(pending);
    } catch (e) {
        if (typeof showToast === 'function') showToast('Failed: ' + (e?.message || e));
        return;
    }
    const deniedIds = new Set(pending.map(p => p.id));
    proposals = proposals.filter(x => !deniedIds.has(x.id));
    renderProposalsFeed(proposals, activeFilter);
    if (typeof showToast === 'function') showToast('Denied ' + pending.length + ' proposals');
    EL_emitProposalsChanged('denied');
}

async function handleApplyAllAccepted() {
    const accepted = proposals.filter(p => (p.status === 'accepted' || p.status === 'auto-accepted') && !p.applied);
    if (accepted.length === 0) return;
    if (shouldConfirmAgentAction()) {
        if (!confirm('Apply all ' + accepted.length + ' accepted proposal(s) to lorebooks? Applied proposals are removed from the feed.')) return;
    }

    const applied = [];
    for (const p of accepted) {
        try {
            await EL_applyProposal(p);
            p.applied = true;
            applied.push(p);
        } catch (_) {}
    }
    // Only drop a card from memory when its server-side delete actually
    // succeeded; otherwise keep it marked applied so it cannot be applied
    // again. Batched first (existing behaviour); per-card fallback on failure.
    const removedApplyIds = new Set();
    try {
        if (applied.length) await EL_deleteDecidedProposals(applied);
        for (const p of applied) removedApplyIds.add(p.id);
    } catch (_) {
        for (const p of applied) {
            try {
                await EL_deleteDecidedProposals([p]);
                removedApplyIds.add(p.id);
            } catch (_) {
                p.status = 'applied';
                try {
                    await EL_apiFetch('POST', '/proposals/update-status', { chatId: proposalChatId(p), proposalId: p.id, newStatus: 'applied' });
                } catch {}
            }
        }
    }
    proposals = proposals.filter(x => !removedApplyIds.has(x.id));
    renderProposalsFeed(proposals, activeFilter);
    if (typeof showToast === 'function') showToast('Applied ' + applied.length + '/' + accepted.length + ' proposals');
    EL_emitProposalsChanged('accepted');
}

async function listBackups() {
    const container = document.getElementById('backup-list-container');
    if (!container) return;

    container.innerHTML = '<div style="padding:8px;color:var(--text-muted);"><i class="fa-solid fa-spinner agent-spinner"></i> Loading backups...</div>';

    try {
        const result = await EL_apiFetch('GET', '/backup/list');
        const backups = result?.backups || [];

        if (backups.length === 0) {
            container.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-style:italic;">No backups found</div>';
            return;
        }

        let html = '<table class="backup-table"><thead><tr><th>Timestamp</th><th>Lorebook</th><th></th></tr></thead><tbody>';
        for (const b of backups) {
            const ts = b.timestamp ? new Date(b.timestamp).toLocaleString() : 'Unknown';
            const lbNames = b.lorebookName || (b.lorebooks ? Object.keys(b.lorebooks).join(', ') : 'All');
            html += '<tr><td>' + escapeHtml(ts) + '</td><td>' + escapeHtml(lbNames) + '</td>';
            html += '<td><button class="btn btn-sm btn-primary btn-backup-restore" data-bid="' + escapeHtml(b.id || b.backupId || '') + '">Restore</button></td></tr>';
        }
        html += '</tbody></table>';
        container.innerHTML = html;

        container.querySelectorAll('.btn-backup-restore').forEach(btn => {
            btn.addEventListener('click', async function () {
                const bid = this.dataset.bid;
                if (!bid) return;
                if (!confirm('Restore backup ' + bid + '? Current lorebook data will be overwritten.')) return;

                try {
                    const st = typeof stContext !== 'undefined' ? stContext : null;
                    await EL_apiFetch('POST', '/backup/restore', { backupId: bid });
                    if (typeof showToast === 'function') showToast('Backup restored');
                    if (st && typeof st.loadWorldInfo === 'function' && typeof currentLorebookName !== 'undefined' && currentLorebookName) {
                        if (typeof currentLorebookData !== 'undefined') {
                            try {
                                const fresh = await st.loadWorldInfo(currentLorebookName);
                                if (typeof EL_setLorebookData === 'function') EL_setLorebookData(fresh, { own: true });
                            } catch (_) {}
                        }
                        if (typeof renderEntries === 'function') renderEntries();
                    }
                } catch (e) {
                    if (typeof showToast === 'function') showToast('Restore failed: ' + e.message);
                }
            });
        });
    } catch (e) {
        container.innerHTML = '<div style="padding:8px;color:var(--danger-color);">Failed to load backups: ' + escapeHtml(e.message) + '</div>';
    }
}

function sendPendingCount() {
    const count = proposals.filter(p => p.status === 'pending').length;
    try {
        if (typeof EL_postToHost === 'function') {
            EL_postToHost({ type: 'el-pending-count', count });
        }
    } catch (e) {}
}

/**
 * Tell the rest of SillyTavern that the proposal list changed.
 *
 * Emitted on the SillyTavern eventSource (the popup shares the host's
 * eventSource), so listeners installed in the MAIN window receive it:
 *   eventSource.on('el:proposals-changed', ({ chatId, count, reason }) => …)
 * reason is one of 'created' | 'accepted' | 'denied' | 'deleted' | 'loaded'.
 */
function EL_emitProposalsChanged(reason, chatId, countOverride) {
    try {
        const st = (typeof stContext !== 'undefined' && stContext) ? stContext : null;
        const source = st && st.eventSource ? st.eventSource : null;
        const count = (countOverride !== undefined && countOverride !== null)
            ? countOverride
            : (Array.isArray(proposals) ? proposals : []).filter(p => p && p.status === 'pending').length;
        const id = (chatId !== undefined && chatId !== null) ? chatId : currentChatId;
        const core = (typeof ELApplyCore !== 'undefined') ? ELApplyCore : null;
        if (core && typeof core.emitProposalsChanged === 'function') {
            return core.emitProposalsChanged(source, { chatId: id, count, reason });
        }
        if (source && typeof source.emit === 'function') {
            source.emit('el:proposals-changed', { chatId: String(id || ''), count, reason });
            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

/* ==========================================
   Agent Dashboard
   ========================================== */

function renderDashboard() {
    const grid = document.getElementById('agent-card-grid');
    const empty = document.getElementById('agent-dashboard-empty');
    if (!grid) return;

    const agents = typeof agentManager !== 'undefined' && agentManager ? agentManager.getAgents() : [];

    if (agents.length === 0) {
        grid.style.display = 'none';
        if (empty) empty.style.display = '';
        return;
    }

    grid.style.display = '';
    if (empty) empty.style.display = 'none';
    grid.innerHTML = '';

    for (const agent of agents) {
        grid.appendChild(createAgentCard(agent));
    }
}

function createAgentCard(agent) {
    const status = (typeof _elHubRunningAgents !== 'undefined' && _elHubRunningAgents.has(agent.id)) ? 'running' : 'idle';
    const enabled = agent.enabled !== false;

    const card = document.createElement('div');
    card.className = 'agent-card';
    card.dataset.agentId = agent.id;

    const taskSnippet = agent.taskDescription
        ? (agent.taskDescription.length > 100 ? agent.taskDescription.slice(0, 100) + '...' : agent.taskDescription)
        : 'No task defined';

    const pendingCount = proposals ? proposals.filter(p => p.status === 'pending' && p.agentId === agent.id).length : 0;

    let html = '<div class="agent-card-header">';
    html += '<div class="agent-card-name"><span class="agent-card-status-dot ' + (enabled ? status : 'disabled') + '"></span>' + escapeHtml(agent.name || 'Unnamed') + '</div>';
    html += '<div class="agent-card-toggle"><label class="toggle-switch" style="margin:0;"><input type="checkbox" class="agent-toggle-enable" data-agent-id="' + escapeHtml(agent.id) + '" ' + (enabled ? 'checked' : '') + '><span class="toggle-slider"></span></label></div>';
    html += '</div>';

    html += '<div class="agent-card-body">';
    html += '<div class="agent-card-badges">';
    html += '<span class="agent-card-badge ' + (agent.mode === 'periodic' ? 'periodic' : 'manual') + '">' + (agent.mode === 'periodic' ? 'Periodic' : 'Manual') + '</span>';
    html += '<span class="agent-card-badge hubmode" title="ST-RequestHub request mode">' + (agent.hubMode === 'single' ? 'Single' : 'Agentic') + '</span>';
    if (pendingCount > 0) {
        html += '<span class="agent-card-badge pending-count">' + pendingCount + ' pending</span>';
    }
    html += '</div>';

    html += '<div class="agent-card-task">' + escapeHtml(taskSnippet) + '</div>';

    html += '<div class="agent-card-meta">';
    html += '<span><i class="fa-regular fa-clock" style="margin-right:4px;"></i>' + (agent.mode === 'periodic' ? 'Every ' + (agent.interval ?? agent.periodicInterval ?? 10) + ' msgs' : 'Manual only') + '</span>';
    html += '</div>';
    html += '</div>';

    html += '<div class="agent-card-actions">';
    html += '<button class="btn btn-sm btn-primary btn-agent-run" data-agent-id="' + escapeHtml(agent.id) + '"><i class="fa-solid fa-play"></i> Run Now</button>';
    html += '<button class="btn btn-sm btn-secondary btn-agent-config" data-agent-id="' + escapeHtml(agent.id) + '"><i class="fa-solid fa-gear"></i> Config</button>';
    html += '<button class="btn btn-sm btn-secondary btn-agent-duplicate" data-agent-id="' + escapeHtml(agent.id) + '"><i class="fa-solid fa-copy"></i> Duplicate</button>';
    html += '<button class="btn btn-sm btn-danger btn-agent-delete" style="background:rgba(239,68,68,0.2);color:#ef4444;" data-agent-id="' + escapeHtml(agent.id) + '"><i class="fa-solid fa-trash"></i> Delete</button>';
    html += '</div>';

    card.innerHTML = html;

    return card;
}

function renderAgentSidebar() {
    const container = document.getElementById('agent-sidebar-list');
    if (!container) return;

    const agents = typeof agentManager !== 'undefined' && agentManager ? agentManager.getAgents() : [];
    container.innerHTML = '';

    const pendingByAgent = {};
    for (const p of proposals) {
        if (p.status === 'pending' && p.agentId) {
            pendingByAgent[p.agentId] = (pendingByAgent[p.agentId] || 0) + 1;
        }
    }

    for (const agent of agents) {
        const status = (typeof _elHubRunningAgents !== 'undefined' && _elHubRunningAgents.has(agent.id)) ? 'running' : 'idle';
        const enabled = agent.enabled !== false;
        const pCount = pendingByAgent[agent.id] || 0;

        const item = document.createElement('div');
        item.className = 'sidebar-agent-item' + (activeAgentId === agent.id ? ' active' : '');
        item.dataset.agentId = agent.id;

        let html = '<span class="status-dot ' + (enabled ? status : 'disabled') + '"></span><span class="agent-name">' + escapeHtml(agent.name || 'Unnamed') + '</span>';
        if (pCount > 0) {
            html += '<span class="sidebar-agent-badge" style="font-size:0.7rem; background:rgba(239,68,68,0.15); color:#ef4444; padding:1px 6px; border-radius:8px; font-weight:600; flex-shrink:0;">' + pCount + '</span>';
        }
        item.innerHTML = html;

        item.addEventListener('click', function () {
            activeAgentId = this.dataset.agentId;
            switchToView('agent-config');
        });
        container.appendChild(item);
    }
}

function openCreateAgentModal() {
    const modal = document.getElementById('create-agent-modal');
    if (!modal) return;

    document.getElementById('create-agent-name').value = '';
    document.getElementById('create-agent-task').value = '';

    const copyFrom = document.getElementById('create-agent-copy-from');
    if (copyFrom) {
        copyFrom.innerHTML = '<option value="">-- Start fresh with defaults --</option>';
        const agents = typeof agentManager !== 'undefined' && agentManager ? agentManager.getAgents() : [];
        for (const a of agents) {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.textContent = a.name || 'Unnamed';
            copyFrom.appendChild(opt);
        }
    }

    showModalEl(modal);
}

function closeCreateAgentModal() {
    hideModalEl(document.getElementById('create-agent-modal'));
}

async function createAgentFromModal() {
    const nameEl = document.getElementById('create-agent-name');
    const taskEl = document.getElementById('create-agent-task');
    const copyFromEl = document.getElementById('create-agent-copy-from');

    const name = (nameEl?.value || '').trim();
    const task = (taskEl?.value || '').trim();
    const copyFromId = copyFromEl?.value || '';

    if (!name) {
        if (typeof showToast === 'function') showToast('Agent name is required');
        return;
    }

    const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
    const baseDefaults = schema ? schema.sanitizeAgentConfig({}) : {};
    let newAgent = {
        ...baseDefaults,
        name: name,
        enabled: true,
        mode: 'manual',
        taskDescription: task,
        customInstructions: '',
    };

    if (copyFromId && typeof agentManager !== 'undefined' && agentManager) {
        const source = agentManager.getAgent(copyFromId);
        if (source) {
            const { id: _dropId, ...rest } = source;
            newAgent = { ...rest, name: name, taskDescription: task || rest.taskDescription };
        }
    }

    if (typeof agentManager !== 'undefined' && agentManager) {
        agentManager.createAgent(newAgent);
    }

    closeCreateAgentModal();
    renderAgentSidebar();
    renderDashboard();

    if (typeof showToast === 'function') showToast('Agent "' + name + '" created');
}

async function duplicateAgent(agentId) {
    if (typeof agentManager === 'undefined' || !agentManager) return;
    const clone = agentManager.duplicateAgent(agentId);
    if (!clone) return;
    renderAgentSidebar();
    renderDashboard();
    if (typeof showToast === 'function') showToast('Agent duplicated');
}

async function deleteAgent(agentId) {
    if (typeof agentManager === 'undefined' || !agentManager) return;
    const agent = agentManager.getAgent(agentId);
    if (!agent) return;
    if (!confirm('Delete agent "' + (agent.name || 'Unnamed') + '"? This cannot be undone.')) return;

    agentManager.deleteAgent(agentId);
    if (typeof saveSettings === 'function') saveSettings();
    renderAgentSidebar();
    renderDashboard();
    if (typeof showToast === 'function') showToast('Agent deleted');
}

async function toggleAgentEnabled(agentId, enabled) {
    if (typeof agentManager === 'undefined' || !agentManager) return;
    const agent = agentManager.getAgent(agentId);
    if (!agent) return;

    agent.enabled = enabled;
    agentManager.updateAgent(agentId, agent);
    if (typeof saveSettings === 'function') saveSettings();
    renderAgentSidebar();
    renderDashboard();
}

let _elDashboardWired = false;
function wireDashboardEvents() {
    if (_elDashboardWired) return;
    _elDashboardWired = true;
    const grid = document.getElementById('agent-card-grid');
    if (grid) {
        grid.addEventListener('click', function (e) {
            const runBtn = e.target.closest('.btn-agent-run');
            if (runBtn) {
                runSpecificAgent(runBtn.dataset.agentId);
                return;
            }

            const configBtn = e.target.closest('.btn-agent-config');
            if (configBtn) {
                activeAgentId = configBtn.dataset.agentId;
                switchToView('agent-config');
                return;
            }

            const duplicateBtn = e.target.closest('.btn-agent-duplicate');
            if (duplicateBtn) {
                duplicateAgent(duplicateBtn.dataset.agentId);
                return;
            }

            const deleteBtn = e.target.closest('.btn-agent-delete');
            if (deleteBtn) {
                deleteAgent(deleteBtn.dataset.agentId);
                return;
            }
        });
    }

    if (grid) {
        grid.addEventListener('change', function (e) {
            const toggle = e.target.closest('.agent-toggle-enable');
            if (toggle) {
                toggleAgentEnabled(toggle.dataset.agentId, toggle.checked);
            }
        });
    }

    const createBtn = document.getElementById('btn-create-agent');
    if (createBtn) {
        createBtn.addEventListener('click', openCreateAgentModal);
    }

    const createCancel = document.getElementById('btn-create-agent-cancel');
    if (createCancel) {
        createCancel.addEventListener('click', closeCreateAgentModal);
    }

    const createConfirm = document.getElementById('btn-create-agent-confirm');
    if (createConfirm) {
        createConfirm.addEventListener('click', createAgentFromModal);
    }

    const modal = document.getElementById('create-agent-modal');
    if (modal) {
        modal.addEventListener('click', function (e) {
            if (e.target === modal || e.target.closest('.close-modal')) {
                closeCreateAgentModal();
            }
        });
    }
}

const _elHubRunningAgents = new Set();
async function runSpecificAgent(agentId) {
    if (typeof agentManager === 'undefined' || !agentManager) return;

    if (_elHubRunningAgents.has(agentId)) {
        if (typeof showToast === 'function') showToast('Agent is already running');
        return;
    }
    _elHubRunningAgents.add(agentId);

    const statusEl = document.getElementById('agent-run-status');
    try {
        const agent = agentManager.getAgent(agentId);
        const onStep = (typeof EL_fireToast === 'function' && agent?.hubMode === 'agent')
            ? ({ step, toolCalls }) => {
                try {
                    const names = (toolCalls || []).map(t => t?.function?.name || t?.name).filter(Boolean).join(', ');
                    if (statusEl) statusEl.textContent = `Agent step ${step}${names ? `: ${names}` : ''}…`;
                } catch {}
            }
            : undefined;
        const result = await agentManager.runAgent(agentId, {
            onStep,
            // Token budget gate: confirm before sending a huge payload.
            confirmTokenWarning: async (gate) => {
                try {
                    return confirm(`Agent context is ~${Number(gate.total).toLocaleString()} tokens (threshold ${Number(gate.threshold).toLocaleString()}). Run anyway?`);
                } catch { return true; }
            },
        });
        await loadProposalsForCurrentChat();
        renderDashboard();
        const warns = (result?.warnings || []).length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'})` : '';
        if (typeof showToast === 'function') {
            showToast(`Agent run complete: ${result?.proposalsCreated || 0} proposal(s)${warns} — see Feed`);
        }
        if (statusEl && result?.warnings?.length) {
            statusEl.textContent = 'Warnings: ' + result.warnings.slice(0, 2).join(' | ');
        }
        return result;
    } catch (e) {
        if (typeof showToast === 'function') showToast('Agent run failed: ' + (e?.message || e));
        renderDashboard();
        throw e;
    } finally {
        _elHubRunningAgents.delete(agentId);
    }
}

// ── Terminal panel ─────────────────────────────────────────────
// One stream, two sources: server history (GET /log/tail, includes
// server-side direct-complete lines + previous sessions) and the live
// client ring buffer (window.EL_terminal, includes full request/response
// details). Live entries flush to the server file within ~2s, so merge
// dedupes by message prefix + timestamp proximity.
let _termServerLines = [];
let _termFilterLevel = 'ALL';
let _termFilterText = '';
let _termRefreshTimer = null;

function _termParseServerLine(line) {
    // `2026-09-05T10:48:35.709Z INFO  [CLIENT] msg meta…`
    const m = /^(\S+)\s+([A-Z]+)\s+([\s\S]*)$/.exec(line || '');
    if (!m) return { ts: Date.now(), level: 'INFO', msg: String(line || ''), detail: '' };
    const ts = Date.parse(m[1]);
    let msg = m[3] || '';
    if (msg.startsWith('[CLIENT] ')) msg = msg.slice(9);
    return { ts: Number.isFinite(ts) ? ts : Date.now(), level: m[2], msg, detail: '' };
}

function _termLevelRank(l) {
    return { DEBUG: 0, INFO: 1, LOG: 1, WARN: 2, ERROR: 3 }[String(l || '').toUpperCase()] ?? 1;
}

function _termNormMsg(msg) {
    return String(msg || '').replace(/ \[detail \d+ chars — see Terminal\]$/, '');
}

function _termMergedEntries() {
    const live = (typeof window !== 'undefined' && window.EL_terminal && typeof window.EL_terminal.entries === 'function')
        ? window.EL_terminal.entries() : [];
    const server = _termServerLines || [];
    const out = server.slice();
    for (const le of live) {
        const norm = _termNormMsg(le.msg);
        const dup = server.some(se => Math.abs((se.ts || 0) - (le.ts || 0)) <= 2000
            && (se.msg === le.msg || (norm && se.msg.startsWith(norm))));
        if (!dup) out.push({ ts: le.ts, level: le.level, msg: le.msg, detail: le.detail || '', total: le.total || 0, truncated: !!le.truncated });
    }
    out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return out;
}

function _termEntryText(e, previewLen) {
    const d = e.detail || '';
    const head = `[${new Date(e.ts || Date.now()).toISOString().slice(11, 19)}] ${e.level} ${e.msg}`;
    if (!d) return head;
    const shown = d.length > previewLen ? d.slice(0, previewLen) + `\n… [truncated — ${d.length} of ${e.total || d.length} chars, click detail in panel to expand]` : d;
    return head + '\n' + shown;
}

let _termOpenKeys = new Set(); // detail keys the user expanded — survive re-renders
let _termLastSig = '';

function _termKey(e) {
    const m = String(e.msg || '');
    let h = 0;
    for (let i = 0; i < m.length; i++) h = ((h * 31) + m.charCodeAt(i)) | 0;
    return (e.ts || 0) + ':' + h + ':' + m.length;
}

function renderTerminal(force) {
    const out = document.getElementById('terminal-output');
    if (!out) return;
    const previewLen = (typeof window !== 'undefined' && window.EL_terminal && window.EL_terminal.previewLen) || 4096;
    const minRank = _termFilterLevel === 'ALL' ? -1 : _termLevelRank(_termFilterLevel);
    const q = (_termFilterText || '').trim().toLowerCase();
    const entries = _termMergedEntries().filter(e => {
        if (_termLevelRank(e.level) < minRank) return false;
        if (q && !((e.msg || '').toLowerCase().includes(q) || (e.detail || '').toLowerCase().includes(q))) return false;
        return true;
    });
    const countEl = document.getElementById('terminal-count');
    if (countEl) countEl.textContent = entries.length ? `(${entries.length} line${entries.length === 1 ? '' : 's'})` : '';
    // Skip no-op refreshes (timer tick with no new lines) so open details,
    // selection, and scroll position are never disturbed.
    const lastTs = entries.length ? (entries[entries.length - 1].ts || 0) : 0;
    const sig = entries.length + '|' + lastTs + '|' + _termFilterLevel + '|' + q;
    if (!force && sig === _termLastSig) return;
    _termLastSig = sig;
    if (!entries.length) { out.innerHTML = '<div class="term-empty">No log lines. Run an agent or refresh to load server history.</div>'; return; }
    // Remember currently-expanded details before rebuild
    try {
        out.querySelectorAll('details.term-detail-wrap[data-key]').forEach(d => {
            if (d.open) _termOpenKeys.add(d.dataset.key);
            else _termOpenKeys.delete(d.dataset.key);
        });
        if (_termOpenKeys.size > 500) _termOpenKeys = new Set(Array.from(_termOpenKeys).slice(-500));
    } catch {}
    // Cap rendered rows for DOM sanity (newest win)
    const shown = entries.length > 1000 ? entries.slice(-1000) : entries;
    let html = '';
    for (const e of shown) {
        const lvl = _escapeHtml(String(e.level || 'INFO').toUpperCase());
        html += `<div class="term-line"><span class="term-ts">${_escapeHtml(new Date(e.ts || Date.now()).toISOString().slice(11, 19))}</span>`
            + `<span class="term-lvl term-lvl-${lvl}">${lvl}</span>`
            + `<span class="term-msg">${_escapeHtml(e.msg || '')}</span>`;
        const d = e.detail || '';
        if (d) {
            const total = e.total || d.length;
            const key = _termKey(e);
            const openAttr = _termOpenKeys.has(key) ? ' open' : '';
            const more = d.length > previewLen ? ` (${total.toLocaleString()} chars total)` : '';
            html += `<details class="term-detail-wrap" data-key="${key}"${openAttr}><summary>detail${more}</summary><pre class="term-detail">${_escapeHtml(d.length > previewLen * 3 ? d.slice(0, previewLen * 3) + `\n… [capped in view at ${(previewLen * 3).toLocaleString()} of ${total.toLocaleString()} chars — download .log for full]` : d)}</pre></details>`;
        }
        html += `</div>`;
    }
    if (entries.length > shown.length) html = `<div class="term-empty">Showing newest ${shown.length} of ${entries.length} — narrow the filter.</div>` + html;
    // Preserve scroll unless following
    let prevTop = 0;
    try { prevTop = out.scrollTop; } catch {}
    const follow = document.getElementById('terminal-autoscroll');
    const stick = !follow || follow.checked;
    out.innerHTML = html;
    try { out.scrollTop = stick ? out.scrollHeight : prevTop; } catch {}
}

async function refreshTerminalHistory() {
    try {
        if (typeof EL_apiFetch !== 'function') return;
        const data = await EL_apiFetch('GET', '/log/tail?lines=300');
        const lines = (data && data.lines) || [];
        _termServerLines = lines.map(_termParseServerLine);
    } catch {}
    renderTerminal(true);
}

function openTerminal() {
    const modal = document.getElementById('terminal-modal');
    if (!modal) return;
    try { if (window.EL_terminal) window.EL_terminal.setOpen(true); } catch {}
    modal._elOnClose = function () {
        try { if (window.EL_terminal) window.EL_terminal.setOpen(false); } catch (e) {}
        if (_termRefreshTimer) { clearInterval(_termRefreshTimer); _termRefreshTimer = null; }
    };
    showModalEl(modal);
    refreshTerminalHistory();
    if (_termRefreshTimer) clearInterval(_termRefreshTimer);
    _termRefreshTimer = setInterval(() => {
        try { if (document.getElementById('terminal-modal')?.classList.contains('active')) renderTerminal(false); } catch {}
    }, 1000);
}

function closeTerminal() {
    const modal = document.getElementById('terminal-modal');
    if (modal) hideModalEl(modal);
    else {
        try { if (window.EL_terminal) window.EL_terminal.setOpen(false); } catch {}
        if (_termRefreshTimer) { clearInterval(_termRefreshTimer); _termRefreshTimer = null; }
    }
}

function initTerminalPanel() {
    window.EL_terminalBadge = function (n) {
        try {
            const badge = document.getElementById('terminal-error-badge');
            if (!badge) return;
            if (n > 0) { badge.style.display = ''; badge.textContent = n > 99 ? '99+' : String(n); }
            else { badge.style.display = 'none'; badge.textContent = '0'; }
        } catch {}
    };
    const btn = document.getElementById('btn-terminal');
    if (btn && !btn.dataset.wired) {
        btn.dataset.wired = '1';
        btn.addEventListener('click', (e) => { e.preventDefault(); openTerminal(); });
    }
    const modal = document.getElementById('terminal-modal');
    if (modal && !modal.dataset.wired) {
        modal.dataset.wired = '1';
        modal.addEventListener('click', (e) => { if (e.target === modal || e.target.closest('.close-modal')) closeTerminal(); });
    }
    const level = document.getElementById('terminal-level');
    if (level && !level.dataset.wired) {
        level.dataset.wired = '1';
        level.addEventListener('change', () => { _termFilterLevel = level.value || 'ALL'; renderTerminal(true); });
    }
    const filter = document.getElementById('terminal-filter');
    if (filter && !filter.dataset.wired) {
        filter.dataset.wired = '1';
        filter.addEventListener('input', () => { _termFilterText = filter.value || ''; renderTerminal(true); });
    }
    const refresh = document.getElementById('btn-terminal-refresh');
    if (refresh && !refresh.dataset.wired) { refresh.dataset.wired = '1'; refresh.addEventListener('click', () => refreshTerminalHistory()); }
    const copy = document.getElementById('btn-terminal-copy');
    if (copy && !copy.dataset.wired) {
        copy.dataset.wired = '1';
        copy.addEventListener('click', async () => {
            try {
                const previewLen = (window.EL_terminal && window.EL_terminal.previewLen) || 4096;
                const text = _termMergedEntries().map(e => _termEntryText(e, previewLen)).join('\n');
                await navigator.clipboard.writeText(text);
                if (typeof showToast === 'function') showToast('Terminal copied');
            } catch { if (typeof showToast === 'function') showToast('Copy failed'); }
        });
    }
    const dl = document.getElementById('btn-terminal-download');
    if (dl && !dl.dataset.wired) {
        dl.dataset.wired = '1';
        dl.addEventListener('click', () => {
            try {
                const lines = _termMergedEntries().map(e => {
                    const head = `[${new Date(e.ts || Date.now()).toISOString()}] ${e.level} ${e.msg}`;
                    return e.detail ? head + '\n' + e.detail : head;
                });
                const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'el-terminal-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch {} }, 1000);
            } catch {}
        });
    }
    const clear = document.getElementById('btn-terminal-clear');
    if (clear && !clear.dataset.wired) {
        clear.dataset.wired = '1';
        clear.addEventListener('click', () => {
            try { if (window.EL_terminal) window.EL_terminal.clear(); } catch {}
            _termServerLines = [];
            _termOpenKeys = new Set();
            renderTerminal(true);
        });
    }
}
