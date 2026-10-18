const EXTENSION_NAME = 'Enhanced Lorebook UI';
const EXTENSION_DIR = 'ST-EnhancedLorebook';

function getExtensionUrl() {
    return `scripts/extensions/third-party/${EXTENSION_DIR}`;
}

let _csrfToken = null;
async function getCsrfToken() {
    try {
        const response = await fetch('/csrf-token');
        if (response.ok) {
            const data = await response.json();
            return data.token;
        }
    } catch (e) {
        console.error('Failed to fetch CSRF token', e);
    }
    const value = `; ${document.cookie}`;
    const parts = value.split('; X-CSRF-Token=');
    if (parts.length === 2) return parts.pop().split(';').shift();
    return '';
}

getCsrfToken().then(t => { _csrfToken = t; });

let appWindow = null;
let messageCounter = 0;
let lastPeriodicRun = 0;
let pendingPeriodicTrigger = false;
let pendingPeriodicAgentIds = null;
const periodicCounters = {};

function openStandaloneApp(tab = '') {
    // Reuse the existing app window instead of spawning a duplicate. Duplicate
    // windows were a primary cause of stale-copy whole-file overwrites that
    // silently deleted lorebook entries.
    if (appWindow && !appWindow.closed) {
        appWindow.focus();
        try {
            appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-navigate', tab }, window.location.origin);
        } catch (e) {
            console.error('Enhanced Lorebook: failed to navigate existing window', e);
        }
        if (pendingPeriodicTrigger) {
            const ids = pendingPeriodicAgentIds;
            pendingPeriodicTrigger = false;
            pendingPeriodicAgentIds = null;
            setTimeout(() => sendPeriodicTriggerToApp(ids), 1000);
        }
        return;
    }

    const baseUrl = getExtensionUrl();
    const token = _csrfToken || '';
    const params = new URLSearchParams({ csrf: token, v: Date.now() });
    if (tab) params.set('tab', tab);
    const url = `${baseUrl}/app/index.html?${params.toString()}`;
    appWindow = window.open(url, '_blank');
    window.__enhancedLorebookWindow = appWindow;
    if (pendingPeriodicTrigger) {
        const ids = pendingPeriodicAgentIds;
        pendingPeriodicTrigger = false;
        pendingPeriodicAgentIds = null;
        setTimeout(() => sendPeriodicTriggerToApp(ids), 1000);
    }
}

function sendPeriodicTriggerToApp(agentIds) {
    if (appWindow && !appWindow.closed) {
        const context = SillyTavern.getContext();
        const chatInfo = { characterId: context.characterId, chatId: context.chatId ?? context.chat?.chat_id };
        appWindow.postMessage({
            source: 'enhanced-lorebook',
            type: 'el-agent-periodic-trigger',
            chatInfo,
            messageCounter: messageCounter,
            agentIds: agentIds || undefined,
        }, window.location.origin);
    }
}

function sendChatChangedToApp() {
    if (appWindow && !appWindow.closed) {
        const context = SillyTavern.getContext();
        appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-chat-changed', characterId: context.characterId, chatId: context.chatId ?? context.chat?.chat_id }, window.location.origin);
    }
}

function sendSettingsSyncToApp(settings) {
    if (appWindow && !appWindow.closed) {
        appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-settings-sync', settings }, window.location.origin);
    }
}

function sendAgentsSyncToApp() {
    if (appWindow && !appWindow.closed) {
        const context = SillyTavern.getContext();
        const agents = context.extensionSettings?.SillyTavernEnhancedLorebook?.agents || [];
        appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-settings-sync', agents }, window.location.origin);
    }
}

function isAgentActiveForChat(agent, context) {
    if (!agent || agent.scope !== 'local') return true;
    const charId = context?.characterId ?? 'no-char';
    const chatFile = context?.chatId ?? context?.chat?.chat_id ?? 'default';
    const chatId = charId + '_' + chatFile;
    if (agent.boundCharacterId && String(agent.boundCharacterId) !== String(charId)) return false;
    if (agent.boundChatId && String(agent.boundChatId) !== String(chatId)) return false;
    return !!agent.boundChatId || !!agent.boundCharacterId;
}

async function getActiveCharacterLorebooks() {
    const context = SillyTavern.getContext();
    const charId = context?.characterId;

    // ST core stores this_chid as a string (setCharacterId stringifies it), so
    // accept both numeric strings and plain numbers.
    const charIndex = (charId !== undefined && charId !== null) ? Number(charId) : NaN;
    const character = (Number.isInteger(charIndex) && charIndex >= 0 && Array.isArray(context?.characters))
        ? context.characters[charIndex]
        : null;

    // Chat lore: lorebook attached to the active chat via chat_metadata['world_info'].
    // Works in single-character and group chats alike.
    const chatLorebook = (typeof context?.chatMetadata?.['world_info'] === 'string' && context.chatMetadata['world_info'])
        ? context.chatMetadata['world_info']
        : null;

    // Character lore: primary world + additional books (world_info.charLore), keyed by avatar filename.
    const characterLorebooks = [];
    let embeddedBook = null;
    if (character) {
        const primary = character?.data?.extensions?.world;
        if (typeof primary === 'string' && primary) {
            characterLorebooks.push(primary);
        } else {
            // Embedded-only lorebook that was never imported as a file.
            embeddedBook = character?.data?.character_book?.name;
            if (typeof embeddedBook === 'string' && embeddedBook) {
                characterLorebooks.push(embeddedBook);
            }
        }

        try {
            const wiModule = await import('/scripts/world-info.js');
            const fileName = (character?.avatar || '').replace(/\.[^/.]+$/, '');
            const entry = Array.isArray(wiModule.world_info?.charLore)
                ? wiModule.world_info.charLore.find(e => e && e.name === fileName)
                : null;
            const extraBooks = Array.isArray(entry?.extraBooks) ? entry.extraBooks.filter(Boolean) : [];
            for (const name of extraBooks) {
                if (!characterLorebooks.includes(name)) characterLorebooks.push(name);
            }
        } catch (e) {
            console.error('Enhanced Lorebook: failed to read character lorebooks', e);
        }
    }

    const result = {
        characterId: charId ?? null,
        characterName: character?.name || '',
        chatLorebook,
        characterLorebooks,
        embeddedBook,
    };
    console.debug('Enhanced Lorebook: active lorebooks =', result);
    return result;
}

// ── Legacy ST-native dynamic scan — REMOVED (Hub v2). ──
// Hub inline tools (hub-tools.js: ls/grep/read) inspect linked
// lorebooks at run time instead.

