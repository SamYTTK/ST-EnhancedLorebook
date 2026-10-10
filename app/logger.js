/**
 * logger.js — Extension-wide logger mirroring SillyTavern's conventions.
 *
 * Reuses ST's logging.minLogLevel gating (src/util.js:1113 setupLogLevel).
 * ST patches console.debug/info/warn/error to no-ops when below level; console.log is NEVER silenced.
 *
 * Design (optimized, batched + relevance-filtered):
 *   - Console still shows via console.debug/info/warn/error/log (honors ST gating + our logLevel)
 *   - File logging is BATCHED: enqueue to EL_logQueue, flush via POST /log/batch every 2s
 *     - Drops per-token/network storm (was fire-and-forget per log)
 *     - Server uses async appendFile (no blocking sync)
 *     - /log and /log/batch are excluded from request-logging middleware (halves writes)
 *   - Relevance filter: only lorebook CRUD (guard, batch ops) + generation SUMMARY are INFO by default.
 *     DEBUG categories (folder/sync/poll/prompt) are OFF unless extensionSettings.sync.verbose===true
 *     or logLevel=DEBUG. See app.js generation hooks for single END summary (no per-token).
 */

const EL_LOG_PREFIX = '[EL]';
const EL_LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// Save original console methods before ST patches them (if loaded early enough)
const _origConsole = {
    log: console.log.bind(console),
    debug: (console.debug || console.log).bind(console),
    info: (console.info || console.log).bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

// ST's LOG_LEVELS is global via src/constants.js but not exposed to extension.
// We infer current level by probing which methods are no-ops (ST replaces them with () => {}).
function _isSilenced(fn) {
    try { return fn.toString().includes('=> { }') || fn.toString() === '() => { }' || fn.length === 0 && fn.toString().includes('{}'); } catch { return false; }
}
function _currentMinLevel() {
    if (_isSilenced(console.debug)) {
        if (_isSilenced(console.info)) {
            if (_isSilenced(console.warn)) return 3; // ERROR
            return 2; // WARN
        }
        return 1; // INFO
    }
    return 0; // DEBUG
}

function _formatArgs(prefix, levelTag, args) {
    const ts = new Date().toISOString();
    const head = `${ts} ${prefix} ${levelTag}`;
    if (args.length === 0) return [head];
    if (typeof args[0] === 'string') return [`${head} ${args[0]}`, ...args.slice(1)];
    return [head, ...args];
}

// ── Level gating (extension's own logLevel, default INFO) ───────────
const _EL_LEVEL_MAP = { DEBUG: 0, INFO: 1, LOG: 1, WARN: 2, ERROR: 3, OFF: 4 };
function _getEffectiveMinLevel() {
    try {
        // Prefer extension's sync.logLevel if available (app.js init sets default INFO)
        let lvl = null;
        if (typeof extensionSettings !== 'undefined' && extensionSettings?.sync?.logLevel) lvl = extensionSettings.sync.logLevel;
        else if (typeof window !== 'undefined' && window.extensionSettings?.sync?.logLevel) lvl = window.extensionSettings.sync.logLevel;
        // Also check stContext extensionSettings (cross-window)
        if (!lvl) {
            try {
                const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
                if (host?.SillyTavern?.getContext) {
                    const ctx = host.SillyTavern.getContext();
                    lvl = ctx?.extensionSettings?.SillyTavernEnhancedLorebook?.sync?.logLevel || null;
                    // Fallback: extensionSettings global from app.js window
                    if (!lvl && typeof host.extensionSettings !== 'undefined') lvl = host.extensionSettings?.sync?.logLevel || null;
                }
            } catch {}
        }
        if (lvl && _EL_LEVEL_MAP[lvl.toUpperCase()] !== undefined) return _EL_LEVEL_MAP[lvl.toUpperCase()];
    } catch {}
    // Fallback: ST's minLogLevel probing
    return _currentMinLevel();
}
function _shouldLog(level) {
    const min = _getEffectiveMinLevel();
    if (min >= 4) return false; // OFF
    const lvlNum = _EL_LEVEL_MAP[level] ?? 1;
    return lvlNum >= min;
}
function _isVerbose() {
    try {
        if (typeof extensionSettings !== 'undefined' && typeof extensionSettings.sync?.verbose === 'boolean') return !!extensionSettings.sync.verbose;
        if (typeof window !== 'undefined' && typeof window.extensionSettings?.sync?.verbose === 'boolean') return !!window.extensionSettings.sync.verbose;
        const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
        if (host?.SillyTavern?.getContext) {
            const ctx = host.SillyTavern.getContext();
            const v = ctx?.extensionSettings?.SillyTavernEnhancedLorebook?.sync?.verbose;
            if (typeof v === 'boolean') return v;
        }
    } catch {}
    return false;
}

// ── In-extension terminal ring buffer ──────────────────────────
// Every entry that passes the level gate is mirrored here so the
// Terminal panel (dashboard) renders full history without the browser
// console. Bodies are capped per entry; buffer capped by count.
// Secrets/keys must NEVER be passed as detail (credential logged as
// kind/source/model only — enforced at call sites, e.g. agent-core).
const EL_TERM_MAX_ENTRIES = 300;
const EL_TERM_BODY_CAP = 12288; // 12KB full-detail cap per entry (file keeps 4KB)
const EL_TERM_PREVIEW = 4096;   // inline preview length; rest behind expand
let _termBuffer = [];
let _termUnreadErrors = 0;
let _termOpen = false;
let _termSuppressNext = false; // EL_termLog pushes rich entry itself; skip dup

function _termPush(level, msg, detail, totalLen) {
    try {
        const detailStr = typeof detail === 'string' ? detail : '';
        const entry = {
            ts: Date.now(),
            level: level || 'INFO',
            msg: String(msg == null ? '' : msg),
            detail: detailStr.slice(0, EL_TERM_BODY_CAP),
            total: Number.isFinite(totalLen) ? totalLen : detailStr.length,
        };
        entry.truncated = entry.total > entry.detail.length;
        _termBuffer.push(entry);
        if (_termBuffer.length > EL_TERM_MAX_ENTRIES) _termBuffer.splice(0, _termBuffer.length - EL_TERM_MAX_ENTRIES);
        if (!_termOpen && level === 'ERROR') {
            _termUnreadErrors++;
            try { if (typeof window !== 'undefined' && typeof window.EL_terminalBadge === 'function') window.EL_terminalBadge(_termUnreadErrors); } catch {}
        }
    } catch {}
}

// Rich terminal log: full detail (to body cap) for the terminal panel,
// plus a one-line summary through the normal level path (console + file).
// Detail is ALWAYS recorded regardless of verbose/logLevel — the Terminal
// panel has its own level filter.
function EL_termLog(level, msg, detail) {
    let detailStr = '';
    try { detailStr = (typeof detail === 'string') ? detail : JSON.stringify(detail, null, 2); }
    catch { try { detailStr = String(detail); } catch { detailStr = ''; } }
    const total = detailStr.length;
    _termPush(level, msg, detailStr, total);
    const summary = total > EL_TERM_PREVIEW
        ? `${msg} [detail ${total} chars — see Terminal]`
        : (total > 0 ? `${msg} ${detailStr}` : String(msg));
    const lvl = String(level || 'INFO').toUpperCase();
    _termSuppressNext = true;
    try {
        if (lvl === 'ERROR') ELLogger.error(summary);
        else if (lvl === 'WARN') ELLogger.warn(summary);
        else if (lvl === 'DEBUG') ELLogger.debug(summary);
        else ELLogger.info(summary);
    } catch { _termSuppressNext = false; }
}

// ── Batched file queue (fire every 2s, not per-log) ────────────────
const EL_LOG_BATCH_MS = 2000;
const EL_LOG_MAX_QUEUE = 300;
let _logQueue = [];
let _logTimer = null;
let _logFlushing = false;

function _getRequestHeadersForLog() {
    try {
        if (typeof EL_getRequestHeaders === 'function') return EL_getRequestHeaders();
        if (typeof stContext !== 'undefined' && stContext?.getRequestHeaders) return stContext.getRequestHeaders();
    } catch {}
    try {
        const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
        if (host?.SillyTavern?.getContext) {
            const ctx = host.SillyTavern.getContext();
            if (ctx?.getRequestHeaders) return ctx.getRequestHeaders();
        }
    } catch {}
    return { 'Content-Type': 'application/json' };
}

function _enqueue(level, msg, meta) {
    if (!_shouldLog(level)) return;
    // DEBUG categories (folder/sync/verbose) are OFF unless verbose or DEBUG level
    if ((level === 'DEBUG' || level === 'LOG') && !_isVerbose() && _getEffectiveMinLevel() > 0) {
        // Allow DEBUG only when logLevel OK AND (verbose or level DEBUG). If level INFO, suppress DEBUG even batched.
        return;
    }
    if (_logQueue.length >= EL_LOG_MAX_QUEUE) {
        // Drop oldest to keep memory bounded, keep newest
        _logQueue.shift();
    }
    _logQueue.push({ level, msg: String(msg).slice(0, 4000), meta: meta ? String(JSON.stringify(meta)).slice(0, 4000) : '', ts: Date.now() });
    if (_termSuppressNext) { _termSuppressNext = false; }
    else _termPush(level, msg, meta);
    if (!_logTimer && !_logFlushing) {
        _logTimer = setTimeout(() => { _logTimer = null; _flushQueue(); }, EL_LOG_BATCH_MS);
    }
    // Flush immediately for ERROR to avoid loss on crash, but still batched if queue small
    if (level === 'ERROR' && _logQueue.length >= 5) {
        if (_logTimer) { clearTimeout(_logTimer); _logTimer = null; }
        _flushQueue();
    }
}

async function _flushQueue() {
    if (_logFlushing || _logQueue.length === 0) return;
    _logFlushing = true;
    const batch = _logQueue.splice(0, _logQueue.length);
    try {
        const headers = _getRequestHeadersForLog();
        const body = JSON.stringify({ entries: batch });
        // Prefer batch endpoint; fallback to single log if batch missing (old server)
        let res = null;
        try {
            res = await fetch('/api/plugins/enhanced-lorebook-agent/log/batch', {
                method: 'POST',
                headers,
                body,
                keepalive: true,
            });
        } catch {}
        if (!res || !res.ok) {
            // Fallback: try single log endpoint with first entry only to avoid spam
            // Re-queue remaining for next flush
            if (batch.length > 0) {
                const remaining = batch.slice(1);
                if (remaining.length) _logQueue.unshift(...remaining.slice(0, EL_LOG_MAX_QUEUE - _logQueue.length));
            }
            const first = batch[0];
            if (first) {
                try {
                    await fetch('/api/plugins/enhanced-lorebook-agent/log', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ level: first.level, msg: first.msg, meta: first.meta, ts: first.ts }),
                        keepalive: true,
                    }).catch(()=>{});
                } catch {}
            }
        }
    } catch {}
    _logFlushing = false;
    if (_logQueue.length > 0 && !_logTimer) {
        _logTimer = setTimeout(() => { _logTimer = null; _flushQueue(); }, EL_LOG_BATCH_MS);
    }
}

