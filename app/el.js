/**
 * The sanctioned namespace for the extension's app-window scripts.
 *
 * This is the target surface for the 3.1 architecture work: every module's public
 * API is addressable as window.EL.<module>.<name>. It is ADDITIVE — the legacy
 * window.* globals are all still assigned by their own modules and are what every
 * current caller uses, so nothing can break while callers migrate. New code should
 * prefer window.EL.<module>.
 *
 * See docs/PHASE3-3.1-plan.md for the remaining migration steps.
 */
(function () {
    'use strict';
    const EL = window.EL = window.EL || {};
    function pick(names) {
        const o = {};
        for (const n of names) {
            try { if (typeof window[n] !== 'undefined') o[n] = window[n]; } catch (e) {}
        }
        return o;
    }
    // UI primitives (self-registered IIFEs; read them off window directly)
    EL.ui = Object.assign(EL.ui || {}, {
        toast: window.EL_toast || null,
        modalOpen: window.EL_modalOpen || null,
        modalClose: window.EL_modalClose || null,
        openEditEntryModal: window.openEditEntryModal || null,
    });
    EL.log = pick(['ELLogger', 'EL_log', 'EL_terminal', '_EL_flushLogs', 'EL_termLog']);
    EL.config = pick(['ELAgentConfigSchema']);
    EL.context = pick(['EL_resolveAgentContext', 'EL_buildAgentContextAsync', 'EL_resolveContextPromptText',
        'EL_checkContextTokenWarning', 'EL_getContextPreset', 'EL_mergeContextOverride',
        'EL_collectContextMessages', 'EL_formatContextHistory', 'EL_countTokensAsync', 'EL_heuristicTokens',
        'EL_CONTEXT_PRESETS', 'EL_CONTEXT_VERSION', 'EL_fetchPreviousMemories', 'EL_sanitizeCtxExcludeIds']);
    EL.hub = pick(['EL_apiFetch', 'EL_apiFetchWithSignal', 'EL_postToHost', 'EL_bridgeRequest',
        'EL_requestChatBooks', 'EL_getHub', 'EL_isHubReady', 'EL_hubStatus', 'EL_onHubReady',
        'EL_buildHubRequest', 'EL_buildHubTaskText', 'EL_buildPromptMessage', 'EL_buildMetaBlock',
        'EL_buildStaticContextBlock', 'EL_runHubAgent', 'EL_commitHubProposals', 'EL_applyProposal',
        'EL_reviseHubProposal', 'EL_parseHubProposals', 'EL_sanitizeHubProposal', 'EL_canonicalHubChatId',
        'EL_ENTRY_FIELDS', 'EL_ENTRY_DEFAULTS', 'EL_VALID_TRIGGERS', 'EL_PROPOSAL_CONTRACT',
        'EL_proposalId', 'EL_fireToast', 'EL_getRequestHeaders', 'EL_recoverStagedHubProposals',
        'EL_extractJsonObject', 'EL_collectHistoryText', 'EL_resolveCustomText', 'EL_resolvePromptRole',
        'EL_resolvePromptPosition', 'EL_hubAllowedActions', 'EL_buildLinkedBooksLine']);
    EL.tools = pick(['EL_buildHubTools', 'EL_parseFsPath', 'EL_entryFingerprint']);
    EL.chat = pick(['AgentChatManager', 'EL_getChatIdForAgent', 'renderAgentChat', 'initAgentChatPanel',
        'sendAgentChatMessage', 'handleChatSwipe', 'wireAgentChatUI', 'EL_simpleMarkdown',
        'EL_parseAgentReasoningClient', 'agentChatManager']);
    EL.backup = pick(['BackupClient']);
    try { if (!EL.backup.BackupClient && typeof BackupClient !== 'undefined') EL.backup.BackupClient = BackupClient; } catch (e) {}
    EL.guard = pick(['ELG_guardSave', 'ELG_loadFresh', 'ELG_fetchServerState', 'ELG_fetchServerStateEx',
        'ELG_snapshot', 'ELG_trashEntries', 'ELG_audit', 'ELG_toast', 'ELG_canonicalEntries',
        'ELG_pluginAvailable', 'ELG_listTrash', 'ELG_restoreTrash', 'ELG_deleteTrashByIds',
        'ELG_deleteTrash', 'ELG_listSnapshots', 'ELG_restoreSnapshot', 'ELG_deleteSnapshot', 'ELG_listAudit']);
    EL.folders = pick(['ELFolderUrl', 'EL_getUrlForUid', 'EL_parseUrl', 'EL_ensureFolderByPath',
        'EL_assignEntryToUrl', 'EL_getFolderIdForUid']);
    EL.store = Object.assign(EL.store || {}, {
        setData: window.EL_setLorebookData || null,
        getData: window.EL_getLorebookData || null,
        setName: window.EL_setLorebookName || null,
    });
})();
