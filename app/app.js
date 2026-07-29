const EL_SETTINGS_KEY = 'SillyTavernEnhancedLorebook';
const ST_Window = window.opener || window.parent;
const safeJoin = (val, sep = ', ') => Array.isArray(val) ? val.join(sep) : (val ? String(val) : '');

let stContext = null;
let currentLorebookName = null;
let currentLorebookData = null;
let selectedEntries = new Set();
let lastClickedEntryUid = null;
let extensionSettings = {};
let expandedFolders = new Set();
let downloadFn = null;
let agentEngine = null;
let agentUIInitialized = false;
let currentViewMode = 'lorebook';

// DOM Elements
const els = {
    btnCloseApp: document.getElementById('btn-close-app'),
    btnSettings: document.getElementById('btn-settings'),
    btnRefresh: document.getElementById('btn-refresh-lorebooks'),
    btnSaveTemplate: document.getElementById('btn-save-template'),

    listActive: document.getElementById('active-lorebooks-list'),
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

    try {
        const wiModule = await import('../../../../world-info.js');
        duplicateWorldInfoEntry = wiModule.duplicateWorldInfoEntry;
        moveWorldInfoEntry = wiModule.moveWorldInfoEntry;
    } catch (e) {
        console.error('Failed to dynamically import world-info.js core functions:', e);
    }

    try {
        const utilsModule = await import('../../../../utils.js');
        downloadFn = utilsModule.download;
    } catch (e) {
        console.error('Failed to dynamically import download utility:', e);
    }

    // Load settings
    if (!stContext.extensionSettings[EL_SETTINGS_KEY]) {
        stContext.extensionSettings[EL_SETTINGS_KEY] = {
            colors: {},
            templates: {}, // name -> array of lorebook names
            folders: {},    // lorebookName -> array of {id, name, entries: [uid, uid]}
        };
    }
    extensionSettings = stContext.extensionSettings[EL_SETTINGS_KEY];
    if (!extensionSettings.folders) extensionSettings.folders = {};
    if (!extensionSettings.templates) extensionSettings.templates = {};
    if (extensionSettings.sidebarWidth) {
        document.documentElement.style.setProperty('--sidebar-width', `${extensionSettings.sidebarWidth}px`);
    }

    applyColors();
    setupEventListeners();
    createContextMenu();
    await refreshSidebar();

    if (!extensionSettings.agent) {
        extensionSettings.agent = {
            enabled: true,
            mode: 'manual',
            periodicInterval: 10,
            useSeparateApi: false,
            canCreate: true,
            canEdit: true,
            canDelete: false,
            canResearch: false,
            autoAccept: false,
            autoAcceptConfidence: 0.8,
            maxEntriesPerRun: 5,
            requireKeyConfidence: 'low',
            requireConfirmation: true,
            research: { source: 'disabled' },
        };
    }

    try {
        const agentCoreModule = await import('./agent-core.js');
        const agentUiModule = await import('./agent-ui.js');
        const context = {
            stContext,
            settings: extensionSettings.agent,
            permissions: {
                canCreate: extensionSettings.agent.canCreate,
                canEdit: extensionSettings.agent.canEdit,
                canDelete: extensionSettings.agent.canDelete,
                canResearch: extensionSettings.agent.canResearch,
                autoAccept: extensionSettings.agent.autoAccept,
                autoAcceptConfidence: extensionSettings.agent.autoAcceptConfidence,
                maxEntriesPerRun: extensionSettings.agent.maxEntriesPerRun,
                requireKeyConfidence: extensionSettings.agent.requireKeyConfidence,
                requireConfirmation: extensionSettings.agent.requireConfirmation,
            },
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
    if (initialTab === 'agent-config') switchToView('agent-config');
    else if (initialTab === 'agent-feed') switchToView('agent-feed');
}

function saveSettings() {
    stContext.saveSettingsDebounced();
}

function refreshAfterAgentChange(lorebookName) {
    if (currentLorebookName === lorebookName && currentViewMode === 'lorebook') {
        renderEntries();
    }
}

// ==========================================
// Theme & Colors
// ==========================================
function applyColors() {
    const colors = extensionSettings.colors || {};
    const root = document.documentElement;
    if (colors.bg) root.style.setProperty('--bg-color', colors.bg);
    if (colors.panel) root.style.setProperty('--panel-bg', colors.panel);
    if (colors.text) root.style.setProperty('--text-color', colors.text);
    if (colors.primary) root.style.setProperty('--primary-color', colors.primary);
}

function openSettings() {
    const colors = extensionSettings.colors || {};
    document.getElementById('color-bg').value = colors.bg || '#0f111a';
    document.getElementById('color-panel').value = colors.panel || '#1a1c29'; /* Simplified */
    document.getElementById('color-text').value = colors.text || '#e2e8f0';
    document.getElementById('color-primary').value = colors.primary || '#6366f1';
    els.settingsModal.classList.add('active');
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

    // In standard ST, active global lorebooks are in stContext.world_info_settings ?
    // We'll just read from ST's world_info element if possible, or global settings.
    const stSelect = ST_Window.document.getElementById('world_info');
    let activeGlobals = [];
    if (stSelect) {
        activeGlobals = Array.from(stSelect.selectedOptions).map(opt => opt.text).filter(v => v);
    }

    renderLorebookList(els.listAll, allNames, (name) => {
        openLorebook(name);
    }, true);

    renderLorebookList(els.listActive, activeGlobals, (name) => {
        openLorebook(name);
    }, false, true);

    renderTemplatesList();
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

        div.innerHTML = `<i class="fa-solid fa-book"></i><span>${name}</span>`;

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
        div.innerHTML = `<i class="fa-solid fa-bookmark"></i><span>${tName}</span>`;

        // Double click to load template
        div.addEventListener('dblclick', () => {
            if (confirm(`Apply template '${tName}'? This will replace your currently active global lorebooks.`)) {
                applyTemplate(tName);
            }
        });

        // Right click to delete
        div.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (confirm(`Delete template '${tName}'?`)) {
                delete extensionSettings.templates[tName];
                saveSettings();
                renderTemplatesList();
            }
        });

        els.listTemplates.appendChild(div);
    });
}

