import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';

const PLUGIN_NAME = 'enhanced-lorebook-agent';
const PLUGIN_VERSION = '1.0.0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Defaults ──────────────────────────────────────────────────────────

const DEFAULT_API_CONFIG = Object.freeze({
    useSeparateApi: false,
    apiEndpoint: '',
    apiKey: '',
    apiModel: '',
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1.0,
    topK: 0,
    reasoningEffort: 'auto',
    frequencyPenalty: 0.0,
    presencePenalty: 0.0,
    stop: [],
    extraHeaders: {},
});

const PUBLIC_FIELDS = Object.freeze([
    'useSeparateApi',
    'apiEndpoint',
    'apiModel',
    'temperature',
    'maxTokens',
    'topP',
    'topK',
    'reasoningEffort',
    'frequencyPenalty',
    'presencePenalty',
    'stop',
    'extraHeaders',
]);

const MAX_STRING_LENGTH = 2048;

// ── Paths ──────────────────────────────────────────────────────────────

function getStorageRoot() {
    const stRoot = path.resolve(__dirname, '..', '..');
    return path.join(stRoot, 'data', 'enhanced-lorebook-agent');
}

function apiConfigPath() {
    return path.join(getStorageRoot(), 'api-config.json');
}

function backupsDir(lorebookName) {
    return path.join(getStorageRoot(), 'backups', lorebookName);
}

// ── Init helpers ──────────────────────────────────────────────────────

