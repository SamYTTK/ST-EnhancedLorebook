class AgentManager {
    constructor() {
        this.engines = {};
        this._ensureSettings();
    }

    _ensureSettings() {
        if (!extensionSettings?.agents) {
            extensionSettings.agents = [];
        }
        this._migrateFromLegacy();
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
        const defaultAgent = {
            id: 'agent_default',
            name: 'Main Agent',
            enabled: legacy.enabled !== false,
            mode: legacy.mode || 'manual',
            interval: legacy.periodicInterval ?? 10,
            periodicInterval: legacy.periodicInterval ?? 10,
            taskDescription: 'General lorebook maintenance and enhancement',
            customInstructions: '',
            useSeparateApi: legacy.useSeparateApi || false,
            apiEndpoint: legacy.apiEndpoint || '',
            apiModel: legacy.apiModel || '',
            temperature: legacy.temperature ?? 0.7,
            toolPermissions: {
                view_active_lorebooks: true,
                view_lorebook_detail: true,
                view_chat_history: true,
                view_entry: true,
                propose_create_entry: true,
                propose_edit_entry: true,
                propose_delete_entry: false,
                research: false,
                get_feasibility_report: true,
            },
            canCreate: legacy.canCreate !== false,
            canEdit: legacy.canEdit !== false,
            canDelete: legacy.canDelete === true,
            canResearch: legacy.canResearch === true,
            autoAccept: legacy.autoAccept === true,
            autoAcceptConfidence: legacy.autoAcceptConfidence ?? 0.8,
            maxEntriesPerRun: legacy.maxEntriesPerRun ?? 5,
            requireKeyConfidence: legacy.requireKeyConfidence || 'low',
            maxPendingProposals: legacy.maxPendingProposals ?? 20,
            requireConfirmation: legacy.requireConfirmation !== false,
            research: {
                source: legacy.research?.source || 'disabled',
                searxngUrl: legacy.research?.searxngUrl || '',
                searxngToken: legacy.research?.searxngToken || '',
            },
            multiTurn: {
                enabled: false,
                limitMode: 'count',
                maxCalls: 10,
                callsPerMinute: 5,
                safetyCap: 30,
            },
            injectedContext: [],
        };

        extensionSettings.agents.push(defaultAgent);
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
        const agent = {
            id: 'agent_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            name: config.name || 'New Agent',
            enabled: config.enabled !== false,
            mode: config.mode || 'manual',
            interval: config.interval ?? 10,
            periodicInterval: config.interval ?? 10,
            taskDescription: config.taskDescription || '',
            customInstructions: config.customInstructions || '',
            useSeparateApi: config.useSeparateApi || false,
            apiEndpoint: config.apiEndpoint || '',
            apiModel: config.apiModel || '',
            temperature: config.temperature ?? 0.7,
            toolPermissions: {
                view_active_lorebooks: true,
                view_lorebook_detail: true,
                view_chat_history: true,
                view_entry: true,
                propose_create_entry: true,
                propose_edit_entry: true,
                propose_delete_entry: false,
                research: false,
                get_feasibility_report: true,
                ...(config.toolPermissions || {}),
            },
            canCreate: config.canCreate !== false,
            canEdit: config.canEdit !== false,
            canDelete: config.canDelete === true,
            canResearch: config.canResearch === true,
            autoAccept: config.autoAccept === true,
            autoAcceptConfidence: config.autoAcceptConfidence ?? 0.8,
            maxEntriesPerRun: config.maxEntriesPerRun ?? 5,
            requireKeyConfidence: config.requireKeyConfidence || 'low',
            maxPendingProposals: config.maxPendingProposals ?? 20,
            requireConfirmation: config.requireConfirmation !== false,
            research: {
                source: config.research?.source || 'disabled',
                searxngUrl: config.research?.searxngUrl || '',
                searxngToken: config.research?.searxngToken || '',
            },
            multiTurn: {
                enabled: false,
                limitMode: 'count',
                maxCalls: 10,
                callsPerMinute: 5,
                safetyCap: 30,
                ...(config.multiTurn || {}),
            },
            injectedContext: Array.isArray(config.injectedContext) ? config.injectedContext : [],
        };

        extensionSettings.agents.push(agent);
        this._save();
        return agent;
    }

    updateAgent(id, changes) {
        const idx = (extensionSettings.agents || []).findIndex(a => a.id === id);
        if (idx === -1) return null;

        const agent = extensionSettings.agents[idx];
        const allowedFields = [
            'name', 'enabled', 'mode', 'interval',
            'taskDescription', 'customInstructions',
            'useSeparateApi', 'apiEndpoint', 'apiModel', 'temperature',
            'toolPermissions',
            'canCreate', 'canEdit', 'canDelete', 'canResearch',
            'autoAccept', 'autoAcceptConfidence',
            'maxEntriesPerRun', 'requireKeyConfidence',
            'maxPendingProposals', 'requireConfirmation',
            'research',
            'multiTurn',
            'injectedContext',
        ];

        for (const field of allowedFields) {
            if (changes[field] !== undefined) {
                agent[field] = changes[field];
            }
        }

        delete this.engines[id];
        this._save();
        return agent;
    }

    deleteAgent(id) {
        const idx = (extensionSettings.agents || []).findIndex(a => a.id === id);
        if (idx === -1) return false;

        extensionSettings.agents.splice(idx, 1);
        delete this.engines[id];
        this._save();
        return true;
    }

    duplicateAgent(id) {
        const source = this.getAgent(id);
        if (!source) return null;

        const clone = JSON.parse(JSON.stringify(source));
        clone.id = 'agent_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        clone.name = source.name + ' (Copy)';

        extensionSettings.agents.push(clone);
        this._save();
        return clone;
    }

    getEngine(id) {
        const agent = this.getAgent(id);
        if (!agent) return null;

        if (!this.engines[id]) {
            this.engines[id] = new AgentEngine(agent, stContext);
        }
        return this.engines[id];
    }

    async runAgent(id) {
        const engine = this.getEngine(id);
        if (!engine) throw new Error('Agent not found: ' + id);
        return engine.analyze('manual');
    }

    async runAllEnabled() {
        const results = [];
        for (const agent of this.getAgents()) {
            if (!agent.enabled) continue;
            try {
                const engine = this.getEngine(agent.id);
                if (engine) {
                    const result = await engine.analyze('manual');
                    results.push({ agentId: agent.id, name: agent.name, result, success: true });
                }
            } catch (e) {
                results.push({ agentId: agent.id, name: agent.name, error: e.message, success: false });
            }
        }
        return results;
    }

    getAgentsNeedingRun(msgCount) {
        return this.getAgents().filter(a => {
            if (!a.enabled || a.mode !== 'periodic') return false;
            return msgCount > 0 && msgCount % (a.interval || a.periodicInterval || 10) === 0;
        });
    }
}