// Flush on visibility hide / beforeunload via sendBeacon (reliable)
try {
    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('visibilitychange', () => {
            if (document.hidden && _logQueue.length) {
                // Use sendBeacon if available (lower priority, survives unload)
                try {
                    if (navigator.sendBeacon && _logQueue.length) {
                        const batch = _logQueue.splice(0, Math.min(_logQueue.length, 50));
                        const headers = _getRequestHeadersForLog();
                        // sendBeacon doesn't support custom headers well; fallback to fetch keepalive
                        const body = JSON.stringify({ entries: batch });
                        const blob = new Blob([body], { type: 'application/json' });
                        // Try beacon to batch endpoint
                        const ok = navigator.sendBeacon('/api/plugins/enhanced-lorebook-agent/log/batch', blob);
                        if (!ok) _flushQueue();
                    } else {
                        _flushQueue();
                    }
                } catch { _flushQueue(); }
            }
        });
        window.addEventListener('beforeunload', () => {
            if (_logQueue.length && navigator.sendBeacon) {
                try {
                    const batch = _logQueue.splice(0, Math.min(_logQueue.length, 50));
                    const body = JSON.stringify({ entries: batch });
                    const blob = new Blob([body], { type: 'application/json' });
                    navigator.sendBeacon('/api/plugins/enhanced-lorebook-agent/log/batch', blob);
                } catch {}
            }
        });
    }
} catch {}

