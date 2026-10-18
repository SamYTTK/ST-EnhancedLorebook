# Phase 3.1 — Full module encapsulation: plan and current state

**Status: partially done.** The namespace root and the duplicate consolidation shipped in
Phase 3. The full IIFE encapsulation of all app-window scripts is **not** done, and this
document records why, with the measured numbers, so the remaining work can be scheduled
against evidence rather than guesswork.

## What the brief assumed vs. what the code actually contains

The Phase 3 brief listed duplicates to collapse. Measured against the code:

| Brief said | Actual |
|---|---|
| four `escapeHtml` implementations | **one** (`app.js`). There are three escape *helpers* under three different names: `escapeHtml` (app.js), `ELG_escapeHtml` (worldinfo-guard.js), `elEscapeHtmlQt` (index.js — host window, cannot share code). |
| two `getFreeWorldEntryUid` | **one** (`app.js`). |
| three `stripHtml` | **zero** — no function of that name exists. |
| two `sortFn` copies | **two**, both nested inside different functions of `app.js` (byte-identical). |
| two `parseNullBool` | **two**, both nested inside different functions of `app.js` (byte-identical). |
| five divergent chat-id helpers | **five**, and they had genuinely drifted. **Consolidated in Phase 3** to one function. |

## The collision class is already closed

`tools/load-harness.cjs` reports **0 duplicate top-level names across 516 declarations in 15
files**. The `clamp` collision that silently disabled auto-accept was the last one; Phase 2
removed it. The guard now fails the build if another is ever introduced.

This matters for scheduling: the remaining value of 3.1 is **encapsulation and explicit
dependencies**, not bug removal.

## The measured cost of full encapsulation

Across the 12 original app scripts:

- **866 cross-file call sites** across **156 cross-file edges**.
- Largest consumers: `agent-ui.js` (319 sites / 40 names), `hub-client.js` (109 / 23),
  `app.js` (93 / 23), `agent-chat.js` (67 / 15).
- **~17 shared mutable bindings** are read across file boundaries — `extensionSettings` (8
  files), `stContext` (9), `ST_Window` (7), `proposals` (6), `sync` (5), plus
  `currentLorebookData`, `currentLorebookName`, `currentViewMode`, `agentManager`,
  `activeAgentId`. These are read as bare identifiers.
- **Circular dependency:** `app.js` ↔ `agent-ui.js` (each consumes the other's functions).

## The design that makes it safe

Naively rewriting 866 call sites is the risky path. The low-risk design:

1. **Import block, not call-site rewrites.** At the top of each IIFE, bind the foreign names
   to their *existing* local names:
   ```js
   (function () {
       'use strict';
       const EL_apiFetch = EL.hub.apiFetch;   // body below is UNCHANGED
       ...
   })();
   ```
   Every call site keeps working untouched. The dependency list becomes explicit and
   machine-checkable.

2. **Shared mutable state stays a real global.** State that must be live across files cannot
   be a `const` import (that would snapshot it). Declare it in a preamble *outside* the IIFE,
   or on `window`, so it remains live:
   ```js
   var extensionSettings = null;   // genuine global, live and shared
   (function () { 'use strict'; /* functions only */ })();
   ```

3. **Forward and circular references resolve lazily.** For a name whose owner loads *later*
   (or in the `app.js` ↔ `agent-ui.js` cycle), import a call-time delegate rather than a
   value:
   ```js
   function initAgentUI() { return EL.ui.initAgentUI.apply(null, arguments); }
   ```
   Note: `class` declarations (`AgentManager`, `BackupClient`) are global *lexical* bindings,
   not `window` properties, and `new X()` cannot go through a plain delegate — they need
   either a load-order change or an explicit `window.X = X` export.

4. **Gate every step on the harness.** `node tools/load-harness.cjs` loads all 15 scripts in
   `index.html` order inside a DOM shim and fails on any load-time error, broken export block
   or missing forward reference. Run it after each file, not once at the end.

## Suggested order (leaf-first, one commit per file)

Low-risk leaves first — few or no inbound edges:

1. `logger.js`, `folder-url.js`, `agent-backup.js`, `agent-config-schema.js`, `context-builder.js`
2. `worldinfo-guard.js`, `hub-tools.js`
3. `agent-manager.js`, `agent-chat.js`
4. `hub-client.js`
5. `app.js`, then `agent-ui.js` last (the cycle — `app.js` gets lazy delegates for
   `agent-ui.js` names)

## Not yet done

- The IIFE encapsulation above.
- Hoisting the byte-identical nested `sortFn` (`app.js:1300-1328`, `:1490-1518`) and
  `parseNullBool` (`app.js:3086`, `:3430`) to one top-level helper each.
- Folding `ELG_escapeHtml` (worldinfo-guard.js) into the shared `escapeHtml`.
- Adding `AgentManager` to `window.EL` (needs an explicit `window.AgentManager = AgentManager`
  export first, because it is a lexical binding).
