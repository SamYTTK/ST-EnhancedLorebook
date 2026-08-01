let currentChatId = null;
let proposals = [];
let activeFilter = 'all';
let activeAgentFilter = 'all';
let chatPollInterval = null;
let backupClient = null;
let activeAgentId = null;
let pendingInjectedContext = [];
let pendingPicker = { lorebooks: [], search: '', selected: new Map(), expanded: new Set() };

function getChatId() {
    const st = typeof stContext !== 'undefined' ? stContext : null;
    const charId = st?.characterId ?? 'no-char';
    const chatFile = st?.chat?.chat_id ?? 'default';
    return charId + '_' + chatFile;
}

async function initAgentUI(context) {
    backupClient = new BackupClient(context || {});
    if (!agentEngine) {
        agentEngine = new AgentEngine({ id: 'agent_default', name: 'Main Agent' }, context?.stContext);
    }

    loadToolPermissionCheckboxes();
    loadSettingsToConfig();
    wireConfigEvents();
    wireFeedEvents();

    currentChatId = getChatId();
    await loadProposalsForCurrentChat();

    if (chatPollInterval) clearInterval(chatPollInterval);
    chatPollInterval = setInterval(async () => {
        const newId = getChatId();
        if (newId !== currentChatId) {
            currentChatId = newId;
            await loadProposalsForCurrentChat();
        }
    }, 2000);

    renderAgentSidebar();
    wireDashboardEvents();

    const chatIdEl = document.getElementById('agent-chat-id');
    if (chatIdEl) chatIdEl.textContent = 'Chat: ' + currentChatId;
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

async function openInjectedPicker() {
    const modal = document.getElementById('injected-picker-modal');
    if (!modal) return;

    const st = elResolveSt();
    if (!st || typeof st.getWorldInfoNames !== 'function') {
        if (typeof showToast === 'function') showToast('Lorebook access unavailable in this context');
        return;
    }

    pendingPicker = { lorebooks: [], search: '', selected: new Map(), expanded: new Set() };
    const searchEl = document.getElementById('injected-picker-search');
    if (searchEl) searchEl.value = '';

    const names = st.getWorldInfoNames() || [];
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
        } catch (_) {
            pendingPicker.lorebooks.push({ name, entries: [] });
        }
    }

    renderInjectedPicker();
    modal.style.display = 'flex';
}

function closeInjectedPicker() {
    const modal = document.getElementById('injected-picker-modal');
    if (modal) modal.style.display = 'none';
}

