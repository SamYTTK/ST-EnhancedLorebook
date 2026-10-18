/**
 * agent-manager.js — Agent CRUD + scope resolution (Hub v2).
 *
 * The manager owns NOTHING that executes. Runs go through hub-client.js
 * (EL_runHubAgent → ST-RequestHub). The old AgentEngine cache is gone.
 */
class AgentManager {
    constructor() {
        this._ensureSettings();
    }

    _ensureSettings() {
        if (!extensionSettings?.agents) {
            extensionSettings.agents = [];
        }
        this._migrateFromLegacy();
        this._migrateToSchema();
    }

    _migrateToSchema() {
        try {
            const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
            if (!schema) return;
            let mutated = false;
            for (let i = 0; i < (extensionSettings.agents || []).length; i++) {
                const before = JSON.stringify(extensionSettings.agents[i]);
                const cleaned = schema.sanitizeAgentConfig(extensionSettings.agents[i]);
                // preserve id
                cleaned.id = extensionSettings.agents[i].id;
                extensionSettings.agents[i] = cleaned;
                if (JSON.stringify(cleaned) !== before) mutated = true;
            }
            if (mutated) this._save();
        } catch {}
    }

    _save() {
        if (typeof saveSettings === 'function') {
            saveSettings();
        }
    }

    _migrateFromLegacy() {
        if (!extensionSettings?.agent) return;
        if (extensionSettings.agents && extensionSettings.agents.length > 0) return;

        const legacy = extensionSettings.agent;
        const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
        const v1 = {
            name: 'Main Agent',
            enabled: legacy.enabled !== false,
            mode: legacy.mode || 'manual',
            interval: legacy.periodicInterval ?? 10,
            periodicInterval: legacy.periodicInterval ?? 10,
            taskDescription: 'General lorebook maintenance and enhancement',
            customInstructions: '',
            useSeparateApi: legacy.useSeparateApi || false,
            apiModel: legacy.apiModel || '',
            temperature: legacy.temperature ?? 0.7,
            secretId: legacy.secretId || null,
            toolPermissions: {
                view_active_lorebooks: true,
                view_lorebook_detail: true,
                view_chat_history: true,
                view_entry: true,
                propose_create_entry: legacy.canCreate !== false,
                propose_edit_entry: legacy.canEdit !== false,
                propose_delete_entry: legacy.canDelete === true,
                research: legacy.canResearch === true,
                get_feasibility_report: true,
            },
            autoAccept: legacy.autoAccept === true,
            autoAcceptConfidence: legacy.autoAcceptConfidence ?? 0.8,
            maxEntriesPerRun: legacy.maxEntriesPerRun ?? 5,
            requireKeyConfidence: legacy.requireKeyConfidence || 'low',
            maxPendingProposals: legacy.maxPendingProposals ?? 20,
            requireConfirmation: legacy.requireConfirmation !== false,
            multiTurn: { enabled: false, limitMode: 'count', maxCalls: 10, callsPerMinute: 5, safetyCap: 30 },
            injectedContext: [],
            dynamicLinks: [],
            scope: 'global',
            boundCharacterId: null,
            boundChatId: null,
            conditionals: [],
            defaultRule: { injectedContext: [], taskOverride: '', instructionsOverride: '' },
            notifyNoMatch: false,
            quickDefaults: {
                profileId: '',
                messages: { type: 'last', first: 10, last: 10, range: { start: 0, end: 10 } },
                includeCharCard: true,
                includeAuthorNote: true,
                includeWorldInfo: true,
                includeInjected: true,
            },
        };
        const cleaned = schema ? schema.sanitizeAgentConfig(v1) : v1;
        cleaned.id = 'agent_default';
        extensionSettings.agents.push(cleaned);
        delete extensionSettings.agent;
        this._save();
    }

    getAgents() {
        return extensionSettings.agents || [];
    }

    getAgent(id) {
        return (extensionSettings.agents || []).find(a => a.id === id);
    }