function handleNewMessage() {
    messageCounter++;
    // Reset per-agent counters when chat changes so intervals stay per-chat.
    try {
        const context = SillyTavern.getContext();
        const agents = context.extensionSettings?.SillyTavernEnhancedLorebook?.agents || [];
        if (!agents.length) return;

        const agentsToTrigger = [];
        for (const a of agents) {
            if (!a.enabled || a.mode !== 'periodic' || !isAgentActiveForChat(a, context)) continue;
            const interval = Math.max(1, Number(a.interval || a.periodicInterval || 10));
            periodicCounters[a.id] = (periodicCounters[a.id] || 0) + 1;
            if (periodicCounters[a.id] >= interval) {
                periodicCounters[a.id] = 0;
                agentsToTrigger.push(a);
            }
        }
        if (!agentsToTrigger.length) return;

        lastPeriodicRun = Date.now();

        const agentIds = agentsToTrigger.map(a => a.id);
        if (appWindow && !appWindow.closed) {
            sendPeriodicTriggerToApp(agentIds);
        } else {
            pendingPeriodicTrigger = true;
            pendingPeriodicAgentIds = agentIds;
        }
    } catch (e) {
        console.error('Enhanced Lorebook: handleNewMessage error', e);
    }
}

function setupPostMessageBridge() {
    window.addEventListener('message', async (e) => {
        if (e.origin !== window.location.origin) return;
        const msg = e.data;
        if (!msg || typeof msg !== 'object' || msg.source !== 'enhanced-lorebook') return;

        switch (msg.type) {
            case 'el-close': {
                break;
            }
            case 'el-agent-toast': {
                const toastText = typeof msg.message === 'string' ? msg.message : String(msg.message || '');
                if (!toastText) break;
                const type = ['success', 'info', 'warning', 'error'].includes(msg.toastType) ? msg.toastType : 'warning';
                try {
                    const fn = typeof toastr === 'object' && toastr && typeof toastr[type] === 'function' ? toastr[type] : toastr?.warning;
                    if (typeof fn === 'function') {
                        fn.call(toastr, toastText);
                    } else {
                        console.warn('Enhanced Lorebook: toastr unavailable, toast dropped:', toastText);
                    }
                } catch (e) {
                    console.error('Enhanced Lorebook: failed to show toast', e);
                }
                break;
            }
            case 'el-agent-trigger-now': {
                const context = SillyTavern.getContext();
                const agents = context.extensionSettings?.SillyTavernEnhancedLorebook?.agents || [];
                if (agents.length) {
                    handleNewMessage();
                }
                break;
            }
            case 'el-pending-count': {
                const badge = document.getElementById('agent-pending-badge');
                if (!badge) break;
                const count = Number(msg.count) || 0;
                badge.textContent = count > 99 ? '99+' : String(count);
                badge.style.display = count > 0 ? 'inline' : 'none';
                break;
            }
            case 'el-agent-trigger-periodic': {
                const ctx = SillyTavern.getContext();
                const triggered = (ctx.extensionSettings?.SillyTavernEnhancedLorebook?.agents || []).some(a => a.enabled && a.mode === 'periodic' && isAgentActiveForChat(a, ctx));
                if (triggered) {
                    handleNewMessage();
                }
                break;
            }
            case 'el-agent-request-chat-info': {
                const ctx2 = SillyTavern.getContext();
                if (e.source) {
                    const agents = ctx2.extensionSettings?.SillyTavernEnhancedLorebook?.agents || [];
                    e.source.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-chat-info', characterId: ctx2.characterId, chatId: ctx2.chatId ?? ctx2.chat?.chat_id, agents }, window.location.origin);
                }
                break;
            }
            // (Hub v2: el-agent-dynamic-scan bridge removed — hub tools inspect lorebooks.)
            case 'el-agent-request-chat-books': {
                // Chat's active lorebook set for the "Sync with chat" button.
                // Response: el-agent-chat-books { requestId, globalBooks, chatLorebook, characterLorebooks, embeddedBook }
                try {
                    let globalBooks = [];
                    try {
                        const wi = await import('/scripts/world-info.js');
                        if (Array.isArray(wi.selected_world_info)) globalBooks = [...wi.selected_world_info];
                    } catch {}
                    if (!globalBooks.length) {
                        try {
                            const sel = document.getElementById('world_info');
                            if (sel) globalBooks = Array.from(sel.selectedOptions).map(o => o.text).filter(Boolean);
                        } catch {}
                    }
                    const info = await getActiveCharacterLorebooks();
                    if (e.source) {
                        e.source.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-chat-books', requestId: msg.requestId || null, globalBooks, chatLorebook: info.chatLorebook, characterLorebooks: info.characterLorebooks, embeddedBook: info.embeddedBook }, window.location.origin);
                    }
                } catch (err) {
                    console.error('Enhanced Lorebook: chat books request failed', err);
                    if (e.source) {
                        e.source.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-chat-books', requestId: msg?.requestId || null, globalBooks: [], chatLorebook: null, characterLorebooks: [], embeddedBook: null }, window.location.origin);
                    }
                }
                break;
            }
            case 'el-agent-request-character-lorebooks': {
                try {
                    const info = await getActiveCharacterLorebooks();
                    if (e.source) {
                        e.source.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-character-lorebooks', ...info }, window.location.origin);
                    }
                } catch (err) {
                    console.error('Enhanced Lorebook: character lorebooks request failed', err);
                    if (e.source) {
                        e.source.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-character-lorebooks', characterId: null, characterName: '', chatLorebook: null, characterLorebooks: [], embeddedBook: null }, window.location.origin);
                    }
                }
                break;
            }
            case 'el-agent-settings-changed': {
                try {
                    const ctx3 = SillyTavern.getContext();
                    if (!ctx3.extensionSettings.SillyTavernEnhancedLorebook) ctx3.extensionSettings.SillyTavernEnhancedLorebook = {};
                    if (msg.agents && Array.isArray(msg.agents)) {
                        delete ctx3.extensionSettings.SillyTavernEnhancedLorebook.agent;
                        ctx3.extensionSettings.SillyTavernEnhancedLorebook.agents = msg.agents;
                    } else if (msg.settings) {
                        if (!ctx3.extensionSettings.SillyTavernEnhancedLorebook.agents) {
                            ctx3.extensionSettings.SillyTavernEnhancedLorebook.agents = [];
                        }
                        const idx = ctx3.extensionSettings.SillyTavernEnhancedLorebook.agents.findIndex(a => a.id === msg.settings.id);
                        if (idx !== -1) {
                            ctx3.extensionSettings.SillyTavernEnhancedLorebook.agents[idx] = msg.settings;
                        } else {
                            ctx3.extensionSettings.SillyTavernEnhancedLorebook.agent = msg.settings;
                        }
                    }
                    ctx3.saveSettingsDebounced();
                } catch (e) {
                    console.error('Enhanced Lorebook: settings changed error', e);
                }
                break;
            }
            case 'el-agent-quick-task-ack': {
                // The app window confirms it received the task; stop re-sending.
                const entry = pendingQuickTasks.get(msg.requestId);
                if (entry) {
                    entry.acked = true;
                    try { if (entry.retryId) clearInterval(entry.retryId); } catch (_) {}
                    entry.retryId = null;
                }
                break;
            }
            case 'el-agent-quick-task-result': {
                const entry = pendingQuickTasks.get(msg.requestId);
                if (!entry) break;
                pendingQuickTasks.delete(msg.requestId);
                try { if (entry.timerId) clearTimeout(entry.timerId); } catch (_) {}
                try { if (entry.retryId) clearInterval(entry.retryId); } catch (_) {}
                const name = entry?.agentName || 'Agent';
                if (msg.ok) {
                    const n = Number(msg.proposalsCreated || 0);
                    if (n > 0) {
                        try { toastr.success('Agent "' + name + '" finished — ' + n + ' proposal(s). See Review Changes.'); } catch (_) {}
                    } else if (Array.isArray(msg.warnings) && msg.warnings.length) {
                        try { toastr.warning('Agent "' + name + '" finished with warnings: ' + msg.warnings[0]); } catch (_) {}
                    } else {
                        try { toastr.info('Agent "' + name + '" finished — no proposals needed.'); } catch (_) {}
                    }
                } else {
                    try { toastr.error('Agent "' + name + '" failed: ' + (msg.error || 'unknown error')); } catch (_) {}
                }
                try { elRefreshQuickTaskBadge(); } catch (_) {}
                break;
            }
        }
    });
}

