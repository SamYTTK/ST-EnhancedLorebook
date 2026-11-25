/**
 * Editor-panel UI for Enhanced Lorebook plugins.
 *
 * Plugins never write to lorebooks. This module gathers the user's choices,
 * asks the plugin for plain items, then performs ONE guarded save through the
 * same path as every other entry edit. Remote plugins (registered in the host
 * window by another extension via the SDK) are listed/run over the bridge.
 */
(function () {
    'use strict';
    var EL = window.EL = window.EL || {};
    var registry = window.ELPluginRegistry;
    if (!registry) {
        EL.plugins = { apiVersion: 0, list: function () { return []; }, run: function () { return Promise.reject(new Error('plugin registry unavailable')); } };
        return;
    }
    EL.plugins = registry;

    var remotePlugins = [];
    var _seq = 0;

    function escapeSafe(value) {
        try { return escapeHtml(String(value == null ? '' : value)); } catch (e) { return String(value == null ? '' : value); }
    }

    function isLocal(id) { return !!registry.get(id); }

    async function refresh() {
        try {
            if (typeof EL_bridgeRequest !== 'function') return;
            var res = await EL_bridgeRequest('el-plugin-list-request', {}, 5000);
            remotePlugins = (res && !res.noHost && !res.timeout && Array.isArray(res.plugins)) ? res.plugins : [];
        } catch (e) {
            remotePlugins = [];
        }
    }

    function all() {
        var seen = {};
        var out = registry.list().map(function (p) { seen[p.id] = true; return p; });
        remotePlugins.forEach(function (p) {
            if (!p || !p.id || seen[p.id]) return;
            seen[p.id] = true;
            out.push(p);
        });
        return out;
    }

    async function run(id, ctx) {
        if (isLocal(id)) return registry.run(id, ctx);
        if (typeof EL_bridgeRequest !== 'function') throw new Error('bridge unavailable');
        var res = await EL_bridgeRequest('el-plugin-run-request', { id: id, ctx: ctx }, 30000);
        if (!res || res.noHost || res.timeout) throw new Error('host did not answer');
        if (!res.ok) throw new Error(res.error || 'plugin failed');
        return res.result;
    }

    function render() {
        var host = document.getElementById('el-plugins-list');
        if (!host) return;
        var list = all();
        if (!list.length) {
            host.innerHTML = '<div style="opacity:0.7;font-size:0.85rem;">No plugins registered.</div>';
            return;
        }
        host.innerHTML = list.map(function (p) {
            return '<button type="button" class="btn btn-secondary btn-sm el-plugin-run" data-plugin-id="' + escapeSafe(p.id) + '" style="margin:0 6px 6px 0;">'
                + '<i class="fa-solid ' + escapeSafe(p.icon || 'fa-puzzle-piece') + '"></i> ' + escapeSafe(p.title || p.name || p.id)
                + '</button>';
        }).join('');
        host.querySelectorAll('.el-plugin-run').forEach(function (btn) {
            btn.addEventListener('click', function () { open(btn.getAttribute('data-plugin-id')); });
        });
    }

    function makeOverlay(id, title, bodyHtml, footerHtml) {
        var overlay = document.createElement('div');
        overlay.className = 'modal active';
        overlay.id = id;
        var content = document.createElement('div');
        content.className = 'modal-content glass-panel';
        content.style.width = '520px';
        content.style.maxWidth = '92vw';
        content.style.maxHeight = '88vh';
        content.style.display = 'flex';
        content.style.flexDirection = 'column';
        content.innerHTML = '<div class="modal-header"><h3>' + escapeSafe(title) + '</h3>'
            + '<button class="close-modal"><i class="fa-solid fa-xmark"></i></button></div>'
            + '<div class="modal-body" style="overflow-y:auto;flex:1;">' + bodyHtml + '</div>'
            + (footerHtml ? '<div class="modal-actions" style="padding:12px 16px;">' + footerHtml + '</div>' : '');
        overlay.appendChild(content);
        document.body.appendChild(overlay);
        EL_modalOpen(overlay);
        function close() {
            try { EL_modalClose(overlay); } catch (e) {}
            try { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); } catch (e) {}
        }
        var x = content.querySelector('.close-modal');
        if (x) x.addEventListener('click', close);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
        return { overlay: overlay, content: content, close: close };
    }

    async function open(id) {
        var sourceUid = String((document.getElementById('edit-entry-uid') || {}).value || '');
        var entry = currentLorebookData && currentLorebookData.entries && currentLorebookData.entries[sourceUid];
        if (!entry) {
            try { EL_toast('Save or select an entry before running a plugin.', 'warning'); } catch (e) {}
            return;
        }
        var descriptor = null;
        all().forEach(function (p) { if (p.id === id) descriptor = p; });
        if (!descriptor) return;

        var first = makeOverlay('el-plugin-start-' + (++_seq), 'Plugin: ' + (descriptor.title || descriptor.name || id),
            '<p style="opacity:0.8;font-size:0.9rem;">Format the memories in this entry into separate entries. Choose the number to start the new <code>&lt;Memory_N&gt;</code> blocks at.</p>'
            + '<div class="form-group"><label>Start at</label><input type="number" id="el-plugin-start-num" min="1" value="1"></div>',
            '<button type="button" class="btn btn-primary" id="el-plugin-start-go">Continue</button>'
            + '<button type="button" class="btn btn-secondary" id="el-plugin-start-cancel">Cancel</button>');

        var go = first.content.querySelector('#el-plugin-start-go');
        var cancel = first.content.querySelector('#el-plugin-start-cancel');
        if (cancel) cancel.addEventListener('click', first.close);
        if (!go) return;
        go.addEventListener('click', async function () {
            var input = first.content.querySelector('#el-plugin-start-num');
            var startAt = Math.max(1, parseInt((input && input.value) || 1, 10) || 1);
            go.disabled = true;
            go.textContent = 'Processing…';
            var result;
            try {
                result = await run(id, {
                    sourceUid: sourceUid,
                    sourceContent: String(entry.content || ''),
                    bookName: currentLorebookName,
                    startAt: startAt,
                });
            } catch (e) {
                first.close();
                try { EL_toast('Plugin failed: ' + (e && e.message ? e.message : String(e)), 'error'); } catch (_) {}
                return;
            }
            first.close();
            if (!result || !Array.isArray(result.items) || !result.items.length) {
                try { EL_toast('No <Memory_X> blocks found in this entry.', 'warning'); } catch (_) {}
                return;
            }
            showDestination(result, descriptor, sourceUid, entry);
        });
    }

    function fieldHtml(def) {
        var id = 'el-plugin-opt-' + def.id;
        if (def.type === 'check') {
            return '<div class="form-group row" style="margin-bottom:0;"><input type="checkbox" id="' + id + '"' + (def.checked ? ' checked' : '') + '><label for="' + id + '">' + escapeSafe(def.label) + '</label></div>';
        }
        if (def.type === 'select') {
            return '<div class="form-group"><label>' + escapeSafe(def.label) + '</label><select id="' + id + '">'
                + def.options.map(function (o) { return '<option value="' + escapeSafe(o.value) + '"' + (o.value === String(def.value) ? ' selected' : '') + '>' + escapeSafe(o.label) + '</option>'; }).join('')
                + '</select></div>';
        }
        return '<div class="form-group"><label>' + escapeSafe(def.label) + '</label><input type="' + (def.type || 'text') + '" id="' + id + '" value="' + escapeSafe(def.value == null ? '' : def.value) + '"></div>';
    }

    var POSITION_OPTIONS = [
        { value: '0', label: '↑Char' }, { value: '1', label: '↓Char' },
        { value: '5', label: '↑EM' }, { value: '6', label: '↓EM' },
        { value: '2', label: '↑AN' }, { value: '3', label: '↓AN' },
        { value: '4|0', label: '@D System' }, { value: '4|1', label: '@D User' },
        { value: '4|2', label: '@D Assistant' }, { value: '7', label: '➡️ Outlet' },
    ];

    function showDestination(result, descriptor, sourceUid, sourceEntry) {
        var folders = ((extensionSettings && extensionSettings.folders && extensionSettings.folders[currentLorebookName]) || []);
        var folderOptions = '<option value="">-- No Folder (Root) --</option>' + folders.map(function (f) {
            var label = f.name || f.id;
            try { label = getFolderPathName(f.id); } catch (e) {}
            return '<option value="' + escapeSafe(f.id) + '">' + escapeSafe(label) + '</option>';
        }).join('');

        var definitions = [
            { id: 'folder', label: 'Folder / group', type: 'select', options: [{ value: '', label: '-- No Folder (Root) --' }].concat(folders.map(function (f) { return { value: f.id, label: (function () { try { return getFolderPathName(f.id); } catch (e) { return f.name || f.id; } })() }; })) },
            { id: 'vectorized', label: 'Vectorized', type: 'check' },
            { id: 'exclude', label: 'Exclude Recursion', type: 'check' },
            { id: 'prevent', label: 'Prevent Recursion', type: 'check' },
            { id: 'disable', label: 'Disabled', type: 'check' },
            { id: 'constant', label: 'Constant', type: 'check' },
            { id: 'selective', label: 'Selective', type: 'check', checked: true },
            { id: 'use-probability', label: 'Use Probability', type: 'check', checked: true },
            { id: 'order', label: 'Sort Order', type: 'number', value: 100 },
            { id: 'position', label: 'Insertion Strategy', type: 'select', options: POSITION_OPTIONS, value: '0' },
            { id: 'depth', label: 'Insertion Depth', type: 'number', value: 4 },
            { id: 'probability', label: 'Trigger Probability (%)', type: 'number', value: 100 },
            { id: 'group', label: 'Inclusion Group', type: 'text', value: '' },
            { id: 'sticky', label: 'Sticky (turns)', type: 'number', value: 0 },
            { id: 'cooldown', label: 'Cooldown (turns)', type: 'number', value: 0 },
            { id: 'delay', label: 'Delay (turns)', type: 'number', value: 0 },
        ];

        var second = makeOverlay('el-plugin-dest-' + (++_seq), 'Create ' + result.items.length + ' entries',
            '<p style="opacity:0.8;font-size:0.9rem;">These settings are applied to every new entry. The source entry will be <strong>disabled</strong>.</p>'
            + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' + definitions.map(fieldHtml).join('') + '</div>',
            '<button type="button" class="btn btn-primary" id="el-plugin-dest-go">Create entries</button>'
            + '<button type="button" class="btn btn-secondary" id="el-plugin-dest-cancel">Cancel</button>');

        // The folder select is built from the real folder list above; replace the
        // placeholder one generated by fieldHtml so nested paths are preserved.
        var folderEl = second.content.querySelector('#el-plugin-opt-folder');
        if (folderEl) folderEl.innerHTML = folderOptions;

        var cancel = second.content.querySelector('#el-plugin-dest-cancel');
        if (cancel) cancel.addEventListener('click', second.close);
        var go = second.content.querySelector('#el-plugin-dest-go');
        if (!go) return;
        go.addEventListener('click', async function () {
            var settings = readSettings(second.content, definitions);
            go.disabled = true;
            go.textContent = 'Saving…';
            await new Promise(function (resolve) {
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { setTimeout(resolve, 0); });
                else setTimeout(resolve, 0);
            });
            var ok = await createEntries(result.items, settings, sourceUid, descriptor);
            second.close();
            if (!ok) return;
            // The source entry is now disabled on disk. Closing the editor and
            // clearing its dirty flag prevents a later "Save Entry" from writing
            // the stale unchecked disable value back over the plugin's change.
            try { EL_modalClose('edit-entry-modal'); } catch (e) {}
            try { _elEntryDirty = false; } catch (e) {}
            try { renderEntries(); } catch (e) {}
            try { EL_toast('Created ' + result.items.length + ' entries with ' + (descriptor.title || descriptor.name) + '.', 'success'); } catch (e) {}
        });
    }

    function readSettings(root, definitions) {
        var out = {};
        definitions.forEach(function (def) {
            var node = root.querySelector('#el-plugin-opt-' + def.id);
            if (!node) return;
            if (def.type === 'check') out[def.id] = !!node.checked;
            else if (def.type === 'number') out[def.id] = parseInt(node.value, 10);
            else if (def.id === 'position') {
                // @D variants encode their role as "4|<role>", like the editor's
                // data-role options. Never flatten them into plain @D System.
                var bits = String(node.value || '0').split('|');
                out.position = bits[0];
                out.positionRole = bits.length > 1 ? parseInt(bits[1], 10) : null;
            } else out[def.id] = String(node.value || '');
        });
        // Constant and vectorized are mutually exclusive in SillyTavern.
        if (out.constant) out.vectorized = false;
        return out;
    }

    async function createEntries(items, settings, sourceUid, descriptor) {
        var data = currentLorebookData;
        if (!data || !data.entries || !data.entries[sourceUid]) {
            try { EL_toast('Source entry is gone — nothing created.', 'error'); } catch (e) {}
            return false;
        }
        var folders = ((extensionSettings && extensionSettings.folders && extensionSettings.folders[currentLorebookName]) || []);
        var targetFolder = folders.find(function (f) { return f && f.id === settings.folder; }) || null;
        var added = [];
        var maxDisplay = Object.keys(data.entries).reduce(function (max, key) {
            return Math.max(max, Number((data.entries[key] || {}).displayIndex) || 0);
        }, 0);
        var prevDisable = !!data.entries[sourceUid].disable;

        for (var i = 0; i < items.length; i++) {
            var uid = getFreeWorldEntryUid(data);
            if (uid === null) break;
            // EL_ENTRY_DEFAULTS is frozen and shared — never mutate it. Copy into
            // a fresh object before writing the new entry's fields.
            var base = EL_batchDefaults ? Object.assign({}, EL_batchDefaults()) : {};
            var position = parseInt(settings.position, 10);
            var role = (position === 4 && settings.positionRole != null) ? settings.positionRole : null;
            var entry = Object.assign({}, base, {
                uid: String(uid),
                comment: String(items[i].comment || ''),
                key: Array.isArray(items[i].key) ? items[i].key : [],
                keysecondary: [],
                content: String(items[i].content || ''),
                order: Number.isFinite(settings.order) ? settings.order : 100,
                position: Number.isFinite(position) ? position : 0,
                role: role,
                depth: Number.isFinite(settings.depth) ? settings.depth : 4,
                probability: Number.isFinite(settings.probability) ? settings.probability : 100,
                useProbability: !!settings['use-probability'],
                constant: !!settings.constant,
                vectorized: !!settings.vectorized,
                selective: !!settings.selective,
                disable: !!settings.disable,
                excludeRecursion: !!settings.exclude,
                preventRecursion: !!settings.prevent,
                group: String(settings.group || ''),
                sticky: Number.isFinite(settings.sticky) ? settings.sticky : 0,
                cooldown: Number.isFinite(settings.cooldown) ? settings.cooldown : 0,
                delay: Number.isFinite(settings.delay) ? settings.delay : 0,
                displayIndex: ++maxDisplay,
            });
            data.entries[String(uid)] = entry;
            added.push(String(uid));
        }
        if (!added.length) {
            try { EL_toast('No free UIDs available — nothing created.', 'error'); } catch (e) {}
            return false;
        }
        if (targetFolder) {
            if (!Array.isArray(targetFolder.entries)) targetFolder.entries = [];
            added.forEach(function (uid) { targetFolder.entries.push(uid); });
        }
        data.entries[sourceUid].disable = true;

        var ok = false;
        try {
            ok = await ELG_guardSave(currentLorebookName, data, {
                explicitDelete: false,
                source: 'user',
                note: 'Plugin ' + ((descriptor && (descriptor.title || descriptor.name)) || 'plugin'),
            });
        } catch (e) { ok = false; }

        if (!ok) {
            // Roll back every local mutation: the guard refused the write.
            added.forEach(function (uid) { delete data.entries[uid]; });
            if (targetFolder && Array.isArray(targetFolder.entries)) {
                targetFolder.entries = targetFolder.entries.filter(function (uid) { return added.indexOf(String(uid)) === -1; });
            }
            data.entries[sourceUid].disable = prevDisable;
            try { EL_toast('Save blocked — nothing was created.', 'error'); } catch (e) {}
            try { var fresh = await ELG_loadFresh(currentLorebookName); if (fresh) EL_setLorebookData(fresh, { own: true }); } catch (e) {}
            return false;
        }
        try {
            sync.lastSave[currentLorebookName] = Date.now();
            var sig = entriesSignature(data);
            sync.poll.entriesSig = sig;
            sync.poll.entriesBook = currentLorebookName;
            sync.signatures.entries = sig;
        } catch (e) {}
        try { saveSettings(); } catch (e) {}
        return true;
    }

    EL.pluginsUI = {
        refresh: refresh,
        render: function () { refresh().then(render); },
        open: open,
    };
    window.EL_pluginsRender = function () { try { EL.pluginsUI.render(); } catch (e) {} };
    window.EL_pluginsCreateEntries = createEntries;
})();
