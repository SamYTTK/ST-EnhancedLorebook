const EL_SETTINGS_KEY = 'SillyTavernEnhancedLorebook';
const ST_Window = window.opener || window.parent;
const safeJoin = (val, sep = ', ') => Array.isArray(val) ? val.join(sep) : (val ? String(val) : '');

let stContext = null;
let currentLorebookName = null;
let currentLorebookData = null;
let selectedEntries = new Set();
let lastClickedEntryUid = null;
// Re-entrancy guard with a staleness escape: a request that never answers must not
// wedge polling forever. The token stops a stale tick's finally from releasing a
// newer tick's lock.
const SYNC_POLL_STUCK_MS = 60000;
let _syncPollSeq = 0;
let _syncPollActive = null;   // { id, startedAt }
let _elRenderCtx = null;
let extensionSettings = {};
let expandedFolders = new Set();
let selectedFolders = new Set();
let EL_folderClipboard = null;
let agentEngine = null;
let agentManager = null;
let agentUIInitialized = false;
let currentViewMode = 'lorebook';
// ── Single lorebook state store ──
// currentLorebookData is the ONLY copy of the open book's entries, and every write
// goes through EL_setLorebookData so there is exactly one mutation point and no
// second copy can drift out of sync. Note that `window.currentLorebookData = ...`
// was a SILENT NO-OP: a top-level `let` is a script-scoped binding, not a window
// property, so assigning through `window.` created an unrelated property and left
// the real state untouched.

/**
 * Deep copy used when we adopt a book so in-place entry edits can never mutate
 * SillyTavern's own cached object behind its back.
 */
function EL_cloneLorebookData(data) {
    if (!data || typeof data !== 'object') return data || null;
    try { return structuredClone(data); } catch (e) {}
    try { return JSON.parse(JSON.stringify(data)); } catch (e) {}
    return data;
}

/**
 * The single mutation point for the open book's entries.
 * opts.own = true takes our own deep copy (use when adopting data that came from
 * SillyTavern, so we never mutate its cache).
 */
function EL_setLorebookData(data, opts) {
    const o = opts || {};
    currentLorebookData = (o.own === true) ? EL_cloneLorebookData(data) : (data || null);
    return currentLorebookData;
}

function EL_getLorebookData() {
    return currentLorebookData;
}

/** Same treatment for the open book's name, for symmetry. */
function EL_setLorebookName(name) {
    currentLorebookName = (typeof name === 'string' && name) ? name : null;
    return currentLorebookName;
}
let panelHeights = {};
let panelCollapsed = {};
// Clipboard for copy/paste that respects folder URL (extension-only)
let EL_clipboard = null; // { book, items: [{ entry, url }] }
const PANEL_KEYS = ['character', 'lorebooks', 'agent'];

// ── EL Logger helpers (reuse ST's minLogLevel, Q2 file + console, Q4 EL_toast for data-loss) ─
function EL_log(...args){ try { (window.ELLogger||console).log('[EL]', ...args); } catch {} }
function EL_info(...args){ try { (window.ELLogger||console).info('[EL]', ...args); } catch {} }
function EL_warn(...args){ try { (window.ELLogger||console).warn('[EL]', ...args); } catch {} }
function EL_error(...args){ try { (window.ELLogger||console).error('[EL]', ...args); } catch {} }
function EL_debugPromoted(...args){ try { const L=window.ELLogger||console; if(L.debugPromoted) L.debugPromoted('[EL]', ...args); else L.log('[EL]', ...args); } catch {} }
function EL_isGenerating(){
    try {
        if (typeof window !== 'undefined' && Number(window._elHubRunning) > 0) return true;
        // ST global generation flag
        if (typeof ST_Window !== 'undefined' && ST_Window.SillyTavern && ST_Window.SillyTavern.getContext) {
            const ctx = ST_Window.SillyTavern.getContext();
            if (ctx && (ctx.isGenerating || ctx.is_send_press)) return true;
        }
        if (typeof stContext !== 'undefined' && stContext && (stContext.isGenerating || stContext.is_send_press)) return true;
    } catch {}
    return false;
}
function EL_logGuardResult(ok, action, book, detail){
    if (ok) EL_info(`guardSave ok action=${action} book="${book}"`, detail||'');
    else { EL_error(`guardSave FAILED/BLOCKED action=${action} book="${book}"`, detail||''); try { EL_toast(`Save failed/blocked for "${book}" (${action})`, 'error'); } catch {} }
}
const PANEL_MIN_H = 60;

// ── Dynamic Sync Engine (region-based updates) ─────────────────────────
// Named "regions" refresh independently. Signals (ST events + a lightweight
// server poll) are routed to the affected region only; signature gating skips
// DOM rebuilds when nothing actually changed, so bursts never cause a full
// reload or UI freeze.
const SYNC_REGIONS = {
    LIST: 'list',
    ACTIVE_GLOBALS: 'active_globals',
    ACTIVE_CHAR: 'active_char',
    ENTRIES: 'entries',
};

const sync = {
    enabled: true,
    interval: 5000,
    settingsData: null,
    debounceTimers: {},
    pendingHidden: new Set(),
    signatures: {
        list: null,
        activeGlobals: null,
        activeChar: null,
        entries: null,
    },
    poll: {
        globalSelectSig: '',
        charLoreSig: '',
        entriesSig: '',
        entriesBook: null,
        revision: { settings: null, book: null, worldsDir: null },
        revisionBook: null,
    },
    lastSave: {},
    timer: null,
    unsubscribers: [],
};

// DOM Elements
const els = {
    btnCloseApp: document.getElementById('btn-close-app'),
    btnSettings: document.getElementById('btn-settings'),
    btnRefresh: document.getElementById('btn-refresh-lorebooks'),
    btnSaveTemplate: document.getElementById('btn-save-template'),

    listActive: document.getElementById('active-lorebooks-list'),
    chatLoreList: document.getElementById('chat-lore-list'),
    characterLoreList: document.getElementById('character-lore-list'),
    activeCharacterName: document.getElementById('active-character-name'),
    sidebarPanels: document.getElementById('sidebar-panels'),
    listTemplates: document.getElementById('templates-list'),
    listAll: document.getElementById('all-lorebooks-list'),

    searchLorebooks: document.getElementById('search-lorebooks'),
    searchEntries: document.getElementById('search-entries'),

    mainToolbar: document.getElementById('main-toolbar'),
    currentTitle: document.getElementById('current-lorebook-title'),
    entriesContainer: document.getElementById('entries-container'),

    btnAddItem: document.getElementById('btn-add-item'),
    btnBatchOptions: document.getElementById('btn-batch-options'),
    btnDownload: document.getElementById('btn-download-selected'),
    btnDeselectAll: document.getElementById('btn-deselect-all'),
    btnSelectAll: document.getElementById('btn-select-all'),

    // Modals
    settingsModal: document.getElementById('settings-modal'),
    addItemModal: document.getElementById('add-item-modal'),
    batchModal: document.getElementById('batch-options-modal'),

    // Context Menu
    contextMenu: null, // Will create dynamically
};

// Initialize
async function init() {
    try {
        stContext = ST_Window.SillyTavern.getContext();
    } catch (e) {
        console.error('Could not access SillyTavern context. Are we running inside the iframe?', e);
        return;
    }

    // Load settings
    if (!stContext.extensionSettings[EL_SETTINGS_KEY]) {
        stContext.extensionSettings[EL_SETTINGS_KEY] = {
            colors: {},
            themeMode: 'dark', // dark | light | follow (follow mirrors SillyTavern)
            templates: {}, // name -> array of lorebook names
            folders: {},    // lorebookName -> array of {id, name, entries: [uid, uid]}
            dragAndDrop: true,
            foldersExpanded: {}, // lorebookName -> array of expanded folder ids
        };
    }
    extensionSettings = stContext.extensionSettings[EL_SETTINGS_KEY];
    if (!extensionSettings.folders) extensionSettings.folders = {};
    if (!extensionSettings.templates) extensionSettings.templates = {};
    if (typeof extensionSettings.dragAndDrop !== 'boolean') extensionSettings.dragAndDrop = true;
    if (!extensionSettings.foldersExpanded || typeof extensionSettings.foldersExpanded !== 'object') extensionSettings.foldersExpanded = {};
    if (!extensionSettings.sidebarPanelHeights) extensionSettings.sidebarPanelHeights = {};
    if (!extensionSettings.sidebarPanelsCollapsed) extensionSettings.sidebarPanelsCollapsed = {};
    if (typeof extensionSettings.themeMode !== 'string' || ['dark', 'light', 'follow'].indexOf(extensionSettings.themeMode) === -1) extensionSettings.themeMode = 'dark';
    if (!extensionSettings.sync) extensionSettings.sync = {};
    // Logging prefs: batched + relevance-filtered (verbose off by default)
    if (typeof extensionSettings.sync.logLevel !== 'string' || !['OFF','ERROR','WARN','INFO','DEBUG'].includes(extensionSettings.sync.logLevel.toUpperCase())) {
        extensionSettings.sync.logLevel = extensionSettings.sync.logLevel || 'INFO';
        // Normalize
        extensionSettings.sync.logLevel = String(extensionSettings.sync.logLevel).toUpperCase();
        if (!['OFF','ERROR','WARN','INFO','DEBUG'].includes(extensionSettings.sync.logLevel)) extensionSettings.sync.logLevel = 'INFO';
    } else {
        extensionSettings.sync.logLevel = extensionSettings.sync.logLevel.toUpperCase();
    }
    if (typeof extensionSettings.sync.verbose !== 'boolean') extensionSettings.sync.verbose = false;
    panelHeights = extensionSettings.sidebarPanelHeights;
    panelCollapsed = extensionSettings.sidebarPanelsCollapsed;
    sync.enabled = extensionSettings.sync.enabled !== false;
    sync.interval = Math.max(1, Number(extensionSettings.sync.interval) || 5) * 1000;
    if (extensionSettings.sidebarWidth) {
        document.documentElement.style.setProperty('--sidebar-width', `${extensionSettings.sidebarWidth}px`);
    }

    applyColors();
    applyPanelHeights();
    applyPanelCollapsed();
    setupEventListeners();
    createContextMenu();

    // Register the bridge listener BEFORE the first refresh so an in-flight
    // response (e.g. active lorebooks) can never be missed.
    window.addEventListener('message', (e) => {
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
        if (msg.type === 'el-navigate') {
            if (msg.tab) {
                switchToView(msg.tab);
            } else {
                showLorebookView();
            }
        } else if (msg.type === 'el-agent-character-lorebooks') {
            renderCharacterLorebooks(msg);
        } else if (msg.type === 'el-agent-chat-changed') {
            scheduleRegion(SYNC_REGIONS.ACTIVE_CHAR);
        } else if (msg.type === 'el-agent-periodic-trigger') {
            handlePeriodicTriggerFromHost(msg);
        } else if (msg.type === 'el-agent-settings-sync') {
            // Host pushed agent list (e.g. after save in main window). Refresh UI.
            try {
                if (typeof renderDashboard === 'function') renderDashboard();
                if (typeof renderAgentSidebar === 'function') renderAgentSidebar();
                if (typeof initAgentChatPanel === 'function' && currentViewMode === 'agent-chat') initAgentChatPanel();
            } catch {}
        }
    });

    await refreshSidebar();

    // Logging: minimal, relevance-filtered, batched (no per-token stream spam)
    // - Only lorebook-relevant generation summary (single END, not per token/combine)
    // - Prompt ready only when verbose
    try {
        const L = window.ELLogger || console;
        if (stContext?.eventSource && stContext?.event_types) {
            const et = stContext.event_types;
            const es = stContext.eventSource;
            let _elGenStartTs = 0;
            const _isVerboseGen = () => {
                try { return !!extensionSettings?.sync?.verbose; } catch { return false; }
            };
            // START: capture ts for duration, single START log (INFO batched)
            const evStart = et['GENERATION_STARTED'];
            if (evStart) {
                try {
                    es.on(evStart, () => {
                        _elGenStartTs = Date.now();
                        try { L.info(`[EL:Gen] generation STARTED book="${currentLorebookName||''}"`); } catch {}
                    });
                } catch (e) { try { L.warn(`[EL] failed to hook GENERATION_STARTED`, e); } catch {} }
            }
            // END / STOPPED: single summary (duration + single 500-char preview intent)
            ['GENERATION_ENDED','GENERATION_STOPPED'].forEach(evName => {
                const ev = et[evName];
                if (!ev) return;
                try {
                    es.on(ev, () => {
                        try {
                            const dur = _elGenStartTs ? (Date.now() - _elGenStartTs) : 0;
                            _elGenStartTs = 0;
                            L.info(`[EL:Gen] generation ${evName} duration=${dur}ms book="${currentLorebookName||''}"`);
                        } catch {}
                    });
                } catch (e) { try { L.warn(`[EL] failed to hook generation event ${evName}`, e); } catch {} }
            });
            // Prompt ready: verbose-only (was spamming each gen)
            const evPrompt = et['CHAT_COMPLETION_PROMPT_READY'];
            if (evPrompt) {
                try {
                    es.on(evPrompt, (...args) => {
                        if (!_isVerboseGen()) return;
                        try {
                            const L2 = window.ELLogger || console;
                            const data = args[0]||{};
                            const prompt = data.prompt || data.chat || '';
                            const preview = String(prompt).slice(0,500).replace(/\n/g,' ');
                            L2.info(`[EL:Prompt] prompt_ready verbose len=${String(prompt).length} preview=${preview.slice(0,80)}…`);
                        } catch {}
                    });
                } catch (e) { try { (window.ELLogger||console).warn(`[EL] failed to hook CHAT_COMPLETION_PROMPT_READY`, e); } catch {} }
            }
            // Intentionally NOT hooking: STREAM_TOKEN_RECEIVED, GENERATE_BEFORE_COMBINE_PROMPTS, GENERATE_AFTER_COMBINE_PROMPTS, GENERATE_AFTER_DATA
            // These were per-token / per-combine spam. Agent summary (agent-core.js generation end) already covers needed info in one pass.
            if (_isVerboseGen()) {
                try { L.info('[EL] generation hooks installed (filtered, verbose prompt on)'); } catch {}
            }
        }
    } catch (e) { try { console.warn('[EL] generation hook setup failed', e); } catch {} }

    // Dynamic sync: route ST events to the affected region (instant), plus a
    // lightweight server poll that catches external edits which emit no events.
    setupSyncSubscriptions();
    startSyncPolling();

    try {
        // agent-manager.js and agent-ui.js are already loaded as classic scripts
        // (see index.html). Dynamic-importing them here evaluated BOTH files a
        // second time, re-running their top-level side effects and re-registering
        // their listeners. Their globals are used directly below.
        agentManager = new AgentManager();
        // Always init agent UI (even with zero agents) so Dashboard empty-state
        // + Create Agent button are wired. Runs go through the hub (hub-client.js).
        const context = {
            stContext,
            agentManager,
            currentLorebookName: currentLorebookName,
            currentLorebookData: currentLorebookData,
        };
        if (typeof initAgentUI === 'function') {
            await initAgentUI(context);
            agentUIInitialized = true;
        }
    } catch (e) {
        console.error('Failed to initialize agent UI:', e);
    }

    const urlParams = new URLSearchParams(window.location.search);
    const initialTab = urlParams.get('tab');
    if (initialTab === 'agent-dashboard') switchToView('agent-dashboard');
    else if (initialTab === 'agent-config') switchToView('agent-config');
    else if (initialTab === 'agent-feed') switchToView('agent-feed');
    else if (initialTab === 'agent-chat') switchToView('agent-chat');
}

function saveSettings() {
    stContext.saveSettingsDebounced();
}

function refreshAfterAgentChange(lorebookName) {
    if (currentLorebookName === lorebookName && currentViewMode === 'lorebook') {
        sync.poll.entriesSig = entriesSignature(currentLorebookData);
        sync.poll.entriesBook = currentLorebookName;
        sync.signatures.entries = sync.poll.entriesSig;
        sync.lastSave[lorebookName] = Date.now();
        renderEntries();
    }
}

// ==========================================
// Theme & Colors
// ==========================================
function applyColors() {
    const mode = EL_themeMode();
    const root = document.documentElement;
    const colors = (extensionSettings && extensionSettings.colors) || {};
    if (mode === 'light') {
        // The light palette owns every variable; stale custom or mirrored
        // overrides would punch dark holes in it, so drop them here. The
        // saved custom colours stay in settings for dark mode.
        ['--bg-color', '--panel-bg', '--text-color', '--text-muted', '--panel-border', '--primary-color'].forEach(k => {
            try { root.style.removeProperty(k); } catch (e) {}
        });
    } else {
        if (colors.bg) root.style.setProperty('--bg-color', colors.bg);
        if (colors.panel) root.style.setProperty('--panel-bg', colors.panel);
        if (colors.text) root.style.setProperty('--text-color', colors.text);
        if (colors.primary) root.style.setProperty('--primary-color', colors.primary);
    }
    EL_applyThemeMode();
}

/**
 * Current theme mode, always one of dark/light/follow.
 * @returns {string}
 */
function EL_themeMode() {
    try {
        const m = extensionSettings && extensionSettings.themeMode;
        if (m === 'light' || m === 'follow') return m;
    } catch (e) {}
    return 'dark';
}

/**
 * Apply the theme mode: light class for the light palette, mirrored
 * SillyTavern colours for follow, plain dark otherwise.
 */
function EL_applyThemeMode() {
    const mode = EL_themeMode();
    try {
        document.body.classList.remove('el-theme-light');
    } catch (e) {}
    if (mode === 'light') {
        try { document.body.classList.add('el-theme-light'); } catch (e) {}
    } else if (mode === 'follow') {
        EL_applyFollowTheme();
    }
}

/**
 * Read one computed custom property from the opener (SillyTavern) document.
 * @param {string} name e.g. "--SmartThemeBodyColor".
 * @returns {string} Trimmed value, or "" when unavailable.
 */
function EL_followThemeValue(name) {
    try {
        const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
        if (!host || host === window || !host.document || !host.document.documentElement) return '';
        const cs = host.getComputedStyle ? host.getComputedStyle(host.document.documentElement) : null;
        if (!cs || typeof cs.getPropertyValue !== 'function') return '';
        const v = cs.getPropertyValue(name);
        return v ? String(v).trim() : '';
    } catch (e) { return ''; }
}

/**
 * Relative luminance of a CSS colour (0 = black, 1 = white), or null when
 * the colour cannot be parsed.
 * @param {string} color
 * @returns {number|null}
 */
function EL_cssLuminance(color) {
    try {
        const c = String(color || '').trim().toLowerCase();
        if (!c) return null;
        let r = -1, g = -1, b = -1;
        let m = /^#([0-9a-f]{6})$/.exec(c);
        if (m) {
            r = parseInt(m[1].slice(0, 2), 16);
            g = parseInt(m[1].slice(2, 4), 16);
            b = parseInt(m[1].slice(4, 6), 16);
        } else if (/^#([0-9a-f]{3})$/.test(c)) {
            const h = c.slice(1);
            r = parseInt(h[0] + h[0], 16);
            g = parseInt(h[1] + h[1], 16);
            b = parseInt(h[2] + h[2], 16);
        } else {
            m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(c);
            if (!m) return null;
            r = Number(m[1]);
            g = Number(m[2]);
            b = Number(m[3]);
        }
        if (![r, g, b].every(v => Number.isFinite(v) && v >= 0 && v <= 255)) return null;
        const lin = (v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    } catch (e) { return null; }
}

/**
 * Mirror SillyTavern's SmartTheme colours onto this window's variables and
 * pick the matching (light/dark) app palette by tint luminance. Any failure
 * (opener gone, values missing) leaves the app on the dark palette.
 */
function EL_applyFollowTheme() {
    try {
        const body = EL_followThemeValue('--SmartThemeBodyColor');
        const tint = EL_followThemeValue('--SmartThemeBlurTintColor');
        const border = EL_followThemeValue('--SmartThemeBorderColor');
        const em = EL_followThemeValue('--SmartThemeEmColor');
        const quote = EL_followThemeValue('--SmartThemeQuoteColor');
        if (!body && !tint) throw new Error('no SmartTheme values from opener');
        const lum = EL_cssLuminance(tint || body);
        const isLight = (lum !== null) ? lum > 0.4 : false;
        if (isLight) {
            try { document.body.classList.add('el-theme-light'); } catch (e) {}
        }
        const root = document.documentElement;
        const set = (k, v) => {
            if (v) {
                try { root.style.setProperty(k, v); } catch (e) {}
            }
        };
        if (tint) {
            set('--bg-color', tint);
            set('--panel-bg', tint);
        }
        if (body) set('--text-color', body);
        if (quote) set('--text-muted', quote);
        if (border) set('--panel-border', border);
        if (em) set('--primary-color', em);
    } catch (e) {
        try { document.body.classList.remove('el-theme-light'); } catch (_e) {}
        EL_warn('follow theme unavailable, staying on dark palette', e);
    }
}

function openSettings() {
    const colors = extensionSettings.colors || {};
    document.getElementById('color-bg').value = colors.bg || '#0f111a';
    document.getElementById('color-panel').value = colors.panel || '#1a1c29'; /* Simplified */
    document.getElementById('color-text').value = colors.text || '#e2e8f0';
    document.getElementById('color-primary').value = colors.primary || '#6366f1';
    const themeModeSelect = document.getElementById('setting-theme-mode');
    if (themeModeSelect) themeModeSelect.value = EL_themeMode();
    const syncEnabled = document.getElementById('sync-enabled');
    if (syncEnabled) syncEnabled.checked = sync.enabled;
    const syncInterval = document.getElementById('sync-interval');
    if (syncInterval) syncInterval.value = Math.round(sync.interval / 1000);
    const syncLogLevel = document.getElementById('sync-loglevel');
    if (syncLogLevel) syncLogLevel.value = (extensionSettings.sync?.logLevel || 'INFO').toUpperCase();
    const syncVerbose = document.getElementById('sync-verbose');
    if (syncVerbose) syncVerbose.checked = !!extensionSettings.sync?.verbose;
    const dragDrop = document.getElementById('setting-drag-drop');
    if (dragDrop) dragDrop.checked = extensionSettings.dragAndDrop !== false;
    EL_modalOpen(els.settingsModal);
}

function updateColor(key, cssVar, value) {
    if (!extensionSettings.colors) extensionSettings.colors = {};
    extensionSettings.colors[key] = value;
    document.documentElement.style.setProperty(cssVar, value);
    saveSettings();
}

// ==========================================
// Sidebar & Data Loading
// ==========================================
async function refreshSidebar() {
    const allNames = stContext.getWorldInfoNames();
    const activeGlobals = getActiveGlobals();

    renderLorebookList(els.listAll, allNames, (name) => {
        openLorebook(name);
    }, true);

    renderLorebookList(els.listActive, activeGlobals, (name) => {
        openLorebook(name);
    }, false, true);

    renderTemplatesList();
    requestCharacterLorebooks();
}

function requestCharacterLorebooks() {
    try {
        if (typeof EL_postToHost === 'function') {
            EL_postToHost({ type: 'el-agent-request-character-lorebooks' });
        }
    } catch (e) {
        console.error('Enhanced Lorebook: failed to request character lorebooks', e);
    }
}

function renderCharacterLorebooks(payload) {
    // Skip redundant re-renders when the active-lorebook set didn't change.
    const sig = JSON.stringify({
        id: payload?.characterId ?? null,
        name: payload?.characterName || '',
        chat: payload?.chatLorebook || '',
        chars: payload?.characterLorebooks || [],
        embedded: payload?.embeddedBook || '',
    });
    if (sig === sync.signatures.activeChar) return;
    sync.signatures.activeChar = sig;

    const characterName = payload?.characterName || '';
    if (els.activeCharacterName) {
        els.activeCharacterName.textContent = characterName || (payload?.characterId === null || payload?.characterId === undefined ? 'No Character' : '');
        els.activeCharacterName.title = characterName || 'No character selected';
    }
    if (!els.chatLoreList && !els.characterLoreList) return;

    const allNames = stContext.getWorldInfoNames ? stContext.getWorldInfoNames() : [];

    const chatLore = (payload && typeof payload.chatLorebook === 'string') ? payload.chatLorebook : '';
    const chatExisting = (chatLore && allNames.includes(chatLore)) ? [chatLore] : [];

    const charBooks = (payload && Array.isArray(payload.characterLorebooks)) ? payload.characterLorebooks : [];
    const charExisting = charBooks.filter(name => allNames.includes(name));

    // An embedded-only primary (never imported as a file) won't be in world_names,
    // so append it explicitly so it is never silently dropped.
    const embeddedBook = (payload && typeof payload.embeddedBook === 'string' && payload.embeddedBook) ? payload.embeddedBook : '';
    if (embeddedBook && !charExisting.includes(embeddedBook)) {
        charExisting.unshift(embeddedBook);
    }

    if (els.chatLoreList) {
        renderLorebookList(els.chatLoreList, chatExisting, (name) => {
            openLorebook(name);
        }, false, false);
    }
    if (els.characterLoreList) {
        renderLorebookList(els.characterLoreList, charExisting, (name) => {
            openLorebook(name);
        }, false, false);
    }

    if (extensionSettings.sync?.verbose) try { (window.ELLogger||console).debug('Enhanced Lorebook: rendered active lorebooks', payload); } catch {}
    else if (window.ELLogger?.sync) try { window.ELLogger.sync('rendered active lorebooks', payload); } catch {}
}

// ==========================================
// Dynamic Sync Engine (region-based updates)
// ==========================================

function getActiveGlobals() {
    const stSelect = ST_Window.document.getElementById('world_info');
    if (stSelect) {
        return Array.from(stSelect.selectedOptions).map(opt => opt.text).filter(v => v);
    }
    return [];
}

function namesSignature(names) {
    return (names || []).slice().sort().join('\n');
}

/**
 * Signature of the open book's entries, used to decide whether a server-side change
 * needs re-rendering.
 *
 * Built on EL_entryFingerprint (hub-tools.js) so it covers EVERY field in
 * EL_ENTRY_FIELDS, including the full content/key/comment text and the flag fields
 * an agent actually edits (order, position, role, depth, probability, disable,
 * constant, ...). The previous version hashed only content LENGTH, the joined keys
 * and comment LENGTH, so it was blind to every same-length edit and to every one of
 * those flags — which made the UI show stale state indefinitely after a run.
 *
 * uids are sorted so an equivalent book serialised in a different key order does not
 * read as a change and trigger a spurious re-render.
 */
function entriesSignature(book) {
    if (!book || !book.entries) return '';
    const parts = [];
    const uids = Object.keys(book.entries).sort();
    for (const uid of uids) {
        const e = book.entries[uid] || {};
        const fp = (typeof EL_entryFingerprint === 'function')
            ? EL_entryFingerprint(e)
            // Degrade to the previous length-based hash rather than to '' — a missing
            // helper must not make the signature weaker than it was before.
            : (String(e.content || '').length + ':' + safeJoin(e.key) + ':' + String(e.comment || '').length);
        parts.push(uid + ':' + fp);
    }
    return parts.join('|');
}

function isEntryEditorOpen() {
    return ['edit-entry-modal', 'add-item-modal', 'batch-options-modal'].some(id => {
        const el = document.getElementById(id);
        return !!(el && el.classList.contains('active'));
    });
}

async function fetchSettingsData() {
    try {
        const headers = (typeof stContext.getRequestHeaders === 'function') ? stContext.getRequestHeaders() : { 'Content-Type': 'application/json' };
        const resp = await fetch('/api/settings/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
            cache: 'no-cache',
        });
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        console.error('Enhanced Lorebook: settings poll failed', e);
        return null;
    }
}

/**
 * Cheap server probe: mtimeMs/size of settings.json, mtimeMs of the worlds
 * directory, and mtimeMs/size of the named book's file.
 * Returns the parsed `{ ok, settings, book, worldsDir }` object, or null on ANY
 * failure (non-2xx, network error, parse error, timeout). Never throws. A null
 * return means the probe is unavailable (old plugin / server not restarted /
 * plugin down) and the caller must fall back to the unconditional fetches.
 */
async function EL_fetchRevision(book) {
    let timeoutId = null;
    let controller = null;
    try {
        let headers = { 'Content-Type': 'application/json' };
        try {
            if (typeof stContext !== 'undefined' && stContext && typeof stContext.getRequestHeaders === 'function') {
                headers = stContext.getRequestHeaders();
            }
        } catch (e) {}
        const url = '/api/plugins/enhanced-lorebook-agent/revision' + (book ? '?book=' + encodeURIComponent(book) : '');
        try {
            if (typeof AbortController !== 'undefined') {
                controller = new AbortController();
                timeoutId = setTimeout(() => { try { controller.abort(); } catch (e) {} }, 8000);
            }
        } catch (e) {
            controller = null;
            timeoutId = null;
        }
        const opts = { method: 'GET', headers: headers, cache: 'no-cache' };
        if (controller) opts.signal = controller.signal;
        const resp = await fetch(url, opts);
        if (!resp || !resp.ok) return null;
        const data = await resp.json();
        return data;
    } catch (e) {
        return null;
    } finally {
        try { if (timeoutId !== null) clearTimeout(timeoutId); } catch (e) {}
    }
}

function scheduleRegion(region) {
    if (sync.debounceTimers[region]) clearTimeout(sync.debounceTimers[region]);
    sync.debounceTimers[region] = setTimeout(() => {
        sync.debounceTimers[region] = null;
        refreshRegion(region);
    }, 300);
}

function refreshRegion(region) {
    if (document.hidden) {
        sync.pendingHidden.add(region);
        return;
    }
    switch (region) {
        case SYNC_REGIONS.LIST:
            refreshListRegion();
            break;
        case SYNC_REGIONS.ACTIVE_GLOBALS:
            refreshActiveGlobalsFrom(getActiveGlobals());
            break;
        case SYNC_REGIONS.ACTIVE_CHAR:
            requestCharacterLorebooks();
            break;
        case SYNC_REGIONS.ENTRIES:
            if (currentViewMode === 'lorebook' && currentLorebookName && !isEntryEditorOpen()) {
                ensureFoldersStructure(currentLorebookName);
                renderEntries();
            }
            break;
    }
}

function refreshListRegion() {
    const allNames = stContext.getWorldInfoNames();
    const sig = namesSignature(allNames);
    if (sig === sync.signatures.list) return;
    sync.signatures.list = sig;
    renderLorebookList(els.listAll, allNames, (name) => {
        openLorebook(name);
    }, true);
    renderTemplatesList();
}

function refreshActiveGlobalsFrom(globals) {
    const list = (globals || []).filter(n => typeof n === 'string' && n);
    const sig = list.slice().sort().join('\n');
    if (sig === sync.signatures.activeGlobals) return;
    sync.signatures.activeGlobals = sig;
    renderLorebookList(els.listActive, list, (name) => {
        openLorebook(name);
    }, false, true);
}

function applyEntriesData(name, data) {
    const loadFailed = !data || !data.entries;
    const newData = loadFailed ? { entries: {} } : data;
    EL_setLorebookData(newData, { own: true });
    const sig = entriesSignature(newData);
    sync.poll.entriesSig = sig;
    sync.poll.entriesBook = name;
    sync.signatures.entries = sig;
    if (!document.hidden && currentViewMode === 'lorebook' && currentLorebookName && !isEntryEditorOpen()) {
        // Never prune folder membership against an empty fallback: a failed read
        // would otherwise wipe the folder layout, which the next saveSettings() persists.
        ensureFoldersStructure(currentLorebookName, { prune: !loadFailed });
        renderEntries();
    }
}

async function syncPollTick() {
    if (document.hidden || !sync.enabled) return;
    const now = Date.now();
    if (_syncPollActive && (now - _syncPollActive.startedAt) < SYNC_POLL_STUCK_MS) return;
    const _myPollId = ++_syncPollSeq;
    _syncPollActive = { id: _myPollId, startedAt: now };
    try {
        // Cheap probe first: mtimeMs/size of settings.json, mtimeMs of the worlds
        // directory, and mtimeMs/size of the open book. world_names is NOT stored in
        // settings.json — SillyTavern derives it from a live readdirSync of the
        // user's worlds directory — so adding or deleting a lorebook file leaves
        // settings.json untouched and the cached snapshot would never refresh.
        // That is why the directory mtime is part of the settings signal.
        // rev === null means the probe is unavailable (old plugin / server not
        // restarted / plugin down) — fall back to EXACTLY today's behaviour: fetch
        // settings and the book unconditionally, so a user who has not restarted
        // sees no behaviour change and no errors. The probe is fail-open.
        const book = currentLorebookName;
        const rev = await EL_fetchRevision(book);

        let settingsData = null;
        if (rev === null) {
            settingsData = await fetchSettingsData();
            if (!settingsData) return;
            sync.settingsData = settingsData;
        } else {
            if (!sync.poll.revision) sync.poll.revision = { settings: null, book: null, worldsDir: null };
            const lastSettings = sync.poll.revision.settings || null;
            const curSettings = rev.settings || null;
            const lastWorlds = sync.poll.revision.worldsDir || null;
            const curWorlds = rev.worldsDir || null;
            const settingsJsonChanged = !curSettings || !lastSettings || curSettings.mtimeMs !== lastSettings.mtimeMs || curSettings.size !== lastSettings.size;
            // Fail-open: a null directory stat (unresolvable) or no prior observation
            // means "unknown", so refetch rather than skip. Compare mtimeMs ONLY —
            // a directory's size is 0 on Windows and its mtime only moves on
            // add/remove (not on modify), which is exactly the create/delete signal.
            const worldsChanged = !curWorlds || !lastWorlds || curWorlds.mtimeMs !== lastWorlds.mtimeMs;
            const settingsChanged = settingsJsonChanged || worldsChanged;
            if (settingsChanged) {
                settingsData = await fetchSettingsData();
                if (!settingsData) return;
                sync.settingsData = settingsData;
                sync.poll.revision.settings = curSettings ? { mtimeMs: curSettings.mtimeMs, size: curSettings.size } : null;
                sync.poll.revision.worldsDir = curWorlds ? { mtimeMs: curWorlds.mtimeMs } : null;
            } else {
                settingsData = sync.settingsData;
                if (!settingsData) return;
            }
        }

        // LIST: external creates/deletes emit no events, so reconcile the parent's
        // world_names against the authoritative server list.
        if (settingsData && Array.isArray(settingsData.world_names)) {
            const authSig = namesSignature(settingsData.world_names);
            const parentNames = stContext.getWorldInfoNames();
            const parentSig = namesSignature(parentNames);
            if (authSig !== parentSig) {
                const authNames = settingsData.world_names;
                const added = authNames.filter(n => !parentNames.includes(n));
                try {
                    if (typeof stContext.updateWorldInfoList === 'function') {
                        await stContext.updateWorldInfoList();
                    }
                } catch (e) {
                    console.error('Enhanced Lorebook: failed to re-sync world info list', e);
                }
                scheduleRegion(SYNC_REGIONS.LIST);
                // Lorebook duplication with URL-aware folder clone (extension-only, no ST pollution)
                if (added.length) {
                    // Defer a tick so ST has the new file on disk
                    setTimeout(() => {
                        for (const nb of added) EL_checkAndPromptLorebookFolderClone(nb).catch(() => {});
                    }, 800);
                }
            }
        }

        // ACTIVE: globalSelect / charLore bindings changed.
        if (settingsData) {
            const wi = settingsData?.world_info_settings?.world_info;
            const gsSig = namesSignature(wi?.globalSelect || []);
            if (gsSig !== sync.poll.globalSelectSig) {
                sync.poll.globalSelectSig = gsSig;
                refreshActiveGlobalsFrom(wi?.globalSelect || []);
            }
            const charSig = JSON.stringify(wi?.charLore || []);
            if (charSig !== sync.poll.charLoreSig) {
                sync.poll.charLoreSig = charSig;
                scheduleRegion(SYNC_REGIONS.ACTIVE_CHAR);
            }
        }

        // ENTRIES: the open book changed on the server without an event.
        if (currentLorebookName && currentViewMode === 'lorebook' && !isEntryEditorOpen()) {
            const bookNow = currentLorebookName;
            const savedBefore = sync.lastSave[bookNow] || 0;
            if (rev === null) {
                const serverData = await ELG_fetchServerState(bookNow);
                if (serverData && serverData.entries && (sync.lastSave[bookNow] || 0) === savedBefore) {
                    const serverSig = entriesSignature(serverData);
                    if (serverSig !== sync.poll.entriesSig || sync.poll.entriesBook !== bookNow) {
                        applyEntriesData(bookNow, serverData);
                    }
                }
            } else {
                if (!sync.poll.revision) sync.poll.revision = { settings: null, book: null, worldsDir: null };
                const lastBook = sync.poll.revision.book || null;
                const curBook = rev.book || null;
                const bookChanged = sync.poll.revisionBook !== bookNow || !curBook || !lastBook || curBook.mtimeMs !== lastBook.mtimeMs || curBook.size !== lastBook.size;
                if (!bookChanged) {
                    // Unchanged: skip the whole-book fetch AND the signature
                    // computation entirely (entriesSignature reads every entry).
                    // sync.lastSave and sync.poll.entriesSig are left untouched.
                } else {
                    const serverData = await ELG_fetchServerState(bookNow);
                    if (serverData && serverData.entries && (sync.lastSave[bookNow] || 0) === savedBefore) {
                        sync.poll.revision.book = curBook ? { mtimeMs: curBook.mtimeMs, size: curBook.size } : null;
                        sync.poll.revisionBook = bookNow;
                        const serverSig = entriesSignature(serverData);
                        if (serverSig !== sync.poll.entriesSig || sync.poll.entriesBook !== bookNow) {
                            applyEntriesData(bookNow, serverData);
                        }
                    }
                }
            }
        }
    } finally {
        if (_syncPollActive && _syncPollActive.id === _myPollId) _syncPollActive = null;
    }
}

function startSyncPolling() {
    stopSyncPolling();
    if (!sync.enabled) return;
    sync.timer = setInterval(syncPollTick, sync.interval);
}

function stopSyncPolling() {
    if (sync.timer) {
        clearInterval(sync.timer);
        sync.timer = null;
    }
}

async function EL_checkAndPromptLorebookFolderClone(newBookName) {
    try {
        if (!newBookName || typeof newBookName !== 'string') return;
        if (!extensionSettings || !extensionSettings.folders) return;
        // If new book already has folders, skip
        const existing = extensionSettings.folders[newBookName];
        if (Array.isArray(existing) && existing.length > 0) return;
        // Fetch new book entries
        let newData = null;
        try { newData = await ELG_loadFresh(newBookName); } catch {}
        if (!newData || !newData.entries || Object.keys(newData.entries).length === 0) return;
        const newUids = new Set(Object.keys(newData.entries).map(String));
        // Find best source book whose folders overlap heavily with new book's UID set
        let bestSource = null;
        let bestScore = 0;
        let bestIdMap = null;
        for (const [candName, folders] of Object.entries(extensionSettings.folders)) {
            if (!Array.isArray(folders) || !folders.length) continue;
            if (candName === newBookName) continue;
            const candUids = new Set();
            for (const f of folders) {
                if (Array.isArray(f.entries)) f.entries.forEach(uid => candUids.add(String(uid)));
            }
            if (!candUids.size) continue;
            // Score = intersection size / candidate size
            let inter = 0;
            for (const uid of candUids) if (newUids.has(uid)) inter++;
            const score = inter / candUids.size;
            if (score > bestScore) {
                bestScore = score;
                bestSource = candName;
            }
            // Also try content-based match if score low but entry counts equal (file copy may have regenerated UIDs)
            if (score < 0.5) {
                try {
                    const candData = await ELG_loadFresh(candName);
                    if (candData && candData.entries) {
                        const candEntries = Object.values(candData.entries);
                        const newEntries = Object.values(newData.entries);
                        if (candEntries.length === newEntries.length && candEntries.length > 0) {
                            // Build map by content hash (keys+comment+content)
                            const hash = e => `${(e.key||[]).join('|')}::${e.comment||''}::${(e.content||'').slice(0,200)}`;
                            const candMap = new Map();
                            for (const [uid, e] of Object.entries(candData.entries)) candMap.set(hash(e), String(uid));
                            let matched = 0;
                            const uidRemap = new Map();
                            for (const [newUid, ne] of Object.entries(newData.entries)) {
                                const oldUid = candMap.get(hash(ne));
                                if (oldUid) { matched++; uidRemap.set(String(oldUid), String(newUid)); }
                            }
                            const contentScore = matched / candEntries.length;
                            if (contentScore > bestScore && contentScore >= 0.7) {
                                bestScore = contentScore;
                                bestSource = candName;
                                bestIdMap = uidRemap;
                            }
                        }
                    }
                } catch {}
            }
        }
        if (!bestSource || bestScore < 0.5) return;
        // Prompt user — this is extension-only clone, avoid ST pollution
        const foldersSnapshot = window.ELFolderUrl ? window.ELFolderUrl.getFoldersSnapshot(bestSource) : (extensionSettings.folders[bestSource] || []);
        if (!foldersSnapshot.length) return;
        const msg = `New lorebook "${newBookName}" looks like a copy of "${bestSource}" (${Math.round(bestScore * 100)}% match). Copy its folder structure (groups) as well? This only affects the extension's group mapping, not ST data.`;
        let doClone = false;
        try { doClone = confirm(msg); } catch { doClone = false; }
        if (!doClone) return;
        if (bestIdMap && bestIdMap.size) {
            if (window.ELFolderUrl) window.ELFolderUrl.restoreFoldersWithRemap(newBookName, foldersSnapshot, bestIdMap);
            else extensionSettings.folders[newBookName] = JSON.parse(JSON.stringify(foldersSnapshot));
            // Reassign entries that were remapped but not yet in folders due to path
            saveSettings();
            if (typeof showToast === 'function') showToast(`Folder structure copied from "${bestSource}" (content-matched)`);
        } else {
            // Direct clone — UIDs identical
            if (window.ELFolderUrl) {
                // Use clone helper to re-id folders to avoid id collision but keep entries
                const srcSnap = window.ELFolderUrl.getFoldersSnapshot(bestSource);
                // Preserve entries verbatim if UIDs match
                window.ELFolderUrl.setFoldersSnapshot(newBookName, srcSnap);
            } else {
                extensionSettings.folders[newBookName] = JSON.parse(JSON.stringify(foldersSnapshot));
            }
            saveSettings();
            if (typeof showToast === 'function') showToast(`Folder structure copied from "${bestSource}"`);
        }
        // If new book is currently open, re-render
        if (currentLorebookName === newBookName) {
            ensureFoldersStructure(newBookName);
            renderEntries();
        }
    } catch (e) {
        console.warn('[EL] lorebook folder clone check failed', e);
    }
}

function flushPendingHiddenRegions() {
    const pending = Array.from(sync.pendingHidden);
    sync.pendingHidden.clear();
    for (const region of pending) refreshRegion(region);
}

function setupSyncSubscriptions() {
    if (!stContext.eventSource || !stContext.event_types) return;
    const es = stContext.eventSource;
    const et = stContext.event_types;

    const handlers = [
        {
            event: et.WORLDINFO_UPDATED,
            handler: (name, data) => {
                if (name === currentLorebookName) {
                    sync.lastSave[name] = Date.now();
                    applyEntriesData(name, data);
                } else {
                    scheduleRegion(SYNC_REGIONS.LIST);
                }
            },
        },
        {
            event: et.WORLDINFO_SETTINGS_UPDATED,
            handler: () => {
                scheduleRegion(SYNC_REGIONS.LIST);
                scheduleRegion(SYNC_REGIONS.ACTIVE_GLOBALS);
                scheduleRegion(SYNC_REGIONS.ACTIVE_CHAR);
            },
        },
        {
            event: et.WORLDINFO_ENTRIES_LOADED,
            handler: () => scheduleRegion(SYNC_REGIONS.ACTIVE_CHAR),
        },
        {
            event: et.EXTENSION_SETTINGS_LOADED,
            handler: () => scheduleRegion(SYNC_REGIONS.LIST),
        },
    ];

    for (const h of handlers) {
        try {
            es.on(h.event, h.handler);
            sync.unsubscribers.push(() => es.removeListener(h.event, h.handler));
        } catch (e) {
            console.error('Enhanced Lorebook: failed to subscribe to ' + h.event, e);
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        flushPendingHiddenRegions();
        syncPollTick();
    });
    window.addEventListener('focus', () => {
        if (!document.hidden) syncPollTick();
    });
    window.addEventListener('beforeunload', () => {
        stopSyncPolling();
        for (const unsub of sync.unsubscribers) {
            try { unsub(); } catch (e) { }
        }
        sync.unsubscribers = [];
    });
}

// ==========================================
// Sidebar Panels (collapsible / resizable)
// ==========================================
function EL_clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
}

function applyPanelHeights() {
    if (!els.sidebarPanels) return;
    for (const key of PANEL_KEYS) {
        const h = panelHeights[key];
        if (typeof h === 'number' && h > 0) {
            els.sidebarPanels.style.setProperty(`--panel-h-${key}`, `${Math.round(h)}px`);
        }
    }
}

function setPanelHeight(key, px) {
    panelHeights[key] = Math.round(px);
    if (els.sidebarPanels) {
        els.sidebarPanels.style.setProperty(`--panel-h-${key}`, `${Math.round(px)}px`);
    }
}

function applyPanelCollapsed() {
    if (!els.sidebarPanels) return;
    for (const key of PANEL_KEYS) {
        const panel = document.getElementById(`panel-${key}`);
        const collapsed = !!panelCollapsed[key];
        if (panel) panel.classList.toggle('collapsed', collapsed);
        els.sidebarPanels.classList.toggle(`${key}-collapsed`, collapsed);
    }
    updateResizerVisibility();
}

function updateResizerVisibility() {
    document.querySelectorAll('.panel-resizer').forEach(resizer => {
        const key = resizer.dataset.panel;
        let hidden = !!panelCollapsed[key];
        if (key === 'lorebooks' && !!panelCollapsed['agent']) {
            hidden = true; // lorebooks becomes the filler when agent is collapsed
        }
        resizer.classList.toggle('collapsed-hidden', hidden);
    });
}

function togglePanel(key) {
    panelCollapsed[key] = !panelCollapsed[key];
    applyPanelCollapsed();
    saveSettings();
}

function wirePanelControls() {
    if (!els.sidebarPanels) return;

    document.querySelectorAll('.panel-header').forEach(header => {
        header.addEventListener('click', () => togglePanel(header.dataset.panel));
    });

    document.querySelectorAll('.panel-resizer').forEach(resizer => {
        const key = resizer.dataset.panel;
        if (!key) return;
        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const panel = document.getElementById(`panel-${key}`);
            const container = els.sidebarPanels;
            const startY = e.clientY;
            const startH = panel ? panel.getBoundingClientRect().height : 0;
            const maxH = Math.max(PANEL_MIN_H, container.clientHeight - PANEL_MIN_H * 2 - 60);

            const onMove = (ev) => {
                const delta = ev.clientY - startY;
                setPanelHeight(key, EL_clamp(startH + delta, PANEL_MIN_H, maxH));
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                resizer.classList.remove('active');
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
                saveSettings();
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
            resizer.classList.add('active');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'row-resize';
        });
    });
}

function renderLorebookList(container, names, onClick, showToggle = false, showRemove = false) {
    container.innerHTML = '';
    if (!names || names.length === 0) {
        container.innerHTML = '<div class="list-item" style="color:var(--text-muted); cursor:default;"><span>None</span></div>';
        return;
    }

    names.forEach(name => {
        const div = document.createElement('div');
        div.className = 'list-item';
        if (name === currentLorebookName) div.classList.add('active');

        div.innerHTML = `<i class="fa-solid fa-book"></i><span>${escapeHtml(name)}</span>`;

        if (showToggle) {
            const stSelect = ST_Window.document.getElementById('world_info');
            const opt = Array.from(stSelect?.options || []).find(o => o.text === name);
            const isGlobal = opt ? opt.selected : false;

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.checked = isGlobal;
            toggle.title = 'Toggle Active Global';
            toggle.style.marginLeft = 'auto';
            toggle.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (opt) {
                    opt.selected = toggle.checked;
                    if (ST_Window.jQuery) ST_Window.jQuery(stSelect).trigger('change');
                    else stSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    stContext.saveSettingsDebounced();
                    await refreshSidebar();
                }
            });
            div.appendChild(toggle);
        } else if (showRemove) {
            const btnRemove = document.createElement('button');
            btnRemove.className = 'btn btn-secondary btn-sm';
            btnRemove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            btnRemove.style.marginLeft = 'auto';
            btnRemove.title = 'Remove Global Lorebook';
            btnRemove.style.padding = '2px 6px';
            btnRemove.addEventListener('click', async (e) => {
                e.stopPropagation();
                const stSelect = ST_Window.document.getElementById('world_info');
                const opt = Array.from(stSelect?.options || []).find(o => o.text === name);
                if (opt) {
                    opt.selected = false;
                    if (ST_Window.jQuery) ST_Window.jQuery(stSelect).trigger('change');
                    else stSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    stContext.saveSettingsDebounced();
                    await refreshSidebar();
                }
            });
            div.appendChild(btnRemove);
        }

        div.addEventListener('click', (e) => {
            if (e.target.tagName.toLowerCase() === 'input') return;
            document.querySelectorAll('.list-item').forEach(el => el.classList.remove('active'));
            div.classList.add('active');
            onClick(name);
        });
        try {
            if (typeof els !== 'undefined' && els && els.listAll && container === els.listAll) {
                div.dataset.lorebookName = name;
                div.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    try {
                        showContextMenu(e.clientX, e.clientY, 'lorebook', name);
                    } catch (err) {}
                });
            }
        } catch (e) {}
        container.appendChild(div);
    });
}

function renderTemplatesList() {
    els.listTemplates.innerHTML = '';
    const templates = Object.keys(extensionSettings.templates || {});
    if (templates.length === 0) {
        els.listTemplates.innerHTML = '<div class="list-item" style="color:var(--text-muted); cursor:default;"><span>No templates saved</span></div>';
        return;
    }

    templates.forEach(tName => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.title = safeJoin(extensionSettings.templates[tName], ', ');
        div.innerHTML = `<i class="fa-solid fa-bookmark"></i><span>${escapeHtml(tName)}</span>`;

        // Double click to load template (replace mode)
        div.addEventListener('dblclick', () => {
            if (confirm(`Apply template '${tName}'? This will replace your currently active global lorebooks.`)) {
                applyTemplate(tName, 'replace');
            }
        });

        // Right click: template actions menu
        div.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
                showContextMenu(e.clientX, e.clientY, 'template', tName);
            } catch (err) {
                if (confirm(`Delete template '${tName}'?`)) {
                    delete extensionSettings.templates[tName];
                    saveSettings();
                    renderTemplatesList();
                }
            }
        });

        els.listTemplates.appendChild(div);
    });
}

/**
 * Rename a saved template. Overwriting an existing name asks first.
 * @param {string} oldName Current template name.
 */
function EL_renameTemplate(oldName) {
    const list = (extensionSettings.templates || {})[oldName];
    if (!list) return;
    let raw = null;
    try {
        raw = prompt('Enter a new name for template "' + oldName + '":', oldName);
    } catch (e) {
        return;
    }
    if (raw === null || raw === undefined) return;
    const newName = String(raw).trim();
    if (!newName) {
        EL_toast('Template name cannot be empty.', 'error');
        return;
    }
    if (newName === oldName) return;
    if (extensionSettings.templates[newName]) {
        let ok = false;
        try {
            ok = confirm('Template "' + newName + '" already exists. Overwrite?');
        } catch (e) {}
        if (!ok) return;
    }
    extensionSettings.templates[newName] = list;
    delete extensionSettings.templates[oldName];
    saveSettings();
    renderTemplatesList();
    EL_toast('Renamed template "' + oldName + '" to "' + newName + '".', 'success');
}

/**
 * Download the saved templates as a JSON file.
 */
function EL_exportTemplates() {
    try {
        const data = (extensionSettings && extensionSettings.templates) || {};
        download(JSON.stringify(data, null, 2), 'lorebook-templates.json', 'application/json');
        EL_toast('Exported ' + Object.keys(data).length + ' template(s).', 'success');
    } catch (e) {
        EL_toast('Export failed: ' + ((e && e.message) || e), 'error');
    }
}

/**
 * Check an imported templates object has the shape { [name]: string[] }.
 * @param {*} data Parsed JSON value.
 * @returns {boolean} True when the shape is valid.
 */
function EL_isValidTemplatesData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    return Object.entries(data).every(([k, v]) => typeof k === 'string' && Array.isArray(v) && v.every(s => typeof s === 'string'));
}

/**
 * Import templates from a user-picked .json file and MERGE into the current
 * set. Existing names ask before overwriting; nothing is dropped silently.
 * @param {File} file User-picked JSON file.
 */
async function EL_importTemplatesFile(file) {
    if (!file) return;
    let text = '';
    try {
        text = await new Promise((resolve, reject) => {
            try {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(new Error('Could not read file.'));
                reader.readAsText(file);
            } catch (e) {
                reject(e);
            }
        });
    } catch (e) {
        EL_toast('Could not read file: ' + ((e && e.message) || e), 'error');
        return;
    }
    let data = null;
    try {
        data = JSON.parse(text);
    } catch (e) {
        EL_toast('Import failed: file is not valid JSON.', 'error');
        return;
    }
    if (!EL_isValidTemplatesData(data)) {
        EL_toast('Import failed: file must look like { "template name": ["lorebook", ...] }.', 'error');
        return;
    }
    let imported = 0;
    let skipped = 0;
    for (const [tName, books] of Object.entries(data)) {
        const name = String(tName).trim();
        if (!name) {
            skipped++;
            continue;
        }
        if (extensionSettings.templates[name]) {
            let ok = false;
            try {
                ok = confirm('Template "' + name + '" already exists. Overwrite?');
            } catch (e) {}
            if (!ok) {
                skipped++;
                continue;
            }
        }
        extensionSettings.templates[name] = books.slice();
        imported++;
    }
    saveSettings();
    renderTemplatesList();
    EL_toast('Imported ' + imported + ' template(s)' + (skipped ? ' (' + skipped + ' skipped)' : '') + '.', imported ? 'success' : 'info');
}

/**
 * Apply a saved template of global lorebooks.
 * Replace mode clears all globals first (today's behaviour); add mode only
 * switches the template's books on and leaves everything else untouched.
 * Missing books are reported before applying and never silently dropped.
 * @param {string} tName Template name.
 * @param {string} [mode] 'replace' (default) or 'add'.
 */
async function applyTemplate(tName, mode) {
    const list = extensionSettings.templates[tName];
    if (!list) return;
    const m = (mode === 'add') ? 'add' : 'replace';

    try {
        const allNames = (stContext && typeof stContext.getWorldInfoNames === 'function') ? stContext.getWorldInfoNames() : [];
        const missing = Array.isArray(allNames) ? list.filter(n => !allNames.includes(n)) : [];
        if (missing.length) {
            EL_toast('Template "' + tName + '" is missing ' + missing.length + ' lorebook(s): ' + missing.join(', ') + ' — they cannot be selected.', 'warning');
        }
    } catch (e) {}

    const stSelect = ST_Window.document.getElementById('world_info');
    if (stSelect) {
        if (m === 'add') {
            // Additive: switch the template's books on, change nothing else.
            Array.from(stSelect.options).forEach(opt => {
                if (list.includes(opt.text)) {
                    opt.selected = true;
                }
            });
        } else {
            // Clear all
            Array.from(stSelect.options).forEach(opt => opt.selected = false);
            // Select matching
            Array.from(stSelect.options).forEach(opt => {
                if (list.includes(opt.text)) {
                    opt.selected = true;
                }
            });
        }
        // Trigger change
        if (ST_Window.jQuery) {
            ST_Window.jQuery(stSelect).trigger('change');
        } else {
            stSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Also call stContext.saveSettingsDebounced
        stContext.saveSettingsDebounced();
        await refreshSidebar();
    }
}

// ==========================================
// Lorebook Display
// ==========================================
async function openLorebook(name) {
    EL_setLorebookName(name);
    currentViewMode = 'lorebook';
    els.currentTitle.textContent = name;
    els.mainToolbar.style.display = 'flex';
    els.entriesContainer.innerHTML = '';
    els.entriesContainer.classList.remove('hidden');
    selectedEntries.clear();
    lastClickedEntryUid = null;
    try { selectedFolders.clear(); } catch (e) {}
    try { EL_clearDragHighlights(); } catch (e) {}
    try { EL_restoreExpandedFolders(); } catch (e) { try { expandedFolders.clear(); } catch (_e) {} }
    updateBatchButton();
    EL_batchClearUndo();

    document.querySelectorAll('.agent-sidebar-item').forEach(i => i.classList.remove('active'));
    hideAgentPanels();

    const loaded = await stContext.loadWorldInfo(name);
    const loadFailed = !loaded || !loaded.entries;
    EL_setLorebookData(loadFailed ? { entries: {} } : loaded, { own: true });
    if (loadFailed) {
        if (typeof showToast === 'function') showToast('Could not load "' + name + '" — showing an empty view. Folder layout left untouched.');
    }
    ensureFoldersStructure(name, { prune: !loadFailed });
    renderEntries();
}

function showLorebookView() {
    currentViewMode = 'lorebook';
    hideAgentPanels();
    document.querySelectorAll('.agent-sidebar-item').forEach(i => i.classList.remove('active'));
    if (currentLorebookName) {
        els.currentTitle.textContent = currentLorebookName;
        els.entriesContainer.classList.remove('hidden');
        els.mainToolbar.style.display = 'flex';
        renderEntries();
    } else {
        els.currentTitle.textContent = 'No Lorebook Selected';
        els.entriesContainer.classList.remove('hidden');
        els.mainToolbar.style.display = 'none';
        els.entriesContainer.innerHTML = '<div class="empty-state"><i class="fa-solid fa-book-open fa-3x"></i><p>Select a lorebook from the sidebar</p></div>';
    }
}

function ensureFoldersStructure(lbName, { prune = true } = {}) {
    if (!extensionSettings.folders[lbName]) {
        extensionSettings.folders[lbName] = [];
    }
    if (!prune) {
        return;
    }
    // Cleanup: Remove references to non-existent entries from folders
    const existingUids = new Set(Object.keys(currentLorebookData.entries));
    extensionSettings.folders[lbName].forEach(folder => {
        folder.entries = folder.entries.filter(uid => existingUids.has(String(uid)));
    });
}

 // ==========================================
// Whole-lorebook file operations (create / rename / delete / import / export)
// Direct core endpoints only — never the entry guard (ELG_guardSave), which is
// for entry writes with fingerprint verification. Whole-book operations are a
// different class and use /api/worldinfo/* directly.
// ==========================================

/**
 * Validate a lorebook file name BEFORE any core call. Core runs
 * sanitize-filename, so a name with path characters would silently become a
 * different file and could collide with another book.
 * @param {string} name Raw user-supplied name.
 * @param {object} [opts] { checkExists: boolean } — reject names already taken.
 * @returns {string|null} Error message, or null when the name is usable.
 */
function EL_validateLorebookName(name, opts) {
    const o = opts || {};
    const raw = (name === null || name === undefined) ? '' : String(name);
    const trimmed = raw.trim();
    if (!trimmed) return 'Name cannot be empty.';
    if (trimmed === '.' || trimmed === '..') return 'Name cannot be "." or "..".';
    if (/[\/\\:*?"<>|]/.test(trimmed)) return 'Name cannot contain any of / \\ : * ? " < > |.';
    if (/^[. ]/.test(trimmed) || /[. ]$/.test(trimmed)) return 'Name cannot start or end with a dot or space.';
    if (o.checkExists) {
        try {
            const names = (stContext && typeof stContext.getWorldInfoNames === 'function') ? stContext.getWorldInfoNames() : [];
            if (Array.isArray(names) && names.includes(trimmed)) return 'A lorebook named "' + trimmed + '" already exists.';
        } catch (e) {}
    }
    return null;
}

/**
 * Headers for direct core /api/worldinfo/* calls.
 * @returns {object} Header map with at least Content-Type.
 */
function EL_worldinfoHeaders() {
    try {
        if (typeof stContext !== 'undefined' && stContext && typeof stContext.getRequestHeaders === 'function') {
            return stContext.getRequestHeaders();
        }
    } catch (e) {}
    return { 'Content-Type': 'application/json' };
}

/**
 * Read a whole lorebook straight from the core endpoint.
 * @param {string} name Lorebook name.
 * @returns {Promise<object>} Parsed book data.
 */
async function EL_worldinfoGet(name) {
    const resp = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: EL_worldinfoHeaders(),
        body: JSON.stringify({ name: name }),
        cache: 'no-cache',
    });
    if (!resp.ok) throw new Error('Could not read lorebook "' + name + '" (HTTP ' + resp.status + ').');
    return await resp.json();
}

/**
 * Write a whole lorebook via the core edit endpoint (creates when missing).
 * @param {string} name Lorebook name.
 * @param {object} data Book data; must contain an entries object.
 * @returns {Promise<void>}
 */
async function EL_worldinfoEdit(name, data) {
    const resp = await fetch('/api/worldinfo/edit', {
        method: 'POST',
        headers: EL_worldinfoHeaders(),
        body: JSON.stringify({ name: name, data: data }),
        cache: 'no-cache',
    });
    if (!resp.ok) {
        let detail = '';
        try { detail = await resp.text(); } catch (e) {}
        throw new Error('Could not save lorebook "' + name + '" (HTTP ' + resp.status + ')' + (detail ? ' — ' + String(detail).slice(0, 200) : ''));
    }
}

/**
 * Delete a whole lorebook via the core endpoint.
 * @param {string} name Lorebook name.
 * @returns {Promise<void>}
 */
async function EL_worldinfoDelete(name) {
    const resp = await fetch('/api/worldinfo/delete', {
        method: 'POST',
        headers: EL_worldinfoHeaders(),
        body: JSON.stringify({ name: name }),
        cache: 'no-cache',
    });
    if (!resp.ok) {
        let detail = '';
        try { detail = await resp.text(); } catch (e) {}
        throw new Error('Could not delete lorebook "' + name + '" (HTTP ' + resp.status + ')' + (detail ? ' — ' + String(detail).slice(0, 200) : ''));
    }
}

/**
 * Clear the open-book view (empty state + hidden toolbar).
 */
function EL_clearOpenBookView() {
    EL_setLorebookName('');
    EL_setLorebookData(null, { own: false });
    currentLorebookData = null;
    try {
        selectedEntries.clear();
    } catch (e) {}
    try {
        if (els && els.currentTitle) els.currentTitle.textContent = 'No Lorebook Selected';
        if (els && els.entriesContainer) els.entriesContainer.innerHTML = '<div class="empty-state"><i class="fa-solid fa-book-open fa-3x"></i><p>Select a lorebook from the sidebar</p></div>';
        if (els && els.mainToolbar) els.mainToolbar.style.display = 'none';
    } catch (e) {}
}

/**
 * Create a new empty lorebook. Prompts for a name, validates it, writes an
 * empty book via the core edit endpoint, then opens it.
 */
async function EL_createLorebook() {
    let name = null;
    try {
        name = prompt('Enter a name for the new lorebook:');
    } catch (e) {
        return;
    }
    if (name === null || name === undefined) return;
    const trimmed = String(name).trim();
    const err = EL_validateLorebookName(trimmed, { checkExists: true });
    if (err) {
        EL_toast(err, 'error');
        return;
    }
    try {
        await EL_worldinfoEdit(trimmed, { entries: {} });
    } catch (e) {
        EL_toast((e && e.message) || ('Could not create lorebook "' + trimmed + '".'), 'error');
        return;
    }
    try {
        if (stContext && typeof stContext.updateWorldInfoList === 'function') await stContext.updateWorldInfoList();
    } catch (e) {}
    try {
        await refreshSidebar();
    } catch (e) {}
    EL_toast('Created lorebook "' + trimmed + '".', 'success');
    try {
        await openLorebook(trimmed);
    } catch (e) {}
}

/**
 * Rename a lorebook: read old, write new, verify, then delete old.
 * Moves the extension folder layout and, when the renamed book is open,
 * reloads it under the new name. Updating the global World Info selection
 * is opt-in via confirm; chat/character attachments are never auto-updated.
 * @param {string} oldName Current lorebook name.
 */
async function EL_renameLorebook(oldName) {
    if (!oldName) return;
    let raw = null;
    try {
        raw = prompt('Enter a new name for lorebook "' + oldName + '":', oldName);
    } catch (e) {
        return;
    }
    if (raw === null || raw === undefined) return;
    const newName = String(raw).trim();
    if (!newName) {
        EL_toast('Name cannot be empty.', 'error');
        return;
    }
    if (newName === oldName) return;
    const err = EL_validateLorebookName(newName, { checkExists: true });
    if (err) {
        EL_toast(err, 'error');
        return;
    }
    let wasGlobalSelected = false;
    try {
        const stSelect = ST_Window.document.getElementById('world_info');
        if (stSelect) {
            wasGlobalSelected = Array.from(stSelect.selectedOptions).map(opt => opt.text).includes(oldName);
        }
    } catch (e) {}
    let oldData = null;
    try {
        oldData = await EL_worldinfoGet(oldName);
    } catch (e) {
        EL_toast((e && e.message) || ('Could not read lorebook "' + oldName + '".'), 'error');
        return;
    }
    if (!oldData || !oldData.entries || typeof oldData.entries !== 'object') {
        EL_toast('Could not read lorebook "' + oldName + '" — rename aborted.', 'error');
        return;
    }
    const oldCount = Object.keys(oldData.entries).length;
    try {
        await EL_worldinfoEdit(newName, oldData);
    } catch (e) {
        EL_toast((e && e.message) || ('Could not write lorebook "' + newName + '".'), 'error');
        return;
    }
    let newData = null;
    try {
        newData = await EL_worldinfoGet(newName);
    } catch (e) {
        newData = null;
    }
    const newCount = (newData && newData.entries && typeof newData.entries === 'object') ? Object.keys(newData.entries).length : -1;
    if (newCount !== oldCount) {
        EL_toast('Rename verification failed: "' + newName + '" does not match "' + oldName + '" (' + oldCount + ' vs ' + newCount + ' entries). The old lorebook was NOT deleted.', 'error');
        return;
    }
    try {
        await EL_worldinfoDelete(oldName);
    } catch (e) {
        EL_toast((e && e.message) || ('Renamed to "' + newName + '" but could not delete "' + oldName + '".'), 'error');
        return;
    }
    try {
        if (extensionSettings && extensionSettings.folders && extensionSettings.folders[oldName]) {
            extensionSettings.folders[newName] = extensionSettings.folders[oldName];
            delete extensionSettings.folders[oldName];
        }
        saveSettings();
    } catch (e) {}
    try {
        if (stContext && typeof stContext.updateWorldInfoList === 'function') await stContext.updateWorldInfoList();
    } catch (e) {}
    try {
        await refreshSidebar();
    } catch (e) {}
    if (wasGlobalSelected) {
        let doUpdate = false;
        try {
            doUpdate = confirm('"' + oldName + '" was selected as a global lorebook. Switch that selection to "' + newName + '"?');
        } catch (e) {
            doUpdate = false;
        }
        if (doUpdate) {
            try {
                const stSelect = ST_Window.document.getElementById('world_info');
                if (stSelect) {
                    Array.from(stSelect.options).forEach(opt => {
                        if (opt.text === oldName) opt.selected = false;
                        if (opt.text === newName) opt.selected = true;
                    });
                    if (ST_Window.jQuery) ST_Window.jQuery(stSelect).trigger('change');
                    else stSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    if (stContext && typeof stContext.saveSettingsDebounced === 'function') stContext.saveSettingsDebounced();
                    await refreshSidebar();
                }
            } catch (e) {}
        }
    }
    try {
        EL_toast('Chat-attached and character-attached lorebooks referencing "' + oldName + '" were NOT updated automatically — re-select them if needed.', 'warning');
    } catch (e) {}
    if (currentLorebookName === oldName) {
        try {
            EL_setLorebookName(newName);
            if (els && els.currentTitle) els.currentTitle.textContent = newName;
            await openLorebook(newName);
        } catch (e) {}
    }
    EL_toast('Renamed lorebook "' + oldName + '" to "' + newName + '".', 'success');
}

/**
 * Delete a whole lorebook: best-effort server backup, then core delete.
 * Clears the view when the deleted book is open.
 * @param {string} name Lorebook name.
 */
async function EL_deleteLorebook(name) {
    if (!name) return;
    let confirmed = false;
    try {
        confirmed = confirm('Delete lorebook "' + name + '"? This cannot be undone. A backup will be attempted first.');
    } catch (e) {
        return;
    }
    if (!confirmed) return;
    try {
        const client = (typeof BackupClient !== 'undefined') ? new BackupClient({ stContext: stContext }) : null;
        if (client && typeof client.createBackup === 'function') {
            await client.createBackup(name);
        }
    } catch (e) {}
    try {
        await EL_worldinfoDelete(name);
    } catch (e) {
        EL_toast((e && e.message) || ('Could not delete lorebook "' + name + '".'), 'error');
        return;
    }
    try {
        if (extensionSettings && extensionSettings.folders && extensionSettings.folders[name]) {
            delete extensionSettings.folders[name];
        }
        saveSettings();
    } catch (e) {}
    const wasOpen = (currentLorebookName === name);
    if (wasOpen) {
        EL_clearOpenBookView();
        try {
            showLorebookView();
        } catch (e) {}
    }
    try {
        if (stContext && typeof stContext.updateWorldInfoList === 'function') await stContext.updateWorldInfoList();
    } catch (e) {}
    try {
        await refreshSidebar();
    } catch (e) {}
    EL_toast('Deleted lorebook "' + name + '".', 'success');
}

/**
 * Export a whole lorebook as a <name>.json download.
 * @param {string} name Lorebook name.
 */
async function EL_exportLorebook(name) {
    if (!name) {
        EL_toast('Open a lorebook first.', 'warning');
        return;
    }
    let data = null;
    try {
        data = await EL_worldinfoGet(name);
    } catch (e) {
        try {
            if (stContext && typeof stContext.loadWorldInfo === 'function') data = await stContext.loadWorldInfo(name);
        } catch (e2) {}
    }
    if (!data || !data.entries) {
        EL_toast('Could not read lorebook "' + name + '" — export aborted.', 'error');
        return;
    }
    try {
        download(JSON.stringify(data, null, 2), name + '.json', 'application/json');
        EL_toast('Exported lorebook "' + name + '".', 'success');
    } catch (e) {
        EL_toast('Export failed: ' + ((e && e.message) || e), 'error');
    }
}

/**
 * Import a lorebook from a user-picked .json file object.
 * Validates the shape, derives the book name from the filename, and writes
 * via the core edit endpoint (never the multipart import endpoint).
 * @param {File} file User-picked JSON file.
 */
async function EL_importLorebookFile(file) {
    if (!file) return;
    let rawName = String(file.name || 'lorebook');
    if (rawName.toLowerCase().endsWith('.json')) rawName = rawName.slice(0, -5);
    rawName = rawName.trim() || 'lorebook';
    const validateErr = EL_validateLorebookName(rawName, { checkExists: false });
    if (validateErr) {
        EL_toast('Invalid lorebook name "' + rawName + '": ' + validateErr, 'error');
        return;
    }
    let text = '';
    try {
        text = await new Promise((resolve, reject) => {
            try {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(new Error('Could not read file.'));
                reader.readAsText(file);
            } catch (e) {
                reject(e);
            }
        });
    } catch (e) {
        EL_toast('Could not read file: ' + ((e && e.message) || e), 'error');
        return;
    }
    let data = null;
    try {
        data = JSON.parse(text);
    } catch (e) {
        EL_toast('Import failed: file is not valid JSON.', 'error');
        return;
    }
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
        EL_toast('Import failed: file must contain an "entries" object.', 'error');
        return;
    }
    let exists = false;
    try {
        const names = (stContext && typeof stContext.getWorldInfoNames === 'function') ? stContext.getWorldInfoNames() : [];
        exists = Array.isArray(names) && names.includes(rawName);
    } catch (e) {}
    if (exists) {
        let ok = false;
        try {
            ok = confirm('A lorebook named "' + rawName + '" already exists. Overwrite it with the imported file?');
        } catch (e) {}
        if (!ok) return;
    }
    try {
        await EL_worldinfoEdit(rawName, data);
    } catch (e) {
        EL_toast((e && e.message) || ('Could not import lorebook "' + rawName + '".'), 'error');
        return;
    }
    try {
        if (stContext && typeof stContext.updateWorldInfoList === 'function') await stContext.updateWorldInfoList();
    } catch (e) {}
    try {
        await refreshSidebar();
    } catch (e) {}
    EL_toast('Imported lorebook "' + rawName + '".', 'success');
    try {
        await openLorebook(rawName);
    } catch (e) {}
}

/**
 * Current entry-search field scope, read from the toolbar control.
 * @returns {string} 'all', 'keys', 'content' or 'comments'.
 */
function EL_getSearchScope() {
    try {
        const sel = document.getElementById('search-scope');
        const v = sel ? String(sel.value || 'all').toLowerCase() : 'all';
        if (v === 'keys' || v === 'key') return 'keys';
        if (v === 'content') return 'content';
        if (v === 'comments' || v === 'comment') return 'comments';
        return 'all';
    } catch (e) {
        return 'all';
    }
}

/**
 * Escape HTML then highlight every case-insensitive occurrence of term.
 * Splitting on the raw text first keeps escaping correct: user text can
 * never become markup, only the wrapper we add here is markup.
 * @param {string} raw Raw user-supplied text.
 * @param {string} term Current search term (may be empty).
 * @returns {string} Escaped HTML with <mark> wrappers around matches.
 */
function EL_escapeAndHighlight(raw, term) {
    const text = (raw === null || raw === undefined) ? '' : String(raw);
    const q = (term === null || term === undefined) ? '' : String(term);
    if (!q) return escapeHtml(text);
    const lowerText = text.toLowerCase();
    const lowerTerm = q.toLowerCase();
    if (!lowerTerm || lowerText.indexOf(lowerTerm) === -1) return escapeHtml(text);
    let out = '';
    let i = 0;
    while (i <= text.length) {
        const idx = lowerText.indexOf(lowerTerm, i);
        if (idx === -1) {
            out += escapeHtml(text.slice(i));
            break;
        }
        out += escapeHtml(text.slice(i, idx));
        out += '<mark style="background:rgba(250,204,21,0.45); color:inherit; border-radius:2px; padding:0 1px;">' + escapeHtml(text.slice(idx, idx + lowerTerm.length)) + '</mark>';
        i = idx + lowerTerm.length;
        if (i >= text.length) break;
    }
    return out;
}

/**
 * Update the "N matches" label beside the entry search box.
 * Hidden and empty when there is no query.
 * @param {string} query Raw query text (untrimmed is fine).
 */
function EL_updateSearchCount(query) {
    try {
        const el = document.getElementById('search-count');
        if (!el) return;
        const q = (query === null || query === undefined) ? '' : String(query).trim();
        if (!q) {
            el.style.display = 'none';
            el.textContent = '';
            return;
        }
        let n = 0;
        try {
            const entries = (currentLorebookData && currentLorebookData.entries) || {};
            for (const uid of Object.keys(entries)) {
                try {
                    if (getMatchScore({ type: 'entry', uid: String(uid) }, q) > 0) n++;
                } catch (e) {}
            }
        } catch (e) {}
        el.style.display = '';
        el.textContent = (n === 1) ? '1 match' : (n + ' matches');
    } catch (e) {}
}

/**
 * Per-render memoisation context. renderEntries builds ONE context per render so
 * the per-item hot spots below run in O(1) instead of re-walking the tree.
 * Every helper falls back to its direct computation when no context is active,
 * so calls from outside a render stay correct.
 */
function EL_buildRenderContext(query) {
    const term = (query || '').toLowerCase();
    const scope = EL_getSearchScope();
    let startsWithRegex = null;
    let containsRegex = null;
    if (term) {
        const escaped = escapeRegex(term);
        startsWithRegex = new RegExp('^\\b' + escaped + '\\b', 'i');
        containsRegex = new RegExp('\\b' + escaped + '\\b', 'i');
    }
    const folders = (typeof extensionSettings !== 'undefined' && extensionSettings && extensionSettings.folders && currentLorebookName) ? (extensionSettings.folders[currentLorebookName] || []) : [];
    const folderById = new Map();
    const childrenMap = new Map();
    for (const f of folders) {
        if (!f || f.id === undefined || f.id === null) continue;
        if (!folderById.has(f.id)) folderById.set(f.id, f);
        if (f.parentId) {
            if (!childrenMap.has(f.parentId)) childrenMap.set(f.parentId, []);
            childrenMap.get(f.parentId).push(f);
        }
    }
    return {
        query: term,
        scope: scope,
        startsWithRegex: startsWithRegex,
        containsRegex: containsRegex,
        folderById: folderById,
        childrenMap: childrenMap,
        scoreMap: new Map(),
        entryScoreMap: new Map(),
        countMap: new Map(),
    };
}

function EL_fillFolderCounts(ctx) {
    const visiting = new Set();
    function count(id) {
        if (ctx.countMap.has(id)) return ctx.countMap.get(id);
        if (visiting.has(id)) {
            ctx.countMap.set(id, 0);
            return 0;
        }
        const f = ctx.folderById.get(id);
        if (!f) {
            ctx.countMap.set(id, 0);
            return 0;
        }
        visiting.add(id);
        let c = Array.isArray(f.entries) ? f.entries.length : 0;
        const kids = ctx.childrenMap.get(id) || [];
        for (const k of kids) c += count(k.id);
        visiting.delete(id);
        ctx.countMap.set(id, c);
        return c;
    }
    for (const id of ctx.folderById.keys()) count(id);
}

function EL_renderEntryScore(ctx, uid) {
    const key = String(uid);
    if (ctx.entryScoreMap.has(key)) return ctx.entryScoreMap.get(key);
    const s = getMatchScore({ type: 'entry', uid: key }, ctx.query);
    ctx.entryScoreMap.set(key, s);
    return s;
}

function EL_renderFolderScore(ctx, folderId) {
    if (ctx.scoreMap.has(folderId)) return ctx.scoreMap.get(folderId);
    const visiting = ctx._scoreVisiting || (ctx._scoreVisiting = new Set());
    if (visiting.has(folderId)) {
        ctx.scoreMap.set(folderId, 0);
        return 0;
    }
    const f = ctx.folderById.get(folderId);
    if (!f) {
        ctx.scoreMap.set(folderId, 0);
        return 0;
    }
    visiting.add(folderId);
    let max = getMatchScore({ type: 'folder', data: f }, ctx.query);
    const kids = ctx.childrenMap.get(folderId) || [];
    for (const k of kids) {
        const s = EL_renderFolderScore(ctx, k.id);
        if (s > max) max = s;
    }
    if (Array.isArray(f.entries)) {
        for (const uid of f.entries) {
            const s = EL_renderEntryScore(ctx, uid);
            if (s > max) max = s;
        }
    }
    visiting.delete(folderId);
    ctx.scoreMap.set(folderId, max);
    return max;
}

function getFolderPathName(folderId) {
    const folders = extensionSettings.folders[currentLorebookName] || [];
    const path = [];
    let current = folders.find(f => f.id === folderId);
    while (current) {
        path.unshift(current.name);
        if (current.parentId) {
            current = folders.find(f => f.id === current.parentId);
        } else {
            current = null;
        }
    }
    return path.join(' / ');
}

function getFolderRecursiveCount(folderId) {
    if (_elRenderCtx && _elRenderCtx.countMap && _elRenderCtx.countMap.has(folderId)) {
        return _elRenderCtx.countMap.get(folderId);
    }
    const folders = extensionSettings.folders[currentLorebookName] || [];
    const currentFolder = folders.find(f => f.id === folderId);
    if (!currentFolder) return 0;
    
    let count = currentFolder.entries.length;
    folders.forEach(f => {
        if (f.parentId === folderId) {
            count += getFolderRecursiveCount(f.id);
        }
    });
    return count;
}

function getDescendantFolderIds(folderId) {
    const folders = extensionSettings.folders[currentLorebookName] || [];
    const descendants = new Set();
    function collect(parentId) {
        folders.forEach(f => {
            if (f.parentId === parentId) {
                descendants.add(f.id);
                collect(f.id);
            }
        });
    }
    collect(folderId);
    return descendants;
}

function getFolderContentItems(folderId) {
    const folders = extensionSettings.folders[currentLorebookName] || [];
    const currentFolder = folders.find(f => f.id === folderId);
    if (!currentFolder) return [];

    const items = [];
    folders.forEach(f => {
        if (f.parentId === folderId) {
            items.push({
                type: 'folder',
                data: f,
                uids: f.entries,
                order: f.order ?? 100,
            });
        }
    });

    currentFolder.entries.forEach(uid => {
        const entry = currentLorebookData.entries[uid];
        if (entry) {
            items.push({
                type: 'entry',
                uid: uid,
                order: entry.order ?? 100,
            });
        }
    });

    return items;
}

function getRootItems() {
    const folders = extensionSettings.folders[currentLorebookName] || [];
    const items = [];

    folders.forEach(f => {
        const parentExists = f.parentId ? folders.some(parent => parent.id === f.parentId) : false;
        if (!f.parentId || !parentExists) {
            items.push({
                type: 'folder',
                data: f,
                uids: f.entries,
                order: f.order ?? 100,
            });
        }
    });

    const uncategorizedUids = getUncategorizedEntries();
    uncategorizedUids.forEach(uid => {
        const entry = currentLorebookData.entries[uid];
        if (entry) {
            items.push({
                type: 'entry',
                uid: uid,
                order: entry.order ?? 100,
            });
        }
    });

    return items;
}

function getUncategorizedEntries() {
    const allUids = Object.keys(currentLorebookData.entries);
    const folderUids = new Set();
    const folders = extensionSettings.folders[currentLorebookName] || [];
    folders.forEach(f => f.entries.forEach(uid => folderUids.add(String(uid))));

    return allUids.filter(uid => !folderUids.has(String(uid)));
}

function escapeRegex(string) {
    return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function getMatchScore(item, query) {
    if (!query) return 0;
    const term = query.toLowerCase();
    const scope = EL_getSearchScope();

    let startsWithRegex = null;
    let containsRegex = null;
    if (_elRenderCtx && _elRenderCtx.query === term && _elRenderCtx.scope === scope && _elRenderCtx.startsWithRegex && _elRenderCtx.containsRegex) {
        startsWithRegex = _elRenderCtx.startsWithRegex;
        containsRegex = _elRenderCtx.containsRegex;
    } else {
        const escapedFresh = escapeRegex(term);
        startsWithRegex = new RegExp('^\\b' + escapedFresh + '\\b', 'i');
        containsRegex = new RegExp('\\b' + escapedFresh + '\\b', 'i');
    }

    if (item.type === 'folder') {
        const name = (item.data.name || '').toLowerCase();
        if (name === term) return 10000;

        if (startsWithRegex.test(name)) return 5000;
        if (containsRegex.test(name)) return 2000;
        if (name.includes(term)) return 1000;
        return 0;
    } else {
        const entry = currentLorebookData.entries[item.uid];
        if (!entry) return 0;
        const inKeys = (scope === 'all' || scope === 'keys');
        const inComments = (scope === 'all' || scope === 'comments');
        const inContent = (scope === 'all' || scope === 'content');
        const comment = (entry.comment || '').toLowerCase();
        const keys = (Array.isArray(entry.key) ? entry.key : []).map(k => String(k).toLowerCase());
        const keysSecondary = (Array.isArray(entry.keysecondary) ? entry.keysecondary : []).map(k => String(k).toLowerCase());

        if ((inComments && comment === term) || (inKeys && (keys.includes(term) || keysSecondary.includes(term)))) return 10000;

        const startsKeys = inKeys && (keys.some(k => startsWithRegex.test(k)) || keysSecondary.some(k => startsWithRegex.test(k)));
        if ((inComments && startsWithRegex.test(comment)) || startsKeys) return 5000;
        const containsKeys = inKeys && (keys.some(k => containsRegex.test(k)) || keysSecondary.some(k => containsRegex.test(k)));
        if ((inComments && containsRegex.test(comment)) || containsKeys) return 2000;
        const includesKeys = inKeys && (keys.some(k => k.includes(term)) || keysSecondary.some(k => k.includes(term)));
        if ((inComments && comment.includes(term)) || includesKeys) return 1000;

        if (!inContent) return 0;
        const content = (entry.content || '').toLowerCase();
        if (startsWithRegex.test(content)) return 100;
        if (containsRegex.test(content)) return 50;
        if (content.includes(term)) return 10;

        return 0;
    }
}

function getItemMaxScore(item, query) {
    if (!query) return 0;
    const term = (query || '').toLowerCase();
    const scope = EL_getSearchScope();
    if (_elRenderCtx && _elRenderCtx.query === term && _elRenderCtx.scope === scope) {
        if (item.type === 'entry') {
            return EL_renderEntryScore(_elRenderCtx, item.uid);
        }
        const fid = item && item.data ? item.data.id : undefined;
        if (fid !== undefined && fid !== null) {
            if (_elRenderCtx.folderById && _elRenderCtx.folderById.has(fid)) {
                return EL_renderFolderScore(_elRenderCtx, fid);
            }
        }
    }
    if (item.type === 'entry') {
        return getMatchScore(item, query);
    }
    let maxScore = getMatchScore(item, query);
    
    const children = getFolderContentItems(item.data.id);
    for (const child of children) {
        const childScore = getItemMaxScore(child, query);
        if (childScore > maxScore) {
            maxScore = childScore;
        }
    }
    return maxScore;
}

function folderHasMatch(folderId, query) {
    if (!query) return true;
    return getItemMaxScore({ type: 'folder', data: { id: folderId } }, query) > 0;
}

function renderEntries() {
    els.entriesContainer.innerHTML = '';
    if (!currentLorebookName) return;

    // Preserve the selection across re-renders (bulk workflows were destroyed by any
    // sync tick or keystroke). Only drop uids that no longer exist in the book — prune
    // against the book itself, not the filtered view, since a search-hidden entry is
    // still selected.
    if (selectedEntries.size) {
        const live = currentLorebookData && currentLorebookData.entries ? currentLorebookData.entries : {};
        for (const uid of Array.from(selectedEntries)) {
            if (!live[uid]) selectedEntries.delete(uid);
        }
    }
    updateBatchButton();
    const sortSelect = document.getElementById('sort-entries');
    const sortMode = sortSelect ? sortSelect.value : 'order_desc';
    const query = els.searchEntries ? els.searchEntries.value.trim().toLowerCase() : '';

    _elRenderCtx = null;
    try {
        _elRenderCtx = EL_buildRenderContext(query);
        EL_fillFolderCounts(_elRenderCtx);
    } catch (e) {
        _elRenderCtx = null;
    }
    try {
        const sortFn = (a, b) => {
            if (sortMode === 'search') {
                const scoreA = getItemMaxScore(a, query);
                const scoreB = getItemMaxScore(b, query);
                if (scoreA !== scoreB) {
                    return scoreB - scoreA;
                }
                return (b.order ?? 100) - (a.order ?? 100);
            } else if (sortMode === 'order_desc') {
                return (b.order ?? 100) - (a.order ?? 100);
            } else if (sortMode === 'order_asc') {
                return (a.order ?? 100) - (b.order ?? 100);
            } else if (sortMode === 'alpha_asc' || sortMode === 'alpha_desc') {
                let nameA = '', nameB = '';
                if (a.type === 'folder') nameA = a.data.name;
                else {
                    const entryA = currentLorebookData.entries[a.uid];
                    nameA = entryA ? safeJoin(entryA.key, ', ') : '';
                }
                if (b.type === 'folder') nameB = b.data.name;
                else {
                    const entryB = currentLorebookData.entries[b.uid];
                    nameB = entryB ? safeJoin(entryB.key, ', ') : '';
                }
                const cmp = nameA.localeCompare(nameB);
                return sortMode === 'alpha_asc' ? cmp : -cmp;
            }
            return 0;
        };

        let rootItems = getRootItems();
        if (sortMode === 'search' && query) {
            rootItems = rootItems.filter(item => {
                return getItemMaxScore(item, query) > 0;
            });
        }
        rootItems.sort(sortFn);

        rootItems.forEach(item => {
            if (item.type === 'folder') {
                const fDiv = createFolderElement(item.data, item.uids);
                els.entriesContainer.appendChild(fDiv);
            } else {
                const card = createEntryCard(item.uid);
                if (card) els.entriesContainer.appendChild(card);
            }
        });
        try {
            EL_updateSearchCount(query);
        } catch (e) {}
    } finally {
        _elRenderCtx = null;
    }
}

/* eslint-disable-next-line no-unused-vars */
function matchesSearch(uid, query) {
    if (!query) return true;
    const entry = currentLorebookData.entries[uid];
    if (!entry) return false;
    const keys = safeJoin(entry.key, ' ').toLowerCase();
    const content = (entry.content || '').toLowerCase();
    const comment = (entry.comment || '').toLowerCase();
    return keys.includes(query) || content.includes(query) || comment.includes(query);
}

function createFolderElement(folder, filteredUids, isRoot = false) {
    const container = document.createElement('div');
    const isSearching = els.searchEntries && els.searchEntries.value.trim() !== '';
    container.className = `folder-container ${isRoot ? 'root-folder' : (isSearching || expandedFolders.has(folder.id) ? '' : 'collapsed')}`;
    container.dataset.folderId = folder.id;

    const header = document.createElement('div');
    header.className = 'folder-header';

    const totalCount = getFolderRecursiveCount(folder.id);
    let titleHtml = isRoot ? `<i></i><span class="folder-title">${escapeHtml(folder.name)} <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: normal;">(${totalCount})</span></span>` :
        `<i class="fa-solid fa-chevron-down folder-toggle"></i><span class="folder-title">${escapeHtml(folder.name)} <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: normal;">(${totalCount})</span></span>`;

    if (!isRoot) {
        titleHtml += `<div style="margin-left: 12px; display:flex; align-items:center; gap: 4px; font-size: 0.8rem; color: var(--text-muted);">
            <i class="fa-solid fa-sort-numeric-down"></i> Order:
            <input type="number" class="inline-edit folder-order-input" value="${folder.order ?? 100}" style="width: 60px;" data-folder-id="${folder.id}">
        </div>`;
    }

    header.innerHTML = titleHtml;

    if (!isRoot && folder.parentId) {
        try {
            const fullPath = getFolderPathName(folder.id);
            const sep = ' / ';
            const idx = fullPath.lastIndexOf(sep);
            const ancestors = (idx === -1) ? '' : fullPath.slice(0, idx);
            if (ancestors) {
                const crumb = document.createElement('div');
                crumb.className = 'el-breadcrumb';
                crumb.textContent = ancestors;
                crumb.title = fullPath;
                const titleEl = header.querySelector('.folder-title');
                if (titleEl && titleEl.parentNode === header) header.insertBefore(crumb, titleEl.nextSibling);
                else header.appendChild(crumb);
            }
        } catch (e) {}
    }

    if (!isRoot) {
        header.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('label')) return;
            if (e.target.closest('.el-drag-handle')) return;
            if (e.ctrlKey || e.metaKey) {
                e.stopPropagation();
                try { EL_toggleFolderSelected(folder.id, container); } catch (err) {}
                return;
            }
            container.classList.toggle('collapsed');
            if (container.classList.contains('collapsed')) {
                expandedFolders.delete(folder.id);
            } else {
                expandedFolders.add(folder.id);
            }
            try { EL_saveExpandedFolders(); } catch (err) {}
        });

        const orderInput = header.querySelector('.folder-order-input');
        if (orderInput) {
            orderInput.addEventListener('change', (e) => {
                const newOrder = parseInt(e.target.value);
                if (isNaN(newOrder)) return;
                const f = extensionSettings.folders[currentLorebookName].find(f => f.id === folder.id);
                if (f) {
                    f.order = newOrder;
                    saveSettings();
                    renderEntries();
                }
            });
        }

        // Add sub-item, rename, and delete buttons for folder
        const actions = document.createElement('div');
        actions.className = 'folder-actions';
        actions.innerHTML = `
            <button title="Move Folder" class="btn-move-folder"><i class="fa-solid fa-arrow-right-arrow-left"></i></button>
            <button title="Add Sub-item" class="btn-add-sub-item"><i class="fa-solid fa-circle-plus"></i></button>
            <button title="Select All Entries" class="btn-select-folder-entries"><i class="fa-solid fa-check-double"></i></button>
            <button title="Deselect All Entries" class="btn-deselect-folder-entries"><i class="fa-solid fa-xmark"></i></button>
            <button title="Rename" class="btn-rename-folder"><i class="fa-solid fa-pencil"></i></button>
            <button title="Delete Folder" class="btn-delete-folder"><i class="fa-solid fa-trash"></i></button>
        `;

        actions.querySelector('.btn-move-folder').addEventListener('click', (e) => {
            e.stopPropagation();
            showMoveFolderMenu(folder.id);
        });
        actions.querySelector('.btn-add-sub-item').addEventListener('click', (e) => {
            e.stopPropagation();
            openAddItemModal(folder.id);
        });
        actions.querySelector('.btn-select-folder-entries').addEventListener('click', (e) => {
            e.stopPropagation();
            const f = extensionSettings.folders[currentLorebookName]?.find(f => f.id === folder.id);
            if (f) {
                f.entries.forEach(uid => selectedEntries.add(String(uid)));
                document.querySelectorAll('.entry-card').forEach(c => {
                    if (selectedEntries.has(c.dataset.uid)) c.classList.add('selected');
                });
                updateBatchButton();
            }
        });
        actions.querySelector('.btn-deselect-folder-entries').addEventListener('click', (e) => {
            e.stopPropagation();
            const folders = extensionSettings.folders[currentLorebookName] || [];
            function collectFolderUids(folderId) {
                const folder = folders.find(f => f.id === folderId);
                if (!folder) return [];
                let uids = [...folder.entries];
                folders.forEach(f => {
                    if (f.parentId === folderId) {
                        uids = uids.concat(collectFolderUids(f.id));
                    }
                });
                return uids;
            }
            const uidsToDeselect = collectFolderUids(folder.id);
            uidsToDeselect.forEach(uid => {
                const uidStr = String(uid);
                selectedEntries.delete(uidStr);
                const card = document.querySelector(`.entry-card[data-uid="${uidStr}"]`);
                if (card) card.classList.remove('selected');
            });
            updateBatchButton();
        });
        actions.querySelector('.btn-rename-folder').addEventListener('click', (e) => {
            e.stopPropagation();
            renameFolder(folder.id);
        });
        actions.querySelector('.btn-delete-folder').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteFolder(folder.id);
        });
        header.appendChild(actions);

        // Bind context menu on folder header
        header.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(e.clientX, e.clientY, 'folder', folder.id);
        });
    }

    const content = document.createElement('div');
    content.className = 'folder-content';
    if (!isRoot) {
        content.style.paddingLeft = '20px';
        content.style.borderLeft = '1px dashed rgba(255, 255, 255, 0.08)';
    }

    const sortSelect = document.getElementById('sort-entries');
    const sortMode = sortSelect ? sortSelect.value : 'order_desc';
    const query = els.searchEntries ? els.searchEntries.value.trim().toLowerCase() : '';

    const sortFn = (a, b) => {
        if (sortMode === 'search') {
            const scoreA = getItemMaxScore(a, query);
            const scoreB = getItemMaxScore(b, query);
            if (scoreA !== scoreB) {
                return scoreB - scoreA;
            }
            return (b.order ?? 100) - (a.order ?? 100);
        } else if (sortMode === 'order_desc') {
            return (b.order ?? 100) - (a.order ?? 100);
        } else if (sortMode === 'order_asc') {
            return (a.order ?? 100) - (b.order ?? 100);
        } else if (sortMode === 'alpha_asc' || sortMode === 'alpha_desc') {
            let nameA = '', nameB = '';
            if (a.type === 'folder') nameA = a.data.name;
            else {
                const entryA = currentLorebookData.entries[a.uid];
                nameA = entryA ? safeJoin(entryA.key, ', ') : '';
            }
            if (b.type === 'folder') nameB = b.data.name;
            else {
                const entryB = currentLorebookData.entries[b.uid];
                nameB = entryB ? safeJoin(entryB.key, ', ') : '';
            }
            const cmp = nameA.localeCompare(nameB);
            return sortMode === 'alpha_asc' ? cmp : -cmp;
        }
        return 0;
    };

    let contentItems = getFolderContentItems(folder.id);
    if (sortMode === 'search' && query) {
        contentItems = contentItems.filter(item => {
            return getItemMaxScore(item, query) > 0;
        });
    }
    contentItems.sort(sortFn);

    contentItems.forEach(item => {
        if (item.type === 'folder') {
            const fDiv = createFolderElement(item.data, item.uids);
            content.appendChild(fDiv);
        } else {
            const card = createEntryCard(item.uid);
            if (card) content.appendChild(card);
        }
    });

    if (query && contentItems.length === 0) {
        try {
            const ownScore = getMatchScore({ type: 'folder', data: folder }, query);
            if (ownScore > 0) {
                const hint = document.createElement('div');
                hint.className = 'folder-name-match-hint';
                hint.style.cssText = 'font-size:0.8rem; color:var(--text-muted); padding:6px 4px; font-style:italic;';
                hint.textContent = 'Folder name matches — no entries inside match.';
                content.appendChild(hint);
            }
        } catch (e) {}
    }

    container.appendChild(header);
    container.appendChild(content);
    try {
        if (selectedFolders.has(folder.id)) container.classList.add('el-folder-selected');
        if (EL_folderClipboard && EL_folderClipboard.mode === 'cut' && EL_folderClipboard.book === currentLorebookName && Array.isArray(EL_folderClipboard.folderIds) && EL_folderClipboard.folderIds.includes(folder.id)) container.classList.add('el-folder-cut');
    } catch (e) {}
    try { EL_setupFolderDrag(header, container, folder); } catch (e) {}
    try { EL_setupFolderDrop(container, header, content, folder); } catch (e) {}
    return container;
}

function createEntryCard(uid) {
    const entry = currentLorebookData.entries[uid];
    if (!entry) return null;

    const card = document.createElement('div');
    card.className = `entry-card ${selectedEntries.has(String(uid)) ? 'selected' : ''}`;
    card.dataset.uid = String(uid);

    const keysStr = safeJoin(entry.key, ', ');
    const secondaryKeysStr = safeJoin(entry.keysecondary, ', ');

    let badges = [];
    if (entry.disable) badges.push('<span class="badge" style="color:var(--danger-color); border: 1px solid var(--danger-color)">Disabled</span>');
    if (entry.excludeRecursion) badges.push('<span class="badge">Exclude Recursion</span>');
    if (entry.preventRecursion) badges.push('<span class="badge">Prevent Recursion</span>');

    let iconHtml = '';
    if (entry.constant) {
        iconHtml = '<i class="fa-solid fa-circle" style="color: var(--success-color, #10b981); font-size: 0.7rem; margin-right: 6px;" title="Constant"></i>';
    } else {
        if (entry.vectorized || entry.is_vector) {
            iconHtml = '<i class="fa-solid fa-link" style="color: var(--primary-color, #6366f1); font-size: 0.8rem; margin-right: 6px;" title="Vectorized"></i>';
        } else {
            iconHtml = '<i class="fa-solid fa-circle" style="color: var(--primary-color, #6366f1); font-size: 0.7rem; margin-right: 6px;" title="Keyword Activated"></i>';
        }
    }

    const ST_POSITIONS = [
        { pos: 0, role: null, label: '↑Char' },
        { pos: 1, role: null, label: '↓Char' },
        { pos: 5, role: null, label: '↑EM' },
        { pos: 6, role: null, label: '↓EM' },
        { pos: 2, role: null, label: '↑AN' },
        { pos: 3, role: null, label: '↓AN' },
        { pos: 4, role: 0, label: '@D ⚙️' },
        { pos: 4, role: 1, label: '@D 👤' },
        { pos: 4, role: 2, label: '@D 🤖' },
        { pos: 7, role: null, label: '➡️ Outlet' },
    ];

    const posOptions = ST_POSITIONS.map((opt, i) => {
        const isSelected = entry.position === opt.pos && (opt.role === null || entry.role === opt.role);
        return `<option value="${i}" ${isSelected ? 'selected' : ''}>${opt.label}</option>`;
    }).join('');

    const ST_LOGICS = {
        0: 'AND ANY',
        1: 'NOT ALL',
        2: 'NOT ANY',
        3: 'AND ALL',
    };
    const logicName = ST_LOGICS[entry.selectiveLogic] || 'AND ANY';

    const _hlQuery = (els.searchEntries && typeof els.searchEntries.value === 'string') ? els.searchEntries.value.trim() : '';
    const _hlScope = EL_getSearchScope();
    const _hlKeys = !_hlQuery || _hlScope === 'all' || _hlScope === 'keys';
    const _hlComments = !_hlQuery || _hlScope === 'all' || _hlScope === 'comments';
    const _hlContent = !_hlQuery || _hlScope === 'all' || _hlScope === 'content';
    const _keysHtml = _hlKeys ? EL_escapeAndHighlight(keysStr, _hlQuery) : escapeHtml(keysStr);
    const _commentHtml = _hlComments ? EL_escapeAndHighlight(entry.comment, _hlQuery) : escapeHtml(entry.comment);
    const _secKeysHtml = _hlKeys ? EL_escapeAndHighlight(secondaryKeysStr, _hlQuery) : escapeHtml(secondaryKeysStr);
    const _contentHtml = _hlContent ? EL_escapeAndHighlight(entry.content || 'Empty Entry...', _hlQuery) : escapeHtml(entry.content || 'Empty Entry...');

    card.innerHTML = `
        <div class="entry-header" style="align-items: center;">
            <div style="display:flex; flex-direction:column; gap: 4px; flex: 1;">
                <div class="entry-keys" title="${escapeHtml(keysStr)}" style="display:flex; align-items:center;">
                    ${iconHtml}
                    ${entry.comment ? `<span style="color:var(--text-muted)">[${_commentHtml}]</span> ` : ''}
                    ${_keysHtml || '<em>No Primary Keys</em>'}
                </div>
                ${secondaryKeysStr ? `<div style="font-size: 0.8rem; color:var(--text-muted)">Sec: ${_secKeysHtml}</div>` : ''}
            </div>
            <div class="entry-badges" style="flex-wrap: wrap; justify-content: flex-end; max-width: 250px; align-items: center; gap: 8px;">
                ${badges.join('')}
                <input type="checkbox" class="entry-select-checkbox" style="width: 18px; height: 18px; cursor: pointer; margin: 0;">
            </div>
        </div>
        <div class="entry-content" style="-webkit-line-clamp: 2;">${_contentHtml}</div>
        <div class="entry-meta" style="font-size: 0.8rem; color: var(--text-muted); display:flex; gap: 16px; justify-content: flex-start; margin-top: 12px; flex-wrap: wrap; border-top: 1px solid var(--panel-border); padding-top: 8px;">
            <div style="display:flex; align-items:center; gap:4px;"><i class="fa-solid fa-sort-numeric-down"></i> Order: <input type="number" class="inline-edit inline-entry-order" value="${entry.order ?? 100}" style="width:60px;"></div>
            <div style="display:flex; align-items:center; gap:4px;"><i class="fa-solid fa-layer-group"></i> Depth: <input type="number" class="inline-edit inline-entry-depth" value="${entry.depth ?? 4}" style="width:50px;" min="0"></div>
            <div style="display:flex; align-items:center; gap:4px;"><i class="fa-solid fa-map-pin"></i> Pos: <select class="inline-edit inline-entry-pos">${posOptions}</select></div>
            <div style="display:flex; align-items:center; gap:4px;"><i class="fa-solid fa-percent"></i> Prob: <input type="number" class="inline-edit inline-entry-prob" value="${entry.probability ?? 100}" style="width:50px;" min="0" max="100">%</div>
            <span style="display:flex; align-items:center;"><i class="fa-solid fa-filter"></i>&nbsp;Logic: ${logicName}</span>
            ${entry.delay ? `<span style="display:flex; align-items:center;"><i class="fa-solid fa-clock"></i>&nbsp;Delay: ${entry.delay}</span>` : ''}
        </div>
    `;

    card.querySelectorAll('.inline-edit').forEach(input => {
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('change', async (e) => {
            const val = parseInt(e.target.value);
            if (isNaN(val)) return;
            if (e.target.classList.contains('inline-entry-order')) entry.order = val;
            if (e.target.classList.contains('inline-entry-depth')) entry.depth = val;
            if (e.target.classList.contains('inline-entry-pos')) {
                const opt = [
                    { pos: 0, role: null }, { pos: 1, role: null }, { pos: 5, role: null },
                    { pos: 6, role: null }, { pos: 2, role: null }, { pos: 3, role: null },
                    { pos: 4, role: 0 }, { pos: 4, role: 1 }, { pos: 4, role: 2 }, { pos: 7, role: null },
                ][val];
                if (opt) {
                    entry.position = opt.pos;
                    entry.role = opt.role !== null ? opt.role : (entry.role ?? null);
                }
            }
            if (e.target.classList.contains('inline-entry-prob')) entry.probability = val;
            { const _inlineOk = await ELG_guardSave(currentLorebookName, currentLorebookData, { explicitDelete: false, source: 'user', note: 'Inline edit' }); EL_logGuardResult(_inlineOk,'Inline edit',currentLorebookName); if(!_inlineOk){ EL_error('Inline edit blocked/failed'); try{ const f=await ELG_loadFresh(currentLorebookName); if(f) EL_setLorebookData(f, { own: true }); renderEntries(); }catch(e){ EL_warn('reload after inline fail',e);} } }
            if (e.target.classList.contains('inline-entry-order')) {
                renderEntries();
            }
        });
    });

    const checkbox = card.querySelector('.entry-select-checkbox');

    if (checkbox) {
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        checkbox.addEventListener('change', (e) => {
            if (e.target.checked) {
                selectedEntries.add(card.dataset.uid);
                card.classList.add('selected');
            } else {
                selectedEntries.delete(card.dataset.uid);
                card.classList.remove('selected');
            }
            updateBatchButton();
            lastClickedEntryUid = card.dataset.uid;
        });
    }

    // Edit
    card.addEventListener('click', (e) => {
        const uid = card.dataset.uid;
        if (e.shiftKey && lastClickedEntryUid) {
            const cards = Array.from(document.querySelectorAll('.entry-card'));
            const anchorIdx = cards.findIndex(c => c.dataset.uid === lastClickedEntryUid);
            const clickedIdx = cards.findIndex(c => c.dataset.uid === uid);
            if (anchorIdx !== -1 && clickedIdx !== -1) {
                const [start, end] = anchorIdx < clickedIdx ? [anchorIdx, clickedIdx] : [clickedIdx, anchorIdx];
                for (let i = start; i <= end; i++) {
                    const rangeUid = cards[i].dataset.uid;
                    selectedEntries.add(rangeUid);
                    cards[i].classList.add('selected');
                }
                updateBatchButton();
            }
            lastClickedEntryUid = uid;
        } else if (e.ctrlKey || e.metaKey) {
            if (selectedEntries.has(uid)) {
                selectedEntries.delete(uid);
                card.classList.remove('selected');
            } else {
                selectedEntries.add(uid);
                card.classList.add('selected');
            }
            updateBatchButton();
            lastClickedEntryUid = uid;
        } else {
            openEditEntryModal(uid);
            lastClickedEntryUid = uid;
        }
    });

    const observer = new MutationObserver(() => {
        if (checkbox) checkbox.checked = card.classList.contains('selected');
    });
    observer.observe(card, { attributes: true, attributeFilter: ['class'] });

    // Context Menu
    card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!selectedEntries.has(card.dataset.uid)) {
            selectedEntries.clear();
            document.querySelectorAll('.entry-card').forEach(el => el.classList.remove('selected'));
            selectedEntries.add(card.dataset.uid);
            card.classList.add('selected');
            updateBatchButton();
            lastClickedEntryUid = card.dataset.uid;
        }
        showContextMenu(e.clientX, e.clientY);
    });

    try { EL_setupEntryDrag(card, String(uid)); } catch (e) {}

    return card;
}

function updateBatchButton() {
    const hasEntries = Object.keys(currentLorebookData?.entries || {}).length > 0;
    if (selectedEntries.size > 0) {
        els.btnBatchOptions.removeAttribute('disabled');
        els.btnBatchOptions.innerHTML = `<i class="fa-solid fa-layer-group"></i> Batch (${selectedEntries.size})`;
        if (els.btnDeselectAll) els.btnDeselectAll.style.display = 'inline-block';
    } else {
        els.btnBatchOptions.setAttribute('disabled', 'true');
        els.btnBatchOptions.innerHTML = '<i class="fa-solid fa-layer-group"></i> Batch';
        if (els.btnDeselectAll) els.btnDeselectAll.style.display = 'none';
    }
    if (els.btnSelectAll) {
        els.btnSelectAll.style.display = hasEntries ? 'inline-block' : 'none';
    }
    if (els.btnDownload) {
        if (selectedEntries.size > 0) {
            els.btnDownload.removeAttribute('disabled');
            els.btnDownload.style.display = 'inline-block';
        } else {
            els.btnDownload.setAttribute('disabled', 'true');
            els.btnDownload.style.display = 'none';
        }
    }
}

function showDownloadFormatPicker() {
    els.contextMenu.innerHTML = '';
    const rect = els.btnDownload.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        els.contextMenu.style.left = `${rect.left}px`;
        els.contextMenu.style.top = `${rect.bottom + 4}px`;
    } else {
        const toolbarRect = els.mainToolbar?.getBoundingClientRect();
        if (toolbarRect) {
            els.contextMenu.style.left = `${toolbarRect.right - 200}px`;
            els.contextMenu.style.top = `${toolbarRect.bottom + 4}px`;
        } else {
            els.contextMenu.style.left = '16px';
            els.contextMenu.style.top = '60px';
        }
    }

    const jsonItem = document.createElement('div');
    jsonItem.className = 'context-item';
    jsonItem.innerHTML = '<i class="fa-solid fa-file-code"></i> Download as JSON';
    jsonItem.addEventListener('click', () => {
        els.contextMenu.classList.remove('visible');
        downloadSelectedEntries('json');
    });
    els.contextMenu.appendChild(jsonItem);

    const txtItem = document.createElement('div');
    txtItem.className = 'context-item';
    txtItem.innerHTML = '<i class="fa-solid fa-file-lines"></i> Download as Plain Text';
    txtItem.addEventListener('click', () => {
        els.contextMenu.classList.remove('visible');
        downloadSelectedEntries('txt');
    });
    els.contextMenu.appendChild(txtItem);

    els.contextMenu.classList.add('visible');
}

async function downloadSelectedEntries(format) {
    if (selectedEntries.size === 0) return;

    const entries = [];
    for (const uid of selectedEntries) {
        const entry = currentLorebookData.entries[uid];
        if (entry) entries.push(entry);
    }

    if (entries.length === 0) return;

    const sanitizedName = (currentLorebookName || 'lorebook').replace(/[^a-zA-Z0-9_-]/g, '_');

    let content, mimeType, ext;

    if (format === 'json') {
        content = JSON.stringify(entries, null, 2);
        mimeType = 'application/json';
        ext = 'json';
    } else {
        content = entries.map(e => {
            const lines = [];
            lines.push(`[${e.comment || 'Untitled'}]`);
            const keys = safeJoin(e.key, ', ');
            if (keys) lines.push(`Keys: ${keys}`);
            const secKeys = safeJoin(e.keysecondary, ', ');
            if (secKeys) lines.push(`Secondary Keys: ${secKeys}`);
            lines.push('');
            lines.push(e.content || '');
            return lines.join('\n');
        }).join('\n---\n');
        mimeType = 'text/plain';
        ext = 'txt';
    }

    const filename = `${sanitizedName}_${entries.length}_entries.${ext}`;

    download(content, filename, mimeType);

    showToast(`Downloaded ${entries.length} entries as ${ext.toUpperCase()}`);
}

function download(content, fileName, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ==========================================
// Folder Actions
// ==========================================


function renameFolder(folderId) {
    const folder = extensionSettings.folders[currentLorebookName].find(f => f.id === folderId);
    if (!folder) return;
    let name = null;
    try {
        name = prompt('Enter new folder name:', folder.name);
    } catch (e) {
        return;
    }
    if (name === null || name === undefined) return;
    const err = EL_validateFolderName(name, folder.parentId, folder.id);
    if (err) {
        try { EL_toast(err, 'error'); } catch (e) {}
        return;
    }
    folder.name = String(name).trim();
    saveSettings();
    renderEntries();
}

function deleteFolder(folderId) {
    if (!confirm('Delete this folder? (Entries will be moved to Root, subfolders will be moved to the parent level)')) return;
    
    const folder = extensionSettings.folders[currentLorebookName].find(f => f.id === folderId);
    if (!folder) return;
    
    const parentId = folder.parentId || null;
    
    // Reparent subfolders
    extensionSettings.folders[currentLorebookName].forEach(f => {
        if (f.parentId === folderId) {
            f.parentId = parentId;
        }
    });

    // Remove the folder
    extensionSettings.folders[currentLorebookName] = extensionSettings.folders[currentLorebookName].filter(f => f.id !== folderId);
    
    saveSettings();
    renderEntries();
}

function showMoveFolderMenu(sourceFolderId) {
    const folders = extensionSettings.folders[currentLorebookName] || [];
    const sourceFolder = folders.find(f => f.id === sourceFolderId);
    if (!sourceFolder) return;

    const excludeIds = new Set([sourceFolderId, ...getDescendantFolderIds(sourceFolderId)]);

    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal active';
    overlay.id = 'move-folder-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content glass-panel';
    content.style.width = '420px';

    content.innerHTML = `
        <div class="modal-header">
            <h3><i class="fa-solid fa-arrow-right-arrow-left" style="margin-right: 8px;"></i>Move Folder</h3>
            <button class="close-modal"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="modal-body">
            <p style="margin-bottom: 12px; color: var(--text-muted); font-size: 0.9rem;">Moving: <strong style="color: var(--text-color);">${escapeHtml(getFolderPathName(sourceFolderId))}</strong></p>
            <div class="searchable-folder-picker">
                <div class="folder-picker-search-wrapper">
                    <i class="fa-solid fa-search"></i>
                    <input type="text" placeholder="Search target folders..." class="folder-picker-search" id="move-folder-search">
                </div>
                <div class="folder-picker-list" id="move-folder-list" style="max-height: 280px;"></div>
            </div>
        </div>
    `;

    overlay.appendChild(content);
    document.body.appendChild(overlay);
    EL_modalOpen(overlay);

    const searchInput = document.getElementById('move-folder-search');
    const listContainer = document.getElementById('move-folder-list');

    function renderList(query = '') {
        listContainer.innerHTML = '';
        const term = query.toLowerCase();

        // Root option
        if ('root (no parent)'.includes(term)) {
            const rootItem = document.createElement('div');
            rootItem.className = 'folder-picker-item' + (!sourceFolder.parentId ? ' selected' : '');
            rootItem.innerHTML = '<i class="fa-solid fa-house"></i> Root (No Parent)';
            rootItem.addEventListener('click', () => {
                executeFolderMove(sourceFolderId, null);
                EL_modalClose(overlay);
                overlay.remove();
            });
            listContainer.appendChild(rootItem);
        }

        // Valid target folders (exclude self and descendants)
        const validFolders = folders.filter(f => !excludeIds.has(f.id));
        const filtered = validFolders.filter(f => {
            const pathName = getFolderPathName(f.id);
            return pathName.toLowerCase().includes(term);
        });

        filtered.forEach(f => {
            const item = document.createElement('div');
            const isCurrentParent = sourceFolder.parentId === f.id;
            item.className = 'folder-picker-item' + (isCurrentParent ? ' selected' : '');
            const pathName = getFolderPathName(f.id);
            item.innerHTML = `<i class="fa-solid fa-folder"></i> ${escapeHtml(pathName)}`;
            item.addEventListener('click', () => {
                executeFolderMove(sourceFolderId, f.id);
                EL_modalClose(overlay);
                overlay.remove();
            });
            listContainer.appendChild(item);
        });

        if (listContainer.children.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'folder-picker-empty';
            empty.textContent = 'No matching folders';
            listContainer.appendChild(empty);
        }
    }

    renderList();

    searchInput.addEventListener('input', () => renderList(searchInput.value));
    searchInput.addEventListener('keydown', (e) => e.stopPropagation());

    // Close handlers
    content.querySelector('.close-modal').addEventListener('click', () => { EL_modalClose(overlay); overlay.remove(); });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { EL_modalClose(overlay); overlay.remove(); }
    });

    setTimeout(() => searchInput.focus(), 50);
}

function executeFolderMove(folderId, targetParentId) {
    const folders = extensionSettings.folders[currentLorebookName] || [];
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return;

    const res = EL_moveFolderToParent(folderId, targetParentId);
    if (!res || !res.ok) {
        try { EL_toast((res && res.reason) || 'Cannot move folder.', 'error'); } catch (e) {}
        return;
    }

    saveSettings();
    try { EL_saveExpandedFolders(); } catch (e) {}
    renderEntries();
    try {
        const label = targetParentId ? getFolderPathName(targetParentId) : 'root';
        EL_toast('Moved folder "' + ((res.folder && res.folder.name) || '') + '" to ' + label + '.', 'success');
    } catch (e) {}
}

// ==========================================
// Entry Creation & Batch
// ==========================================
// ==========================================
// Revamped Add Item Modal & Excel Grid logic
// ==========================================
let advancedRows = [];
let selectedIndividualRowId = null;

function renderAddItemParentFolderList(query = '') {
    const hiddenInput = document.getElementById('add-item-parent');
    const listContainer = document.getElementById('add-item-parent-list');
    const searchInput = document.getElementById('add-item-parent-search');
    if (!hiddenInput || !listContainer) return;
    
    listContainer.innerHTML = '';
    const term = query.toLowerCase();

    const folders = extensionSettings.folders[currentLorebookName] || [];

    // Root option
    if ('root (no folder)'.includes(term) || 'uncategorized'.includes(term) || '-- no folder (root) --'.includes(term)) {
        const rootItem = document.createElement('div');
        rootItem.className = 'folder-picker-item' + (hiddenInput.value === '' ? ' selected' : '');
        rootItem.innerHTML = '<i class="fa-solid fa-house"></i> Root (No Folder)';
        rootItem.addEventListener('click', () => {
            hiddenInput.value = '';
            renderAddItemParentFolderList(searchInput ? searchInput.value : '');
        });
        listContainer.appendChild(rootItem);
    }

    const filtered = folders.filter(f => {
        const pathName = getFolderPathName(f.id);
        return pathName.toLowerCase().includes(term);
    });

    filtered.forEach(f => {
        const item = document.createElement('div');
        item.className = 'folder-picker-item' + (hiddenInput.value === f.id ? ' selected' : '');
        const pathName = getFolderPathName(f.id);
        item.innerHTML = `<i class="fa-solid fa-folder"></i> ${escapeHtml(pathName)}`;
        item.addEventListener('click', () => {
            hiddenInput.value = f.id;
            renderAddItemParentFolderList(searchInput ? searchInput.value : '');
        });
        listContainer.appendChild(item);
    });

    if (listContainer.children.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'folder-picker-empty';
        empty.textContent = 'No matching folders';
        listContainer.appendChild(empty);
    }
}

function openAddItemModal(parentFolderId = null) {
    if (!currentLorebookName) return;

    // Populate parent folder picker
    const hiddenInput = document.getElementById('add-item-parent');
    if (hiddenInput) {
        hiddenInput.value = parentFolderId || '';
    }
    const searchInput = document.getElementById('add-item-parent-search');
    if (searchInput) {
        searchInput.value = '';
    }
    renderAddItemParentFolderList('');

    // Reset Quick tab inputs
    document.getElementById('quick-entry-comments').value = '';
    document.getElementById('quick-entry-count').value = '1';
    document.getElementById('quick-entry-keys').value = '';
    document.getElementById('quick-entry-order').value = '100';
    document.getElementById('quick-entry-depth').value = '4';
    document.getElementById('quick-entry-probability').value = '100';
    document.getElementById('quick-entry-position').selectedIndex = 0;
    document.getElementById('quick-entry-constant').checked = false;
    document.getElementById('quick-entry-vectorized').checked = false;
    document.getElementById('quick-entry-selective').checked = false;
    document.getElementById('quick-entry-disable').checked = false;
    document.getElementById('quick-entry-exclude').checked = false;
    document.getElementById('quick-entry-prevent').checked = false;

    document.getElementById('quick-folder-names').value = '';
    document.getElementById('quick-folder-order').value = '100';

    // Select "Entry" item type by default in Quick Creation
    const radios = document.getElementsByName('quick-item-type');
    radios.forEach(r => {
        if (r.value === 'entry') r.checked = true;
    });
    document.getElementById('quick-entry-fields').style.display = 'flex';
    document.getElementById('quick-folder-fields').style.display = 'none';

    // Reset Advanced tab inputs
    advancedRows = [];
    document.getElementById('adv-excel-tbody').innerHTML = '';
    selectedIndividualRowId = null;
    document.getElementById('ind-variables-list').innerHTML = '';
    document.getElementById('ind-form-fields').style.display = 'none';
    document.getElementById('ind-form-placeholder').style.display = 'flex';

    // Set first row automatically in Advanced Creation Excel table
    addNewExcelRow();

    // Select default tab "Quick Creation"
    document.querySelectorAll('#add-item-modal .tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === 'quick');
        if (btn.dataset.tab === 'quick') {
            btn.style.color = 'var(--primary-color)';
            btn.style.borderBottom = '2px solid var(--primary-color)';
        } else {
            btn.style.color = 'var(--text-muted)';
            btn.style.borderBottom = 'none';
        }
    });
    document.getElementById('quick-creation-tab').style.display = 'flex';
    document.getElementById('advanced-creation-tab').style.display = 'none';
    document.getElementById('xml-creation-tab').style.display = 'none';

    // Reset XML tab inputs
    document.getElementById('xml-input').value = '';
    document.getElementById('xml-apply-order').checked = true;
    document.getElementById('xml-order').value = '100';
    document.getElementById('xml-apply-position').checked = false;
    document.getElementById('xml-position').selectedIndex = 0;
    document.getElementById('xml-apply-depth').checked = false;
    document.getElementById('xml-depth').value = '4';
    document.getElementById('xml-apply-probability').checked = false;
    document.getElementById('xml-probability').value = '100';
    document.getElementById('xml-constant').checked = false;
    document.getElementById('xml-vectorized').checked = false;
    document.getElementById('xml-selective').checked = false;
    document.getElementById('xml-disable').checked = false;
    document.getElementById('xml-exclude').checked = false;
    document.getElementById('xml-prevent').checked = false;

    // Reset settings mini-tabs in Advanced view
    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sview === 'general');
    });
    document.getElementById('adv-settings-general').style.display = 'flex';
    document.getElementById('adv-settings-individual').style.display = 'none';

    // Remove peek mode
    document.getElementById('add-item-modal').classList.remove('peek-mode');

    // Show modal
    EL_modalOpen('add-item-modal');
}

function closeAddItemModal() {
    EL_modalClose('add-item-modal');
    document.getElementById('add-item-modal').classList.remove('peek-mode');
}

function addNewExcelRow() {
    const rowId = 'row_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const newRow = {
        id: rowId,
        comment: '',
        key: '',
        keysecondary: '',
        content: '',
        settings: {
            order: 100,
            position: 0,
            role: null,
            depth: 4,
            probability: 100,
            constant: false,
            vectorized: false,
            selective: false,
            disable: false,
            excludeRecursion: false,
            preventRecursion: false
        }
    };
    advancedRows.push(newRow);
    renderExcelRow(newRow);
    updateIndividualVariablesList();
}

function renderExcelRow(row) {
    const tbody = document.getElementById('adv-excel-tbody');
    const tr = document.createElement('tr');
    tr.dataset.rowId = row.id;
    tr.style.borderBottom = '1px solid var(--panel-border)';

    const index = advancedRows.findIndex(r => r.id === row.id) + 1;

    tr.innerHTML = `
        <td class="excel-row-num" style="padding: 6px; text-align: center; color: var(--text-muted); font-size: 0.8rem; font-weight: bold;">${index}</td>
        <td style="padding: 4px;"><input type="text" class="excel-comment" value="${escapeHtml(row.comment)}" placeholder="Comment/Title" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid var(--panel-border); color: var(--text-color); padding: 6px; border-radius: 4px; font-size: 0.85rem; outline: none;"></td>
        <td style="padding: 4px;"><input type="text" class="excel-keys" value="${escapeHtml(row.key)}" placeholder="e.g. hero, protagonist" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid var(--panel-border); color: var(--text-color); padding: 6px; border-radius: 4px; font-size: 0.85rem; outline: none;"></td>
        <td style="padding: 4px;"><input type="text" class="excel-seckeys" value="${escapeHtml(row.keysecondary)}" placeholder="e.g. secondary keys" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid var(--panel-border); color: var(--text-color); padding: 6px; border-radius: 4px; font-size: 0.85rem; outline: none;"></td>
        <td style="padding: 4px;"><textarea class="excel-cell-content" placeholder="Content..." style="width: 100%; background: rgba(0,0,0,0.3); border: 1px solid var(--panel-border); color: var(--text-color); padding: 6px; border-radius: 4px; font-size: 0.85rem; outline: none; height: 28px; resize: none; overflow-y: auto; white-space: pre-wrap; line-height: 1.2; font-family: inherit;"></textarea></td>
        <td style="padding: 4px; text-align: center;"><button class="btn-delete-row" title="Delete Row" style="background:transparent; border:none; color:var(--danger-color); cursor:pointer;"><i class="fa-solid fa-trash-can"></i></button></td>
    `;

    // Bind event listeners
    tr.querySelector('.excel-comment').addEventListener('input', (e) => {
        row.comment = e.target.value;
        updateIndividualVariablesList();
    });
    tr.querySelector('.excel-keys').addEventListener('input', (e) => {
        row.key = e.target.value;
    });
    tr.querySelector('.excel-seckeys').addEventListener('input', (e) => {
        row.keysecondary = e.target.value;
    });
    tr.querySelector('.excel-cell-content').addEventListener('input', (e) => {
        row.content = e.target.value;
    });
    tr.querySelector('.btn-delete-row').addEventListener('click', () => {
        const idx = advancedRows.findIndex(r => r.id === row.id);
        if (idx !== -1) {
            advancedRows.splice(idx, 1);
            tr.remove();
            // Re-index rows
            const rows = tbody.querySelectorAll('tr');
            rows.forEach((r, i) => {
                r.querySelector('.excel-row-num').textContent = i + 1;
            });
            updateIndividualVariablesList();
            if (selectedIndividualRowId === row.id) {
                selectedIndividualRowId = null;
                document.getElementById('ind-form-fields').style.display = 'none';
                document.getElementById('ind-form-placeholder').style.display = 'flex';
            }
        }
    });

    tbody.appendChild(tr);
}

function updateIndividualVariablesList() {
    const container = document.getElementById('ind-variables-list');
    container.innerHTML = '';

    advancedRows.forEach((row, i) => {
        const name = row.comment.trim() || `Entry ${i + 1}`;
        const div = document.createElement('div');
        div.className = `ind-var-item ${selectedIndividualRowId === row.id ? 'selected' : ''}`;
        div.dataset.rowId = row.id;

        div.innerHTML = `
            <label style="display:flex; align-items:center; gap:8px; width:100%; cursor:pointer; margin:0;">
                <input type="checkbox" class="ind-select-checkbox" data-row-id="${row.id}" style="width:14px; height:14px; margin:0;">
                <span style="font-size:0.85rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;">${escapeHtml(name)}</span>
            </label>
        `;

        div.addEventListener('click', (e) => {
            if (e.target.tagName.toLowerCase() === 'input') return;
            selectedIndividualRowId = row.id;
            document.querySelectorAll('.ind-var-item').forEach(el => el.classList.remove('selected'));
            div.classList.add('selected');
            const chk = div.querySelector('.ind-select-checkbox');
            chk.checked = true;
            onIndividualSelectionChanged();
        });

        div.querySelector('.ind-select-checkbox').addEventListener('change', () => {
            onIndividualSelectionChanged();
        });

        container.appendChild(div);
    });
}

function getSelectedRowIds() {
    const checkboxes = document.querySelectorAll('#ind-variables-list .ind-select-checkbox:checked');
    return Array.from(checkboxes).map(chk => chk.dataset.rowId);
}

function onIndividualSelectionChanged() {
    const selectedIds = getSelectedRowIds();
    const fields = document.getElementById('ind-form-fields');
    const placeholder = document.getElementById('ind-form-placeholder');

    if (selectedIds.length === 0) {
        fields.style.display = 'none';
        placeholder.style.display = 'flex';
        return;
    }

    placeholder.style.display = 'none';
    fields.style.display = 'flex';

    const label = document.getElementById('ind-selection-label');
    if (selectedIds.length === 1) {
        const row = advancedRows.find(r => r.id === selectedIds[0]);
        label.textContent = `Editing: ${row.comment.trim() || 'Entry'}`;
        document.getElementById('ind-order').value = row.settings.order ?? 100;
        document.getElementById('ind-depth').value = row.settings.depth ?? 4;
        document.getElementById('ind-probability').value = row.settings.probability ?? 100;
        
        const positionSelect = document.getElementById('ind-position');
        Array.from(positionSelect.options).forEach(opt => {
            const matchPos = parseInt(opt.value) === row.settings.position;
            const roleAttr = opt.dataset.role;
            const matchRole = roleAttr !== '' ? parseInt(roleAttr) === row.settings.role : true;
            if (matchPos && matchRole) opt.selected = true;
        });

        document.getElementById('ind-constant').checked = !!row.settings.constant;
        document.getElementById('ind-vectorized').checked = !!row.settings.vectorized;
        document.getElementById('ind-selective').checked = !!row.settings.selective;
        document.getElementById('ind-disable').checked = !!row.settings.disable;
        document.getElementById('ind-exclude').checked = !!row.settings.excludeRecursion;
        document.getElementById('ind-prevent').checked = !!row.settings.preventRecursion;
    } else {
        label.textContent = `Editing: ${selectedIds.length} entries (Batch)`;
    }
}

function setupIndividualFormListeners() {
    const updateSetting = (key, value) => {
        const selectedIds = getSelectedRowIds();
        selectedIds.forEach(id => {
            const row = advancedRows.find(r => r.id === id);
            if (row) {
                row.settings[key] = value;
            }
        });
    };

    document.getElementById('ind-order').addEventListener('change', (e) => updateSetting('order', parseInt(e.target.value) || 100));
    document.getElementById('ind-depth').addEventListener('change', (e) => updateSetting('depth', parseInt(e.target.value) || 4));
    document.getElementById('ind-probability').addEventListener('change', (e) => updateSetting('probability', parseInt(e.target.value) || 100));
    
    document.getElementById('ind-position').addEventListener('change', (e) => {
        const opt = e.target.selectedOptions[0];
        const pos = parseInt(opt.value) || 0;
        const role = opt.dataset.role !== '' ? parseInt(opt.dataset.role) : null;
        const selectedIds = getSelectedRowIds();
        selectedIds.forEach(id => {
            const row = advancedRows.find(r => r.id === id);
            if (row) {
                row.settings.position = pos;
                row.settings.role = role;
            }
        });
    });

    document.getElementById('ind-constant').addEventListener('change', (e) => {
        updateSetting('constant', e.target.checked);
        if (e.target.checked) document.getElementById('ind-vectorized').checked = false;
    });
    document.getElementById('ind-vectorized').addEventListener('change', (e) => {
        updateSetting('vectorized', e.target.checked);
        if (e.target.checked) document.getElementById('ind-constant').checked = false;
    });
    document.getElementById('ind-selective').addEventListener('change', (e) => updateSetting('selective', e.target.checked));
    document.getElementById('ind-disable').addEventListener('change', (e) => updateSetting('disable', e.target.checked));
    document.getElementById('ind-exclude').addEventListener('change', (e) => updateSetting('excludeRecursion', e.target.checked));
    document.getElementById('ind-prevent').addEventListener('change', (e) => updateSetting('preventRecursion', e.target.checked));
}

const XML_TEMPLATE = `<Title>My Entry</Title>
<Key>keyword1, keyword2</Key>
<Content>Your entry content goes here...</Content>

<Title>Advanced Entry</Title>
<Key>primary_key1, primary_key2</Key>
<Keysecondary>secondary_key1, secondary_key2</Keysecondary>
<Content>Your detailed entry content goes here...</Content>
<Order>100</Order>
<Depth>4</Depth>
<Probability>100</Probability>
<Position>0</Position>
<Role></Role>
<Selectivelogic>0</Selectivelogic>
<Constant>false</Constant>
<Vectorized>false</Vectorized>
<Selective>false</Selective>
<Disable>false</Disable>
<Excluderecursion>false</Excluderecursion>
<Preventrecursion>false</Preventrecursion>
<Ignorebudget>false</Ignorebudget>
<Addmemo>false</Addmemo>
<Group>group_name</Group>
<Groupoverride>false</Groupoverride>
<Groupweight>100</Groupweight>
<Sticky></Sticky>
<Cooldown></Cooldown>
<Delay></Delay>
<Outletname>outlet_name</Outletname>
<Triggers>trigger1, trigger2</Triggers>
<Scandepth></Scandepth>
<Casesensitive></Casesensitive>
<Matchwholewords></Matchwholewords>
<Usegroupscoring></Usegroupscoring>
<Automationid>automation_id</Automationid>
<Delay_until_recursion>false</Delay_until_recursion>
<Delayuntilrecursionlevel>1</Delayuntilrecursionlevel>
<Useprobability>true</Useprobability>
<Characterfilterexclude>false</Characterfilterexclude>
<Matchcharacterdescription>false</Matchcharacterdescription>
<Matchcharacterpersonality>false</Matchcharacterpersonality>
<Matchscenario>false</Matchscenario>
<Matchpersonadescription>false</Matchpersonadescription>
<Matchcharacterdepthprompt>false</Matchcharacterdepthprompt>
<Matchcreatornotes>false</Matchcreatornotes>`;

function showToast(message) {
    EL_toast(message, 'info');
}

function showCopyToast() {
    EL_toast('Template copied to clipboard!', 'success');
}

function copyXmlTemplate() {
    navigator.clipboard.writeText(XML_TEMPLATE).catch(() => {
        const textarea = document.createElement('textarea');
        textarea.value = XML_TEMPLATE;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
    });
    showCopyToast();
}

function parseXmlEntries(text) {
    const tagPattern = /<(\w+)>([\s\S]*?)<\/\1>/gi;
    const allTags = [];
    let tagMatch;
    while ((tagMatch = tagPattern.exec(text)) !== null) {
        allTags.push({
            tag: tagMatch[1].toLowerCase(),
            value: tagMatch[2].trim(),
        });
    }

    const entries = [];
    let currentEntry = null;

    for (const t of allTags) {
        if (t.tag === 'title' || t.tag === 'comment') {
            if (currentEntry) entries.push(currentEntry);
            currentEntry = { comment: t.value, keys: [], keysecondary: [], content: '', overrides: {} };
            continue;
        }
        if (!currentEntry && ['key', 'keys', 'content'].includes(t.tag)) {
            currentEntry = { comment: '', keys: [], keysecondary: [], content: '', overrides: {} };
        }
        if (!currentEntry) continue;

        switch (t.tag) {
            case 'key':
            case 'keys':
                currentEntry.keys = t.value.split(',').map(s => s.trim()).filter(Boolean);
                break;
            case 'keysecondary':
            case 'secondary_keys':
            case 'secondarykeys':
                currentEntry.keysecondary = t.value.split(',').map(s => s.trim()).filter(Boolean);
                break;
            case 'content':
                currentEntry.content = t.value;
                break;
            case 'order':
                currentEntry.overrides.order = parseInt(t.value) || 100;
                break;
            case 'depth':
                currentEntry.overrides.depth = parseInt(t.value) || 4;
                break;
            case 'probability':
            case 'prob':
                currentEntry.overrides.probability = parseInt(t.value);
                if (isNaN(currentEntry.overrides.probability)) delete currentEntry.overrides.probability;
                break;
            case 'position':
            case 'strategy':
                currentEntry.overrides.position = parseInt(t.value);
                if (isNaN(currentEntry.overrides.position)) delete currentEntry.overrides.position;
                break;
            case 'role':
                currentEntry.overrides.role = t.value === '' || t.value.toLowerCase() === 'null' ? null : (parseInt(t.value) ?? null);
                break;
            case 'selectivelogic':
                currentEntry.overrides.selectiveLogic = parseInt(t.value);
                if (isNaN(currentEntry.overrides.selectiveLogic)) delete currentEntry.overrides.selectiveLogic;
                break;
            case 'constant':
                currentEntry.overrides.constant = t.value.toLowerCase() === 'true';
                break;
            case 'vectorized':
                currentEntry.overrides.vectorized = t.value.toLowerCase() === 'true';
                break;
            case 'selective':
                currentEntry.overrides.selective = t.value.toLowerCase() === 'true';
                break;
            case 'disable':
            case 'disabled':
                currentEntry.overrides.disable = t.value.toLowerCase() === 'true';
                break;
            case 'excluderecursion':
                currentEntry.overrides.excludeRecursion = t.value.toLowerCase() === 'true';
                break;
            case 'preventrecursion':
                currentEntry.overrides.preventRecursion = t.value.toLowerCase() === 'true';
                break;
            case 'ignorebudget':
                currentEntry.overrides.ignoreBudget = t.value.toLowerCase() === 'true';
                break;
            case 'addmemo':
                currentEntry.overrides.addMemo = t.value.toLowerCase() === 'true';
                break;
            case 'group':
                currentEntry.overrides.group = t.value;
                break;
            case 'groupoverride':
                currentEntry.overrides.groupOverride = t.value.toLowerCase() === 'true';
                break;
            case 'groupweight':
                currentEntry.overrides.groupWeight = parseInt(t.value);
                if (isNaN(currentEntry.overrides.groupWeight)) delete currentEntry.overrides.groupWeight;
                break;
            case 'sticky':
                currentEntry.overrides.sticky = t.value === '' ? null : (parseInt(t.value) ?? null);
                break;
            case 'cooldown':
                currentEntry.overrides.cooldown = t.value === '' ? null : (parseInt(t.value) ?? null);
                break;
            case 'delay':
                currentEntry.overrides.delay = t.value === '' ? null : (parseInt(t.value) ?? null);
                break;
            case 'outletname':
                currentEntry.overrides.outletName = t.value;
                break;
            case 'triggers':
                currentEntry.overrides.triggers = t.value.split(',').map(s => s.trim()).filter(Boolean);
                break;
            case 'scandepth':
                currentEntry.overrides.scanDepth = t.value === '' ? null : (parseInt(t.value) ?? null);
                break;
            case 'casesensitive':
                currentEntry.overrides.caseSensitive = t.value.toLowerCase() === 'true' ? true : (t.value.toLowerCase() === 'false' ? false : null);
                break;
            case 'matchwholewords':
                currentEntry.overrides.matchWholeWords = t.value.toLowerCase() === 'true' ? true : (t.value.toLowerCase() === 'false' ? false : null);
                break;
            case 'usegroupscoring':
                currentEntry.overrides.useGroupScoring = t.value.toLowerCase() === 'true' ? true : (t.value.toLowerCase() === 'false' ? false : null);
                break;
            case 'automationid':
                currentEntry.overrides.automationId = t.value;
                break;
            case 'delay_until_recursion':
            case 'delayuntilrecursion': {
                const delayOn = t.value.toLowerCase() === 'true';
                const curDelay = currentEntry.overrides.delayUntilRecursion;
                currentEntry.overrides.delayUntilRecursion = !delayOn ? false
                    : (typeof curDelay === 'number' && curDelay > 1 ? curDelay : true);
                break;
            }
            case 'delayuntilrecursionlevel': {
                const recLevel = parseInt(t.value);
                if (!Number.isFinite(recLevel)) break;
                if (recLevel > 1) currentEntry.overrides.delayUntilRecursion = recLevel;
                else if (currentEntry.overrides.delayUntilRecursion !== false) currentEntry.overrides.delayUntilRecursion = true;
                break;
            }
            case 'useprobability':
                currentEntry.overrides.useProbability = t.value.toLowerCase() === 'true';
                break;
            case 'characterfilterexclude':
            case 'character_exclusion':
                currentEntry.overrides.characterFilter = { isExclude: t.value.toLowerCase() === 'true', names: [], tags: [] };
                break;
            case 'matchcharacterdescription':
                currentEntry.overrides.matchCharacterDescription = t.value.toLowerCase() === 'true';
                break;
            case 'matchcharacterpersonality':
                currentEntry.overrides.matchCharacterPersonality = t.value.toLowerCase() === 'true';
                break;
            case 'matchscenario':
                currentEntry.overrides.matchScenario = t.value.toLowerCase() === 'true';
                break;
            case 'matchpersonadescription':
                currentEntry.overrides.matchPersonaDescription = t.value.toLowerCase() === 'true';
                break;
            case 'matchcharacterdepthprompt':
                currentEntry.overrides.matchCharacterDepthPrompt = t.value.toLowerCase() === 'true';
                break;
            case 'matchcreatornotes':
                currentEntry.overrides.matchCreatorNotes = t.value.toLowerCase() === 'true';
                break;
        }
    }
    if (currentEntry) entries.push(currentEntry);

    return entries;
}

async function createItems() {
    const parentFolderId = document.getElementById('add-item-parent').value || null;
    const activeTab = document.querySelector('#add-item-modal .tab-btn.active').dataset.tab;

    if (activeTab === 'quick') {
        const itemType = document.querySelector('input[name="quick-item-type"]:checked').value;
        
        if (itemType === 'folder') {
            const folderNamesStr = document.getElementById('quick-folder-names').value.trim();
            const folderNamesList = folderNamesStr ? folderNamesStr.split('\n').map(s => s.trim()).filter(Boolean) : [];
            
            if (folderNamesList.length === 0) {
                alert('Please enter at least one folder name.');
                return;
            }
            
            const order = parseInt(document.getElementById('quick-folder-order').value) || 100;
            
            if (!extensionSettings.folders[currentLorebookName]) {
                extensionSettings.folders[currentLorebookName] = [];
            }

            const stagedNames = new Set();
            for (const rawName of folderNamesList) {
                const nameErr = EL_validateFolderName(rawName, parentFolderId, null, stagedNames);
                if (nameErr) {
                    try { EL_toast(nameErr, 'error'); } catch (e) {}
                    return;
                }
                stagedNames.add(String(rawName).trim().toLowerCase());
            }

            folderNamesList.forEach(name => {
                const newId = 'folder_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                extensionSettings.folders[currentLorebookName].push({
                    id: newId,
                    name: String(name).trim(),
                    parentId: parentFolderId,
                    order: order,
                    entries: [],
                });
            });
            
            saveSettings();
            closeAddItemModal();
            renderEntries();
            
        } else if (itemType === 'entry') {
            const commentsStr = document.getElementById('quick-entry-comments').value.trim();
            const commentsList = commentsStr ? commentsStr.split('\n').map(s => s.trim()).filter(Boolean) : [];
            
            let count = 1;
            if (commentsList.length > 0) {
                count = commentsList.length;
            } else {
                count = parseInt(document.getElementById('quick-entry-count').value) || 1;
            }

            const order = parseInt(document.getElementById('quick-entry-order').value) || 100;
            const keysStr = document.getElementById('quick-entry-keys').value || '';
            const keys = keysStr ? keysStr.split(',').map(s => s.trim()).filter(Boolean) : [];
            
            const constant = document.getElementById('quick-entry-constant').checked;
            const vectorized = document.getElementById('quick-entry-vectorized').checked;
            const selective = document.getElementById('quick-entry-selective').checked;
            const disable = document.getElementById('quick-entry-disable').checked;
            const excludeRecursion = document.getElementById('quick-entry-exclude').checked;
            const preventRecursion = document.getElementById('quick-entry-prevent').checked;
            const depth = parseInt(document.getElementById('quick-entry-depth').value) || 4;
            const probability = parseInt(document.getElementById('quick-entry-probability').value) ?? 100;

            const positionSelect = document.getElementById('quick-entry-position');
            const selectedOption = positionSelect.selectedOptions[0];
            const position = parseInt(selectedOption.value) || 0;
            const role = selectedOption.dataset.role !== '' ? parseInt(selectedOption.dataset.role) : null;

            const newUids = [];
            for (let i = 0; i < count; i++) {
                const newUid = getFreeWorldEntryUid(currentLorebookData);
                if (newUid === null) { console.error('Enhanced Lorebook: Couldn\'t assign UID'); break; }
                const entryComment = commentsList[i] || '';
                
                currentLorebookData.entries[newUid] = {
                    uid: newUid,
                    key: [...keys],
                    keysecondary: [],
                    comment: entryComment,
                    content: '',
                    constant: constant,
                    vectorized: vectorized,
                    selective: selective,
                    selectiveLogic: 0,
                    order: order,
                    position: position,
                    role: role,
                    disable: disable,
                    excludeRecursion: excludeRecursion,
                    preventRecursion: preventRecursion,
                    delay: 0,
                    depth: depth,
                    probability: probability,
                };
                newUids.push(String(newUid));
            }

            if (parentFolderId) {
                const folder = extensionSettings.folders[currentLorebookName].find(f => f.id === parentFolderId);
                if (folder) {
                    folder.entries.push(...newUids);
                    saveSettings();
                }
            }

            { const _qaOk = await ELG_guardSave(currentLorebookName, currentLorebookData, { explicitDelete: false, source: 'user', note: 'Quick add entry' }); EL_logGuardResult(_qaOk,'Quick add',currentLorebookName); if(!_qaOk) EL_error('Quick add blocked/failed'); }
            closeAddItemModal();
            renderEntries();
        }

    } else if (activeTab === 'advanced') {
        if (advancedRows.length === 0) {
            alert('Please add at least one entry row.');
            return;
        }

        const sView = document.querySelector('.settings-tab-btn.active').dataset.sview;
        const newUids = [];

        const applyOrder = document.getElementById('g-apply-order').checked;
        const orderVal = parseInt(document.getElementById('g-order').value) || 100;
        
        const applyPosition = document.getElementById('g-apply-position').checked;
        const positionSelect = document.getElementById('g-position');
        const selectedOption = positionSelect.selectedOptions[0];
        const posVal = parseInt(selectedOption.value) || 0;
        const roleVal = selectedOption.dataset.role !== '' ? parseInt(selectedOption.dataset.role) : null;

        const applyDepth = document.getElementById('g-apply-depth').checked;
        const depthVal = parseInt(document.getElementById('g-depth').value) || 4;

        const applyProb = document.getElementById('g-apply-probability').checked;
        const probVal = parseInt(document.getElementById('g-probability').value) ?? 100;

        const constantVal = document.getElementById('g-constant').checked;
        const vectorizedVal = document.getElementById('g-vectorized').checked;
        const selectiveVal = document.getElementById('g-selective').checked;
        const disableVal = document.getElementById('g-disable').checked;
        const excludeRecursionVal = document.getElementById('g-exclude').checked;
        const preventRecursionVal = document.getElementById('g-prevent').checked;

        for (let i = 0; i < advancedRows.length; i++) {
            const newUid = getFreeWorldEntryUid(currentLorebookData);

            if (newUid === null) { console.error('Enhanced Lorebook: Couldn\'t assign UID'); continue; }
            const row = advancedRows[i];

            const keys = row.key ? row.key.split(',').map(s => s.trim()).filter(Boolean) : [];
            const keysecondary = row.keysecondary ? row.keysecondary.split(',').map(s => s.trim()).filter(Boolean) : [];

            let entrySettings = {};
            if (sView === 'general') {
                entrySettings = {
                    order: applyOrder ? orderVal : 100,
                    position: applyPosition ? posVal : 0,
                    role: applyPosition ? roleVal : null,
                    depth: applyDepth ? depthVal : 4,
                    probability: applyProb ? probVal : 100,
                    constant: constantVal,
                    vectorized: vectorizedVal,
                    selective: selectiveVal,
                    disable: disableVal,
                    excludeRecursion: excludeRecursionVal,
                    preventRecursion: preventRecursionVal,
                };
            } else {
                entrySettings = {
                    order: row.settings.order ?? 100,
                    position: row.settings.position ?? 0,
                    role: row.settings.role ?? null,
                    depth: row.settings.depth ?? 4,
                    probability: row.settings.probability ?? 100,
                    constant: row.settings.constant,
                    vectorized: row.settings.vectorized,
                    selective: row.settings.selective,
                    disable: row.settings.disable,
                    excludeRecursion: row.settings.excludeRecursion,
                    preventRecursion: row.settings.preventRecursion,
                };
            }

            currentLorebookData.entries[newUid] = {
                uid: newUid,
                key: keys,
                keysecondary: keysecondary,
                comment: row.comment,
                content: row.content,
                selectiveLogic: 0,
                delay: 0,
                ...entrySettings
            };
            newUids.push(String(newUid));
        }

        if (parentFolderId) {
            const folder = extensionSettings.folders[currentLorebookName].find(f => f.id === parentFolderId);
            if (folder) {
                folder.entries.push(...newUids);
                saveSettings();
            }
        }

        { const _advOk = await ELG_guardSave(currentLorebookName, currentLorebookData, { explicitDelete: false, source: 'user', note: 'Advanced add entries' }); EL_logGuardResult(_advOk,'Advanced add',currentLorebookName); if(!_advOk) EL_error('Advanced add blocked/failed'); }
        closeAddItemModal();
        renderEntries();
    } else if (activeTab === 'xml') {
        const xmlText = document.getElementById('xml-input').value.trim();
        if (!xmlText) {
            alert('Please enter XML-formatted entries.');
            return;
        }

        const parsedEntries = parseXmlEntries(xmlText);
        if (parsedEntries.length === 0) {
            alert('No valid entries found. Make sure to use &lt;Title&gt; tags to define entries.');
            return;
        }

        const applyOrder = document.getElementById('xml-apply-order').checked;
        const orderVal = parseInt(document.getElementById('xml-order').value) || 100;

        const applyPosition = document.getElementById('xml-apply-position').checked;
        const positionSelect = document.getElementById('xml-position');
        const posOption = positionSelect.selectedOptions[0];
        const posVal = parseInt(posOption.value) || 0;
        const roleVal = posOption.dataset.role !== '' ? parseInt(posOption.dataset.role) : null;

        const applyDepth = document.getElementById('xml-apply-depth').checked;
        const depthVal = parseInt(document.getElementById('xml-depth').value) || 4;

        const applyProb = document.getElementById('xml-apply-probability').checked;
        const probVal = parseInt(document.getElementById('xml-probability').value) ?? 100;

        const constantVal = document.getElementById('xml-constant').checked;
        const vectorizedVal = document.getElementById('xml-vectorized').checked;
        const selectiveVal = document.getElementById('xml-selective').checked;
        const disableVal = document.getElementById('xml-disable').checked;
        const excludeRecursionVal = document.getElementById('xml-exclude').checked;
        const preventRecursionVal = document.getElementById('xml-prevent').checked;

        const defaults = {
            order: applyOrder ? orderVal : 100,
            position: applyPosition ? posVal : 0,
            role: applyPosition ? roleVal : null,
            depth: applyDepth ? depthVal : 4,
            probability: applyProb ? probVal : 100,
            constant: constantVal,
            vectorized: vectorizedVal,
            selective: selectiveVal,
            disable: disableVal,
            excludeRecursion: excludeRecursionVal,
            preventRecursion: preventRecursionVal,
        };

        const newUids = [];


        for (const parsed of parsedEntries) {
            const newUid = getFreeWorldEntryUid(currentLorebookData);

            if (newUid === null) { console.error('Enhanced Lorebook: Couldn\'t assign UID'); continue; }
            const ov = parsed.overrides;

            currentLorebookData.entries[newUid] = {
                uid: newUid,
                key: parsed.keys,
                keysecondary: parsed.keysecondary,
                comment: parsed.comment,
                content: parsed.content,
                constant: ov.constant ?? defaults.constant,
                vectorized: ov.vectorized ?? defaults.vectorized,
                selective: ov.selective ?? defaults.selective,
                selectiveLogic: ov.selectiveLogic ?? 0,
                order: ov.order ?? defaults.order,
                position: ov.position ?? defaults.position,
                role: ov.role !== undefined ? ov.role : defaults.role,
                disable: ov.disable ?? defaults.disable,
                excludeRecursion: ov.excludeRecursion ?? defaults.excludeRecursion,
                preventRecursion: ov.preventRecursion ?? defaults.preventRecursion,
                delay: ov.delay ?? 0,
                depth: ov.depth ?? defaults.depth,
                probability: ov.probability ?? defaults.probability,
                sticky: ov.sticky ?? null,
                cooldown: ov.cooldown ?? null,
                group: ov.group ?? '',
                groupOverride: ov.groupOverride ?? false,
                groupWeight: ov.groupWeight ?? 100,
                outletName: ov.outletName ?? '',
                triggers: ov.triggers ?? [],
                scanDepth: ov.scanDepth ?? null,
                caseSensitive: ov.caseSensitive ?? null,
                matchWholeWords: ov.matchWholeWords ?? null,
                useGroupScoring: ov.useGroupScoring ?? null,
                automationId: ov.automationId ?? '',
                delayUntilRecursion: ov.delayUntilRecursion ?? false,
                ignoreBudget: ov.ignoreBudget ?? false,
                addMemo: ov.addMemo ?? false,
                useProbability: ov.useProbability ?? true,
                characterFilter: ov.characterFilter ?? { isExclude: false, names: [], tags: [] },
                matchCharacterDescription: ov.matchCharacterDescription ?? false,
                matchCharacterPersonality: ov.matchCharacterPersonality ?? false,
                matchScenario: ov.matchScenario ?? false,
                matchPersonaDescription: ov.matchPersonaDescription ?? false,
                matchCharacterDepthPrompt: ov.matchCharacterDepthPrompt ?? false,
                matchCreatorNotes: ov.matchCreatorNotes ?? false,
            };
            newUids.push(String(newUid));
        }

        if (parentFolderId) {
            const folder = extensionSettings.folders[currentLorebookName].find(f => f.id === parentFolderId);
            if (folder) {
                folder.entries.push(...newUids);
                saveSettings();
            }
        }

        { const _xmlOk = await ELG_guardSave(currentLorebookName, currentLorebookData, { explicitDelete: false, source: 'user', note: 'XML add entries' }); EL_logGuardResult(_xmlOk,'XML add',currentLorebookName); if(!_xmlOk) EL_error('XML add blocked/failed'); }
        closeAddItemModal();
        renderEntries();
    }
}

function openAddEntryModal() {
    openAddItemModal(null);
}

function createNewEntries() {
    createItems();
}

function openBatchModal() {
    document.getElementById('batch-selected-count').textContent = selectedEntries.size;
    EL_batchPendingPlan = null;
    
    // Populate searchable batch folder picker
    const hiddenInput = document.getElementById('batch-folder-val');
    hiddenInput.value = '';
    const searchInput = document.getElementById('batch-folder-search');
    searchInput.value = '';
    const listContainer = document.getElementById('batch-folder-list');
    const folders = extensionSettings.folders[currentLorebookName] || [];

    function renderBatchFolderList(query = '') {
        listContainer.innerHTML = '';
        const term = query.toLowerCase();

        // Root option
        if ('root (no folder)'.includes(term) || 'uncategorized'.includes(term)) {
            const rootItem = document.createElement('div');
            rootItem.className = 'folder-picker-item' + (hiddenInput.value === '' ? ' selected' : '');
            rootItem.innerHTML = '<i class="fa-solid fa-house"></i> Root (No Folder)';
            rootItem.addEventListener('click', () => {
                hiddenInput.value = '';
                renderBatchFolderList(searchInput.value);
            });
            listContainer.appendChild(rootItem);
        }

        const filtered = folders.filter(f => {
            const pathName = getFolderPathName(f.id);
            return pathName.toLowerCase().includes(term);
        });

        filtered.forEach(f => {
            const item = document.createElement('div');
            item.className = 'folder-picker-item' + (hiddenInput.value === f.id ? ' selected' : '');
            const pathName = getFolderPathName(f.id);
            item.innerHTML = `<i class="fa-solid fa-folder"></i> ${escapeHtml(pathName)}`;
            item.addEventListener('click', () => {
                hiddenInput.value = f.id;
                renderBatchFolderList(searchInput.value);
            });
            listContainer.appendChild(item);
        });

        if (listContainer.children.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'folder-picker-empty';
            empty.textContent = 'No matching folders';
            listContainer.appendChild(empty);
        }
    }

    renderBatchFolderList();

    searchInput.addEventListener('input', () => renderBatchFolderList(searchInput.value));
    searchInput.addEventListener('keydown', (e) => e.stopPropagation());

    EL_modalOpen(els.batchModal);
}

/**
 * Batch edit: three-state fields, preview diff, and single-level undo.
 *
 * Every field in the batch modal is a genuine three-state control:
 *   - "leave"  — leave the field unchanged on every selected entry.
 *   - "set"    — write the value from the field's value input.
 *   - "reset"  — write SillyTavern's default from EL_ENTRY_DEFAULTS
 *                (deep-copied, since some defaults are objects/arrays).
 * Only fields actually set (set/reset) are collected into a plan. The plan
 * is shown as a preview diff first; nothing is written until the user
 * confirms. After a successful apply the previous values are kept for one
 * undo, restored through the same ELG_guardSave path.
 */

let EL_batchUndoState = null;
let EL_batchPendingPlan = null;

/** Sentinel for "this entry had no such field", so undo can delete it back. */
const EL_BATCH_MISSING = { elBatchMissing: true };

/**
 * Read the three-state mode for one batch field.
 * @param {string} short Short key, e.g. "order" for #batch-mode-order.
 * @returns {"leave"|"set"|"reset"}
 */
function EL_batchModeOf(short) {
    try {
        const sel = document.getElementById('batch-mode-' + short);
        if (sel && typeof sel.value === 'string') {
            if (sel.value === 'set' || sel.value === 'reset') return sel.value;
            return 'leave';
        }
    } catch (e) {}
    try {
        const legacy = document.getElementById('batch-apply-' + short);
        if (legacy) return legacy.checked ? 'set' : 'leave';
    } catch (e) {}
    return 'leave';
}

/**
 * Canonical entry defaults table (mirrored from hub-client.js).
 * characterFilter is not in EL_ENTRY_DEFAULTS, so it gets its own default.
 * @returns {object}
 */
function EL_batchDefaults() {
    try {
        if (typeof window !== 'undefined' && window.EL_ENTRY_DEFAULTS) return window.EL_ENTRY_DEFAULTS;
    } catch (e) {}
    try {
        if (typeof EL_ENTRY_DEFAULTS !== 'undefined' && EL_ENTRY_DEFAULTS) return EL_ENTRY_DEFAULTS;
    } catch (e) {}
    return {
        order: 100, position: 0, depth: 4, probability: 100, useProbability: true,
        constant: false, vectorized: false, selective: true, selectiveLogic: 0,
        disable: false, addMemo: false, excludeRecursion: false, preventRecursion: false,
        outletName: '', group: '', groupOverride: false, groupWeight: 100, sticky: null,
        cooldown: null, delay: null, matchPersonaDescription: false,
        matchCharacterDescription: false, matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
        delayUntilRecursion: 0, scanDepth: null, caseSensitive: null, matchWholeWords: null,
        useGroupScoring: null, automationId: '', role: 0, ignoreBudget: false, triggers: [],
    };
}

/**
 * Fresh default characterFilter object (never a shared reference).
 * @returns {{isExclude: boolean, names: Array, tags: Array}}
 */
function EL_batchDefaultCharFilter() {
    return { isExclude: false, names: [], tags: [] };
}

/**
 * Deep copy for snapshot/default values.
 * @param {*} value
 * @returns {*}
 */
function EL_cloneBatchValue(value) {
    if (value === null || value === undefined) return value;
    try {
        if (typeof structuredClone === 'function') return structuredClone(value);
    } catch (e) {}
    try { return JSON.parse(JSON.stringify(value)); } catch (e) {}
    if (Array.isArray(value)) return value.slice();
    if (typeof value === 'object') {
        const out = {};
        try { for (const k of Object.keys(value)) out[k] = value[k]; } catch (e) {}
        return out;
    }
    return value;
}

/**
 * Read an integer value input (NaN when missing/unparseable).
 * @param {string} id Element id.
 * @returns {number}
 */
function EL_batchIntVal(id) {
    try {
        const el = document.getElementById(id);
        if (!el) return NaN;
        return parseInt(el.value);
    } catch (e) { return NaN; }
}

/**
 * Read a boolean (checkbox) value input.
 * @param {string} id Element id.
 * @returns {boolean}
 */
function EL_batchBoolVal(id) {
    try {
        const el = document.getElementById(id);
        return !!(el && el.checked);
    } catch (e) { return false; }
}

/**
 * Read a text value input.
 * @param {string} id Element id.
 * @returns {string}
 */
function EL_batchTextVal(id) {
    try {
        const el = document.getElementById(id);
        return el ? String(el.value ?? '') : '';
    } catch (e) { return ''; }
}

/**
 * Read a tri-state (true/false/null) select value input.
 * @param {string} id Element id.
 * @returns {boolean|null}
 */
function EL_batchNullBoolVal(id) {
    try {
        const el = document.getElementById(id);
        if (!el) return null;
        if (el.value === 'true') return true;
        if (el.value === 'false') return false;
        return null;
    } catch (e) { return null; }
}

/**
 * Compare two field values by content.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function EL_batchValuesEqual(a, b) {
    try {
        if (a === b) return true;
        return JSON.stringify(a) === JSON.stringify(b);
    } catch (e) { return false; }
}

/**
 * Short human label for an entry in the preview/undo UI.
 * @param {string} uid
 * @param {object} entry
 * @returns {string}
 */
function EL_batchEntryLabel(uid, entry) {
    try {
        const c = entry && entry.comment ? String(entry.comment).trim() : '';
        if (c) return c;
        const k = entry && entry.key ? safeJoin(entry.key, ', ') : '';
        if (k) return k;
    } catch (e) {}
    return 'Entry ' + uid;
}

/**
 * Short human rendering of one new/old field value.
 * @param {string} field Entry field name.
 * @param {*} value
 * @returns {string}
 */
function EL_batchDisplayValue(field, value) {
    try {
        if (value === null || value === undefined || value === '') return '(empty)';
        if (typeof value === 'boolean') return value ? 'Yes' : 'No';
        if (field === 'characterFilter' && typeof value === 'object') {
            const names = Array.isArray(value.names) ? value.names : [];
            const base = names.length ? names.join(', ') : '(no names)';
            return value.isExclude ? base + ' [excluded]' : base;
        }
        if (field === 'delayUntilRecursion') {
            if (value === false || value === 0) return 'Off';
            if (value === true) return 'On (default level)';
            return 'Level ' + value;
        }
        if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    } catch (e) {
        try { return String(value); } catch (_e) { return '?'; }
    }
}

/**
 * Human label for an insertion-strategy position/role pair, using the
 * batch modal's own strategy select when available.
 * @param {number} position
 * @param {number|null} role
 * @returns {string}
 */
function EL_batchStrategyLabel(position, role) {
    try {
        const sel = document.getElementById('batch-strategy-val');
        if (sel && sel.options) {
            for (const opt of sel.options) {
                if (parseInt(opt.value) !== position) continue;
                const r = opt.dataset && opt.dataset.role !== '' ? parseInt(opt.dataset.role) : null;
                if (r === null || r === role) return String(opt.textContent || '').trim();
            }
        }
    } catch (e) {}
    return 'position ' + position + ((role !== null && role !== undefined) ? ', role ' + role : '');
}

/**
 * Folder display name for the preview ("Root (no folder)" for top level).
 * @param {string} folderId
 * @returns {string}
 */
function EL_batchFolderName(folderId) {
    try {
        if (!folderId) return 'Root (no folder)';
        if (typeof getFolderPathName === 'function') return getFolderPathName(folderId);
    } catch (e) {}
    return folderId || 'Root (no folder)';
}

/**
 * Folder id currently holding an entry ("" when at root).
 * @param {string} uid
 * @returns {string}
 */
function EL_batchEntryFolder(uid) {
    try {
        const folders = (extensionSettings.folders && extensionSettings.folders[currentLorebookName]) || [];
        const f = folders.find(x => (x.entries || []).map(String).includes(String(uid)));
        return f ? f.id : '';
    } catch (e) { return ''; }
}

/**
 * Collect the batch plan: one op per field the user actually set
 * (set/reset; "leave" fields are omitted entirely), plus the folder move.
 * Each op carries a compute(entry) returning the writes for that entry.
 * @returns {{ops: Array, folderOp: object|null, uids: Array, uidSet: Set}|null}
 */
function EL_batchCollectPlan() {
    if (!currentLorebookData || !currentLorebookData.entries) return null;
    const D = EL_batchDefaults() || {};
    const def = (k, fb) => (D[k] !== undefined ? EL_cloneBatchValue(D[k]) : fb);
    const uids = Array.from(selectedEntries || []).filter(uid => currentLorebookData.entries[uid]);
    if (!uids.length) return null;
    const ops = [];
    const modeOf = (short) => EL_batchModeOf(short);

    const intFields = [
        { short: 'order', label: 'Order', valId: 'batch-order-val', field: 'order', dk: 'order', fb: 100 },
        { short: 'depth', label: 'Insertion Depth', valId: 'batch-depth-val', field: 'depth', dk: 'depth', fb: 4 },
        { short: 'probability', label: 'Probability (%)', valId: 'batch-prob-val', field: 'probability', dk: 'probability', fb: 100 },
        { short: 'group-weight', label: 'Group Weight', valId: 'batch-group-weight-val', field: 'groupWeight', dk: 'groupWeight', fb: 100 },
        { short: 'sticky', label: 'Sticky (Turns)', valId: 'batch-sticky-val', field: 'sticky', dk: 'sticky', fb: null },
        { short: 'cooldown', label: 'Cooldown (Turns)', valId: 'batch-cooldown-val', field: 'cooldown', dk: 'cooldown', fb: null },
        { short: 'delay', label: 'Delay (Turns)', valId: 'batch-delay-val', field: 'delay', dk: 'delay', fb: null },
        { short: 'logic', label: 'Selective Logic', valId: 'batch-logic-val', field: 'selectiveLogic', dk: 'selectiveLogic', fb: 0, isSelect: true },
    ];
    for (const f of intFields) {
        const m = modeOf(f.short);
        if (m === 'leave') continue;
        if (m === 'set') {
            let v = NaN;
            try {
                const el = document.getElementById(f.valId);
                v = el ? parseInt(el.value) : NaN;
            } catch (e) { v = NaN; }
            if (isNaN(v)) continue;
            ops.push({ short: f.short, label: f.label, valId: f.valId, mode: m, compute: () => ({ [f.field]: v }) });
        } else {
            ops.push({ short: f.short, label: f.label, valId: f.valId, mode: m, compute: () => ({ [f.field]: def(f.dk, f.fb) }) });
        }
    }

    const mStrategy = modeOf('strategy');
    if (mStrategy === 'set') {
        let opt = null;
        try {
            const sel = document.getElementById('batch-strategy-val');
            opt = sel ? sel.selectedOptions[0] : null;
        } catch (e) { opt = null; }
        if (opt) {
            const p = parseInt(opt.value);
            const r = (opt.dataset && opt.dataset.role !== '') ? parseInt(opt.dataset.role) : null;
            ops.push({
                short: 'strategy', label: 'Insertion Strategy', valId: 'batch-strategy-val', mode: mStrategy,
                compute: () => {
                    const w = { position: p };
                    if (r !== null && !isNaN(r)) w.role = r;
                    return w;
                },
            });
        }
    } else if (mStrategy === 'reset') {
        ops.push({
            short: 'strategy', label: 'Insertion Strategy', valId: 'batch-strategy-val', mode: mStrategy,
            compute: () => ({ position: def('position', 0), role: def('role', 0) }),
        });
    }

    const boolFields = [
        { short: 'use-probability', label: 'Use Probability', valId: 'batch-use-probability-val', field: 'useProbability', dk: 'useProbability', fb: true },
        { short: 'constant', label: 'Constant', valId: 'batch-constant-val', field: 'constant', dk: 'constant', fb: false },
        { short: 'vectorized', label: 'Vectorized', valId: 'batch-vectorized-val', field: 'vectorized', dk: 'vectorized', fb: false },
        { short: 'selective', label: 'Selective', valId: 'batch-selective-val', field: 'selective', dk: 'selective', fb: true },
        { short: 'disable', label: 'Disabled', valId: 'batch-disable-val', field: 'disable', dk: 'disable', fb: false },
        { short: 'add-memo', label: 'Add Memo', valId: 'batch-add-memo-val', field: 'addMemo', dk: 'addMemo', fb: false },
        { short: 'exclude-recursion', label: 'Exclude Recursion', valId: 'batch-exclude-recursion-val', field: 'excludeRecursion', dk: 'excludeRecursion', fb: false },
        { short: 'prevent-recursion', label: 'Prevent Recursion', valId: 'batch-prevent-recursion-val', field: 'preventRecursion', dk: 'preventRecursion', fb: false },
        { short: 'group-override', label: 'Group Override', valId: 'batch-group-override-val', field: 'groupOverride', dk: 'groupOverride', fb: false },
        { short: 'match-char-desc', label: 'Match Char Desc', valId: 'batch-match-char-desc-val', field: 'matchCharacterDescription', dk: 'matchCharacterDescription', fb: false },
        { short: 'match-char-pers', label: 'Match Char Pers', valId: 'batch-match-char-pers-val', field: 'matchCharacterPersonality', dk: 'matchCharacterPersonality', fb: false },
        { short: 'match-scenario', label: 'Match Scenario', valId: 'batch-match-scenario-val', field: 'matchScenario', dk: 'matchScenario', fb: false },
        { short: 'match-persona', label: 'Match Persona', valId: 'batch-match-persona-val', field: 'matchPersonaDescription', dk: 'matchPersonaDescription', fb: false },
        { short: 'match-char-depth', label: 'Match Char Note', valId: 'batch-match-char-depth-val', field: 'matchCharacterDepthPrompt', dk: 'matchCharacterDepthPrompt', fb: false },
        { short: 'match-creator-notes', label: 'Match Creator Notes', valId: 'batch-match-creator-notes-val', field: 'matchCreatorNotes', dk: 'matchCreatorNotes', fb: false },
        { short: 'ignore-budget', label: 'Ignore Budget', valId: 'batch-ignore-budget-val', field: 'ignoreBudget', dk: 'ignoreBudget', fb: false },
    ];
    for (const f of boolFields) {
        const m = modeOf(f.short);
        if (m === 'leave') continue;
        if (m === 'set') {
            const v = EL_batchBoolVal(f.valId);
            if (f.short === 'constant' && v) {
                ops.push({ short: f.short, label: f.label, valId: f.valId, mode: m, compute: () => ({ constant: true, vectorized: false }) });
            } else if (f.short === 'vectorized' && v) {
                ops.push({ short: f.short, label: f.label, valId: f.valId, mode: m, compute: () => ({ vectorized: true, constant: false }) });
            } else {
                ops.push({ short: f.short, label: f.label, valId: f.valId, mode: m, compute: () => ({ [f.field]: v }) });
            }
        } else {
            if (f.short === 'constant') {
                ops.push({ short: f.short, label: f.label, valId: f.valId, mode: m, compute: () => ({ constant: def('constant', false) }) });
            } else if (f.short === 'vectorized') {
                ops.push({ short: f.short, label: f.label, valId: f.valId, mode: m, compute: () => ({ vectorized: def('vectorized', false) }) });
            } else {
                ops.push({ short: f.short, label: f.label, valId: f.valId, mode: m, compute: () => ({ [f.field]: def(f.dk, f.fb) }) });
            }
        }
    }

    const textFields = [
        { short: 'outlet-name', label: 'Outlet Name', valId: 'batch-outlet-name-val', field: 'outletName', dk: 'outletName', fb: '' },
        { short: 'group', label: 'Inclusion Group', valId: 'batch-group-val', field: 'group', dk: 'group', fb: '' },
        { short: 'automation-id', label: 'Automation ID', valId: 'batch-automation-id-val', field: 'automationId', dk: 'automationId', fb: '' },
    ];
    for (const f of textFields) {
        const m = modeOf(f.short);
        if (m === 'leave') continue;
        if (m === 'set') {
            const v = EL_batchTextVal(f.valId);
            ops.push({ short: f.short, label: f.label, valId: f.valId, mode: m, compute: () => ({ [f.field]: v }) });
        } else {
            ops.push({ short: f.short, label: f.label, valId: f.valId, mode: m, compute: () => ({ [f.field]: def(f.dk, f.fb) }) });
        }
    }

    const mCharFilter = modeOf('char-filter');
    const mCharExcl = modeOf('char-exclusion');
    if (mCharFilter === 'set') {
        const text = EL_batchTextVal('batch-char-filter-val');
        ops.push({
            short: 'char-filter', label: 'Character Filter', valId: 'batch-char-filter-val', mode: mCharFilter,
            compute: (entry) => {
                let isEx = false;
                try { isEx = !!(entry.characterFilter && entry.characterFilter.isExclude === true); } catch (e) {}
                if (mCharExcl === 'set') isEx = EL_batchBoolVal('batch-char-exclusion-val');
                else if (mCharExcl === 'reset') isEx = false;
                return { characterFilter: EL_buildCharacterFilter(text, isEx, entry.characterFilter) };
            },
        });
    } else if (mCharFilter === 'reset') {
        ops.push({
            short: 'char-filter', label: 'Character Filter', valId: 'batch-char-filter-val', mode: mCharFilter,
            compute: () => {
                const cf = EL_batchDefaultCharFilter();
                if (mCharExcl === 'set') cf.isExclude = EL_batchBoolVal('batch-char-exclusion-val');
                return { characterFilter: cf };
            },
        });
    }
    if (mCharExcl !== 'leave' && mCharFilter === 'leave') {
        if (mCharExcl === 'set') {
            ops.push({
                short: 'char-exclusion', label: 'Exclude Listed Characters', valId: 'batch-char-exclusion-val', mode: mCharExcl,
                compute: (entry) => ({ characterFilter: EL_buildCharacterFilter(EL_characterFilterToText(entry.characterFilter), EL_batchBoolVal('batch-char-exclusion-val'), entry.characterFilter) }),
            });
        } else {
            ops.push({
                short: 'char-exclusion', label: 'Exclude Listed Characters', valId: 'batch-char-exclusion-val', mode: mCharExcl,
                compute: (entry) => ({ characterFilter: EL_buildCharacterFilter(EL_characterFilterToText(entry.characterFilter), false, entry.characterFilter) }),
            });
        }
    }

    const mTriggers = modeOf('triggers');
    if (mTriggers === 'set') {
        const raw = EL_batchTextVal('batch-triggers-val');
        const list = [...new Set((raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : []).filter(t => EL_GENERATION_TYPE_TRIGGERS.includes(t)))];
        ops.push({ short: 'triggers', label: 'Gen Triggers', valId: 'batch-triggers-val', mode: mTriggers, compute: () => ({ triggers: EL_cloneBatchValue(list) }) });
    } else if (mTriggers === 'reset') {
        ops.push({ short: 'triggers', label: 'Gen Triggers', valId: 'batch-triggers-val', mode: mTriggers, compute: () => ({ triggers: def('triggers', []) }) });
    }

    const mScanDepth = modeOf('scan-depth');
    if (mScanDepth === 'set') {
        const raw = EL_batchTextVal('batch-scan-depth-val').trim();
        const v = raw === '' ? null : parseInt(raw);
        ops.push({ short: 'scan-depth', label: 'Scan Depth Override', valId: 'batch-scan-depth-val', mode: mScanDepth, compute: () => ({ scanDepth: v }) });
    } else if (mScanDepth === 'reset') {
        ops.push({ short: 'scan-depth', label: 'Scan Depth Override', valId: 'batch-scan-depth-val', mode: mScanDepth, compute: () => ({ scanDepth: def('scanDepth', null) }) });
    }

    const mRecLevel = modeOf('recursion-level');
    const mDelayRec = modeOf('delay-recursion');
    if (mRecLevel !== 'leave' || mDelayRec !== 'leave') {
        ops.push({
            short: 'recursion', label: 'Delay Until Recursion', valId: 'batch-recursion-level-val', mode: (mRecLevel !== 'leave' ? mRecLevel : mDelayRec),
            compute: (entry) => {
                let delayOn;
                if (mDelayRec === 'set') delayOn = EL_batchBoolVal('batch-delay-recursion-val');
                else if (mDelayRec === 'reset') delayOn = false;
                else { try { delayOn = !!entry.delayUntilRecursion; } catch (e) { delayOn = false; } }
                let recLvl;
                if (mRecLevel === 'set') recLvl = EL_batchIntVal('batch-recursion-level-val');
                else if (mRecLevel === 'reset') recLvl = def('delayUntilRecursion', 0);
                else recLvl = (typeof entry.delayUntilRecursion === 'number') ? entry.delayUntilRecursion : NaN;
                const v = !delayOn ? false : ((!Number.isFinite(recLvl) || recLvl <= 1) ? true : recLvl);
                return { delayUntilRecursion: v };
            },
        });
    }

    const nullBoolFields = [
        { short: 'case-sensitive', label: 'Case-Sensitive', valId: 'batch-case-sensitive-val', field: 'caseSensitive', dk: 'caseSensitive' },
        { short: 'whole-words', label: 'Whole Words', valId: 'batch-whole-words-val', field: 'matchWholeWords', dk: 'matchWholeWords' },
        { short: 'group-scoring', label: 'Group Scoring', valId: 'batch-group-scoring-val', field: 'useGroupScoring', dk: 'useGroupScoring' },
    ];
    for (const f of nullBoolFields) {
        const m = modeOf(f.short);
        if (m === 'leave') continue;
        if (m === 'set') {
            const v = EL_batchNullBoolVal(f.valId);
            ops.push({ short: f.short, label: f.label, valId: f.valId, mode: m, compute: () => ({ [f.field]: v }) });
        } else {
            ops.push({ short: f.short, label: f.label, valId: f.valId, mode: m, compute: () => ({ [f.field]: def(f.dk, null) }) });
        }
    }

    const mFolder = modeOf('folder');
    let folderOp = null;
    if (mFolder === 'set') folderOp = { mode: mFolder, folderId: EL_batchTextVal('batch-folder-val') };
    else if (mFolder === 'reset') folderOp = { mode: mFolder, folderId: '' };

    if (!ops.length && !folderOp) return null;
    return { ops, folderOp, uids, uidSet: new Set(uids.map(String)) };
}

/**
 * Describe the target of one op for the preview summary.
 * @param {object} op
 * @param {object|null} folderOp
 * @returns {string}
 */
function EL_batchTargetDesc(op) {
    try {
        if (op.mode === 'reset') return 'Reset to default';
        const el = document.getElementById(op.valId || '');
        if (!el) return '';
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'select' && el.id === 'batch-strategy-val') {
            const o = el.selectedOptions ? el.selectedOptions[0] : null;
            return o ? String(o.textContent || '').trim() : '';
        }
        if (tag === 'select') {
            const o = el.selectedOptions ? el.selectedOptions[0] : null;
            return o ? String(o.textContent || '').trim() : String(el.value);
        }
        if (el.type === 'checkbox') return el.checked ? 'Yes' : 'No';
        return String(el.value);
    } catch (e) { return ''; }
}

/**
 * Build the per-entry diff for a plan without mutating anything.
 * @param {{ops: Array, folderOp: object|null, uids: Array, uidSet: Set}} plan
 * @returns {{rows: Array, unaffected: number, fieldStats: Array}}
 */
function EL_batchBuildDiff(plan) {
    const rows = [];
    let unaffected = 0;
    const statMap = {};
    for (const uid of plan.uids) {
        const entry = currentLorebookData.entries[uid];
        if (!entry) { unaffected++; continue; }
        const changes = [];
        for (const op of plan.ops) {
            let writes = null;
            try { writes = op.compute(entry) || null; } catch (e) { writes = null; }
            if (!writes) continue;
            if (op.short === 'strategy') {
                const np = writes.position;
                const hasRole = Object.prototype.hasOwnProperty.call(writes, 'role');
                const nr = hasRole ? writes.role : entry.role;
                if (!EL_batchValuesEqual(entry.position, np) || (hasRole && !EL_batchValuesEqual(entry.role, nr))) {
                    changes.push({ field: 'position', label: op.label, from: EL_batchStrategyLabel(entry.position, entry.role), to: EL_batchStrategyLabel(np, nr) });
                    statMap[op.label] = statMap[op.label] || { label: op.label, target: EL_batchTargetDesc(op), affected: 0 };
                    statMap[op.label].affected++;
                }
                continue;
            }
            for (const f of Object.keys(writes)) {
                if (EL_batchValuesEqual(entry[f], writes[f])) continue;
                changes.push({ field: f, label: op.label, from: EL_batchDisplayValue(f, entry[f]), to: EL_batchDisplayValue(f, writes[f]) });
                statMap[op.label] = statMap[op.label] || { label: op.label, target: EL_batchTargetDesc(op), affected: 0 };
                statMap[op.label].affected++;
            }
        }
        if (plan.folderOp) {
            const fromFolder = EL_batchEntryFolder(uid);
            const toFolder = plan.folderOp.folderId || '';
            if (fromFolder !== toFolder) {
                changes.push({ field: '__folder', label: 'Folder', from: EL_batchFolderName(fromFolder), to: EL_batchFolderName(toFolder) });
                statMap.Folder = statMap.Folder || { label: 'Folder', target: EL_batchFolderName(toFolder), affected: 0 };
                statMap.Folder.affected++;
            }
        }
        if (!changes.length) unaffected++;
        else rows.push({ uid: String(uid), label: EL_batchEntryLabel(uid, entry), changes });
    }
    return { rows, unaffected, fieldStats: Object.values(statMap) };
}

/**
 * Render the preview diff into the preview modal and store nothing yet.
 * @param {{ops: Array, folderOp: object|null, uids: Array, uidSet: Set}} plan
 */
function EL_batchRenderPreview(plan) {
    const diff = EL_batchBuildDiff(plan);
    plan.diff = diff;
    const body = document.getElementById('batch-preview-body');
    const confirmBtn = document.getElementById('btn-batch-preview-confirm');
    const changed = diff.rows.length;
    const total = plan.uids.length;
    if (confirmBtn) {
        try { confirmBtn.textContent = changed ? ('Apply Changes (' + changed + ' entr' + (changed === 1 ? 'y' : 'ies') + ')') : 'Apply Changes'; } catch (e) {}
        try { confirmBtn.disabled = !changed; } catch (e) {}
    }
    if (!body) return;
    let html = '';
    html += '<p class="el-batch-preview-summary">Selected <strong>' + total + '</strong> entr' + (total === 1 ? 'y' : 'ies')
        + ' &middot; <strong>' + changed + '</strong> will change'
        + ' &middot; <strong>' + diff.unaffected + '</strong> already match (unaffected).</p>';
    if (diff.fieldStats.length) {
        html += '<table class="el-batch-field-table"><thead><tr><th>Field</th><th>Change to</th><th>Entries</th></tr></thead><tbody>';
        for (const st of diff.fieldStats) {
            html += '<tr><td>' + escapeHtml(st.label) + '</td><td>' + escapeHtml(st.target || '') + '</td><td>' + st.affected + '</td></tr>';
        }
        html += '</tbody></table>';
    } else {
        html += '<p class="el-batch-preview-empty">Nothing would change — every selected entry already matches.</p>';
    }
    const MAX_ROWS = 60;
    if (diff.rows.length) {
        html += '<div class="el-batch-entry-details">';
        for (const row of diff.rows.slice(0, MAX_ROWS)) {
            html += '<details class="el-batch-entry-row"><summary>' + escapeHtml(row.label) + ' <span class="el-batch-entry-count">' + row.changes.length + ' change' + (row.changes.length === 1 ? '' : 's') + '</span></summary><ul>';
            for (const c of row.changes) {
                html += '<li><span class="el-batch-change-field">' + escapeHtml(c.label) + ':</span> '
                    + '<span class="el-batch-change-from">' + escapeHtml(c.from) + '</span>'
                    + ' <span class="el-batch-change-arrow">&rarr;</span> '
                    + '<span class="el-batch-change-to">' + escapeHtml(c.to) + '</span></li>';
            }
            html += '</ul></details>';
        }
        if (diff.rows.length > MAX_ROWS) {
            html += '<p class="el-batch-preview-note">Showing ' + MAX_ROWS + ' of ' + diff.rows.length + ' changed entries.</p>';
        }
        html += '</div>';
    }
    if (diff.unaffected) {
        html += '<p class="el-batch-preview-note">' + diff.unaffected + ' selected entr' + (diff.unaffected === 1 ? 'y' : 'ies') + ' would not change and ' + (diff.unaffected === 1 ? 'is' : 'are') + ' omitted above.</p>';
    }
    body.innerHTML = html;
}

/**
 * Entry point for the batch modal's Apply button: collect the plan and
 * show the confirmation preview. Nothing is written until confirmed.
 */
async function applyBatchOptions() {
    try {
        if (!selectedEntries || !selectedEntries.size) {
            if (typeof showToast === 'function') showToast('No entries selected.');
            return;
        }
        const plan = EL_batchCollectPlan();
        if (!plan) {
            if (typeof showToast === 'function') showToast('Nothing to apply — every field is set to "Leave unchanged".');
            return;
        }
        EL_batchPendingPlan = plan;
        EL_batchRenderPreview(plan);
        EL_modalOpen(document.getElementById('batch-preview-modal'));
    } catch (e) {
        EL_error('batch preview failed', e);
        if (typeof showToast === 'function') showToast('Could not build the batch preview.');
    }
}

/**
 * Commit the pending batch plan through the worldinfo guard, snapshotting
 * the previous per-field values first so the edit can be undone.
 */
async function EL_batchConfirmApply() {
    const plan = EL_batchPendingPlan;
    const previewEl = document.getElementById('batch-preview-modal');
    try {
        if (!plan || !plan.uids || !plan.uids.length) {
            try { EL_modalClose(previewEl); } catch (e) {}
            return;
        }
        if (!currentLorebookData || !currentLorebookData.entries) {
            if (typeof showToast === 'function') showToast('No lorebook open — batch edit cancelled.');
            return;
        }
        const book = currentLorebookName;
        const prev = {};
        const foldersBefore = EL_cloneBatchValue((extensionSettings.folders && extensionSettings.folders[book]) || []);
        const changedUids = [];
        for (const uid of plan.uids) {
            const entry = currentLorebookData.entries[uid];
            if (!entry) continue;
            const writes = {};
            for (const op of plan.ops) {
                let w = null;
                try { w = op.compute(entry) || null; } catch (e) { w = null; }
                if (w) {
                    for (const f of Object.keys(w)) writes[f] = w[f];
                }
            }
            const changedFields = Object.keys(writes).filter(f => !EL_batchValuesEqual(entry[f], writes[f]));
            if (!changedFields.length) continue;
            changedUids.push(String(uid));
            const oldVals = {};
            for (const f of changedFields) {
                oldVals[f] = (entry[f] === undefined) ? EL_BATCH_MISSING : EL_cloneBatchValue(entry[f]);
            }
            prev[String(uid)] = oldVals;
            for (const f of changedFields) entry[f] = writes[f];
            if (Object.prototype.hasOwnProperty.call(writes, 'delayUntilRecursion')) {
                try { delete entry.delayUntilRecursionLevel; } catch (e) {}
                try { delete entry.delay_until_recursion; } catch (e) {}
            }
        }
        let folderChanged = false;
        if (plan.folderOp) {
            const folders = (extensionSettings.folders && extensionSettings.folders[book]) || [];
            const beforeSig = JSON.stringify(folders.map(f => [f.id, f.entries]));
            folders.forEach(f => {
                try { f.entries = (f.entries || []).filter(x => !plan.uidSet.has(String(x))); } catch (e) {}
            });
            if (plan.folderOp.folderId) {
                const target = folders.find(f => f.id === plan.folderOp.folderId);
                if (target) {
                    try { target.entries.push(...plan.uids.map(String)); } catch (e) {}
                }
            }
            try { folderChanged = JSON.stringify(folders.map(f => [f.id, f.entries])) !== beforeSig; } catch (e) { folderChanged = true; }
        }
        if (!changedUids.length && !folderChanged) {
            if (typeof showToast === 'function') showToast('No changes — every selected entry already matches.');
            try { EL_modalClose(previewEl); } catch (e) {}
            EL_batchPendingPlan = null;
            return;
        }
        const batchOk = await ELG_guardSave(currentLorebookName, currentLorebookData, { explicitDelete: false, source: 'user', note: 'Batch edit' });
        EL_logGuardResult(batchOk, 'Batch edit', currentLorebookName);
        if (!batchOk) {
            EL_error('Batch edit blocked/failed');
            try {
                if (extensionSettings.folders) extensionSettings.folders[book] = foldersBefore;
            } catch (e) {}
            try { const fresh = await ELG_loadFresh(currentLorebookName); if (fresh) EL_setLorebookData(fresh, { own: true }); } catch (e) { EL_warn('reload after failed save failed', e); }
            if (typeof showToast === 'function') showToast('Batch edit was blocked — no changes were saved.');
            EL_batchPendingPlan = null;
            try { EL_modalClose(previewEl); } catch (e) {}
            renderEntries();
            return;
        }
        try { saveSettings(); } catch (e) {}
        EL_batchUndoState = { book, prev, foldersBefore: folderChanged ? foldersBefore : null, at: Date.now() };
        EL_updateBatchUndoButton();
        EL_batchPendingPlan = null;
        try { EL_modalClose(previewEl); } catch (e) {}
        EL_modalClose(els.batchModal);
        renderEntries();
        const n = changedUids.length;
        if (typeof showToast === 'function') {
            showToast('Batch edit applied to ' + n + ' entr' + (n === 1 ? 'y' : 'ies') + (folderChanged ? ' (folders updated)' : '') + '. Undo is in the toolbar.');
        }
    } catch (e) {
        EL_error('batch apply failed', e);
        if (typeof showToast === 'function') showToast('Batch edit failed.');
    }
}

/**
 * Restore the previous values captured by the last batch apply, through
 * the same guard-save path, then re-render.
 */
async function EL_batchUndoBatch() {
    try {
        const s = EL_batchUndoState;
        if (!s) {
            if (typeof showToast === 'function') showToast('Nothing to undo.');
            return;
        }
        if (s.book !== currentLorebookName || !currentLorebookData || !currentLorebookData.entries) {
            if (typeof showToast === 'function') showToast('Undo is no longer available (lorebook changed).');
            EL_batchClearUndo();
            return;
        }
        const uids = Object.keys(s.prev || {});
        for (const uid of uids) {
            const entry = currentLorebookData.entries[uid];
            if (!entry) continue;
            const oldVals = s.prev[uid] || {};
            for (const f of Object.keys(oldVals)) {
                const v = oldVals[f];
                try {
                    if (v === EL_BATCH_MISSING) delete entry[f];
                    else entry[f] = EL_cloneBatchValue(v);
                } catch (e) {}
            }
        }
        if (s.foldersBefore) {
            try {
                if (!extensionSettings.folders) extensionSettings.folders = {};
                extensionSettings.folders[s.book] = EL_cloneBatchValue(s.foldersBefore);
                saveSettings();
            } catch (e) {}
        }
        const ok = await ELG_guardSave(s.book, currentLorebookData, { explicitDelete: false, source: 'user', note: 'Undo batch edit' });
        EL_logGuardResult(ok, 'Undo batch edit', s.book);
        if (!ok) {
            EL_error('Undo batch edit blocked/failed');
            try { const fresh = await ELG_loadFresh(s.book); if (fresh) EL_setLorebookData(fresh, { own: true }); } catch (e) {}
            if (typeof showToast === 'function') showToast('Undo was blocked — no changes were saved.');
            renderEntries();
            return;
        }
        EL_batchClearUndo();
        renderEntries();
        if (typeof showToast === 'function') showToast('Batch edit undone (' + uids.length + ' entr' + (uids.length === 1 ? 'y' : 'ies') + ').');
    } catch (e) {
        EL_error('batch undo failed', e);
        if (typeof showToast === 'function') showToast('Undo failed.');
    }
}

/**
 * Drop the pending batch undo (e.g. the user switched lorebooks) and hide
 * the affordance so it can never be offered for a different book.
 */
function EL_batchClearUndo() {
    EL_batchUndoState = null;
    EL_updateBatchUndoButton();
}

/**
 * Show the toolbar Undo button only while an undo exists for the open book.
 */
function EL_updateBatchUndoButton() {
    try {
        const btn = document.getElementById('btn-batch-undo');
        if (!btn) return;
        const show = !!(EL_batchUndoState && EL_batchUndoState.book === currentLorebookName);
        btn.style.display = show ? '' : 'none';
        if (show) {
            let n = 0;
            try { n = Object.keys(EL_batchUndoState.prev || {}).length; } catch (e) {}
            btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Undo (' + n + ')';
            btn.title = 'Undo last batch edit (' + n + ' entries)';
        }
    } catch (e) {}
}

const EL_GENERATION_TYPE_TRIGGERS = Object.freeze(['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet']);

// SillyTavern stores characterFilter as { isExclude, names (avatar keys), tags (tag ids) }.
// The edit field shows character names; we translate names <-> avatar keys so a value
// typed here behaves the same as one typed in the native editor. Tags have no UI and are
// always preserved untouched.
function EL_characterFilterMaps() {
    const nameToAvatar = new Map();
    const avatarToLabel = new Map();
    try {
        const ctx = (typeof stContext !== 'undefined' && stContext) ? stContext : null;
        const chars = Array.isArray(ctx?.characters) ? ctx.characters : [];
        for (const c of chars) {
            if (!c || !c.avatar) continue;
            const avatar = String(c.avatar);
            avatarToLabel.set(avatar, String(c.name || avatar));
            const nm = String(c.name || '').trim().toLowerCase();
            if (nm && !nameToAvatar.has(nm)) nameToAvatar.set(nm, avatar);
        }
    } catch (e) { /* no character list available — fall back to raw values */ }
    return { nameToAvatar, avatarToLabel };
}

function EL_characterFilterToText(filter) {
    try {
        const names = (filter && typeof filter === 'object' && !Array.isArray(filter) && Array.isArray(filter.names)) ? filter.names : [];
        if (!names.length) return '';
        const { avatarToLabel } = EL_characterFilterMaps();
        return names.map(n => avatarToLabel.get(String(n)) || String(n)).join(', ');
    } catch (e) { return ''; }
}

function EL_buildCharacterFilter(text, isExclude, previous) {
    const prev = (previous && typeof previous === 'object' && !Array.isArray(previous)) ? previous : {};
    const tags = Array.isArray(prev.tags) ? prev.tags.slice() : [];
    const { nameToAvatar } = EL_characterFilterMaps();
    const names = [];
    for (const raw of String(text || '').split(',')) {
        const token = raw.trim();
        if (!token) continue;
        // Prefer an avatar key: typed character name -> avatar, else assume the
        // token already IS an avatar key. Never drop what the user typed.
        const key = nameToAvatar.get(token.toLowerCase()) || token;
        if (!names.includes(key)) names.push(key);
    }
    return { isExclude: isExclude === true, names, tags };
}

// ==========================================
// Entry Editing
// ==========================================
function openEditEntryModal(uid) {
    try {
        if (!currentLorebookData || !currentLorebookData.entries[uid]) return;

        const entry = currentLorebookData.entries[uid];
        document.getElementById('edit-entry-uid').value = uid;

        // Populate and select folder
        const fSelect = document.getElementById('edit-entry-folder');
        fSelect.innerHTML = '<option value="">-- No Folder (Root) --</option>';
        const folders = extensionSettings.folders[currentLorebookName] || [];
        folders.forEach(f => {
            const fullName = getFolderPathName(f.id);
            fSelect.innerHTML += `<option value="${f.id}">${escapeHtml(fullName)}</option>`;
        });
        const currentFolder = folders.find(f => f.entries.map(String).includes(String(uid)));
        fSelect.value = currentFolder ? currentFolder.id : '';

        document.getElementById('edit-comment').value = entry.comment || '';
        document.getElementById('edit-keys').value = safeJoin(entry.key, ', ');
        document.getElementById('edit-secondary-keys').value = safeJoin(entry.keysecondary, ', ');
        document.getElementById('edit-content').value = entry.content || '';

        const positionSelect = document.getElementById('edit-position');
        Array.from(positionSelect.options).forEach(opt => {
            const matchPos = parseInt(opt.value) === entry.position;
            const roleAttr = opt.dataset.role;
            const matchRole = roleAttr !== '' ? parseInt(roleAttr) === entry.role : true;
            if (matchPos && matchRole) {
                opt.selected = true;
            }
        });
        document.getElementById('edit-logic').value = entry.selectiveLogic || 0;

        document.getElementById('edit-order').value = entry.order ?? 100;
        document.getElementById('edit-depth').value = entry.depth ?? 4;
        document.getElementById('edit-probability').value = entry.probability ?? 100;
        document.getElementById('edit-delay').value = entry.delay ?? 0;
        document.getElementById('edit-use-probability').checked = entry.useProbability !== false;

        document.getElementById('edit-constant').checked = !!entry.constant;
        document.getElementById('edit-vectorized').checked = !!entry.vectorized;
        document.getElementById('edit-disable').checked = !!entry.disable;
        document.getElementById('edit-add-memo').checked = !!entry.addMemo;
        document.getElementById('edit-exclude').checked = !!entry.excludeRecursion;
        document.getElementById('edit-prevent').checked = !!entry.preventRecursion;

        document.getElementById('edit-outlet-name').value = entry.outletName || '';
        document.getElementById('edit-selective').checked = !!entry.selective;
        document.getElementById('edit-group').value = entry.group || '';
        document.getElementById('edit-group-weight').value = entry.groupWeight ?? 100;
        document.getElementById('edit-group-override').checked = !!entry.groupOverride;
        document.getElementById('edit-sticky').value = entry.sticky ?? 0;
        document.getElementById('edit-cooldown').value = entry.cooldown ?? 0;
        document.getElementById('edit-character-filter').value = EL_characterFilterToText(entry.characterFilter);
        document.getElementById('edit-triggers').value = safeJoin(entry.triggers, ', ');
        document.getElementById('edit-character-exclusion').checked = entry.characterFilter?.isExclude === true;

        document.getElementById('edit-match-char-desc').checked = !!entry.matchCharacterDescription;
        document.getElementById('edit-match-char-pers').checked = !!entry.matchCharacterPersonality;
        document.getElementById('edit-match-scenario').checked = !!entry.matchScenario;
        document.getElementById('edit-match-persona').checked = !!entry.matchPersonaDescription;
        document.getElementById('edit-match-char-depth').checked = !!entry.matchCharacterDepthPrompt;
        document.getElementById('edit-match-creator-notes').checked = !!entry.matchCreatorNotes;

        document.getElementById('edit-scan-depth').value = entry.scanDepth !== undefined && entry.scanDepth !== null ? entry.scanDepth : '';
        document.getElementById('edit-recursion-level').value = (typeof entry.delayUntilRecursion === 'number' && entry.delayUntilRecursion > 1) ? entry.delayUntilRecursion : '';

        document.getElementById('edit-case-sensitive').value = entry.caseSensitive === true ? 'true' : (entry.caseSensitive === false ? 'false' : 'null');
        document.getElementById('edit-whole-words').value = entry.matchWholeWords === true ? 'true' : (entry.matchWholeWords === false ? 'false' : 'null');
        document.getElementById('edit-use-group-scoring').value = entry.useGroupScoring === true ? 'true' : (entry.useGroupScoring === false ? 'false' : 'null');

        document.getElementById('edit-automation-id').value = entry.automationId || '';
        document.getElementById('edit-delay-recursion').checked = !!entry.delayUntilRecursion;
        document.getElementById('edit-ignore-budget').checked = !!entry.ignoreBudget;

        EL_modalOpen('edit-entry-modal');
    } catch (e) {
        alert('Error opening modal: ' + e.stack);
        console.error(e);
    }
}
window.openEditEntryModal = openEditEntryModal;

async function saveEditedEntry() {
    const uid = document.getElementById('edit-entry-uid').value;
    if (!currentLorebookData || !currentLorebookData.entries[uid]) return;

    const entry = currentLorebookData.entries[uid];

    // Change folder mapping
    const newFolderId = document.getElementById('edit-entry-folder').value;
    const foldersBefore = JSON.parse(JSON.stringify(extensionSettings.folders[currentLorebookName] || []));
    const folders = extensionSettings.folders[currentLorebookName] || [];
    folders.forEach(f => {
        f.entries = f.entries.filter(e => String(e) !== String(uid));
    });
    if (newFolderId) {
        const target = folders.find(f => f.id === newFolderId);
        if (target) {
            target.entries.push(String(uid));
        }
    }

    entry.comment = document.getElementById('edit-comment').value;

    const keysStr = document.getElementById('edit-keys').value;
    entry.key = keysStr.split(',').map(k => k.trim()).filter(k => k);

    const secKeysStr = document.getElementById('edit-secondary-keys').value;
    entry.keysecondary = secKeysStr.split(',').map(k => k.trim()).filter(k => k);

    entry.content = document.getElementById('edit-content').value;

    const positionSelect = document.getElementById('edit-position');
    const selectedOption = positionSelect.selectedOptions[0];
    entry.position = parseInt(selectedOption.value) || 0;
    entry.role = selectedOption.dataset.role !== '' ? parseInt(selectedOption.dataset.role) : (entry.role ?? null);
    entry.selectiveLogic = parseInt(document.getElementById('edit-logic').value) || 0;

    entry.order = parseInt(document.getElementById('edit-order').value);
    if (isNaN(entry.order)) entry.order = 100;

    entry.depth = parseInt(document.getElementById('edit-depth').value);
    if (isNaN(entry.depth)) entry.depth = 4;

    entry.probability = parseInt(document.getElementById('edit-probability').value);
    if (isNaN(entry.probability)) entry.probability = 100;
    entry.useProbability = document.getElementById('edit-use-probability').checked;

    entry.delay = parseInt(document.getElementById('edit-delay').value) || 0;

    // constant and vectorized are mutually exclusive in SillyTavern (tri-state).
    entry.constant = document.getElementById('edit-constant').checked;
    if (entry.constant) entry.vectorized = false;
    entry.vectorized = document.getElementById('edit-vectorized').checked;
    if (entry.vectorized) entry.constant = false;
    entry.disable = document.getElementById('edit-disable').checked;
    entry.addMemo = document.getElementById('edit-add-memo').checked;
    entry.excludeRecursion = document.getElementById('edit-exclude').checked;
    entry.preventRecursion = document.getElementById('edit-prevent').checked;

    entry.outletName = document.getElementById('edit-outlet-name').value;
    entry.selective = document.getElementById('edit-selective').checked;
    entry.group = document.getElementById('edit-group').value;
    entry.groupWeight = parseInt(document.getElementById('edit-group-weight').value);
    if (isNaN(entry.groupWeight)) entry.groupWeight = 100;
    entry.groupOverride = document.getElementById('edit-group-override').checked;
    entry.sticky = parseInt(document.getElementById('edit-sticky').value) || 0;
    entry.cooldown = parseInt(document.getElementById('edit-cooldown').value) || 0;

    entry.characterFilter = EL_buildCharacterFilter(
        document.getElementById('edit-character-filter').value,
        document.getElementById('edit-character-exclusion').checked,
        entry.characterFilter,
    );
    delete entry.character_exclusion;

    const triggerStr = document.getElementById('edit-triggers').value;
    const parsedTriggers = triggerStr ? triggerStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    const storedTriggers = Array.isArray(entry.triggers) ? entry.triggers : [];
    // Only filter to core's known trigger values when the user actually changed the
    // field. Filtering unconditionally would silently drop a non-standard token an
    // entry carried (e.g. from an imported card) during an unrelated edit.
    if (JSON.stringify(parsedTriggers) !== JSON.stringify(storedTriggers)) {
        entry.triggers = [...new Set(parsedTriggers.filter(t => EL_GENERATION_TYPE_TRIGGERS.includes(t)))];
    }

    entry.matchCharacterDescription = document.getElementById('edit-match-char-desc').checked;
    entry.matchCharacterPersonality = document.getElementById('edit-match-char-pers').checked;
    entry.matchScenario = document.getElementById('edit-match-scenario').checked;
    entry.matchPersonaDescription = document.getElementById('edit-match-persona').checked;
    entry.matchCharacterDepthPrompt = document.getElementById('edit-match-char-depth').checked;
    entry.matchCreatorNotes = document.getElementById('edit-match-creator-notes').checked;

    const scanDepthVal = document.getElementById('edit-scan-depth').value;
    entry.scanDepth = scanDepthVal === '' ? null : parseInt(scanDepthVal);

    // ST stores one field: delayUntilRecursion = false | true | number(>1).
    const delayRecursionOn = document.getElementById('edit-delay-recursion').checked;
    const recursionLevel = parseInt(document.getElementById('edit-recursion-level').value);
    entry.delayUntilRecursion = !delayRecursionOn ? false
        : (!Number.isFinite(recursionLevel) || recursionLevel <= 1) ? true
            : recursionLevel;
    delete entry.delayUntilRecursionLevel;
    delete entry.delay_until_recursion;

    const parseNullBool = (v) => v === 'true' ? true : (v === 'false' ? false : null);
    entry.caseSensitive = parseNullBool(document.getElementById('edit-case-sensitive').value);
    entry.matchWholeWords = parseNullBool(document.getElementById('edit-whole-words').value);
    entry.useGroupScoring = parseNullBool(document.getElementById('edit-use-group-scoring').value);

    entry.automationId = document.getElementById('edit-automation-id').value;
    entry.ignoreBudget = document.getElementById('edit-ignore-budget').checked;

    if (EL_isGenerating()) EL_warn(`saveEditedEntry: generation running (agent=${agentEngine?.state}) — save may race with agent`, { uid: entry.uid, book: currentLorebookName });
    const _guardOk = await ELG_guardSave(currentLorebookName, currentLorebookData, { explicitDelete: false, source: 'user', note: 'Save edited entry' });
    EL_logGuardResult(_guardOk, 'saveEditedEntry', currentLorebookName, { uid: entry.uid });
    if (!_guardOk) { EL_error('saveEditedEntry blocked/failed — entry not persisted, will reload from server'); extensionSettings.folders[currentLorebookName] = foldersBefore; try { const fresh = await ELG_loadFresh(currentLorebookName); if(fresh){ EL_setLorebookData(fresh, { own: true }); } } catch(e){ EL_warn('reload after failed save failed', e);} } else { saveSettings(); }
    EL_modalClose('edit-entry-modal');
    renderEntries();
}

// ==========================================
// Context Menu
// ==========================================

function getFreeWorldEntryUid(data) {
    if (!data || !('entries' in data)) {
        EL_warn('getFreeWorldEntryUid: invalid data', data);
        return null;
    }
    const MAX_UID = 1000000;
    for (let uid = 0; uid < MAX_UID; uid++) {
        if (uid in data.entries) {
            continue;
        }
        return uid;
    }
    EL_error('getFreeWorldEntryUid: UID space exhausted (1M)', { book: currentLorebookName, entries: Object.keys(data.entries).length });
    try { EL_toast('UID space exhausted — cannot create entry', 'error'); } catch {}
    return null;
}

function duplicateWorldInfoEntry(data, uid) {
    if (!data || !('entries' in data) || !data.entries[uid]) {
        EL_warn('duplicateWorldInfoEntry: invalid data/uid', { uid, hasData: !!data, hasEntry: !!(data && data.entries && data.entries[uid]) });
        return null;
    }

    const newUid = getFreeWorldEntryUid(data);
    if (newUid === null) {
        EL_error('duplicateWorldInfoEntry: Couldn\'t assign UID', { uid, book: currentLorebookName });
        try { EL_toast('Duplicate failed: no free UID', 'error'); } catch {}
        return null;
    }
    try { EL_info(`duplicateWorldInfoEntry uid=${uid} → newUid=${newUid} book="${currentLorebookName}"`); } catch {}

    const newEntry = {
        ...structuredClone(data.entries[uid]),
        uid: newUid,
    };
    const maxDisplayIndex = Object.values(data.entries).reduce((max, entry) => Math.max(max, entry.displayIndex ?? -1), -1);
    newEntry.displayIndex = maxDisplayIndex + 1;
    data.entries[newUid] = newEntry;

    return newEntry;
}

function deleteWIOriginalDataValue(data, uid) {
    if (data.originalData && Array.isArray(data.originalData.entries)) {
        const originalIndex = data.originalData.entries.findIndex(x => String(x.uid) === String(uid));
        if (originalIndex >= 0) {
            data.originalData.entries.splice(originalIndex, 1);
        }
    }
}

async function moveWorldInfoEntry(sourceName, targetName, uid, { deleteOriginal = true } = {}) {
    if (sourceName === targetName) {
        return false;
    }

    const sourceData = await ELG_loadFresh(sourceName);
    const targetData = await ELG_loadFresh(targetName);
    if (!sourceData || !sourceData.entries || !targetData || !targetData.entries) {
        return false;
    }
    if (!sourceData.entries[uid]) {
        return false;
    }

    const entryToMove = structuredClone(sourceData.entries[uid]);
    const newUid = getFreeWorldEntryUid(targetData);
    if (newUid === null) {
        console.error('Enhanced Lorebook: Couldn\'t assign UID to a moved entry');
        return false;
    }
    const maxDisplayIndex = Object.values(targetData.entries).reduce((max, entry) => Math.max(max, entry.displayIndex ?? -1), -1);
    entryToMove.uid = newUid;
    entryToMove.displayIndex = maxDisplayIndex + 1;
    targetData.entries[newUid] = entryToMove;

    if (deleteOriginal) {
        delete sourceData.entries[uid];
        deleteWIOriginalDataValue(sourceData, uid);
    }

    EL_info(`Move entry uid=${uid} "${currentLorebookName}" → "${targetName}" deleteOriginal=${deleteOriginal}`);
    { const _moveTOk = await ELG_guardSave(targetName, targetData, { explicitDelete: false, source: 'user', note: 'Move entry to lorebook (target)' }); EL_logGuardResult(_moveTOk,'Move target',targetName); if(!_moveTOk){ EL_error('Move failed at target — aborting source delete (prevent loss)', { uid, targetName, sourceName }); try{ EL_toast('Move failed at target — entry not lost', 'error'); }catch{} throw new Error('Move target save failed'); } }
    if (deleteOriginal) {
        const _moveSOk = await ELG_guardSave(sourceName, sourceData, { explicitDelete: true, source: 'user', note: 'Move entry out of source lorebook' }); EL_logGuardResult(_moveSOk,'Move source',sourceName); if(!_moveSOk) EL_error('Move source delete failed — entry may be duplicated', { uid, sourceName });
    }
    EL_info('Move ok', { uid, newUid, targetName, sourceName });

    return true;
}

// ── Copy / Paste that respects folder URL (extension-only) ─────────────
function EL_copySelectedEntries() {
    if (!currentLorebookName || !currentLorebookData || selectedEntries.size === 0) {
        if (typeof showToast === 'function') showToast('No entries selected');
        return false;
    }
    const items = [];
    for (const uid of selectedEntries) {
        const entry = currentLorebookData.entries[uid];
        if (!entry) continue;
        const cloned = structuredClone(entry);
        let url = null;
        try {
            if (window.ELFolderUrl) url = window.ELFolderUrl.getUrlForUid(uid, currentLorebookName);
        } catch {}
        items.push({ entry: cloned, url, _origUid: String(uid) });
    }
    if (!items.length) return false;
    EL_clipboard = { book: currentLorebookName, items, ts: Date.now() };
    try {
        const text = JSON.stringify({ source: 'enhanced-lorebook', book: currentLorebookName, items: items.map(i => ({ entry: i.entry, url: i.url })) });
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
    } catch {}
    if (typeof showToast === 'function') showToast(`Copied ${items.length} entr${items.length === 1 ? 'y' : 'ies'} (URL-aware)`);
    return true;
}

async function EL_pasteEntries(targetFolderId = null, targetBook = null) {
    const book = targetBook || currentLorebookName;
    if (!book) {
        if (typeof showToast === 'function') showToast('Open a lorebook first');
        return;
    }
    // Try to hydrate from system clipboard if EL_clipboard is empty / stale (recent browser paste)
    let items = EL_clipboard?.items || null;
    if (!items) {
        try {
            if (navigator.clipboard && navigator.clipboard.readText) {
                const text = await navigator.clipboard.readText();
                if (text) {
                    const parsed = JSON.parse(text);
                    if (parsed && parsed.source === 'enhanced-lorebook' && Array.isArray(parsed.items)) items = parsed.items;
                }
            }
        } catch {}
    }
    if (!items || !items.length) {
        if (typeof showToast === 'function') showToast('Clipboard empty — copy entries first (Copy respects folder URL)');
        return;
    }
    if (!currentLorebookData || currentLorebookName !== book) {
        // Pasting into a different book: the TARGET book's data must be loaded first.
        // Continuing with the previously-open book's entries in currentLorebookData
        // would make the save below write them into the target and destroy it.
        const fresh = await ELG_loadFresh(book);
        if (!fresh || !fresh.entries) {
            if (typeof showToast === 'function') showToast('Could not load "' + book + '" — paste cancelled, nothing was written.');
            return;
        }
        EL_setLorebookData(fresh, { own: true });
        EL_setLorebookName(book);
    }
    // Ensure target folder exists; if targetFolderId provided (paste into folder), use its path, else use each item's URL path
    let targetPathForEmpty = null;
    if (targetFolderId && window.ELFolderUrl) {
        try { targetPathForEmpty = window.ELFolderUrl.getFolderPathById(book, targetFolderId); } catch {}
    }
    const newUids = [];
    const urlMapForNew = new Map();
    for (const it of items) {
        const origEntry = it.entry;
        if (!origEntry) continue;
        // Decide URL to respect
        let urlToRespect = it.url || null;
        // If user pasted explicitly into a folder, override path but keep original's name path if copying group?
        // For entry copy, respect original path unless targetFolderId is set, then rebase to target folder path
        if (targetFolderId) {
            const targetPath = window.ELFolderUrl ? window.ELFolderUrl.getFolderPathById(book, targetFolderId) : '';
            // Rebase: keep entry's leaf path? Simpler: put directly into target folder irrespective of original path
            // If original was in "A / B", and target is "C", result should be "C / B"? But user expects paste into C.
            // We choose: paste into target folder directly for explicit paste-into-folder, otherwise respect original.
            urlToRespect = window.ELFolderUrl ? window.ELFolderUrl.buildUrl(book, targetPath, 'tmp') : null;
            // will be rebased per newUid below
        }
        const newUid = getFreeWorldEntryUid(currentLorebookData);
        if (newUid === null) {
            console.error('Enhanced Lorebook: Couldn\'t assign UID for paste');
            continue;
        }
        const newEntry = {
            ...structuredClone(origEntry),
            uid: newUid,
        };
        // Fix displayIndex to append
        try {
            const maxIdx = Object.values(currentLorebookData.entries).reduce((m, e) => Math.max(m, e.displayIndex ?? -1), -1);
            newEntry.displayIndex = maxIdx + 1;
        } catch {}
        // Preserve order field similarly
        currentLorebookData.entries[newUid] = newEntry;
        const sNew = String(newUid);
        newUids.push(sNew);
        if (urlToRespect && window.ELFolderUrl) {
            const newUrl = window.ELFolderUrl.buildUrlForNewUid(urlToRespect, sNew);
            urlMapForNew.set(sNew, newUrl);
        }
    }
    // Now assign each new entry to its URL folder (extension-only)
    if (window.ELFolderUrl) {
        for (const sNew of newUids) {
            const url = urlMapForNew.get(sNew);
            if (url) {
                try { window.ELFolderUrl.assignEntryToUrl(sNew, url, book); } catch {}
            }
        }
    }
    ensureFoldersStructure(book);
    saveSettings();
    await ELG_guardSave(book, currentLorebookData, { explicitDelete: false, source: 'user', note: `Paste ${newUids.length} entr${newUids.length === 1 ? 'y' : 'ies'} (URL-aware)` });
    selectedEntries.clear();
    newUids.forEach(uid => selectedEntries.add(uid));
    updateBatchButton();
    renderEntries();
    if (typeof showToast === 'function') showToast(`Pasted ${newUids.length} entr${newUids.length === 1 ? 'y' : 'ies'} — folder URL respected`);
}

async function duplicateFolderHelper(fId, newParentId) {
    const folders = extensionSettings.folders[currentLorebookName] || [];
    const f = folders.find(x => x.id === fId);
    if (!f) return null;
    
    const newFolderId = 'folder_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const newFolder = {
        id: newFolderId,
        name: f.name + ' (Copy)',
        parentId: newParentId,
        order: f.order ?? 100,
        entries: []
    };
    
    for (const entryUid of f.entries) {
        const newEntry = duplicateWorldInfoEntry(currentLorebookData, entryUid);
        if (newEntry) {
            newFolder.entries.push(String(newEntry.uid));
        }
    }
    
    folders.push(newFolder);
    
    const subfolders = folders.filter(x => x.parentId === fId);
    for (const sub of subfolders) {
        await duplicateFolderHelper(sub.id, newFolderId);
    }
    
    return newFolderId;
}

async function sendFolderToLorebookHelper(folderId, targetBook, targetData, targetParentId, isMove) {
    if (!extensionSettings.folders[targetBook]) {
        extensionSettings.folders[targetBook] = [];
    }
    const folders = extensionSettings.folders[currentLorebookName] || [];
    const f = folders.find(x => x.id === folderId);
    if (!f) return { folderId: null, movedCount: 0 };

    const newFolderId = 'folder_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const newFolder = {
        id: newFolderId,
        name: f.name,
        parentId: targetParentId,
        order: f.order ?? 100,
        entries: []
    };

    let movedCount = 0;
    for (const entryUid of f.entries) {
        if (!currentLorebookData.entries[entryUid]) {
            continue;
        }
        const beforeKeys = new Set(Object.keys(targetData.entries));
        let moved = false;
        try {
            moved = await moveWorldInfoEntry(currentLorebookName, targetBook, entryUid, { deleteOriginal: isMove });
        } catch (e) {
            EL_error('sendFolderToLorebookHelper move failed', { entryUid, targetBook, error: e && e.message });
            continue;
        }
        if (!moved) {
            continue;
        }
        movedCount += 1;
        const updatedTargetData = await stContext.loadWorldInfo(targetBook);
        Object.assign(targetData.entries, updatedTargetData.entries);
        const newUid = Object.keys(targetData.entries).find(uid => !beforeKeys.has(uid));
        if (newUid) {
            newFolder.entries.push(String(newUid));
        }
    }

    extensionSettings.folders[targetBook].push(newFolder);

    const subfolders = folders.filter(x => x.parentId === folderId);
    for (const sub of subfolders) {
        try {
            const subResult = await sendFolderToLorebookHelper(sub.id, targetBook, targetData, newFolderId, isMove);
            if (subResult && typeof subResult.movedCount === 'number') {
                movedCount += subResult.movedCount;
            }
        } catch (e) {
            EL_error('sendFolderToLorebookHelper subfolder failed', { subId: sub.id, error: e && e.message });
        }
    }

    if (isMove && movedCount > 0) {
        const updatedSourceData = await stContext.loadWorldInfo(currentLorebookName);
        currentLorebookData.entries = updatedSourceData.entries;
        // Re-read the array: a recursive child call may already have removed its own
        // folder from it, and assigning the array captured at the top would undo that.
        const currentSourceFolders = extensionSettings.folders[currentLorebookName] || [];
        extensionSettings.folders[currentLorebookName] = currentSourceFolders.filter(x => x.id !== folderId);
    }

    return { folderId: newFolderId, movedCount };
}

function createContextMenu() {
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.id = 'el-context-menu';
    document.body.appendChild(menu);
    els.contextMenu = menu;

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#el-context-menu')) {
            els.contextMenu.classList.remove('visible');
        }
    });
}

function showContextMenu(x, y, targetType = 'entry', targetId = null) {
    els.contextMenu.innerHTML = '';

    if (targetType === 'entry') {
        // Move to folder
        const moveItem = document.createElement('div');
        moveItem.className = 'context-item';
        moveItem.innerHTML = '<i class="fa-solid fa-folder-tree"></i> Move to Folder...';
        moveItem.addEventListener('click', (e) => {
            e.stopPropagation();
            showFolderSelectMenu(x, y);
        });
        els.contextMenu.appendChild(moveItem);

        // Duplicate
        const dupItem = document.createElement('div');
        dupItem.className = 'context-item';
        dupItem.innerHTML = '<i class="fa-solid fa-copy"></i> Duplicate Selected';
        dupItem.addEventListener('click', async () => {
            els.contextMenu.classList.remove('visible');
            const newUids = [];
            // Capture URL for each original before mutation (extension-only, avoid ST pollution)
            const urlMap = new Map();
            if (window.ELFolderUrl) {
                for (const uid of selectedEntries) {
                    if (currentLorebookData.entries[uid]) {
                        const u = window.ELFolderUrl.getUrlForUid(uid, currentLorebookName);
                        if (u) urlMap.set(String(uid), u);
                    }
                }
            }
            for (const uid of selectedEntries) {
                if (currentLorebookData.entries[uid]) {
                    const newEntry = duplicateWorldInfoEntry(currentLorebookData, uid);
                    if (newEntry) {
                        newUids.push({ original: uid, duplicate: String(newEntry.uid) });
                    }
                }
            }
            // Place duplicated entries next to their original via stable URL, not at root
            if (window.ELFolderUrl && urlMap.size) {
                for (const { original, duplicate } of newUids) {
                    const sourceUrl = urlMap.get(String(original));
                    if (!sourceUrl) continue;
                    const newUrl = window.ELFolderUrl.buildUrlForNewUid(sourceUrl, duplicate);
                    window.ELFolderUrl.assignEntryToUrl(duplicate, newUrl, currentLorebookName);
                    // Keep display order close to original and splice right after original inside folder
                    try {
                        const folders = extensionSettings.folders[currentLorebookName] || [];
                        const origId = window.ELFolderUrl.getFolderIdForUid(original, currentLorebookName);
                        const dupId = window.ELFolderUrl.getFolderIdForUid(duplicate, currentLorebookName);
                        if (origId && origId === dupId) {
                            const folder = folders.find(f => f.id === origId);
                            if (folder && Array.isArray(folder.entries)) {
                                const sDup = String(duplicate);
                                // assignEntryToUrl pushed to end; move it right after original
                                const idxOrig = folder.entries.indexOf(String(original));
                                const idxDup = folder.entries.indexOf(sDup);
                                if (idxOrig !== -1 && idxDup !== -1 && idxDup !== idxOrig + 1) {
                                    folder.entries.splice(idxDup, 1);
                                    folder.entries.splice(idxOrig + 1, 0, sDup);
                                }
                            }
                        }
                        // Copy order so duplicate sorts next to original (tiny delta keeps it adjacent)
                        if (currentLorebookData.entries[original] && currentLorebookData.entries[duplicate]) {
                            const origOrder = currentLorebookData.entries[original].order ?? 100;
                            currentLorebookData.entries[duplicate].order = origOrder;
                        }
                    } catch {}
                }
            } else {
                // Fallback: old path — add to same folder, else root
                const folders = extensionSettings.folders[currentLorebookName] || [];
                newUids.forEach(({ original, duplicate }) => {
                    const folder = folders.find(f => f.entries.map(String).includes(String(original)));
                    if (folder) {
                        const idx = folder.entries.indexOf(String(original));
                        if (idx !== -1) folder.entries.splice(idx + 1, 0, duplicate);
                        else folder.entries.push(duplicate);
                    }
                });
            }
            saveSettings();
            if (EL_isGenerating()) EL_warn('Duplicate selected: generation running — may race', { book: currentLorebookName, count: selectedEntries.size });
            { const _dupOk = await ELG_guardSave(currentLorebookName, currentLorebookData, { explicitDelete: false, source: 'user', note: 'Duplicate selected entries' }); EL_logGuardResult(_dupOk,'Duplicate selected',currentLorebookName); if(!_dupOk){ EL_error('Duplicate save blocked/failed — entries not persisted, will vanish on next sync (LOSS RISK)'); try{ const fresh=await ELG_loadFresh(currentLorebookName); if(fresh) EL_setLorebookData(fresh, { own: true }); }catch(e){} } else EL_info('Duplicate save ok', { book: currentLorebookName }); }
            selectedEntries.clear();
            updateBatchButton();
            renderEntries();
        });
        els.contextMenu.appendChild(dupItem);

        // Copy (URL-aware)
        if (selectedEntries.size > 0) {
            const copyItem = document.createElement('div');
            copyItem.className = 'context-item';
            copyItem.innerHTML = '<i class="fa-solid fa-clipboard"></i> Copy Selected';
            copyItem.addEventListener('click', () => {
                els.contextMenu.classList.remove('visible');
                EL_copySelectedEntries();
            });
            els.contextMenu.appendChild(copyItem);
        }
        // Paste (URL-aware) — respects stored folder path URLs
        {
            const hasClip = EL_clipboard && Array.isArray(EL_clipboard.items) && EL_clipboard.items.length > 0;
            const pasteItem = document.createElement('div');
            pasteItem.className = 'context-item' + (hasClip ? '' : ' disabled');
            pasteItem.style.opacity = hasClip ? '' : '0.45';
            pasteItem.style.pointerEvents = hasClip ? '' : 'none';
            pasteItem.innerHTML = '<i class="fa-solid fa-paste"></i> Paste' + (hasClip ? ` (${EL_clipboard.items.length})` : '');
            if (hasClip) {
                pasteItem.addEventListener('click', async () => {
                    els.contextMenu.classList.remove('visible');
                    // If right-clicked an entry, paste into its folder for intuitive placement
                    let targetFolderId = null;
                    if (targetId !== null && currentLorebookData.entries[targetId]) {
                        try {
                            if (window.ELFolderUrl) targetFolderId = window.ELFolderUrl.getFolderIdForUid(targetId, currentLorebookName);
                        } catch {}
                    }
                    // For entry paste we respect URLs; if targetFolderId provided we rebase there via EL_pasteEntries logic
                    // Here we want URL-respect: don't force rebase — just respect original URLs (null = root)
                    // So we call with null to respect stored URLs
                    await EL_pasteEntries(targetFolderId, currentLorebookName);
                });
            }
            els.contextMenu.appendChild(pasteItem);
        }

        // Send to another lorebook
        const sendItem = document.createElement('div');
        sendItem.className = 'context-item';
        sendItem.innerHTML = '<i class="fa-solid fa-share-from-square"></i> Send to Lorebook...';
        sendItem.addEventListener('click', (e) => {
            e.stopPropagation();
            showSendToLorebookMenu(x, y, 'entry', Array.from(selectedEntries));
        });
        els.contextMenu.appendChild(sendItem);

        // Download Selected
        if (selectedEntries.size > 0) {
            const downloadItem = document.createElement('div');
            downloadItem.className = 'context-item';
            downloadItem.innerHTML = '<i class="fa-solid fa-download"></i> Download Selected...';
            downloadItem.addEventListener('click', (e) => {
                e.stopPropagation();
                els.contextMenu.classList.remove('visible');
                showDownloadFormatPicker();
            });
            els.contextMenu.appendChild(downloadItem);
        }

        // Divider
        const divider = document.createElement('div');
        divider.className = 'context-divider';
        els.contextMenu.appendChild(divider);

        // Delete
        const deleteItem = document.createElement('div');
        deleteItem.className = 'context-item';
        deleteItem.innerHTML = '<i class="fa-solid fa-trash"></i> Delete Selected';
        deleteItem.style.color = 'var(--danger-color)';
        deleteItem.addEventListener('click', async () => {
            els.contextMenu.classList.remove('visible');
            if (confirm(`Delete ${selectedEntries.size} entries?`)) {
                const deletedUids = Array.from(selectedEntries);
                deletedUids.forEach(uid => {
                    delete currentLorebookData.entries[uid];
                });
                EL_info(`Delete selected: ${deletedUids.length} entries book="${currentLorebookName}"`, deletedUids.slice(0, 10));
                const ok = await ELG_guardSave(currentLorebookName, currentLorebookData, { explicitDelete: true, source: 'user', note: 'Delete selected entries' });
                EL_logGuardResult(ok, 'Delete selected', currentLorebookName);
                if (ok) {
                    const folders = extensionSettings.folders[currentLorebookName] || [];
                    deletedUids.forEach(uid => {
                        folders.forEach(f => f.entries = f.entries.filter(e => String(e) !== String(uid)));
                    });
                    saveSettings();
                    EL_info('Delete ok, entries moved to Trash', { book: currentLorebookName });
                } else {
                    EL_error('Delete blocked/failed — entries still on disk, reloading');
                    try { const fresh = await ELG_loadFresh(currentLorebookName); if (fresh) EL_setLorebookData(fresh, { own: true }); } catch (e) {}
                }
                selectedEntries.clear();
                updateBatchButton();
                renderEntries();
            }
        });
        els.contextMenu.appendChild(deleteItem);

    } else if (targetType === 'folder') {
        // Add Sub-item
        const addSubItem = document.createElement('div');
        addSubItem.className = 'context-item';
        addSubItem.innerHTML = '<i class="fa-solid fa-circle-plus"></i> Add Sub-item...';
        addSubItem.addEventListener('click', () => {
            els.contextMenu.classList.remove('visible');
            openAddItemModal(targetId);
        });
        els.contextMenu.appendChild(addSubItem);

        // Paste into Folder (URL-aware rebase)
        {
            const hasClip = EL_clipboard && Array.isArray(EL_clipboard.items) && EL_clipboard.items.length > 0;
            const pasteIntoItem = document.createElement('div');
            pasteIntoItem.className = 'context-item' + (hasClip ? '' : ' disabled');
            pasteIntoItem.style.opacity = hasClip ? '' : '0.45';
            pasteIntoItem.style.pointerEvents = hasClip ? '' : 'none';
            pasteIntoItem.innerHTML = '<i class="fa-solid fa-paste"></i> Paste into Folder' + (hasClip ? ` (${EL_clipboard.items.length})` : '');
            if (hasClip) {
                pasteIntoItem.addEventListener('click', async () => {
                    els.contextMenu.classList.remove('visible');
                    await EL_pasteEntries(targetId, currentLorebookName);
                });
            }
            els.contextMenu.appendChild(pasteIntoItem);
        }

        // Duplicate Folder
        const dupFolderItem = document.createElement('div');
        dupFolderItem.className = 'context-item';
        dupFolderItem.innerHTML = '<i class="fa-solid fa-copy"></i> Duplicate Folder';
        dupFolderItem.addEventListener('click', async () => {
            els.contextMenu.classList.remove('visible');
            const folder = extensionSettings.folders[currentLorebookName].find(f => f.id === targetId);
            if (!folder) return;
            await duplicateFolderHelper(targetId, folder.parentId);
            saveSettings();
            await ELG_guardSave(currentLorebookName, currentLorebookData, { explicitDelete: false, source: 'user', note: 'Duplicate folder' });
            renderEntries();
        });
        els.contextMenu.appendChild(dupFolderItem);

        // Move Folder
        const moveFolderItem = document.createElement('div');
        moveFolderItem.className = 'context-item';
        moveFolderItem.innerHTML = '<i class="fa-solid fa-arrow-right-arrow-left"></i> Move Folder...';
        moveFolderItem.addEventListener('click', () => {
            els.contextMenu.classList.remove('visible');
            showMoveFolderMenu(targetId);
        });
        els.contextMenu.appendChild(moveFolderItem);

        // Cut / Copy folder(s): operate on the multi-selection when non-empty, else on the clicked folder
        {
            const liveFolders = (extensionSettings.folders[currentLorebookName] || []).map(f => f.id);
            const picked = selectedFolders.size ? Array.from(selectedFolders).filter(id => liveFolders.includes(id)) : [targetId];
            const n = picked.length;
            const cutItem = document.createElement('div');
            cutItem.className = 'context-item';
            cutItem.innerHTML = '<i class="fa-solid fa-scissors"></i> ' + (n > 1 ? `Cut ${n} Selected Folders` : 'Cut Folder');
            cutItem.addEventListener('click', () => {
                els.contextMenu.classList.remove('visible');
                try { EL_cutFolders(picked); } catch (e) {}
            });
            els.contextMenu.appendChild(cutItem);

            const copyItem = document.createElement('div');
            copyItem.className = 'context-item';
            copyItem.innerHTML = '<i class="fa-solid fa-copy"></i> ' + (n > 1 ? `Copy ${n} Selected Folders` : 'Copy Folder');
            copyItem.addEventListener('click', () => {
                els.contextMenu.classList.remove('visible');
                try { EL_copyFolders(picked); } catch (e) {}
            });
            els.contextMenu.appendChild(copyItem);
        }

        // Paste folder(s) into this folder
        {
            const hasFolderClip = EL_folderClipboard && Array.isArray(EL_folderClipboard.folderIds) && EL_folderClipboard.folderIds.length > 0 && EL_folderClipboard.book === currentLorebookName;
            const pasteFolderItem = document.createElement('div');
            pasteFolderItem.className = 'context-item' + (hasFolderClip ? '' : ' disabled');
            pasteFolderItem.style.opacity = hasFolderClip ? '' : '0.45';
            pasteFolderItem.style.pointerEvents = hasFolderClip ? '' : 'none';
            pasteFolderItem.innerHTML = '<i class="fa-solid fa-paste"></i> Paste into this Folder' + (hasFolderClip ? ` (${EL_folderClipboard.folderIds.length})` : '');
            if (hasFolderClip) {
                pasteFolderItem.addEventListener('click', async () => {
                    els.contextMenu.classList.remove('visible');
                    try { await EL_pasteFoldersInto(targetId); } catch (e) {}
                });
            }
            els.contextMenu.appendChild(pasteFolderItem);
        }

        // Send Folder to Lorebook
        const sendFolderItem = document.createElement('div');
        sendFolderItem.className = 'context-item';
        sendFolderItem.innerHTML = '<i class="fa-solid fa-share-from-square"></i> Send to Lorebook...';
        sendFolderItem.addEventListener('click', (e) => {
            e.stopPropagation();
            showSendToLorebookMenu(x, y, 'folder', [targetId]);
        });
        els.contextMenu.appendChild(sendFolderItem);

        // Rename Folder
        const renameFolderItem = document.createElement('div');
        renameFolderItem.className = 'context-item';
        renameFolderItem.innerHTML = '<i class="fa-solid fa-pencil"></i> Rename Folder...';
        renameFolderItem.addEventListener('click', () => {
            els.contextMenu.classList.remove('visible');
            renameFolder(targetId);
        });
        els.contextMenu.appendChild(renameFolderItem);

        // Remove Empty Folders (book-wide cleanup, confirmed, never automatic)
        const cleanupItem = document.createElement('div');
        cleanupItem.className = 'context-item';
        cleanupItem.innerHTML = '<i class="fa-solid fa-broom"></i> Remove Empty Folders...';
        cleanupItem.addEventListener('click', async () => {
            els.contextMenu.classList.remove('visible');
            try { await EL_cleanupEmptyFolders(); } catch (e) {}
        });
        els.contextMenu.appendChild(cleanupItem);

        // Divider
        const divider = document.createElement('div');
        divider.className = 'context-divider';
        els.contextMenu.appendChild(divider);

        // Delete Folder
        const deleteFolderItem = document.createElement('div');
        deleteFolderItem.className = 'context-item';
        deleteFolderItem.innerHTML = '<i class="fa-solid fa-trash"></i> Delete Folder';
        deleteFolderItem.style.color = 'var(--danger-color)';
        deleteFolderItem.addEventListener('click', () => {
            els.contextMenu.classList.remove('visible');
            deleteFolder(targetId);
        });
        els.contextMenu.appendChild(deleteFolderItem);
    } else if (targetType === 'lorebook') {
        const bookName = targetId;

        const openItem = document.createElement('div');
        openItem.className = 'context-item';
        openItem.innerHTML = '<i class="fa-solid fa-book-open"></i> Open';
        openItem.addEventListener('click', () => {
            els.contextMenu.classList.remove('visible');
            openLorebook(bookName);
        });
        els.contextMenu.appendChild(openItem);

        const exportItem = document.createElement('div');
        exportItem.className = 'context-item';
        exportItem.innerHTML = '<i class="fa-solid fa-download"></i> Export (.json)';
        exportItem.addEventListener('click', () => {
            els.contextMenu.classList.remove('visible');
            EL_exportLorebook(bookName);
        });
        els.contextMenu.appendChild(exportItem);

        const renameItem = document.createElement('div');
        renameItem.className = 'context-item';
        renameItem.innerHTML = '<i class="fa-solid fa-pencil"></i> Rename...';
        renameItem.addEventListener('click', () => {
            els.contextMenu.classList.remove('visible');
            EL_renameLorebook(bookName);
        });
        els.contextMenu.appendChild(renameItem);

        const cleanupLbItem = document.createElement('div');
        cleanupLbItem.className = 'context-item';
        cleanupLbItem.innerHTML = '<i class="fa-solid fa-broom"></i> Remove Empty Folders...';
        cleanupLbItem.addEventListener('click', async () => {
            els.contextMenu.classList.remove('visible');
            try { await EL_cleanupEmptyFolders(bookName); } catch (e) {}
        });
        els.contextMenu.appendChild(cleanupLbItem);

        const dividerLb = document.createElement('div');
        dividerLb.className = 'context-divider';
        els.contextMenu.appendChild(dividerLb);

        const deleteItem = document.createElement('div');
        deleteItem.className = 'context-item';
        deleteItem.innerHTML = '<i class="fa-solid fa-trash"></i> Delete...';
        deleteItem.style.color = 'var(--danger-color)';
        deleteItem.addEventListener('click', () => {
            els.contextMenu.classList.remove('visible');
            EL_deleteLorebook(bookName);
        });
        els.contextMenu.appendChild(deleteItem);
    } else if (targetType === 'template') {
        const tName = targetId;

        const applyItem = document.createElement('div');
        applyItem.className = 'context-item';
        applyItem.innerHTML = '<i class="fa-solid fa-check"></i> Apply (replace)';
        applyItem.addEventListener('click', () => {
            els.contextMenu.classList.remove('visible');
            if (confirm(`Apply template '${tName}'? This will replace your currently active global lorebooks.`)) {
                applyTemplate(tName, 'replace');
            }
        });
        els.contextMenu.appendChild(applyItem);

        const addItem = document.createElement('div');
        addItem.className = 'context-item';
        addItem.innerHTML = '<i class="fa-solid fa-plus"></i> Add to current';
        addItem.addEventListener('click', () => {
            els.contextMenu.classList.remove('visible');
            applyTemplate(tName, 'add');
        });
        els.contextMenu.appendChild(addItem);

        const renameTplItem = document.createElement('div');
        renameTplItem.className = 'context-item';
        renameTplItem.innerHTML = '<i class="fa-solid fa-pencil"></i> Rename...';
        renameTplItem.addEventListener('click', () => {
            els.contextMenu.classList.remove('visible');
            EL_renameTemplate(tName);
        });
        els.contextMenu.appendChild(renameTplItem);

        const dividerTpl = document.createElement('div');
        dividerTpl.className = 'context-divider';
        els.contextMenu.appendChild(dividerTpl);

        const deleteTplItem = document.createElement('div');
        deleteTplItem.className = 'context-item';
        deleteTplItem.innerHTML = '<i class="fa-solid fa-trash"></i> Delete';
        deleteTplItem.style.color = 'var(--danger-color)';
        deleteTplItem.addEventListener('click', () => {
            els.contextMenu.classList.remove('visible');
            if (confirm(`Delete template '${tName}'?`)) {
                delete extensionSettings.templates[tName];
                saveSettings();
                renderTemplatesList();
            }
        });
        els.contextMenu.appendChild(deleteTplItem);
    }

    els.contextMenu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
    els.contextMenu.style.top = `${Math.min(y, window.innerHeight - 240)}px`;
    els.contextMenu.classList.add('visible');
}

function showSendToLorebookMenu(_x, _y, type, targetIds) {
    els.contextMenu.classList.remove('visible');

    const allBooks = stContext.getWorldInfoNames();
    const otherBooks = allBooks.filter(name => name !== currentLorebookName);

    const overlay = document.createElement('div');
    overlay.className = 'modal active';
    overlay.id = 'send-lorebook-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content glass-panel';
    content.style.width = '420px';

    content.innerHTML = `
        <div class="modal-header">
            <h3><i class="fa-solid fa-share-from-square" style="margin-right: 8px;"></i>Send to Lorebook</h3>
            <button class="close-modal"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="modal-body">
            <div style="display:flex; gap:24px; margin-bottom:14px;">
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:0.9rem;">
                    <input type="radio" name="send-lorebook-action" value="copy" checked> Copy
                </label>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:0.9rem;">
                    <input type="radio" name="send-lorebook-action" value="move"> Move
                </label>
            </div>
            <p style="margin-bottom:10px; color:var(--text-muted); font-size:0.85rem;">
                ${type === 'entry' ? `Sending <strong>${targetIds.length}</strong> entr${targetIds.length === 1 ? 'y' : 'ies'}` : `Sending <strong>${targetIds.length}</strong> folder${targetIds.length === 1 ? '' : 's'}`} to:
            </p>
            <div class="searchable-folder-picker">
                <div class="folder-picker-search-wrapper">
                    <i class="fa-solid fa-search"></i>
                    <input type="text" placeholder="Search lorebooks..." class="folder-picker-search" id="send-lorebook-search">
                </div>
                <div class="folder-picker-list" id="send-lorebook-list" style="max-height:280px;"></div>
            </div>
        </div>
    `;

    overlay.appendChild(content);
    document.body.appendChild(overlay);
    EL_modalOpen(overlay);

    const searchInput = content.querySelector('#send-lorebook-search');
    const listContainer = content.querySelector('#send-lorebook-list');

    async function executeSend(targetBook) {
        const actionRadio = content.querySelector('input[name="send-lorebook-action"]:checked');
        const isMove = actionRadio && actionRadio.value === 'move';
        const verb = isMove ? 'Moved' : 'Copied';
        let transferMoved = 0;
        let transferFailed = 0;

        if (type === 'entry') {
            // Capture URLs before move so target respects folder path (extension-only)
            const urlMap = new Map();
            if (window.ELFolderUrl) {
                for (const uid of targetIds) {
                    try { urlMap.set(String(uid), window.ELFolderUrl.getUrlForUid(uid, currentLorebookName)); } catch {}
                }
            }
            // Track new UIDs per old UID for folder assignment
            const uidRemap = new Map();
            for (const uid of targetIds) {
                const beforeData = await ELG_loadFresh(targetBook);
                const beforeKeys = new Set(Object.keys(beforeData?.entries || {}));
                let moved = false;
                try {
                    moved = await moveWorldInfoEntry(currentLorebookName, targetBook, uid, { deleteOriginal: isMove });
                } catch (e) {
                    EL_error('executeSend move failed', { uid, targetBook, error: e && e.message });
                    transferFailed += 1;
                    continue;
                }
                if (!moved) {
                    transferFailed += 1;
                    continue;
                }
                transferMoved += 1;
                // Find new UID in target
                let newUid = null;
                try {
                    const afterData = await ELG_loadFresh(targetBook);
                    for (const k of Object.keys(afterData?.entries || {})) if (!beforeKeys.has(k)) { newUid = k; break; }
                } catch {}
                if (newUid !== null) uidRemap.set(String(uid), String(newUid));
                if (isMove) {
                    const folders = extensionSettings.folders[currentLorebookName] || [];
                    folders.forEach(f => f.entries = f.entries.filter(e => String(e) !== String(uid)));
                }
            }
            // Assign each new entry in target book to same folder path as source URL
            if (window.ELFolderUrl && uidRemap.size) {
                if (!extensionSettings.folders[targetBook]) extensionSettings.folders[targetBook] = [];
                for (const [oldUid, newUid] of uidRemap.entries()) {
                    const srcUrl = urlMap.get(String(oldUid));
                    if (!srcUrl) continue;
                    const parsed = window.ELFolderUrl.parseUrl(srcUrl);
                    const path = parsed ? parsed.folderPath : '';
                    try {
                        const folderId = window.ELFolderUrl.ensureFolderByPath(targetBook, path);
                        window.ELFolderUrl.assignEntryToFolderId(newUid, folderId, targetBook);
                    } catch {}
                }
                saveSettings();
            }
            if (isMove) {
                saveSettings();
                const updatedSourceData = await stContext.loadWorldInfo(currentLorebookName);
                currentLorebookData.entries = updatedSourceData.entries;
            } else {
                // Copy also needs save for target folders
                saveSettings();
            }
        } else if (type === 'folder') {
            const targetData = await stContext.loadWorldInfo(targetBook);
            for (const folderId of targetIds) {
                try {
                    const sendResult = await sendFolderToLorebookHelper(folderId, targetBook, targetData, null, isMove);
                    if (sendResult && typeof sendResult.movedCount === 'number') {
                        transferMoved += sendResult.movedCount;
                    }
                } catch (e) {
                    EL_error('executeSend folder failed', { folderId, targetBook, error: e && e.message });
                    transferFailed += 1;
                }
            }
            saveSettings();
            if (isMove) {
                const updatedSourceData = await stContext.loadWorldInfo(currentLorebookName);
                currentLorebookData.entries = updatedSourceData.entries;
            }
        }

        if (typeof showToast === 'function') {
            let summary = verb + ' ' + transferMoved + ' entr' + (transferMoved === 1 ? 'y' : 'ies') + ' to "' + targetBook + '"';
            if (transferFailed > 0) {
                summary += ' (' + transferFailed + ' failed)';
            }
            showToast(summary);
        }

        selectedEntries.clear();
        updateBatchButton();
        renderEntries();
    }

    function renderLorebookList(query = '') {
        listContainer.innerHTML = '';
        const term = query.toLowerCase();
        const filtered = otherBooks.filter(name => name.toLowerCase().includes(term));

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'folder-picker-empty';
            empty.textContent = term ? 'No matching lorebooks' : 'No other lorebooks available';
            listContainer.appendChild(empty);
            return;
        }

        filtered.forEach(name => {
            const item = document.createElement('div');
            item.className = 'folder-picker-item';
            item.innerHTML = `<i class="fa-solid fa-book"></i> ${escapeHtml(name)}`;
            item.addEventListener('click', async () => {
                EL_modalClose(overlay);
                overlay.remove();
                await executeSend(name);
            });
            listContainer.appendChild(item);
        });
    }

    renderLorebookList();

    searchInput.addEventListener('input', () => renderLorebookList(searchInput.value));
    searchInput.addEventListener('keydown', (e) => e.stopPropagation());

    content.querySelector('.close-modal').addEventListener('click', () => { EL_modalClose(overlay); overlay.remove(); });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { EL_modalClose(overlay); overlay.remove(); }
    });

    setTimeout(() => searchInput.focus(), 50);
}

function showFolderSelectMenu(x, y) {
    els.contextMenu.innerHTML = '';
    const folders = extensionSettings.folders[currentLorebookName] || [];

    const searchWrapper = document.createElement('div');
    searchWrapper.style.padding = '6px';
    searchWrapper.style.borderBottom = '1px solid var(--panel-border)';
    searchWrapper.style.marginBottom = '4px';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search folders...';
    searchInput.style.background = 'rgba(0,0,0,0.3)';
    searchInput.style.border = '1px solid var(--panel-border)';
    searchInput.style.color = 'var(--text-color)';
    searchInput.style.padding = '6px 10px';
    searchInput.style.borderRadius = '6px';
    searchInput.style.fontSize = '0.85rem';
    searchInput.style.outline = 'none';
    searchInput.style.width = '100%';
    
    searchWrapper.appendChild(searchInput);
    els.contextMenu.appendChild(searchWrapper);

    const listContainer = document.createElement('div');
    listContainer.className = 'context-menu-list';
    listContainer.style.maxHeight = '240px';
    listContainer.style.overflowY = 'auto';
    listContainer.style.padding = '2px';
    els.contextMenu.appendChild(listContainer);

    function renderList(query = '') {
        listContainer.innerHTML = '';
        const term = query.toLowerCase();

        if ('root (uncategorized)'.includes(term)) {
            const rootItem = document.createElement('div');
            rootItem.className = 'context-item';
            rootItem.innerHTML = '<i></i> Root (Uncategorized)';
            rootItem.addEventListener('click', () => moveToFolder(null));
            listContainer.appendChild(rootItem);
        }

        const filteredFolders = folders.filter(f => {
            const pathName = getFolderPathName(f.id);
            return pathName.toLowerCase().includes(term);
        });

        if (filteredFolders.length > 0) {
            const div = document.createElement('div');
            div.className = 'context-divider';
            listContainer.appendChild(div);
        }

        filteredFolders.forEach(f => {
            const item = document.createElement('div');
            item.className = 'context-item';
            const pathName = getFolderPathName(f.id);
            item.innerHTML = `<i class="fa-solid fa-folder"></i> ${escapeHtml(pathName)}`;
            item.addEventListener('click', () => moveToFolder(f.id));
            listContainer.appendChild(item);
        });
    }

    renderList();

    searchInput.addEventListener('input', (e) => {
        renderList(searchInput.value);
    });

    searchInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
    });

    setTimeout(() => searchInput.focus(), 50);
}

function moveToFolder(folderId) {
    els.contextMenu.classList.remove('visible');

    const folders = extensionSettings.folders[currentLorebookName] || [];
    folders.forEach(f => {
        f.entries = f.entries.filter(uid => !selectedEntries.has(String(uid)));
    });

    if (folderId) {
        const target = folders.find(f => f.id === folderId);
        if (target) {
            target.entries.push(...Array.from(selectedEntries));
        }
    }

    saveSettings();
    renderEntries();
}

let allFoldersExpanded = false;
function toggleAllFolders() {
    const folders = extensionSettings.folders[currentLorebookName] || [];
    if (folders.length === 0) return;

    allFoldersExpanded = !allFoldersExpanded;
    if (allFoldersExpanded) {
        folders.forEach(f => expandedFolders.add(f.id));
    } else {
        expandedFolders.clear();
    }

    try { EL_saveExpandedFolders(); } catch (e) { try { saveSettings(); } catch (_e) {} }
    renderEntries();
}

// ==========================================
// Event Listeners & Utilities
// ==========================================
function setupEventListeners() {
    wirePanelControls();

    // Top buttons
    els.btnCloseApp.addEventListener('click', () => {
        window.close();
    });

    // Sidebar resizing
    const resizer = document.getElementById('sidebar-resizer');
    let isResizing = false;
    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
    });
    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const newWidth = Math.max(250, Math.min(600, e.clientX));
        document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
        extensionSettings.sidebarWidth = newWidth;
    });
    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            resizer.classList.remove('dragging');
            document.body.style.cursor = '';
            saveSettings();
        }
    });

    els.btnSettings.addEventListener('click', openSettings);
    els.btnRefresh.addEventListener('click', refreshSidebar);

    // Auto-refresh (dynamic sync) controls
    const syncEnabledInput = document.getElementById('sync-enabled');
    if (syncEnabledInput) {
        syncEnabledInput.addEventListener('change', () => {
            sync.enabled = syncEnabledInput.checked;
            extensionSettings.sync = extensionSettings.sync || {};
            extensionSettings.sync.enabled = sync.enabled;
            saveSettings();
            if (sync.enabled) startSyncPolling(); else stopSyncPolling();
        });
    }
    const syncIntervalInput = document.getElementById('sync-interval');
    if (syncIntervalInput) {
        syncIntervalInput.addEventListener('change', () => {
            const secs = Math.max(1, Math.min(300, Number(syncIntervalInput.value) || 5));
            syncIntervalInput.value = secs;
            sync.interval = secs * 1000;
            extensionSettings.sync = extensionSettings.sync || {};
            extensionSettings.sync.interval = secs;
            saveSettings();
            if (sync.enabled) startSyncPolling();
        });
    }
    const syncRefreshNow = document.getElementById('sync-refresh-now');
    if (syncRefreshNow) {
        syncRefreshNow.addEventListener('click', async () => {
            await refreshSidebar();
            syncPollTick();
        });
    }
    // Logging prefs (batched + filtered)
    const syncLogLevelInput = document.getElementById('sync-loglevel');
    if (syncLogLevelInput) {
        syncLogLevelInput.addEventListener('change', () => {
            const lvl = String(syncLogLevelInput.value||'INFO').toUpperCase();
            const allowed = ['OFF','ERROR','WARN','INFO','DEBUG'];
            const final = allowed.includes(lvl) ? lvl : 'INFO';
            syncLogLevelInput.value = final;
            extensionSettings.sync = extensionSettings.sync || {};
            extensionSettings.sync.logLevel = final;
            saveSettings();
            try { (window.ELLogger||console).info(`[EL] logLevel → ${final}`); } catch {}
        });
    }
    const syncVerboseInput = document.getElementById('sync-verbose');
    if (syncVerboseInput) {
        syncVerboseInput.addEventListener('change', () => {
            extensionSettings.sync = extensionSettings.sync || {};
            extensionSettings.sync.verbose = !!syncVerboseInput.checked;
            saveSettings();
            try { (window.ELLogger||console).info(`[EL] verbose → ${extensionSettings.sync.verbose}`); } catch {}
        });
    }
    const dragDropInput = document.getElementById('setting-drag-drop');
    if (dragDropInput) {
        dragDropInput.addEventListener('change', () => {
            try {
                extensionSettings.dragAndDrop = !!dragDropInput.checked;
                saveSettings();
                renderEntries();
                EL_toast(extensionSettings.dragAndDrop ? 'Drag-and-drop enabled.' : 'Drag-and-drop disabled.', 'info');
            } catch (e) {}
        });
    }

    // Search Lorebooks
    const searchLorebooksInput = document.getElementById('search-lorebooks');
    if (searchLorebooksInput) {
        searchLorebooksInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            if (!els.listAll) return;
            const items = els.listAll.querySelectorAll('.list-item');
            items.forEach(item => {
                // If it's the "None" placeholder, skip
                if (item.textContent === 'None') return;
                const text = item.textContent.toLowerCase();
                item.style.display = text.includes(term) ? '' : 'none';
            });
        });
    }

    // Templates
    els.btnSaveTemplate.addEventListener('click', () => {
        const stSelect = ST_Window.document.getElementById('world_info');
        if (!stSelect) return;
        const activeGlobals = Array.from(stSelect.selectedOptions).map(opt => opt.text).filter(v => v);

        if (activeGlobals.length === 0) {
            alert('No global lorebooks are currently active!');
            return;
        }

        const name = prompt('Enter a name for this preset:');
        if (!name) return;
        const trimmed = String(name).trim();
        if (!trimmed) {
            EL_toast('Template name cannot be empty.', 'error');
            return;
        }

        if (extensionSettings.templates[trimmed]) {
            if (!confirm(`Template '${trimmed}' already exists. Overwrite?`)) return;
        }

        extensionSettings.templates[trimmed] = activeGlobals;
        saveSettings();
        renderTemplatesList();
        EL_toast(`Template "${trimmed}" saved.`, 'success');
    });

    // Whole-lorebook file operations (sidebar header)
    const btnCreateLorebook = document.getElementById('btn-create-lorebook');
    if (btnCreateLorebook) {
        btnCreateLorebook.addEventListener('click', () => EL_createLorebook());
    }
    const btnImportLorebook = document.getElementById('btn-import-lorebook');
    const importLorebookFile = document.getElementById('import-lorebook-file');
    if (btnImportLorebook && importLorebookFile) {
        btnImportLorebook.addEventListener('click', () => importLorebookFile.click());
        importLorebookFile.addEventListener('change', () => {
            const f = importLorebookFile.files && importLorebookFile.files[0];
            importLorebookFile.value = '';
            if (f) EL_importLorebookFile(f);
        });
    }

    // Template import / export
    const btnExportTemplates = document.getElementById('btn-export-templates');
    if (btnExportTemplates) {
        btnExportTemplates.addEventListener('click', () => EL_exportTemplates());
    }
    const btnImportTemplates = document.getElementById('btn-import-templates');
    const importTemplatesFile = document.getElementById('import-templates-file');
    if (btnImportTemplates && importTemplatesFile) {
        btnImportTemplates.addEventListener('click', () => importTemplatesFile.click());
        importTemplatesFile.addEventListener('change', () => {
            const f = importTemplatesFile.files && importTemplatesFile.files[0];
            importTemplatesFile.value = '';
            if (f) EL_importTemplatesFile(f);
        });
    }

    // Search field scope
    const searchScope = document.getElementById('search-scope');
    if (searchScope) {
        searchScope.addEventListener('change', () => {
            renderEntries();
        });
    }

    // Toolbar
    if (els.btnAddItem) {
        els.btnAddItem.addEventListener('click', () => openAddItemModal(null));
    }

    // Root drop target (un-file entries / un-nest folders) + global drag cleanup
    try { EL_setupRootDrop(); } catch (e) {}
    try {
        document.addEventListener('dragend', () => { try { EL_clearDragHighlights(); } catch (_e) {} });
        document.addEventListener('dragleave', (e) => {
            try {
                if (!e.relatedTarget) EL_clearDragHighlights();
            } catch (_e) {}
        });
        if (!document.__elDndMouseup) {
            document.__elDndMouseup = true;
            document.addEventListener('mouseup', () => {
                try {
                    if (EL_dragPayload) return;
                    if (typeof EL_clearStaleDraggables === 'function') EL_clearStaleDraggables();
                } catch (_e) {}
            });
        }
    } catch (e) {}

    const btnExportLorebook = document.getElementById('btn-export-lorebook');
    if (btnExportLorebook) {
        btnExportLorebook.addEventListener('click', () => EL_exportLorebook(currentLorebookName));
    }
    
    const btnToggleAllFolders = document.getElementById('btn-toggle-all-folders');
    if (btnToggleAllFolders) {
        btnToggleAllFolders.addEventListener('click', toggleAllFolders);
    }

    els.btnBatchOptions.addEventListener('click', openBatchModal);
    if (els.btnDownload) {
        els.btnDownload.addEventListener('click', (e) => {
            e.stopPropagation();
            showDownloadFormatPicker();
        });
    }

    // Backup Watch
    const btnBackupWatch = document.getElementById('btn-backup-watch');
    if (btnBackupWatch) {
        btnBackupWatch.addEventListener('click', () => {
            if (currentLorebookName) openBackupWatchModal();
        });
    }
    wireBackupWatchModalEvents();

    // Search Entries - Auto-toggle Sort mode to Relevance
    let previousSortMode = 'order_desc';
    // Debounce only the render: the sort-mode switch stays immediate, and rendering
    // the whole tree on every keystroke was both slow and selection-destroying.
    let _searchRenderTimer = null;
    const _searchRenderNow = () => { renderEntries(); };
    els.searchEntries.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        const sortSelect = document.getElementById('sort-entries');
        if (query) {
            if (sortSelect.value !== 'search') {
                previousSortMode = sortSelect.value;
                sortSelect.value = 'search';
            }
        } else {
            if (sortSelect.value === 'search') {
                sortSelect.value = previousSortMode;
            }
        }
        if (_searchRenderTimer) clearTimeout(_searchRenderTimer);
        _searchRenderTimer = setTimeout(() => {
            _searchRenderTimer = null;
            _searchRenderNow();
        }, 150);
    });

    const sortEntriesSelect = document.getElementById('sort-entries');
    if (sortEntriesSelect) {
        sortEntriesSelect.addEventListener('change', () => {
            renderEntries();
        });
    }

    if (els.btnDeselectAll) {
        els.btnDeselectAll.addEventListener('click', () => {
            selectedEntries.clear();
            lastClickedEntryUid = null;
            document.querySelectorAll('.entry-card').forEach(c => c.classList.remove('selected'));
            updateBatchButton();
        });
    }

    if (els.btnSelectAll) {
        els.btnSelectAll.addEventListener('click', () => {
            const allUids = Object.keys(currentLorebookData?.entries || {});
            allUids.forEach(uid => selectedEntries.add(String(uid)));
            document.querySelectorAll('.entry-card').forEach(c => c.classList.add('selected'));
            updateBatchButton();
        });
    }

    // Modals
    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal');
            if (modal) {
                EL_modalClose(modal);
                modal.classList.remove('peek-mode');
            }
        });
    });

    // Unified Modal Tab switching
    document.querySelectorAll('#add-item-modal .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#add-item-modal .tab-btn').forEach(b => {
                b.classList.remove('active');
                b.style.color = 'var(--text-muted)';
                b.style.borderBottom = 'none';
            });
            btn.classList.add('active');
            btn.style.color = 'var(--primary-color)';
            btn.style.borderBottom = '2px solid var(--primary-color)';

            const tab = btn.dataset.tab;
            document.getElementById('quick-creation-tab').style.display = tab === 'quick' ? 'flex' : 'none';
            document.getElementById('advanced-creation-tab').style.display = tab === 'advanced' ? 'flex' : 'none';
            document.getElementById('xml-creation-tab').style.display = tab === 'xml' ? 'flex' : 'none';
            document.getElementById('btn-copy-xml-template').style.display = tab === 'xml' ? '' : 'none';
        });
    });

    // Item Type toggle in Quick Creation
    const quickRadios = document.getElementsByName('quick-item-type');
    quickRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const val = e.target.value;
            document.getElementById('quick-entry-fields').style.display = val === 'entry' ? 'flex' : 'none';
            document.getElementById('quick-folder-fields').style.display = val === 'folder' ? 'flex' : 'none';
        });
    });

    // Floating Peek Toggle in Unified Modal
    const btnPeek = document.getElementById('btn-peek-modal');
    if (btnPeek) {
        btnPeek.addEventListener('click', () => {
            const modal = document.getElementById('add-item-modal');
            modal.classList.toggle('peek-mode');
        });
    }

    // Collapsible Advanced Creation Sections
    document.querySelectorAll('.adv-section-header').forEach(header => {
        header.addEventListener('click', (e) => {
            if (e.target.closest('.settings-view-tabs')) return;
            const section = header.closest('.adv-section');
            section.classList.toggle('collapsed');
        });
    });

    // Settings View switching in Advanced creation view
    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const view = btn.dataset.sview;
            document.getElementById('adv-settings-general').style.display = view === 'general' ? 'flex' : 'none';
            document.getElementById('adv-settings-individual').style.display = view === 'individual' ? 'flex' : 'none';
            if (view === 'individual') {
                updateIndividualVariablesList();
            }
        });
    });

    // Add row button in Advanced Excel view
    document.getElementById('btn-adv-add-row').addEventListener('click', () => {
        addNewExcelRow();
    });

    // Individual Settings Form listeners
    setupIndividualFormListeners();

    // Add Item Parent Search
    const addItemParentSearch = document.getElementById('add-item-parent-search');
    if (addItemParentSearch) {
        addItemParentSearch.addEventListener('input', (e) => {
            renderAddItemParentFolderList(e.target.value);
        });
        addItemParentSearch.addEventListener('keydown', (e) => {
            e.stopPropagation();
        });
    }

    // Confirm add item
    document.getElementById('btn-add-item-create').addEventListener('click', createItems);
    document.getElementById('btn-add-item-cancel').addEventListener('click', closeAddItemModal);
    document.getElementById('btn-copy-xml-template').addEventListener('click', copyXmlTemplate);

    // Settings Color Pickers
    ['bg', 'panel', 'text', 'primary'].forEach(key => {
        document.getElementById(`color-${key}`).addEventListener('input', (e) => {
            updateColor(key, `--${key === 'primary' ? 'primary-color' : (key === 'text' ? 'text-color' : (key === 'bg' ? 'bg-color' : 'panel-bg'))}`, e.target.value);
        });
    });

    document.getElementById('btn-reset-colors').addEventListener('click', () => {
        delete extensionSettings.colors;
        saveSettings();
        applyColors();
        openSettings();
    });

    // Batch Edit
    document.getElementById('btn-apply-batch').addEventListener('click', applyBatchOptions);
    document.getElementById('btn-batch-preview-confirm').addEventListener('click', EL_batchConfirmApply);
    document.getElementById('btn-batch-preview-back').addEventListener('click', () => EL_modalClose(document.getElementById('batch-preview-modal')));
    const btnBatchUndo = document.getElementById('btn-batch-undo');
    if (btnBatchUndo) btnBatchUndo.addEventListener('click', EL_batchUndoBatch);

    // Theme mode
    const themeModeSelect = document.getElementById('setting-theme-mode');
    if (themeModeSelect) {
        themeModeSelect.addEventListener('change', () => {
            extensionSettings.themeMode = themeModeSelect.value;
            saveSettings();
            applyColors();
        });
    }

    // Edit Entry
    document.getElementById('btn-save-edit-entry').addEventListener('click', saveEditedEntry);

    // Mutual exclusivity between Constant and Vectorized checkboxes
    function mutualExclusive(id1, id2) {
        const el1 = document.getElementById(id1);
        const el2 = document.getElementById(id2);
        if (el1 && el2) {
            el1.addEventListener('change', () => { if (el1.checked) el2.checked = false; });
            el2.addEventListener('change', () => { if (el2.checked) el1.checked = false; });
        }
    }
    mutualExclusive('edit-constant', 'edit-vectorized');
    mutualExclusive('quick-entry-constant', 'quick-entry-vectorized');
    mutualExclusive('g-constant', 'g-vectorized');
    mutualExclusive('ind-constant', 'ind-vectorized');
    mutualExclusive('batch-constant-val', 'batch-vectorized-val');
    mutualExclusive('xml-constant', 'xml-vectorized');

    // Agent sidebar routing
    const navDashboard = document.getElementById('nav-agent-dashboard');
    if (navDashboard) {
        navDashboard.addEventListener('click', function () { switchToView('agent-dashboard'); });
    }

    const navFeed = document.getElementById('nav-agent-feed');
    if (navFeed) {
        navFeed.addEventListener('click', function () { switchToView('agent-feed'); });
    }

    const navChat = document.getElementById('nav-agent-chat');
    if (navChat) {
        navChat.addEventListener('click', function () { switchToView('agent-chat'); });
    }

    const navRecovery = document.getElementById('nav-recovery');
    if (navRecovery) {
        navRecovery.addEventListener('click', function () { switchToView('recovery'); });
    }

    // Recovery sub-tab routing
    document.querySelectorAll('.pill-btn[data-recovery-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.pill-btn[data-recovery-tab]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentRecoveryTab = btn.dataset.recoveryTab;
            renderRecoveryTab();
        });
    });

    // Global copy/paste that respects folder URL (Ctrl+C / Ctrl+V)
    // Intentionally ignored when an input/textarea/contenteditable is focused so ST native clipboard is untouched
    function EL_isInputFocused() {
        const el = document.activeElement;
        if (!el) return false;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        if (el.isContentEditable) return true;
        // Also ignore when editing inside a modal's form
        if (el.closest && el.closest('.modal.active')) {
            // Allow copy/paste inside modals to behave normally; don't hijack
            return true;
        }
        return false;
    }
    document.addEventListener('keydown', (e) => {
        const isMod = e.ctrlKey || e.metaKey;
        if (!isMod) return;
        const key = (e.key || '').toLowerCase();
        if (key === 'c' && !EL_isInputFocused() && selectedEntries.size > 0 && currentViewMode === 'lorebook' && currentLorebookName) {
            // Let native copy still happen for system clipboard, but also capture URL-aware
            EL_copySelectedEntries();
            // Do not preventDefault — allow native copy to also succeed for fallback
        } else if (key === 'v' && !EL_isInputFocused() && currentViewMode === 'lorebook' && currentLorebookName) {
            const hasClip = EL_clipboard && Array.isArray(EL_clipboard.items) && EL_clipboard.items.length > 0;
            if (!hasClip) return;
            e.preventDefault();
            EL_pasteEntries(null, currentLorebookName);
        }
    });
}

function switchToView(view) {
    currentViewMode = view;
    els.entriesContainer.classList.add('hidden');
    document.querySelectorAll('.agent-sidebar-item').forEach(i => i.classList.remove('active'));
    els.mainToolbar.style.display = 'none';

    const dashboardPanel = document.getElementById('agent-dashboard-panel');
    const configPanel = document.getElementById('agent-config-panel');
    const feedPanel = document.getElementById('agent-feed-panel');
    const recoveryPanel = document.getElementById('recovery-panel');
    const chatPanel = document.getElementById('agent-chat-panel');
    if (dashboardPanel) dashboardPanel.classList.add('hidden');
    if (configPanel) configPanel.classList.add('hidden');
    if (feedPanel) feedPanel.classList.add('hidden');
    if (recoveryPanel) recoveryPanel.classList.add('hidden');
    if (chatPanel) chatPanel.classList.add('hidden');

    if (view === 'agent-dashboard') {
        const nav = document.getElementById('nav-agent-dashboard');
        if (nav) nav.classList.add('active');
        if (dashboardPanel) dashboardPanel.classList.remove('hidden');
        els.currentTitle.textContent = 'Agent Dashboard';
        if (typeof renderDashboard === 'function') {
            renderDashboard();
        }
    } else if (view === 'agent-config') {
        const nav = document.getElementById('nav-agent-config');
        if (nav) nav.classList.add('active');
        if (configPanel) configPanel.classList.remove('hidden');
        els.currentTitle.textContent = 'Agent Configuration';
        if (typeof openAgentConfig === 'function') {
            openAgentConfig(activeAgentId || null);
        }
    } else if (view === 'agent-feed') {
        const nav = document.getElementById('nav-agent-feed');
        if (nav) nav.classList.add('active');
        if (feedPanel) feedPanel.classList.remove('hidden');
        els.currentTitle.textContent = 'Agent Feed';
        if (typeof loadProposalsForCurrentChat === 'function') {
            loadProposalsForCurrentChat();
        }
    } else if (view === 'recovery') {
        const nav = document.getElementById('nav-recovery');
        if (nav) nav.classList.add('active');
        const recoveryPanel = document.getElementById('recovery-panel');
        if (recoveryPanel) recoveryPanel.classList.remove('hidden');
        els.currentTitle.textContent = 'Recovery';
        renderRecovery();
    } else if (view === 'agent-chat') {
        const nav = document.getElementById('nav-agent-chat');
        if (nav) nav.classList.add('active');
        const chatPanel = document.getElementById('agent-chat-panel');
        if (chatPanel) chatPanel.classList.remove('hidden');
        els.currentTitle.textContent = 'Agent Chat';
        if (typeof initAgentChatPanel === 'function') initAgentChatPanel();
        if (typeof renderAgentChat === 'function') renderAgentChat();
    }
}

let _elPeriodicRunning = false;
async function handlePeriodicTriggerFromHost(msg) {
    if (_elPeriodicRunning) return;
    if (typeof agentManager === 'undefined' || !agentManager) return;
    const ids = Array.isArray(msg?.agentIds) && msg.agentIds.length ? msg.agentIds : null;
    const candidates = ids
        ? ids.map(id => agentManager.getAgent(id)).filter(a => a && a.enabled && a.mode === 'periodic')
        : agentManager.getAgents().filter(a => a && a.enabled && a.mode === 'periodic');
    if (!candidates.length) return;
    _elPeriodicRunning = true;
    try {
        for (const agent of candidates) {
            try {
                if (typeof agentManager.isActiveForChat === 'function' && !agentManager.isActiveForChat(agent, stContext)) continue;
                if (typeof EL_isHubReady === 'function' && !EL_isHubReady()) {
                    try { (window.ELLogger || console).warn('[EL:Periodic] hub unavailable, skipping', agent?.id); } catch {}
                    continue;
                }
                await agentManager.runAgent(agent.id, { label: `lorebook-periodic:${agent?.name || agent?.id}` });
            } catch (e) {
                try { (window.ELLogger || console).warn('[EL:Periodic] agent run failed', agent?.id, e); } catch {}
            }
        }
        try {
            if (typeof loadProposalsForCurrentChat === 'function') await loadProposalsForCurrentChat();
            if (typeof renderDashboard === 'function') renderDashboard();
            if (typeof renderAgentSidebar === 'function') renderAgentSidebar();
        } catch {}
    } finally {
        _elPeriodicRunning = false;
    }
}

// ==========================================
// Recovery (Trash / Snapshots / Audit)
// ==========================================
let currentRecoveryTab = 'trash';

function renderRecovery() {
    const nameEl = document.getElementById('recovery-book-name');
    if (nameEl) {
        nameEl.textContent = currentLorebookName || 'No lorebook open';
    }
    document.querySelectorAll('.pill-btn[data-recovery-tab]').forEach(b => {
        b.classList.toggle('active', b.dataset.recoveryTab === currentRecoveryTab);
    });
    renderRecoveryTab();
}

async function renderRecoveryTab() {
    const container = document.getElementById('recovery-content');
    const toolbar = document.getElementById('recovery-toolbar');
    if (!container) return;
    container.innerHTML = '';
    if (toolbar) toolbar.innerHTML = '';

    if (!currentLorebookName) {
        container.innerHTML = '<div class="empty-state" style="padding:40px 0;"><i class="fa-solid fa-book fa-3x"></i><p>Open a lorebook from the sidebar to manage its deleted entries and backups.</p></div>';
        return;
    }

    try {
        if (currentRecoveryTab === 'trash') {
            await renderRecoveryTrash(container, toolbar);
        } else if (currentRecoveryTab === 'snapshots') {
            await renderRecoverySnapshots(container, toolbar);
        } else if (currentRecoveryTab === 'backups') {
            await renderRecoveryBackups(container, toolbar);
        } else if (currentRecoveryTab === 'audit') {
            await renderRecoveryAudit(container, toolbar);
        }
    } catch (e) {
        console.error('Recovery render failed', e);
        container.innerHTML = '<div class="empty-state" style="padding:40px 0;"><p>Failed to load: ' + escapeHtml(e.message) + '</p></div>';
    }
}

function formatRecoveryTime(ts) {
    if (!ts) return 'unknown time';
    try {
        const d = new Date(ts);
        return d.toLocaleString();
    } catch {
        return String(ts);
    }
}

function renderEmptyRecovery(container, text) {
    container.innerHTML = `<div class="empty-state" style="padding:40px 0;"><i class="fa-solid fa-box-open fa-3x"></i><p>${escapeHtml(text)}</p></div>`;
}

async function renderRecoveryTrash(container, toolbar) {
    const book = currentLorebookName;
    const trash = await ELG_listTrash(book);

    if (trash.length === 0) {
        renderEmptyRecovery(container, 'No deleted entries. Anything removed from now on will be kept here for recovery.');
        return;
    }

    toolbar.innerHTML = `
        <button id="recovery-trash-restore-all" class="btn btn-sm" style="background:var(--success-color,#10b981); color:#fff;"><i class="fa-solid fa-arrow-rotate-left"></i> Restore All</button>
        <button id="recovery-trash-empty" class="btn btn-sm" style="background:var(--danger-color,#ef4444); color:#fff;"><i class="fa-solid fa-trash-can"></i> Empty Trash</button>
        <span style="flex:1;"></span>
        <span style="font-size:0.85rem; color:var(--text-muted);">${trash.length} deleted entr${trash.length === 1 ? 'y' : 'ies'}</span>
    `;

    container.innerHTML = trash.map((t, idx) => `
        <div class="recovery-trash-item" style="display:flex; align-items:flex-start; gap:12px; background:rgba(0,0,0,0.15); border:1px solid var(--panel-border); border-radius:8px; padding:10px 12px; margin-bottom:8px;">
            <input type="checkbox" class="recovery-trash-check" data-uid="${escapeHtml(t.uid)}" style="margin-top:4px;">
            <div style="flex:1; min-width:0;">
                <div style="font-weight:600; font-size:0.9rem; word-break:break-word;">${escapeHtml(t.entry?.comment || '(no comment)')}</div>
                <div style="font-size:0.78rem; color:var(--text-muted); margin-top:4px; display:flex; flex-wrap:wrap; gap:10px;">
                    ${t.entry?.key?.length ? `<span><i class="fa-solid fa-key"></i> ${escapeHtml(t.entry.key.join(', '))}</span>` : ''}
                    <span><i class="fa-solid fa-clock"></i> Deleted ${formatRecoveryTime(t.deletedAt)}</span>
                    <span><i class="fa-solid fa-tag"></i> ${escapeHtml(t.source || 'unknown')}</span>
                </div>
                <div style="font-size:0.78rem; color:var(--text-muted); margin-top:4px; max-height:60px; overflow:hidden; white-space:pre-wrap; word-break:break-word;">${escapeHtml((t.entry?.content || '').slice(0, 300))}</div>
            </div>
            <div style="display:flex; flex-direction:column; gap:6px;">
                <button class="btn btn-secondary btn-sm recovery-trash-restore" data-id="${escapeHtml(t.id)}"><i class="fa-solid fa-arrow-rotate-left"></i> Restore</button>
                <button class="btn btn-danger btn-sm recovery-trash-delete" data-id="${escapeHtml(t.id)}" style="background:rgba(239,68,68,0.15);color:#ef4444;"><i class="fa-solid fa-xmark"></i> Delete</button>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.recovery-trash-restore').forEach(btn => {
        btn.addEventListener('click', () => restoreTrashEntries([btn.dataset.id], container));
    });
    container.querySelectorAll('.recovery-trash-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (confirm('Permanently delete this entry from Trash? This cannot be undone.')) {
                await ELG_deleteTrashByIds(book, [btn.dataset.id]);
                renderRecoveryTab();
            }
        });
    });

    const restoreAllBtn = toolbar.querySelector('#recovery-trash-restore-all');
    if (restoreAllBtn) {
        restoreAllBtn.addEventListener('click', () => {
            const allIds = trash.map(t => String(t.id));
            restoreTrashEntries(allIds, container);
        });
    }
    const emptyBtn = toolbar.querySelector('#recovery-trash-empty');
    if (emptyBtn) {
        emptyBtn.addEventListener('click', async () => {
            if (confirm(`Permanently delete all ${trash.length} entries from Trash? This cannot be undone.`)) {
                await ELG_deleteTrashByIds(book, trash.map(t => String(t.id)));
                renderRecoveryTab();
            }
        });
    }
}

async function restoreTrashEntries(ids, container) {
    const book = currentLorebookName;
    if (!book || !ids || !ids.length) return;

    // 1. PEEK — read the records WITHOUT consuming them.
    let restoring = [];
    try { restoring = await ELG_restoreTrash(book, ids); } catch (e) { restoring = []; }
    if (!restoring.length) {
        if (typeof showToast === 'function') showToast('Nothing restored');
        return;
    }

    // 2. Load authoritative data, re-insert with fresh uids (keep the existing
    //    getFreeWorldEntryUid / structuredClone logic and the folder re-link).
    const fresh = await ELG_loadFresh(book);
    if (!fresh || !fresh.entries) {
        if (typeof showToast === 'function') showToast('Could not load lorebook to restore into');
        return;
    }

    const insertedIds = [];   // trash record ids we actually inserted
    const folderChanges = []; // { folderId, uid } applied, for rollback
    for (const t of restoring) {
        const newUid = getFreeWorldEntryUid(fresh);
        if (newUid === null) continue;
        const entry = structuredClone(t.entry || {});
        entry.uid = newUid;
        fresh.entries[newUid] = entry;
        insertedIds.push(String(t.id));
        if (t.folderId) {
            const folders = extensionSettings.folders[book] || [];
            const folder = folders.find(f => f.id === t.folderId);
            if (folder && !folder.entries.map(String).includes(String(newUid))) {
                folder.entries.push(String(newUid));
                folderChanges.push({ folderId: t.folderId, uid: String(newUid) });
            }
        }
    }
    if (!insertedIds.length) {
        if (typeof showToast === 'function') showToast('Nothing restored');
        return;
    }

    // 3. Save. Only consume the trash records AFTER the save is confirmed.
    const ok = await ELG_guardSave(book, fresh, { explicitDelete: false, source: 'user', note: 'Restore ' + insertedIds.length + ' entr' + (insertedIds.length === 1 ? 'y' : 'ies') + ' from Trash' });

    if (!ok) {
        // Roll back the in-memory folder changes; the entries stay in Trash.
        const folders = extensionSettings.folders[book] || [];
        for (const ch of folderChanges) {
            const folder = folders.find(f => f.id === ch.folderId);
            if (folder) folder.entries = folder.entries.filter(e => String(e) !== String(ch.uid));
        }
        if (typeof showToast === 'function') showToast('Restore failed — the entries are still in Trash.');
        renderRecoveryTab();
        return;
    }

    // 4. Consume exactly the records we restored. If this fails the entries are
    //    safely on disk AND still in Trash — say so rather than claiming a clean
    //    restore (they would otherwise reappear in the Trash list).
    let consumed = true;
    try { await ELG_deleteTrashByIds(book, insertedIds); } catch (e) { consumed = false; }
    if (folderChanges.length) saveSettings();

    if (typeof showToast === 'function') {
        if (consumed) {
            showToast(`Restored ${insertedIds.length} entr${insertedIds.length === 1 ? 'y' : 'ies'}`);
        } else {
            showToast(`Restored ${insertedIds.length} entr${insertedIds.length === 1 ? 'y' : 'ies'} — but they could not be removed from Trash, so they still appear there.`);
        }
    }
    EL_setLorebookData(fresh, { own: true });
    renderRecoveryTab();
    if (currentViewMode === 'lorebook') renderEntries();
}

async function renderRecoverySnapshots(container, toolbar) {
    const book = currentLorebookName;
    const snapshots = await ELG_listSnapshots(book);

    if (snapshots.length === 0) {
        renderEmptyRecovery(container, 'No snapshots yet. Every save now creates a snapshot automatically, so this list will grow as you work.');
        return;
    }

    toolbar.innerHTML = `<span style="font-size:0.85rem; color:var(--text-muted);">${snapshots.length} snapshots — kept for 90 days / last 50 per lorebook</span>`;

    container.innerHTML = snapshots.map(s => `
        <div style="display:flex; align-items:center; gap:12px; background:rgba(0,0,0,0.15); border:1px solid var(--panel-border); border-radius:8px; padding:10px 12px; margin-bottom:8px;">
            <i class="fa-solid fa-camera" style="opacity:0.6;"></i>
            <div style="flex:1;">
                <div style="font-weight:600; font-size:0.9rem;">${formatRecoveryTime(s.timestamp)}</div>
                <div style="font-size:0.78rem; color:var(--text-muted);">${escapeHtml(s.id)}</div>
            </div>
            <button class="btn btn-secondary btn-sm recovery-snapshot-restore" data-id="${escapeHtml(s.id)}"><i class="fa-solid fa-arrow-rotate-left"></i> Restore</button>
            <button class="btn btn-danger btn-sm recovery-snapshot-delete" data-id="${escapeHtml(s.id)}" style="background:rgba(239,68,68,0.15);color:#ef4444;"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `).join('');

    container.querySelectorAll('.recovery-snapshot-restore').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm(`Restore snapshot from ${formatRecoveryTime(btn.dataset.id.replace('snap_', ''))}? Entries and folder URLs will be restored; current differing entries go to Trash.`)) return;
            try {
                const result = await ELG_restoreSnapshot(btn.dataset.id, book);
                if (!result?.lorebookData) {
                    if (typeof showToast === 'function') showToast('Snapshot not found');
                    return;
                }
                // Extension-only URL-respecting restore: folders sidecar first (if snapshot has them)
                const foldersSnapshot = Array.isArray(result.folders) ? result.folders : null;
                const hasFolders = Array.isArray(foldersSnapshot) && foldersSnapshot.length > 0;
                let folderSnapshotBefore = null;
                try { folderSnapshotBefore = window.ELFolderUrl ? window.ELFolderUrl.getFoldersSnapshot(book) : null; } catch {}
                // Set entries in memory so folder prune can see them
                EL_setLorebookData(result.lorebookData, { own: true });
                if (hasFolders && window.ELFolderUrl) {
                    try { window.ELFolderUrl.restoreFoldersWithRemap(book, foldersSnapshot, null); } catch {}
                    try { saveSettings(); } catch {}
                }
                const ok = await ELG_guardSave(book, result.lorebookData, { explicitDelete: true, source: 'user', note: 'Restore snapshot ' + btn.dataset.id });
                if (!ok) {
                    try { if (folderSnapshotBefore !== null && window.ELFolderUrl) window.ELFolderUrl.setFoldersSnapshot(book, folderSnapshotBefore); } catch {}
                    try { saveSettings(); } catch {}
                    if (typeof showToast === 'function') showToast('Restore blocked or failed — nothing was written.');
                    return;
                }
                if (typeof showToast === 'function') showToast(hasFolders ? 'Snapshot restored (folders URL-respected)' : 'Snapshot restored');
                renderRecoveryTab();
                if (currentViewMode === 'lorebook') renderEntries();
            } catch (e) {
                if (typeof showToast === 'function') showToast('Restore failed: ' + e.message);
            }
        });
    });
    container.querySelectorAll('.recovery-snapshot-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (confirm('Delete this snapshot permanently?')) {
                await ELG_deleteSnapshot(btn.dataset.id, book);
                renderRecoveryTab();
            }
        });
    });
}

async function renderRecoveryAudit(container, toolbar) {
    const book = currentLorebookName;
    const entries = await ELG_listAudit(book);

    if (entries.length === 0) {
        renderEmptyRecovery(container, 'No audit records yet. Every guarded save is logged here.');
        return;
    }

    toolbar.innerHTML = `<span style="font-size:0.85rem; color:var(--text-muted);">${entries.length} events (newest first)</span>`;

    container.innerHTML = `<table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
        <thead>
            <tr style="text-align:left; color:var(--text-muted); border-bottom:1px solid var(--panel-border);">
                <th style="padding:6px 8px;">Time</th>
                <th style="padding:6px 8px;">Action</th>
                <th style="padding:6px 8px;">Source</th>
                <th style="padding:6px 8px;">Details</th>
            </tr>
        </thead>
        <tbody>
            ${entries.map(e => `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.06); vertical-align:top;">
                    <td style="padding:6px 8px; white-space:nowrap;">${formatRecoveryTime(e.ts)}</td>
                    <td style="padding:6px 8px; font-weight:600;">${escapeHtml(e.action || '')}</td>
                    <td style="padding:6px 8px;">${escapeHtml(e.source || '')}</td>
                    <td style="padding:6px 8px; word-break:break-word;">
                        ${e.note ? `<div style="color:var(--text-muted);">${escapeHtml(e.note)}</div>` : ''}
                        ${e.removed?.length ? `<div style="color:var(--danger-color,#ef4444);">Removed: ${e.removed.map(r => escapeHtml(r.comment || r.uid)).join('; ')}</div>` : ''}
                        ${e.added?.length ? `<div style="color:var(--success-color,#10b981);">Added: ${e.added.map(r => escapeHtml(r.comment || r.uid)).join('; ')}</div>` : ''}
                        ${e.changedCount ? `<div>Changed: ${e.changedCount}</div>` : ''}
                    </td>
                </tr>
            `).join('')}
        </tbody>
    </table>`;
}

function escapeHtml(unsafe) {
    return (unsafe || '').toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ==========================================
// Backup Watch
// ==========================================

function closeModalById(id) {
    const modal = document.getElementById(id);
    if (modal) {
        EL_modalClose(modal);
        modal.classList.remove('peek-mode');
    }
}

function getBackupWatchEntryLabel(entry) {
    if (!entry) return '(unknown entry)';
    const label = [];
    if (entry.comment) label.push(entry.comment);
    if (Array.isArray(entry.key) && entry.key.length) label.push(`Keys: ${entry.key.join(', ')}`);
    if (!label.length && entry.content) {
        const firstLine = String(entry.content).split(/\r?\n/).filter(l => l.trim())[0];
        if (firstLine) label.push(firstLine.slice(0, 80));
    }
    return label.join(' — ') || `UID ${entry.uid ?? '?'}`;
}

async function openBackupWatchModal() {
    if (!currentLorebookName) {
        if (typeof showToast === 'function') showToast('Open a lorebook first');
        return;
    }
    const modal = document.getElementById('backup-watch-modal');
    if (!modal) return;
    const nameEl = document.getElementById('backup-watch-book-name');
    if (nameEl) nameEl.textContent = currentLorebookName;

    document.querySelectorAll('input[name="backup-watch-mode"]').forEach(r => r.checked = r.value === 'simple');
    const detail = document.getElementById('backup-watch-auto-detail');
    if (detail) detail.style.display = 'none';

    await refreshBackupWatchStatus();

    modal.classList.remove('peek-mode');
    EL_modalOpen(modal);
}

async function refreshBackupWatchStatus() {
    const statusEl = document.getElementById('backup-watch-status');
    const removeBtn = document.getElementById('btn-backup-watch-remove');
    const confirmBtn = document.getElementById('btn-backup-watch-confirm');
    if (!statusEl) return;

    let status;
    try {
        status = await EL_apiFetch('GET', '/backup-watch/status?lorebookName=' + encodeURIComponent(currentLorebookName));
    } catch (e) {
        statusEl.innerHTML = '<span style="color:var(--danger-color,#ef4444);">Failed to load status: ' + escapeHtml(e.message) + '</span>';
        return;
    }

    let summary = '';
    try {
        const list = await EL_apiFetch('GET', '/backup-watch/list?lorebookName=' + encodeURIComponent(currentLorebookName));
        const auto = (list?.backups || []).filter(b => b.kind === 'auto').length;
        const simple = (list?.backups || []).filter(b => b.kind === 'simple').length;
        summary = `<div style="margin-top:6px;">${list.count} existing backup(s) — <span style="color:var(--text-color);">${auto} automatic</span> / ${simple} simple</div>`;
    } catch (_) {}

    if (status?.watched) {
        const last = status.lastBackupAt ? new Date(status.lastBackupAt).toLocaleString() : '—';
        const next = status.nextBackupAt ? new Date(status.nextBackupAt).toLocaleString() : '—';
        statusEl.innerHTML = `<div><i class="fa-solid fa-circle-check" style="color:var(--success-color,#10b981);"></i> <b>Automatic watch active</b></div>
            <div style="margin-top:4px;">Last automatic copy: ${escapeHtml(last)}</div>
            <div>Next automatic copy: ${escapeHtml(next)}</div>${summary}`;
        document.querySelectorAll('input[name="backup-watch-mode"]').forEach(r => r.checked = r.value === 'auto');
        if (removeBtn) removeBtn.style.display = '';
        if (confirmBtn) confirmBtn.textContent = 'Update & Save Backup';
        updateBackupWatchAutoDetail(status);
    } else {
        statusEl.innerHTML = `<div><i class="fa-solid fa-circle-info"></i> <b>Not on the automatic schedule.</b></div>
            <div style="margin-top:4px;">Pick a mode below to add this lorebook to the backup watch.</div>${summary}`;
        if (removeBtn) removeBtn.style.display = 'none';
        if (confirmBtn) confirmBtn.textContent = 'Save Backup';
        const detail = document.getElementById('backup-watch-auto-detail');
        if (detail) detail.style.display = 'none';
    }
}

function updateBackupWatchAutoDetail(status) {
    const el = document.getElementById('backup-watch-auto-detail');
    if (!el) return;
    const next = status?.nextBackupAt ? status.nextBackupAt : null;
    el.innerHTML = next
        ? `Automatic copies run every 5 hours while SillyTavern is running. Next copy at <b>${escapeHtml(new Date(next).toLocaleString())}</b>.`
        : 'Automatic copies run every 5 hours while SillyTavern is running. Recent copies are kept whole for a week; after that only one per day is retained.';
    el.style.display = '';
}

async function confirmBackupWatch() {
    if (!currentLorebookName) return;
    const mode = document.querySelector('input[name="backup-watch-mode"]:checked')?.value || 'simple';
    const confirmBtn = document.getElementById('btn-backup-watch-confirm');
    if (confirmBtn) confirmBtn.disabled = true;
    try {
        const data = currentLorebookData || await stContext.loadWorldInfo(currentLorebookName);
        if (!data || !data.entries) throw new Error('Could not read lorebook data');
        let folders = [];
        try {
            if (window.ELFolderUrl) folders = window.ELFolderUrl.getFoldersSnapshot(currentLorebookName);
            else if (extensionSettings?.folders?.[currentLorebookName]) folders = extensionSettings.folders[currentLorebookName];
        } catch {}
        const result = await EL_apiFetch('POST', '/backup-watch/create', { lorebookName: currentLorebookName, mode, lorebookData: data, folders });
        if (typeof showToast === 'function') {
            showToast(mode === 'auto' ? 'Automatic backup enabled' : 'Simple backup saved');
        }
        closeModalById('backup-watch-modal');
        if (currentRecoveryTab === 'backups' && currentViewMode === 'recovery') renderRecoveryTab();
    } catch (e) {
        if (typeof showToast === 'function') showToast('Backup failed: ' + e.message);
    } finally {
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

async function removeFromBackupWatch() {
    if (!currentLorebookName) return;
    if (!confirm('Remove "' + currentLorebookName + '" from the automatic backup watch? Existing backups are kept.')) return;
    try {
        await EL_apiFetch('POST', '/backup-watch/disable', { lorebookName: currentLorebookName });
        if (typeof showToast === 'function') showToast('Removed from backup watch');
        closeModalById('backup-watch-modal');
    } catch (e) {
        if (typeof showToast === 'function') showToast('Failed: ' + e.message);
    }
}

function wireBackupWatchModalEvents() {
    const modal = document.getElementById('backup-watch-modal');
    if (!modal) return;

    document.querySelectorAll('input[name="backup-watch-mode"]').forEach(r => {
        r.addEventListener('change', (e) => {
            const detail = document.getElementById('backup-watch-auto-detail');
            if (!detail) return;
            if (e.target.value === 'auto' && e.target.checked) {
                detail.innerHTML = 'Automatic copies run every 5 hours while SillyTavern is running. Recent copies are kept whole for a week; after that only one per day is retained.';
                detail.style.display = '';
            } else {
                detail.style.display = 'none';
            }
        });
    });

    const removeBtn = document.getElementById('btn-backup-watch-remove');
    if (removeBtn) removeBtn.addEventListener('click', removeFromBackupWatch);

    const cancelBtn = document.getElementById('btn-backup-watch-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => closeModalById('backup-watch-modal'));

    const confirmBtn = document.getElementById('btn-backup-watch-confirm');
    if (confirmBtn) confirmBtn.addEventListener('click', confirmBackupWatch);
}

async function renderRecoveryBackups(container, toolbar) {
    const book = currentLorebookName;
    const result = await EL_apiFetch('GET', '/backup-watch/list?lorebookName=' + encodeURIComponent(book));
    const backups = result?.backups || [];
    const autoCount = backups.filter(b => b.kind === 'auto').length;
    const simpleCount = backups.length - autoCount;

    let watchStatus = '';
    try {
        const status = await EL_apiFetch('GET', '/backup-watch/status?lorebookName=' + encodeURIComponent(book));
        if (status?.watched) {
            const next = status.nextBackupAt ? formatRecoveryTime(status.nextBackupAt) : 'soon';
            watchStatus = `<span><i class="fa-solid fa-circle-check" style="color:var(--success-color,#10b981);"></i> Automatic watch active — next copy ~${escapeHtml(next)}</span>`;
        }
    } catch (_) {}

    toolbar.innerHTML = `
        <button id="recovery-backup-watch" class="btn btn-sm" style="background:var(--primary-color,#6366f1); color:#fff;"><i class="fa-solid fa-shield-halved"></i> Backup Watch</button>
        ${watchStatus ? `<span style="font-size:0.85rem; color:var(--text-muted);">${watchStatus}</span>` : ''}
        <span style="flex:1;"></span>
        <span style="font-size:0.85rem; color:var(--text-muted);">${backups.length} backup(s) — ${autoCount} automatic / ${simpleCount} simple</span>
    `;

    const btnWatch = toolbar.querySelector('#recovery-backup-watch');
    if (btnWatch) btnWatch.addEventListener('click', openBackupWatchModal);

    if (backups.length === 0) {
        renderEmptyRecovery(container, 'No backup-watch backups yet. Use the "Backup Watch" button to add one.');
        return;
    }

    container.innerHTML = backups.map(b => {
        const auto = b.kind === 'auto';
        return `
            <div style="display:flex; align-items:center; gap:12px; background:rgba(0,0,0,0.15); border:1px solid var(--panel-border); border-radius:8px; padding:10px 12px; margin-bottom:8px;">
                <i class="fa-solid ${auto ? 'fa-rotate' : 'fa-camera'}" style="opacity:0.6; ${auto ? 'color:#ffb347;' : ''}"></i>
                <div style="flex:1; min-width:0;">
                    <div style="font-weight:600; font-size:0.9rem;">${formatRecoveryTime(b.timestamp)}</div>
                    <div style="font-size:0.78rem; color:var(--text-muted); display:flex; gap:8px; flex-wrap:wrap; margin-top:2px;">
                        <span style="font-size:0.72rem; padding:2px 6px; border-radius:4px; ${auto ? 'background:rgba(255,179,71,0.15); color:#ffb347;' : 'background:rgba(100,116,139,0.25); color:var(--text-muted);'}">${auto ? 'Automatic' : 'Simple'}</span>
                        <span>${escapeHtml(b.id)}</span>
                    </div>
                </div>
                <button class="btn btn-secondary btn-sm recovery-backup-view" data-id="${escapeHtml(b.id)}"><i class="fa-solid fa-eye"></i> View</button>
                <button class="btn btn-sm recovery-backup-restore" data-id="${escapeHtml(b.id)}" style="background:var(--success-color,#10b981); color:#fff;"><i class="fa-solid fa-arrow-rotate-left"></i> Restore</button>
                <button class="btn btn-danger btn-sm recovery-backup-delete" data-id="${escapeHtml(b.id)}" style="background:rgba(239,68,68,0.15);color:#ef4444;"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
    }).join('');

    container.querySelectorAll('.recovery-backup-view').forEach(btn => {
        btn.addEventListener('click', () => viewBackupWatch(btn.dataset.id));
    });
    container.querySelectorAll('.recovery-backup-restore').forEach(btn => {
        btn.addEventListener('click', () => restoreBackupWatch(btn.dataset.id));
    });
    container.querySelectorAll('.recovery-backup-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this backup permanently?')) return;
            try {
                await EL_apiFetch('POST', '/backup-watch/delete', { lorebookName: book, backupId: btn.dataset.id });
                renderRecoveryTab();
            } catch (e) {
                if (typeof showToast === 'function') showToast('Delete failed: ' + e.message);
            }
        });
    });
}

async function viewBackupWatch(backupId) {
    const modal = document.getElementById('backup-view-modal');
    if (!modal) return;
    let backup;
    try {
        const result = await EL_apiFetch('POST', '/backup-watch/get', { lorebookName: currentLorebookName, backupId });
        backup = result?.backup;
    } catch (e) {
        if (typeof showToast === 'function') showToast('Failed to load backup: ' + e.message);
        return;
    }
    if (!backup) {
        if (typeof showToast === 'function') showToast('Backup not found');
        return;
    }

    const titleEl = document.getElementById('backup-view-title');
    if (titleEl) titleEl.textContent = formatRecoveryTime(backup.timestamp) + (backup.kind === 'auto' ? ' (Automatic)' : ' (Simple)');

    const data = backup.data || {};
    const entries = data.entries || {};
    const arr = Object.values(entries).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const metaEl = document.getElementById('backup-view-meta');
    if (metaEl) metaEl.innerHTML = `${escapeHtml(currentLorebookName)} — ${arr.length} entries — ID ${escapeHtml(backup.id)}`;

    const entriesEl = document.getElementById('backup-view-entries');
    if (!arr.length) {
        entriesEl.innerHTML = '<div style="color:var(--text-muted); font-style:italic;">No entries in this backup.</div>';
    } else {
        entriesEl.innerHTML = arr.map(e => `
            <div style="background:rgba(0,0,0,0.12); border:1px solid var(--panel-border); border-radius:8px; padding:8px 12px; margin-bottom:6px;">
                <div style="font-weight:600; font-size:0.85rem;">${escapeHtml(e.comment || '(no comment)')} <span style="color:var(--text-muted); font-weight:400;">UID ${escapeHtml(String(e.uid))}</span></div>
                ${e.key && e.key.length ? `<div style="font-size:0.78rem; color:var(--text-muted);"><i class="fa-solid fa-key"></i> ${escapeHtml(e.key.join(', '))}</div>` : ''}
                <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px; max-height:40px; overflow:hidden;">${escapeHtml((e.content || '').slice(0, 200))}</div>
            </div>
        `).join('');
    }

    const jsonEl = document.getElementById('backup-view-json');
    if (jsonEl) jsonEl.value = JSON.stringify(data, null, 2);

    const restoreBtn = document.getElementById('btn-backup-view-restore');
    if (restoreBtn) {
        const newBtn = restoreBtn.cloneNode(true);
        restoreBtn.replaceWith(newBtn);
        newBtn.addEventListener('click', () => restoreBackupWatch(backup.id, true));
    }

    modal.classList.remove('peek-mode');
    EL_modalOpen(modal);
}

/**
 * Show a blocking confirmation that lists, entry by entry, exactly what a
 * restore would remove/overwrite. Nothing touches the lorebook until the
 * user explicitly confirms.
 */
function showBackupRestoreConfirm(book, backupTs, diff) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal active elg-confirm-modal';

        const removedList = diff.removed.map(([uid, e]) => `
            <div class="elg-delete-item"><span class="elg-delete-icon"><i class="fa-solid fa-triangle-exclamation"></i></span><span class="elg-delete-label">${escapeHtml(getBackupWatchEntryLabel(e))}</span></div>
        `).join('');

        const addedNote = diff.added.length ? `<div style="margin-top:8px;"><i class="fa-solid fa-circle-plus" style="color:var(--success-color,#10b981);"></i> <b>${diff.added.length}</b> entr${diff.added.length === 1 ? 'y' : 'ies'} will be <b>re-added</b> from the backup.</div>` : '';
        const overwrittenNote = diff.overwritten.length ? `<div style="margin-top:4px;"><i class="fa-solid fa-pen-to-square" style="color:#ffb347;"></i> <b>${diff.overwritten.length}</b> entr${diff.overwritten.length === 1 ? 'y' : 'ies'} will be <b>overwritten</b> with the backup version.</div>` : '';

        overlay.innerHTML = `
            <div class="modal-content glass-panel" style="width: 640px; max-width: 92vw; max-height: 85vh; display: flex; flex-direction: column;">
                <div class="modal-header">
                    <h3><i class="fa-solid fa-arrow-rotate-left" style="margin-right: 8px; color: var(--primary-color);"></i>Confirm Restore</h3>
                    <button class="close-modal el-bw-cancel"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="modal-body" style="overflow-y: auto; flex: 1; padding: 16px;">
                    <p style="margin-bottom: 12px; color: var(--text-muted); font-size: 0.9rem;">
                        Restore <strong style="color: var(--text-color);">${escapeHtml(book)}</strong> to its state from <strong style="color: var(--text-color);">${escapeHtml(formatRecoveryTime(backupTs))}</strong>?
                    </p>
                    ${diff.removed.length ? `
                        <div style="margin: 8px 0; color: var(--danger-color, #ef4444); font-weight: 700; font-size: 0.9rem;">
                            <i class="fa-solid fa-triangle-exclamation"></i> ${diff.removed.length} entr${diff.removed.length === 1 ? 'y' : 'ies'} will be REMOVED (they are not in this backup):
                        </div>
                        <div class="elg-delete-list" style="max-height: 220px; overflow-y: auto;">${removedList}</div>
                    ` : ''}
                    ${addedNote}
                    ${overwrittenNote}
                    <p style="margin-top: 12px; font-size: 0.82rem; color: var(--text-muted);">
                        The current state is snapshotted automatically before the restore, and any removed entries are quarantined to <b>Deleted Entries</b> (Trash) so nothing is truly lost.
                    </p>
                </div>
                <div class="modal-footer" style="padding: 12px 16px; border-top: 1px solid var(--panel-border); display: flex; justify-content: flex-end; gap: 12px;">
                    <button class="btn btn-secondary el-bw-cancel">Cancel</button>
                    <button class="btn el-bw-apply" style="background: var(--success-color, #10b981); color: #fff;"><i class="fa-solid fa-arrow-rotate-left"></i> Restore Backup</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        EL_modalOpen(overlay);

        function close() {
            EL_modalClose(overlay);
            overlay.remove();
        }

        overlay.querySelectorAll('.el-bw-cancel').forEach(el => {
            el.addEventListener('click', () => { close(); resolve(false); });
        });
        overlay.querySelector('.el-bw-apply').addEventListener('click', () => { close(); resolve(true); });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { close(); resolve(false); }
        });
    });
}

async function restoreBackupWatch(backupId, closeViewModal) {
    const book = currentLorebookName;
    if (!book || !backupId) return;

    let backupData;
    let backupFolders = null;
    let backupTs = 0;
    try {
        const result = await EL_apiFetch('POST', '/backup-watch/restore', { lorebookName: book, backupId });
        if (!result?.lorebookData) {
            if (typeof showToast === 'function') showToast('Backup not found');
            return;
        }
        backupData = result.lorebookData;
        backupFolders = Array.isArray(result.folders) ? result.folders : (Array.isArray(result.backup?.folders) ? result.backup.folders : null);
        backupTs = result.timestamp || result.backup?.timestamp || 0;
    } catch (e) {
        if (typeof showToast === 'function') showToast('Failed to load backup: ' + e.message);
        return;
    }

    // Authoritative current state straight from the server.
    let currentData;
    try {
        currentData = await ELG_fetchServerState(book) || await stContext.loadWorldInfo(book);
    } catch (e) {
        currentData = null;
    }
    if (!currentData || !currentData.entries) {
        if (typeof showToast === 'function') showToast('Could not load the current lorebook state from the server.');
        return;
    }

    // Per-entry diff between the live book and the backup.
    const currentEntries = currentData.entries || {};
    const backupEntries = backupData.entries || {};
    const currUids = new Set(Object.keys(currentEntries));
    const backUids = new Set(Object.keys(backupEntries));

    const removed = [];
    const added = [];
    const overwritten = [];
    for (const uid of [...currUids]) {
        if (!backUids.has(uid)) removed.push([uid, currentEntries[uid]]);
    }
    for (const uid of [...backUids]) {
        if (!currUids.has(uid)) added.push([uid, backupEntries[uid]]);
        else if (JSON.stringify(currentEntries[uid]) !== JSON.stringify(backupEntries[uid])) overwritten.push([uid, backupEntries[uid]]);
    }

    if (removed.length === 0 && added.length === 0 && overwritten.length === 0) {
        if (typeof showToast === 'function') showToast('This backup matches the current lorebook exactly — nothing to restore.');
        if (closeViewModal) closeModalById('backup-view-modal');
        return;
    }

    // Confirm exactly what will happen before SillyTavern touches the lorebook.
    const confirmed = await showBackupRestoreConfirm(book, backupTs, { removed, added, overwritten });
    if (!confirmed) return;

    try {
        // Apply entries first so folder prune sees correct UID set, then restore folders (extension-only, URL-respected)
        let folderSnapshotBefore = null;
        try { folderSnapshotBefore = window.ELFolderUrl ? window.ELFolderUrl.getFoldersSnapshot(book) : null; } catch {}
        EL_setLorebookData(backupData, { own: true });
        const hasFolders = Array.isArray(backupFolders) && backupFolders.length > 0;
        if (hasFolders && window.ELFolderUrl) {
            try { window.ELFolderUrl.restoreFoldersWithRemap(book, backupFolders, null); } catch {}
            try { saveSettings(); } catch {}
        }
        const ok = await ELG_guardSave(book, backupData, { explicitDelete: true, source: 'user', note: 'Restore backup-watch ' + backupId });
        if (!ok) {
            try { if (folderSnapshotBefore !== null && window.ELFolderUrl) window.ELFolderUrl.setFoldersSnapshot(book, folderSnapshotBefore); } catch {}
            try { saveSettings(); } catch {}
            if (typeof showToast === 'function') showToast('Restore blocked or failed — nothing was written.');
            return;
        }
        if (typeof showToast === 'function') showToast(hasFolders ? 'Backup restored (folders URL-respected)' : 'Backup restored');
        if (closeViewModal) closeModalById('backup-view-modal');
        if (currentViewMode === 'recovery') {
            renderRecoveryTab();
        } else if (currentViewMode === 'lorebook') {
            renderEntries();
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('Restore failed: ' + e.message);
    }
}

// ==========================================
// Folders: names, expand state, drag-and-drop, clipboard (5.1 / 5.3)
// ==========================================
let EL_dragPayload = null;

/**
 * Whether drag-and-drop is enabled. Off means the list behaves exactly as it
 * does today: no handles, no drop targets.
 * @returns {boolean} True unless the user turned the setting off.
 */
function EL_isDragEnabled() {
    try {
        return !!extensionSettings && extensionSettings.dragAndDrop !== false;
    } catch (e) {
        return true;
    }
}

/**
 * Shared validator for folder names. Folder names flow into folder-url.js
 * URLs where the path is slash- or " / "-joined, so separators and sibling
 * duplicates would corrupt the path encoding or make the tree ambiguous.
 * @param {string} rawName User-supplied name.
 * @param {string|null} parentId Sibling scope (same parentId).
 * @param {string|null} [excludeId] Folder id to ignore (rename case).
 * @param {Set<string>} [extraLowerNames] Extra taken lowercase names (batch create).
 * @returns {string|null} Error message, or null when the name is usable.
 */
function EL_validateFolderName(rawName, parentId, excludeId, extraLowerNames) {
    const trimmed = (rawName === null || rawName === undefined) ? '' : String(rawName).trim();
    if (!trimmed) return 'Folder name cannot be empty.';
    if (trimmed === '.' || trimmed === '..') return 'Folder name cannot be "." or "..".';
    if (trimmed.includes(' / ')) return 'Folder name cannot contain " / " — it separates folders in the path.';
    if (trimmed.includes('/') || trimmed.includes('\\')) return 'Folder name cannot contain / or \\ — they would split the folder path.';
    try {
        const lower = trimmed.toLowerCase();
        if (extraLowerNames && typeof extraLowerNames.has === 'function' && extraLowerNames.has(lower)) {
            return 'A folder named "' + trimmed + '" already exists here.';
        }
        const folders = (extensionSettings && extensionSettings.folders && currentLorebookName) ? (extensionSettings.folders[currentLorebookName] || []) : [];
        const clash = folders.some(f => f && f.id !== excludeId && (f.parentId || null) === (parentId || null) && String(f.name || '').toLowerCase() === lower);
        if (clash) return 'A folder named "' + trimmed + '" already exists here.';
    } catch (e) {}
    return null;
}

/**
 * Disambiguate a folder name among siblings: "Name" -> "Name (2)", ...
 * @param {string} base Desired name.
 * @param {string|null} parentId Sibling scope.
 * @param {string|null} [excludeId] Folder id to ignore.
 * @returns {string} A name no sibling currently uses.
 */
function EL_uniqueFolderName(base, parentId, excludeId) {
    let name = (base === null || base === undefined) ? '' : String(base).trim();
    if (!name) name = 'Folder';
    try {
        const folders = (extensionSettings && extensionSettings.folders && currentLorebookName) ? (extensionSettings.folders[currentLorebookName] || []) : [];
        const taken = new Set();
        folders.forEach(f => {
            if (f && f.id !== excludeId && (f.parentId || null) === (parentId || null)) taken.add(String(f.name || '').toLowerCase());
        });
        if (!taken.has(name.toLowerCase())) return name;
        let i = 2;
        while (taken.has((name + ' (' + i + ')').toLowerCase())) i++;
        return name + ' (' + i + ')';
    } catch (e) {
        return name;
    }
}

/**
 * Cycle check: would moving dragId under targetId make dragId its own
 * ancestor? Walks the target's parentId chain; refuses self-drops too.
 * Without this the tree becomes an infinite loop and render recursion hangs.
 * @param {string} dragId Folder being moved.
 * @param {string|null} targetId Proposed new parent (null = root, always safe).
 * @returns {boolean} True when the move must be refused.
 */
function EL_folderMoveWouldCycle(dragId, targetId) {
    if (!dragId || !targetId) return false;
    if (dragId === targetId) return true;
    try {
        const folders = (extensionSettings && extensionSettings.folders && currentLorebookName) ? (extensionSettings.folders[currentLorebookName] || []) : [];
        let cur = folders.find(f => f && f.id === targetId) || null;
        let guard = 0;
        while (cur && guard < 256) {
            const pid = cur.parentId || null;
            if (pid === null) break;
            if (pid === dragId) return true;
            cur = folders.find(f => f && f.id === pid) || null;
            guard++;
        }
    } catch (e) {}
    return false;
}

/**
 * Move an entry into a folder (or root). Membership goes through the
 * folder-url helper so the entry leaves its previous folder (one folder
 * at a time).
 * @param {string|number} uid Entry to move.
 * @param {string|null} targetFolderId Destination folder (null = root).
 * @returns {{ok: boolean, reason?: string, target?: string|null}} Outcome.
 */
function EL_moveEntryToFolderAt(uid, targetFolderId) {
    try {
        const book = currentLorebookName;
        if (!book || !currentLorebookData || !currentLorebookData.entries || !currentLorebookData.entries[uid]) {
            return { ok: false, reason: 'Entry not found.' };
        }
        const sUid = String(uid);
        const folders = (extensionSettings && extensionSettings.folders) ? (extensionSettings.folders[book] || []) : [];
        const target = (targetFolderId === null || targetFolderId === undefined) ? null : targetFolderId;
        if (target !== null && !folders.some(f => f && f.id === target)) {
            return { ok: false, reason: 'Target folder not found.' };
        }
        try {
            if (window.ELFolderUrl && typeof window.ELFolderUrl.assignEntryToFolderId === 'function') {
                const assigned = window.ELFolderUrl.assignEntryToFolderId(sUid, target, book);
                if (!assigned && target !== null) return { ok: false, reason: 'Could not move entry.' };
            } else {
                folders.forEach(f => {
                    if (f && Array.isArray(f.entries)) f.entries = f.entries.filter(x => String(x) !== sUid);
                });
                if (target !== null) {
                    const t = folders.find(f => f && f.id === target);
                    if (!t) return { ok: false, reason: 'Target folder not found.' };
                    if (!Array.isArray(t.entries)) t.entries = [];
                    if (!t.entries.map(String).includes(sUid)) t.entries.push(sUid);
                }
            }
        } catch (e) {
            return { ok: false, reason: 'Could not move entry.' };
        }
        return { ok: true, target: target };
    } catch (e) {
        return { ok: false, reason: 'Could not move entry.' };
    }
}

/**
 * Move a folder under a new parent (or root), with the cycle check.
 * @param {string} folderId Folder to move.
 * @param {string|null} newParentId Destination parent (null = root).
 * @param {number} [newOrder] Optional order for sibling reordering.
 * @returns {{ok: boolean, reason?: string, folder?: object}} Outcome.
 */
function EL_moveFolderToParent(folderId, newParentId, newOrder) {
    try {
        const folders = (extensionSettings && extensionSettings.folders && currentLorebookName) ? (extensionSettings.folders[currentLorebookName] || []) : [];
        const folder = folders.find(f => f && f.id === folderId);
        if (!folder) return { ok: false, reason: 'Folder not found.' };
        const target = (newParentId === null || newParentId === undefined) ? null : newParentId;
        if (target !== null && !folders.some(f => f && f.id === target)) {
            return { ok: false, reason: 'Target folder not found.' };
        }
        if (EL_folderMoveWouldCycle(folderId, target)) {
            return { ok: false, reason: 'Cannot move a folder into itself or one of its subfolders.' };
        }
        folder.parentId = target;
        if (typeof newOrder === 'number' && !isNaN(newOrder)) folder.order = newOrder;
        return { ok: true, folder: folder };
    } catch (e) {
        return { ok: false, reason: 'Could not move folder.' };
    }
}

/**
 * Persist the current expand/collapse set for the open book.
 */
function EL_saveExpandedFolders() {
    try {
        if (!currentLorebookName) return;
        if (!extensionSettings.foldersExpanded || typeof extensionSettings.foldersExpanded !== 'object') {
            extensionSettings.foldersExpanded = {};
        }
        extensionSettings.foldersExpanded[currentLorebookName] = Array.from(expandedFolders);
        saveSettings();
    } catch (e) {}
}

/**
 * Restore the expand/collapse set for the open book. Prunes ids that no
 * longer exist. Books with no saved entry default to fully expanded.
 */
function EL_restoreExpandedFolders() {
    try {
        expandedFolders.clear();
        const folders = (extensionSettings && extensionSettings.folders && currentLorebookName) ? (extensionSettings.folders[currentLorebookName] || []) : [];
        const saved = extensionSettings && extensionSettings.foldersExpanded ? extensionSettings.foldersExpanded[currentLorebookName] : undefined;
        if (!Array.isArray(saved)) {
            folders.forEach(f => { if (f && f.id !== undefined && f.id !== null) expandedFolders.add(f.id); });
            return;
        }
        const live = new Set(folders.map(f => f && f.id));
        saved.forEach(id => { if (live.has(id)) expandedFolders.add(id); });
    } catch (e) {}
}

/**
 * Toggle a folder id in the multi-selection set.
 * @param {string} folderId Folder to toggle.
 * @param {Element} [container] Folder container to restyle.
 */
function EL_toggleFolderSelected(folderId, container) {
    try {
        if (selectedFolders.has(folderId)) {
            selectedFolders.delete(folderId);
            if (container && container.classList) container.classList.remove('el-folder-selected');
        } else {
            selectedFolders.add(folderId);
            if (container && container.classList) container.classList.add('el-folder-selected');
        }
    } catch (e) {}
}

/**
 * Cut folders: stash them in the folder clipboard for a later paste (move).
 * @param {string[]} ids Live folder ids.
 */
function EL_cutFolders(ids) {
    try {
        const folders = (extensionSettings && extensionSettings.folders && currentLorebookName) ? (extensionSettings.folders[currentLorebookName] || []) : [];
        const live = new Set(folders.map(f => f && f.id));
        const list = (ids || []).filter(id => live.has(id));
        if (!list.length) {
            try { EL_toast('No folder to cut.', 'error'); } catch (e) {}
            return;
        }
        EL_folderClipboard = { mode: 'cut', folderIds: list, book: currentLorebookName };
        try { renderEntries(); } catch (e) {}
        try { EL_toast('Cut ' + list.length + ' folder' + (list.length === 1 ? '' : 's') + ' — paste into a folder.', 'info'); } catch (e) {}
    } catch (e) {}
}

/**
 * Copy folders: stash them in the folder clipboard for repeated pastes.
 * @param {string[]} ids Live folder ids.
 */
function EL_copyFolders(ids) {
    try {
        const folders = (extensionSettings && extensionSettings.folders && currentLorebookName) ? (extensionSettings.folders[currentLorebookName] || []) : [];
        const live = new Set(folders.map(f => f && f.id));
        const list = (ids || []).filter(id => live.has(id));
        if (!list.length) {
            try { EL_toast('No folder to copy.', 'error'); } catch (e) {}
            return;
        }
        EL_folderClipboard = { mode: 'copy', folderIds: list, book: currentLorebookName };
        try { renderEntries(); } catch (e) {}
        try { EL_toast('Copied ' + list.length + ' folder' + (list.length === 1 ? '' : 's') + ' — paste into a folder.', 'info'); } catch (e) {}
    } catch (e) {}
}

/**
 * Paste the folder clipboard into a folder. Copies duplicate via
 * duplicateFolderHelper; cuts move via EL_moveFolderToParent. Refuses pastes
 * that would make a folder its own ancestor, and disambiguates names that
 * collide with existing siblings. Clears a cut clipboard after pasting.
 * @param {string} targetFolderId Destination folder id.
 */
async function EL_pasteFoldersInto(targetFolderId) {
    try {
        const clip = EL_folderClipboard;
        if (!clip || !Array.isArray(clip.folderIds) || !clip.folderIds.length) {
            try { EL_toast('Nothing to paste — cut or copy a folder first.', 'error'); } catch (e) {}
            return;
        }
        if (!currentLorebookName || clip.book !== currentLorebookName) {
            try { EL_toast('Clipboard is from a different lorebook.', 'error'); } catch (e) {}
            return;
        }
        const folders = extensionSettings.folders[currentLorebookName] || [];
        const target = folders.find(f => f && f.id === targetFolderId);
        if (!target) {
            try { EL_toast('Target folder not found.', 'error'); } catch (e) {}
            return;
        }
        const ids = clip.folderIds.filter(id => folders.some(f => f && f.id === id));
        if (!ids.length) {
            try { EL_toast('Clipboard folders no longer exist.', 'error'); } catch (e) {}
            EL_folderClipboard = null;
            return;
        }
        let done = 0;
        let skipped = 0;
        let targetPath = targetFolderId;
        try { targetPath = getFolderPathName(targetFolderId); } catch (e) {}
        if (clip.mode === 'cut') {
            for (const id of ids) {
                const f = folders.find(x => x && x.id === id);
                if (!f) {
                    skipped++;
                    continue;
                }
                if (EL_folderMoveWouldCycle(id, targetFolderId)) {
                    skipped++;
                    try { EL_toast('Cannot paste "' + f.name + '" into itself or a subfolder.', 'error'); } catch (e) {}
                    continue;
                }
                const res = EL_moveFolderToParent(id, targetFolderId);
                if (!res || !res.ok) {
                    skipped++;
                    try { EL_toast((res && res.reason) || 'Could not paste folder.', 'error'); } catch (e) {}
                    continue;
                }
                try { f.name = EL_uniqueFolderName(f.name, targetFolderId, f.id); } catch (e) {}
                done++;
            }
            EL_folderClipboard = null;
            try { selectedFolders.clear(); } catch (e) {}
            try { saveSettings(); } catch (e) {}
            try { EL_saveExpandedFolders(); } catch (e) {}
            try { renderEntries(); } catch (e) {}
            try {
                EL_toast(done ? ('Moved ' + done + ' folder' + (done === 1 ? '' : 's') + ' to "' + targetPath + '".' + (skipped ? ' Skipped ' + skipped + '.' : '')) : 'Nothing pasted.', done ? 'success' : 'error');
            } catch (e) {}
        } else {
            for (const id of ids) {
                const f = folders.find(x => x && x.id === id);
                if (!f) {
                    skipped++;
                    continue;
                }
                if (EL_folderMoveWouldCycle(id, targetFolderId)) {
                    skipped++;
                    try { EL_toast('Cannot paste "' + f.name + '" into itself or a subfolder.', 'error'); } catch (e) {}
                    continue;
                }
                let newId = null;
                try {
                    newId = await duplicateFolderHelper(id, targetFolderId);
                } catch (e) {
                    newId = null;
                }
                if (!newId) {
                    skipped++;
                    continue;
                }
                try {
                    const nf = (extensionSettings.folders[currentLorebookName] || []).find(x => x && x.id === newId);
                    if (nf) nf.name = EL_uniqueFolderName(nf.name, targetFolderId, newId);
                } catch (e) {}
                done++;
            }
            try { selectedFolders.clear(); } catch (e) {}
            try { saveSettings(); } catch (e) {}
            if (done) {
                try {
                    if (typeof ELG_guardSave === 'function') {
                        const ok = await ELG_guardSave(currentLorebookName, currentLorebookData, { explicitDelete: false, source: 'user', note: 'Paste folders (copy)' });
                        try { EL_logGuardResult(ok, 'Paste folders', currentLorebookName); } catch (_e) {}
                    }
                } catch (e) {}
            }
            try { renderEntries(); } catch (e) {}
            try {
                EL_toast(done ? ('Copied ' + done + ' folder' + (done === 1 ? '' : 's') + ' to "' + targetPath + '".' + (skipped ? ' Skipped ' + skipped + '.' : '')) : 'Nothing pasted.', done ? 'success' : 'error');
            } catch (e) {}
        }
    } catch (e) {}
}

/**
 * Remove folders which have no entries AND no subfolders, recursively (a
 * folder holding only empty folders is itself removed). Never runs
 * automatically: always confirms, reports the count, and persists.
 * @param {string} [bookName] Book to clean (default: open book).
 */
async function EL_cleanupEmptyFolders(bookName) {
    try {
        const book = bookName || currentLorebookName;
        if (!book) {
            try { EL_toast('Open a lorebook first.', 'error'); } catch (e) {}
            return;
        }
        const folders = (extensionSettings && extensionSettings.folders && extensionSettings.folders[book]) || [];
        if (!folders.length) {
            try { EL_toast('No folders to clean up.', 'info'); } catch (e) {}
            return;
        }
        let live = null;
        try {
            if (book === currentLorebookName && currentLorebookData && currentLorebookData.entries) {
                live = new Set(Object.keys(currentLorebookData.entries).map(String));
            } else if (typeof stContext !== 'undefined' && stContext && typeof stContext.loadWorldInfo === 'function') {
                const fresh = await stContext.loadWorldInfo(book);
                if (fresh && fresh.entries) live = new Set(Object.keys(fresh.entries).map(String));
            }
        } catch (e) {
            live = null;
        }
        if (live === null) {
            try { EL_toast('Could not verify entries — cleanup cancelled, nothing removed.', 'error'); } catch (e) {}
            return;
        }
        let ok = false;
        try {
            ok = confirm('Remove folders with no entries and no subfolders from "' + book + '"?');
        } catch (e) {
            return;
        }
        if (!ok) return;
        const byId = new Map(folders.map(f => [f.id, f]));
        const hasLiveEntries = (f) => {
            try {
                return Array.isArray(f.entries) && f.entries.some(uid => live.has(String(uid)));
            } catch (e) {
                return true;
            }
        };
        let removed = 0;
        let progress = true;
        let guard = 0;
        const removedIds = [];
        while (progress && guard < 1000) {
            guard++;
            progress = false;
            for (const f of folders) {
                if (!f || !byId.has(f.id)) continue;
                let kids = 0;
                for (const x of folders) {
                    if (x && byId.has(x.id) && x.parentId === f.id) {
                        kids++;
                        break;
                    }
                }
                if (kids === 0 && !hasLiveEntries(f)) {
                    byId.delete(f.id);
                    removedIds.push(f.id);
                    removed++;
                    progress = true;
                }
            }
        }
        if (!removed) {
            try { EL_toast('No empty folders found.', 'info'); } catch (e) {}
            return;
        }
        extensionSettings.folders[book] = folders.filter(f => f && byId.has(f.id));
        try {
            removedIds.forEach(id => {
                try { expandedFolders.delete(id); } catch (_e) {}
                try { selectedFolders.delete(id); } catch (_e) {}
            });
            if (EL_folderClipboard && Array.isArray(EL_folderClipboard.folderIds)) {
                EL_folderClipboard.folderIds = EL_folderClipboard.folderIds.filter(id => byId.has(id));
                if (!EL_folderClipboard.folderIds.length) EL_folderClipboard = null;
            }
        } catch (e) {}
        try { saveSettings(); } catch (e) {}
        try { EL_saveExpandedFolders(); } catch (e) {}
        if (book === currentLorebookName) {
            try { renderEntries(); } catch (e) {}
        }
        try { EL_toast('Removed ' + removed + ' empty folder' + (removed === 1 ? '' : 's') + '.', 'success'); } catch (e) {}
    } catch (e) {}
}

/**
 * Read the in-flight drag payload (same-window drags set EL_dragPayload on
 * dragstart; dataTransfer is the Firefox-safe fallback for drops).
 * @param {DragEvent} e Drop event.
 * @returns {{kind: string, uid?: string, id?: string}|null} Payload or null.
 */
function EL_readDragData(e) {
    try {
        if (EL_dragPayload && (EL_dragPayload.kind === 'entry' || EL_dragPayload.kind === 'folder')) return EL_dragPayload;
        const raw = (e && e.dataTransfer && (e.dataTransfer.getData('application/x-el-drag') || e.dataTransfer.getData('text/plain'))) || '';
        if (!raw) return null;
        const d = JSON.parse(raw);
        if (d && (d.kind === 'entry' || d.kind === 'folder')) return d;
    } catch (err) {}
    return null;
}

/**
 * Clear every drop highlight. Called on dragleave/drop/dragend, including a
 * document-level dragend so a cancelled drag or one leaving the window can
 * never leave a stale highlight behind.
 */
function EL_clearDragHighlights() {
    try {
        const nodes = document.querySelectorAll('.el-drop-into, .el-drop-before, .el-drop-after, .el-drop-root');
        nodes.forEach(el => el.classList.remove('el-drop-into', 'el-drop-before', 'el-drop-after', 'el-drop-root'));
    } catch (e) {}
}

/**
 * Reset draggable flags left set by a handle press that never became a drag
 * (single global mouseup listener; never attached per card).
 */
function EL_clearStaleDraggables() {
    try {
        const nodes = document.querySelectorAll('.entry-card[draggable="true"], .folder-container[draggable="true"]');
        nodes.forEach(el => { try { el.draggable = false; } catch (_e) {} });
    } catch (e) {}
}

/**
 * Persist + re-render + toast after a drop. Refused drags (cycles) toast an
 * error and persist nothing.
 * @param {{ok: boolean, reason?: string}} res Mutator outcome.
 * @param {object} [opts] { entryMoved, note, success }.
 */
async function EL_afterDrop(res, opts) {
    const o = opts || {};
    try { EL_clearDragHighlights(); } catch (e) {}
    if (!res || !res.ok) {
        try { EL_toast((res && res.reason) || 'Drop failed.', 'error'); } catch (e) {}
        return;
    }
    try { saveSettings(); } catch (e) {}
    if (o.entryMoved) {
        try {
            if (typeof ELG_guardSave === 'function') {
                const ok = await ELG_guardSave(currentLorebookName, currentLorebookData, { explicitDelete: false, source: 'user', note: o.note || 'Drag and drop' });
                try { EL_logGuardResult(ok, o.note || 'Drag and drop', currentLorebookName); } catch (_e) {}
                if (!ok) {
                    try { EL_toast('Move applied locally but the save failed.', 'error'); } catch (_e) {}
                }
            }
        } catch (e) {}
    }
    try { renderEntries(); } catch (e) {}
    try {
        if (o.success) EL_toast(o.success, 'success');
    } catch (e) {}
}

/**
 * Drop an entry into a folder (append).
 * @param {string} uid Entry uid.
 * @param {string} folderId Destination folder.
 */
async function EL_dropEntryIntoFolder(uid, folderId) {
    let label = folderId;
    try { label = getFolderPathName(folderId); } catch (e) {}
    const res = EL_moveEntryToFolderAt(uid, folderId);
    await EL_afterDrop(res, { entryMoved: true, note: 'Drag entry to folder', success: res && res.ok ? ('Moved entry to "' + label + '".') : '' });
}

/**
 * Drop an entry on the root area (un-file it).
 * @param {string} uid Entry uid.
 */
async function EL_dropEntryToRoot(uid) {
    const res = EL_moveEntryToFolderAt(uid, null);
    await EL_afterDrop(res, { entryMoved: true, note: 'Drag entry to root', success: res && res.ok ? 'Moved entry to root.' : '' });
}

/**
 * Drop a folder into another folder (nest).
 * @param {string} dragId Dragged folder id.
 * @param {string} targetId Destination folder id.
 */
async function EL_dropFolderIntoFolder(dragId, targetId) {
    const res = EL_moveFolderToParent(dragId, targetId);
    let label = targetId;
    try { label = getFolderPathName(targetId); } catch (e) {}
    await EL_afterDrop(res, { success: res && res.ok ? ('Moved folder "' + ((res.folder && res.folder.name) || '') + '" into "' + label + '".') : '' });
}

/**
 * Drop a folder above/below another folder header (reorder among siblings).
 * @param {string} dragId Dragged folder id.
 * @param {string} refId Target header folder id.
 * @param {string} place 'before' or 'after'.
 */
async function EL_dropFolderAtHeader(dragId, refId, place) {
    let ref = null;
    try {
        ref = (extensionSettings.folders[currentLorebookName] || []).find(f => f && f.id === refId) || null;
    } catch (e) {
        ref = null;
    }
    if (!ref) {
        try { EL_toast('Target folder not found.', 'error'); } catch (e) {}
        return;
    }
    const newOrder = (ref.order ?? 100) + ((place === 'before') ? 1 : -1);
    const res = EL_moveFolderToParent(dragId, ref.parentId || null, newOrder);
    await EL_afterDrop(res, { success: res && res.ok ? ('Moved folder "' + ((res.folder && res.folder.name) || '') + '" ' + place + ' "' + (ref.name || '') + '".') : '' });
}

/**
 * Drop a folder on the root area (un-nest it).
 * @param {string} dragId Folder id.
 */
async function EL_dropFolderToRoot(dragId) {
    const res = EL_moveFolderToParent(dragId, null);
    await EL_afterDrop(res, { success: res && res.ok ? ('Moved folder "' + ((res.folder && res.folder.name) || '') + '" to root.') : '' });
}

/**
 * Attach the drag handle + dragstart/dragend wiring to an entry card. The
 * card is NOT draggable by default (cards contain inline inputs and
 * selectable text); dragging starts only from the small grip handle, which
 * sets draggable = true while pressed and resets it on dragend.
 * @param {Element} card Entry card element.
 * @param {string} uid Entry uid.
 */
function EL_setupEntryDrag(card, uid) {
    try {
        if (!EL_isDragEnabled()) return;
        if (!card || !card.querySelector) return;
        const host = card.querySelector('.entry-header') || card;
        if (host.querySelector(':scope > .el-drag-handle')) return;
        const handle = document.createElement('span');
        handle.className = 'el-drag-handle';
        handle.title = 'Drag to move';
        handle.innerHTML = '<i class="fa-solid fa-grip-vertical"></i>';
        handle.addEventListener('mousedown', (e) => {
            try { e.stopPropagation(); } catch (_e) {}
            try { card.draggable = true; } catch (_e) {}
        });
        handle.addEventListener('click', (e) => {
            try { e.stopPropagation(); } catch (_e) {}
        });
        try { host.insertBefore(handle, host.firstChild); } catch (_e) {}
        card.addEventListener('dragstart', (e) => {
            try {
                if (!EL_isDragEnabled()) {
                    e.preventDefault();
                    return;
                }
                EL_dragPayload = { kind: 'entry', uid: String(uid) };
                try {
                    e.dataTransfer.setData('application/x-el-drag', JSON.stringify(EL_dragPayload));
                    e.dataTransfer.setData('text/plain', JSON.stringify(EL_dragPayload));
                } catch (_e) {}
                try { e.dataTransfer.effectAllowed = 'move'; } catch (_e) {}
            } catch (err) {
                try { e.preventDefault(); } catch (_e) {}
            }
        });
        card.addEventListener('dragend', () => {
            try { card.draggable = false; } catch (e) {}
            try { EL_dragPayload = null; } catch (e) {}
            try { EL_clearDragHighlights(); } catch (e) {}
        });
    } catch (e) {}
}

/**
 * Attach the drag handle + dragstart/dragend wiring to a folder header.
 * @param {Element} header Folder header element.
 * @param {Element} container Folder container element (the draggable).
 * @param {object} folder Folder record.
 */
function EL_setupFolderDrag(header, container, folder) {
    try {
        if (!EL_isDragEnabled()) return;
        if (!header || !container || !folder) return;
        if (header.querySelector(':scope > .el-drag-handle')) return;
        const handle = document.createElement('span');
        handle.className = 'el-drag-handle';
        handle.title = 'Drag to move folder';
        handle.innerHTML = '<i class="fa-solid fa-grip-vertical"></i>';
        handle.addEventListener('mousedown', (e) => {
            try { e.stopPropagation(); } catch (_e) {}
            try { container.draggable = true; } catch (_e) {}
        });
        handle.addEventListener('click', (e) => {
            try { e.stopPropagation(); } catch (_e) {}
        });
        try { header.insertBefore(handle, header.firstChild); } catch (_e) {}
        container.addEventListener('dragstart', (e) => {
            try {
                if (!EL_isDragEnabled()) {
                    e.preventDefault();
                    return;
                }
                EL_dragPayload = { kind: 'folder', id: String(folder.id) };
                try {
                    e.dataTransfer.setData('application/x-el-drag', JSON.stringify(EL_dragPayload));
                    e.dataTransfer.setData('text/plain', JSON.stringify(EL_dragPayload));
                } catch (_e) {}
                try { e.dataTransfer.effectAllowed = 'move'; } catch (_e) {}
            } catch (err) {
                try { e.preventDefault(); } catch (_e) {}
            }
        });
        container.addEventListener('dragend', () => {
            try { container.draggable = false; } catch (e) {}
            try { EL_dragPayload = null; } catch (e) {}
            try { EL_clearDragHighlights(); } catch (e) {}
        });
    } catch (e) {}
}

/**
 * Attach drop targeting to a folder: entries dropped on the header or body
 * move INTO the folder; folders dropped on the middle of the header nest
 * INTO it, while the top/bottom edge zones reorder among siblings.
 * @param {Element} container Folder container element.
 * @param {Element} header Folder header element.
 * @param {Element} content Folder body element.
 * @param {object} folder Folder record.
 */
function EL_setupFolderDrop(container, header, content, folder) {
    try {
        if (!EL_isDragEnabled()) return;
        if (!container || !header || !folder) return;
        const fid = String(folder.id);
        header.addEventListener('dragover', (e) => {
            try {
                if (!EL_dragPayload) return;
                if (EL_dragPayload.kind === 'entry') {
                    e.preventDefault();
                    e.stopPropagation();
                    try { e.dataTransfer.dropEffect = 'move'; } catch (_e) {}
                    container.classList.add('el-drop-into');
                    return;
                }
                if (EL_dragPayload.kind === 'folder' && String(EL_dragPayload.id) !== fid) {
                    e.preventDefault();
                    e.stopPropagation();
                    try { e.dataTransfer.dropEffect = 'move'; } catch (_e) {}
                    let zone = 'into';
                    try {
                        const rect = header.getBoundingClientRect ? header.getBoundingClientRect() : null;
                        if (rect && rect.height > 0) {
                            const y = e.clientY - rect.top;
                            if (y < rect.height * 0.25) zone = 'before';
                            else if (y > rect.height * 0.75) zone = 'after';
                        }
                    } catch (_e) {}
                    header.classList.toggle('el-drop-before', zone === 'before');
                    header.classList.toggle('el-drop-after', zone === 'after');
                    container.classList.toggle('el-drop-into', zone === 'into');
                }
            } catch (err) {}
        });
        header.addEventListener('dragleave', (e) => {
            try {
                if (!header.contains(e.relatedTarget)) {
                    header.classList.remove('el-drop-before');
                    header.classList.remove('el-drop-after');
                    container.classList.remove('el-drop-into');
                }
            } catch (err) {}
        });
        header.addEventListener('drop', (e) => {
            try {
                if (!EL_dragPayload) return;
                const data = EL_readDragData(e);
                if (!data) return;
                e.preventDefault();
                e.stopPropagation();
                if (data.kind === 'entry') {
                    const dragUid = String(data.uid);
                    EL_dragPayload = null;
                    EL_dropEntryIntoFolder(dragUid, fid);
                    return;
                }
                if (data.kind === 'folder' && String(data.id) !== fid) {
                    let zone = 'into';
                    try {
                        const rect = header.getBoundingClientRect ? header.getBoundingClientRect() : null;
                        if (rect && rect.height > 0) {
                            const y = e.clientY - rect.top;
                            if (y < rect.height * 0.25) zone = 'before';
                            else if (y > rect.height * 0.75) zone = 'after';
                        }
                    } catch (_e) {}
                    const dragId = String(data.id);
                    EL_dragPayload = null;
                    if (zone === 'into') EL_dropFolderIntoFolder(dragId, fid);
                    else EL_dropFolderAtHeader(dragId, fid, zone);
                }
            } catch (err) {}
        });
        if (content && content.addEventListener) {
            content.addEventListener('dragover', (e) => {
                try {
                    if (!EL_dragPayload) return;
                    if (EL_dragPayload.kind === 'folder' && String(EL_dragPayload.id) === fid) return;
                    e.preventDefault();
                    e.stopPropagation();
                    try { e.dataTransfer.dropEffect = 'move'; } catch (_e) {}
                    container.classList.add('el-drop-into');
                } catch (err) {}
            });
            content.addEventListener('dragleave', (e) => {
                try {
                    if (!container.contains(e.relatedTarget)) container.classList.remove('el-drop-into');
                } catch (err) {}
            });
            content.addEventListener('drop', (e) => {
                try {
                    if (!EL_dragPayload) return;
                    const data = EL_readDragData(e);
                    if (!data) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (data.kind === 'entry') {
                        const dragUid = String(data.uid);
                        EL_dragPayload = null;
                        EL_dropEntryIntoFolder(dragUid, fid);
                    } else if (data.kind === 'folder' && String(data.id) !== fid) {
                        const dragId = String(data.id);
                        EL_dragPayload = null;
                        EL_dropFolderIntoFolder(dragId, fid);
                    }
                } catch (err) {}
            });
        }
        container.addEventListener('dragleave', (e) => {
            try {
                if (!container.contains(e.relatedTarget)) {
                    container.classList.remove('el-drop-into');
                    header.classList.remove('el-drop-before');
                    header.classList.remove('el-drop-after');
                }
            } catch (err) {}
        });
    } catch (e) {}
}

/**
 * Root drop target: dropping an entry on the empty list area un-files it,
 * dropping a folder un-nests it to the top level.
 */
function EL_setupRootDrop() {
    try {
        const root = els.entriesContainer;
        if (!root || !root.addEventListener) return;
        if (root.dataset && root.dataset.elRootDrop === '1') return;
        if (root.dataset) root.dataset.elRootDrop = '1';
        root.addEventListener('dragover', (e) => {
            try {
                if (!EL_isDragEnabled() || !EL_dragPayload) return;
                e.preventDefault();
                try { e.dataTransfer.dropEffect = 'move'; } catch (_e) {}
                root.classList.add('el-drop-root');
            } catch (err) {}
        });
        root.addEventListener('dragleave', (e) => {
            try {
                if (!root.contains(e.relatedTarget)) root.classList.remove('el-drop-root');
            } catch (err) {}
        });
        root.addEventListener('drop', (e) => {
            try {
                if (!EL_dragPayload) return;
                const data = EL_readDragData(e);
                if (!data) return;
                e.preventDefault();
                e.stopPropagation();
                if (data.kind === 'entry') {
                    const dragUid = String(data.uid);
                    EL_dragPayload = null;
                    EL_dropEntryToRoot(dragUid);
                } else if (data.kind === 'folder') {
                    const dragId = String(data.id);
                    EL_dragPayload = null;
                    EL_dropFolderToRoot(dragId);
                }
            } catch (err) {}
        });
    } catch (e) {}
}

// Start app
window.addEventListener('load', init);