async function applyTemplate(tName) {
    const list = extensionSettings.templates[tName];
    if (!list) return;

    const stSelect = ST_Window.document.getElementById('world_info');
    if (stSelect) {
        // Clear all
        Array.from(stSelect.options).forEach(opt => opt.selected = false);
        // Select matching
        Array.from(stSelect.options).forEach(opt => {
            if (list.includes(opt.text)) {
                opt.selected = true;
            }
        });
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
    currentLorebookName = name;
    currentViewMode = 'lorebook';
    els.currentTitle.textContent = name;
    els.mainToolbar.style.display = 'flex';
    els.entriesContainer.innerHTML = '';
    els.entriesContainer.classList.remove('hidden');
    selectedEntries.clear();
    lastClickedEntryUid = null;
    expandedFolders.clear();
    updateBatchButton();

    document.querySelectorAll('.agent-sidebar-item').forEach(i => i.classList.remove('active'));
    hideAgentPanels();

    currentLorebookData = await stContext.loadWorldInfo(name);
    if (!currentLorebookData || !currentLorebookData.entries) {
        currentLorebookData = { entries: {} }; // Fallback
    }

    ensureFoldersStructure(name);
    renderEntries();
}

function ensureFoldersStructure(lbName) {
    if (!extensionSettings.folders[lbName]) {
        extensionSettings.folders[lbName] = [];
    }
    // Cleanup: Remove references to non-existent entries from folders
    const existingUids = new Set(Object.keys(currentLorebookData.entries));
    extensionSettings.folders[lbName].forEach(folder => {
        folder.entries = folder.entries.filter(uid => existingUids.has(String(uid)));
    });
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

    if (item.type === 'folder') {
        const name = (item.data.name || '').toLowerCase();
        if (name === term) return 10000;
        
        const escaped = escapeRegex(term);
        const startsWithRegex = new RegExp('^\\b' + escaped + '\\b', 'i');
        const containsRegex = new RegExp('\\b' + escaped + '\\b', 'i');
        
        if (startsWithRegex.test(name)) return 5000;
        if (containsRegex.test(name)) return 2000;
        if (name.includes(term)) return 1000;
        return 0;
    } else {
        const entry = currentLorebookData.entries[item.uid];
        if (!entry) return 0;
        const comment = (entry.comment || '').toLowerCase();
        const keys = (Array.isArray(entry.key) ? entry.key : []).map(k => String(k).toLowerCase());
        
        if (comment === term || keys.includes(term)) return 10000;
        
        const escaped = escapeRegex(term);
        const startsWithRegex = new RegExp('^\\b' + escaped + '\\b', 'i');
        const containsRegex = new RegExp('\\b' + escaped + '\\b', 'i');
        
        if (startsWithRegex.test(comment) || keys.some(k => startsWithRegex.test(k))) return 5000;
        if (containsRegex.test(comment) || keys.some(k => containsRegex.test(k))) return 2000;
        if (comment.includes(term) || keys.some(k => k.includes(term))) return 1000;
        
        const content = (entry.content || '').toLowerCase();
        if (startsWithRegex.test(content)) return 100;
        if (containsRegex.test(content)) return 50;
        if (content.includes(term)) return 10;
        
        return 0;
    }
}

function getItemMaxScore(item, query) {
    if (!query) return 0;
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

    selectedEntries.clear();
    lastClickedEntryUid = null;
    updateBatchButton();
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
    let titleHtml = isRoot ? `<i></i><span class="folder-title">${folder.name} <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: normal;">(${totalCount})</span></span>` :
        `<i class="fa-solid fa-chevron-down folder-toggle"></i><span class="folder-title">${folder.name} <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: normal;">(${totalCount})</span></span>`;

    if (!isRoot) {
        titleHtml += `<div style="margin-left: 12px; display:flex; align-items:center; gap: 4px; font-size: 0.8rem; color: var(--text-muted);">
            <i class="fa-solid fa-sort-numeric-down"></i> Order:
            <input type="number" class="inline-edit folder-order-input" value="${folder.order ?? 100}" style="width: 60px;" data-folder-id="${folder.id}">
        </div>`;
    }

    header.innerHTML = titleHtml;

    if (!isRoot) {
        header.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('label')) return;
            container.classList.toggle('collapsed');
            if (container.classList.contains('collapsed')) {
                expandedFolders.delete(folder.id);
            } else {
                expandedFolders.add(folder.id);
            }
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

    container.appendChild(header);
    container.appendChild(content);
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

    card.innerHTML = `
        <div class="entry-header" style="align-items: center;">
            <div style="display:flex; flex-direction:column; gap: 4px; flex: 1;">
                <div class="entry-keys" title="${escapeHtml(keysStr)}" style="display:flex; align-items:center;">
                    ${iconHtml}
                    ${entry.comment ? `<span style="color:var(--text-muted)">[${escapeHtml(entry.comment)}]</span> ` : ''}
                    ${escapeHtml(keysStr) || '<em>No Primary Keys</em>'}
                </div>
                ${secondaryKeysStr ? `<div style="font-size: 0.8rem; color:var(--text-muted)">Sec: ${escapeHtml(secondaryKeysStr)}</div>` : ''}
            </div>
            <div class="entry-badges" style="flex-wrap: wrap; justify-content: flex-end; max-width: 250px; align-items: center; gap: 8px;">
                ${badges.join('')}
                <input type="checkbox" class="entry-select-checkbox" style="width: 18px; height: 18px; cursor: pointer; margin: 0;">
            </div>
        </div>
        <div class="entry-content" style="-webkit-line-clamp: 2;">${escapeHtml(entry.content || 'Empty Entry...')}</div>
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
            await stContext.saveWorldInfo(currentLorebookName, currentLorebookData);
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
        } else if (selectedEntries.size > 0) {
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

    if (downloadFn) {
        downloadFn(content, filename, mimeType);
    } else {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    showToast(`Downloaded ${entries.length} entries as ${ext.toUpperCase()}`);
}

// ==========================================
// Folder Actions
// ==========================================


function renameFolder(folderId) {
    const folder = extensionSettings.folders[currentLorebookName].find(f => f.id === folderId);
    if (!folder) return;
    const name = prompt('Enter new folder name:', folder.name);
    if (!name) return;
    folder.name = name;
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
    content.querySelector('.close-modal').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    setTimeout(() => searchInput.focus(), 50);
}

function executeFolderMove(folderId, targetParentId) {
    const folders = extensionSettings.folders[currentLorebookName] || [];
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return;

    // Guard: prevent moving a folder into itself or its descendants
    if (targetParentId) {
        const descendants = getDescendantFolderIds(folderId);
        if (targetParentId === folderId || descendants.has(targetParentId)) {
            alert('Cannot move a folder into itself or one of its subfolders.');
            return;
        }
    }

    folder.parentId = targetParentId;
    saveSettings();
    renderEntries();
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
    document.getElementById('add-item-modal').classList.add('active');
}

function closeAddItemModal() {
    document.getElementById('add-item-modal').classList.remove('active');
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
    const toast = document.getElementById('xml-copy-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.remove('visible'), 2000);
}

function showCopyToast() {
    showToast('Template copied to clipboard!');
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
            case 'delayuntilrecursion':
                currentEntry.overrides.delay_until_recursion = t.value.toLowerCase() === 'true';
                break;
            case 'delayuntilrecursionlevel':
                currentEntry.overrides.delayUntilRecursionLevel = parseInt(t.value);
                if (isNaN(currentEntry.overrides.delayUntilRecursionLevel)) delete currentEntry.overrides.delayUntilRecursionLevel;
                break;
            case 'useprobability':
                currentEntry.overrides.useProbability = t.value.toLowerCase() === 'true';
                break;
            case 'characterfilterexclude':
            case 'character_exclusion':
                currentEntry.overrides.character_exclusion = t.value.toLowerCase() === 'true';
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
            
            folderNamesList.forEach(name => {
                const newId = 'folder_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                extensionSettings.folders[currentLorebookName].push({
                    id: newId,
                    name: name,
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
            let maxUid = 0;
            Object.keys(currentLorebookData.entries).forEach(uid => {
                if (parseInt(uid) > maxUid) maxUid = parseInt(uid);
            });

            for (let i = 0; i < count; i++) {
                maxUid++;
                const newUid = maxUid;
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

            await stContext.saveWorldInfo(currentLorebookName, currentLorebookData);
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
        let maxUid = 0;
        Object.keys(currentLorebookData.entries).forEach(uid => {
            if (parseInt(uid) > maxUid) maxUid = parseInt(uid);
        });

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
            maxUid++;
            const newUid = maxUid;
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

        await stContext.saveWorldInfo(currentLorebookName, currentLorebookData);
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
        let maxUid = 0;
        Object.keys(currentLorebookData.entries).forEach(uid => {
            if (parseInt(uid) > maxUid) maxUid = parseInt(uid);
        });

        for (const parsed of parsedEntries) {
            maxUid++;
            const newUid = maxUid;
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
                delayUntilRecursionLevel: ov.delayUntilRecursionLevel ?? 1,
                delay_until_recursion: ov.delay_until_recursion ?? false,
                ignoreBudget: ov.ignoreBudget ?? false,
                addMemo: ov.addMemo ?? false,
                useProbability: ov.useProbability ?? true,
                character_exclusion: ov.character_exclusion ?? false,
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

        await stContext.saveWorldInfo(currentLorebookName, currentLorebookData);
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

    els.batchModal.classList.add('active');
}

async function applyBatchOptions() {
    const applyOrder = document.getElementById('batch-apply-order').checked;
    const orderVal = parseInt(document.getElementById('batch-order-val').value);

    const applyFolder = document.getElementById('batch-apply-folder') ? document.getElementById('batch-apply-folder').checked : false;
    const folderVal = document.getElementById('batch-folder-val') ? document.getElementById('batch-folder-val').value : '';

    const applyStrategy = document.getElementById('batch-apply-strategy').checked;
    const strategySelect = document.getElementById('batch-strategy-val');
    const strategyOption = strategySelect.selectedOptions[0];

    const applyDepth = document.getElementById('batch-apply-depth').checked;
    const depthVal = parseInt(document.getElementById('batch-depth-val').value);

    const applyProb = document.getElementById('batch-apply-probability').checked;
    const probVal = parseInt(document.getElementById('batch-prob-val').value);

    const applyConstant = document.getElementById('batch-apply-constant').checked;
    const constantVal = document.getElementById('batch-constant-val').checked;

    const applyVectorized = document.getElementById('batch-apply-vectorized').checked;
    const vectorizedVal = document.getElementById('batch-vectorized-val').checked;

    const applySelective = document.getElementById('batch-apply-selective').checked;
    const selectiveVal = document.getElementById('batch-selective-val').checked;

    const applyLogic = document.getElementById('batch-apply-logic').checked;
    const logicVal = parseInt(document.getElementById('batch-logic-val').value);

    const applyDisable = document.getElementById('batch-apply-disable').checked;
    const disableVal = document.getElementById('batch-disable-val').checked;

    const applyAddMemo = document.getElementById('batch-apply-add-memo').checked;
    const addMemoVal = document.getElementById('batch-add-memo-val').checked;

    const applyExcludeRecursion = document.getElementById('batch-apply-exclude-recursion').checked;
    const excludeRecursionVal = document.getElementById('batch-exclude-recursion-val').checked;

    const applyPreventRecursion = document.getElementById('batch-apply-prevent-recursion').checked;
    const preventRecursionVal = document.getElementById('batch-prevent-recursion-val').checked;

    const applyOutletName = document.getElementById('batch-apply-outlet-name').checked;
    const outletNameVal = document.getElementById('batch-outlet-name-val').value;

    const applyGroup = document.getElementById('batch-apply-group').checked;
    const groupVal = document.getElementById('batch-group-val').value;

    const applyGroupWeight = document.getElementById('batch-apply-group-weight').checked;
    const groupWeightVal = parseInt(document.getElementById('batch-group-weight-val').value);

    const applyGroupOverride = document.getElementById('batch-apply-group-override').checked;
    const groupOverrideVal = document.getElementById('batch-group-override-val').checked;

    const applySticky = document.getElementById('batch-apply-sticky').checked;
    const stickyVal = parseInt(document.getElementById('batch-sticky-val').value);

    const applyCooldown = document.getElementById('batch-apply-cooldown').checked;
    const cooldownVal = parseInt(document.getElementById('batch-cooldown-val').value);

    const applyDelay = document.getElementById('batch-apply-delay').checked;
    const delayVal = parseInt(document.getElementById('batch-delay-val').value);

    const applyCharFilter = document.getElementById('batch-apply-char-filter').checked;
    const charFilterVal = document.getElementById('batch-char-filter-val').value;

    const applyTriggers = document.getElementById('batch-apply-triggers').checked;
    const triggersVal = document.getElementById('batch-triggers-val').value;

    const applyCharExclusion = document.getElementById('batch-apply-char-exclusion').checked;
    const charExclusionVal = document.getElementById('batch-char-exclusion-val').checked;

    const applyMatchCharDesc = document.getElementById('batch-apply-match-char-desc').checked;
    const matchCharDescVal = document.getElementById('batch-match-char-desc-val').checked;

    const applyMatchCharPers = document.getElementById('batch-apply-match-char-pers').checked;
    const matchCharPersVal = document.getElementById('batch-match-char-pers-val').checked;

    const applyMatchScenario = document.getElementById('batch-apply-match-scenario').checked;
    const matchScenarioVal = document.getElementById('batch-match-scenario-val').checked;

    const applyMatchPersona = document.getElementById('batch-apply-match-persona').checked;
    const matchPersonaVal = document.getElementById('batch-match-persona-val').checked;

    const applyMatchCharDepth = document.getElementById('batch-apply-match-char-depth').checked;
    const matchCharDepthVal = document.getElementById('batch-match-char-depth-val').checked;

    const applyMatchCreatorNotes = document.getElementById('batch-apply-match-creator-notes').checked;
    const matchCreatorNotesVal = document.getElementById('batch-match-creator-notes-val').checked;

    const applyScanDepth = document.getElementById('batch-apply-scan-depth').checked;
    const scanDepthRaw = document.getElementById('batch-scan-depth-val').value;

    const applyRecursionLevel = document.getElementById('batch-apply-recursion-level').checked;
    const recursionLevelVal = parseInt(document.getElementById('batch-recursion-level-val').value);

    const parseNullBool = (v) => v === 'true' ? true : (v === 'false' ? false : null);

    const applyCaseSensitive = document.getElementById('batch-apply-case-sensitive').checked;
    const caseSensitiveVal = parseNullBool(document.getElementById('batch-case-sensitive-val').value);

    const applyWholeWords = document.getElementById('batch-apply-whole-words').checked;
    const wholeWordsVal = parseNullBool(document.getElementById('batch-whole-words-val').value);

    const applyGroupScoring = document.getElementById('batch-apply-group-scoring').checked;
    const groupScoringVal = parseNullBool(document.getElementById('batch-group-scoring-val').value);

    const applyAutomationId = document.getElementById('batch-apply-automation-id').checked;
    const automationIdVal = document.getElementById('batch-automation-id-val').value;

    const applyDelayRecursion = document.getElementById('batch-apply-delay-recursion').checked;
    const delayRecursionVal = document.getElementById('batch-delay-recursion-val').checked;

    const applyIgnoreBudget = document.getElementById('batch-apply-ignore-budget').checked;
    const ignoreBudgetVal = document.getElementById('batch-ignore-budget-val').checked;

    selectedEntries.forEach(uid => {
        const entry = currentLorebookData.entries[uid];
        if (!entry) return;

        if (applyOrder && !isNaN(orderVal)) entry.order = orderVal;
        if (applyStrategy && strategyOption) {
            entry.position = parseInt(strategyOption.value);
            entry.role = strategyOption.dataset.role !== '' ? parseInt(strategyOption.dataset.role) : (entry.role ?? null);
        }
        if (applyDepth && !isNaN(depthVal)) entry.depth = depthVal;
        if (applyProb && !isNaN(probVal)) entry.probability = probVal;
        if (applyConstant) { entry.constant = constantVal; if (constantVal) entry.vectorized = false; }
        if (applyVectorized) { entry.vectorized = vectorizedVal; if (vectorizedVal) entry.constant = false; }
        if (applySelective) entry.selective = selectiveVal;
        if (applyLogic) entry.selectiveLogic = logicVal;
        if (applyDisable) entry.disable = disableVal;
        if (applyAddMemo) entry.addMemo = addMemoVal;
        if (applyExcludeRecursion) entry.excludeRecursion = excludeRecursionVal;
        if (applyPreventRecursion) entry.preventRecursion = preventRecursionVal;
        if (applyOutletName) entry.outletName = outletNameVal;
        if (applyGroup) entry.group = groupVal;
        if (applyGroupWeight && !isNaN(groupWeightVal)) entry.groupWeight = groupWeightVal;
        if (applyGroupOverride) entry.groupOverride = groupOverrideVal;
        if (applySticky && !isNaN(stickyVal)) entry.sticky = stickyVal;
        if (applyCooldown && !isNaN(cooldownVal)) entry.cooldown = cooldownVal;
        if (applyDelay && !isNaN(delayVal)) entry.delay = delayVal;
        if (applyCharFilter) entry.characterFilter = charFilterVal ? charFilterVal.split(',').map(s => s.trim()).filter(Boolean) : [];
        if (applyTriggers) entry.triggers = triggersVal ? triggersVal.split(',').map(s => s.trim()).filter(Boolean) : [];
        if (applyCharExclusion) entry.character_exclusion = charExclusionVal;
        if (applyMatchCharDesc) entry.matchCharacterDescription = matchCharDescVal;
        if (applyMatchCharPers) entry.matchCharacterPersonality = matchCharPersVal;
        if (applyMatchScenario) entry.matchScenario = matchScenarioVal;
        if (applyMatchPersona) entry.matchPersonaDescription = matchPersonaVal;
        if (applyMatchCharDepth) entry.matchCharacterDepthPrompt = matchCharDepthVal;
        if (applyMatchCreatorNotes) entry.matchCreatorNotes = matchCreatorNotesVal;
        if (applyScanDepth) entry.scanDepth = scanDepthRaw === '' ? null : parseInt(scanDepthRaw);
        if (applyRecursionLevel && !isNaN(recursionLevelVal)) entry.delayUntilRecursionLevel = recursionLevelVal;
        if (applyCaseSensitive) entry.caseSensitive = caseSensitiveVal;
        if (applyWholeWords) entry.matchWholeWords = wholeWordsVal;
        if (applyGroupScoring) entry.useGroupScoring = groupScoringVal;
        if (applyAutomationId) entry.automationId = automationIdVal;
        if (applyDelayRecursion) entry.delay_until_recursion = delayRecursionVal;
        if (applyIgnoreBudget) entry.ignoreBudget = ignoreBudgetVal;
    });

    if (applyFolder) {
        // Remove from all folders first
        const folders = extensionSettings.folders[currentLorebookName] || [];
        folders.forEach(f => {
            f.entries = f.entries.filter(uid => !selectedEntries.has(String(uid)));
        });

        // Add to selected folder
        if (folderVal) {
            const target = folders.find(f => f.id === folderVal);
            if (target) {
                target.entries.push(...Array.from(selectedEntries).map(String));
            }
        }
        saveSettings();
    }

    await stContext.saveWorldInfo(currentLorebookName, currentLorebookData);
    els.batchModal.classList.remove('active');
    renderEntries();
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
        document.getElementById('edit-character-filter').value = safeJoin(entry.characterFilter, ', ');
        document.getElementById('edit-triggers').value = safeJoin(entry.triggers, ', ');
        document.getElementById('edit-character-exclusion').checked = !!entry.character_exclusion;

        document.getElementById('edit-match-char-desc').checked = !!entry.matchCharacterDescription;
        document.getElementById('edit-match-char-pers').checked = !!entry.matchCharacterPersonality;
        document.getElementById('edit-match-scenario').checked = !!entry.matchScenario;
        document.getElementById('edit-match-persona').checked = !!entry.matchPersonaDescription;
        document.getElementById('edit-match-char-depth').checked = !!entry.matchCharacterDepthPrompt;
        document.getElementById('edit-match-creator-notes').checked = !!entry.matchCreatorNotes;

        document.getElementById('edit-scan-depth').value = entry.scanDepth !== undefined && entry.scanDepth !== null ? entry.scanDepth : '';
        document.getElementById('edit-recursion-level').value = entry.delayUntilRecursionLevel ?? 1;

        document.getElementById('edit-case-sensitive').value = entry.caseSensitive === true ? 'true' : (entry.caseSensitive === false ? 'false' : 'null');
        document.getElementById('edit-whole-words').value = entry.matchWholeWords === true ? 'true' : (entry.matchWholeWords === false ? 'false' : 'null');
        document.getElementById('edit-use-group-scoring').value = entry.useGroupScoring === true ? 'true' : (entry.useGroupScoring === false ? 'false' : 'null');

        document.getElementById('edit-automation-id').value = entry.automationId || '';
        document.getElementById('edit-delay-recursion').checked = !!entry.delay_until_recursion;
        document.getElementById('edit-ignore-budget').checked = !!entry.ignoreBudget;

        document.getElementById('edit-entry-modal').classList.add('active');
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
    saveSettings();

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

    entry.delay = parseInt(document.getElementById('edit-delay').value) || 0;

    entry.constant = document.getElementById('edit-constant').checked;
    entry.vectorized = document.getElementById('edit-vectorized').checked;
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

    const charFilterStr = document.getElementById('edit-character-filter').value;
    entry.characterFilter = charFilterStr ? charFilterStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    const triggerStr = document.getElementById('edit-triggers').value;
    entry.triggers = triggerStr ? triggerStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    entry.character_exclusion = document.getElementById('edit-character-exclusion').checked;

    entry.matchCharacterDescription = document.getElementById('edit-match-char-desc').checked;
    entry.matchCharacterPersonality = document.getElementById('edit-match-char-pers').checked;
    entry.matchScenario = document.getElementById('edit-match-scenario').checked;
    entry.matchPersonaDescription = document.getElementById('edit-match-persona').checked;
    entry.matchCharacterDepthPrompt = document.getElementById('edit-match-char-depth').checked;
    entry.matchCreatorNotes = document.getElementById('edit-match-creator-notes').checked;

    const scanDepthVal = document.getElementById('edit-scan-depth').value;
    entry.scanDepth = scanDepthVal === '' ? null : parseInt(scanDepthVal);

    entry.delayUntilRecursionLevel = parseInt(document.getElementById('edit-recursion-level').value);
    if (isNaN(entry.delayUntilRecursionLevel)) entry.delayUntilRecursionLevel = 1;

    const parseNullBool = (v) => v === 'true' ? true : (v === 'false' ? false : null);
    entry.caseSensitive = parseNullBool(document.getElementById('edit-case-sensitive').value);
    entry.matchWholeWords = parseNullBool(document.getElementById('edit-whole-words').value);
    entry.useGroupScoring = parseNullBool(document.getElementById('edit-use-group-scoring').value);

    entry.automationId = document.getElementById('edit-automation-id').value;
    entry.delay_until_recursion = document.getElementById('edit-delay-recursion').checked;
    entry.ignoreBudget = document.getElementById('edit-ignore-budget').checked;

    await stContext.saveWorldInfo(currentLorebookName, currentLorebookData);
    document.getElementById('edit-entry-modal').classList.remove('active');
    renderEntries();
}

// ==========================================
// Context Menu
// ==========================================
let duplicateWorldInfoEntry = null;
let moveWorldInfoEntry = null;

function getFreeWorldEntryUid(data) {
    if (!data || !('entries' in data)) {
        return null;
    }
    const MAX_UID = 1000000;
    for (let uid = 0; uid < MAX_UID; uid++) {
        if (uid in data.entries) {
            continue;
        }
        return uid;
    }
    return null;
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
        if (duplicateWorldInfoEntry && currentLorebookData.entries[entryUid]) {
            const newEntry = duplicateWorldInfoEntry(currentLorebookData, entryUid);
            if (newEntry) {
                newFolder.entries.push(String(newEntry.uid));
            }
        } else {
            const originalEntry = currentLorebookData.entries[entryUid];
            if (originalEntry) {
                const newUid = getFreeWorldEntryUid(currentLorebookData);
                if (newUid !== null) {
                    currentLorebookData.entries[newUid] = {
                        ...structuredClone(originalEntry),
                        uid: newUid
                    };
                    newFolder.entries.push(String(newUid));
                }
            }
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
    if (!f) return null;
    
    const newFolderId = 'folder_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const newFolder = {
        id: newFolderId,
        name: f.name,
        parentId: targetParentId,
        order: f.order ?? 100,
        entries: []
    };
    
    for (const entryUid of f.entries) {
        const originalEntry = currentLorebookData.entries[entryUid];
        if (originalEntry) {
            if (moveWorldInfoEntry) {
                const beforeKeys = new Set(Object.keys(targetData.entries));
                await moveWorldInfoEntry(currentLorebookName, targetBook, entryUid, { deleteOriginal: isMove });
                const updatedTargetData = await stContext.loadWorldInfo(targetBook);
                Object.assign(targetData.entries, updatedTargetData.entries);
                const newUid = Object.keys(targetData.entries).find(uid => !beforeKeys.has(uid));
                if (newUid) {
                    newFolder.entries.push(String(newUid));
                }
            } else {
                targetData.entries[entryUid] = originalEntry;
                const newEntry = duplicateWorldInfoEntry ? duplicateWorldInfoEntry(targetData, entryUid) : null;
                delete targetData.entries[entryUid];
                
                if (newEntry) {
                    newFolder.entries.push(String(newEntry.uid));
                } else {
                    const newUid = getFreeWorldEntryUid(targetData);
                    if (newUid !== null) {
                        targetData.entries[newUid] = {
                            ...structuredClone(originalEntry),
                            uid: newUid
                        };
                        newFolder.entries.push(String(newUid));
                    }
                }
            }
        }
    }
    
    extensionSettings.folders[targetBook].push(newFolder);
    
    const subfolders = folders.filter(x => x.parentId === folderId);
    for (const sub of subfolders) {
        await sendFolderToLorebookHelper(sub.id, targetBook, targetData, newFolderId, isMove);
    }
    
    if (isMove) {
        if (!moveWorldInfoEntry) {
            for (const entryUid of f.entries) {
                delete currentLorebookData.entries[entryUid];
            }
        } else {
            const updatedSourceData = await stContext.loadWorldInfo(currentLorebookName);
            currentLorebookData.entries = updatedSourceData.entries;
        }
        extensionSettings.folders[currentLorebookName] = folders.filter(x => x.id !== folderId);
    }
    
    return newFolderId;
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
            for (const uid of selectedEntries) {
                if (duplicateWorldInfoEntry && currentLorebookData.entries[uid]) {
                    const newEntry = duplicateWorldInfoEntry(currentLorebookData, uid);
                    if (newEntry) {
                        newUids.push({ original: uid, duplicate: String(newEntry.uid) });
                    }
                } else {
                    const originalEntry = currentLorebookData.entries[uid];
                    if (originalEntry) {
                        const newUid = getFreeWorldEntryUid(currentLorebookData);
                        if (newUid !== null) {
                            currentLorebookData.entries[newUid] = {
                                ...structuredClone(originalEntry),
                                uid: newUid
                            };
                            newUids.push({ original: uid, duplicate: String(newUid) });
                        }
                    }
                }
            }
            // Add duplicated entries to the same folders
            const folders = extensionSettings.folders[currentLorebookName] || [];
            newUids.forEach(({ original, duplicate }) => {
                const folder = folders.find(f => f.entries.map(String).includes(String(original)));
                if (folder) {
                    folder.entries.push(duplicate);
                }
            });
            saveSettings();
            await stContext.saveWorldInfo(currentLorebookName, currentLorebookData);
            selectedEntries.clear();
            updateBatchButton();
            renderEntries();
        });
        els.contextMenu.appendChild(dupItem);

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
                selectedEntries.forEach(uid => {
                    delete currentLorebookData.entries[uid];
                    const folders = extensionSettings.folders[currentLorebookName] || [];
                    folders.forEach(f => f.entries = f.entries.filter(e => String(e) !== String(uid)));
                });
                saveSettings();
                await stContext.saveWorldInfo(currentLorebookName, currentLorebookData);
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
            await stContext.saveWorldInfo(currentLorebookName, currentLorebookData);
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

    const searchInput = content.querySelector('#send-lorebook-search');
    const listContainer = content.querySelector('#send-lorebook-list');

    async function executeSend(targetBook) {
        const actionRadio = content.querySelector('input[name="send-lorebook-action"]:checked');
        const isMove = actionRadio && actionRadio.value === 'move';

        if (type === 'entry') {
            for (const uid of targetIds) {
                if (moveWorldInfoEntry) {
                    await moveWorldInfoEntry(currentLorebookName, targetBook, uid, { deleteOriginal: isMove });
                } else {
                    const targetData = await stContext.loadWorldInfo(targetBook);
                    const originalEntry = currentLorebookData.entries[uid];
                    if (originalEntry) {
                        targetData.entries[uid] = originalEntry;
                        const newEntry = duplicateWorldInfoEntry ? duplicateWorldInfoEntry(targetData, uid) : null;
                        delete targetData.entries[uid];
                        if (!newEntry) {
                            const newUid = getFreeWorldEntryUid(targetData);
                            if (newUid !== null) {
                                targetData.entries[newUid] = {
                                    ...structuredClone(originalEntry),
                                    uid: newUid
                                };
                            }
                        }
                    }
                    await stContext.saveWorldInfo(targetBook, targetData);
                    if (isMove) {
                        delete currentLorebookData.entries[uid];
                    }
                }
                if (isMove) {
                    const folders = extensionSettings.folders[currentLorebookName] || [];
                    folders.forEach(f => f.entries = f.entries.filter(e => String(e) !== String(uid)));
                }
            }
            if (isMove) {
                saveSettings();
                if (!moveWorldInfoEntry) {
                    await stContext.saveWorldInfo(currentLorebookName, currentLorebookData);
                } else {
                    const updatedSourceData = await stContext.loadWorldInfo(currentLorebookName);
                    currentLorebookData.entries = updatedSourceData.entries;
                }
            }
        } else if (type === 'folder') {
            const targetData = await stContext.loadWorldInfo(targetBook);
            for (const folderId of targetIds) {
                await sendFolderToLorebookHelper(folderId, targetBook, targetData, null, isMove);
            }
            if (!moveWorldInfoEntry) {
                await stContext.saveWorldInfo(targetBook, targetData);
            }
            if (isMove) {
                saveSettings();
                if (!moveWorldInfoEntry) {
                    await stContext.saveWorldInfo(currentLorebookName, currentLorebookData);
                } else {
                    const updatedSourceData = await stContext.loadWorldInfo(currentLorebookName);
                    currentLorebookData.entries = updatedSourceData.entries;
                }
            }
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
                overlay.remove();
                await executeSend(name);
            });
            listContainer.appendChild(item);
        });
    }

    renderLorebookList();

    searchInput.addEventListener('input', () => renderLorebookList(searchInput.value));
    searchInput.addEventListener('keydown', (e) => e.stopPropagation());

    content.querySelector('.close-modal').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
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

    saveSettings();
    renderEntries();
}

// ==========================================
// Event Listeners & Utilities
// ==========================================
function setupEventListeners() {
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

        extensionSettings.templates[name] = activeGlobals;
        saveSettings();
        renderTemplatesList();
    });

    // Toolbar
    if (els.btnAddItem) {
        els.btnAddItem.addEventListener('click', () => openAddItemModal(null));
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

    // Search Entries - Auto-toggle Sort mode to Relevance
    let previousSortMode = 'order_desc';
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
        renderEntries();
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
                modal.classList.remove('active');
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
        document.documentElement.style.removeProperty('--bg-color');
        document.documentElement.style.removeProperty('--panel-bg');
        document.documentElement.style.removeProperty('--text-color');
        document.documentElement.style.removeProperty('--primary-color');
        openSettings();
    });

    // Batch Edit
    document.getElementById('btn-apply-batch').addEventListener('click', applyBatchOptions);

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
    const navConfig = document.getElementById('nav-agent-config');
    if (navConfig) {
        navConfig.addEventListener('click', function () { switchToView('agent-config'); });
    }

    const navFeed = document.getElementById('nav-agent-feed');
    if (navFeed) {
        navFeed.addEventListener('click', function () { switchToView('agent-feed'); });
    }
}

function switchToView(view) {
    currentViewMode = view;
    els.entriesContainer.classList.add('hidden');
    document.querySelectorAll('.agent-sidebar-item').forEach(i => i.classList.remove('active'));
    els.mainToolbar.style.display = 'none';

    const configPanel = document.getElementById('agent-config-panel');
    const feedPanel = document.getElementById('agent-feed-panel');
    if (configPanel) configPanel.classList.add('hidden');
    if (feedPanel) feedPanel.classList.add('hidden');

    if (view === 'agent-config') {
        const nav = document.getElementById('nav-agent-config');
        if (nav) nav.classList.add('active');
        if (configPanel) configPanel.classList.remove('hidden');
        els.currentTitle.textContent = 'Agent Configuration';
    } else if (view === 'agent-feed') {
        const nav = document.getElementById('nav-agent-feed');
        if (nav) nav.classList.add('active');
        if (feedPanel) feedPanel.classList.remove('hidden');
        els.currentTitle.textContent = 'Agent Feed';
        if (typeof loadProposalsForCurrentChat === 'function') {
            loadProposalsForCurrentChat();
        }
    }
}

function escapeHtml(unsafe) {
    return (unsafe || '').toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Start app
window.addEventListener('load', init);
