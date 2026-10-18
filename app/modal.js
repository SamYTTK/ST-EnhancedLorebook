// One modal system: a stack, Escape handling, focus trap, and inert/aria-hidden
// on anything hidden so a closed modal is not tabbable or announced.
(function () {
    'use strict';

    var EL_MODAL_STACK = [];
    var EL_MODAL_INIT_DONE = false;
    var FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function elModalResolve(elOrId) {
        if (typeof elOrId === 'string') {
            try { return document.getElementById(elOrId); } catch (e) { return null; }
        }
        return elOrId || null;
    }

    function elModalPrune() {
        EL_MODAL_STACK = EL_MODAL_STACK.filter(function (m) {
            try { return !!m && document.contains(m) && m.classList.contains('active'); } catch (e) { return false; }
        });
    }

    function elModalFirstFocusable(modal) {
        try {
            var list = modal.querySelectorAll(FOCUSABLE_SELECTOR);
            for (var i = 0; i < list.length; i++) {
                var el = list[i];
                if (!el || el.disabled) continue;
                var rects = null;
                try { rects = el.getClientRects(); } catch (e) { rects = null; }
                if ((rects && rects.length) || el === document.activeElement) return el;
            }
        } catch (e) {}
        return null;
    }

    function elModalInitState() {
        if (EL_MODAL_INIT_DONE) return;
        EL_MODAL_INIT_DONE = true;
        try {
            var all = document.querySelectorAll('.modal');
            for (var i = 0; i < all.length; i++) {
                var m = all[i];
                if (m.classList.contains('active')) {
                    if (EL_MODAL_STACK.indexOf(m) === -1) EL_MODAL_STACK.push(m);
                    try { m.setAttribute('aria-hidden', 'false'); } catch (e) {}
                    try { if ('inert' in m) m.inert = false; } catch (e) {}
                } else {
                    try { m.setAttribute('aria-hidden', 'true'); } catch (e) {}
                    try { if ('inert' in m) m.inert = true; } catch (e) {}
                    try { m.style.display = 'none'; } catch (e) {}
                }
            }
        } catch (e) {}
    }

    function elModalInitSoon() {
        try {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', elModalInitState);
            } else {
                elModalInitState();
            }
        } catch (e) {}
    }

    window.EL_modalOpen = function EL_modalOpen(elOrId) {
        elModalInitState();
        var modal = elModalResolve(elOrId);
        if (!modal) return null;
        if (EL_MODAL_STACK.indexOf(modal) !== -1) {
            try { modal.style.display = ''; } catch (e) {}
            try { modal.classList.add('active'); } catch (e) {}
            try { modal.setAttribute('aria-hidden', 'false'); } catch (e) {}
            try { if ('inert' in modal) modal.inert = false; } catch (e) {}
            return modal;
        }
        try { modal._elPrevFocus = document.activeElement || null; } catch (e) { modal._elPrevFocus = null; }
        EL_MODAL_STACK.push(modal);
        try { modal.style.display = ''; } catch (e) {}
        try { modal.classList.add('active'); } catch (e) {}
        try { modal.setAttribute('aria-hidden', 'false'); } catch (e) {}
        try { if ('inert' in modal) modal.inert = false; } catch (e) {}
        var target = elModalFirstFocusable(modal);
        try {
            if (target) target.focus();
            else {
                if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
                modal.focus();
            }
        } catch (e) {}
        return modal;
    };

    window.EL_modalClose = function EL_modalClose(elOrId) {
        elModalInitState();
        var modal = elModalResolve(elOrId);
        if (!modal) return null;
        var idx = EL_MODAL_STACK.indexOf(modal);
        var wasOpen = idx !== -1;
        try { if (!wasOpen && modal.classList.contains('active')) wasOpen = true; } catch (e) {}
        if (idx !== -1) EL_MODAL_STACK.splice(idx, 1);
        try { modal.classList.remove('active'); } catch (e) {}
        try { modal.style.display = 'none'; } catch (e) {}
        try { modal.setAttribute('aria-hidden', 'true'); } catch (e) {}
        try { if ('inert' in modal) modal.inert = true; } catch (e) {}
        // Side-effect hook (e.g. terminal setOpen(false) + timer cleanup) so every
        // close path — button, backdrop, or Escape — runs the same cleanup.
        if (wasOpen && typeof modal._elOnClose === 'function') {
            try { modal._elOnClose(); } catch (e) {}
        }
        var prev = modal._elPrevFocus || null;
        modal._elPrevFocus = null;
        try {
            if (prev && document.contains(prev) && typeof prev.focus === 'function') prev.focus();
        } catch (e) {}
        return modal;
    };

    document.addEventListener('keydown', function (e) {
        var key = e ? e.key : null;
        if (key !== 'Escape' && key !== 'Esc') return;
        if (e.repeat) return;
        elModalInitState();
        elModalPrune();
        if (!EL_MODAL_STACK.length) return;
        var top = EL_MODAL_STACK[EL_MODAL_STACK.length - 1];
        if (!top) return;
        try { e.stopPropagation(); } catch (err) {}
        try { if (e.cancelable) e.preventDefault(); } catch (err) {}
        try { window.EL_modalClose(top); } catch (err) {}
    }, true);

    document.addEventListener('keydown', function (e) {
        if (!e || e.key !== 'Tab') return;
        elModalInitState();
        elModalPrune();
        if (!EL_MODAL_STACK.length) return;
        var top = EL_MODAL_STACK[EL_MODAL_STACK.length - 1];
        if (!top || !document.contains(top)) return;
        try { if (!top.classList.contains('active')) return; } catch (err) { return; }
        var focusables = [];
        try {
            var list = top.querySelectorAll(FOCUSABLE_SELECTOR);
            for (var i = 0; i < list.length; i++) {
                var el = list[i];
                if (!el || el.disabled) continue;
                var rects = null;
                try { rects = el.getClientRects(); } catch (err2) { rects = null; }
                if (rects && rects.length) focusables.push(el);
            }
        } catch (err3) {}
        if (!focusables.length) {
            try { e.preventDefault(); } catch (err4) {}
            try { top.focus(); } catch (err5) {}
            return;
        }
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        try {
            if (e.shiftKey && (document.activeElement === first || !top.contains(document.activeElement))) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        } catch (err6) {}
    }, true);

    elModalInitSoon();
})();
