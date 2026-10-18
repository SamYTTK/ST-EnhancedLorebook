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
or comments, narrow the search to just one of those fields with the dropdown
next to the search box, and sort them however you like. Matching words are
highlighted on the entry cards, and a small count tells you how many entries
match.

## Managing your lorebooks

You don't have to go back to SillyTavern's panel for file chores any more:

- **New**: the **+** button at the top of the sidebar creates an empty
  lorebook. Just give it a name.
- **Rename**: right-click any lorebook in the "All Lorebooks" list and choose
  Rename. The app copies everything to the new name, checks the copy
  matches, and only then removes the old file. If the old book was switched
  on globally, you'll be asked whether to switch the new one on instead.
  Chat and character links still point at the old name, so re-select those
  by hand — the app will remind you.
- **Delete**: right-click and choose Delete. You'll see the exact name for
  confirmation, and a backup is attempted first in case you change your mind.
- **Import**: the upload button at the top of the sidebar reads a `.json`
  file and saves it as a lorebook (the file must contain an entries list).
  If a book with that name already exists, you'll be asked before anything
  is overwritten.
- **Export**: right-click a lorebook, or use the Export button in the toolbar
  while a book is open, to download it as a `.json` file.

Names with `/ \ : * ? " < > |`, or starting or ending with a dot or space,
are rejected up front, since SillyTavern would silently save those under a
different filename.

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

Right-click a template (or double-click it) to apply it two ways:

- **Apply (replace)** — switches off everything, then switches the
  template's books on. This is the classic behaviour.
- **Add to current** — switches the template's books on without switching
  anything else off.

If a template mentions lorebooks you no longer have, the app tells you which
ones are missing before applying — they simply can't be switched on, and the
template itself is left untouched. Saving under a name that already exists
asks before overwriting, and you can rename a template from its right-click
menu. The download/upload buttons next to "Templates" export all your
templates to a file or merge a file back in (existing names ask before they
are replaced).

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
with `/el-run`). One-off tasks are sent to the Enhanced Lorebook window, which
is where agents actually run — so that window needs to be open (it opens
automatically if it isn't). You can also just chat with an agent to talk things
through before anything gets suggested.

Agents need two things to work: the **[ST-RequestHub](https://github.com/SamYTTK/ST-RequestHub)** extension (which handles
all the model talking) and a small server plugin that ships with this
extension (which stores suggestions, chats, and backups — no model code in
it). Backups from accepted suggestions clean themselves up after a day.

## Dependencies

- Nothing extra, for managing lorebooks.
- **[ST-RequestHub](https://github.com/SamYTTK/ST-RequestHub)** — only needed
  if you want to use agents. It handles all the model talking.

## Getting it set up

1. In SillyTavern, go to **Extensions** → **Install from URL** and paste
   `https://github.com/SamYTTK/ST-EnhancedLorebook`, then enable it.
2. Copy the `plugins/enhanced-lorebook-agent/` folder from this extension
   into your SillyTavern `plugins/` folder (only needed for agents).
3. In `config.yaml`, set `enableServerPlugins: true` (only needed for
   agents).
4. Restart SillyTavern.

## Good to know

- Every save is verified: the app re-reads the file after writing it and tells
  you if the write did not land, instead of pretending it worked. If the file
  changed underneath you (another window, the native editor, an agent), the
  save is blocked rather than overwriting it.
- The server plugin stores its snapshots, trash, backups and agent chats in one
  shared place and assumes a **single SillyTavern user**. It is not partitioned
  per user. If you run SillyTavern in multi-user mode, be aware that users can
  see and restore each other's recovery data.
- This is still early work. The lorebook workspace itself has seen a lot of
  real use, but expect the occasional bug — the agents especially are new.
- This extension was built largely with AI assistance (via
  [OpenCode](https://opencode.ai)).

## License

AGPL-3.0
