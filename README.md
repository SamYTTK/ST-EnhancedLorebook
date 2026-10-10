# ST-EnhancedLorebook

A fully revamped World Info / Lorebook interface for SillyTavern, designed to replace the built-in panel with a faster, more capable standalone app.

## Why?

SillyTavern's built-in lorebook panel works, but navigating entries, searching, bulk-editing, and organising lorebooks is slow and limited. This extension provides a dedicated standalone app (opens as a new browser tab) with a proper desktop-app-style interface.

## Features

### Lorebook Management
- **Standalone app** — opens as a new tab, not an in-page overlay, giving you full screen real estate and a dedicated workspace
- **Sidebar navigation** — browse all lorebooks, active globals, and saved templates from one sidebar
- **Live search** — filter lorebooks by name in the sidebar; search entries by keys, content, or comment with auto-sort by relevance
- **Entry CRUD** — create, edit, duplicate, and delete entries with a rich form UI
- **Batch operations** — multi-select entries with checkboxes, then batch-edit order/depth/position/probability, or download/delete in bulk
- **Entry fields** — full access to every field SillyTavern supports: primary keys, secondary keys, content, comment, order, depth, position, probability, selective logic, delay, role, constant/vectorized toggles, recursion flags, disable toggle, and more
- **Inline editing** — edit order, depth, position, and probability directly on each entry card without opening a modal
- **Download & export** — download selected entries as JSON with a choice of format (individual files, single merged file, or ST-compatible character book format)
- **Drag-and-drop reordering** — reorder entries within a lorebook by drag-and-drop on a dedicated handle
- **Duplicate entries** — clone an entry within the same lorebook or copy it to a different lorebook via the context menu
- **Move entries** — move entries between lorebooks with target lorebook selection

### Folder Organisation
- **Folder-based grouping** — organise entries into named folders inside a lorebook
- **Nested folders** — folders can contain sub-folders to any depth
- **Drag-and-drop** — drag entries into folders, drag folders into other folders to nest them
- **Expand/collapse** — fold and unfold folder trees; collapse all or expand all with one click
- **Folder counts** — each folder shows the total number of entries inside it (including sub-folders)
- **Context menu** — right-click a folder to rename, delete, or create a sub-folder

### Templates & Quick Actions
- **Save active set as template** — save your currently active global lorebooks as a named template, then apply it later to activate the same set
- **Quick-add entry** — quickly create a new entry with just a key and content from a compact form
- **One-click toggle** — toggle a lorebook's global active state directly from the sidebar
- **Remove from active** — remove a lorebook from the active list without leaving the app

### Colours & Visual Customisation
- **Colour-coded categories** — assign background/text/border colours to lorebooks for quick visual identification
- **Settings modal** — customise background colour, panel colour, text colour, and accent colour; reset to defaults at any time
- **Entry card badges** — visual badges for Disabled, Exclude Recursion, Prevent Recursion states
- **Position labels** — human-readable labels for each insertion position (e.g. ↑Char, ↓Char, ↑AN, @D, ➡️ Outlet)

### Resizable Sidebar
- Drag the sidebar edge to resize; width is saved per session

## Quick Start

1. Click the **World Info** button in the SillyTavern toolbar
2. In the dropdown that appears, choose **Enhanced Lorebook**
3. Browse lorebooks in the sidebar, click one to view its entries
4. Use the toolbar to search, sort, add items, or toggle batch mode
5. Right-click any entry or folder for the context menu (duplicate, move, delete, etc.)

## Lorebook Agents (Hub v2 — ST-RequestHub backend)

> **Note:** Agents are an experimental feature. They are not required to use the lorebook interface.

Each agent is a JSON request config for the shared **ST-RequestHub** extension, which owns all model execution. The agent sends the request (one-shot or agentic tool loop), the hub runs it, and the reply comes back as proposals in the Review Changes panel where you can Accept, Deny, or send Feedback before anything is applied. Nothing is ever written without your approval.

### Agent Features
- Per-chat proposals stored server-side, keyed by character and chat file
- Single (one-shot) or Agentic (autonomous tool loop) request modes
- Model & sampling config per agent: hub API profile, chat preset, model override, temperature/top-p/seed, timeouts, retries
- Inline lorebook tools in agent mode: list / search / get entries, stage proposals (linked lorebooks only — everything else is hard-blocked)
- Configurable permissions: independently allow/disallow create, edit, and delete
- Auto-accept mode with a confidence threshold (extension-side policy — the hub enforces none)
- Manual, Periodic, and one-shot runs (toolbar wand + `/el-run` slash command)
- Per-agent Agent Chat threads with proposal handoff to the Feed
- Server-side backup system with 24-hour auto-expiry

### Requirements
- **ST-RequestHub** installed and enabled (it provides `globalThis.STRequestHub`). Configure connections (API profiles) in its settings panel.
- The server plugin in `plugins/enhanced-lorebook-agent/` (storage for proposals, chats, backups — no LLM code).

To enable an agent, open the app, click **Dashboard** in the sidebar, create an agent, link lorebooks, pick a hub profile/preset/model, and press Run. Proposals appear under **Feed (Review Changes)**.

## Status

Early development. The core lorebook management interface has seen real-world use, but bugs are expected. The AI agent is newer and less tested. Feedback and issues are welcome.

## Disclaimer

This extension was coded primarily using AI (via [OpenCode](https://opencode.ai)).

## Installation

### 1. Install via SillyTavern's extension panel
1. Open SillyTavern and go to **Extensions** → **Install from URL**
2. Paste `https://github.com/SamYTTK/ST-EnhancedLorebook` and click **Install**
3. Enable the extension in the Extensions panel

### 2. Install the server plugin
The server plugin (required for agent proposal/chat/backup storage) lives in `plugins/enhanced-lorebook-agent/` and must be copied to your SillyTavern root:

```bash
cp -r plugins/enhanced-lorebook-agent /path/to/your/SillyTavern/plugins/
```

Or manually copy the `plugins/enhanced-lorebook-agent/` folder into your SillyTavern `plugins/` directory.

### 3. Enable server plugins (agent storage only)
In `config.yaml`:

```yaml
enableServerPlugins: true
```

### 4. Restart SillyTavern

## Files

```
public/scripts/extensions/third-party/ST-EnhancedLorebook/
├── manifest.json          # Extension manifest (loads after ST-RequestHub)
├── index.js               # Extension entry (launcher dropdown, periodic events, quick-task, postMessage bridge)
├── .gitignore
├── README.md
├── app/
│   ├── index.html         # Standalone app HTML
│   ├── app.js             # App core (routing, CRUD, sidebar, entry rendering)
│   ├── style.css          # App styles
│   ├── hub-client.js      # Hub connection: probe, request builder, runner, proposal parse/commit/apply
│   ├── hub-tools.js       # Inline hub tools (list/search/get/propose — linked-only, never write)
│   ├── agent-config-schema.js # Agent config v2 schema + v1 migration
│   ├── agent-manager.js   # Agent CRUD + scope resolution (no execution)
│   ├── agent-ui.js        # Agent UI controllers (config panel, feed panel, backup UI)
│   ├── agent-chat.js      # Agent Chat panel (threads run through the hub)
│   └── agent-backup.js    # Backup client (server-side CRUD)
└── plugins/
    └── enhanced-lorebook-agent/
        ├── package.json   # Plugin metadata
        └── index.js       # Server plugin (STORAGE ONLY: proposals, chats, backups, snapshots, trash, audit)
```

## License

AGPL-3.0
