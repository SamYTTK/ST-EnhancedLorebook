class AgentEngine {
    constructor(context) {
        this.context = context || {};
        this.state = 'idle';
        this.pendingProposals = [];
        this.backupClient = new BackupClient(context);
        this._abortController = null;
    }

    stop() {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
        this.state = 'idle';
    }

    async analyze(triggerType) {
        if (this.state !== 'idle') {
            return { success: false, error: 'Agent is already running (state: ' + this.state + ')' };
        }
        this.state = 'analyzing';
        this._abortController = new AbortController();
        this.pendingProposals = [];

        const trigger = triggerType || 'manual';
        const st = this.context?.stContext || (typeof stContext !== 'undefined' ? stContext : null);
        const settings = this.context?.settings || {};
        const permissions = this.context?.permissions || {};
        const apiConfig = this.context?.apiConfig || {};
        const errors = [];
        let proposalsCreated = 0;
        let autoAccepted = 0;

        try {
            const chatResult = await view_chat_history({ count: 20, offset: 0 }, this.context);
            const chatHistory = chatResult.success ? chatResult.data : [];

            const activeResult = await view_active_lorebooks({}, this.context);
            const activeLorebooks = activeResult.success ? activeResult.data : [];

            const lorebookDetails = [];
            for (const lb of activeLorebooks) {
                const detailResult = await view_lorebook_detail({ lorebookName: lb.name }, this.context);
                if (detailResult.success) {
                    lorebookDetails.push(detailResult.data);
                }
            }

            const researchSources = settings?.research?.sources || [];
            const systemPrompt = EL_getAgentSystemPrompt(researchSources);

            const lorebookSummary = lorebookDetails.map(d => ({
                name: d.name,
                entryCount: d.entries.length,
                entries: d.entries.map(e => ({
                    uid: e.uid,
                    keys: e.keys,
                    comment: e.comment,
                    contentPreview: e.contentPreview,
                    order: e.order,
                    depth: e.depth,
                    probability: e.probability,
                    position: e.position,
                })),
            }));

            const analysisPrompt = EL_getAnalysisPrompt(chatHistory, lorebookSummary, settings);

            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: analysisPrompt },
            ];

            const guardrail = EL_createGuardrailValidator(permissions);
            const toolCalls = await this._callLLM(messages, apiConfig, settings);

            for (const tc of toolCalls) {
                const result = await this._executeToolCall(tc, guardrail);
                if (result && result.status === 'proposed') {
                    proposalsCreated++;
                    this.pendingProposals.push(result.data);
                }
            }

            if (this.pendingProposals.length > 0) {
                const chatId = (st?.characterId || 'unknown') + '_' + (st?.chat?.filename || st?.chatFile || 'unknown');
                try {
                    await EL_apiFetch('POST', '/proposals/batch-save', {
                        chatId,
                        proposals: this.pendingProposals,
                    });
                } catch (e) {
                    errors.push('Failed to save proposals: ' + e.message);
                }
            }

            const affectedLorebooks = new Set();
            for (const p of this.pendingProposals) {
                if (p.action === 'create' || p.action === 'edit' || p.action === 'delete') {
                    affectedLorebooks.add(p.lorebookName);
                }
            }
            const backupIds = {};
            for (const lbName of affectedLorebooks) {
                try {
                    const backupResult = await this.backupClient.createBackup(lbName);
                    if (backupResult && backupResult.backupId) {
                        backupIds[lbName] = backupResult.backupId;
                    }
                } catch (e) {
                    errors.push('Backup failed for "' + lbName + '": ' + e.message);
                }
            }
            for (const p of this.pendingProposals) {
                if (backupIds[p.lorebookName]) {
                    p.backupId = backupIds[p.lorebookName];
                }
            }

            const autoAccept = permissions.autoAccept === true;
            const confidenceThreshold = permissions.autoAcceptConfidence ?? 0.8;
            for (const p of this.pendingProposals) {
                if (autoAccept && p.action !== 'delete') {
                    const confidence = p.confidence ?? 1;
                    if (confidence >= confidenceThreshold) {
                        try {
                            await this.applyProposal(p);
                            p.status = 'auto-accepted';
                            await EL_apiFetch('POST', '/proposals/update-status', {
                                proposalId: p.id,
                                status: 'auto-accepted',
                            });
                            autoAccepted++;
                        } catch (e) {
                            errors.push('Auto-accept failed for proposal ' + p.id + ': ' + e.message);
                        }
                    }
                }
            }

            this.state = 'idle';

            return {
                proposalsCreated,
                autoAccepted,
                errors: errors.length > 0 ? errors : undefined,
                success: true,
            };
        } catch (err) {
            this.state = 'idle';
            if (err.name === 'AbortError') {
                return { proposalsCreated, autoAccepted: 0, success: false, aborted: true };
            }
            throw err;
        }
    }

    async revise(proposalId, feedback) {
        const listResult = await EL_apiFetch('GET', '/proposals/list');
        const allProposals = listResult?.proposals || [];
        const proposal = allProposals.find(p => p.id === proposalId || p.proposalId === proposalId);
        if (!proposal) throw new Error('Proposal ' + proposalId + ' not found');

        const settings = this.context?.settings || {};
        const apiConfig = this.context?.apiConfig || {};
        const permissions = this.context?.permissions || {};

        const chatResult = await view_chat_history({ count: 20, offset: 0 }, this.context);
        const chatHistory = chatResult.success ? chatResult.data : [];

        const activeResult = await view_active_lorebooks({}, this.context);
        const activeLorebooks = activeResult.success ? activeResult.data : [];

        const lorebookDetails = [];
        for (const lb of activeLorebooks) {
            const detailResult = await view_lorebook_detail({ lorebookName: lb.name }, this.context);
            if (detailResult.success) lorebookDetails.push(detailResult.data);
        }

        const researchSources = settings?.research?.sources || [];
        const systemPrompt = EL_getAgentSystemPrompt(researchSources);

        const lorebookSummary = lorebookDetails.map(d => ({
            name: d.name,
            entryCount: d.entries.length,
            entries: d.entries,
        }));

        const analysisPrompt = EL_getAnalysisPrompt(chatHistory, lorebookSummary, settings);

        const reviseMsg = '\n\n## Revision Request\nProposal ID: ' + proposalId + '\nUser Feedback: ' + feedback + '\nOriginal Proposal: ' + JSON.stringify(proposal, null, 2) + '\n\nPlease revise the proposal based on this feedback.';

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: analysisPrompt + reviseMsg },
        ];

        const toolCalls = await this._callLLM(messages, apiConfig, settings);
        let revisedProposal = null;

        for (const tc of toolCalls) {
            if (tc.tool && tc.tool.startsWith('propose_')) {
                const result = await this._executeToolCall(tc, EL_createGuardrailValidator(permissions));
                if (result && result.status === 'proposed') {
                    const prop = result.data.proposal || result.data;
                    prop.id = proposalId;
                    prop.revises = proposalId;
                    revisedProposal = prop;
                }
            }
        }

        if (!revisedProposal) throw new Error('No revised proposal generated from the LLM');

        await EL_apiFetch('POST', '/proposals/save', revisedProposal);
        return revisedProposal;
    }

    async applyProposal(proposal) {
        const st = this.context?.stContext || (typeof stContext !== 'undefined' ? stContext : null);
        if (!st) throw new Error('No SillyTavern context available');

        const data = await st.loadWorldInfo(proposal.lorebookName);
        if (!data || !data.entries) {
            throw new Error('Lorebook "' + proposal.lorebookName + '" not found');
        }

        if (proposal.action === 'create') {
            const snapshot = proposal.entrySnapshot || {};
            const existingUids = Object.keys(data.entries).map(Number);
            const nextUid = existingUids.length > 0 ? Math.max(...existingUids) + 1 : 0;
            const newEntry = {};
            for (const key of ['key', 'keysecondary', 'comment', 'content', 'order', 'position', 'depth', 'probability', 'constant', 'vectorized', 'selective', 'disable', 'excludeRecursion', 'preventRecursion', 'group', 'groupWeight', 'groupOverride', 'sticky', 'cooldown', 'delay', 'triggers', 'characterFilter', 'characterFilterExclude', 'selectiveLogic', 'role', 'outletName']) {
                if (snapshot[key] !== undefined) newEntry[key] = snapshot[key];
            }
            newEntry.uid = nextUid;
            data.entries[nextUid] = newEntry;

            if (snapshot.folderId) {
                try {
                    const folders = (typeof extensionSettings !== 'undefined' ? extensionSettings?.folders?.[proposal.lorebookName] : null);
                    if (folders) {
                        const folder = folders.find(f => f.id === snapshot.folderId);
                        if (folder) folder.entries.push(String(nextUid));
                    }
                } catch (_) {}
            }
        } else if (proposal.action === 'edit') {
            const uid = proposal.uid;
            const entry = data.entries[uid];
            if (!entry) throw new Error('Entry UID ' + uid + ' not found');
            const snapshot = proposal.entrySnapshot || {};
            for (const key of Object.keys(snapshot)) {
                if (key === 'uid') continue;
                entry[key] = snapshot[key];
            }
        } else if (proposal.action === 'delete') {
            const uid = proposal.uid;
            if (!data.entries[uid]) throw new Error('Entry UID ' + uid + ' not found');
            delete data.entries[uid];
            try {
                const folders = (typeof extensionSettings !== 'undefined' ? extensionSettings?.folders?.[proposal.lorebookName] : null);
                if (folders) {
                    for (const folder of folders) {
                        folder.entries = folder.entries.filter(e => String(e) !== String(uid));
                    }
                }
            } catch (_) {}
        }

        await st.saveWorldInfo(proposal.lorebookName, data);

        const currName = this.context?.currentLorebookName || (typeof currentLorebookName !== 'undefined' ? currentLorebookName : null);
        if (currName === proposal.lorebookName) {
            try {
                const updated = await st.loadWorldInfo(proposal.lorebookName);
                if (typeof window !== 'undefined' && window.currentLorebookData !== undefined) {
                    window.currentLorebookData = updated;
                }
            } catch (_) {}
            if (typeof renderEntries === 'function') {
                renderEntries();
            }
        }
    }

    async runPeriodicIfNeeded(messagesSinceLastRun) {
        const settings = this.context?.settings || {};
        if (settings.mode !== 'periodic') return;
        if (typeof messagesSinceLastRun !== 'number' || messagesSinceLastRun < (settings.periodicInterval || 10)) return;
        return this.analyze('periodic');
    }

    async _callLLM(messages, apiConfig, settings) {
        if (apiConfig?.useSeparateApi) {
            return this._callSeparateApi(messages, apiConfig, settings);
        }
        return this._callStPipeline(messages, settings);
    }

    async _callStPipeline(messages, settings) {
        const signal = this._abortController?.signal;
        const st = this.context?.stContext || (typeof stContext !== 'undefined' ? stContext : null);
        const maxTokens = settings?.maxTokens || 1024;
        const temperature = settings?.temperature ?? 0.7;
        const options = {
            messages,
            max_tokens: maxTokens,
            temperature,
            top_p: settings?.topP ?? 1,
            frequency_penalty: settings?.frequencyPenalty ?? 0,
            presence_penalty: settings?.presencePenalty ?? 0,
            stop: settings?.stop || [],
            logit_bias: {},
            n: 1,
        };

        if (st?.generateRaw) {
            const text = await st.generateRaw(messages, options, signal);
            return this._parseToolCalls(text);
        }

        const text = await this._fallbackGenerate(messages, options);
        return this._parseToolCalls(text);
    }

    async _callSeparateApi(messages, apiConfig, settings) {
        const configResp = await EL_apiFetch('GET', '/agent/api-config');
        if (!configResp || !configResp.hasApiKey) {
            throw new Error('Separate API requested but no API key is configured');
        }

        const tools = EL_TOOL_DEFINITIONS.map(def => ({
            type: 'function',
            function: { name: def.name, description: def.description, parameters: def.parameters },
        }));

        const payload = {
            messages,
            model: configResp.model || '',
            apiEndpoint: configResp.apiEndpoint || '',
            apiKey: '',
            maxTokens: settings?.maxTokens ?? configResp.maxTokens ?? 1024,
            temperature: settings?.temperature ?? configResp.temperature ?? 0.7,
            topP: settings?.topP ?? configResp.topP ?? 1,
            topK: settings?.topK ?? configResp.topK ?? 0,
            reasoningEffort: settings?.reasoningEffort ?? configResp.reasoningEffort ?? '',
            frequencyPenalty: settings?.frequencyPenalty ?? configResp.frequencyPenalty ?? 0,
            presencePenalty: settings?.presencePenalty ?? configResp.presencePenalty ?? 0,
            stop: settings?.stop ?? configResp.stop ?? [],
            extraHeaders: configResp.extraHeaders || {},
            tools,
        };

        const result = await EL_apiFetch('POST', '/agent/chat', payload);
        if (!result || !result.choices || !result.choices[0]) {
            throw new Error('Invalid response from agent chat endpoint');
        }

        const choice = result.choices[0];
        if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
            return choice.message.tool_calls.map(tc => ({
                tool: tc.function.name,
                args: JSON.parse(tc.function.arguments || '{}'),
            }));
        }

        const text = choice.message?.content || '';
        return this._parseToolCalls(text);
    }

    async _fallbackGenerate(messages, options) {
        const textResp = await EL_apiFetch('POST', '/agent/chat', {
            messages,
            model: 'fallback',
            apiEndpoint: '',
            apiKey: '',
            maxTokens: options.max_tokens || 1024,
            temperature: options.temperature ?? 0.7,
            topP: options.top_p ?? 1,
            topK: options.top_k ?? 0,
            frequencyPenalty: options.frequency_penalty ?? 0,
            presencePenalty: options.presence_penalty ?? 0,
            stop: options.stop || [],
            extraHeaders: {},
            tools: EL_TOOL_DEFINITIONS.map(def => ({
                type: 'function',
                function: { name: def.name, description: def.description, parameters: def.parameters },
            })),
        });

        if (!textResp || !textResp.choices || !textResp.choices[0]) {
            return '[]';
        }

        const choice = textResp.choices[0];
        if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
            return JSON.stringify(choice.message.tool_calls.map(tc => ({
                tool: tc.function.name,
                args: JSON.parse(tc.function.arguments || '{}'),
            })));
        }
        return choice.message?.content || '[]';
    }

    _parseToolCalls(text) {
        if (!text) return [];
        try {
            const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed)) return parsed.filter(item => item && item.tool);
            if (parsed && parsed.tool) return [parsed];
            return [];
        } catch (e) {
            const match = text.match(/\[[\s\S]*?\]/);
            if (match) {
                try {
                    const parsed = JSON.parse(match[0]);
                    if (Array.isArray(parsed)) return parsed.filter(item => item && item.tool);
                } catch (_) {}
            }
            return [];
        }
    }

    async _executeToolCall(tc, guardrail) {
        const { tool, args } = tc;
        if (!tool || !args) return null;

        switch (tool) {
            case 'view_active_lorebooks': {
                const res = await view_active_lorebooks(args || {}, this.context);
                return { tool, status: res.success ? 'ok' : 'error', data: res.data, error: res.error };
            }
            case 'view_lorebook_detail': {
                const res = await view_lorebook_detail(args, this.context);
                return { tool, status: res.success ? 'ok' : 'error', data: res.data, error: res.error };
            }
            case 'view_chat_history': {
                const res = await view_chat_history(args || {}, this.context);
                return { tool, status: res.success ? 'ok' : 'error', data: res.data, error: res.error };
            }
            case 'view_entry': {
                const res = await view_entry(args, this.context);
                return { tool, status: res.success ? 'ok' : 'error', data: res.data, error: res.error };
            }
            case 'get_feasibility_report': {
                const res = await get_feasibility_report(args, this.context);
                return { tool, status: res.success ? 'ok' : 'error', data: res.data, error: res.error };
            }
            case 'research': {
                const res = await research(args, this.context);
                return { tool, status: res.success ? 'ok' : 'error', data: res.data, error: res.error };
            }
            case 'propose_create_entry': {
                const validation = guardrail.validateProposal('create', args?.entryData);
                if (!validation.allowed) return { tool, status: 'blocked', reason: validation.reason };
                const res = await propose_create_entry(args, this.context);
                guardrail.incrementCount();
                if (res.success) {
                    this.pendingProposals.push(res.data.proposal);
                    return { tool, status: 'proposed', data: res.data };
                }
                return { tool, status: 'error', error: res.error };
            }
            case 'propose_edit_entry': {
                const validation = guardrail.validateProposal('edit', args?.changes);
                if (!validation.allowed) return { tool, status: 'blocked', reason: validation.reason };
                const res = await propose_edit_entry(args, this.context);
                guardrail.incrementCount();
                if (res.success) {
                    this.pendingProposals.push(res.data.proposal);
                    return { tool, status: 'proposed', data: res.data };
                }
                return { tool, status: 'error', error: res.error };
            }
            case 'propose_delete_entry': {
                const validation = guardrail.validateProposal('delete', { uid: args?.uid });
                if (!validation.allowed) return { tool, status: 'blocked', reason: validation.reason };
                const res = await propose_delete_entry(args, this.context);
                guardrail.incrementCount();
                if (res.success) {
                    this.pendingProposals.push(res.data.proposal);
                    return { tool, status: 'proposed', data: res.data };
                }
                return { tool, status: 'error', error: res.error };
            }
            default:
                return { tool, status: 'error', reason: 'Unknown tool: ' + tool };
        }
    }
}
