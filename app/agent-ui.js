let currentChatId = null;
let proposals = [];
let activeFilter = 'all';
let chatPollInterval = null;
let backupClient = null;

function getChatId() {
    const st = typeof stContext !== 'undefined' ? stContext : null;
    const charId = st?.characterId ?? 'no-char';
    const chatFile = st?.chat?.chat_id ?? 'default';
    return charId + '_' + chatFile;
}

async function initAgentUI(context) {
    backupClient = new BackupClient(context || {});
    agentEngine = new AgentEngine(context || {});

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

    const chatIdEl = document.getElementById('agent-chat-id');
    if (chatIdEl) chatIdEl.textContent = 'Chat: ' + currentChatId;
}

function loadSettingsToConfig() {
    const settings = (typeof extensionSettings !== 'undefined' && extensionSettings?.agent) || {};

    setChecked('agent-enabled', settings.enabled !== false);
    setChecked('agent-perm-create', settings.canCreate !== false);
    setChecked('agent-perm-edit', settings.canEdit !== false);
    setChecked('agent-perm-delete', settings.canDelete === true);
    setChecked('agent-perm-research', settings.canResearch === true);
    setChecked('agent-perm-auto-accept', settings.autoAccept === true);

    const mode = settings.mode === 'periodic' ? 'periodic' : 'manual';
    const modeRadio = document.querySelector('input[name="agent-mode"][value="' + mode + '"]');
    if (modeRadio) modeRadio.checked = true;
    togglePeriodicConfig(mode === 'periodic');

    setVal('agent-periodic-interval', settings.periodicInterval ?? 10);

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
    return {
        enabled: document.getElementById('agent-enabled')?.checked !== false,
        mode: modeRadio ? modeRadio.value : 'manual',
        periodicInterval: intVal('agent-periodic-interval', 10),
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
}

function renderProposalsFeed(items, filter) {
    const container = document.getElementById('proposals-list');
    if (!container) return;

    container.innerHTML = '';

    const f = filter || 'all';
    let filtered = items;
    if (f !== 'all') {
        filtered = items.filter(p => p.status === f);
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

    let headerHtml = '<div class="proposal-card-header">';
    headerHtml += '<span class="proposal-status-badge ' + statusLabel + '">' + statusLabel.replace('-', ' ') + '</span>';
    headerHtml += '<i class="fa-solid ' + actionIcon + ' proposal-action-icon" style="color:' + actionColor + '"></i>';
    headerHtml += '<span class="proposal-lorebook">' + escapeHtml(p.lorebookName || '') + '</span>';
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
        saveBtn.addEventListener('click', saveAgentSettings);
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

async function saveAgentSettings() {
    const settings = readAgentSettings();

    if (typeof extensionSettings !== 'undefined') {
        if (!extensionSettings.agent) extensionSettings.agent = {};
        extensionSettings.agent = settings;
    }

    if (typeof saveSettings === 'function') {
        saveSettings();
    }

    if (agentEngine) {
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
    if (agentEngine?.state && agentEngine.state !== 'idle') {
        if (typeof showToast === 'function') showToast('Agent is already running');
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
        const settings = readAgentSettings();
        if (agentEngine) {
            agentEngine.context.settings = settings;
        }
        const result = await agentEngine.analyze('manual');
        await loadProposalsForCurrentChat();

        if (statusEl) {
            const msg = 'Analyzed. Created ' + result.proposalsCreated + ' proposal(s).';
            const accepted = result.autoAccepted || 0;
            const extra = accepted > 0 ? ' (' + accepted + ' auto-accepted)' : '';
            statusEl.innerHTML = '<span style="color:var(--success-color,#10b981);">' + msg + extra + '</span>';
        }
        if (typeof showToast === 'function') showToast('Agent run complete: ' + result.proposalsCreated + ' proposals');
    } catch (e) {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger-color);">Error: ' + e.message + '</span>';
        if (typeof showToast === 'function') showToast('Agent run failed: ' + e.message);
    } finally {
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.innerHTML = '<i class="fa-solid fa-play"></i> Run Agent Now';
        }
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
