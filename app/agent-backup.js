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

    async restoreBackup(backupId, lorebookName) {
        const result = await EL_apiFetch('POST', '/backup/restore', { backupId, lorebookName });
        if (result?.success && lorebookName && result.lorebooks?.[lorebookName]) {
            const st = this._st();
            if (st) {
                await st.saveWorldInfo(lorebookName, result.lorebooks[lorebookName]);
                if (typeof renderEntries === 'function') {
                    renderEntries();
                }
            }
        }
        return result;
    }

    async deleteBackup(backupId, lorebookName) {
        return EL_apiFetch('DELETE', '/backup/delete', { backupId, lorebookName });
    }
}
