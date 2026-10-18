/**
 * agent-chat.js — Per-agent chat panel (ST-chat clone, forked style).
 *
 * Unbounded per (agentId, chatId) thread, stored server-side
 * data/enhanced-lorebook-agent/agent-chats/<agentId>/<chatId>.json
 * via plugins/enhanced-lorebook-agent/index.js routes.
 *
 * Features per user spec:
 *  - Full reply parsing: <think> / <thinking> / <reasoning> / <thought> (all regex, Q3) → reasoning expandable block
 *  - Response shown, input textarea + Send button, arrows reroll (simple, ST-like swipe)
 *  - Tool proposals from chat are saved to feed so "show all stuff in feed" (Q4)
 *  - Forked style similar to extension design (not direct ST CSS import, Q6)
 */

function EL_getChatIdForAgent() {
    try {
        const st = (typeof stContext !== 'undefined' && stContext) ? stContext : null;
        if (st) {
            const cid = st.characterId ?? 'no-char';
            // `st.chat` is the message ARRAY; the chat id lives on `chatId`
            // (see SillyTavern's st-context.js). Reading chat.chat_id yielded
            // undefined, so every chat of a character shared one thread.
            const chatFile = st.chatId ?? st.chat?.chat_id ?? st.chat?.filename ?? st.chatFile ?? 'default';
            return cid + '_' + chatFile;
        }
    } catch {}
    try {
        const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
        if (host?.SillyTavern?.getContext) {
            const ctx = host.SillyTavern.getContext();
            const cid = ctx?.characterId ?? 'no-char';
            const chatFile = ctx?.chatId ?? ctx?.chat?.chat_id ?? 'default';
            return cid + '_' + chatFile;
        }
    } catch {}
    return 'no-char_default';
}

