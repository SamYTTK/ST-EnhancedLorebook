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

function openStandaloneApp(tab = '') {
    const baseUrl = getExtensionUrl();
    const token = _csrfToken || '';
    const params = new URLSearchParams({ csrf: token, v: Date.now() });
    if (tab) params.set('tab', tab);
    const url = `${baseUrl}/app/index.html?${params.toString()}`;
    appWindow = window.open(url, '_blank');
    window.__enhancedLorebookWindow = appWindow;
    if (pendingPeriodicTrigger) {
        pendingPeriodicTrigger = false;
        setTimeout(() => sendPeriodicTriggerToApp(), 1000);
    }
}

function sendPeriodicTriggerToApp() {
    if (appWindow && !appWindow.closed) {
        const context = SillyTavern.getContext();
        const chatInfo = { characterId: context.characterId, chatId: context.chat?.chat_id };
        appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-periodic-trigger', chatInfo }, window.location.origin);
    }
}

function sendChatChangedToApp() {
    if (appWindow && !appWindow.closed) {
        const context = SillyTavern.getContext();
        appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-chat-changed', characterId: context.characterId, chatId: context.chat?.chat_id }, window.location.origin);
    }
}

function sendSettingsSyncToApp(settings) {
    if (appWindow && !appWindow.closed) {
        appWindow.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-settings-sync', settings }, window.location.origin);
    }
}

function handleNewMessage() {
    messageCounter++;
    try {
        const context = SillyTavern.getContext();
        const settings = context.extensionSettings?.SillyTavernEnhancedLorebook?.agent;
        if (!settings || settings.mode !== 'periodic' || !settings.enabled) return;
        const interval = Number(settings.interval) || 5;
        if (messageCounter % interval !== 0) return;

        messageCounter = 0;
        lastPeriodicRun = Date.now();

        if (appWindow && !appWindow.closed) {
            sendPeriodicTriggerToApp();
        } else {
            pendingPeriodicTrigger = true;
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
            case 'el-agent-trigger-now': {
                const context = SillyTavern.getContext();
                const settings = context.extensionSettings?.SillyTavernEnhancedLorebook?.agent;
                if (settings?.enabled) {
                    handleNewMessage();
                }
                break;
            }
            case 'el-pending-count': {
                const badge = document.getElementById('agent-pending-badge');
                if (!badge) break;
                const count = Number(msg.count) || 0;
                badge.textContent = count;
                badge.style.display = count > 0 ? 'inline' : 'none';
                break;
            }
            case 'el-agent-trigger-periodic': {
                const ctx = SillyTavern.getContext();
                const s = ctx.extensionSettings?.SillyTavernEnhancedLorebook?.agent;
                if (s?.enabled && s?.mode === 'periodic') {
                    handleNewMessage();
                }
                break;
            }
            case 'el-agent-request-chat-info': {
                const ctx2 = SillyTavern.getContext();
                if (e.source) {
                    e.source.postMessage({ source: 'enhanced-lorebook', type: 'el-agent-chat-info', characterId: ctx2.characterId, chatId: ctx2.chat?.chat_id }, window.location.origin);
                }
                break;
            }
            case 'el-agent-settings-changed': {
                try {
                    const ctx3 = SillyTavern.getContext();
                    if (!ctx3.extensionSettings.SillyTavernEnhancedLorebook) ctx3.extensionSettings.SillyTavernEnhancedLorebook = {};
                    ctx3.extensionSettings.SillyTavernEnhancedLorebook.agent = msg.settings;
                    ctx3.saveSettingsDebounced();
                    sendSettingsSyncToApp(msg.settings);
                } catch (e) {
                    console.error('Enhanced Lorebook: settings changed error', e);
                }
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
        <div class="el-launcher-item" data-action="agent-config">
            <i class="fa-solid fa-robot"></i>
            <span>Agent Config</span>
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
        } else if (item.dataset.action === 'agent-config') {
            openStandaloneApp('agent-config');
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

jQuery(async () => {
    setupLauncherDropdown();
    setupPostMessageBridge();

    try {
        const context = SillyTavern.getContext();
        context.eventSource.on(context.event_types.CHARACTER_MESSAGE_RENDERED, () => handleNewMessage());
        context.eventSource.on(context.event_types.USER_MESSAGE_RENDERED, () => handleNewMessage());
        context.eventSource.on(context.event_types.CHAT_CHANGED, () => sendChatChangedToApp());
    } catch (e) {
        console.error('Enhanced Lorebook: failed to subscribe to events', e);
    }
});