function injectLauncherStyles() {
    if (document.getElementById('enhanced-lorebook-launcher-styles')) return;
    const style = document.createElement('style');
    style.id = 'enhanced-lorebook-launcher-styles';
    style.textContent = `
        .el-launcher-dropdown {
            position: fixed;
            z-index: 30000;
            min-width: 210px;
            background: var(--SmartThemeBlurTintColor, rgba(20, 22, 28, 0.95));
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 10px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.55);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            padding: 6px;
            opacity: 0;
            transform: translateY(-8px) scale(0.96);
            pointer-events: none;
            transition: opacity 0.18s ease, transform 0.18s ease;
        }
        .el-launcher-dropdown.visible {
            opacity: 1;
            transform: translateY(0) scale(1);
            pointer-events: auto;
        }
        .el-launcher-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            border-radius: 7px;
            cursor: pointer;
            color: var(--SmartThemeBodyColor, #dcdfe4);
            font-size: 13.5px;
            font-family: inherit;
            transition: background 0.14s ease;
            user-select: none;
            white-space: nowrap;
        }
        .el-launcher-item:hover {
            background: rgba(255,255,255,0.08);
        }
        .el-launcher-item:active {
            background: rgba(255,255,255,0.13);
        }
        .el-launcher-item i {
            width: 20px;
            text-align: center;
            font-size: 15px;
            opacity: 0.85;
        }
        .el-launcher-item[data-action="enhanced"] i {
            color: var(--SmartThemeQuoteColor, #b4a0ff);
        }
        .el-launcher-item[data-action="agent-config"] i {
            color: #6cd4ff;
        }
        .el-launcher-item[data-action="agent-feed"] i {
            color: #ffb347;
        }
        .el-launcher-divider {
            height: 1px;
            margin: 4px 8px;
            background: rgba(255,255,255,0.08);
        }
        .el-launcher-scrim {
            position: fixed;
            inset: 0;
            z-index: 29999;
            display: none;
        }
        .el-launcher-scrim.visible {
            display: block;
        }
    `;
    document.head.appendChild(style);
}

function setupLauncherDropdown() {
    const wiDrawer = document.getElementById('WI-SP-button');
    if (!wiDrawer) {
        console.warn(`${EXTENSION_NAME}: WI button not found.`);
        return false;
    }

    const drawerToggle = wiDrawer.querySelector('.drawer-toggle');
    const drawerIcon = wiDrawer.querySelector('.drawer-icon');

    if (!drawerToggle || !drawerIcon) {
        console.warn(`${EXTENSION_NAME}: WI drawer elements not found.`);
        return false;
    }

    injectLauncherStyles();

    const dropdown = document.createElement('div');
    dropdown.id = 'el-launcher-dropdown';
    dropdown.className = 'el-launcher-dropdown';
    dropdown.innerHTML = `
        <div class="el-launcher-item" data-action="native">
            <i class="fa-solid fa-book-atlas"></i>
            <span>Normal Lorebook</span>
        </div>
        <div class="el-launcher-divider"></div>
        <div class="el-launcher-item" data-action="enhanced">
            <i class="fa-solid fa-book-open"></i>
            <span>Enhanced Lorebook</span>
        </div>
        <div class="el-launcher-divider"></div>
        <div class="el-launcher-item" data-action="agent-dashboard">
            <i class="fa-solid fa-robot"></i>
            <span>Agent Dashboard</span>
        </div>
        <div class="el-launcher-item" data-action="agent-feed">
            <i class="fa-solid fa-clipboard-list"></i>
            <span>Review Changes</span>
            <span id="agent-pending-badge" class="badge-count" style="display:none;">0</span>
        </div>
    `;

    const scrim = document.createElement('div');
    scrim.className = 'el-launcher-scrim';

    document.body.appendChild(scrim);
    document.body.appendChild(dropdown);

    if (getComputedStyle(drawerIcon).position === 'static') {
        drawerIcon.style.position = 'relative';
    }
    const chevron = document.createElement('i');
    chevron.className = 'fa-solid fa-caret-down charlib-chevron-badge';
    Object.assign(chevron.style, {
        position: 'absolute',
        bottom: '2px',
        right: '0px',
        fontSize: '7px',
        opacity: '0.5',
        pointerEvents: 'none',
        color: 'var(--SmartThemeBodyColor, #dcdfe4)',
    });
    drawerIcon.appendChild(chevron);

    let isOpen = false;
    let bypassIntercept = false;

    function positionDropdown() {
        const rect = drawerIcon.getBoundingClientRect();
        dropdown.style.top = (rect.bottom + 6) + 'px';
        dropdown.style.right = Math.max(8, window.innerWidth - rect.right - 10) + 'px';
        dropdown.style.left = 'auto';
    }

    function show() {
        positionDropdown();
        scrim.classList.add('visible');
        dropdown.classList.add('visible');
        isOpen = true;
    }

    function hide() {
        scrim.classList.remove('visible');
        dropdown.classList.remove('visible');
        isOpen = false;
    }

    const worldInfoContent = document.getElementById('WorldInfo');

    document.addEventListener('click', (e) => {
        if (!drawerToggle.contains(e.target)) return;

        if (bypassIntercept) {
            bypassIntercept = false;
            return;
        }

        if (worldInfoContent && worldInfoContent.classList.contains('openDrawer')) {
            if (isOpen) hide();
            return;
        }

        e.stopPropagation();
        e.preventDefault();

        if (isOpen) {
            hide();
        } else {
            show();
        }
    }, true);

    scrim.addEventListener('click', () => hide());

    dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;

        e.stopPropagation();
        hide();

        if (item.dataset.action === 'native') {
            bypassIntercept = true;
            drawerToggle.click();
        } else if (item.dataset.action === 'enhanced') {
            openStandaloneApp();
        } else if (item.dataset.action === 'agent-dashboard') {
            openStandaloneApp('agent-dashboard');
        } else if (item.dataset.action === 'agent-feed') {
            openStandaloneApp('agent-feed');
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen) {
            e.stopPropagation();
            hide();
        }
    });

    return true;
}

