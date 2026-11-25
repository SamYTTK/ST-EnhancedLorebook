/**
 * Shared, UI-free plugin registry for Enhanced Lorebook.
 *
 * Loaded by BOTH windows:
 *  - host: index.js publishes it as window.EL.plugins so other extensions can
 *    register a plugin through the SDK wrapper;
 *  - app:  app/plugins-ui.js uses the same object for the editor panel list.
 *
 * A plugin is a transformation: run(ctx) -> { items: [{comment, key, content, order}] }.
 * It never writes to a lorebook. The hub owns the UI and the guarded save.
 * This file is deliberately additive and has no dependency on app.js or el.js.
 */
(function () {
    'use strict';
    var registry = window.ELPluginRegistry = window.ELPluginRegistry || {};
    var plugins = new Map();

    registry.apiVersion = 1;

    /**
     * Register a plugin. Existing ids are replaced so an extension can hot-reload
     * its own descriptor; no other registry state is touched.
     * @param {{id:string,name?:string,title?:string,icon?:string,run:Function}} descriptor
     * @returns {string} the registered id
     */
    registry.register = function register(descriptor) {
        if (!descriptor || typeof descriptor !== 'object') throw new Error('EL plugin: descriptor must be an object');
        var id = String(descriptor.id || '').trim();
        if (!id) throw new Error('EL plugin: id is required');
        if (typeof descriptor.run !== 'function') throw new Error('EL plugin: run(ctx) must be a function');
        var name = String(descriptor.name || descriptor.title || id);
        plugins.set(id, {
            id: id,
            name: name,
            title: String(descriptor.title || name),
            icon: String(descriptor.icon || 'fa-puzzle-piece'),
            run: descriptor.run,
            source: 'local',
        });
        return id;
    };

    /** Metadata only — safe to postMessage to the other window. */
    registry.list = function list() {
        var out = [];
        plugins.forEach(function (p) {
            out.push({ id: p.id, name: p.name, title: p.title, icon: p.icon, source: p.source });
        });
        return out;
    };

    registry.get = function get(id) {
        return plugins.get(String(id || '')) || null;
    };

    /**
     * Execute a plugin and validate its output shape. The returned items are
     * plain data, never live entry objects, so they can cross the bridge.
     * @returns {Promise<{title:string, items:Array<{comment:string,key:string[],content:string,order:number}>}>}
     */
    registry.run = async function run(id, ctx) {
        var plugin = plugins.get(String(id || ''));
        if (!plugin) throw new Error('EL plugin not found: ' + String(id || ''));
        var out = await plugin.run(ctx || {});
        if (!out || !Array.isArray(out.items)) throw new Error('EL plugin ' + plugin.id + ' returned no items array');
        return {
            title: plugin.title,
            items: out.items.map(function (item) {
                var rawOrder = item && item.order;
                var order = Number(rawOrder);
                return {
                    comment: String((item && item.comment) || ''),
                    key: Array.isArray(item && item.key) ? item.key.map(String) : [],
                    content: String((item && item.content) || ''),
                    order: Number.isFinite(order) ? order : undefined,
                };
            }),
        };
    };

    // Test-only helper: never exposed through window.EL.
    registry._clear = function clear() { plugins.clear(); };
})();
