class BackupClient {
    constructor(context) {
        this.context = context || {};
    }

    _st() {
        return this.context?.stContext || (typeof stContext !== 'undefined' ? stContext : null);
    }

    async createBackup(lorebookName) {
        const st = this._st();
        if (!st) throw new Error('No SillyTavern context available');
        const lorebookData = await st.loadWorldInfo(lorebookName);
        const result = await EL_apiFetch('POST', '/backup/create', { lorebookName, lorebookData });
        return { backupId: result?.backupId || '', timestamp: result?.timestamp || new Date().toISOString() };
    }

    async createAgentBackup(lorebookName) {
        const st = this._st();
        if (!st) throw new Error('No SillyTavern context available');
        const lorebookData = await st.loadWorldInfo(lorebookName);
        let folders = [];
        try {
            if (typeof window !== 'undefined' && window.ELFolderUrl && typeof window.ELFolderUrl.getFoldersSnapshot === 'function') {
                folders = window.ELFolderUrl.getFoldersSnapshot(lorebookName);
            } else if (typeof extensionSettings !== 'undefined' && extensionSettings?.folders?.[lorebookName]) {
                folders = extensionSettings.folders[lorebookName];
            }
        } catch {}
        const result = await EL_apiFetch('POST', '/agent-backup/create', { lorebookName, lorebookData, folders });
        return { backupId: result?.backupId || '', timestamp: result?.timestamp || new Date().toISOString() };
    }

    async listBackups(lorebookName) {
        const query = lorebookName ? '?lorebookName=' + encodeURIComponent(lorebookName) : '';
        const result = await EL_apiFetch('GET', '/backup/list' + query);
        const backups = result?.backups || [];
        return backups.map(b => ({
            id: b.id || b.backupId || '',
            timestamp: b.timestamp || '',
            lorebookName: b.lorebookName || '',
        }));
    }

    async listAgentBackups(lorebookName) {
        const query = lorebookName ? '?lorebookName=' + encodeURIComponent(lorebookName) : '';
        const result = await EL_apiFetch('GET', '/agent-backup/list' + query);
        const backups = result?.backups || [];
        return backups.map(b => ({
            id: b.id || b.backupId || '',
            timestamp: b.timestamp || '',
            lorebookName: b.lorebookName || '',
            source: b.source || 'agent',
        }));
    }

    async restoreBackup(backupId, lorebookName) {
        const result = await EL_apiFetch('POST', '/backup/restore', { backupId, lorebookName });
        if (result?.success && lorebookName && result.lorebooks?.[lorebookName]) {
            const st = this._st();
            if (st) {
                const data = result.lorebooks[lorebookName];
                if (typeof window.ELG_guardSave === 'function') {
                    await window.ELG_guardSave(lorebookName, data, { explicitDelete: true, source: 'user', note: 'Restore backup ' + backupId });
                } else {
                    await st.saveWorldInfo(lorebookName, data);
                }
                if (typeof renderEntries === 'function') {
                    renderEntries();
                }
            }
        }
        return result;
    }

    async restoreAgentBackup(backupId, lorebookName) {
        const result = await EL_apiFetch('POST', '/agent-backup/restore', { backupId, lorebookName });
        if (result?.success && result.lorebookData && lorebookName) {
            const st = this._st();
            if (st) {
                const data = result.lorebookData;
                const folders = result.folders || [];
                if (Array.isArray(folders) && folders.length && typeof window !== 'undefined' && window.ELFolderUrl) {
                    try { window.ELFolderUrl.setFoldersSnapshot(lorebookName, folders); } catch {}
                }
                if (typeof window.ELG_guardSave === 'function') {
                    await window.ELG_guardSave(lorebookName, data, { explicitDelete: true, source: 'user', note: 'Restore agent backup ' + backupId });
                } else {
                    await st.saveWorldInfo(lorebookName, data);
                }
                if (typeof renderEntries === 'function') renderEntries();
            }
        }
        return result;
    }

    async deleteBackup(backupId, lorebookName) {
        return EL_apiFetch('DELETE', '/backup/delete', { backupId, lorebookName });
    }

    async deleteAgentBackup(backupId, lorebookName) {
        return EL_apiFetch('POST', '/agent-backup/delete', { backupId, lorebookName });
    }
}