// ── Quick-task: wand button + popup + slash, dispatched to the app window ──
// Lets the user pick an agent and give it a one-shot task from the chat bar,
// with a configurable RP message window (none/all/first/last/range), an
// optional hub API profile override, and snapshot toggles (character card,
// author note, lorebooks, static injects).
// Quick tasks are dispatched to the Enhanced Lorebook app window (which owns
// the lorebook guard) via postMessage; the app window runs the agent and
// posts the result back. Proposals land in Review Changes for review.

const EL_QUICK_SETTINGS_KEY = 'SillyTavernEnhancedLorebook';
const pendingQuickTasks = new Map();

function elEscapeHtmlQt(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function elGetQuickTaskAgents() {
    try {
        const context = SillyTavern.getContext();
        const agents = context.extensionSettings?.[EL_QUICK_SETTINGS_KEY]?.agents;
        return Array.isArray(agents) ? agents : [];
    } catch (_) {
        return [];
    }
}

async function elRefreshQuickTaskBadge() {
    try {
        const context = SillyTavern.getContext();
        const charId = context?.characterId ?? 'no-char';
        const chatFile = context?.chatId ?? context?.chat?.chat_id ?? 'default';
        const chatId = charId + '_' + chatFile;
        const headers = (typeof context?.getRequestHeaders === 'function') ? context.getRequestHeaders() : { 'Content-Type': 'application/json' };
        const resp = await fetch('/api/plugins/enhanced-lorebook-agent/proposals/list?chatId=' + encodeURIComponent(chatId), { headers });
        if (!resp.ok) return;
        const data = await resp.json().catch(() => null);
        const count = (data?.proposals || []).filter(p => p.status === 'pending').length;
        const badge = document.getElementById('agent-pending-badge');
        if (badge) {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.style.display = count > 0 ? 'inline' : 'none';
        }
    } catch (e) {
        console.error('Enhanced Lorebook: quick-task badge refresh failed', e);
    }
}

// ── Quick-task options: message window + profile + context toggles ──
// Shape mirrors the World Info Recommender's contextToSend.messages
// (none | all | first | last | range) plus a hub API profile name override
// and snapshot toggles.
const EL_QUICK_DEFAULT_OPTS = {
    profileId: '',
    messages: { type: 'last', first: 10, last: 10, range: { start: 0, end: 10 } },
    includeCharCard: true,
    includeAuthorNote: true,
    includeWorldInfo: true,
    includeInjected: true,
};

function elCloneQuickOpts() {
    return JSON.parse(JSON.stringify(EL_QUICK_DEFAULT_OPTS));
}

function elClampInt(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

function elSanitizeQuickMessages(m) {
    const src = (m && typeof m === 'object') ? m : {};
    const type = ['none', 'all', 'first', 'last', 'range'].includes(src.type) ? src.type : 'last';
    const r = (src.range && typeof src.range === 'object') ? src.range : {};
    const start = elClampInt(r.start, 0, 100000, 0);
    let end = elClampInt(r.end, 0, 100000, 10);
    if (end < start) end = start;
    return {
        type,
        first: elClampInt(src.first, 1, 500, 10),
        last: elClampInt(src.last, 1, 500, 10),
        range: { start, end },
    };
}

function elSanitizeQuickOpts(input) {
    const src = (input && typeof input === 'object') ? input : {};
    return {
        profileId: typeof src.profileId === 'string' ? src.profileId.trim().slice(0, 120) : '',
        messages: elSanitizeQuickMessages(src.messages),
        includeCharCard: src.includeCharCard !== false,
        includeAuthorNote: src.includeAuthorNote !== false,
        includeWorldInfo: src.includeWorldInfo !== false,
        includeInjected: src.includeInjected !== false,
        // Granular one-shot exclusions (chat message IDs, "12, 15-18").
        excludeIds: elSanitizeIdList(src.excludeIds),
    };
}

// Parses "12, 15-18" / arrays into a sorted unique int list (cap 200).
function elSanitizeIdList(v) {
    const out = [];
    const push = (n) => {
        const i = Number(n);
        if (Number.isInteger(i) && i >= 0 && i <= 100000 && !out.includes(i)) out.push(i);
    };
    try {
        if (Array.isArray(v)) {
            for (const x of v) push(x);
        } else if (typeof v === 'string' && v.trim()) {
            for (const part of v.split(',')) {
                const t = part.trim();
                if (!t) continue;
                const rm = /^(\d+)\s*-\s*(\d+)$/.exec(t);
                if (rm) {
                    const lo = Math.min(Number(rm[1]), Number(rm[2]));
                    const hi = Math.max(Number(rm[1]), Number(rm[2]));
                    for (let i = lo; i <= hi && out.length < 200; i++) push(i);
                } else push(t);
                if (out.length >= 200) break;
            }
        }
    } catch (_) {}
    return out.sort((a, b) => a - b);
}

// ── Unified-context adapters ──
// The popup / /el-run still speak legacy quick-opts; the agent stores
// context. Popup controls act as ONE-SHOT overrides merged over the stored
// context for that run only (see EL_mergeContextOverride).
function elContextToQuickOpts(ctx, profileId) {
    const c = (ctx && typeof ctx === 'object') ? ctx : {};
    const m = (c.messages && typeof c.messages === 'object') ? c.messages : {};
    const s = (c.sources && typeof c.sources === 'object') ? c.sources : {};
    let type = ['none', 'all', 'last', 'range'].includes(m.mode) ? m.mode : 'last';
    let first = 10;
    const last = Math.max(1, Math.min(1000, Number(m.last) || 10));
    let range = { start: Math.max(0, Number(m.start) || 0), end: Math.max(0, Number(m.end) || 10) };
    if (range.end < range.start) range.end = range.start;
    if (type === 'range' && range.start === 0) { type = 'first'; first = Math.max(1, range.end); }
    return elSanitizeQuickOpts({
        profileId: typeof profileId === 'string' ? profileId : '',
        messages: { type, first, last, range },
        includeCharCard: !s.charCard || s.charCard.enabled !== false,
        includeAuthorNote: !s.authorNote || s.authorNote.enabled !== false,
        includeWorldInfo: !s.worldInfo || s.worldInfo.enabled !== false,
        includeInjected: !s.injected || s.injected.enabled !== false,
    });
}

// The quick-opts -> unified-context conversion now lives in the app window
// (agent-ui.js: EL_quickOptsToContextOverride), which is where the run happens.

// Last-used globals, persisted under the extension settings key.
function elGetQuickGlobals() {
    try {
        const context = SillyTavern.getContext();
        const stored = context.extensionSettings?.[EL_QUICK_SETTINGS_KEY]?.quickTask;
        if (stored && typeof stored === 'object') return elSanitizeQuickOpts(stored);
    } catch (_) {}
    return elCloneQuickOpts();
}

function elSaveQuickGlobals(opts) {
    try {
        const context = SillyTavern.getContext();
        if (!context.extensionSettings[EL_QUICK_SETTINGS_KEY]) context.extensionSettings[EL_QUICK_SETTINGS_KEY] = {};
        context.extensionSettings[EL_QUICK_SETTINGS_KEY].quickTask = elSanitizeQuickOpts(opts);
        context.saveSettingsDebounced();
    } catch (e) {
        console.error('Enhanced Lorebook: failed to save quick-task options', e);
    }
}

// Per-agent one-shot starting values for the popup: the agent's stored
// unified context translated back to popup controls (+ profile override).
// null when the agent has none, so the popup falls back to globals.
function elGetAgentQuickDefaults(agent) {
    try {
        if (agent && typeof agent === 'object') {
            const qd = (agent.quickDefaults && typeof agent.quickDefaults === 'object') ? agent.quickDefaults : {};
            let ctx = (agent.context && typeof agent.context === 'object') ? agent.context : null;
            if (!ctx && typeof EL_resolveAgentContext === 'function') {
                try { ctx = EL_resolveAgentContext(agent); } catch (_) { ctx = null; }
            }
            if (ctx) return elContextToQuickOpts(ctx, qd.profileId || '');
            if (agent.quickDefaults) return elSanitizeQuickOpts(agent.quickDefaults);
        }
    } catch (_) {}
    return null;
}

function elListHubProfiles() {
    // Hub v2: profiles live in ST-RequestHub (name + URL + key + model).
    // The profile NAME is what travels in the request JSON.
    try {
        const hub = globalThis.STRequestHub;
        if (!hub || typeof hub.listApiProfiles !== 'function') return [];
        const list = hub.listApiProfiles() || [];
        return list
            .filter(p => p && p.name)
            .map(p => ({ id: String(p.name), name: String(p.name), model: String(p.model || '') }));
    } catch (_) { return []; }
}

function elStripHtmlForQuick(s) {
    return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// NOTE: history + snapshot assembly now lives in app/context-builder.js
// (EL_buildAgentContextAsync) — the unified builder for all run paths.
// elBuildQuickHistory / elBuildQuickContextBlock were removed; the popup opts
// travel to the app window, which converts them into a one-shot context
// override for that run only.

function elCountRpMessages(chat) {
    try {
        let n = 0;
        for (const m of (Array.isArray(chat) ? chat : [])) {
            if (m && !m.is_system && String(m.mes ?? '').trim()) n++;
        }
        return n;
    } catch (_) { return 0; }
}

async function elRunQuickTask(agentId, taskText, runOpts) {
    let agentName = 'Agent';
    try {
        const task = String(taskText || '').trim();
        if (!task) { try { toastr.warning('Task is empty.'); } catch (_) {} return; }
        let context = null;
        try { context = SillyTavern.getContext(); } catch (_) { try { toastr.error('SillyTavern context unavailable'); } catch (_) {} return; }
        const agent = elGetQuickTaskAgents().find(a => a && a.id === agentId);
        if (!agent) { try { toastr.warning('Agent not found.'); } catch (_) {} return; }
        agentName = agent.name || 'Unnamed';
        if (agent.enabled === false) { try { toastr.warning('Agent "' + agentName + '" is disabled.'); } catch (_) {} return; }
        if (!isAgentActiveForChat(agent, context)) { try { toastr.warning('Agent "' + agentName + '" is bound to another chat.'); } catch (_) {} return; }
        const opts = elSanitizeQuickOpts(runOpts || elGetQuickGlobals());
        elSaveQuickGlobals(opts);
        let profileOverride = (opts.profileId || '').trim();
        if (profileOverride) {
            try {
                const hub = globalThis.STRequestHub;
                const names = (hub && typeof hub.listApiProfiles === 'function')
                    ? hub.listApiProfiles().map(p => p && p.name).filter(Boolean)
                    : [];
                if (!names.includes(profileOverride)) {
                    try { toastr.warning('Hub API profile "' + profileOverride + '" not found — using agent default.'); } catch (_) {}
                    profileOverride = '';
                }
            } catch (_) {}
        }
        if (!appWindow || appWindow.closed) {
            openStandaloneApp('agent-dashboard');
        }
        if (!appWindow || appWindow.closed) { try { toastr.error('Could not open the Enhanced Lorebook window — quick tasks now run there.'); } catch (_) {} return; }
        const requestId = 'qt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const entry = { agentName, startedAt: Date.now(), timerId: null, retryId: null, acked: false, attempts: 0 };
        const payload = {
            source: 'enhanced-lorebook',
            type: 'el-agent-quick-task',
            requestId,
            agentId,
            task,
            opts: {
                profileId: profileOverride,
                messages: { type: opts.messages.type, first: opts.messages.first, last: opts.messages.last, range: { start: opts.messages.range.start, end: opts.messages.range.end } },
                includeCharCard: opts.includeCharCard,
                includeAuthorNote: opts.includeAuthorNote,
                includeWorldInfo: opts.includeWorldInfo,
                includeInjected: opts.includeInjected,
                excludeIds: opts.excludeIds || [],
            },
        };
        const stopRetry = () => { try { if (entry.retryId) clearInterval(entry.retryId); } catch (_) {} entry.retryId = null; };
        const postTask = () => {
            try {
                if (appWindow && !appWindow.closed) appWindow.postMessage(payload, window.location.origin);
            } catch (_) {}
        };
        entry.timerId = setTimeout(() => {
            try {
                if (pendingQuickTasks.has(requestId)) {
                    pendingQuickTasks.delete(requestId);
                    stopRetry();
                    try { toastr.warning('Agent "' + agentName + '" did not report back — check the Enhanced Lorebook window.'); } catch (_) {}
                }
            } catch (_) {}
        }, 10 * 60 * 1000);
        // The app window may have just been opened, so its message listener may
        // not be registered yet — keep re-sending until it acknowledges receipt.
        entry.retryId = setInterval(() => {
            if (entry.acked || !pendingQuickTasks.has(requestId)) { stopRetry(); return; }
            entry.attempts++;
            if (entry.attempts > 25) { stopRetry(); return; } // ~20s; the 10-min timeout still warns
            postTask();
        }, 800);
        pendingQuickTasks.set(requestId, entry);
        postTask();
        try { toastr.info('Agent "' + agentName + '" started in the Enhanced Lorebook window — review the results in Review Changes.'); } catch (_) {}
    } catch (e) {
        console.error('Enhanced Lorebook: quick-task failed', e);
        try { toastr.error('Agent "' + agentName + '" failed: ' + (e?.message || e)); } catch (_) {}
    }
}

function elReadQuickDialog(dlg) {
    const v = (s) => { try { const el = dlg.querySelector(s); return el ? el.value : ''; } catch (_) { return ''; } };
    const c = (s, fb) => { try { const el = dlg.querySelector(s); return el ? !!el.checked : fb; } catch (_) { return fb; } };
    return elSanitizeQuickOpts({
        profileId: v('#el-quick-profile'),
        messages: {
            type: v('#el-quick-msgtype'),
            first: v('#el-quick-first'),
            last: v('#el-quick-last'),
            range: { start: v('#el-quick-range-start'), end: v('#el-quick-range-end') },
        },
        includeCharCard: c('#el-quick-inc-char', true),
        includeAuthorNote: c('#el-quick-inc-author', true),
        includeWorldInfo: c('#el-quick-inc-wi', true),
        includeInjected: c('#el-quick-inc-inj', true),
    });
}

// Deep-ish merge for partial overrides (/el-run args): {messages:{...}}
// merges onto the base instead of replacing it.
function elMergeQuickOpts(base, partial) {
    const b = elSanitizeQuickOpts(base);
    const p = (partial && typeof partial === 'object') ? partial : {};
    const pm = (p.messages && typeof p.messages === 'object') ? p.messages : {};
    const pr = (pm.range && typeof pm.range === 'object') ? pm.range : {};
    return elSanitizeQuickOpts({
        ...b,
        ...p,
        messages: { ...b.messages, ...pm, range: { ...b.messages.range, ...pr } },
    });
}

// Parses: profile="Name" | last=N | first=N | range=A-B | msgs=none|all |
// excl=1,5-9 — everything else stays task text.
function elParseQuickSlashArgs(raw) {
    const out = { opts: {}, task: '' };
    let s = String(raw || '');
    const pm = s.match(/profile\s*=\s*("[^"]+"|\S+)/);
    if (pm) {
        let v = pm[1];
        if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        // Accept a profile name or id; resolve to id later against live list.
        out.opts.profileName = v;
        s = s.replace(pm[0], ' ');
    }
    const lm = s.match(/\blast\s*=\s*(\d+)/);
    if (lm) { out.opts.messages = Object.assign(out.opts.messages || {}, { type: 'last', last: parseInt(lm[1], 10) }); s = s.replace(lm[0], ' '); }
    const fm = s.match(/\bfirst\s*=\s*(\d+)/);
    if (fm) { out.opts.messages = Object.assign(out.opts.messages || {}, { type: 'first', first: parseInt(fm[1], 10) }); s = s.replace(fm[0], ' '); }
    const rm = s.match(/\brange\s*=\s*(\d+)\s*-\s*(\d+)/);
    if (rm) { out.opts.messages = Object.assign(out.opts.messages || {}, { type: 'range', range: { start: parseInt(rm[1], 10), end: parseInt(rm[2], 10) } }); s = s.replace(rm[0], ' '); }
    const mm = s.match(/\bmsgs\s*=\s*(none|all|first|last|range)/);
    if (mm) {
        out.opts.messages = Object.assign(out.opts.messages || {}, { type: mm[1] });
        s = s.replace(mm[0], ' ');
    }
    const xm = s.match(/\bexcl\s*=\s*([\d,\s-]+)/);
    if (xm) {
        out.opts.excludeIds = xm[1].trim();
        s = s.replace(xm[0], ' ');
    }
    out.task = s.replace(/\s+/g, ' ').trim();
    return out;
}

async function openElQuickPrompt(prefill) {
    const agents = elGetQuickTaskAgents();
    if (!agents.length) {
        try { toastr.warning('No agents yet — create one in Enhanced Lorebook → Agent Dashboard first.'); } catch (_) {}
        return;
    }
    let context = null;
    try { context = SillyTavern.getContext(); } catch (_) {}
    const activeAgents = agents.filter(a => { try { return isAgentActiveForChat(a, context); } catch (_) { return true; } });
    const fallbackList = activeAgents.length ? activeAgents : agents;
    const byId = {};
    try { for (const a of agents) { if (a && a.id) byId[a.id] = a; } } catch (_) {}
    const profiles = elListHubProfiles();
    const rpCount = elCountRpMessages(context?.chat);
    const globals = elGetQuickGlobals();
    const firstAgent = (fallbackList[0] && byId[fallbackList[0].id]) || fallbackList[0];
    let baseOpts = (firstAgent && elGetAgentQuickDefaults(firstAgent)) || globals;
    let prefillTask = '';
    if (typeof prefill === 'string') {
        prefillTask = prefill;
    } else if (prefill && typeof prefill === 'object') {
        prefillTask = String(prefill.task || '');
        const po = (prefill.opts && typeof prefill.opts === 'object') ? { ...prefill.opts } : {};
        // /el-run may pass a hub profile NAME — resolve against the live hub list.
        if (po.profileName && !po.profileId) {
            try {
                const needle = String(po.profileName).toLowerCase();
                const hit = profiles.find(p => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle)
                    || profiles.find(p => p.name.toLowerCase().includes(needle));
                if (hit) po.profileId = hit.id;
                else try { toastr.warning('Hub API profile "' + po.profileName + '" not found — using agent default.'); } catch (_) {}
            } catch (_) {}
            delete po.profileName;
        }
        baseOpts = elMergeQuickOpts(baseOpts, po);
    }
    baseOpts = elSanitizeQuickOpts(baseOpts);
    const options = agents.map(a => {
        let disabled = false;
        try { disabled = !isAgentActiveForChat(a, context); } catch (_) {}
        const suffix = (a.enabled === false ? ' (disabled)' : '') + (disabled ? ' (other chat)' : '');
        return '<option value="' + elEscapeHtmlQt(a.id) + '"' + (disabled ? ' disabled' : '') + '>' + elEscapeHtmlQt((a.name || 'Unnamed') + suffix) + '</option>';
    }).join('');
    const profileOptions = '<option value="">Agent default (hub profile / ST backend)</option>' + profiles.map(p => {
        const bits = [p.name];
        if (p.model) bits.push(p.model);
        return '<option value="' + elEscapeHtmlQt(p.id) + '">' + elEscapeHtmlQt(bits.join(' \u00B7 ')) + '</option>';
    }).join('');
    const msgTypeOptions = [['none', 'None'], ['all', 'All messages'], ['first', 'First X messages'], ['last', 'Last X messages'], ['range', 'Range']]
        .map(([v, l]) => '<option value="' + v + '"' + (baseOpts.messages.type === v ? ' selected' : '') + '>' + l + '</option>').join('');
    const chk = (on) => on ? ' checked' : '';
    const content = ''
        + '<h3>Ask Lorebook Agent</h3>'
        + '<div class="world_entry_form_control"><label for="el-quick-agent">Agent</label>'
        + '<select id="el-quick-agent" class="text_pole">' + options + '</select></div>'
        + '<div class="world_entry_form_control"><label for="el-quick-task">Task (one-shot — not saved, no history carried over)</label>'
        + '<textarea id="el-quick-task" class="text_pole" rows="5" placeholder="e.g. Create an entry for the tavern the party just entered…"></textarea></div>'
        + '<h4 style="margin:10px 0 4px;">Model</h4>'
        + '<div class="world_entry_form_control"><label for="el-quick-profile">Hub API profile override (empty = agent default)</label>'
        + '<select id="el-quick-profile" class="text_pole">' + profileOptions + '</select>'
        + '<div id="el-quick-profile-note" style="opacity:0.7;font-size:0.82rem;"></div></div>'
        + '<h4 style="margin:10px 0 4px;">Context to send</h4>'
        + '<div class="world_entry_form_control"><label for="el-quick-msgtype">RP messages to include (<span id="el-quick-chatcount">' + rpCount + '</span> in chat; ST system messages skipped)</label>'
        + '<select id="el-quick-msgtype" class="text_pole">' + msgTypeOptions + '</select></div>'
        + '<div class="world_entry_form_control" id="el-quick-first-row" style="display:none;"><label for="el-quick-first">First N messages</label>'
        + '<input id="el-quick-first" type="number" class="text_pole" min="1" max="500" value="' + baseOpts.messages.first + '"></div>'
        + '<div class="world_entry_form_control" id="el-quick-last-row" style="display:none;"><label for="el-quick-last">Last N messages</label>'
        + '<input id="el-quick-last" type="number" class="text_pole" min="1" max="500" value="' + baseOpts.messages.last + '"></div>'
        + '<div class="world_entry_form_control" id="el-quick-range-row" style="display:none;"><label>Range (chat message IDs; exclusions live in the agent config)</label>'
        + '<div style="display:flex;gap:6px;"><input id="el-quick-range-start" type="number" class="text_pole" min="0" max="100000" value="' + baseOpts.messages.range.start + '" title="Start">'
        + '<input id="el-quick-range-end" type="number" class="text_pole" min="0" max="100000" value="' + baseOpts.messages.range.end + '" title="End"></div></div>'
        + '<label class="checkbox_label"><input type="checkbox" id="el-quick-inc-char"' + chk(baseOpts.includeCharCard) + '> Active character card</label><br>'
        + '<label class="checkbox_label"><input type="checkbox" id="el-quick-inc-author"' + chk(baseOpts.includeAuthorNote) + '> Author note</label><br>'
        + '<label class="checkbox_label"><input type="checkbox" id="el-quick-inc-wi"' + chk(baseOpts.includeWorldInfo) + '> Lorebook snapshot (names + entry counts)</label><br>'
        + '<label class="checkbox_label"><input type="checkbox" id="el-quick-inc-inj"' + chk(baseOpts.includeInjected) + '> Agent&rsquo;s static injected context</label>'
        + '<div style="opacity:0.7;font-size:0.82rem;margin-top:6px;">Runs in the background while you keep roleplaying. Proposals land in Review Changes.</div>';
    try {
        const { Popup, POPUP_TYPE, POPUP_RESULT } = await import('/scripts/popup.js');
        const captured = { agentId: (fallbackList[0] && fallbackList[0].id) || '', task: prefillTask, opts: baseOpts };
        const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
            wide: true,
            allowVerticalScrolling: true,
            okButton: 'Run in background',
            cancelButton: 'Cancel',
            onClosing: (pop) => {
                try {
                    const sel = pop.dlg.querySelector('#el-quick-agent');
                    const ta = pop.dlg.querySelector('#el-quick-task');
                    if (sel && sel.value) captured.agentId = sel.value;
                    if (ta) captured.task = ta.value;
                    captured.opts = elReadQuickDialog(pop.dlg);
                } catch (_) {}
                return true;
            },
        });
        try {
            const dlg = popup.dlg;
            const q = (s) => dlg.querySelector(s);
            const sel = q('#el-quick-agent');
            if (sel && captured.agentId) sel.value = captured.agentId;
            const ta = q('#el-quick-task');
            if (ta && prefillTask) ta.value = prefillTask;
            const refreshRows = () => {
                try {
                    const t = q('#el-quick-msgtype') ? q('#el-quick-msgtype').value : 'last';
                    if (q('#el-quick-first-row')) q('#el-quick-first-row').style.display = t === 'first' ? '' : 'none';
                    if (q('#el-quick-last-row')) q('#el-quick-last-row').style.display = t === 'last' ? '' : 'none';
                    if (q('#el-quick-range-row')) q('#el-quick-range-row').style.display = t === 'range' ? '' : 'none';
                } catch (_) {}
            };
            const refreshProfileState = () => {
                try {
                    const psel = q('#el-quick-profile');
                    const note = q('#el-quick-profile-note');
                    if (!psel) return;
                    if (!profiles.length) {
                        psel.disabled = true;
                        if (note) note.textContent = 'No hub API profiles — agent default (hub default / ST backend) will be used.';
                    } else {
                        psel.disabled = false;
                        if (note) note.textContent = '';
                    }
                } catch (_) {}
            };
            const applyOpts = (o) => {
                try {
                    const oo = elSanitizeQuickOpts(o);
                    if (q('#el-quick-profile')) q('#el-quick-profile').value = oo.profileId || '';
                    if (q('#el-quick-msgtype')) q('#el-quick-msgtype').value = oo.messages.type;
                    if (q('#el-quick-first')) q('#el-quick-first').value = String(oo.messages.first);
                    if (q('#el-quick-last')) q('#el-quick-last').value = String(oo.messages.last);
                    if (q('#el-quick-range-start')) q('#el-quick-range-start').value = String(oo.messages.range.start);
                    if (q('#el-quick-range-end')) q('#el-quick-range-end').value = String(oo.messages.range.end);
                    if (q('#el-quick-inc-char')) q('#el-quick-inc-char').checked = oo.includeCharCard;
                    if (q('#el-quick-inc-author')) q('#el-quick-inc-author').checked = oo.includeAuthorNote;
                    if (q('#el-quick-inc-wi')) q('#el-quick-inc-wi').checked = oo.includeWorldInfo;
                    if (q('#el-quick-inc-inj')) q('#el-quick-inc-inj').checked = oo.includeInjected;
                    refreshRows();
                    refreshProfileState();
                } catch (_) {}
            };
            if (q('#el-quick-profile') && baseOpts.profileId) q('#el-quick-profile').value = baseOpts.profileId;
            if (sel) sel.addEventListener('change', () => {
                try {
                    const ag = sel.value ? byId[sel.value] : null;
                    applyOpts((ag && elGetAgentQuickDefaults(ag)) || globals);
                } catch (_) {}
            });
            if (q('#el-quick-msgtype')) q('#el-quick-msgtype').addEventListener('change', refreshRows);
            refreshRows();
            refreshProfileState();
        } catch (_) {}
        const result = await popup.show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        if (!captured.agentId) { try { toastr.warning('Select an agent.'); } catch (_) {} return; }
        elRunQuickTask(captured.agentId, captured.task, captured.opts);
    } catch (e) {
        console.error('Enhanced Lorebook: quick prompt failed', e);
        try { toastr.error('Could not open agent prompt: ' + (e?.message || e)); } catch (_) {}
    }
}

function addElWandButton(retries) {
    if (typeof retries !== 'number') retries = 40;
    try {
        if (document.getElementById('el-quick-wand')) return true;
        const menu = document.getElementById('extensionsMenu');
        if (!menu) {
            if (retries > 0) setTimeout(() => addElWandButton(retries - 1), 500);
            return false;
        }
        const container = document.createElement('div');
        container.id = 'el-quick-wand';
        container.className = 'extension_container interactable';
        container.setAttribute('tabindex', '0');
        container.setAttribute('title', 'Ask a lorebook agent to do a one-shot task in the background');
        const item = document.createElement('div');
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.setAttribute('tabindex', '0');
        const icon = document.createElement('div');
        icon.className = 'fa-fw fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton';
        const label = document.createElement('span');
        label.textContent = 'Ask Lorebook Agent';
        item.appendChild(icon);
        item.appendChild(label);
        container.appendChild(item);
        const open = () => {
            try { if (window.jQuery) jQuery('#extensionsMenu').hide(); } catch (_) {}
            openElQuickPrompt('');
        };
        container.addEventListener('click', open);
        container.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
        menu.appendChild(container);
        return true;
    } catch (e) {
        console.error('Enhanced Lorebook: failed to add wand button', e);
        return false;
    }
}

let elSlashRegistered = false;
async function registerElSlash() {
    if (elSlashRegistered) return;
    try {
        const { SlashCommandParser } = await import('/scripts/slash-commands/SlashCommandParser.js');
        const { SlashCommand } = await import('/scripts/slash-commands/SlashCommand.js');
        const { SlashCommandArgument, ARGUMENT_TYPE } = await import('/scripts/slash-commands/SlashCommandArgument.js');
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'el-run',
            callback: async (args, value) => {
                try {
                    const parsed = elParseQuickSlashArgs(String(value || ''));
                    openElQuickPrompt({ task: parsed.task, opts: parsed.opts });
                } catch (_) {
                    openElQuickPrompt(String(value || ''));
                }
                return '';
            },
            helpString: 'Open the Enhanced Lorebook quick-task popup. Options: profile="Name" last=N first=N range=A-B msgs=none|all excl=1,5-9 — rest is task text. E.g. /el-run last=20 profile="My Preset" summarize the tavern scene',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({ description: 'options + task text to prefill (profile="Name" last=N first=N range=A-B msgs=none|all excl=1,5-9)', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
            ],
            returns: 'empty string',
        }));
        elSlashRegistered = true;
    } catch (e) {
        console.error('Enhanced Lorebook: slash registration failed', e);
    }
}

jQuery(async () => {
    setupLauncherDropdown();
    setupPostMessageBridge();
    addElWandButton();
    registerElSlash();

    try {
        const context = SillyTavern.getContext();
        context.eventSource.on(context.event_types.CHARACTER_MESSAGE_RENDERED, () => handleNewMessage());
        context.eventSource.on(context.event_types.USER_MESSAGE_RENDERED, () => handleNewMessage());
        context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
            for (const k of Object.keys(periodicCounters)) delete periodicCounters[k];
            messageCounter = 0;
            sendChatChangedToApp();
        });
    } catch (e) {
        console.error('Enhanced Lorebook: failed to subscribe to events', e);
    }
});
