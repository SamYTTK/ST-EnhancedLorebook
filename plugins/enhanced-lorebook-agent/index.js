import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import sanitize from 'sanitize-filename';
import { getAllUserHandles, getUserDirectories } from '../../src/users.js';

const PLUGIN_NAME = 'enhanced-lorebook-agent';
const PLUGIN_VERSION = '1.3.0';

// Hub v2: LLM execution moved to ST-RequestHub. This plugin keeps STORAGE ONLY
// (proposals, agent chats, backups, snapshots, trash, audit, logs).
// The vault (/secrets/*), LLM proxy (/agent/direct-complete) and research
// (/agent/research) routes were deleted.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Extension file logger (mirrors ST access.log, Q2) ─────────────────
// Writes to data/enhanced-lorebook-agent/extension.log (like ST's access.log via middleware)
// Console still shows via console.log/debug (ST's console.log never silenced, Q2)
// Optimized: async batched append, non-blocking, mutex queue to avoid EventLoop stalls.
const EXT_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB, rotate once
const EXT_LOG_FILE = () => path.join(getStorageRoot(), 'extension.log');
let _elLogChain = Promise.resolve();
async function _elLogAppendLines(lines) {
    if (!lines || !lines.length) return;
    const fp = EXT_LOG_FILE();
    try {
        // Ensure dir exists
        const dir = path.dirname(fp);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch {}
    // Check rotation async
    try {
        if (fs.existsSync(fp)) {
            try {
                const stat = await fs.promises.stat(fp);
                if (stat.size > EXT_LOG_MAX_BYTES) {
                    const bak = fp + '.1';
                    try { if (fs.existsSync(bak)) await fs.promises.unlink(bak); } catch {}
                    try { await fs.promises.rename(fp, bak); } catch {}
                }
            } catch {}
        }
    } catch {}
    const data = lines.join('');
    try { await fs.promises.appendFile(fp, data, 'utf-8'); } catch {}
}
function _elLogEnqueue(line) {
    _elLogChain = _elLogChain.then(() => _elLogAppendLines([line])).catch(()=>{});
}
function _elLogEnqueueBatch(lines) {
    if (!lines || !lines.length) return;
    _elLogChain = _elLogChain.then(() => _elLogAppendLines(lines)).catch(()=>{});
}
function elLogFile(level, msg, meta) {
    try {
        const ts = new Date().toISOString();
        const line = `${ts} ${level.padEnd(5)} ${msg}${meta ? ' ' + String(meta).slice(0, 2000) : ''}\n`;
        _elLogEnqueue(line);
    } catch {}
}
function elLogFileBatch(entries) {
    try {
        const lines = [];
        for (const e of entries) {
            const lvl = typeof e.level === 'string' ? e.level.toUpperCase() : 'INFO';
            const ts = e.ts ? new Date(e.ts).toISOString() : new Date().toISOString();
            const msg = typeof e.msg === 'string' ? e.msg.slice(0, 4000) : String(e.msg||'').slice(0,4000);
            const meta = e.meta ? String(e.meta).slice(0, 2000) : '';
            lines.push(`${ts} ${lvl.padEnd(5)} ${msg}${meta ? ' ' + meta : ''}\n`);
        }
        _elLogEnqueueBatch(lines);
    } catch {}
}
function elLog(level, msg, meta) {
    const prefix = `[EL:${level}]`;
    const text = `${prefix} ${msg}${meta ? ' ' + String(meta).slice(0, 500) : ''}`;
    try {
        if (level === 'ERROR') console.error(text);
        else if (level === 'WARN') console.warn(text);
        else if (level === 'INFO') console.info(text);
        else console.debug(text);
    } catch {}
    elLogFile(level, msg, meta);
}

// ── Defaults ──────────────────────────────────────────────────────────
// (Hub v2: DEFAULT_API_CONFIG removed — connections live in ST-RequestHub.)

const MAX_STRING_LENGTH = 2048;

// ── Paths ──────────────────────────────────────────────────────────────

function getStorageRoot() {
    const stRoot = path.resolve(__dirname, '..', '..');
    return path.join(stRoot, 'data', 'enhanced-lorebook-agent');
}

function backupsDir(lorebookName) {
    return path.join(getStorageRoot(), 'backups', lorebookName);
}

function agentBackupsDir(lorebookName) {
    return path.join(getStorageRoot(), 'agent-backups', lorebookName);
}

function backupWatchDir(lorebookName) {
    return path.join(getStorageRoot(), 'backup-watch', lorebookName);
}

function watchlistFile() {
    return path.join(getStorageRoot(), 'backup-watch', 'watchlist.json');
}

function snapshotsDir(lorebookName) {
    return path.join(getStorageRoot(), 'snapshots', lorebookName);
}

function trashFile(lorebookName) {
    return path.join(getStorageRoot(), 'trash', `${lorebookName}.json`);
}

function auditFile(lorebookName) {
    return path.join(getStorageRoot(), 'audit', `${lorebookName}.json`);
}

// ── Init helpers ──────────────────────────────────────────────────────

function agentChatsDir(agentId) {
    return path.join(getStorageRoot(), 'agent-chats', agentId || 'unknown');
}
function agentChatFile(agentId, chatId) {
    const a = sanitizeString(agentId) || 'unknown';
    const c = sanitizeString(chatId) || 'default';
    // sanitize chatId like proposals: allow underscores, hyphens, alphanumeric
    const safeC = c.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 120) || 'default';
    const safeA = a.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80) || 'unknown';
    return path.join(getStorageRoot(), 'agent-chats', safeA, `${safeC}.json`);
}