function renderInjectedPicker() {
    const container = document.getElementById('injected-picker-lorebooks');
    const searchEl = document.getElementById('injected-picker-search');
    if (!container) return;
    const search = (searchEl?.value || '').trim().toLowerCase();

    container.innerHTML = '';

    let totalSelected = 0;
    for (const lb of pendingPicker.lorebooks) {
        const sel = pendingPicker.selected.get(lb.name) || { all: false, uids: new Set() };

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

        if (pendingPicker.expanded.has(lb.name)) {
            for (const e of filtered) {
                const row = document.createElement('label');
                row.style.cssText = 'display:flex; align-items:flex-start; gap:8px; padding:4px 0 4px 26px; cursor:pointer;';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = sel.all || sel.uids.has(e.uid);
                cb.addEventListener('change', function () {
                    if (sel.all) {
                        pendingPicker.selected.set(lb.name, { all: false, uids: new Set(lb.entries.map(x => x.uid)) });
                        sel.all = false;
                    }
                    if (this.checked) {
                        pendingPicker.selected.get(lb.name).uids.add(e.uid);
                    } else {
                        pendingPicker.selected.get(lb.name).uids.delete(e.uid);
                        if (pendingPicker.selected.get(lb.name).uids.size === 0) {
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
    if (countEl) countEl.textContent = totalSelected > 0 ? `${totalSelected} selected` : '';
}

function loadToolPermissionCheckboxes() {
    const container = document.getElementById('agent-tool-permissions-container');
    if (!container) return;
    container.innerHTML = '';
    const toolDefs = typeof EL_TOOL_DEFINITIONS !== 'undefined' ? EL_TOOL_DEFINITIONS : [];
    for (const def of toolDefs) {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = 'agent-tool-' + def.name;
        cb.checked = true;
        const name = def.name.replace(/_/g, ' ');
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' ' + displayName));
        container.appendChild(label);
    }
}

function openAgentConfig(agentId) {
    activeAgentId = agentId;
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

    setChecked('agent-perm-create', agent.canCreate !== false);
    setChecked('agent-perm-edit', agent.canEdit !== false);
    setChecked('agent-perm-delete', agent.canDelete === true);
    setChecked('agent-perm-research', agent.canResearch === true);
    setChecked('agent-perm-auto-accept', agent.autoAccept === true);

    const mode = agent.mode === 'periodic' ? 'periodic' : 'manual';
    const modeRadio = document.querySelector('input[name="agent-mode"][value="' + mode + '"]');
    if (modeRadio) modeRadio.checked = true;
    togglePeriodicConfig(mode === 'periodic');
    setVal('agent-periodic-interval', agent.interval ?? agent.periodicInterval ?? 10);

    const conn = agent.useSeparateApi ? 'separate-api' : 'st-pipeline';
    const connRadio = document.querySelector('input[name="agent-connection"][value="' + conn + '"]');
    if (connRadio) connRadio.checked = true;
    toggleSeparateApiConfig(agent.useSeparateApi === true);

    setVal('agent-api-endpoint', agent.apiEndpoint || '');
    setVal('agent-api-model', agent.apiModel || '');
    setVal('agent-api-temperature', agent.temperature ?? 0.7);
    const tempVal = document.getElementById('agent-api-temp-value');
    if (tempVal) tempVal.textContent = agent.temperature ?? 0.7;

    setVal('agent-guard-max-entries', agent.maxEntriesPerRun ?? 5);
    setVal('agent-guard-key-confidence', agent.requireKeyConfidence || 'low');
    setVal('agent-guard-max-pending', agent.maxPendingProposals ?? 20);
    setChecked('agent-guard-require-confirmation', agent.requireConfirmation !== false);

    setVal('agent-confidence-threshold', agent.autoAcceptConfidence ?? 0.8);
    const confVal = document.getElementById('agent-confidence-value');
    if (confVal) confVal.textContent = agent.autoAcceptConfidence ?? 0.8;
    toggleAutoAcceptConfig(agent.autoAccept === true);

    setVal('agent-research-source', agent.research?.source || 'disabled');
    toggleSearxngConfig((agent.research?.source || 'disabled') === 'searxng');
    setVal('agent-searxng-url', agent.research?.searxngUrl || '');
    setVal('agent-searxng-token', agent.research?.searxngToken || '');

    const toolPerms = agent.toolPermissions || {};
    const toolDefs = typeof EL_TOOL_DEFINITIONS !== 'undefined' ? EL_TOOL_DEFINITIONS : [];
    for (const def of toolDefs) {
        const cb = document.getElementById('agent-tool-' + def.name);
        if (cb) cb.checked = toolPerms[def.name] !== false;
    }

    pendingInjectedContext = Array.isArray(agent.injectedContext) ? JSON.parse(JSON.stringify(agent.injectedContext)) : [];
    renderInjectedContextList(pendingInjectedContext);

    const mt = agent.multiTurn || {};
    setChecked('agent-multiturn-enabled', mt.enabled === true);
    const mtMode = mt.limitMode === 'rate' ? 'rate' : 'count';
    const mtRadio = document.querySelector('input[name="agent-multiturn-mode"][value="' + mtMode + '"]');
    if (mtRadio) mtRadio.checked = true;
    setVal('agent-multiturn-maxcalls', mt.maxCalls ?? 10);
    setVal('agent-multiturn-cpm', mt.callsPerMinute ?? 5);
    setVal('agent-multiturn-safety', mt.safetyCap ?? 30);
    toggleMultiTurnConfig(mt.enabled === true);

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

    setChecked('agent-perm-create', settings.canCreate !== false);
    setChecked('agent-perm-edit', settings.canEdit !== false);
    setChecked('agent-perm-delete', settings.canDelete === true);
    setChecked('agent-perm-research', settings.canResearch === true);
    setChecked('agent-perm-auto-accept', settings.autoAccept === true);

    const toolPerms = settings.toolPermissions || {};
    const toolDefs = typeof EL_TOOL_DEFINITIONS !== 'undefined' ? EL_TOOL_DEFINITIONS : [];
    for (const def of toolDefs) {
        const cb = document.getElementById('agent-tool-' + def.name);
        if (cb) cb.checked = toolPerms[def.name] !== false;
    }

    const mode = settings.mode === 'periodic' ? 'periodic' : 'manual';
    const modeRadio = document.querySelector('input[name="agent-mode"][value="' + mode + '"]');
    if (modeRadio) modeRadio.checked = true;
    togglePeriodicConfig(mode === 'periodic');

    setVal('agent-periodic-interval', settings.interval ?? settings.periodicInterval ?? 10);

    const conn = settings.useSeparateApi ? 'separate-api' : 'st-pipeline';
    const connRadio = document.querySelector('input[name="agent-connection"][value="' + conn + '"]');
    if (connRadio) connRadio.checked = true;
    toggleSeparateApiConfig(settings.useSeparateApi === true);

    setVal('agent-api-endpoint', settings.apiEndpoint || '');
    setVal('agent-api-model', settings.apiModel || '');
    setVal('agent-api-temperature', settings.temperature ?? 0.7);
    const tempVal = document.getElementById('agent-api-temp-value');
    if (tempVal) tempVal.textContent = settings.temperature ?? 0.7;

    setVal('agent-guard-max-entries', settings.maxEntriesPerRun ?? 5);
    setVal('agent-guard-key-confidence', settings.requireKeyConfidence || 'low');
    setVal('agent-guard-max-pending', settings.maxPendingProposals ?? 20);
    setChecked('agent-guard-require-confirmation', settings.requireConfirmation !== false);

    setVal('agent-confidence-threshold', settings.autoAcceptConfidence ?? 0.8);
    const confVal = document.getElementById('agent-confidence-value');
    if (confVal) confVal.textContent = settings.autoAcceptConfidence ?? 0.8;
    toggleAutoAcceptConfig(settings.autoAccept === true);

    setVal('agent-research-source', settings.research?.source || 'disabled');
    toggleSearxngConfig((settings.research?.source || 'disabled') === 'searxng');
    setVal('agent-searxng-url', settings.research?.searxngUrl || '');
    setVal('agent-searxng-token', settings.research?.searxngToken || '');

    pendingInjectedContext = Array.isArray(settings.injectedContext) ? JSON.parse(JSON.stringify(settings.injectedContext)) : [];
    renderInjectedContextList(pendingInjectedContext);

    const mt = settings.multiTurn || {};
    setChecked('agent-multiturn-enabled', mt.enabled === true);
    const mtMode = mt.limitMode === 'rate' ? 'rate' : 'count';
    const mtRadio = document.querySelector('input[name="agent-multiturn-mode"][value="' + mtMode + '"]');
    if (mtRadio) mtRadio.checked = true;
    setVal('agent-multiturn-maxcalls', mt.maxCalls ?? 10);
    setVal('agent-multiturn-cpm', mt.callsPerMinute ?? 5);
    setVal('agent-multiturn-safety', mt.safetyCap ?? 30);
    toggleMultiTurnConfig(mt.enabled === true);

    document.querySelectorAll('input[name="agent-mode"]').forEach(r => {
        r.addEventListener('change', function () {
            togglePeriodicConfig(this.value === 'periodic');
        });
    });
    document.querySelectorAll('input[name="agent-connection"]').forEach(r => {
        r.addEventListener('change', function () {
            toggleSeparateApiConfig(this.value === 'separate-api');
        });
    });
    const autoAcceptCb = document.getElementById('agent-perm-auto-accept');
    if (autoAcceptCb) {
        autoAcceptCb.addEventListener('change', function () {
            toggleAutoAcceptConfig(this.checked);
        });
    }
    const researchSource = document.getElementById('agent-research-source');
    if (researchSource) {
        researchSource.addEventListener('change', function () {
            toggleSearxngConfig(this.value === 'searxng');
        });
    }
    const tempSlider = document.getElementById('agent-api-temperature');
    if (tempSlider) {
        tempSlider.addEventListener('input', function () {
            const tv = document.getElementById('agent-api-temp-value');
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

function toggleSeparateApiConfig(show) {
    const el = document.getElementById('agent-separate-api-config');
    if (el) el.style.display = show ? 'flex' : 'none';
}

function toggleAutoAcceptConfig(show) {
    const el = document.getElementById('agent-auto-accept-config');
    if (el) el.style.display = show ? 'block' : 'none';
}

function toggleSearxngConfig(show) {
    const el = document.getElementById('agent-searxng-config');
    if (el) el.style.display = show ? 'flex' : 'none';
}

function toggleMultiTurnConfig(enabled) {
    const configEl = document.getElementById('agent-multiturn-config');
    if (configEl) configEl.style.display = enabled ? 'flex' : 'none';
    const modeRadio = document.querySelector('input[name="agent-multiturn-mode"]:checked');
    const mode = modeRadio ? modeRadio.value : 'count';
    const countField = document.getElementById('agent-multiturn-count-field');
    const rateField = document.getElementById('agent-multiturn-rate-field');
    if (countField) countField.style.display = mode === 'count' ? 'block' : 'none';
    if (rateField) rateField.style.display = mode === 'rate' ? 'block' : 'none';
}

function setChecked(id, val) {
    const el = document.getElementById(id);
    if (el) el.checked = !!val;
}

function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

function readAgentSettings() {
    const modeRadio = document.querySelector('input[name="agent-mode"]:checked');
    const connRadio = document.querySelector('input[name="agent-connection"]:checked');
    const intervalVal = intVal('agent-periodic-interval', 10);

    const toolPermissions = {};
    const toolDefs = typeof EL_TOOL_DEFINITIONS !== 'undefined' ? EL_TOOL_DEFINITIONS : [];
    for (const def of toolDefs) {
        const cb = document.getElementById('agent-tool-' + def.name);
        toolPermissions[def.name] = cb ? cb.checked : true;
    }

    return {
        id: strVal('agent-config-id') || undefined,
        name: strVal('agent-config-name') || 'Unnamed',
        enabled: document.getElementById('agent-enabled')?.checked !== false,
        taskDescription: strVal('agent-task-description'),
        customInstructions: strVal('agent-custom-instructions'),
        toolPermissions: toolPermissions,
        mode: modeRadio ? modeRadio.value : 'manual',
        interval: intervalVal,
        periodicInterval: intervalVal,
        useSeparateApi: connRadio ? connRadio.value === 'separate-api' : false,
        apiEndpoint: strVal('agent-api-endpoint'),
        apiModel: strVal('agent-api-model'),
        temperature: floatVal('agent-api-temperature', 0.7),
        canCreate: document.getElementById('agent-perm-create')?.checked !== false,
        canEdit: document.getElementById('agent-perm-edit')?.checked !== false,
        canDelete: document.getElementById('agent-perm-delete')?.checked === true,
        canResearch: document.getElementById('agent-perm-research')?.checked === true,
        autoAccept: document.getElementById('agent-perm-auto-accept')?.checked === true,
        autoAcceptConfidence: floatVal('agent-confidence-threshold', 0.8),
        maxEntriesPerRun: intVal('agent-guard-max-entries', 5),
        requireKeyConfidence: strVal('agent-guard-key-confidence', 'low'),
        maxPendingProposals: intVal('agent-guard-max-pending', 20),
        requireConfirmation: document.getElementById('agent-guard-require-confirmation')?.checked !== false,
        research: {
            source: strVal('agent-research-source', 'disabled'),
            searxngUrl: strVal('agent-searxng-url'),
            searxngToken: strVal('agent-searxng-token'),
        },
        multiTurn: {
            enabled: document.getElementById('agent-multiturn-enabled')?.checked === true,
            limitMode: document.querySelector('input[name="agent-multiturn-mode"]:checked')?.value || 'count',
            maxCalls: intVal('agent-multiturn-maxcalls', 10),
            callsPerMinute: intVal('agent-multiturn-cpm', 5),
            safetyCap: intVal('agent-multiturn-safety', 30),
        },
        injectedContext: pendingInjectedContext,
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
    const chatIdEl = document.getElementById('agent-chat-id');
    if (chatIdEl) chatIdEl.textContent = 'Chat: ' + currentChatId;

    try {
        const result = await EL_apiFetch('GET', '/proposals/list?chatId=' + encodeURIComponent(currentChatId));
        proposals = result?.proposals || [];
    } catch (_) {
        proposals = [];
    }
    renderProposalsFeed(proposals, activeFilter);
    sendPendingCount();
    renderDashboard();
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
    filtered = [...filtered].sort((a, b) => {
        return (b.timestamp || '').localeCompare(a.timestamp || '');
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
        const card = createProposalCard(p);
        container.appendChild(card);
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

function createProposalCard(p) {
    const card = document.createElement('div');
    card.className = 'proposal-card ' + (p.status || 'pending');
    card.dataset.proposalId = p.id;

    const statusLabel = p.status === 'auto-accepted' ? 'auto-accepted' : (p.status || 'pending');

    const actionIcon = p.action === 'create' ? 'fa-plus' : (p.action === 'edit' ? 'fa-pencil' : 'fa-trash');
    const actionColor = p.action === 'create' ? '#10b981' : (p.action === 'edit' ? '#f59e0b' : '#ef4444');

    const entryComment = p.entrySnapshot?.comment || p.originalSnapshot?.comment || '(untitled)';
    const keys = p.entrySnapshot?.key || p.originalSnapshot?.key || [];

    const agentName = p.agentName || '';
    const agentColor = '#6366f1';

    let headerHtml = '<div class="proposal-card-header">';
    headerHtml += '<span class="proposal-status-badge ' + statusLabel + '">' + statusLabel.replace('-', ' ') + '</span>';
    headerHtml += '<i class="fa-solid ' + actionIcon + ' proposal-action-icon" style="color:' + actionColor + '"></i>';
    headerHtml += '<span class="proposal-lorebook">' + escapeHtml(p.lorebookName || '') + '</span>';
    if (agentName) {
        headerHtml += '<span class="proposal-agent-tag" style="margin-left:auto; font-size:0.72rem; padding:2px 8px; border-radius:10px; background:rgba(99,102,241,0.15); color:#6366f1; font-weight:600; white-space:nowrap;">' + escapeHtml(agentName) + '</span>';
    }
    headerHtml += '</div>';

    let bodyHtml = '<div class="proposal-title">' + escapeHtml(entryComment) + '</div>';

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

    if (p.action === 'edit' && p.originalSnapshot?.content !== undefined && p.entrySnapshot?.content !== undefined) {
        bodyHtml += '<div class="proposal-content-diff">';
        bodyHtml += '<div class="proposal-content-diff-original"><strong>Original</strong><br>' + escapeHtml((p.originalSnapshot.content || '').slice(0, 300)) + '</div>';
        bodyHtml += '<div class="proposal-content-diff-proposed"><strong>Proposed</strong><br>' + escapeHtml((p.entrySnapshot.content || '').slice(0, 300)) + '</div>';
        bodyHtml += '</div>';
    } else if (p.action === 'create' && p.entrySnapshot?.content) {
        bodyHtml += '<div class="proposal-content-preview" data-expanded="false">' + escapeHtml(p.entrySnapshot.content) + '</div>';
    } else if (p.action === 'delete' && p.originalSnapshot?.comment) {
        bodyHtml += '<div style="font-size:0.82rem;color:var(--text-muted);padding:4px 0;">Delete entry: <strong>' + escapeHtml(p.originalSnapshot.comment) + '</strong></div>';
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

    return card;
}

function wireConfigEvents() {
    const saveBtn = document.getElementById('btn-save-agent-settings');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveAgentConfig);
    }

    const testBtn = document.getElementById('btn-test-connection');
    if (testBtn) {
        testBtn.addEventListener('click', testConnection);
    }

    const saveApiBtn = document.getElementById('btn-save-api-config');
    if (saveApiBtn) {
        saveApiBtn.addEventListener('click', saveApiConfig);
    }

    const runBtn = document.getElementById('btn-run-agent-now');
    if (runBtn) {
        runBtn.addEventListener('click', runAgentNow);
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

    const mtToggle = document.getElementById('agent-multiturn-enabled');
    if (mtToggle) {
        mtToggle.addEventListener('change', function () {
            toggleMultiTurnConfig(this.checked);
        });
    }

    document.querySelectorAll('input[name="agent-multiturn-mode"]').forEach(r => {
        r.addEventListener('change', function () {
            toggleMultiTurnConfig(document.getElementById('agent-multiturn-enabled')?.checked === true);
        });
    });

    const addInjectedBtn = document.getElementById('btn-add-injected-context');
    if (addInjectedBtn) {
        addInjectedBtn.addEventListener('click', openInjectedPicker);
    }

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
}

function wireFeedEvents() {
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
    if (configPanel) configPanel.classList.add('hidden');
    if (feedPanel) feedPanel.classList.add('hidden');
}

async function saveAgentConfig() {
    const settings = readAgentSettings();
    const targetId = settings.id || activeAgentId || null;

    if (typeof agentManager !== 'undefined' && agentManager && targetId) {
        const existing = agentManager.getAgent(targetId);
        if (existing) {
            agentManager.updateAgent(targetId, settings);
        } else {
            agentManager.addAgent(settings);
        }
    }

    if (typeof extensionSettings !== 'undefined') {
        if (extensionSettings.agent) {
            extensionSettings.agent = settings;
        } else if (extensionSettings.agents && extensionSettings.agents.length > 0) {
            const idx = extensionSettings.agents.findIndex(a => a.id === targetId);
            if (idx !== -1) {
                Object.assign(extensionSettings.agents[idx], settings);
            } else if (extensionSettings.agents.length > 0) {
                Object.assign(extensionSettings.agents[0], settings);
            }
        }
    }

    if (typeof saveSettings === 'function') {
        saveSettings();
    }

    if (agentManager && typeof agentManager.getEngine === 'function') {
        const engineId = targetId || (extensionSettings.agents?.[0]?.id);
        if (engineId) {
            delete agentManager.engines[engineId];
            const engine = agentManager.getEngine(engineId);
            if (engine) {
                agentEngine = engine;
            }
        }
    } else if (agentEngine) {
        agentEngine.context = agentEngine.context || {};
        agentEngine.context.settings = settings;
        agentEngine.context.permissions = {
            canCreate: settings.canCreate,
            canEdit: settings.canEdit,
            canDelete: settings.canDelete,
            canResearch: settings.canResearch,
            autoAccept: settings.autoAccept,
            autoAcceptConfidence: settings.autoAcceptConfidence,
            maxEntriesPerRun: settings.maxEntriesPerRun,
            requireKeyConfidence: settings.requireKeyConfidence,
            requireConfirmation: settings.requireConfirmation,
        };
    }

    renderDashboard();
    renderAgentSidebar();

    if (typeof showToast === 'function') {
        showToast('Agent settings saved');
    }
}

async function saveApiConfig() {
    const payload = {
        apiEndpoint: strVal('agent-api-endpoint'),
        model: strVal('agent-api-model'),
        temperature: floatVal('agent-api-temperature', 0.7),
        useSeparateApi: true,
    };

    try {
        await EL_apiFetch('PUT', '/agent/api-config', payload);
        if (typeof showToast === 'function') showToast('API config saved');
    } catch (e) {
        if (typeof showToast === 'function') showToast('Failed to save API config: ' + e.message);
    }
}

async function testConnection() {
    const connRadio = document.querySelector('input[name="agent-connection"]:checked');
    const useSeparate = connRadio && connRadio.value === 'separate-api';

    try {
        if (useSeparate) {
            const configResp = await EL_apiFetch('GET', '/agent/api-config');
            if (!configResp || !configResp.hasApiKey) {
                if (typeof showToast === 'function') showToast('No API key configured. Save API config first.');
                return;
            }
            const result = await EL_apiFetch('POST', '/agent/chat', {
                messages: [{ role: 'user', content: 'Hi' }],
                model: configResp.model || '',
                apiEndpoint: configResp.apiEndpoint || '',
                apiKey: '',
                maxTokens: 50,
                temperature: 0.7,
            });
            if (result?.choices?.[0]?.message?.content) {
                if (typeof showToast === 'function') showToast('Connection OK: received response');
            } else {
                if (typeof showToast === 'function') showToast('Connection OK but unexpected response format');
            }
        } else {
            const st = typeof stContext !== 'undefined' ? stContext : null;
            if (st?.generateRaw) {
                await st.generateRaw(
                    [{ role: 'user', content: 'Hi' }],
                    { max_tokens: 50, temperature: 0.7 },
                    null
                );
                if (typeof showToast === 'function') showToast('ST Pipeline OK');
            } else {
                if (typeof showToast === 'function') showToast('ST generateRaw not available');
            }
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('Connection failed: ' + e.message);
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

async function handleAcceptProposal(id) {
    const p = findProposal(id);
    if (!p) return;

    const settings = readAgentSettings();
    if (settings.requireConfirmation !== false) {
        if (!confirm('Accept this proposal?')) return;
    }

    try {
        await agentEngine.applyProposal(p);
        await EL_apiFetch('POST', '/proposals/update-status', {
            proposalId: p.id,
            status: 'accepted',
        });
        p.status = 'accepted';
        p.applied = true;
        renderProposalsFeed(proposals, activeFilter);
        if (typeof showToast === 'function') showToast('Proposal accepted and applied');
    } catch (e) {
        if (typeof showToast === 'function') showToast('Failed: ' + e.message);
    }
}

async function handleDenyProposal(id) {
    const p = findProposal(id);
    if (!p) return;

    try {
        await EL_apiFetch('POST', '/proposals/update-status', {
            proposalId: p.id,
            status: 'denied',
        });
        p.status = 'denied';
        renderProposalsFeed(proposals, activeFilter);
        if (typeof showToast === 'function') showToast('Proposal denied');
    } catch (e) {
        if (typeof showToast === 'function') showToast('Failed: ' + e.message);
    }
}

async function handleFeedback(id, text) {
    const p = findProposal(id);
    if (!p) return;

    try {
        await EL_apiFetch('POST', '/proposals/update-status', {
            proposalId: p.id,
            status: p.status,
            userFeedback: text,
        });

        try {
            if (agentEngine && typeof agentEngine.revise === 'function') {
                const revised = await agentEngine.revise(id, text);
                if (revised) {
                    Object.assign(p, revised);
                }
            }
        } catch (_) {}

        renderProposalsFeed(proposals, activeFilter);
        if (typeof showToast === 'function') showToast('Feedback recorded');
    } catch (e) {
        if (typeof showToast === 'function') showToast('Failed: ' + e.message);
    }
}

async function handleApplyProposal(id) {
    const p = findProposal(id);
    if (!p || p.applied) return;

    try {
        await agentEngine.applyProposal(p);
        p.applied = true;
        renderProposalsFeed(proposals, activeFilter);
        if (typeof showToast === 'function') showToast('Proposal applied');
    } catch (e) {
        if (typeof showToast === 'function') showToast('Failed: ' + e.message);
    }
}

async function handleAcceptAll() {
    const pending = proposals.filter(p => p.status === 'pending');
    if (pending.length === 0) return;
    if (!confirm('Accept and apply all ' + pending.length + ' pending proposals?')) return;

    let ok = 0;
    for (const p of pending) {
        try {
            await agentEngine.applyProposal(p);
            await EL_apiFetch('POST', '/proposals/update-status', {
                proposalId: p.id,
                status: 'accepted',
            });
            p.status = 'accepted';
            p.applied = true;
            ok++;
        } catch (_) {}
    }
    renderProposalsFeed(proposals, activeFilter);
    if (typeof showToast === 'function') showToast('Accepted ' + ok + '/' + pending.length + ' proposals');
}

async function handleDenyAll() {
    const pending = proposals.filter(p => p.status === 'pending');
    if (pending.length === 0) return;
    if (!confirm('Deny all ' + pending.length + ' pending proposals?')) return;

    let ok = 0;
    for (const p of pending) {
        try {
            await EL_apiFetch('POST', '/proposals/update-status', {
                proposalId: p.id,
                status: 'denied',
            });
            p.status = 'denied';
            ok++;
        } catch (_) {}
    }
    renderProposalsFeed(proposals, activeFilter);
    if (typeof showToast === 'function') showToast('Denied ' + ok + '/' + pending.length + ' proposals');
}

async function handleApplyAllAccepted() {
    const accepted = proposals.filter(p => (p.status === 'accepted' || p.status === 'auto-accepted') && !p.applied);
    if (accepted.length === 0) return;

    let ok = 0;
    for (const p of accepted) {
        try {
            await agentEngine.applyProposal(p);
            p.applied = true;
            ok++;
        } catch (_) {}
    }
    renderProposalsFeed(proposals, activeFilter);
    if (typeof showToast === 'function') showToast('Applied ' + ok + '/' + accepted.length + ' proposals');
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
                            try { window.currentLorebookData = await st.loadWorldInfo(currentLorebookName); } catch (_) {}
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
    const target = window.opener || window.parent;
    if (target) {
        target.postMessage({ source: 'enhanced-lorebook', type: 'el-pending-count', count }, window.location.origin);
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
    const engine = typeof agentManager !== 'undefined' && agentManager ? agentManager.getEngine(agent.id) : null;
    const status = engine?.state || 'idle';
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
        const engine = typeof agentManager !== 'undefined' && agentManager ? agentManager.getEngine(agent.id) : null;
        const status = engine?.state || 'idle';
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

    modal.style.display = 'flex';
}

function closeCreateAgentModal() {
    const modal = document.getElementById('create-agent-modal');
    if (modal) modal.style.display = 'none';
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

    let newAgent = {
        id: 'agent_' + Date.now(),
        name: name,
        enabled: true,
        mode: 'manual',
        taskDescription: task,
        customInstructions: '',
        canCreate: true,
        canEdit: true,
        canDelete: false,
        canResearch: false,
        autoAccept: false,
        autoAcceptConfidence: 0.8,
        maxEntriesPerRun: 5,
        requireKeyConfidence: 'low',
        maxPendingProposals: 20,
        requireConfirmation: true,
        interval: 10,
        useSeparateApi: false,
        apiEndpoint: '',
        apiModel: '',
        temperature: 0.7,
        research: { source: 'disabled', searxngUrl: '', searxngToken: '' },
    };

    if (copyFromId && typeof agentManager !== 'undefined' && agentManager) {
        const source = agentManager.getAgent(copyFromId);
        if (source) {
            newAgent = { ...source, id: 'agent_' + Date.now(), name: name, taskDescription: task };
        }
    }

    if (typeof agentManager !== 'undefined' && agentManager) {
        agentManager.addAgent(newAgent);
        if (typeof saveSettings === 'function') saveSettings();
    }

    closeCreateAgentModal();
    renderAgentSidebar();
    renderDashboard();

    if (typeof showToast === 'function') showToast('Agent "' + name + '" created');
}

async function duplicateAgent(agentId) {
    if (typeof agentManager === 'undefined' || !agentManager) return;
    const source = agentManager.getAgent(agentId);
    if (!source) return;

    const clone = { ...source, id: 'agent_' + Date.now(), name: source.name + ' (copy)', enabled: false };
    agentManager.addAgent(clone);
    if (typeof saveSettings === 'function') saveSettings();
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

function wireDashboardEvents() {
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

    grid.addEventListener('change', function (e) {
        const toggle = e.target.closest('.agent-toggle-enable');
        if (toggle) {
            toggleAgentEnabled(toggle.dataset.agentId, toggle.checked);
        }
    });

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

async function runSpecificAgent(agentId) {
    if (typeof agentManager === 'undefined' || !agentManager) return;

    const engine = agentManager.getEngine(agentId);
    if (engine?.state && engine.state !== 'idle') {
        if (typeof showToast === 'function') showToast('Agent is already running');
        return;
    }

    try {
        await agentManager.runAgent(agentId);
        await loadProposalsForCurrentChat();
        renderDashboard();
        if (typeof showToast === 'function') showToast('Agent run complete');
    } catch (e) {
        if (typeof showToast === 'function') showToast('Agent run failed: ' + e.message);
        renderDashboard();
    }
}
