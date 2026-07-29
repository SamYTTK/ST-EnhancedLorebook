const EL_TOOL_DEFINITIONS = Object.freeze([
    {
        name: 'view_active_lorebooks',
        description: 'Returns the list of globally active lorebooks with their name and entry count.',
        parameters: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'view_lorebook_detail',
        description: 'Returns all entries in a specific lorebook (uid, keys, comment, content snippet, order, depth, probability, position).',
        parameters: {
            type: 'object',
            properties: {
                lorebookName: {
                    type: 'string',
                    description: 'The name of the lorebook to inspect.',
                },
            },
            required: ['lorebookName'],
        },
    },
    {
        name: 'view_chat_history',
        description: 'Returns the last N chat messages with role, name, and content.',
        parameters: {
            type: 'object',
            properties: {
                count: {
                    type: 'number',
                    description: 'Number of recent messages to return (default 20).',
                },
                offset: {
                    type: 'number',
                    description: 'Offset from the end of the chat (default 0).',
                },
            },
            required: [],
        },
    },
    {
        name: 'view_entry',
        description: 'Returns the full details of a specific lorebook entry including all fields.',
        parameters: {
            type: 'object',
            properties: {
                lorebookName: {
                    type: 'string',
                    description: 'The name of the lorebook containing the entry.',
                },
                uid: {
                    type: 'number',
                    description: 'The numeric UID of the entry.',
                },
            },
            required: ['lorebookName', 'uid'],
        },
    },
    {
        name: 'propose_create_entry',
        description: 'Propose creating a new lorebook entry. All changes go through a proposal + approval workflow.',
        parameters: {
            type: 'object',
            properties: {
                lorebookName: {
                    type: 'string',
                    description: 'The name of the lorebook to add the entry to.',
                },
                entryData: {
                    type: 'object',
                    description: 'The entry fields. Must include at least: key (array of strings), comment (string), content (string). Optional: order, position, depth, probability, constant, vectorized, selective, disable, excludeRecursion, preventRecursion, group, groupWeight, sticky, cooldown, triggers, characterFilter, selectiveLogic, delay.',
                    properties: {
                        key: { type: 'array', items: { type: 'string' } },
                        comment: { type: 'string' },
                        content: { type: 'string' },
                        order: { type: 'number' },
                        position: { type: 'number' },
                        depth: { type: 'number' },
                        probability: { type: 'number' },
                        constant: { type: 'boolean' },
                        vectorized: { type: 'boolean' },
                        selective: { type: 'boolean' },
                        disable: { type: 'boolean' },
                        excludeRecursion: { type: 'boolean' },
                        preventRecursion: { type: 'boolean' },
                    },
                },
            },
            required: ['lorebookName', 'entryData'],
        },
    },
    {
        name: 'propose_edit_entry',
        description: 'Propose editing an existing lorebook entry. Provide only the fields you want to change. All changes go through a proposal + approval workflow.',
        parameters: {
            type: 'object',
            properties: {
                lorebookName: {
                    type: 'string',
                    description: 'The name of the lorebook containing the entry.',
                },
                uid: {
                    type: 'number',
                    description: 'The numeric UID of the entry to edit.',
                },
                changes: {
                    type: 'object',
                    description: 'The fields to update on the entry.',
                },
            },
            required: ['lorebookName', 'uid', 'changes'],
        },
    },
    {
        name: 'propose_delete_entry',
        description: 'Propose deleting an existing lorebook entry. All changes go through a proposal + approval workflow.',
        parameters: {
            type: 'object',
            properties: {
                lorebookName: {
                    type: 'string',
                    description: 'The name of the lorebook containing the entry.',
                },
                uid: {
                    type: 'number',
                    description: 'The numeric UID of the entry to delete.',
                },
            },
            required: ['lorebookName', 'uid'],
        },
    },
    {
        name: 'research',
        description: 'Search the web for information on a topic using the configured research backend (SearXNG or disabled).',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The search query.',
                },
            },
            required: ['query'],
        },
    },
]);

function EL_getAgentSystemPrompt(researchSources) {
    const sources = Array.isArray(researchSources) && researchSources.length > 0
        ? researchSources.join(', ')
        : 'none (research is disabled)';

    return `You are a "Lorebook Manager" AI assistant integrated into SillyTavern.

## Your Role
Your purpose is to help the user maintain and enhance their lorebook (also called World Info). Lorebook entries are pieces of structured information (character details, locations, items, events, lore facts) that are injected into the LLM prompt when relevant keywords are triggered.

## What You Can Do
- View the active lorebook contents and entry details
- View the recent chat history between the user and the AI character
- Propose creating new lorebook entries
- Propose editing existing lorebook entries
- Propose deleting lorebook entries
- Research topics using the configured search backend (available sources: ${sources})

## Workflow
1. Any change you want to make must first be proposed via one of the propose_* tools
2. Each proposal must include a clear explanation of WHY the change is needed
3. Proposals are saved with status "pending" and presented to the user for review
4. The user can accept, deny, or give feedback on each proposal
5. You should respect the user's feedback and revise proposals accordingly

## Guidelines
- Always explain your reasoning for every proposed change
- Consider the chat history to understand what information is missing or needs updating
- Look for: missing character information, locations, items, events, facts, or world-building details that would enhance the roleplay
- Avoid: duplicating existing entries, making trivial changes, creating entries for obvious/common knowledge
- If you propose creating an entry, ensure it has meaningful keys (trigger words) so it will actually activate in context
- If you propose editing an entry, only change the fields that need updating
- If you propose deleting an entry, explain why it's no longer relevant
- You cannot directly apply changes — all modifications go through the proposal + approval workflow
- Respect all permission settings configured by the user`;
}

