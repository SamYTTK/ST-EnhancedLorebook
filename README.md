# Enhanced Lorebook

## What is this?

SillyTavern's built-in lorebook panel gets the job done, but actually working
with your lorebooks in it — finding entries, editing several at once, keeping
things organised — is slow and cramped.

Enhanced Lorebook gives you a proper full-screen workspace for all of that.
It opens in its own browser tab, so you get room to breathe, and everything
you do there applies to your real lorebooks.

## How do I open it?

1. Press the **World Info** button in the SillyTavern toolbar.
2. A small menu appears. Choose **Enhanced Lorebook**.
3. A new browser tab opens with your lorebooks in a sidebar.

That same menu can also take you straight to the agent dashboard or to your
pending reviews (more on those below).

## Looking through your lorebooks

The sidebar shows you, in one place:

- Which lorebooks are attached to your current chat and character.
- Which global lorebooks are switched on.
- Every lorebook you have, with a search box to find one fast.

Click any lorebook to see its entries. You can search inside by keys, content,
or comments, and sort them however you like.

## Editing entries

Open any entry to get every option SillyTavern supports: keys, content,
comments, order, how deep into history it reaches, where it gets inserted,
how likely it is to trigger, and the rest.

For quick tweaks you don't even need to open anything — order, depth,
position, and probability can be changed right on the entry card. Entries can
be duplicated (into the same book or a different one), moved between books,
downloaded as files, and deleted.

If you select several entries at once, you can change settings on all of them
together, or delete and download them in bulk.

## Tidying up with folders

You can group entries into named folders, and folders can hold sub-folders,
as deep as you like. Drag entries and folders around to arrange them, fold
whole branches away with one click, and right-click a folder to rename it or
make a new one inside it.

These folders are just your own way of keeping the overview — a grouping
inside this app. They don't change your actual lorebook files.

## Remembering sets with templates

If you have a combination of global lorebooks you like to switch on together,
save it as a template with one click. Later, applying that template switches
the same set back on. Handy when different stories want different setups.

## If something goes wrong

Deleted something you shouldn't have? There's a recovery spot that keeps
deleted entries and backups, so you can usually get things back.

## Lorebook agents (optional)

> You don't need any of this to manage your lorebooks. It's an extra for
> people who want help maintaining big worlds. Still early and experimental.

Agents are little helpers you set up per story. You give one a job — like
"keep track of the places and people we meet" — link it to some lorebooks,
and it reads along and suggests new or updated entries.

The important part: an agent never writes anything itself. Every suggestion
lands in **Review Changes**, where you accept, reject, or send it back with
feedback. Nothing reaches your lorebooks without you saying so.

You can run an agent whenever you like, have it check in automatically every
so many messages, or give it a one-off task from the wand button in chat (or
with `/el-run`). You can also just chat with an agent to talk things through
before anything gets suggested.

Agents need two things to work: the **ST-RequestHub** extension (which handles
all the model talking) and a small server plugin that ships with this
extension (which stores suggestions, chats, and backups — no model code in
it). Backups from accepted suggestions clean themselves up after a day.

## Getting it set up

1. In SillyTavern, go to **Extensions** → **Install from URL** and paste
   `https://github.com/SamYTTK/ST-EnhancedLorebook`, then enable it.
2. Copy the `plugins/enhanced-lorebook-agent/` folder from this extension
   into your SillyTavern `plugins/` folder (only needed for agents).
3. In `config.yaml`, set `enableServerPlugins: true` (only needed for
   agents).
4. Restart SillyTavern.

## Good to know

- This is still early work. The lorebook workspace itself has seen a lot of
  real use, but expect the occasional bug — the agents especially are new.
- This extension was built largely with AI assistance (via
  [OpenCode](https://opencode.ai)).

## License

AGPL-3.0
