# ST-EnhancedLorebook

A **revamped World Info / Lorebook interface** for SillyTavern, plus an **AI Lorebook Agent** that can analyse your chat and propose lorebook entry changes.

## Why?

SillyTavern's built-in lorebook panel is functional but clumsy — navigating entries, searching, and bulk-editing is slow. This extension provides:

- A dedicated standalone app (opens as a new tab)
- Sidebar with active lorebooks, templates, and all lorebooks
- Advanced search/filter across entries
- Batch operations (select, export, delete, edit)
- Folder-based organisation for entries
- Colour-coded categories
- Quick-add entry from inline text

## AI Lorebook Agent

The agent can **propose**, **edit**, and **delete** lorebook entries based on your chat. It runs in **Manual** or **Periodic** mode and presents each proposal as a card in the Review Changes panel where you can **Accept**, **Deny**, or **Send Feedback** before anything is applied.

### Agent features

- Automatic entry creation, editing, and deletion proposals per chat
- Configurable permissions (allow create/edit/delete independently)
- Auto-accept mode with a confidence threshold
- Feasibility reports before analysis
- Backup system (server-side, auto-expires after 24h)
- Supports SillyTavern's built-in LLM pipeline or a separate API key
- Research tool (disabled, SearXNG, or ST's OpenAI web search)

## Status

**Early development.** Bugs are expected. The UI and agent logic have seen limited real-world testing. Feedback and issues are welcome.

## Disclaimer

This extension was coded primarily using AI (via [OpenCode](https://opencode.ai)).

## Installation

### 1. Install via SillyTavern's extension panel

1. Open SillyTavern and go to **Extensions** → **Install from URL**
2. Paste this repository's URL and click **Install**
3. Enable the extension in the Extensions panel

### 2. Install the server plugin

The server plugin lives in `plugins/enhanced-lorebook-agent/` and must be copied to your SillyTavern root:

```bash
# From the extension directory:
cp -r plugins/enhanced-lorebook-agent /path/to/your/SillyTavern/plugins/
```

Or manually copy the `plugins/enhanced-lorebook-agent/` folder into your SillyTavern installation's `plugins/` directory.

### 3. Enable server plugins

In `config.yaml`, make sure:

```yaml
enableServerPlugins: true
```

### 4. Restart SillyTavern

The plugin registers routes under `/api/plugins/enhanced-lorebook-agent/` automatically.

## Usage

1. Click the **World Info** button in the SillyTavern toolbar
2. Choose **Enhanced Lorebook** from the dropdown to open the lorebook manager
3. Choose **Agent Config** to configure the AI agent
4. Choose **Review Changes** to view and accept/deny agent proposals

## Files

```
public/scripts/extensions/third-party/ST-EnhancedLorebook/
├── manifest.json          # Extension manifest
├── index.js               # Extension entry (launcher, dropdown, periodic events)
├── app/
│   ├── index.html         # Standalone app HTML
│   ├── app.js             # App core (routing, CRUD, sidebar)
│   ├── style.css          # App styles
│   ├── agent-core.js      # AgentEngine class
│   ├── agent-ui.js        # Agent UI controllers
│   ├── agent-tools.js     # Agent tool implementations
│   ├── agent-backup.js    # BackupClient class
│   └── agent-prompts.js   # System prompts & guardrails

plugins/enhanced-lorebook-agent/
├── package.json           # Plugin metadata
└── index.js               # Server plugin (API config, proposals, backups, LLM proxy)
```

## License

AGPL-3.0