function EL_getAnalysisPrompt(chatMessages, lorebookSummary, settings) {
    const mode = settings?.mode === 'periodic' ? `periodic (every ${settings?.periodicInterval || 10} messages)` : 'manual';
    const chatBlock = Array.isArray(chatMessages) && chatMessages.length > 0
        ? chatMessages.map(m => `[${m.role}] ${m.name || ''}: ${m.content}`).join('\n')
        : '(no chat history available)';

    const lorebookBlock = lorebookSummary && lorebookSummary.length > 0
        ? lorebookSummary.map(lb => {
            const entries = Array.isArray(lb.entries) && lb.entries.length > 0
                ? lb.entries.map(e => `  - UID ${e.uid}: keys=[${e.keys?.join(', ') || ''}] comment="${e.comment || ''}" content="${(e.contentPreview || e.content || '').slice(0, 200)}" order=${e.order} depth=${e.depth} prob=${e.probability} pos=${e.position}`).join('\n')
                : '  (no entries)';
            return `Lorebook: "${lb.name}" (${lb.entryCount || 0} entries)\n${entries}`;
        }).join('\n\n')
        : '(no active lorebooks)';

    return `You are running in ${mode} mode.

## Recent Chat History
${chatBlock}

## Current Active Lorebook(s)
${lorebookBlock}

## Task
Based on the chat history and the current lorebook contents, determine if any lorebook entries need to be created, modified, or deleted.

Consider:
- Missing character information: appearance, personality, backstory, relationships, abilities
- Locations: places mentioned but not documented
- Items: objects, artifacts, or equipment that appear in the story
- Events: past or ongoing events that are relevant to the story
- Factions: groups, organizations, or families
- Concepts: magic systems, technology, cultural practices, customs
- Any facts or details that would enhance the AI's understanding of the world

Avoid:
- Duplicating existing entries (check the current keys and comments carefully)
- Making trivial or unnecessary changes
- Creating entries for obvious or common knowledge that doesn't need documentation
- Overwriting user's carefully crafted entries without strong justification

## Output Format
Respond with ONLY a JSON array of tool calls. Do not include any other text, explanation, or markdown formatting.

Each tool call must follow this structure:
[
    {
        "tool": "tool_name",
        "args": { ... parameters ... }
    }
]

Valid tool names: view_active_lorebooks, view_lorebook_detail, view_chat_history, view_entry, propose_create_entry, propose_edit_entry, propose_delete_entry, research

If no changes are needed, respond with an empty array: []`;
}

function EL_createGuardrailValidator(permissions) {
    const perms = permissions || {};
    let proposalCount = 0;

    return {
        validateProposal(actionType, proposalData) {
            const maxEntries = perms.maxEntriesPerRun || 5;

            if (actionType === 'create' || actionType === 'edit' || actionType === 'delete') {
                if (proposalCount >= maxEntries) {
                    return { allowed: false, reason: `Exceeded maximum of ${maxEntries} proposals per run` };
                }
            }

            if (actionType === 'create') {
                if (perms.canCreate === false) {
                    return { allowed: false, reason: 'Creating entries is not permitted by the user\'s permission settings' };
                }
                const keys = proposalData?.key || [];
                const confidence = String(perms.requireKeyConfidence || 'low');
                if (confidence === 'high' && keys.length < 2) {
                    return { allowed: false, reason: 'Entries require at least 2 keys (high confidence mode)' };
                }
                if (confidence === 'medium' && keys.length < 1) {
                    return { allowed: false, reason: 'Entries require at least 1 key (medium confidence mode)' };
                }
            }

            if (actionType === 'edit') {
                if (perms.canEdit === false) {
                    return { allowed: false, reason: 'Editing entries is not permitted by the user\'s permission settings' };
                }
            }

            if (actionType === 'delete') {
                if (perms.canDelete === false) {
                    return { allowed: false, reason: 'Deleting entries is not permitted by the user\'s permission settings' };
                }
                if (perms.allowContentDeletion === false) {
                    return { allowed: false, reason: 'Content deletion is not permitted by the user\'s guardrail settings' };
                }
            }

            return { allowed: true, reason: '' };
        },

        incrementCount() {
            proposalCount++;
        },

        resetCount() {
            proposalCount = 0;
        },

        getCount() {
            return proposalCount;
        },
    };
}