function ensureStorageDirectories() {
    const root = getStorageRoot();
    for (const sub of ['backups', 'proposals']) {
        const dir = path.join(root, sub);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    if (!fs.existsSync(apiConfigPath())) {
        fs.writeFileSync(apiConfigPath(), JSON.stringify({ ...DEFAULT_API_CONFIG }, null, 2), 'utf-8');
    }
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
 * Read the full api-config.json (including the apiKey).
 * Never expose the key to the client — use stripApiKey() for that.
 */
function readFullConfig() {
    try {
        const raw = fs.readFileSync(apiConfigPath(), 'utf-8');
        return { ...DEFAULT_API_CONFIG, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_API_CONFIG };
    }
}

/**
 * Return a safe version of the config without the apiKey.
 */
function stripApiKey(config) {
    const safe = {};
    for (const field of PUBLIC_FIELDS) {
        safe[field] = config[field];
    }
    safe.hasApiKey = !!config.apiKey;
    return safe;
}

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

// ── Route handlers ────────────────────────────────────────────────────

/**
 * GET /api/plugins/enhanced-lorebook-agent/agent/api-config
 *
 * Returns the public subset of the API config — never exposes the apiKey.
 */
async function getApiConfig(req, res) {
    const config = readFullConfig();
    res.json(stripApiKey(config));
}

/**
 * PUT /api/plugins/enhanced-lorebook-agent/agent/api-config
 *
 * Accepts the full config (including apiKey) and writes it to disk.
 * Sanitises all string inputs before storage.
 */
async function putApiConfig(req, res) {
    const body = req.body || {};

    // Read current config to preserve any fields we aren't updating
    const current = readFullConfig();

    // ── Strings ───────────────────────────────────────────────────
    const useSeparateApi = Boolean(body.useSeparateApi);

    const apiEndpoint = sanitizeString(body.apiEndpoint) ?? current.apiEndpoint;
    const apiKey = sanitizeString(body.apiKey) ?? current.apiKey;
    const apiModel = sanitizeString(body.apiModel) ?? current.apiModel;
    const reasoningEffort = sanitizeString(body.reasoningEffort) ?? current.reasoningEffort;

    // Validate: if useSeparateApi is true, endpoint and key are required
    if (useSeparateApi) {
        if (!apiEndpoint) {
            return res.status(400).json({ error: 'apiEndpoint is required when useSeparateApi is enabled' });
        }
        if (!apiKey) {
            return res.status(400).json({ error: 'apiKey is required when useSeparateApi is enabled' });
        }
    }

    // ── Numbers ───────────────────────────────────────────────────
    const temperature = clampNumber(body.temperature, 0.0, 2.0, current.temperature);
    const maxTokens = clampNumber(body.maxTokens, 1, 999_999, current.maxTokens);
    const topP = clampNumber(body.topP, 0.0, 1.0, current.topP);
    const topK = clampNumber(body.topK, 0, 999, current.topK);
    const frequencyPenalty = clampNumber(body.frequencyPenalty, -2.0, 2.0, current.frequencyPenalty);
    const presencePenalty = clampNumber(body.presencePenalty, -2.0, 2.0, current.presencePenalty);

    // ── Arrays / Objects ──────────────────────────────────────────
    const stop = Array.isArray(body.stop)
        ? body.stop.map(s => sanitizeString(s)).filter(s => s !== undefined)
        : current.stop;

    const extraHeaders = (body.extraHeaders && typeof body.extraHeaders === 'object' && !Array.isArray(body.extraHeaders))
        ? body.extraHeaders
        : current.extraHeaders;

    // ── Build & write ─────────────────────────────────────────────
    const updated = {
        useSeparateApi,
        apiEndpoint,
        apiKey,
        apiModel,
        temperature,
        maxTokens,
        topP,
        topK,
        reasoningEffort,
        frequencyPenalty,
        presencePenalty,
        stop,
        extraHeaders,
    };

    fs.writeFileSync(apiConfigPath(), JSON.stringify(updated, null, 2), 'utf-8');

    res.json({ success: true });
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

// ── LLM Proxy ─────────────────────────────────────────────────────────

const LLM_PROXY_TIMEOUT = 60_000; // 60 seconds

/**
 * POST /api/plugins/enhanced-lorebook-agent/agent/chat
 *
 * Proxies a chat completion request to the configured OpenAI-compatible API.
 * Reads apiEndpoint, apiKey, model, and parameters from the stored server config.
 */
async function proxyChat(req, res) {
    const { messages, tools } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages must be a non-empty array' });
    }

    const config = readFullConfig();
    if (!config.apiEndpoint) {
        return res.status(400).json({ error: 'No API endpoint configured. Save API settings first.' });
    }
    if (!config.apiKey) {
        return res.status(400).json({ error: 'No API key configured. Save API settings first.' });
    }

    const url = `${config.apiEndpoint.replace(/\/+$/, '')}/chat/completions`;

    const body = {
        model: config.apiModel || 'gpt-4o-mini',
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
    };

    if (config.topP !== undefined && config.topP !== null) body.top_p = config.topP;
    if (config.topK !== undefined && config.topK !== null && config.topK > 0) body.top_k = config.topK;
    if (config.frequencyPenalty !== undefined && config.frequencyPenalty !== null) body.frequency_penalty = config.frequencyPenalty;
    if (config.presencePenalty !== undefined && config.presencePenalty !== null) body.presence_penalty = config.presencePenalty;

    const validEfforts = ['auto', 'low', 'medium', 'high'];
    if (config.reasoningEffort && validEfforts.includes(config.reasoningEffort)) {
        body.reasoning_effort = config.reasoningEffort;
    }

    if (Array.isArray(config.stop) && config.stop.length > 0) {
        body.stop = config.stop;
    }

    if (Array.isArray(tools) && tools.length > 0) {
        body.tools = tools;
    }

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
    };

    // Apply any extra headers from config
    if (config.extraHeaders && typeof config.extraHeaders === 'object') {
        for (const [key, value] of Object.entries(config.extraHeaders)) {
            headers[key] = String(value);
        }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_PROXY_TIMEOUT);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
            let errorText;
            try {
                errorText = await response.text();
            } catch {
                errorText = `HTTP ${response.status}`;
            }
            return res.status(502).json({
                error: 'API call failed',
                details: `Upstream returned ${response.status}: ${errorText.slice(0, 500)}`,
            });
        }

        const data = await response.json();
        res.json(data);
    } catch (err) {
        clearTimeout(timeout);

        if (err.name === 'AbortError') {
            return res.status(504).json({ error: 'API call timed out', details: 'No response within 60 seconds' });
        }

        return res.status(502).json({
            error: 'API call failed',
            details: err.message?.slice(0, 500) || 'Unknown error',
        });
    }
}

// ── Research (SearXNG) ────────────────────────────────────────────────

const SEARXNG_TIMEOUT = 15_000; // 15 seconds

/**
 * POST /api/plugins/enhanced-lorebook-agent/agent/research
 *
 * Proxies a search query to a self-hosted SearXNG instance,
 * or returns a disabled response.
 */
async function proxyResearch(req, res) {
    const { query, source, searxngUrl, searxngToken } = req.body || {};

    const sanitizedQuery = sanitizeString(query);
    if (!sanitizedQuery) {
        return res.status(400).json({ error: 'query is required' });
    }

    if (source === 'disabled' || !source) {
        return res.json({ results: [], note: 'Research is disabled by the user' });
    }

    if (source === 'searxng') {
        const sanitizedUrl = sanitizeString(searxngUrl);
        if (!sanitizedUrl) {
            return res.status(400).json({ error: 'searxngUrl is required when source is searxng' });
        }

        const searchUrl = `${sanitizedUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(sanitizedQuery)}&format=json&categories=general`;

        const headers = {};
        if (searxngToken) {
            const sanitizedToken = sanitizeString(searxngToken);
            if (sanitizedToken) {
                headers['Authorization'] = `Bearer ${sanitizedToken}`;
            }
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SEARXNG_TIMEOUT);

        try {
            const response = await fetch(searchUrl, { headers, signal: controller.signal });
            clearTimeout(timeout);

            if (!response.ok) {
                return res.json({
                    results: [],
                    note: `SearXNG returned HTTP ${response.status}`,
                });
            }

            const data = await response.json();
            const results = (data.results || [])
                .slice(0, 5)
                .map(r => ({
                    title: r.title || '',
                    snippet: r.content || '',
                    url: r.url || '',
                }))
                .filter(r => r.title || r.snippet);

            return res.json({ results, note: '' });
        } catch (err) {
            clearTimeout(timeout);

            if (err.name === 'AbortError') {
                return res.json({ results: [], note: 'SearXNG request timed out' });
            }

            return res.json({
                results: [],
                note: `SearXNG connection failed: ${err.message?.slice(0, 200) || 'Unknown error'}`,
            });
        }
    }

    return res.status(400).json({ error: `Unknown research source: ${source}` });
}