function ensureStorageDirectories() {
    const root = getStorageRoot();
    for (const sub of ['backups', 'agent-backups', 'proposals', 'snapshots', 'trash', 'audit', 'backup-watch', 'agent-chats']) {
        const dir = path.join(root, sub);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    // (Hub v2: api-config.json + secrets vault removed.)
}

/**
 * Read a JSON array file, tolerating missing/corrupt files.
 */
function readJsonArray(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Validate a lorebook name + optional id (path safe), responding with 400 on failure.
 */
function requireValidPathParams(req, res, { name, id } = {}) {
    const cleanName = sanitizeString(name);
    if (!cleanName) {
        res.status(400).json({ error: 'lorebookName is required' });
        return null;
    }
    if (!isValidPathComponent(cleanName)) {
        res.status(400).json({ error: 'lorebookName contains invalid characters' });
        return null;
    }
    const cleanId = id !== undefined ? sanitizeString(id) : undefined;
    if (id !== undefined && (!cleanId || !isValidPathComponent(cleanId))) {
        res.status(400).json({ error: 'Invalid characters in id' });
        return null;
    }
    return { name: cleanName, id: cleanId };
}

function isValidPathComponent(value) {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (value.includes('..') || value.includes('/') || value.includes('\\')) return false;
    return true;
}

function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

// ── Config helpers ────────────────────────────────────────────────────

/**
 * Sanitise a string: strip control characters / limit length.
 * Returns undefined for non-strings so callers can fall back.
 */
function sanitizeString(value, maxLen = MAX_STRING_LENGTH) {
    if (typeof value !== 'string') return undefined;
    return value
        .replace(/[\x00-\x1f\x7f]/g, '')   // strip control chars
        .trim()
        .slice(0, maxLen);
}

/**
 * Validate and normalise a number within [min, max].
 */
function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// ── Route handlers (storage only — Hub v2) ────────────────────────────
// (GET/PUT /agent/api-config, the secrets vault, /agent/direct-complete and
// /agent/research were removed. Connections + execution live in ST-RequestHub.)

// ── Agent Backups (isolated from generic backups) ─────────────────────

async function createAgentBackup(req, res) {
    const { lorebookName, lorebookData, folders } = req.body || {};
    const name = sanitizeString(lorebookName);
    if (!name) return res.status(400).json({ error: 'lorebookName is required' });
    if (!lorebookData || typeof lorebookData !== 'object' || Array.isArray(lorebookData)) {
        return res.status(400).json({ error: 'lorebookData must be a non-null object' });
    }
    if (!isValidPathComponent(name)) return res.status(400).json({ error: 'lorebookName contains invalid characters' });
    const backupId = `abackup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const dir = agentBackupsDir(name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const foldersSnapshot = Array.isArray(folders) ? folders : [];
    const record = { id: backupId, timestamp: Date.now(), lorebookName: name, data: lorebookData, folders: foldersSnapshot, source: 'agent' };
    fs.writeFileSync(path.join(dir, `${backupId}.json`), JSON.stringify(record, null, 2), 'utf-8');
    res.json({ backupId, timestamp: record.timestamp });
}

async function listAgentBackups(req, res) {
    const name = sanitizeString(req.query.lorebookName);
    if (!name) return res.status(400).json({ error: 'lorebookName query parameter is required' });
    if (!isValidPathComponent(name)) return res.status(400).json({ error: 'lorebookName contains invalid characters' });
    const dir = agentBackupsDir(name);
    if (!fs.existsSync(dir)) return res.json({ backups: [] });
    let files;
    try { files = fs.readdirSync(dir); } catch { return res.json({ backups: [] }); }
    const backups = files.filter(f => f.endsWith('.json')).map(f => {
        try {
            const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
            const parsed = JSON.parse(raw);
            return { id: parsed.id, timestamp: parsed.timestamp, lorebookName: parsed.lorebookName, source: parsed.source || 'agent' };
        } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
    res.json({ backups });
}

async function restoreAgentBackup(req, res) {
    const { backupId, lorebookName } = req.body || {};
    const name = sanitizeString(lorebookName);
    const id = sanitizeString(backupId);
    if (!name) return res.status(400).json({ error: 'lorebookName is required' });
    if (!id) return res.status(400).json({ error: 'backupId is required' });
    if (!isValidPathComponent(name) || !isValidPathComponent(id)) return res.status(400).json({ error: 'Invalid characters in lorebookName or backupId' });
    const filePath = path.join(agentBackupsDir(name), `${id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Agent backup not found' });
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const record = JSON.parse(raw);
        res.json({ success: true, lorebookData: record.data, folders: Array.isArray(record.folders) ? record.folders : [], timestamp: record.timestamp });
    } catch { return res.status(500).json({ error: 'Failed to read agent backup file' }); }
}

async function deleteAgentBackup(req, res) {
    const { backupId, lorebookName } = req.body || {};
    const name = sanitizeString(lorebookName);
    const id = sanitizeString(backupId);
    if (!name) return res.status(400).json({ error: 'lorebookName is required' });
    if (!id) return res.status(400).json({ error: 'backupId is required' });
    if (!isValidPathComponent(name) || !isValidPathComponent(id)) return res.status(400).json({ error: 'Invalid characters in lorebookName or backupId' });
    const filePath = path.join(agentBackupsDir(name), `${id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Agent backup not found' });
    try {
        fs.unlinkSync(filePath);
        const dir = agentBackupsDir(name);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        res.json({ success: true });
    } catch { return res.status(500).json({ error: 'Failed to delete agent backup file' }); }
}

// ── Backup ────────────────────────────────────────────────────────────

/**
 * POST /api/plugins/enhanced-lorebook-agent/backup/create
 *
 * Creates a backup of a lorebook's full data.
 */
async function createBackup(req, res) {
    const { lorebookName, lorebookData } = req.body || {};

    const name = sanitizeString(lorebookName);
    if (!name) {
        return res.status(400).json({ error: 'lorebookName is required' });
    }
    if (!lorebookData || typeof lorebookData !== 'object' || Array.isArray(lorebookData)) {
        return res.status(400).json({ error: 'lorebookData must be a non-null object' });
    }
    if (!isValidPathComponent(name)) {
        return res.status(400).json({ error: 'lorebookName contains invalid characters' });
    }

    const backupId = `backup_${Date.now()}`;
    const dir = backupsDir(name);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const record = {
        id: backupId,
        timestamp: Date.now(),
        lorebookName: name,
        data: lorebookData,
    };

    fs.writeFileSync(path.join(dir, `${backupId}.json`), JSON.stringify(record, null, 2), 'utf-8');

    res.json({ backupId, timestamp: record.timestamp });
}

/**
 * GET /api/plugins/enhanced-lorebook-agent/backup/list
 *
 * Lists all backups for a lorebook (metadata only, no data).
 */
async function listBackups(req, res) {
    const name = sanitizeString(req.query.lorebookName);
    if (!name) {
        return res.status(400).json({ error: 'lorebookName query parameter is required' });
    }
    if (!isValidPathComponent(name)) {
        return res.status(400).json({ error: 'lorebookName contains invalid characters' });
    }

    const dir = backupsDir(name);
    if (!fs.existsSync(dir)) {
        return res.json({ backups: [] });
    }

    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return res.json({ backups: [] });
    }

    const backups = files
        .filter(f => f.endsWith('.json'))
        .map(f => {
            try {
                const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
                const parsed = JSON.parse(raw);
                return { id: parsed.id, timestamp: parsed.timestamp, lorebookName: parsed.lorebookName };
            } catch {
                return null;
            }
        })
        .filter(b => b !== null)
        .sort((a, b) => b.timestamp - a.timestamp);

    res.json({ backups });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/backup/restore
 *
 * Reads and returns the full data of a specific backup.
 */
async function restoreBackup(req, res) {
    const { backupId, lorebookName } = req.body || {};

    const name = sanitizeString(lorebookName);
    const id = sanitizeString(backupId);

    if (!name) {
        return res.status(400).json({ error: 'lorebookName is required' });
    }
    if (!id) {
        return res.status(400).json({ error: 'backupId is required' });
    }
    if (!isValidPathComponent(name) || !isValidPathComponent(id)) {
        return res.status(400).json({ error: 'Invalid characters in lorebookName or backupId' });
    }

    const filePath = path.join(backupsDir(name), `${id}.json`);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const record = JSON.parse(raw);
        res.json({ success: true, lorebookData: record.data });
    } catch {
        return res.status(500).json({ error: 'Failed to read backup file' });
    }
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/backup/delete
 *
 * Deletes a single backup file.
 * Note: using POST because Express does not parse bodies on DELETE requests.
 */
async function deleteBackup(req, res) {
    const { backupId, lorebookName } = req.body || {};

    const name = sanitizeString(lorebookName);
    const id = sanitizeString(backupId);

    if (!name) {
        return res.status(400).json({ error: 'lorebookName is required' });
    }
    if (!id) {
        return res.status(400).json({ error: 'backupId is required' });
    }
    if (!isValidPathComponent(name) || !isValidPathComponent(id)) {
        return res.status(400).json({ error: 'Invalid characters in lorebookName or backupId' });
    }

    const filePath = path.join(backupsDir(name), `${id}.json`);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }

    try {
        fs.unlinkSync(filePath);

        // Clean up empty backup directories
        const dir = backupsDir(name);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
        }

        res.json({ success: true });
    } catch {
        return res.status(500).json({ error: 'Failed to delete backup file' });
    }
}

// ── Backup Watch ────────────────────────────────────────────────────────

const BACKUP_WATCH_INTERVAL_MS = 5 * 60 * 60 * 1000;   // automatic copies every 5 hours
const BACKUP_WATCH_RECENT_MS = 7 * 24 * 60 * 60 * 1000; // copies within the last week are kept whole
const BACKUP_WATCH_CHECK_INTERVAL_MS = 60 * 60 * 1000;  // scheduler runs hourly
let backupWatchTimer = null;

function readWatchlist() {
    const filePath = watchlistFile();
    if (!fs.existsSync(filePath)) return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch {
        return {};
    }
}

function writeWatchlist(watchlist) {
    const dir = path.join(getStorageRoot(), 'backup-watch');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(watchlistFile(), JSON.stringify(watchlist, null, 2), 'utf-8');
}

function readBackupWatchRecord(book, id) {
    const filePath = path.join(backupWatchDir(book), `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

function writeBackupWatchRecord(lorebookName, lorebookData, kind, folders) {
    const dir = backupWatchDir(lorebookName);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const timestamp = Date.now();
    const backupId = `bw_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
    const foldersSnapshot = Array.isArray(folders) ? folders : [];
    const record = {
        id: backupId,
        timestamp,
        lorebookName,
        kind, // 'simple' | 'auto'
        data: lorebookData,
        folders: foldersSnapshot,
    };
    fs.writeFileSync(path.join(dir, `${backupId}.json`), JSON.stringify(record, null, 2), 'utf-8');
    return { backupId, timestamp, kind };
}

function listBackupWatchFiles(book) {
    const dir = backupWatchDir(book);
    if (!fs.existsSync(dir)) return [];
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return files.filter(f => f.endsWith('.json'));
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/backup-watch/create
 *
 * Saves a full backup-watch snapshot of a lorebook's current state.
 * mode 'simple' saves a one-off snapshot; mode 'auto' additionally registers
 * (or updates) the book on the automatic 5-hour backup schedule.
 */
async function createBackupWatch(req, res) {
    const { lorebookName, mode, lorebookData, folders } = req.body || {};
    const params = requireValidPathParams(req, res, { name: lorebookName });
    if (!params) return;

    if (!lorebookData || typeof lorebookData !== 'object' || Array.isArray(lorebookData)) {
        return res.status(400).json({ error: 'lorebookData must be a non-null object' });
    }
    if (mode !== 'simple' && mode !== 'auto') {
        return res.status(400).json({ error: "mode must be 'simple' or 'auto'" });
    }

    const foldersSnapshot = Array.isArray(folders) ? folders : [];
    const { backupId, timestamp, kind } = writeBackupWatchRecord(params.name, lorebookData, mode, foldersSnapshot);

    const watchlist = readWatchlist();
    if (mode === 'auto') {
        watchlist[params.name] = { mode: 'auto', enabled: true, enabledAt: Date.now(), lastBackupAt: timestamp, cachedFolders: foldersSnapshot };
    } else {
        // A simple backup is a one-off snapshot: it must not leave the book on the auto schedule.
        delete watchlist[params.name];
    }
    writeWatchlist(watchlist);

    res.json({ backupId, timestamp, kind, watched: mode === 'auto' });
}

/**
 * GET /api/plugins/enhanced-lorebook-agent/backup-watch/status?lorebookName=
 *
 * Returns the watch state for a lorebook (registered mode, last/next auto copy).
 */
async function getBackupWatchStatus(req, res) {
    const params = requireValidPathParams(req, res, { name: req.query.lorebookName });
    if (!params) return;

    const watch = readWatchlist()[params.name];
    if (!watch || watch.mode !== 'auto' || watch.enabled === false) {
        return res.json({ watched: false, lorebookName: params.name });
    }

    const lastBackupAt = watch.lastBackupAt || 0;
    res.json({
        watched: true,
        lorebookName: params.name,
        mode: watch.mode,
        enabledAt: watch.enabledAt || 0,
        lastBackupAt,
        nextBackupAt: lastBackupAt ? lastBackupAt + BACKUP_WATCH_INTERVAL_MS : Date.now(),
        intervalMs: BACKUP_WATCH_INTERVAL_MS,
    });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/backup-watch/disable
 *
 * Removes a lorebook from the automatic backup schedule. Existing backups stay.
 */
async function disableBackupWatch(req, res) {
    const params = requireValidPathParams(req, res, { name: (req.body || {}).lorebookName });
    if (!params) return;

    const watchlist = readWatchlist();
    delete watchlist[params.name];
    writeWatchlist(watchlist);

    res.json({ success: true, watched: false });
}

/**
 * GET /api/plugins/enhanced-lorebook-agent/backup-watch/list?lorebookName=
 *
 * Lists backup-watch backups for a lorebook (metadata only, no data).
 */
async function listBackupWatches(req, res) {
    const params = requireValidPathParams(req, res, { name: req.query.lorebookName });
    if (!params) return;

    const backups = listBackupWatchFiles(params.name)
        .map(f => {
            const rec = readBackupWatchRecord(params.name, f.replace(/\.json$/, ''));
            if (!rec) return null;
            return { id: rec.id, timestamp: rec.timestamp, lorebookName: rec.lorebookName, kind: rec.kind, hasFolders: Array.isArray(rec.folders) && rec.folders.length > 0 };
        })
        .filter(b => b !== null)
        .sort((a, b) => b.timestamp - a.timestamp);

    res.json({ backups, count: backups.length });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/backup-watch/get
 *
 * Returns the full record of a specific backup-watch backup (for viewing).
 */
async function getBackupWatch(req, res) {
    const { lorebookName, backupId } = req.body || {};
    const params = requireValidPathParams(req, res, { name: lorebookName, id: backupId });
    if (!params) return;

    const rec = readBackupWatchRecord(params.name, params.id);
    if (!rec) return res.status(404).json({ error: 'Backup not found' });

    res.json({ success: true, backup: rec });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/backup-watch/restore
 *
 * Returns the full lorebook data of a specific backup-watch backup so the
 * client can diff it against the live book, confirm, then restore via guardSave.
 */
async function restoreBackupWatch(req, res) {
    const { lorebookName, backupId } = req.body || {};
    const params = requireValidPathParams(req, res, { name: lorebookName, id: backupId });
    if (!params) return;

    const rec = readBackupWatchRecord(params.name, params.id);
    if (!rec) return res.status(404).json({ error: 'Backup not found' });

    res.json({ success: true, lorebookName: rec.lorebookName, timestamp: rec.timestamp, lorebookData: rec.data, folders: Array.isArray(rec.folders) ? rec.folders : [] });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/backup-watch/delete
 *
 * Deletes a single backup-watch backup file.
 * Note: using POST because Express does not parse bodies on DELETE requests.
 */
async function deleteBackupWatch(req, res) {
    const { lorebookName, backupId } = req.body || {};
    const params = requireValidPathParams(req, res, { name: lorebookName, id: backupId });
    if (!params) return;

    const filePath = path.join(backupWatchDir(params.name), `${params.id}.json`);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Backup not found' });
    }

    try {
        fs.unlinkSync(filePath);

        const dir = backupWatchDir(params.name);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
        }

        res.json({ success: true });
    } catch {
        return res.status(500).json({ error: 'Failed to delete backup file' });
    }
}

/**
 * Locate a lorebook's JSON file on disk across all user worlds directories.
 * The first match wins, matching the client's per-user book set.
 */
async function findWorldInfoFile(lorebookName) {
    const filename = `${sanitize(lorebookName)}.json`;
    const handles = await getAllUserHandles();
    for (const handle of handles) {
        try {
            const dirs = getUserDirectories(handle);
            const candidate = path.join(dirs.worlds, filename);
            if (fs.existsSync(candidate)) return candidate;
        } catch {
            // skip users we can't resolve
        }
    }
    return null;
}

/**
 * Write a new backup-watch record straight from the lorebook file on disk.
 * Used by the scheduler so automatic copies work even while the app is closed.
 */
async function writeDiskBackupWatchRecord(lorebookName, kind) {
    const filePath = await findWorldInfoFile(lorebookName);
    if (!filePath) return null;
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        if (!data.entries || typeof data.entries !== 'object') data.entries = {};
        // For scheduler auto copies, reuse cached folder mapping from watchlist if available
        // (scheduler runs while app may be closed, so it has no live extensionSettings)
        let cachedFolders = [];
        try {
            const wl = readWatchlist();
            const w = wl[lorebookName];
            if (w && Array.isArray(w.cachedFolders)) cachedFolders = w.cachedFolders;
        } catch {}
        return writeBackupWatchRecord(lorebookName, data, kind, cachedFolders);
    } catch {
        return null;
    }
}

/**
 * Run the automatic backup schedule: any watched book whose last backup is
 * 5+ hours old gets a fresh copy taken from the lorebook file on disk.
 */
async function runAutoBackupWatches() {
    const watchlist = readWatchlist();
    const now = Date.now();
    let created = 0;

    for (const [book, watch] of Object.entries(watchlist)) {
        if (!watch || watch.mode !== 'auto' || watch.enabled === false) continue;
        if (!isValidPathComponent(book)) continue;
        if (now - (watch.lastBackupAt || 0) < BACKUP_WATCH_INTERVAL_MS) continue;

        const rec = await writeDiskBackupWatchRecord(book, 'auto');
        if (rec) {
            watch.lastBackupAt = now;
            watch.enabledAt = watch.enabledAt || now;
            created++;
        } else {
            console.warn(`[${PLUGIN_NAME}] Backup watch: could not locate lorebook "${book}" for scheduled backup`);
        }
    }

    if (created) {
        writeWatchlist(watchlist);
        console.log(`[${PLUGIN_NAME}] Backup watch: created ${created} scheduled backup(s)`);
    }
}

/**
 * Retention for backup-watch backups:
 *  - copies within the last week: all kept
 *  - auto copies older than a week: collapsed to the newest per calendar day
 *  - simple backups: never touched
 */
function runBackupWatchRetention() {
    const root = path.join(getStorageRoot(), 'backup-watch');
    if (!fs.existsSync(root)) return;

    const cutoff = Date.now() - BACKUP_WATCH_RECENT_MS;
    let deleted = 0;

    let bookDirs = [];
    try {
        bookDirs = fs.readdirSync(root).filter(d => {
            const full = path.join(root, d);
            try {
                return fs.statSync(full).isDirectory();
            } catch {
                return false;
            }
        });
    } catch {
        return;
    }

    for (const book of bookDirs) {
        const dir = path.join(root, book);
        const records = listBackupWatchFiles(book)
            .map(f => ({ file: f, id: f.replace(/\.json$/, ''), rec: readBackupWatchRecord(book, f.replace(/\.json$/, '')) }))
            .filter(x => x.rec);

        const autoOld = records.filter(x => x.rec.kind === 'auto' && cutoff - x.rec.timestamp > 0);
        const byDay = new Map();
        for (const x of autoOld) {
            const d = new Date(x.rec.timestamp);
            const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            const bucket = byDay.get(key) || [];
            bucket.push(x);
            byDay.set(key, bucket);
        }

        for (const dayItems of byDay.values()) {
            if (dayItems.length <= 1) continue;
            dayItems.sort((a, b) => b.rec.timestamp - a.rec.timestamp);
            for (const x of dayItems.slice(1)) {
                try {
                    fs.unlinkSync(path.join(dir, x.file));
                    deleted++;
                } catch {
                    // skip files we can't delete
                }
            }
        }
    }

    if (deleted > 0) {
        console.log(`[${PLUGIN_NAME}] Backup watch: collapsed ${deleted} redundant daily backup(s)`);
    }

    // Sweep now-empty book folders.
    if (fs.existsSync(root)) {
        for (const d of fs.readdirSync(root)) {
            const full = path.join(root, d);
            try {
                if (fs.statSync(full).isDirectory() && fs.readdirSync(full).length === 0) {
                    fs.rmdirSync(full);
                }
            } catch {
                // ignore
            }
        }
    }
}

async function runBackupWatchScheduler() {
    try {
        await runAutoBackupWatches();
    } catch (e) {
        console.warn(`[${PLUGIN_NAME}] Backup watch scheduler error`, e);
    }
    try {
        runBackupWatchRetention();
    } catch (e) {
        console.warn(`[${PLUGIN_NAME}] Backup watch retention error`, e);
    }
}

// ── Snapshots ─────────────────────────────────────────────────────────

/**
 * POST /api/plugins/enhanced-lorebook-agent/snapshot/create
 *
 * Saves a full snapshot of a lorebook's data. Retention is handled by
 * runSnapshotCleanup() (keep last N, cap by age).
 */
async function createSnapshot(req, res) {
    const { lorebookName, lorebookData, folders } = req.body || {};
    const params = requireValidPathParams(req, res, { name: lorebookName });
    if (!params) return;

    if (!lorebookData || typeof lorebookData !== 'object' || Array.isArray(lorebookData)) {
        return res.status(400).json({ error: 'lorebookData must be a non-null object' });
    }

    const dir = snapshotsDir(params.name);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const timestamp = Date.now();
    const snapshotId = `snap_${timestamp}`;
    // folders is extension-only (never pollutes ST data) — snapshot it alongside lorebookData so URL is respected on restore
    const foldersSnapshot = Array.isArray(folders) ? folders : [];
    const record = {
        id: snapshotId,
        timestamp,
        lorebookName: params.name,
        data: lorebookData,
        folders: foldersSnapshot,
    };

    fs.writeFileSync(path.join(dir, `${snapshotId}.json`), JSON.stringify(record, null, 2), 'utf-8');

    res.json({ snapshotId, timestamp });
}

/**
 * GET /api/plugins/enhanced-lorebook-agent/snapshot/list
 *
 * Lists snapshots for a lorebook (metadata only).
 */
async function listSnapshots(req, res) {
    const params = requireValidPathParams(req, res, { name: req.query.lorebookName });
    if (!params) return;

    const dir = snapshotsDir(params.name);
    if (!fs.existsSync(dir)) {
        return res.json({ snapshots: [] });
    }

    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return res.json({ snapshots: [] });
    }

    const snapshots = files
        .filter(f => f.endsWith('.json'))
        .map(f => {
            try {
                const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
                const parsed = JSON.parse(raw);
                return { id: parsed.id, timestamp: parsed.timestamp, lorebookName: parsed.lorebookName, hasFolders: Array.isArray(parsed.folders) && parsed.folders.length > 0 };
            } catch {
                return null;
            }
        })
        .filter(s => s !== null)
        .sort((a, b) => b.timestamp - a.timestamp);

    res.json({ snapshots });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/snapshot/restore
 *
 * Reads and returns the full data of a specific snapshot.
 */
async function restoreSnapshot(req, res) {
    const { snapshotId, lorebookName } = req.body || {};
    const params = requireValidPathParams(req, res, { name: lorebookName, id: snapshotId });
    if (!params) return;

    const filePath = path.join(snapshotsDir(params.name), `${params.id}.json`);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Snapshot not found' });
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const record = JSON.parse(raw);
        res.json({ success: true, lorebookData: record.data, folders: Array.isArray(record.folders) ? record.folders : [], timestamp: record.timestamp });
    } catch {
        return res.status(500).json({ error: 'Failed to read snapshot file' });
    }
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/snapshot/delete
 *
 * Deletes a single snapshot file.
 * Note: using POST because Express does not parse bodies on DELETE requests.
 */
async function deleteSnapshot(req, res) {
    const { snapshotId, lorebookName } = req.body || {};
    const params = requireValidPathParams(req, res, { name: lorebookName, id: snapshotId });
    if (!params) return;

    const dir = snapshotsDir(params.name);
    const filePath = path.join(dir, `${params.id}.json`);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Snapshot not found' });
    }

    try {
        fs.unlinkSync(filePath);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
        }
        res.json({ success: true });
    } catch {
        return res.status(500).json({ error: 'Failed to delete snapshot file' });
    }
}

// ── Trash ─────────────────────────────────────────────────────────────

/**
 * POST /api/plugins/enhanced-lorebook-agent/trash/add
 *
 * Quarantines removed entries so they can be recovered later.
 * entries: array of { uid, entry, deletedAt? }
 */
async function addToTrash(req, res) {
    const { lorebookName, entries, source, note } = req.body || {};
    const params = requireValidPathParams(req, res, { name: lorebookName });
    if (!params) return;

    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ error: 'entries must be a non-empty array' });
    }

    const filePath = trashFile(params.name);
    const trash = readJsonArray(filePath);
    const now = Date.now();

    for (const e of entries) {
        if (!e || typeof e !== 'object' || e.uid === undefined || e.uid === null) continue;
        if (!e.entry || typeof e.entry !== 'object') continue;
        trash.push({
            id: `trash_${now}_${Math.random().toString(36).slice(2, 8)}`,
            uid: String(e.uid),
            entry: e.entry,
            deletedAt: e.deletedAt || now,
            source: sanitizeString(source) || 'unknown',
            note: sanitizeString(note) || '',
        });
    }

    fs.writeFileSync(filePath, JSON.stringify(trash, null, 2), 'utf-8');
    res.json({ success: true, count: trash.length });
}

/**
 * GET /api/plugins/enhanced-lorebook-agent/trash/list
 *
 * Lists all trashed entries for a lorebook, newest first.
 */
async function listTrash(req, res) {
    const params = requireValidPathParams(req, res, { name: req.query.lorebookName });
    if (!params) return;

    const trash = readJsonArray(trashFile(params.name));
    trash.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    res.json({ entries: trash });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/trash/restore
 *
 * Removes matching entries from the trash and returns their full data so
 * the client can re-insert them with fresh UIDs.
 */
async function restoreFromTrash(req, res) {
    const { lorebookName, uids } = req.body || {};
    const params = requireValidPathParams(req, res, { name: lorebookName });
    if (!params) return;

    if (!Array.isArray(uids) || uids.length === 0) {
        return res.status(400).json({ error: 'uids must be a non-empty array' });
    }

    const filePath = trashFile(params.name);
    const trash = readJsonArray(filePath);
    const uidSet = new Set(uids.map(String));
    const restored = [];
    const kept = [];

    for (const t of trash) {
        if (uidSet.has(String(t.uid))) {
            restored.push(t);
        } else {
            kept.push(t);
        }
    }

    if (restored.length > 0) {
        if (kept.length > 0) {
            fs.writeFileSync(filePath, JSON.stringify(kept, null, 2), 'utf-8');
        } else if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    res.json({ success: true, entries: restored });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/trash/delete
 *
 * Permanently deletes matching entries from the trash.
 */
async function deleteFromTrash(req, res) {
    const { lorebookName, uids } = req.body || {};
    const params = requireValidPathParams(req, res, { name: lorebookName });
    if (!params) return;

    if (!Array.isArray(uids) || uids.length === 0) {
        return res.status(400).json({ error: 'uids must be a non-empty array' });
    }

    const filePath = trashFile(params.name);
    const trash = readJsonArray(filePath);
    const uidSet = new Set(uids.map(String));
    const kept = trash.filter(t => !uidSet.has(String(t.uid)));
    const removed = trash.length - kept.length;

    if (kept.length > 0) {
        fs.writeFileSync(filePath, JSON.stringify(kept, null, 2), 'utf-8');
    } else if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }

    res.json({ success: true, removedCount: removed });
}

// ── Audit log ─────────────────────────────────────────────────────────

const MAX_AUDIT_ENTRIES = 500;

/**
 * POST /api/plugins/enhanced-lorebook-agent/audit/append
 *
 * Appends an event to a lorebook's audit log.
 */
async function appendAudit(req, res) {
    const { lorebookName, entry } = req.body || {};
    const params = requireValidPathParams(req, res, { name: lorebookName });
    if (!params) return;

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return res.status(400).json({ error: 'entry must be a non-null object' });
    }

    const filePath = auditFile(params.name);
    const audit = readJsonArray(filePath);
    audit.push({ ts: Date.now(), ...entry });
    if (audit.length > MAX_AUDIT_ENTRIES) {
        audit.splice(0, audit.length - MAX_AUDIT_ENTRIES);
    }
    fs.writeFileSync(filePath, JSON.stringify(audit, null, 2), 'utf-8');

    res.json({ success: true, count: audit.length });
}

/**
 * GET /api/plugins/enhanced-lorebook-agent/audit/list
 *
 * Lists the audit log for a lorebook, newest first.
 */
async function listAudit(req, res) {
    const params = requireValidPathParams(req, res, { name: req.query.lorebookName });
    if (!params) return;

    const audit = readJsonArray(auditFile(params.name));
    audit.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    res.json({ entries: audit });
}

// ── Per-agent chat (unbounded, one thread per agent/chatId, forked style) ───

function readAgentChatFile(agentId, chatId) {
    const fp = agentChatFile(agentId, chatId);
    if (!fs.existsSync(fp)) return null;
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (e) { elLog('WARN', `agent-chats read failed ${agentId}/${chatId}`, e?.message); return null; }
}
function writeAgentChatFile(agentId, chatId, data) {
    const fp = agentChatFile(agentId, chatId);
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
}
async function listAgentChats(req, res) {
    const agentId = sanitizeString(req.query.agentId);
    if (!agentId) return res.status(400).json({ error: 'agentId query required' });
    if (!isValidPathComponent(agentId.replace(/[^a-zA-Z0-9_\-]/g, ''))) return res.status(400).json({ error: 'invalid agentId' });
    const dir = agentChatsDir(agentId);
    if (!fs.existsSync(dir)) return res.json({ chats: [] });
    let files; try { files = fs.readdirSync(dir); } catch (e) { elLog('WARN', 'listAgentChats readdir failed', e?.message); return res.json({ chats: [] }); }
    const chats = files.filter(f=>f.endsWith('.json')).map(f=>{
        try { const j=JSON.parse(fs.readFileSync(path.join(dir,f),'utf-8')); return { chatId: j.chatId || f.replace(/\.json$/,''), updatedAt: j.updatedAt||0, messageCount: Array.isArray(j.messages)? j.messages.length:0 }; } catch { return null; }
    }).filter(Boolean).sort((a,b)=>b.updatedAt-a.updatedAt);
    elLog('INFO', `listAgentChats agent=${agentId} count=${chats.length}`);
    res.json({ chats });
}
async function getAgentChat(req, res) {
    const agentId = sanitizeString(req.query.agentId);
    const chatId = sanitizeString(req.query.chatId);
    if (!agentId || !chatId) return res.status(400).json({ error: 'agentId and chatId required' });
    const data = readAgentChatFile(agentId, chatId);
    if (!data) return res.json({ messages: [], chatId, agentId, updatedAt: 0 });
    elLog('INFO', `getAgentChat agent=${agentId} chat=${chatId} msgs=${(data.messages||[]).length}`);
    res.json(data);
}
async function saveAgentChat(req, res) {
    const { agentId, chatId, messages } = req.body || {};
    const a = sanitizeString(agentId);
    const c = sanitizeString(chatId);
    if (!a || !c) return res.status(400).json({ error: 'agentId and chatId required' });
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages must be array' });
    // Unbounded but cap at 5000 to avoid abuse (still effectively unbounded per user request)
    if (messages.length > 5000) return res.status(400).json({ error: 'messages exceeds limit 5000' });
    const payload = { agentId: a, chatId: c, messages, updatedAt: Date.now() };
    writeAgentChatFile(a, c, payload);
    elLog('INFO', `saveAgentChat agent=${a} chat=${c} msgs=${messages.length}`);
    res.json({ success: true, messageCount: messages.length });
}
async function deleteAgentChat(req, res) {
    const { agentId, chatId } = req.body || {};
    const a = sanitizeString(agentId); const c = sanitizeString(chatId);
    if (!a || !c) return res.status(400).json({ error: 'agentId and chatId required' });
    const fp = agentChatFile(a, c);
    if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (e) { elLog('WARN', 'deleteAgentChat unlink failed', e?.message); return res.status(500).json({ error: 'delete failed' }); } }
    // cleanup empty dir
    try { const dir = agentChatsDir(a); if (fs.existsSync(dir) && fs.readdirSync(dir).length===0) fs.rmdirSync(dir); } catch {}
    elLog('INFO', `deleteAgentChat agent=${a} chat=${c}`);
    res.json({ success: true });
}
async function clearAgentChat(req, res) {
    const { agentId, chatId } = req.body || {};
    const a = sanitizeString(agentId); const c = sanitizeString(chatId);
    if (!a || !c) return res.status(400).json({ error: 'agentId and chatId required' });
    const payload = { agentId: a, chatId: c, messages: [], updatedAt: Date.now() };
    writeAgentChatFile(a, c, payload);
    elLog('INFO', `clearAgentChat agent=${a} chat=${c}`);
    res.json({ success: true });
}

// ── Proposals ─────────────────────────────────────────────────────────

const PROPOSAL_REQUIRED_FIELDS = ['id', 'action', 'lorebookName', 'status'];
const MAX_PENDING_PROPOSALS = 100;

/**
 * Read the proposals file for a given chatId.
 * Returns the parsed object or null if it doesn't exist or is corrupt.
 */
function readProposalsFile(chatId) {
    const filePath = path.join(getStorageRoot(), 'proposals', `${chatId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

/**
 * Write the full proposals object for a given chatId.
 */
function writeProposalsFile(chatId, data) {
    const filePath = path.join(getStorageRoot(), 'proposals', `${chatId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Delete the proposals file for a chatId (used when proposals array becomes empty).
 */
function deleteProposalsFile(chatId) {
    const filePath = path.join(getStorageRoot(), 'proposals', `${chatId}.json`);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

/**
 * Validate a proposal object has all required fields.
 */
function isValidProposal(proposal) {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return false;
    return PROPOSAL_REQUIRED_FIELDS.every(f => {
        const v = proposal[f];
        return typeof v === 'string' && v.length > 0;
    });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/proposals/save
 *
 * Save a single proposal for a chat.
 */
async function saveProposal(req, res) {
    const { chatId, proposal } = req.body || {};

    const sanitizedChatId = sanitizeString(chatId);
    if (!sanitizedChatId) {
        return res.status(400).json({ error: 'chatId is required' });
    }
    if (!isValidProposal(proposal)) {
        return res.status(400).json({ error: `proposal must have fields: ${PROPOSAL_REQUIRED_FIELDS.join(', ')}` });
    }
    if (!isValidPathComponent(sanitizedChatId)) {
        return res.status(400).json({ error: 'chatId contains invalid characters' });
    }

    const existing = readProposalsFile(sanitizedChatId);
    const proposals = existing ? existing.proposals : [];

    if (proposals.length >= MAX_PENDING_PROPOSALS) {
        return res.status(400).json({ error: `Proposal limit (${MAX_PENDING_PROPOSALS}) reached for this chat` });
    }

    proposals.push(proposal);
    writeProposalsFile(sanitizedChatId, { chatId: sanitizedChatId, proposals });

    res.json({ success: true, proposalCount: proposals.length });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/proposals/batch-save
 *
 * Save an array of proposals for a chat in one request.
 */
async function batchSaveProposals(req, res) {
    const { chatId, proposals: incoming } = req.body || {};

    const sanitizedChatId = sanitizeString(chatId);
    if (!sanitizedChatId) {
        return res.status(400).json({ error: 'chatId is required' });
    }
    if (!Array.isArray(incoming) || incoming.length === 0) {
        return res.status(400).json({ error: 'proposals must be a non-empty array' });
    }
    if (!isValidPathComponent(sanitizedChatId)) {
        return res.status(400).json({ error: 'chatId contains invalid characters' });
    }

    for (const p of incoming) {
        if (!isValidProposal(p)) {
            return res.status(400).json({ error: `Invalid proposal: ${p?.id || 'unknown'}` });
        }
    }

    const existing = readProposalsFile(sanitizedChatId);
    const proposals = existing ? existing.proposals : [];

    if (proposals.length + incoming.length > MAX_PENDING_PROPOSALS) {
        return res.status(400).json({ error: `Adding ${incoming.length} proposals would exceed the limit of ${MAX_PENDING_PROPOSALS}` });
    }

    proposals.push(...incoming);
    writeProposalsFile(sanitizedChatId, { chatId: sanitizedChatId, proposals });

    res.json({ success: true, count: proposals.length });
}

/**
 * GET /api/plugins/enhanced-lorebook-agent/proposals/list
 *
 * List all proposals for a given chat.
 */
async function listProposals(req, res) {
    const sanitizedChatId = sanitizeString(req.query.chatId);
    if (!sanitizedChatId) {
        return res.status(400).json({ error: 'chatId query parameter is required' });
    }

    const existing = readProposalsFile(sanitizedChatId);
    const proposals = existing ? existing.proposals : [];

    res.json({ proposals });
}

/**
 * GET /api/plugins/enhanced-lorebook-agent/proposals/list-all
 *
 * List proposals across ALL chat files (All-chats feed scope — finds
 * proposals saved under a different chatId). Read-only.
 */
async function listAllProposals(req, res) {
    const dir = path.join(getStorageRoot(), 'proposals');
    const chats = [];
    try {
        if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith('.json')) continue;
                try {
                    const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
                    const list = Array.isArray(parsed?.proposals) ? parsed.proposals : [];
                    if (!list.length) continue;
                    chats.push({
                        chatId: (parsed && typeof parsed.chatId === 'string' && parsed.chatId)
                            ? parsed.chatId
                            : f.replace(/\.json$/, ''),
                        proposals: list,
                    });
                } catch {}
            }
        }
    } catch {}
    res.json({ chats });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/proposals/update-status
 *
 * Update the status (and optionally userFeedback) of a single proposal.
 */
async function updateProposalStatus(req, res) {
    const { chatId, proposalId, newStatus, userFeedback } = req.body || {};

    const sanitizedChatId = sanitizeString(chatId);
    const sanitizedProposalId = sanitizeString(proposalId);
    const sanitizedStatus = sanitizeString(newStatus);
    const sanitizedFeedback = typeof userFeedback === 'string' ? sanitizeString(userFeedback) : undefined;

    if (!sanitizedChatId) {
        return res.status(400).json({ error: 'chatId is required' });
    }
    if (!sanitizedProposalId) {
        return res.status(400).json({ error: 'proposalId is required' });
    }
    if (!sanitizedStatus) {
        return res.status(400).json({ error: 'newStatus is required' });
    }
    if (!isValidPathComponent(sanitizedChatId)) {
        return res.status(400).json({ error: 'chatId contains invalid characters' });
    }

    const existing = readProposalsFile(sanitizedChatId);
    if (!existing) {
        return res.status(404).json({ error: 'No proposals found for this chat' });
    }

    const proposal = existing.proposals.find(p => p.id === sanitizedProposalId);
    if (!proposal) {
        return res.status(404).json({ error: 'Proposal not found' });
    }

    proposal.status = sanitizedStatus;
    if (sanitizedFeedback !== undefined) {
        proposal.userFeedback = sanitizedFeedback;
    }

    writeProposalsFile(sanitizedChatId, existing);

    res.json({ success: true });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/proposals/batch-update-status
 *
 * Update the status of multiple proposals at once (Accept All / Deny All).
 */
async function batchUpdateProposalStatus(req, res) {
    const { chatId, proposalIds, newStatus } = req.body || {};

    const sanitizedChatId = sanitizeString(chatId);
    const sanitizedStatus = sanitizeString(newStatus);

    if (!sanitizedChatId) {
        return res.status(400).json({ error: 'chatId is required' });
    }
    if (!Array.isArray(proposalIds) || proposalIds.length === 0) {
        return res.status(400).json({ error: 'proposalIds must be a non-empty array' });
    }
    if (!sanitizedStatus) {
        return res.status(400).json({ error: 'newStatus is required' });
    }
    if (!isValidPathComponent(sanitizedChatId)) {
        return res.status(400).json({ error: 'chatId contains invalid characters' });
    }

    const existing = readProposalsFile(sanitizedChatId);
    if (!existing) {
        return res.status(404).json({ error: 'No proposals found for this chat' });
    }

    let updatedCount = 0;
    for (const pid of proposalIds) {
        const p = existing.proposals.find(prop => prop.id === pid);
        if (p) {
            p.status = sanitizedStatus;
            updatedCount++;
        }
    }

    writeProposalsFile(sanitizedChatId, existing);

    res.json({ success: true, updatedCount });
}

/**
 * POST /api/plugins/enhanced-lorebook-agent/proposals/delete
 *
 * Delete specific proposals from a chat's file.
 */
async function deleteProposals(req, res) {
    const { chatId, proposalIds } = req.body || {};

    const sanitizedChatId = sanitizeString(chatId);

    if (!sanitizedChatId) {
        return res.status(400).json({ error: 'chatId is required' });
    }
    if (!Array.isArray(proposalIds) || proposalIds.length === 0) {
        return res.status(400).json({ error: 'proposalIds must be a non-empty array' });
    }
    if (!isValidPathComponent(sanitizedChatId)) {
        return res.status(400).json({ error: 'chatId contains invalid characters' });
    }

    const existing = readProposalsFile(sanitizedChatId);
    if (!existing) {
        return res.status(404).json({ error: 'No proposals found for this chat' });
    }

    const idSet = new Set(proposalIds);
    const before = existing.proposals.length;
    existing.proposals = existing.proposals.filter(p => !idSet.has(p.id));
    const removed = before - existing.proposals.length;

    if (existing.proposals.length === 0) {
        deleteProposalsFile(sanitizedChatId);
    } else {
        writeProposalsFile(sanitizedChatId, existing);
    }

    res.json({ success: true, removedCount: removed });
}

// ── LLM execution — REMOVED (Hub v2). ──
// ST-RequestHub owns all model calls now. The credential resolution,
// direct provider fetch, and SearXNG proxy below were deleted.

// (Hub v2: credential-resolution helpers removed — the hub resolves keys.)

// (Hub v2: elResolveDirectCredential body removed — the hub resolves keys.)

// (Hub v2: elCleanDirectMessages removed.)

// (Hub v2: proxyDirectComplete removed — ST-RequestHub executes model calls.)

// (Hub v2: SearXNG research proxy removed.)

// ── Retention cleanup ─────────────────────────────────────────────────

const SNAPSHOT_MAX_PER_BOOK = 50;      // keep the latest N per book
const SNAPSHOT_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour
let cleanupTimer = null;

/**
 * Prune a per-book JSON snapshot/backup directory:
 *  - drop files older than SNAPSHOT_TTL_MS
 *  - keep at most SNAPSHOT_MAX_PER_BOOK (by timestamp, newest kept)
 *  - remove empty directories
 */
function pruneBookDir(dirPath) {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return;

    let files;
    try {
        files = fs.readdirSync(dirPath);
    } catch {
        return;
    }

    const now = Date.now();
    const entries = [];

    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(dirPath, file);
        let timestamp;
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            timestamp = parsed.timestamp;
        } catch {
            const match = file.match(/(\d+)/);
            if (match) timestamp = parseInt(match[1], 10);
        }
        if (!timestamp) timestamp = now;
        entries.push({ filePath, file, timestamp });
    }

    // Age-based pruning
    const toDelete = entries.filter(e => now - e.timestamp > SNAPSHOT_TTL_MS);

    // Count-based pruning (keep newest)
    entries.sort((a, b) => b.timestamp - a.timestamp);
    entries.slice(SNAPSHOT_MAX_PER_BOOK).forEach(e => {
        if (!toDelete.some(d => d.filePath === e.filePath)) {
            toDelete.push(e);
        }
    });

    let deleted = 0;
    for (const e of toDelete) {
        try {
            fs.unlinkSync(e.filePath);
            deleted++;
        } catch {
            // skip files we can't delete
        }
    }

    // Remove empty lorebook directories
    try {
        if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
            fs.rmdirSync(dirPath);
        }
    } catch {
        // skip
    }

    return deleted;
}

/**
 * Walk all backup/{book} and snapshot/{book} directories and prune them.
 */
function runBackupCleanup() {
    let deleted = 0;
    for (const root of ['backups', 'agent-backups', 'snapshots']) {
        const backupsRoot = path.join(getStorageRoot(), root);
        if (!fs.existsSync(backupsRoot)) continue;

        try {
            const lorebookDirs = fs.readdirSync(backupsRoot);
            for (const lorebookDir of lorebookDirs) {
                const dirPath = path.join(backupsRoot, lorebookDir);
                if (!fs.statSync(dirPath).isDirectory()) continue;
                deleted += pruneBookDir(dirPath) || 0;
            }
        } catch {
            // ignore top-level read errors
        }
    }

    if (deleted > 0) {
        console.log(`[${PLUGIN_NAME}] Cleanup: pruned ${deleted} expired backup/snapshot(s)`);
    }
}

async function handleClientLog(req, res) {
    const { level, msg, meta } = req.body || {};
    const lvl = typeof level === 'string' ? level.toUpperCase() : 'INFO';
    const text = typeof msg === 'string' ? msg.slice(0, 4000) : JSON.stringify(msg || '').slice(0, 4000);
    elLogFile(lvl, `[CLIENT] ${text}`, meta ? String(meta).slice(0, 2000) : '');
    res.json({ ok: true });
}

async function handleClientLogBatch(req, res) {
    const { entries } = req.body || {};
    if (!Array.isArray(entries) || entries.length === 0) return res.json({ ok: true, flushed: 0 });
    const capped = entries.slice(0, 300);
    const batch = [];
    for (const e of capped) {
        const lvl = typeof e.level === 'string' ? e.level.toUpperCase() : 'INFO';
        const text = typeof e.msg === 'string' ? e.msg.slice(0, 4000) : String(e.msg||'').slice(0,4000);
        const meta = e.meta ? String(e.meta).slice(0, 2000) : '';
        const ts = e.ts && Number.isFinite(Number(e.ts)) ? Number(e.ts) : Date.now();
        batch.push({ level: lvl, msg: `[CLIENT] ${text}`, meta, ts });
    }
    try { elLogFileBatch(batch); } catch {}
    res.json({ ok: true, flushed: capped.length });
}

// Tail of extension.log for the in-extension Terminal panel. Log lines are
// single-line (`ts LEVEL msg meta…`, meta is JSON-escaped), so a byte-window
// read from the end + line split is sufficient. Read-only, capped.
async function tailExtensionLog(req, res) {
    const maxLines = Math.max(1, Math.min(2000, parseInt(req.query?.lines, 10) || 300));
    const fp = EXT_LOG_FILE();
    try {
        if (!fs.existsSync(fp)) return res.json({ lines: [], truncated: false });
        const stat = await fs.promises.stat(fp);
        const maxBytes = 512 * 1024;
        const start = Math.max(0, stat.size - maxBytes);
        const fh = await fs.promises.open(fp, 'r');
        try {
            const len = stat.size - start;
            const buf = Buffer.alloc(len);
            if (len > 0) await fh.read(buf, 0, len, start);
            let text = buf.toString('utf-8');
            if (start > 0) {
                const nl = text.indexOf('\n');
                text = nl >= 0 ? text.slice(nl + 1) : '';
            }
            const all = text.split('\n').filter(l => l.length);
            return res.json({ lines: all.slice(-maxLines), truncated: all.length > maxLines || start > 0 });
        } finally {
            try { await fh.close(); } catch {}
        }
    } catch (e) {
        return res.json({ lines: [], error: e?.message || String(e) });
    }
}

// ── Init ──────────────────────────────────────────────────────────────

export async function init(router) {
    elLog('INFO', `Initializing v${PLUGIN_VERSION}...`);
    console.log(`[${PLUGIN_NAME}] Initializing v${PLUGIN_VERSION}...`);

    ensureStorageDirectories();
    elLogFile('INFO', `Storage root: ${getStorageRoot()}`);

    // Run once on startup, then every hour
    runBackupCleanup();
    cleanupTimer = setInterval(runBackupCleanup, CLEANUP_INTERVAL_MS);

    // Backup watch scheduler: automatic copies + retention.
    runBackupWatchScheduler();
    backupWatchTimer = setInterval(runBackupWatchScheduler, BACKUP_WATCH_CHECK_INTERVAL_MS);

    router.use(express.json({ limit: '10mb' }));

    router.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
        if (req.method === 'OPTIONS') {
            return res.sendStatus(204);
        }
        next();
    });

    // Request logging — filtered to reduce spam (skip /log batch, large bodies, success noise)
    router.use((req, res, next) => {
        // Exclude log endpoints entirely (halves writes, avoids recursion)
        if (req.path === '/log' || req.path === '/log/batch') return next();
        const start = Date.now();
        const isLargeBody = (() => {
            try {
                const j = JSON.stringify(req.body || {});
                if (j.length > 2000) return true;
                // Also skip lorebookData dumps
                if (req.body && (req.body.lorebookData || req.body.data)) return true;
                return false;
            } catch { return false; }
        })();
        let shouldLogRequest = true;
        // Only log warns/errors or verbose? For filtered mode, log only failed requests at INFO? We log only 4xx/5xx at file level
        // Still emit request start only for non-2xx? To keep file quiet, skip successful 2xx start log
        // We keep minimal console for 2xx only if verbose need — skip file for 2xx
        const bodyPreview = (() => {
            if (isLargeBody) return '[large body skipped]';
            try { const j = JSON.stringify(req.body || {}); return j.length > 600 ? j.slice(0, 600) + '…' : j; } catch { return String(req.body).slice(0, 600); }
        })();
        // Skip file logging for successful requests when not verbose; still keep timing for response hook
        const silentSuccess = !isLargeBody ? false : true;
        const origJson = res.json.bind(res);
        res.json = (data) => {
            const dur = Date.now() - start;
            const status = res.statusCode || 200;
            if (status >= 400) {
                const preview = (() => { try { const j = JSON.stringify(data||{}); return j.length>500? j.slice(0,500)+'…': j;} catch { return String(data).slice(0,500);} })();
                elLog('WARN', `← ${req.method} ${req.path} ${status} ${dur}ms`, preview);
                try { console.warn(`[EL:req] ← ${req.method} ${req.path} ${status} ${dur}ms ${preview}`); } catch {}
            } else if (!silentSuccess) {
                // Successful 2xx: no file log by default (relevance filter). Keep minimal console only at debug level? Skip entirely for performance.
                // Intentionally silent for lorebook-irrelevant spam reduction.
            }
            return origJson(data);
        };
        next();
    });

    // Client log forwarder (batched, file only — console already via elLogFileBatch)
    router.post('/log', asyncHandler(handleClientLog));
    router.post('/log/batch', asyncHandler(handleClientLogBatch));
    // Terminal panel history (read-only tail of extension.log)
    router.get('/log/tail', asyncHandler(tailExtensionLog));

    // Health
    router.get('/health', (req, res) => {
        res.json({ status: 'ok', version: PLUGIN_VERSION, storage: getStorageRoot() });
    });

    // (Hub v2: secrets vault routes removed — connections live in ST-RequestHub.)

    // Backups
    router.post('/backup/create', asyncHandler(createBackup));
    router.get('/backup/list', asyncHandler(listBackups));
    router.post('/backup/restore', asyncHandler(restoreBackup));
    router.post('/backup/delete', asyncHandler(deleteBackup));

    // Agent Backups (isolated, clearly identifiable)
    router.post('/agent-backup/create', asyncHandler(createAgentBackup));
    router.get('/agent-backup/list', asyncHandler(listAgentBackups));
    router.post('/agent-backup/restore', asyncHandler(restoreAgentBackup));
    router.post('/agent-backup/delete', asyncHandler(deleteAgentBackup));

    // Backup Watch
    router.post('/backup-watch/create', asyncHandler(createBackupWatch));
    router.get('/backup-watch/status', asyncHandler(getBackupWatchStatus));
    router.get('/backup-watch/list', asyncHandler(listBackupWatches));
    router.post('/backup-watch/get', asyncHandler(getBackupWatch));
    router.post('/backup-watch/restore', asyncHandler(restoreBackupWatch));
    router.post('/backup-watch/delete', asyncHandler(deleteBackupWatch));
    router.post('/backup-watch/disable', asyncHandler(disableBackupWatch));

    // Snapshots
    router.post('/snapshot/create', asyncHandler(createSnapshot));
    router.get('/snapshot/list', asyncHandler(listSnapshots));
    router.post('/snapshot/restore', asyncHandler(restoreSnapshot));
    router.post('/snapshot/delete', asyncHandler(deleteSnapshot));

    // Trash
    router.post('/trash/add', asyncHandler(addToTrash));
    router.get('/trash/list', asyncHandler(listTrash));
    router.post('/trash/restore', asyncHandler(restoreFromTrash));
    router.post('/trash/delete', asyncHandler(deleteFromTrash));

    // Audit log
    router.post('/audit/append', asyncHandler(appendAudit));
    router.get('/audit/list', asyncHandler(listAudit));

    // Proposals
    router.post('/proposals/save', asyncHandler(saveProposal));
    router.post('/proposals/batch-save', asyncHandler(batchSaveProposals));
    router.get('/proposals/list', asyncHandler(listProposals));
    router.get('/proposals/list-all', asyncHandler(listAllProposals));
    router.post('/proposals/update-status', asyncHandler(updateProposalStatus));
    router.post('/proposals/batch-update-status', asyncHandler(batchUpdateProposalStatus));
    router.post('/proposals/delete', asyncHandler(deleteProposals));

    // Per-agent chat (unbounded per agent/chatId, one thread per, forked style, reasoning expandable)
    router.get('/agent-chats/list', asyncHandler(listAgentChats));
    router.get('/agent-chats/get', asyncHandler(getAgentChat));
    router.post('/agent-chats/save', asyncHandler(saveAgentChat));
    router.post('/agent-chats/delete', asyncHandler(deleteAgentChat));
    router.post('/agent-chats/clear', asyncHandler(clearAgentChat));

    // (Hub v2: /agent/direct-complete + /agent/research removed —
    // ST-RequestHub owns all model calls now.)

    elLog('INFO', `Initialized. Storage root: ${getStorageRoot()}`);
    console.log(`[${PLUGIN_NAME}] Initialized. Storage root: ${getStorageRoot()}`);
}

export async function exit() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
    if (backupWatchTimer) {
        clearInterval(backupWatchTimer);
        backupWatchTimer = null;
    }
    elLog('INFO', 'Plugin shutting down...');
    console.log(`[${PLUGIN_NAME}] Plugin shutting down...`);
}

export const info = {
    id: PLUGIN_NAME,
    name: 'Enhanced Lorebook Agent',
    description: 'Storage backend for ST-EnhancedLorebook Hub v2 agents: proposals, agent chats, backups, snapshots, trash, audit. (LLM execution moved to ST-RequestHub.)',
    version: PLUGIN_VERSION,
};
