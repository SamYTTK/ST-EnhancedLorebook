# Rules

Rules are the part of Enhanced Lorebook that keeps an entry up to date on its own. This page is the user manual: what rules are, how to set them up, what they can't do, and how to fix it when a rule doesn't fire.

You'll find them in the Enhanced Lorebook window: open a lorebook, then click **Rules** (the hourglass, next to **Map**) in the sidebar. The same panel opens from **Settings → Rules → Open Rules**.

## 1. What rules are

A rule is a small automatic edit. Whenever a new message appears in the chat, Enhanced Lorebook can look at the clock, the day of the week, or a field inside an entry, and rewrite **one line** of that entry to match. No AI is involved, nothing is guessed, and nothing else in the entry is touched — only the `Label: value` line the rule writes.

The classic example: Anna's entry has a line reading `Current_Location: Home, 4 Brewer Lane`. Your story says she works at the pet store in the mall on weekdays, nine to five.

- At 08:00 on a Monday, a message appears. A rule checks the clock, sees it's a working morning, and changes the line to `Current_Location: Pet store, Mall`.
- At 17:04, another message. The same rules now choose the fallback row, and the line reads `Current_Location: Home, 4 Brewer Lane` again.

Anna's entry stays correct without you editing it, and her next reply is written with the right location already in place.

Rules only ever change text. They don't create, delete, or reorder entries, they don't move map pins, and they don't switch anything on or off.

## 2. Systems vs rows

Two things work together:

- A **system** is a reusable bundle. It has a name, the field it writes to by default (usually `Current_Location`), and when it should check. Systems are shared across your lorebooks — they live in your extension settings, not inside the lorebook file.
- **Rows** live on an individual entry. Each entry in a system has its own list of rows: a condition, then the value to write.

So one **Schedule system** can serve Anna, Aldric, and the shop, while each of them has completely different rows:

| Entry | Its rows (short version) |
| --- | --- |
| Anna | work hours, weekends off, otherwise at home |
| Aldric Vane | night → the Gutter Lantern, otherwise his rooms |
| Thornwall | market days → open, otherwise closed |

The system answers "when do we check, and which field do we write?" The rows answer "what value, under what conditions?" An entry joins a system through its **Applies to** switch (section 5).

## 3. What a row is made of

A row reads left to right, roughly like a sentence:

```
if   time   >   17:00        →   Home, 4 Brewer Lane
     kind   condition            value to write
```

There's also an optional **target** box between the condition and the arrow. Leave it blank and the row writes to the system's field. Type a label there and that row writes to a different field instead — useful when one entry should update two things.

Rows can also carry extra **AND-lines** (the "＋ condition" button under a row): every line must match for the row to fire. Use them when one comparison isn't enough — `time > 17:00` **and** `dow != 0`, for example. Each AND-line has its own source, operator, and value.

### Kinds

The first dropdown on a row is its kind. There are three.

**`if`** — "when this matches, write this." Rows are checked from top to bottom, and **the first matching `if` wins**. Everything below it is skipped for that check. This is how you get ranges and exceptions without any "and/or" syntax: earlier rows carve out the special cases.

```
if   time   <   09:00      →   Home, 4 Brewer Lane     (too early for work)
if   time   >   17:00      →   Home, 4 Brewer Lane     (done for the day)
if   dow    =   0          →   Home, 4 Brewer Lane     (Sunday)
```

**`otherwise`** — the else branch. It has no condition of its own; it applies only when **no `if` matched**. If you write several `otherwise` rows, only the first one is used.

```
otherwise                  →   Pet store, Mall          (a normal working day)
```

**`while`** — a constant. It isn't a condition at all: every time the system checks, this row writes its value. Use it for things that stay true regardless of the clock, like a possession or a standing status. Multiple `while` rows all apply; they're added after the main write.

```
while                      →   Carries the Ledger
```

### Operators

The second dropdown appears on `if` rows (and on each AND-line). It compares the left side (a source) with the right side (what you type).

| Operator | Plain meaning | Example |
| --- | --- | --- |
| `=` | is exactly | `dow` `=` `3` → it's Wednesday |
| `!=` | is anything but | `dow` `!=` `0` → any day except Sunday |
| `contains` | includes this text | `field Mood` `contains` `tense` |
| `<` | is less than | `time` `<` `09:00` → before nine in the morning |
| `>` | is greater than | `time` `>` `17:00` → after five in the afternoon |
| `empty` | has nothing in it | `field Current_Location` `empty` → the line is blank or missing |

A few behaviours worth knowing:

- `=` is forgiving. Clock times compare as times, so `9:30` matches `09:30`. Numbers compare as numbers, so `5` matches `5.0`. Text ignores capitals and extra spaces.
- `<` and `>` compare times by the minute and numbers by value. On plain text they fall back to alphabetical order — `Cat` is "less than" `Dog`. That's almost never what you want, so keep `<` and `>` for times and numbers.
- `contains` ignores capitals and looks for the text anywhere inside the left side. Don't leave its right side blank — everything "contains" nothing, so the row always matches.
- `empty` hides the right side, since there's nothing to compare against.
- Labels are matched loosely when writing: `Current_Location`, `current location`, and `Current Location` are the same line. The label you type in the row is the one written.