    createAgent(config) {
        const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
        const base = schema ? schema.sanitizeAgentConfig(config || {}) : { ...(config || {}) };
        const id = 'agent_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const agent = {
            ...base,
            id,
            name: (config && typeof config.name === 'string' && config.name.trim()) ? config.name.trim() : (base.name || 'New Agent'),
        };
        extensionSettings.agents.push(agent);
        this._save();
        return agent;
    }

    updateAgent(id, changes) {
        const idx = (extensionSettings.agents || []).findIndex(a => a.id === id);
        if (idx === -1) return null;

        const agent = extensionSettings.agents[idx];
        const schema = (typeof window !== 'undefined' && window.ELAgentConfigSchema) ? window.ELAgentConfigSchema : null;
        const allowedFields = schema ? schema.ALLOWED_FIELDS : Object.keys(changes || {});

        for (const field of allowedFields) {
            if (changes[field] !== undefined) {
                agent[field] = changes[field];
            }
        }
        // sanitize in place if schema available
        if (schema) {
            const cleaned = schema.sanitizeAgentConfig(agent);
            cleaned.id = agent.id;
            extensionSettings.agents[idx] = cleaned;
        }

        this._save();
        return extensionSettings.agents[idx];
    }

    /**
     * Legacy vault API — REMOVED. Kept as a no-op so old callers fail soft.
     * Secrets now live as hub API profiles in ST-RequestHub settings.
     */
    applySecretToAll() {
        try {
            if (typeof EL_fireToast === 'function') EL_fireToast('Vault secrets are gone — use hub API profiles in ST-RequestHub settings.', 'warning');
        } catch {}
        return 0;
    }

    deleteAgent(id) {
        const idx = (extensionSettings.agents || []).findIndex(a => a.id === id);
        if (idx === -1) return false;

        extensionSettings.agents.splice(idx, 1);
        this._save();
        return true;
    }

    duplicateAgent(id) {
        const source = this.getAgent(id);
        if (!source) return null;

        const clone = JSON.parse(JSON.stringify(source));
        clone.id = 'agent_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        clone.name = source.name + ' (Copy)';
        delete clone.hubMigratedAt;
        delete clone.hubMigrateNotes;

        extensionSettings.agents.push(clone);
        this._save();
        return clone;
    }

    _getChatId(st) {
        return EL_canonicalHubChatId(st);
    }

    isActiveForChat(agent, st) {
        if (!agent || agent.scope !== 'local') return true;
        const ctx = st || (typeof stContext !== 'undefined' ? stContext : null);
        if (!ctx) return false;
        const boundCharId = agent.boundCharacterId;
        const boundChatId = agent.boundChatId;
        if (boundCharId && String(boundCharId) !== String(ctx.characterId ?? '')) return false;
        if (boundChatId && String(boundChatId) !== String(this._getChatId(ctx))) return false;
        return !!boundChatId || !!boundCharId;
    }

    resolveScopeContext(agent, st) {
        const ctx = st || (typeof stContext !== 'undefined' ? stContext : null);
        if (!agent || agent.scope !== 'global') {
            return {
                injectedContext: Array.isArray(agent?.injectedContext) ? agent.injectedContext : [],
                taskOverride: '',
                instructionsOverride: '',
                matched: true,
            };
        }
        if (!ctx) {
            return {
                injectedContext: [],
                taskOverride: '',
                instructionsOverride: '',
                matched: false,
            };
        }
        const rules = Array.isArray(agent.conditionals) ? agent.conditionals : [];
        let rule = rules.find(r => r && r.enabled !== false && String(r.characterId) === String(ctx.characterId ?? ''));
        if (!rule) {
            // Name fallback: character indexes shift when characters are
            // deleted/re-imported; the stored display name survives that.
            try {
                const chars = Array.isArray(ctx?.characters) ? ctx.characters : [];
                const idx = Number(ctx.characterId);
                const cur = (Number.isInteger(idx) && chars[idx]) ? chars[idx] : null;
                const curName = cur && typeof cur.name === 'string' ? cur.name : '';
                if (curName) rule = rules.find(r => r && r.enabled !== false && typeof r.characterName === 'string' && r.characterName === curName);
            } catch {}
        }
        if (rule) {
            return {
                injectedContext: Array.isArray(rule.injectedContext) ? rule.injectedContext : [],
                taskOverride: rule.taskOverride || '',
                instructionsOverride: rule.instructionsOverride || '',
                matched: true,
                rule,
            };
        }
        if (rules.length === 0) {
            return {
                injectedContext: Array.isArray(agent.injectedContext) ? agent.injectedContext : [],
                taskOverride: '',
                instructionsOverride: '',
                matched: true,
            };
        }
        const dr = agent.defaultRule || {};
        return {
            injectedContext: Array.isArray(dr.injectedContext) ? dr.injectedContext : [],
            taskOverride: dr.taskOverride || '',
            instructionsOverride: dr.instructionsOverride || '',
            matched: false,
        };
    }

    /**
     * Run one agent through the hub. Proposals land in the Feed for review.
     * @param {string} id - agent id
     * @param {object} runOpts - forwarded to EL_runHubAgent (historyText, signal, onStep, ...)
     */
    async runAgent(id, runOpts) {
        const agent = this.getAgent(id);
        if (!agent) throw new Error('Agent not found: ' + id);
        if (!this.isActiveForChat(agent)) {
            return { success: false, error: 'Local agent bound to another chat', skipped: true };
        }
        if (typeof EL_runHubAgent !== 'function') throw new Error('Hub client not loaded (hub-client.js).');
        const st = (typeof stContext !== 'undefined' && stContext) ? stContext : null;
        return EL_runHubAgent(agent, Object.assign({ st }, runOpts || {}));
    }

    async runAllEnabled(runOpts) {
        const results = [];
        for (const agent of this.getAgents()) {
            if (!agent.enabled) continue;
            if (!this.isActiveForChat(agent)) continue;
            try {
                const result = await this.runAgent(agent.id, runOpts);
                results.push({ agentId: agent.id, name: agent.name, result, success: true });
            } catch (e) {
                results.push({ agentId: agent.id, name: agent.name, error: e.message, success: false });
            }
        }
        return results;
    }

    getAgentsNeedingRun(msgCount) {
        return this.getAgents().filter(a => {
            if (!a.enabled || a.mode !== 'periodic') return false;
            if (!this.isActiveForChat(a)) return false;
            return msgCount > 0 && msgCount % (a.interval || a.periodicInterval || 10) === 0;
        });
    }
}
