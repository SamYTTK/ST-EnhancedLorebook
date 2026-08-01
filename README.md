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

## AI Lorebook Agent (Experimental)

> **Note:** The AI agent is an experimental feature. It is not required to use the lorebook interface.

The agent can analyse your chat history and propose changes to your active lorebooks — creating new entries, editing existing ones, or suggesting deletions. It runs in Manual or Periodic mode and presents each proposal as a card in the Review Changes panel where you can Accept, Deny, or send Feedback before anything is applied.

### Agent Features
- Per-chat proposals stored server-side, keyed by character and chat file
- Configurable permissions: independently allow/disallow create, edit, and delete
- Auto-accept mode with a confidence threshold
- Feasibility reports before an analysis run
- Server-side backup system with 24-hour auto-expiry
- Supports SillyTavern's built-in LLM pipeline or a separate API key
- Optional research tool (disabled, SearXNG self-hosted, or ST's OpenAI web search)

To enable the agent, open the app, click **Agent Config** in the sidebar, toggle Enable, and configure the model connection and permissions. Proposals appear under **Review Changes**.

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
The server plugin (required for the AI agent only) lives in `plugins/enhanced-lorebook-agent/` and must be copied to your SillyTavern root:

```bash
cp -r plugins/enhanced-lorebook-agent /path/to/your/SillyTavern/plugins/
```

Or manually copy the `plugins/enhanced-lorebook-agent/` folder into your SillyTavern `plugins/` directory.

### 3. Enable server plugins (agent only)
In `config.yaml`:

```yaml
enableServerPlugins: true
```

### 4. Restart SillyTavern

## Files

```
public/scripts/extensions/third-party/ST-EnhancedLorebook/
├── manifest.json          # Extension manifest
├── index.js               # Extension entry (launcher dropdown, periodic events, postMessage bridge)
├── .gitignore
├── README.md
├── app/
│   ├── index.html         # Standalone app HTML
│   ├── app.js             # App core (routing, CRUD, sidebar, entry rendering)
│   ├── style.css          # App styles
│   ├── agent-core.js      # Agent engine (analyze, revise, applyProposal, periodic runner)
│   ├── agent-ui.js        # Agent UI controllers (config panel, feed panel, backup UI)
│   ├── agent-tools.js     # Agent tool implementations (view, propose, research, feasibility)
│   ├── agent-backup.js    # Agent backup client (server-side CRUD)
│   └── agent-prompts.js   # System prompts, tool definitions, guardrail validator
└── plugins/
    └── enhanced-lorebook-agent/
        ├── package.json   # Plugin metadata
        └── index.js       # Server plugin (API config, proposals, backups, LLM proxy, research)
```

## License

AGPL-3.0