function EL_escapeHtmlChat(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function EL_simpleMarkdown(text) {
    // Minimal forked markdown similar to ST messageFormatting but lightweight.
    // Preserve code blocks, then escape, then handle **bold**, *italic*, > quote, lists.
    let t = String(text ?? '');
    const codeBlocks = [];
    t = t.replace(/```([\s\S]*?)```/g, (_, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push(code);
        return `\u0000CODE${idx}\u0000`;
    });
    t = EL_escapeHtmlChat(t);
    // Bold ** **
    t = t.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    // Inline code ` `
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Quotes
    t = t.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
    // Line breaks
    t = t.replace(/\n/g, '<br>');
    codeBlocks.forEach((code, i) => {
        t = t.replace(`\u0000CODE${i}\u0000`, `<pre><code>${EL_escapeHtmlChat(code)}</code></pre>`);
    });
    return t;
}

// Parser reused by core, but also client-side for rendering raw stored messages
function EL_parseAgentReasoningClient(text) {
    let reasoning = '';
    let content = String(text ?? '');
    const tagPattern = /<(think|thinking|reasoning|thought)>([\s\S]*?)<\/\1>/gi;
    const found = [];
    let m;
    while ((m = tagPattern.exec(content)) !== null) {
        const inner = (m[2] || '').trim();
        if (inner) found.push(inner);
    }
    if (found.length) {
        reasoning = found.join('\n\n');
        content = content.replace(tagPattern, '').replace(/\n{3,}/g, '\n\n').trim();
    }
    return { reasoning: reasoning.trim(), content: content.trim() };
}

class AgentChatManager {
    constructor() {
        this.cache = new Map(); // key = agentId|chatId -> messages[]
        this.loading = new Set();
        this._serverMissing = false;
        this._serverMissingNotified = false;
        this._healthChecked = false;
    }
    _key(agentId, chatId) { return `${agentId}::${chatId}`; }
    _localKey(agentId, chatId) { return `el-agent-chat::${agentId}::${chatId}`; }
    _readLocal(agentId, chatId) {
        try {
            const raw = localStorage.getItem(this._localKey(agentId, chatId));
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : null;
        } catch { return null; }
    }
    _writeLocal(agentId, chatId, messages) {
        try { localStorage.setItem(this._localKey(agentId, chatId), JSON.stringify(messages || [])); } catch {}
    }
    _clearLocal(agentId, chatId) {
        try { localStorage.removeItem(this._localKey(agentId, chatId)); } catch {}
    }
    _notifyServerMissing(status, op) {
        this._serverMissing = true;
        const msg = `Agent chat server missing (HTTP ${status} on ${op}) — plugin not installed or outdated. Copy plugins/enhanced-lorebook-agent to SillyTavern/plugins/ and restart SillyTavern. Messages are kept locally for now.`;
        try { (window.ELLogger||console).warn('[EL:Chat] server missing', status, op); } catch {}
        try { if (typeof EL_fireToast === 'function') EL_fireToast(msg, 'error'); } catch {}
        try {
            if (!this._serverMissingNotified) {
                this._serverMissingNotified = true;
                if (typeof toastr !== 'undefined') toastr.error(msg, 'Enhanced Lorebook Agent', { timeOut: 8000 });
                else {
                    const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
                    if (host && host.toastr) host.toastr.error(msg, 'Enhanced Lorebook Agent', { timeOut: 8000 });
                }
            }
        } catch {}
        try {
            const statusEl = document.getElementById('agent-chat-status');
            if (statusEl) {
                statusEl.textContent = msg;
                statusEl.style.color = '#ef4444';
                statusEl.title = msg;
            }
        } catch {}
    }
    _headers() {
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
    async _headersAsync() {
        const base = this._headers() || {};
        if (base['X-CSRF-Token'] || base['x-csrf-token']) return base;
        // Try cookie fallback
        try {
            const cookie = document.cookie || '';
            const m = cookie.match(/X-CSRF-Token=([^;]+)/);
            if (m && m[1]) return { ...base, 'X-CSRF-Token': decodeURIComponent(m[1]) };
        } catch {}
        // Try fetching csrf token endpoint
        try {
            const resp = await fetch('/csrf-token', { method: 'GET', cache: 'no-store' });
            if (resp.ok) {
                const data = await resp.json().catch(()=>null);
                if (data && data.token) return { ...base, 'X-CSRF-Token': data.token };
            }
        } catch {}
        // Last resort: ask host window (ST already fetched it in index.js)
        try {
            const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
            if (host && host.document) {
                const val = `; ${host.document.cookie}`;
                const parts = val.split('; X-CSRF-Token=');
                if (parts.length === 2) return { ...base, 'X-CSRF-Token': parts.pop().split(';').shift() };
            }
        } catch {}
        return base;
    }
    async checkHealth(cacheOk=true) {
        if (this._healthChecked && cacheOk) return !this._serverMissing;
        try {
            const headers = await this._headersAsync();
            const res = await fetch('/api/plugins/enhanced-lorebook-agent/health', { method: 'GET', headers, cache: 'no-store' });
            if (res.ok) {
                this._serverMissing = false;
                this._healthChecked = true;
                try { (window.ELLogger||console).info('[EL:Chat] health OK'); } catch {}
                return true;
            }
            if (res.status === 404) {
                this._notifyServerMissing(404, 'health');
                this._healthChecked = true;
                return false;
            }
        } catch (e) {
            try { (window.ELLogger||console).warn('[EL:Chat] health check failed', e); } catch {}
        }
        this._healthChecked = true;
        return !this._serverMissing;
    }
    async load(agentId, chatId) {
        const key = this._key(agentId, chatId);
        if (this.loading.has(key)) return this.cache.get(key) || this._readLocal(agentId, chatId) || [];
        this.loading.add(key);
        try {
            const headers = await this._headersAsync();
            const url = `/api/plugins/enhanced-lorebook-agent/agent-chats/get?agentId=${encodeURIComponent(agentId)}&chatId=${encodeURIComponent(chatId)}`;
            const res = await fetch(url, { method: 'GET', headers });
            if (!res.ok) {
                if (res.status === 404) {
                    this._notifyServerMissing(404, 'agent-chats/get');
                    const local = this._readLocal(agentId, chatId);
                    if (local) {
                        this.cache.set(key, local);
                        try { (window.ELLogger||console).warn('[EL:Chat] load fallback local', agentId, chatId, 'count='+local.length); } catch {}
                        return local;
                    }
                    return this.cache.get(key) || [];
                }
                throw new Error(`GET agent-chats/get ${res.status} ${await res.text().catch(()=> '')}`.slice(0,300));
            }
            const data = await res.json().catch(()=>null);
            const msgs = Array.isArray(data?.messages) ? data.messages : [];
            this.cache.set(key, msgs);
            this._writeLocal(agentId, chatId, msgs);
            this._serverMissing = false;
            return msgs;
        } catch (e) {
            try { (window.ELLogger||console).warn('[EL:Chat] load failed', agentId, chatId, e); } catch {}
            // Local fallback: keep working offline
            const local = this._readLocal(agentId, chatId);
            if (local) return local;
            return this.cache.get(key) || [];
        } finally { this.loading.delete(key); }
    }
    async save(agentId, chatId, messages) {
        const key = this._key(agentId, chatId);
        this.cache.set(key, messages);
        this._writeLocal(agentId, chatId, messages);
        try {
            const headers = await this._headersAsync();
            const res = await fetch('/api/plugins/enhanced-lorebook-agent/agent-chats/save', {
                method: 'POST',
                headers,
                body: JSON.stringify({ agentId, chatId, messages }),
            });
            if (!res.ok) {
                if (res.status === 404) {
                    this._notifyServerMissing(404, 'agent-chats/save');
                    try { (window.ELLogger||console).warn('[EL:Chat] save kept locally only', agentId, chatId, 'count='+messages.length); } catch {}
                    return; // do not throw — local keep is success for UX
                }
                throw new Error(`POST save ${res.status} ${await res.text().catch(()=> '')}`);
            }
            try { (window.ELLogger||console).info(`[EL:Chat] saved agent=${agentId} chat=${chatId} count=${messages.length}`); } catch {}
            this._serverMissing = false;
        } catch (e) {
            // If we already handled 404 fallback above, don't re-throw
            if (this._serverMissing) return;
            try { (window.ELLogger||console).error('[EL:Chat] save failed', agentId, chatId, e); } catch {}
            // Keep local but notify — do not throw to avoid losing chat UX
            try { if (typeof EL_fireToast === 'function') EL_fireToast('Chat save failed — kept locally: ' + (e.message||e), 'warning'); } catch {}
        }
    }
    async clear(agentId, chatId) {
        const key = this._key(agentId, chatId);
        this.cache.set(key, []);
        this._clearLocal(agentId, chatId);
        try {
            const headers = await this._headersAsync();
            const res = await fetch('/api/plugins/enhanced-lorebook-agent/agent-chats/clear', {
                method: 'POST',
                headers,
                body: JSON.stringify({ agentId, chatId }),
            });
            if (!res.ok && res.status === 404) {
                this._notifyServerMissing(404, 'agent-chats/clear');
                return;
            }
            try { (window.ELLogger||console).info(`[EL:Chat] cleared agent=${agentId} chat=${chatId}`); } catch {}
        } catch (e) {
            try { (window.ELLogger||console).warn('[EL:Chat] clear failed', e); } catch {}
        }
    }
    getCached(agentId, chatId) {
        const v = this.cache.get(this._key(agentId, chatId));
        if (v) return v;
        const local = this._readLocal(agentId, chatId);
        if (local) this.cache.set(this._key(agentId, chatId), local);
        return local;
    }
}

// ── UI: forked ST-chat clone (Q6) ──────────────────────────────
let _chatActiveAgentId = null;
// Messages keyed by `${agentId}::${chatId}`. A single shared array let an
// in-flight reply be appended to whichever thread happened to be on screen
// when it arrived, merging chats across characters.
const _chatThreads = new Map();
function _chatThreadKey(agentId, chatId) { return String(agentId) + '::' + String(chatId); }
function _chatGetThread(agentId, chatId) {
    const key = _chatThreadKey(agentId, chatId);
    if (!_chatThreads.has(key)) _chatThreads.set(key, []);
    return _chatThreads.get(key);
}
let _chatMessages = []; // view alias: live array for the currently displayed thread
let _chatIsSending = false;

function _chatGetActiveIds() {
    const agentId = _chatActiveAgentId || (typeof activeAgentId !== 'undefined' ? activeAgentId : null) || (typeof agentManager !== 'undefined' && agentManager?.getAgents()?.[0]?.id) || null;
    const chatId = EL_getChatIdForAgent();
    return { agentId, chatId };
}

async function initAgentChatPanel() {
    const sel = document.getElementById('agent-chat-agent-select');
    if (!sel) return;
    const agents = (typeof agentManager !== 'undefined' && agentManager?.getAgents) ? agentManager.getAgents() : [];
    sel.innerHTML = '';
    if (!agents.length) {
        const o = document.createElement('option'); o.value=''; o.textContent='No agents'; sel.appendChild(o);
        _chatActiveAgentId = null;
    } else {
        for (const a of agents) {
            const o=document.createElement('option'); o.value=a.id; o.textContent=a.name||'Unnamed'; sel.appendChild(o);
        }
        if (!_chatActiveAgentId) _chatActiveAgentId = agents[0].id;
        sel.value = _chatActiveAgentId;
        sel.onchange = async () => { _chatActiveAgentId = sel.value; await renderAgentChat(); };
    }
    const threadLabel = document.getElementById('agent-chat-thread-label');
    if (threadLabel) threadLabel.textContent = `thread: ${EL_getChatIdForAgent()}`;
    // Proactive health probe — noisy if server missing (augment needs server)
    try { if (window.agentChatManager && typeof window.agentChatManager.checkHealth === 'function') window.agentChatManager.checkHealth(false).catch(()=>{}); } catch {}
    // Poll for ST chat change to switch thread automatically (one thread per)
    if (!window._elChatPoll) {
        window._elChatPoll = setInterval(async ()=>{
            const cur = EL_getChatIdForAgent();
            const lbl = document.getElementById('agent-chat-thread-label');
            if (lbl && lbl.textContent !== `thread: ${cur}`) {
                lbl.textContent = `thread: ${cur}`;
                if (document.getElementById('agent-chat-panel') && !document.getElementById('agent-chat-panel').classList.contains('hidden')) {
                    await renderAgentChat();
                }
            }
        }, 2000);
    }
}

async function renderAgentChat() {
    const { agentId, chatId } = _chatGetActiveIds();
    if (!agentId) {
        const c = document.getElementById('agent-chat-history');
        if (c) c.innerHTML = '<div class="el-chat-empty">Create an agent first.</div>';
        return;
    }
    // Capture the thread BEFORE awaiting: the 2s poll or a quick agent switch can
    // start another render while we are loading, repointing the view alias. Writing
    // through the alias afterwards would then merge this thread's messages into a
    // different thread.
    const thread = _chatGetThread(agentId, chatId);
    _chatMessages = thread;
    const historyEl = document.getElementById('agent-chat-history');
    const statusEl = document.getElementById('agent-chat-status');
    if (statusEl) statusEl.textContent = 'Loading…';
    let msgs = [];
    try { msgs = await window.agentChatManager.load(agentId, chatId); } catch {}
    // If the active thread moved on while we were loading, drop this render — it
    // belongs to a thread the user is no longer looking at.
    const active = _chatGetActiveIds();
    if (active.agentId !== agentId || String(active.chatId) !== String(chatId)) return;
    _chatMessages = thread;
    msgs = Array.isArray(msgs) ? msgs : [];
    if (msgs !== thread) {
        thread.length = 0;
        for (const m of msgs) thread.push(m);
        try { if (window.agentChatManager && window.agentChatManager.cache) window.agentChatManager.cache.set(window.agentChatManager._key(agentId, chatId), thread); } catch {}
    }
    // Ensure each assistant msg has swipe fields
    for (const m of _chatMessages) {
        if (m.role === 'assistant' && !Array.isArray(m.swipes)) {
            m.swipes = [m.content];
            m.swipe_id = 0;
            m.swipe_info = [{ content: m.content, reasoning: m.reasoning||'', ts: m.ts||Date.now() }];
        }
    }
    if (!historyEl) return;
    historyEl.innerHTML = '';
    if (!_chatMessages.length) {
        historyEl.innerHTML = '<div class="el-chat-empty"><i class="fa-solid fa-comments"></i><div>Start chatting with this agent. Reasoning inside <code>&lt;think&gt;</code> / <code>&lt;thinking&gt;</code> / <code>&lt;reasoning&gt;</code> / <code>&lt;thought&gt;</code> will be collapsed.</div><div style="font-size:0.8rem; opacity:0.7; margin-top:6px;">Tool calls (propose_create/edit/delete) appear in Feed (Q4).</div></div>';
        if (statusEl) statusEl.textContent = '';
        return;
    }
    for (let idx=0; idx<_chatMessages.length; idx++) {
        const m = _chatMessages[idx];
        const isUser = m.role === 'user';
        const isLastAssistant = !isUser && idx === _chatMessages.length-1 && m.role === 'assistant';
        // Resolve displayed content via swipe
        const displayContent = (!isUser && Array.isArray(m.swipes) && typeof m.swipe_id === 'number') ? (m.swipes[m.swipe_id] ?? m.content) : m.content;
        const displayReasoning = (!isUser && Array.isArray(m.swipe_info) && typeof m.swipe_id === 'number') ? (m.swipe_info[m.swipe_id]?.reasoning ?? m.reasoning ?? '') : (m.reasoning||'');
        const msgEl = document.createElement('div');
        msgEl.className = `el-msg ${isUser ? 'is_user' : 'is_assistant'}`;
        msgEl.dataset.idx = String(idx);
        const header = document.createElement('div');
        header.className = 'el-msg-header';
        const role = document.createElement('span'); role.className = `el-msg-role ${isUser?'user':'assistant'}`; role.textContent = isUser ? 'You' : (m.agentName || 'Agent');
        const time = document.createElement('span'); time.className='el-msg-time'; try{ time.textContent = new Date(m.ts||Date.now()).toLocaleTimeString(); }catch{ time.textContent=''; }
        const model = document.createElement('span'); model.className='el-msg-model'; if(m.model) model.textContent = m.model;
        header.appendChild(role); header.appendChild(time); if(m.model) header.appendChild(model);
        if (isLastAssistant && m.swipes && m.swipes.length>1) {
            const swipeBar = document.createElement('div'); swipeBar.className='el-swipe-bar'; swipeBar.style.marginLeft='auto';
            swipeBar.innerHTML = `<button class="el-swipe-btn el-swipe-left" title="Previous swipe (←)"><i class="fa-solid fa-chevron-left"></i></button><span class="el-swipe-counter">${(m.swipe_id+1)}/${m.swipes.length}</span><button class="el-swipe-btn el-swipe-right" title="Next / Reroll (→)"><i class="fa-solid fa-chevron-right"></i></button>`;
            header.appendChild(swipeBar);
        } else if (isLastAssistant) {
            // Single swipe still shows reroll right arrow disabled until hover? Show simple reroll
            const swipeBar = document.createElement('div'); swipeBar.className='el-swipe-bar'; swipeBar.style.marginLeft='auto';
            swipeBar.innerHTML = `<span style="opacity:0.6; font-size:0.75rem;">${m.swipes? m.swipes.length : 1} swipe</span><button class="el-swipe-btn el-swipe-right" title="Reroll (→)"><i class="fa-solid fa-rotate"></i></button>`;
            header.appendChild(swipeBar);
        }
        msgEl.appendChild(header);
        // Reasoning expandable (ST details/summary pattern, forked)
        if (!isUser && displayReasoning && String(displayReasoning).trim()) {
            const det = document.createElement('details'); det.className='el-reasoning'; det.open = false;
            const summ = document.createElement('summary');
            summ.innerHTML = `<span>Reasoning</span><i class="fa-solid fa-chevron-down el-reasoning-chevron"></i>`;
            const body = document.createElement('div'); body.className='el-reasoning-body';
            body.textContent = displayReasoning;
            // Also support markdown inside reasoning? Keep pre-wrap
            det.appendChild(summ); det.appendChild(body);
            msgEl.appendChild(det);
        }
        const textDiv = document.createElement('div'); textDiv.className='el-msg-text';
        // Use simple markdown for display (forked, Q6)
        try { textDiv.innerHTML = EL_simpleMarkdown(displayContent||''); } catch { textDiv.textContent = displayContent||''; }
        msgEl.appendChild(textDiv);
        // Actions per message (copy, edit, delete)
        const actions = document.createElement('div'); actions.className='el-msg-actions';
        const copyBtn = document.createElement('button'); copyBtn.className='btn btn-secondary'; copyBtn.innerHTML='<i class="fa-solid fa-copy"></i> Copy'; copyBtn.onclick=()=>{ try{ navigator.clipboard.writeText(displayContent||''); if(typeof showToast==='function') showToast('Copied'); }catch{} };
        actions.appendChild(copyBtn);
        if (isUser) {
            const editBtn=document.createElement('button'); editBtn.className='btn btn-secondary'; editBtn.innerHTML='<i class="fa-solid fa-pencil"></i> Edit';
            editBtn.onclick=()=>{
                const ta=document.createElement('textarea'); ta.value=m.content; ta.style.width='100%'; ta.style.minHeight='60px'; ta.style.background='rgba(0,0,0,0.3)'; ta.style.border='1px solid var(--panel-border)'; ta.style.color='var(--text-color)'; ta.style.padding='6px'; ta.style.borderRadius='6px';
                textDiv.innerHTML=''; textDiv.appendChild(ta); ta.focus();
                const save=document.createElement('button'); save.className='btn btn-primary btn-sm'; save.textContent='Save'; save.onclick=async()=>{
                    m.content = ta.value; const _ids = _chatGetActiveIds(); const _thread = _chatGetThread(_ids.agentId, _ids.chatId); await window.agentChatManager.save(_ids.agentId, _ids.chatId, _thread); renderAgentChat();
                };
                actions.appendChild(save);
            };
            actions.appendChild(editBtn);
        }
        const delBtn=document.createElement('button'); delBtn.className='btn btn-secondary'; delBtn.innerHTML='<i class="fa-solid fa-trash"></i> Delete'; delBtn.style.color='#ef4444';
        delBtn.onclick=async()=>{
            if(!confirm('Delete this message?')) return;
            const _ids = _chatGetActiveIds(); const _thread = _chatGetThread(_ids.agentId, _ids.chatId); _thread.splice(idx,1);
            await window.agentChatManager.save(_ids.agentId, _ids.chatId, _thread);
            renderAgentChat();
        };
        actions.appendChild(delBtn);
        // Swipe handlers for last assistant
        if (isLastAssistant) {
            const leftBtn = msgEl.querySelector('.el-swipe-left');
            const rightBtn = msgEl.querySelector('.el-swipe-right');
            if (leftBtn) leftBtn.onclick = async () => { await handleChatSwipe(idx, 'left'); };
            if (rightBtn) rightBtn.onclick = async () => { await handleChatSwipe(idx, 'right'); };
        }
        msgEl.appendChild(actions);
        // Show toolCalls if present (from chat that did propose_*)
        if (!isUser && Array.isArray(m.toolCalls) && m.toolCalls.length) {
            const toolDiv=document.createElement('div'); toolDiv.style.cssText='font-size:0.78rem; opacity:0.7; margin-top:4px; padding:6px 8px; background:rgba(0,0,0,0.12); border-radius:6px;';
            toolDiv.textContent = `Tool calls: ${m.toolCalls.map(t=>t.tool).join(', ')} → proposals in Feed`;
            msgEl.appendChild(toolDiv);
        }
        historyEl.appendChild(msgEl);
    }
    // Scroll to bottom
    try { historyEl.scrollTop = historyEl.scrollHeight; } catch {}
    if (statusEl) statusEl.textContent = `${_chatMessages.length} messages — thread ${chatId}`;
}

async function handleChatSwipe(msgIdx, dir) {
    const { agentId, chatId } = _chatGetActiveIds();
    if (!agentId) return;
    const thread = _chatGetThread(agentId, chatId);
    const msg = thread[msgIdx];
    if (!msg || msg.role !== 'assistant') return;
    if (!Array.isArray(msg.swipes)) { msg.swipes=[msg.content]; msg.swipe_id=0; msg.swipe_info=[{content:msg.content, reasoning:msg.reasoning||'', ts:msg.ts}]; }
    if (dir === 'left') {
        if (msg.swipe_id > 0) { msg.swipe_id--; msg.content = msg.swipes[msg.swipe_id]; msg.reasoning = msg.swipe_info[msg.swipe_id]?.reasoning||''; await window.agentChatManager.save(agentId, chatId, thread); renderAgentChat(); }
        return;
    }
    // Right: next swipe if exists, else reroll (ST-like)
    if (msg.swipe_id < msg.swipes.length - 1) {
        msg.swipe_id++; msg.content = msg.swipes[msg.swipe_id]; msg.reasoning = msg.swipe_info[msg.swipe_id]?.reasoning||''; await window.agentChatManager.save(agentId, chatId, thread); renderAgentChat(); return;
    }
    // No next swipe → reroll (generate new variant)
    await handleChatReroll(msgIdx);
}

async function handleChatReroll(msgIdx) {
    const { agentId, chatId } = _chatGetActiveIds();
    if (!agentId) return;
    const thread = _chatGetThread(agentId, chatId);
    const statusEl = document.getElementById('agent-chat-status');
    const msg = thread[msgIdx];
    if (!msg) return;
    // Find previous user message
    let userIdx = -1;
    for (let i=msgIdx-1; i>=0; i--) if (thread[i].role==='user') { userIdx=i; break; }
    const historyForReroll = thread.slice(0, userIdx >=0 ? userIdx : 0); // up to user msg exclusive? Keep user
    // Simpler: history without the assistant msg being rerolled
    const history = thread.slice(0, msgIdx).filter(m=>m.role!=='assistant' || true).map(m=>({role:m.role, content: m.role==='assistant' ? (Array.isArray(m.swipes)? m.swipes[m.swipe_id]||m.content : m.content) : m.content})).slice(0, -1); // remove last assistant, keep up to user
    // Actually keep including the user
    // Easier: take all before msgIdx, ensure last is user
    let hist = thread.slice(0, msgIdx).map(m=>({role:m.role, content: m.content}));
    // If last is not user, find user
    if (hist.length && hist[hist.length-1].role !== 'user' && userIdx>=0) {
        hist = thread.slice(0, userIdx+1).map(m=>({role:m.role, content:m.content}));
    }
    const userText = hist.length && hist[hist.length-1].role==='user' ? hist[hist.length-1].content : '';
    const baseHistory = hist.slice(0, -1);
    await sendAgentChatMessage(baseHistory, userText, { isReroll: true, rerollMsgIdx: msgIdx });
}

async function sendAgentChatMessage(historyOverride, userTextOverride, opts={}) {
    if (_chatIsSending) return;
    const { agentId, chatId } = _chatGetActiveIds();
    if (!agentId) { if(typeof showToast==='function') showToast('Select an agent'); return; }
    const inputEl = document.getElementById('agent-chat-input');
    const sendBtn = document.getElementById('btn-agent-chat-send');
    const stopBtn = document.getElementById('btn-agent-chat-stop');
    const statusEl = document.getElementById('agent-chat-status');
    const userText = userTextOverride !== undefined ? userTextOverride : (inputEl?.value || '').trim();
    if (!userText && !opts.isReroll) return;
    // Captured once: all pushes/saves below use this thread so a chat switch
    // mid-generation cannot redirect them into the newly visible thread.
    const thread = _chatGetThread(agentId, chatId);
    if (_chatMessages !== thread) _chatMessages = thread;
    // Build history to send: either provided or current
    let history = historyOverride !== undefined ? historyOverride : thread.map(m=>({role:m.role, content: m.content}));
    _chatIsSending = true;
    if (sendBtn) sendBtn.style.display='none';
    if (stopBtn) stopBtn.style.display='';
    if (statusEl) statusEl.textContent = 'Generating…';
    // For non-reroll, push user message optimistically and save
    let pushedUserIdx = -1;
    if (!opts.isReroll) {
        const userMsg = { id: 'msg_'+Date.now()+'_'+Math.random().toString(36).slice(2,6), role:'user', content: userText, ts: Date.now() };
        thread.push(userMsg); pushedUserIdx = thread.length-1;
        await window.agentChatManager.save(agentId, chatId, thread);
        const _cur = _chatGetActiveIds();
        if (_cur.agentId === agentId && String(_cur.chatId) === String(chatId)) renderAgentChat();
        if (inputEl) inputEl.value='';
        // Reset history for call to include the new user
        history = thread.slice(0, -1).map(m=>({role:m.role, content: m.content}));
        // userText will be sent as separate last message inside core
    } else {
        // Reroll will send existing history + userText as provided
        history = historyOverride;
    }
    let aborter = null;
    try {
        const mgr = (typeof agentManager !== 'undefined' && agentManager) ? agentManager : null;
        const agent = mgr ? mgr.getAgent(agentId) : null;
        if (!agent) throw new Error('Agent not found');
        if (typeof EL_runHubAgent !== 'function') throw new Error('Hub client not loaded (hub-client.js).');
        if (typeof EL_isHubReady === 'function' && !EL_isHubReady()) {
            const detail = (typeof EL_hubStatus === 'function') ? EL_hubStatus().detail : 'hub unavailable';
            throw new Error(detail);
        }
        // Abort handling for stop button
        try {
            aborter = new AbortController();
            if (stopBtn) stopBtn.onclick = () => { try{ aborter.abort(); }catch{}; _chatIsSending=false; if(sendBtn) sendBtn.style.display=''; if(stopBtn) stopBtn.style.display='none'; if(statusEl) statusEl.textContent='Stopped'; };
        } catch {}
        // Thread → hub messages. The shared prompt message (meta briefing +
        // custom text + task brief, in the agent's configured role/position)
        // is inserted by EL_buildHubRequest — chat uses the same system as
        // every other run path.
        const cleanHistory = (Array.isArray(history) ? history : [])
            .filter(m => m && typeof m.content === 'string' && m.content.trim())
            .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
        const messages = [...cleanHistory, { role: 'user', content: userText }];
        // The thread carries its own history, but the agent's configured
        // static sources (previous memories, char card, author note, WI,
        // injected) still ride along via extraContext (see hub-client.js —
        // inserted next to the prompt message, thread untouched).
        let chatSources = '';
        try {
            let st = null;
            try { st = (typeof stContext !== 'undefined' && stContext) ? stContext : null; } catch {}
            if (!st) {
                try {
                    const host = (typeof ST_Window !== 'undefined' && ST_Window) || window.opener || window.parent;
                    if (host && host.SillyTavern && typeof host.SillyTavern.getContext === 'function') st = host.SillyTavern.getContext();
                } catch {}
            }
            if (st && typeof EL_buildAgentContextAsync === 'function') {
                const built = await EL_buildAgentContextAsync(st, agent, { includeHistory: false });
                if (built && built.contextBlock) chatSources = String(built.contextBlock).slice(0, 60000);
            }
        } catch {}
        const result = await EL_runHubAgent(agent, {
            messages,
            extraContext: chatSources,
            chatId,
            label: `lorebook-chat:${agent?.name || agentId}`,
            signal: aborter ? aborter.signal : undefined,
            onStep: ({ step, toolCalls }) => {
                try {
                    if (statusEl) {
                        const names = (toolCalls || []).map(t => t?.function?.name || t?.name).filter(Boolean).join(', ');
                        statusEl.textContent = `Step ${step}${names ? `: ${names}` : ''}…`;
                    }
                } catch {}
            },
        });
        if (!result.success) throw new Error(result.error||'Chat failed');
        try {
            const parsed = (typeof EL_parseAgentReasoningClient === 'function')
                ? EL_parseAgentReasoningClient(result.content || '')
                : { reasoning: '', content: result.content || '' };
            result.reasoning = result.reasoning || parsed.reasoning || '';
            result.content = parsed.content || result.content || '';
            result.toolCalls = (result.steps || []).flatMap(s => s.toolCalls || []);
        } catch {}
        if (opts.isReroll) {
            // Append as new swipe variant to existing assistant msg
            const target = thread[opts.rerollMsgIdx];
            if (target && target.role==='assistant') {
                if (!Array.isArray(target.swipes)) { target.swipes=[target.content]; target.swipe_id=0; target.swipe_info=[{content:target.content, reasoning:target.reasoning||'', ts:target.ts}]; }
                target.swipes.push(result.content||'');
                target.swipe_info.push({ content: result.content||'', reasoning: result.reasoning||'', ts: Date.now(), toolCalls: result.toolCalls||[] });
                target.swipe_id = target.swipes.length-1;
                target.content = result.content||'';
                target.reasoning = result.reasoning||'';
                target.toolCalls = result.toolCalls||[];
                target.ts = Date.now();
                if (result.proposalsCreated) target.proposalsCreated = result.proposalsCreated;
            }
        } else {
            const assistantMsg = {
                id: 'msg_'+Date.now()+'_'+Math.random().toString(36).slice(2,6),
                role: 'assistant',
                content: result.content||'',
                reasoning: result.reasoning||'',
                toolCalls: result.toolCalls||[],
                proposalsCreated: result.proposalsCreated||0,
                ts: Date.now(),
                agentName: agent.name||'Agent',
                model: agent.model||agent.apiProfile||'',
                swipes: [result.content||''],
                swipe_id: 0,
                swipe_info: [{ content: result.content||'', reasoning: result.reasoning||'', ts: Date.now(), toolCalls: result.toolCalls||[] }],
            };
            thread.push(assistantMsg);
        }
        await window.agentChatManager.save(agentId, chatId, thread);
        // The reply belongs to its originating thread: save it there regardless,
        // but only re-render when the user is still viewing that thread. Touching
        // the DOM otherwise would paint this reply into the wrong conversation.
        const _after = _chatGetActiveIds();
        const stillActive = _after.agentId === agentId && String(_after.chatId) === String(chatId);
        if (stillActive) {
            renderAgentChat();
            if (statusEl) statusEl.textContent = result.reasoning ? `Reasoning ${result.reasoning.length} chars` : '';
        }
        if (result.proposalsCreated) {
            try { if(typeof showToast==='function') showToast(`${result.proposalsCreated} proposal(s) created — see Feed`); } catch {}
            // Refresh feed badge
            try { if(typeof loadProposalsForCurrentChat==='function') loadProposalsForCurrentChat(); } catch {}
        }
    } catch (e) {
        try { (window.ELLogger||console).error('[EL:Chat] send failed', e); } catch {}
        try { const _err = _chatGetActiveIds(); if (statusEl && _err.agentId === agentId && String(_err.chatId) === String(chatId)) statusEl.textContent = `Error: ${e.message||e}`; } catch {}
        try { if(typeof showToast==='function') showToast('Chat failed: '+(e.message||e)); } catch {}
        // If we pushed user optimistically and failed, keep it (user can reroll)
    } finally {
        _chatIsSending=false;
        if (sendBtn) sendBtn.style.display='';
        if (stopBtn) stopBtn.style.display='none';
        if (statusEl && statusEl.textContent==='Generating…') statusEl.textContent='';
    }
}

function wireAgentChatUI() {
    const sendBtn = document.getElementById('btn-agent-chat-send');
    const inputEl = document.getElementById('agent-chat-input');
    const clearBtn = document.getElementById('btn-agent-chat-clear');
    if (sendBtn) sendBtn.onclick = () => sendAgentChatMessage();
    if (inputEl) {
        inputEl.addEventListener('keydown', (e)=>{
            if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendAgentChatMessage(); }
        });
    }
    if (clearBtn) clearBtn.onclick = async ()=>{
        if (!confirm('Clear this agent thread?')) return;
        const { agentId, chatId } = _chatGetActiveIds();
        if (!agentId) return;
        const thread = _chatGetThread(agentId, chatId);
        await window.agentChatManager.clear(agentId, chatId);
        thread.length = 0;
        if (_chatMessages !== thread) _chatMessages = thread;
        renderAgentChat();
    };
    // Expose reroll via event for future hotkeys
    document.addEventListener('keydown', (e)=>{
        const panel = document.getElementById('agent-chat-panel');
        if (!panel || panel.classList.contains('hidden')) return;
        if (e.key==='ArrowLeft' && e.altKey) { e.preventDefault(); const lastIdx=_chatMessages.length-1; if(lastIdx>=0 && _chatMessages[lastIdx].role==='assistant') handleChatSwipe(lastIdx,'left'); }
        if (e.key==='ArrowRight' && e.altKey) { e.preventDefault(); const lastIdx=_chatMessages.length-1; if(lastIdx>=0 && _chatMessages[lastIdx].role==='assistant') handleChatSwipe(lastIdx,'right'); }
    });
}

// Singleton
if (typeof window !== 'undefined') {
    window.AgentChatManager = AgentChatManager;
    window.EL_getChatIdForAgent = EL_getChatIdForAgent;
    window.EL_parseAgentReasoningClient = EL_parseAgentReasoningClient;
    window.EL_simpleMarkdown = EL_simpleMarkdown;
    if (!window.agentChatManager) window.agentChatManager = new AgentChatManager();
    window.initAgentChatPanel = initAgentChatPanel;
    window.renderAgentChat = renderAgentChat;
    window.sendAgentChatMessage = sendAgentChatMessage;
    window.handleChatSwipe = handleChatSwipe;
    window.wireAgentChatUI = wireAgentChatUI;
}

