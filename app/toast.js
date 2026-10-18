(function () {
    'use strict';
    const TYPES = ['success', 'info', 'warning', 'error'];
    function normType(t) { return TYPES.includes(t) ? t : 'info'; }

    function injectStyles() {
        if (document.getElementById('el-toast-styles')) return;
        const s = document.createElement('style');
        s.id = 'el-toast-styles';
        s.textContent = `
            #el-toast-host { position: fixed; top: 18px; right: 18px; z-index: 60000;
                display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
                pointer-events: none; max-width: min(420px, 86vw); }
            .el-toast { pointer-events: auto; background: var(--SmartThemeBlurTintColor, rgba(20,22,28,0.96));
                color: var(--SmartThemeBodyColor, #dcdfe4); border: 1px solid rgba(255,255,255,0.14);
                border-left-width: 3px; border-radius: 9px; padding: 10px 14px; font-size: 13px;
                font-family: inherit; line-height: 1.35; box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                opacity: 0; transform: translateX(12px); transition: opacity .18s ease, transform .18s ease;
                white-space: pre-wrap; word-break: break-word; max-width: 100%; }
            .el-toast.visible { opacity: 1; transform: translateX(0); }
            .el-toast-success { border-left-color: var(--success-color, #22c55e); }
            .el-toast-info    { border-left-color: var(--info-color, #38bdf8); }
            .el-toast-warning { border-left-color: var(--warning-color, #f59e0b); }
            .el-toast-error   { border-left-color: var(--danger-color, #ef4444); }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    function localHost() {
        let host = document.getElementById('el-toast-host');
        if (!host) { host = document.createElement('div'); host.id = 'el-toast-host'; (document.body || document.documentElement).appendChild(host); }
        return host;
    }

    function renderLocal(message, type, ms) {
        injectStyles();
        const el = document.createElement('div');
        el.className = 'el-toast el-toast-' + type;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
        el.textContent = String(message);   // textContent: user text can never become markup
        localHost().appendChild(el);
        requestAnimationFrame(() => { try { el.classList.add('visible'); } catch (e) {} });
        setTimeout(() => {
            try { el.classList.remove('visible'); } catch (e) {}
            setTimeout(() => { try { el.remove(); } catch (e) {} }, 220);
        }, ms);
    }

    window.EL_toast = function EL_toast(message, type, opts) {
        const o = (opts && typeof opts === 'object') ? opts : {};
        const t = normType(type || o.type);
        const ms = Number.isFinite(Number(o.timeoutMs)) ? Number(o.timeoutMs) : (t === 'error' ? 5200 : 2600);
        try { renderLocal(message, t, ms); } catch (e) {}
        // The app window can sit behind the main window, so mirror to the host so a
        // message is never invisible. Mirrored at most once.
        const mirror = (o.mirrorToHost === true) || (o.mirrorToHost !== false && document.hidden === true);
        if (mirror) {
            try {
                if (typeof EL_postToHost === 'function') {
                    EL_postToHost({ type: 'el-agent-toast', message: String(message), toastType: t });
                }
            } catch (e) {}
        }
    };
})();