### Sources

The third dropdown picks what the left side reads.

| Source | What it reads | Example |
| --- | --- | --- |
| `time` | the clock, as `HH:MM`, right now | `time` `>` `17:00` |
| `day-of-week` | the day, as `0`–`6` with `0` = Sunday | `dow` `=` `6` → Saturday |
| `field value` | another `Label: value` line in **the same entry** (type the label in the small box) | `field Weather` `=` `rain` |
| `map-placed` | whether this entry is pinned on the lorebook's map (true/false) | `map-placed` `= true` |
| `relation` | whether another entry references this one with the given kind (type the kind) | `relation ally` `= true` |

Day numbers: `0` Sunday, `1` Monday, `2` Tuesday, `3` Wednesday, `4` Thursday, `5` Friday, `6` Saturday.

For `map-placed` and `relation`, the left side is really a yes/no, so use `=` or `!=` with `true` or `false`. `map-placed = true` means "this entry is on the map". The relation check looks at which entries reference this one and with what kind — if nothing references it yet, it's simply false.

## 4. When rules check

The system card has a **Check** dropdown. It controls when the rows are looked at.

- **Check: clock + on message-received** — the default, and what most people want. Every time a new message appears in the chat (the character's or yours), every enabled entry in the system is checked. The clock is read at that moment.
- **Check: every N replies** — same thing, but only every N messages. Set **Every N replies** to a number; the system's own counter ticks once per new message, so `3` means it checks on the 3rd, 6th, 9th… message. Switching chats resets the counter. Handy for things that change slowly.
- **Check: manual only** — never checks on its own. Nothing happens until you press the button.

**Check now** sits at the top of the panel. It runs the system you have selected over every enabled entry in the **open lorebook**, whatever its check method is — this is the only way a `manual` system ever runs. It also retries any writes that were waiting in the queue first, then reports the result, for example `Check now: 3 wrote, 0 blocked.`

Two things about timing:

- The write lands right after the message appears, so the **next** reply is the first one written with the new value.
- There are no background timers. Between messages, a rule simply doesn't run. If a location should change at 17:00 but nobody sends a message until 17:40, it changes at 17:40.

## 5. Applies to

Under the system card is a list of every entry in the open lorebook, each with a switch. That's **Applies to** — how you decide which entries this system runs on. The system itself is shared; membership is per entry.

- **Switch on** — the entry joins the system with one empty starter row, and its rows appear below. Turn on as many entries as you like.
- **Switch off** — the entry leaves the system, **and its rows for that system are deleted.** If you only want to pause an entry, use the small switch next to "Rows for …" instead; that keeps the rows and simply stops them running.

With several entries on, each one is resolved separately: Anna's rows choose Anna's location, the shop's rows choose the shop's status. They share the same check method and the same write budget (section 7).

## 6. If you're editing when a rule fires

You never have to worry about a rule overwriting what you're typing.

If a rule wants to write to an entry you currently have open in the editor, it waits. In the activity log you'll see the line `<entry> held — queued`, with no error popup. When you close the editor — by saving, pressing Escape, or clicking outside — the waiting write applies **on top of what you saved**, touching only its own `Label:` line. Everything else you changed stays exactly as you left it.

If the same field has queued up more than once, they don't pile up: only the newest value is kept, so you don't get a burst of writes when you close the editor.

Editing the entry somewhere else (SillyTavern's own World Info panel, another window, an agent) is handled differently: the save is re-checked against the file just before writing. If the entry changed underneath it, the write is blocked and queued rather than overwriting your work, and you'll see `blocked — queued` in the log. It retries on the next message.

## 7. What rules can't do

Worth knowing up front, so you don't fight the tool:

- **No chaining.** A write never triggers another check, another entry's rows, or the same rule again. Only a new message or **Check now** starts the next pass.
- **Ten writes per message.** All systems and entries together may land at most ten field writes per message. Anything beyond that is skipped until the next message (queued retries count against the same ten). With a handful of characters you'll never notice; with a huge cast you might.
- **The clock is read when it checks.** No polling, no scheduled jobs.
- **AND-lines, not and/or boxes.** A row matches when its main condition *and* every AND-line match. There's no "or" between rows except the first-match-wins order: put the exceptions first.
- **No date, month, or season source.** To get "summer only", keep a `Season: Summer` line in the entry and check `field Season contains Summer` — set it yourself, or let an agent maintain it.
- **Direct values only.** Rules compare text, times, and numbers. They can't judge anything — "is she angry?", "does this scene feel tense?" — those need a model, which is an agent's job, not a rule's.
- **One line per write.** A row writes a single `Label: value` line. It never rewrites whole paragraphs, and it never touches the rest of the entry.
- **Values are text.** Whatever you type is what gets written, including typos. There's no list to pick from.

## 8. Three worked examples

### (a) Anna's day

System: **Schedule system**, writes to `Current_Location`, checks on every message. Anna is switched on under **Applies to**.

| Kind | Condition | → Value |
| --- | --- | --- |
| `if` | `field` `Season` `contains` `Summer` | Lake house, Ashenford |
| `if` | `time` `<` `09:00` | Home, 4 Brewer Lane |
| `if` | `time` `>` `17:00` | Home, 4 Brewer Lane |
| `if` | `dow` `=` `0` | Home, 4 Brewer Lane |
| `if` | `dow` `=` `6` | Home, 4 Brewer Lane |
| `otherwise` |  | Pet store, Mall |
| `while` |  | (target `Carrying`) The Ledger |

Read top to bottom, that's: summer wins over everything; before nine or after five she's home; Sundays and Saturdays she's home; any other time she's at the pet store. The `while` row writes a different field, `Carrying`, and does so on every single check.

Add the summer row only if your story tracks seasons — without a `Season:` line in the entry, the condition is simply false and the row never matches.

### (b) Is the shop open?

Thornwall's entry gets a `Market` line. System: the same Schedule system, or its own with **Write to field** set to `Market`.

| Kind | Condition | → Value |
| --- | --- | --- |
| `if` | `dow` `=` `3` | Market square: open |
| `if` | `dow` `=` `6` | Market square: open |
| `otherwise` |  | Market square: closed |

Two separate `if` rows for the two market days, because one row can only compare one thing. Wednesday hits the first row; Saturday misses it and hits the second; every other day falls through to `otherwise`. The entry always says whether the market is running, and your characters can react to it.

### (c) Something she always carries

A `while` row is the tool for constants. On Anna's entry:

| Kind | Condition | Target | → Value |
| --- | --- | --- | --- |
| `while` |  | `Carrying` | The Ledger |

Every check writes `Carrying: The Ledger`, no matter the hour or the day, and it stacks with whichever `if` or `otherwise` row won. If the ledger is handed over for a scene, edit the value (or the row) — the next check will put it back, which is exactly what a "constant" means. For things that change occasionally, use a `field`-based `if` row instead, and let the field hold the current truth.

## 9. When something's off

### A rule didn't fire

Work down this list; it covers nearly every case:

1. **Is the entry switched on** under **Applies to**, and is the small switch next to "Rows for …" on? (Section 5.)
2. **Is it the right system?** The panel shows one system at a time; rows you're looking at belong to the selected system only.
3. **Is the check method `manual`?** Then nothing happens until you press **Check now**.
4. **Did an earlier row already win?** The first matching `if` stops the rest. An early catch-all `if` will shadow everything below it.
5. **Does the value on the right actually match?** Check capitals aren't an issue (they're ignored), but spelling is. For `contains`, remember it's a substring: `tense` matches `very tense`.
6. **Is the source reading what you think?** `field` reads a line in *the same entry*, using the label you typed. `time` is the real clock — if it's 16:59, `time > 17:00` is false.
7. **Did you reach the ten-write limit?** With many entries in a system, later ones may be skipped this message; they'll get their turn next message.

### A value looks stale

- **No new message since the change was due.** Nothing runs on a timer. Send a message, or press **Check now**.
- **It's queued behind an edit.** You'll see `held — queued` or `blocked — queued` in the log. Close the editor; it lands immediately. Blocked writes also retry on the next message.
- **The system checks every N replies** and this message wasn't the Nth.
- **A cap or a skip happened.** If you see `check now: 0 wrote, 2 blocked`, something is holding the writes — usually an entry open elsewhere.
- **You're looking at a different copy.** Rules always write to the entry's own lorebook file. If a second window or SillyTavern's own panel still shows the old text, reopen the entry there.

### Reading the activity log

The bottom of the panel keeps the **last 20 events, newest first**, each stamped with the time of day (`17:04`). It's a convenience view: it clears when you reload the window, and it only records what this window saw.

What the lines mean:

| Line | Meaning |
| --- | --- |
| `17:04 Anna → Pet store, Mall` | a write landed, and this is the value (long values are cut short) |
| `17:04 3f2a91c0 → wrote` | a write landed for an entry, identified by the first characters of its id |
| `17:04 3f2a91c0 → wrote (retry)` | a previously queued write finally landed |
| `17:04 3f2a91c0 held — queued` | the entry was open in the editor, so the write is waiting |
| `17:04 3f2a91c0 blocked — queued` | the file changed underneath the write; it will retry |
| `17:04 check now: 3 wrote, 0 blocked (Schedule system)` | the result of pressing **Check now** |
| `17:04 applies-to on: 3f2a91c0` | you changed system membership |
| `17:04 system created: System 2` | you added or deleted a system, or deleted a row |

A `blocked` line also raises a short toast: "A rules write was blocked — queued for retry." That's expected, not damage — the write is waiting, not lost.

One last gotcha: **deleting a system also deletes its per-entry rows.** Those rows are part of the system, so removing it removes them in the same save. If you want a system gone for good, that's all you need to do.