// ── Backup cleanup ────────────────────────────────────────────────────

const BACKUP_TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour
let cleanupTimer = null;

/**
 * Walk all backups/{lorebookName}/ directories and delete files older than 24h.
 */
function runBackupCleanup() {
    const backupsRoot = path.join(getStorageRoot(), 'backups');
    if (!fs.existsSync(backupsRoot)) return;

    let deleted = 0;
    const now = Date.now();

    try {
        const lorebookDirs = fs.readdirSync(backupsRoot);

        for (const lorebookDir of lorebookDirs) {
            const dirPath = path.join(backupsRoot, lorebookDir);
            if (!fs.statSync(dirPath).isDirectory()) continue;

            let files;
            try {
                files = fs.readdirSync(dirPath);
            } catch {
                continue;
            }

            for (const file of files) {
                if (!file.endsWith('.json')) continue;

                const filePath = path.join(dirPath, file);
                let timestamp;

                try {
                    // Try parsing from file content first (more reliable)
                    const raw = fs.readFileSync(filePath, 'utf-8');
                    const parsed = JSON.parse(raw);
                    timestamp = parsed.timestamp;
                } catch {
                    // Fallback: parse from filename "backup_{timestamp}.json"
                    const match = file.match(/^backup_(\d+)\.json$/);
                    if (match) {
                        timestamp = parseInt(match[1], 10);
                    }
                }

                if (timestamp && (now - timestamp > BACKUP_TTL_MS)) {
                    try {
                        fs.unlinkSync(filePath);
                        deleted++;
                    } catch {
                        // skip files we can't delete
                    }
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
        }
    } catch {
        // ignore top-level read errors
    }

    if (deleted > 0) {
        console.log(`[${PLUGIN_NAME}] Cleanup: removed ${deleted} expired backup(s)`);
    }
}

// ── Init ──────────────────────────────────────────────────────────────

export async function init(router) {
    console.log(`[${PLUGIN_NAME}] Initializing v${PLUGIN_VERSION}...`);

    ensureStorageDirectories();

    // Run once on startup, then every hour
    runBackupCleanup();
    cleanupTimer = setInterval(runBackupCleanup, CLEANUP_INTERVAL_MS);

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

    // Health
    router.get('/health', (req, res) => {
        res.json({ status: 'ok', version: PLUGIN_VERSION, storage: getStorageRoot() });
    });

    // API Config
    router.get('/agent/api-config', asyncHandler(getApiConfig));
    router.put('/agent/api-config', asyncHandler(putApiConfig));

    // Backups
    router.post('/backup/create', asyncHandler(createBackup));
    router.get('/backup/list', asyncHandler(listBackups));
    router.post('/backup/restore', asyncHandler(restoreBackup));
    router.post('/backup/delete', asyncHandler(deleteBackup));

    // Proposals
    router.post('/proposals/save', asyncHandler(saveProposal));
    router.post('/proposals/batch-save', asyncHandler(batchSaveProposals));
    router.get('/proposals/list', asyncHandler(listProposals));
    router.post('/proposals/update-status', asyncHandler(updateProposalStatus));
    router.post('/proposals/batch-update-status', asyncHandler(batchUpdateProposalStatus));
    router.post('/proposals/delete', asyncHandler(deleteProposals));

    // LLM Proxy
    router.post('/agent/chat', asyncHandler(proxyChat));

    // Research (SearXNG)
    router.post('/agent/research', asyncHandler(proxyResearch));

    console.log(`[${PLUGIN_NAME}] Initialized. Storage root: ${getStorageRoot()}`);
}

export async function exit() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
    console.log(`[${PLUGIN_NAME}] Plugin shutting down...`);
}

export const info = {
    id: PLUGIN_NAME,
    name: 'Enhanced Lorebook Agent',
    description: 'Server backend for the ST-EnhancedLorebook agent: API key storage, proposals, backups, and LLM proxy.',
    version: PLUGIN_VERSION,
};