// Compat: _postToFile now enqueues (was per-log fetch)
function _postToFile(level, msg, meta) {
    let metaStr = '';
    try { metaStr = meta ? (typeof meta === 'string' ? meta : JSON.stringify(meta)).slice(0, 4000) : ''; } catch { metaStr = String(meta).slice(0, 4000); }
    _enqueue(level, msg, metaStr);
}

function _toastForLevel(level, args) {}

const ELLogger = {
    // Promoted debug — now respects level gate + batched file (no longer always via log)
    debugPromoted(...args) {
        if (!_shouldLog('DEBUG') && !_isVerbose()) {
            // Still show console via log if verbose? No, respect gate for file but console always visible via log
            // Keep console visible but file only if gate passes — mirror old Q5 but cheaper
            const fmt = _formatArgs(EL_LOG_PREFIX, '[DEBUG*]', args);
            _origConsole.log(...fmt);
            return;
        }
        const fmt = _formatArgs(EL_LOG_PREFIX, '[DEBUG*]', args);
        _origConsole.log(...fmt);
        _enqueue('DEBUG', fmt[0], args.slice(1).length ? JSON.stringify(args.slice(1)).slice(0,4000) : '');
    },
    debug(...args) {
        if (!_shouldLog('DEBUG')) return;
        const fmt = _formatArgs(EL_LOG_PREFIX, '[DEBUG]', args);
        console.debug(...fmt);
        _enqueue('DEBUG', fmt[0], args.slice(1).length ? JSON.stringify(args.slice(1)).slice(0,4000) : '');
    },
    info(...args) {
        if (!_shouldLog('INFO')) return;
        const fmt = _formatArgs(EL_LOG_PREFIX, '[INFO]', args);
        console.info(...fmt);
        _enqueue('INFO', fmt[0], args.slice(1).length ? JSON.stringify(args.slice(1)).slice(0,4000) : '');
    },
    log(...args) {
        if (!_shouldLog('LOG')) return;
        const fmt = _formatArgs(EL_LOG_PREFIX, '[LOG]', args);
        console.log(...fmt);
        _enqueue('LOG', fmt[0], args.slice(1).length ? JSON.stringify(args.slice(1)).slice(0,4000) : '');
    },
    warn(...args) {
        if (!_shouldLog('WARN')) return;
        const fmt = _formatArgs(EL_LOG_PREFIX, '[WARN]', args);
        console.warn(...fmt);
        _enqueue('WARN', fmt[0], args.slice(1).length ? JSON.stringify(args.slice(1)).slice(0,4000) : '');
    },
    error(...args) {
        if (!_shouldLog('ERROR')) return;
        const fmt = _formatArgs(EL_LOG_PREFIX, '[ERROR]', args);
        console.error(...fmt);
        _enqueue('ERROR', fmt[0], args.slice(1).length ? JSON.stringify(args.slice(1)).slice(0,4000) : '');
    },
    // Scoped helpers — keep INFO level so they survive default INFO gate (lorebook-relevant)
    agent(...args) {
        if (!_shouldLog('INFO')) return;
        const fmt = _formatArgs('[EL:Agent]', '[INFO]', args);
        console.info(...fmt);
        _enqueue('INFO', fmt[0], args.slice(1).length ? JSON.stringify(args.slice(1)).slice(0,4000) : '');
    },
    guard(...args) {
        if (!_shouldLog('INFO')) return;
        const fmt = _formatArgs('[EL:Guard]', '[INFO]', args);
        console.info(...fmt);
        _enqueue('INFO', fmt[0], args.slice(1).length ? JSON.stringify(args.slice(1)).slice(0,4000) : '');
    },
    folder(...args) {
        if (!_shouldLog('DEBUG')) return;
        if (!_isVerbose()) return; // folder spam only when verbose
        const fmt = _formatArgs('[EL:Folder]', '[DEBUG]', args);
        console.debug(...fmt);
        _enqueue('DEBUG', fmt[0], args.slice(1).length ? JSON.stringify(args.slice(1)).slice(0,4000) : '');
    },
    sync(...args) {
        if (!_shouldLog('DEBUG')) return;
        if (!_isVerbose()) return; // sync poll spam only when verbose
        const fmt = _formatArgs('[EL:Sync]', '[DEBUG]', args);
        console.debug(...fmt);
        _enqueue('DEBUG', fmt[0], args.slice(1).length ? JSON.stringify(args.slice(1)).slice(0,4000) : '');
    },
    generation(...args) {
        if (!_shouldLog('INFO')) return;
        const fmt = _formatArgs('[EL:Gen]', '[INFO]', args);
        // DEDUPED: single console.log only (was console.log + _origConsole.log)
        console.log(...fmt);
        _enqueue('INFO', fmt[0], args.slice(1).length ? JSON.stringify(args.slice(1)).slice(0,4000) : '');
    },
    // Manual flush hook for consumers
    flush() { _flushQueue(); },
    // Toast helper for data-loss (Q4)
    toastWarn(msg) {
        try {
            const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
            if (host && typeof host.toastr !== 'undefined' && host.toastr) {
                (host.toastr.warning || host.toastr.error).call(host.toastr, String(msg));
            } else if (typeof toastr !== 'undefined') {
                toastr.warning(String(msg));
            }
        } catch {}
        this.warn(msg);
    },
    toastError(msg) {
        try {
            const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
            if (host && typeof host.toastr !== 'undefined' && host.toastr) {
                host.toastr.error(String(msg));
            } else if (typeof toastr !== 'undefined') {
                toastr.error(String(msg));
            }
        } catch {}
        this.error(msg);
    },
};

// Expose globally
if (typeof window !== 'undefined') {
    window.ELLogger = ELLogger;
    window.EL_log = ELLogger; // alias
    window._EL_flushLogs = _flushQueue;
    window._EL_logQueue = _logQueue;
    window.EL_termLog = EL_termLog;
    window.EL_terminal = {
        entries() { return _termBuffer.slice(); },
        clear() { _termBuffer = []; _termUnreadErrors = 0; try { if (typeof window.EL_terminalBadge === 'function') window.EL_terminalBadge(0); } catch {} },
        setOpen(open) { _termOpen = !!open; if (_termOpen) { _termUnreadErrors = 0; try { if (typeof window.EL_terminalBadge === 'function') window.EL_terminalBadge(0); } catch {} } },
        isOpen() { return _termOpen; },
        unreadErrors() { return _termUnreadErrors; },
        previewLen: EL_TERM_PREVIEW,
    };
}
